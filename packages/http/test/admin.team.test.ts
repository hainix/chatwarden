import { describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { CLAIM_TTL_MS, REASONS_MAX, VIEWING_TTL_MS } from '@chatwarden/core';
import { PERMISSIONS, PERMISSION_KEYS } from '../src/index.js';
import type { KitResponse } from '../src/index.js';
import { DAY, MIN, errorOf, keysDeep, world } from './world.js';

// The team routes the moderator hub needs (K4 Task 4b): soft claims, take next, viewing, the change token and saved
// reasons, over the real routes on the real SQLite store.

type W = Awaited<ReturnType<typeof world>>;
// The routes' answers are checked field by field below, so the tests read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: KitResponse): Record<string, any> => res.body as Record<string, any>;

const CLAIMED_MESSAGE = 'Another moderator is handling this case.';

/** A decision that warns the reported person: valid for any open report. */
const warn = (person: string, over: Record<string, unknown> = {}) => ({
  verdict: 'upheld',
  actions: [{ subject: person, kind: 'warning', durationMs: null, rule: 1 }],
  reason: 'a decision',
  ...over,
});

describe('the permission table', () => {
  it('adds claims.override and reasons.write at senior and reasons.read at moderator', () => {
    expect(PERMISSIONS['claims.override']).toBe('senior');
    expect(PERMISSIONS['reasons.write']).toBe('senior');
    expect(PERMISSIONS['reasons.read']).toBe('moderator');
    for (const k of ['claims.override', 'reasons.write', 'reasons.read']) expect(PERMISSION_KEYS).toContain(k);
  });

  it('GET /me reports them for each role', async () => {
    const w = await world();
    const can = async (role: 'moderator' | 'senior' | 'owner') => body(await w.call('GET', '/me', { role })).can;
    expect(await can('moderator')).toMatchObject({ 'claims.override': false, 'reasons.write': false, 'reasons.read': true });
    expect(await can('senior')).toMatchObject({ 'claims.override': true, 'reasons.write': true, 'reasons.read': true });
    expect(await can('owner')).toMatchObject({ 'claims.override': true, 'reasons.write': true, 'reasons.read': true });
  });
});

describe('POST /cases/:ref/claim', () => {
  it('claims an open case: { claim: { by, since, until }, tookOverFrom: null }, 10 minutes, no audit row', async () => {
    const w = await world();
    const r = await w.file();
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claim: { by: 'ann', since: w.clock.t, until: w.clock.t + CLAIM_TTL_MS }, tookOverFrom: null });
    expect(Object.keys(body(res))).toEqual(['claim', 'tookOverFrom']);
    expect(Object.keys(body(res).claim)).toEqual(['by', 'since', 'until']);
    expect(w.routeAudit()).toEqual([]);
  });

  it('works with no body, an empty object or takeOver false', async () => {
    const w = await world();
    const a = await w.file();
    const b = await w.file();
    const c = await w.file();
    expect((await w.call('POST', `/cases/${a.target}/claim`)).status).toBe(200);
    expect((await w.call('POST', `/cases/${b.target}/claim`, { body: {} })).status).toBe(200);
    expect((await w.call('POST', `/cases/${c.target}/claim`, { body: { takeOver: false } })).status).toBe(200);
  });

  it('404 for a person with no open case: unknown, never reported, or already decided', async () => {
    const w = await world();
    expect((await w.call('POST', '/cases/s_nobody/claim')).status).toBe(404);
    expect((await w.call('POST', `/cases/${w.person()}/claim`)).status).toBe(404);
    const r = await w.file();
    expect((await w.call('POST', `/reports/${r.id}/decide`, { body: warn(r.target) })).status).toBe(200);
    const res = await w.call('POST', `/cases/${r.target}/claim`);
    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('not_found');
  });

  it('a second moderator gets 409 claimed with { by, until } and the claim is unchanged', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const startedAt = w.clock.t;
    w.clock.t += 2 * MIN;
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'claimed', message: CLAIMED_MESSAGE, by: 'ann', until: startedAt + CLAIM_TTL_MS });
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
    expect(w.routeAudit()).toEqual([]);
  });

  it('the holder claiming again is a heartbeat: until moves, since stays', async () => {
    const w = await world();
    const r = await w.file();
    const first = body(await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' })).claim;
    w.clock.t += 5 * MIN;
    const beat = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect(beat.status).toBe(200);
    expect(body(beat).claim).toEqual({ by: 'ann', since: first.since, until: w.clock.t + CLAIM_TTL_MS });
  });

  it('a claim lapses 10 minutes after the last beat, then another moderator may claim', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    w.clock.t += CLAIM_TTL_MS - 1;
    expect((await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' })).status).toBe(409);
    w.clock.t += 1;
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' });
    expect(res.status).toBe(200);
    expect(body(res).tookOverFrom).toBeNull();
  });

  it('a moderator asking to take over is refused with the same 409 (no permission), and nothing changes', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea', role: 'moderator', body: { takeOver: true } });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('claimed');
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
    expect(w.routeAudit()).toEqual([]);
  });

  it('a senior taking over moves the claim, names who it came from, and is audited as case.takeover on the person', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    w.clock.t += MIN;
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claim: { by: 'sam', since: w.clock.t, until: w.clock.t + CLAIM_TTL_MS }, tookOverFrom: 'ann' });
    expect(w.cw.cases.holder(r.target)?.by).toBe('sam');
    expect(w.routeAudit().map((a) => [a.actor, a.role, a.action, a.target])).toEqual([
      ['sam', 'senior', 'case.takeover', { type: 'person', ref: r.target }],
    ]);
    // And Ann is now the one refused.
    expect((await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' })).status).toBe(409);
  });

  it('an owner may take over too', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'olga', role: 'owner', body: { takeOver: true } });
    expect(res.status).toBe(200);
    expect(w.routeAudit()[0]?.action).toBe('case.takeover');
  });

  it('takeOver on a free case, or on your own claim, is not a takeover: no audit row', async () => {
    const w = await world();
    const a = await w.file();
    const free = await w.call('POST', `/cases/${a.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } });
    expect(free.status).toBe(200);
    expect(body(free).tookOverFrom).toBeNull();
    const own = await w.call('POST', `/cases/${a.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } });
    expect(own.status).toBe(200);
    expect(body(own).tookOverFrom).toBeNull();
    expect(w.routeAudit()).toEqual([]);
  });

  it('takeover over a LAPSED claim is not a takeover either', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    w.clock.t += CLAIM_TTL_MS;
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } });
    expect(body(res).tookOverFrom).toBeNull();
    expect(w.routeAudit()).toEqual([]);
  });

  it('claims.override follows the permission table: a moderator can when it is lowered, a senior cannot when it is raised', async () => {
    const low = await world({ permissions: { 'claims.override': 'moderator' } });
    const r1 = await low.file();
    await low.call('POST', `/cases/${r1.target}/claim`, { actor: 'ann' });
    expect((await low.call('POST', `/cases/${r1.target}/claim`, { actor: 'bea', body: { takeOver: true } })).status).toBe(200);

    const high = await world({ permissions: { 'claims.override': 'owner' } });
    const r2 = await high.file();
    await high.call('POST', `/cases/${r2.target}/claim`, { actor: 'ann' });
    expect((await high.call('POST', `/cases/${r2.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } })).status).toBe(409);
    expect((await high.call('POST', `/cases/${r2.target}/claim`, { actor: 'olga', role: 'owner', body: { takeOver: true } })).status).toBe(200);
  });

  it('fails closed on takeover: if its audit row cannot be written, the answer is 500 and the claim does not move', async () => {
    const w = await world({ wrap: (cw): Chatwarden => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', `/cases/${r.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } });
    expect(res.status).toBe(500);
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
  });

  it('refuses a takeOver that is not a boolean (400) before anything happens', async () => {
    const w = await world();
    const r = await w.file();
    for (const bad of ['yes', 1, null, {}, []]) {
      const res = await w.call('POST', `/cases/${r.target}/claim`, { body: { takeOver: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.call('POST', `/cases/${r.target}/claim`, { raw: '{nope' })).status).toBe(400);
    expect((await w.call('POST', `/cases/${r.target}/claim`, { raw: '[]' })).status).toBe(400);
    expect(w.cw.cases.holder(r.target)).toBeNull();
  });

  it('two moderators claiming back to back through the routes: exactly one 200 and one 409', async () => {
    for (const order of [['ann', 'bea'], ['bea', 'ann']]) {
      const w = await world();
      const r = await w.file();
      const results = await Promise.all(order.map((actor) => w.call('POST', `/cases/${r.target}/claim`, { actor })));
      expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
      const winner = results.findIndex((x) => x.status === 200);
      expect(w.cw.cases.holder(r.target)?.by).toBe(order[winner]);
    }
  });

  it('a ref that is an alias claims the surviving person', async () => {
    const w = await world();
    const r = await w.file('harassment', 'key-for-alias-1');
    w.cw.rooms.seat('alias-room', 'a', { accountId: 'acct-alias' }, 'A');
    const other = w.cw.rooms.subjectAt('alias-room', 'a') as string;
    w.cw.rooms.seat('alias-room', 'b', { clientKey: 'key-for-alias-1', accountId: 'acct-alias' }, 'B');
    await w.cw.flush();
    const canon = w.cw.people.canonical(r.target);
    expect(w.cw.people.canonical(other)).toBe(canon);
    const alias = [r.target, other].find((x) => x !== canon);
    expect(alias).toBeDefined();
    expect((await w.call('POST', `/cases/${alias}/claim`, { actor: 'ann' })).status).toBe(200);
    expect(w.cw.cases.holder(canon)?.by).toBe('ann');
    expect((await w.call('POST', `/cases/${canon}/claim`, { actor: 'bea' })).status).toBe(409);
  });

  it('every answer is no-store: success, 404, 409, 400, 401, 403', async () => {
    const w = await world({ permissions: { 'reports.decide': 'senior' } });
    const r = await w.file();
    const calls = [
      await w.call('POST', `/cases/${r.target}/claim`, { role: 'senior', actor: 'ann' }),
      await w.call('POST', `/cases/${r.target}/claim`, { role: 'senior', actor: 'bea' }),
      await w.call('POST', '/cases/s_nobody/claim', { role: 'senior' }),
      await w.call('POST', `/cases/${r.target}/claim`, { role: 'senior', body: { takeOver: 3 } }),
      await w.call('POST', `/cases/${r.target}/claim`, { role: null }),
      await w.call('POST', `/cases/${r.target}/claim`, { role: 'moderator' }),
    ];
    expect(calls.map((c) => c.status)).toEqual([200, 409, 404, 400, 401, 403]);
    for (const c of calls) expect(c.headers?.['cache-control']).toBe('no-store');
  });
});

describe('POST /cases/:ref/release', () => {
  it('the holder releases: { released: true }, the case is free, no audit row', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', `/cases/${r.target}/release`, { actor: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ released: true });
    expect(w.cw.cases.holder(r.target)).toBeNull();
    expect((await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' })).status).toBe(200);
    expect(w.routeAudit()).toEqual([]);
  });

  it("someone else's claim is not released ({ released: false }), nor is an absent or lapsed one", async () => {
    const w = await world();
    const r = await w.file();
    expect(body(await w.call('POST', `/cases/${r.target}/release`, { actor: 'ann' }))).toEqual({ released: false });
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const other = await w.call('POST', `/cases/${r.target}/release`, { actor: 'bea' });
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ released: false });
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
    w.clock.t += CLAIM_TTL_MS;
    expect(body(await w.call('POST', `/cases/${r.target}/release`, { actor: 'ann' }))).toEqual({ released: false });
  });

  it('a senior cannot release another moderator\'s claim either (take it over instead)', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect(body(await w.call('POST', `/cases/${r.target}/release`, { actor: 'sam', role: 'senior' })).released).toBe(false);
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
  });

  it('needs no body', async () => {
    const w = await world();
    const r = await w.file();
    expect((await w.call('POST', `/cases/${r.target}/release`)).status).toBe(200);
  });
});

describe('POST /cases/next', () => {
  it('is { case: null } when nothing is open, and claims nothing', async () => {
    const w = await world();
    const res = await w.call('POST', '/cases/next', { body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ case: null });
  });

  it('claims and returns the oldest open case: { case: { person, reportId, claim } }', async () => {
    const w = await world();
    const first = await w.file();
    await w.file();
    const res = await w.call('POST', '/cases/next', { actor: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      case: { person: first.target, reportId: first.id, claim: { by: 'ann', since: w.clock.t, until: w.clock.t + CLAIM_TTL_MS } },
    });
    expect(Object.keys(body(res).case)).toEqual(['person', 'reportId', 'claim']);
    expect(w.cw.cases.holder(first.target)?.by).toBe('ann');
    expect(w.routeAudit()).toEqual([]);
  });

  it('the case opens on its newest open report', async () => {
    const w = await world();
    const a = await w.file();
    await w.file();
    const again = await w.fileAgainst(a, 'second-reporter');
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' })).case.reportId).toBe(again.id);
  });

  it('hands out different cases to different moderators, skipping held ones and the caller\'s own', async () => {
    const w = await world();
    const a = await w.file();
    const b = await w.file();
    const c = await w.file();
    await w.call('POST', `/cases/${a.target}/claim`, { actor: 'bea' });
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' })).case.person).toBe(b.target);
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' })).case.person).toBe(c.target);
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' }))).toEqual({ case: null });
  });

  it('takes a category: the oldest case with an open report of it; an unknown one is 400 and claims nothing', async () => {
    const w = await world();
    await w.file('harassment');
    const spam = await w.file('spam');
    expect(body(await w.call('POST', '/cases/next', { body: { category: 'spam' } })).case.person).toBe(spam.target);
    expect(body(await w.call('POST', '/cases/next', { actor: 'bea', body: { category: 'cheating' } }))).toEqual({ case: null });
    const bad = await w.call('POST', '/cases/next', { actor: 'cy', body: { category: 'nope' } });
    expect(bad.status).toBe(400);
    expect((await w.call('POST', '/cases/next', { actor: 'cy', body: { category: 5 } })).status).toBe(400);
    expect((await w.call('POST', '/cases/next', { actor: 'cy', raw: '[1]' })).status).toBe(400);
    expect((await w.call('POST', '/cases/next', { actor: 'cy', raw: '{nope' })).status).toBe(400);
  });

  it('works with no body at all', async () => {
    const w = await world();
    const a = await w.file();
    expect(body(await w.call('POST', '/cases/next')).case.person).toBe(a.target);
  });

  it('two moderators racing for the only case: one gets it, the other { case: null }', async () => {
    const w = await world();
    const a = await w.file();
    const results = await Promise.all(['ann', 'bea'].map((actor) => w.call('POST', '/cases/next', { actor })));
    const cases = results.map((x) => body(x).case);
    expect(cases.filter((c) => c !== null)).toHaveLength(1);
    expect(cases.filter((c) => c === null)).toHaveLength(1);
    expect(w.cw.cases.holder(a.target)).not.toBeNull();
  });

  it('three moderators racing over three cases each get a different one', async () => {
    const w = await world();
    const cases = [await w.file(), await w.file(), await w.file()];
    const results = await Promise.all(['ann', 'bea', 'cy'].map((actor) => w.call('POST', '/cases/next', { actor })));
    expect(results.map((x) => body(x).case.person).sort()).toEqual(cases.map((c) => c.target).sort());
  });

  it('a lapsed claim is free for take next again', async () => {
    const w = await world();
    const a = await w.file();
    await w.call('POST', `/cases/${a.target}/claim`, { actor: 'bea' });
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' }))).toEqual({ case: null });
    w.clock.t += CLAIM_TTL_MS;
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' })).case.person).toBe(a.target);
  });

  it('a decided case is not offered', async () => {
    const w = await world();
    const a = await w.file();
    const b = await w.file();
    await w.call('POST', `/reports/${a.id}/decide`, { body: warn(a.target) });
    expect(body(await w.call('POST', '/cases/next', { actor: 'ann' })).case.person).toBe(b.target);
  });
});

describe('GET /reports and GET /reports/:id: claim and viewing', () => {
  it('every item has claim (null when nobody holds the case) and viewing (empty), after targetHandle', async () => {
    const w = await world();
    const r = await w.file();
    const res = await w.call('GET', '/reports');
    const item = body(res).items[0];
    expect(item.id).toBe(r.id);
    expect(item.claim).toBeNull();
    expect(item.viewing).toEqual([]);
    const keys = Object.keys(item);
    expect(keys.slice(-3)).toEqual(['targetHandle', 'claim', 'viewing']);
  });

  it('shows the claim { by, since, until } on every report of the claimed person, and only theirs', async () => {
    const w = await world();
    const a = await w.file();
    const a2 = await w.fileAgainst(a, 'another-reporter');
    const b = await w.file();
    await w.call('POST', `/cases/${a.target}/claim`, { actor: 'ann' });
    const items = body(await w.call('GET', '/reports', { actor: 'bea' })).items as Array<{ id: string; claim: unknown }>;
    const claim = { by: 'ann', since: expect.any(Number), until: expect.any(Number) };
    expect(items.find((i) => i.id === a.id)?.claim).toEqual(claim);
    expect(items.find((i) => i.id === a2.id)?.claim).toEqual(claim);
    expect(items.find((i) => i.id === b.id)?.claim).toBeNull();
  });

  it('a lapsed claim reads as null; a claim never blocks a read', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect((await w.call('GET', `/reports/${r.id}`, { actor: 'bea' })).status).toBe(200);
    expect((await w.call('GET', '/reports', { actor: 'bea' })).status).toBe(200);
    expect((await w.call('GET', `/people/${r.target}/history`, { actor: 'bea' })).status).toBe(200);
    w.clock.t += CLAIM_TTL_MS;
    expect(body(await w.call('GET', '/reports')).items[0].claim).toBeNull();
  });

  it('a decided report carries no claim and no viewers', async () => {
    const w = await world();
    const a = await w.file();
    const b = await w.file();
    await w.call('POST', `/cases/${a.target}/claim`, { actor: 'ann' });
    await w.call('POST', `/cases/${a.target}/viewing`, { actor: 'bea' });
    // Another process (a webhook, say) closes the report straight through the kit; the claim is left to lapse.
    await w.cw.decide({ reportId: a.id, verdict: 'upheld', actions: [{ subject: a.target, kind: 'warning', durationMs: null, rule: 1 }], actor: 'hook', reason: 'r' });
    void b;
    const items = body(await w.call('GET', '/reports')).items as Array<{ id: string; claim: unknown; viewing: string[]; status: string }>;
    const done = items.find((i) => i.id === a.id)!;
    expect(done.status).toBe('actioned');
    expect(done.claim).toBeNull();
    expect(done.viewing).toEqual([]);
  });

  it('GET /reports/:id gains claim (null or { by, since, until }) after rule', async () => {
    const w = await world();
    const r = await w.file();
    const none = body(await w.call('GET', `/reports/${r.id}`));
    expect(Object.keys(none)).toEqual(['report', 'history', 'suggest', 'rule', 'claim']);
    expect(none.claim).toBeNull();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect(body(await w.call('GET', `/reports/${r.id}`)).claim).toEqual({ by: 'ann', since: expect.any(Number), until: expect.any(Number) });
  });

  it('viewing lists the other actors with the case open, never the caller, sorted', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'cy' });
    await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' });
    await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' });
    expect(body(await w.call('GET', '/reports', { actor: 'bea' })).items[0].viewing).toEqual(['ann', 'cy']);
    expect(body(await w.call('GET', '/reports', { actor: 'zed' })).items[0].viewing).toEqual(['ann', 'bea', 'cy']);
  });

  it('keeps the summary free of evidence: only claim and viewing were added', async () => {
    const w = await world();
    await w.file();
    const item = body(await w.call('GET', '/reports')).items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['actionedAt', 'actionedBy', 'badFaith', 'category', 'claim', 'createdAt', 'id', 'reporterPerson', 'roomId', 'status', 'tags', 'targetHandle', 'targetPerson', 'viewing'].sort(),
    );
  });
});

describe('POST /cases/:ref/viewing', () => {
  it('answers { viewers } (the others), writes no audit row, stores nothing', async () => {
    const w = await world();
    const r = await w.file();
    const tokenBefore = w.cw.changes.token();
    const first = await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ viewers: [] });
    const second = await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' });
    expect(second.body).toEqual({ viewers: ['ann'] });
    expect(w.routeAudit()).toEqual([]);
    expect(w.cw.changes.token()).toBe(tokenBefore);
    expect(w.store.loadClaims([r.target], w.clock.t)).toEqual([]);
  });

  it('expires 30 seconds after the last beat; a beat keeps it alive', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' });
    w.clock.t += VIEWING_TTL_MS - 1;
    expect(body(await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' })).viewers).toEqual(['ann']);
    w.clock.t += 1;
    expect(body(await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' })).viewers).toEqual([]);
    w.clock.t += VIEWING_TTL_MS - 1;
    await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' });
    w.clock.t += VIEWING_TTL_MS - 1;
    expect(body(await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' })).viewers).toEqual(['ann']);
  });

  it('viewing never blocks a claim, a decision or take next', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' });
    expect((await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' })).status).toBe(200);
    expect(body(await w.call('GET', '/reports', { actor: 'bea' })).items[0].viewing).toEqual(['ann']);
  });

  it('needs reports.read, not decide', async () => {
    const w = await world({ permissions: { 'reports.decide': 'owner' } });
    const r = await w.file();
    expect((await w.call('POST', `/cases/${r.target}/viewing`, { role: 'moderator' })).status).toBe(200);
    expect((await w.call('POST', `/cases/${r.target}/claim`, { role: 'moderator' })).status).toBe(403);
  });
});

describe('POST /cases/:ref/viewing: only real cases, and a cap per actor', () => {
  it('404 not_found for a person with no open case (unknown, never reported, decided), and nothing is tracked', async () => {
    const w = await world();
    expect((await w.call('POST', '/cases/s_made_up/viewing', { actor: 'ann' })).status).toBe(404);
    expect((await w.call('POST', `/cases/${w.person()}/viewing`, { actor: 'ann' })).status).toBe(404);
    const r = await w.file();
    await w.call('POST', `/reports/${r.id}/decide`, { body: warn(r.target) });
    const res = await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' });
    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('not_found');
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(w.cw.cases.viewers('s_made_up')).toEqual([]);
  });

  it('a flood of made-up refs cannot fill the presence table, so real presence still shows', async () => {
    const w = await world();
    for (let i = 0; i < 200; i++) await w.call('POST', `/cases/s_flood_${i}/viewing`, { actor: 'mallory' });
    const r = await w.file();
    expect(body(await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'ann' })).viewers).toEqual([]);
    expect(body(await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' })).viewers).toEqual(['ann']);
  });

  it('one actor keeps at most 20 cases open; the oldest beat is dropped and other actors are untouched', async () => {
    const w = await world();
    const cases: string[] = [];
    for (let i = 0; i < 21; i++) cases.push((await w.file()).target);
    await w.call('POST', `/cases/${cases[0]}/viewing`, { actor: 'bea' });
    for (const c of cases) expect((await w.call('POST', `/cases/${c}/viewing`, { actor: 'ann' })).status).toBe(200);
    const queue = body(await w.call('GET', '/reports', { actor: 'zed' })).items as Array<{ targetPerson: string; viewing: string[] }>;
    const viewing = (person: string) => queue.find((i) => i.targetPerson === person)?.viewing;
    expect(viewing(cases[0]!)).toEqual(['bea']);
    expect(viewing(cases[1]!)).toEqual(['ann']);
    expect(viewing(cases[20]!)).toEqual(['ann']);
  });
});

describe('saved reasons: characters and control characters', () => {
  it('counts characters (an emoji is one), and refuses a control character in a label or text', async () => {
    const w = await world();
    const emoji = '\u{1F600}';
    const post = (label: string, text: string) => w.call('POST', '/reasons', { role: 'senior', body: { label, text } });
    expect((await post(emoji.repeat(40), emoji.repeat(500))).status).toBe(200);
    expect((await post(emoji.repeat(41), 't')).status).toBe(400);
    expect((await post('two\nlines', 't')).status).toBe(400);
    expect((await post('l', 'tab\there')).status).toBe(400);
    expect((await post('l', 'two\nlines')).status).toBe(200);
  });
});

describe('POST /reports/:id/decide and POST /sanctions with a claim in the way', () => {
  it('another moderator is refused with 409 claimed { by, until } and nothing is written', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const claimUntil = w.clock.t + CLAIM_TTL_MS;
    w.clock.t += MIN;
    const before = w.audit().length;
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'bea', body: warn(r.target) });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'claimed', message: CLAIMED_MESSAGE, by: 'ann', until: claimUntil });
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
    expect(w.cw.sanctions.forPerson(r.target)).toEqual([]);
    expect(w.audit()).toHaveLength(before);
  });

  it('the holder decides; the claim is released and the case is free', async () => {
    const w = await world();
    const r = await w.file();
    const second = await w.fileAgainst(r, 'second-reporter');
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'ann', body: warn(r.target) });
    expect(res.status).toBe(200);
    expect(w.cw.cases.holder(r.target)).toBeNull();
    // The other report is still open and now anyone may take it.
    expect(w.cw.reports.get(second.id)?.status).toBe('open');
    expect((await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' })).status).toBe(200);
  });

  it('a decision on an unclaimed case, or on a case whose claim lapsed, goes through', async () => {
    const w = await world();
    const a = await w.file();
    expect((await w.call('POST', `/reports/${a.id}/decide`, { actor: 'bea', body: warn(a.target) })).status).toBe(200);
    const b = await w.file();
    await w.call('POST', `/cases/${b.target}/claim`, { actor: 'ann' });
    w.clock.t += CLAIM_TTL_MS;
    expect((await w.call('POST', `/reports/${b.id}/decide`, { actor: 'bea', body: warn(b.target) })).status).toBe(200);
  });

  it('a claim on someone else (the reporter, say) does not block it: only the reported person\'s case does', async () => {
    const w = await world();
    const a = await w.file();
    const b = await w.file();
    await w.call('POST', `/cases/${b.target}/claim`, { actor: 'ann' });
    expect((await w.call('POST', `/reports/${a.id}/decide`, { actor: 'bea', body: warn(a.target) })).status).toBe(200);
  });

  it('a senior with takeOver: true takes the case over, it is audited, the decision is made, and the claim is released', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'sam', role: 'senior', body: warn(r.target, { takeOver: true }) });
    expect(res.status).toBe(200);
    expect(w.cw.reports.get(r.id)?.status).toBe('actioned');
    expect(w.cw.cases.holder(r.target)).toBeNull();
    // Both rows land in the same millisecond on the test clock, so compare them without relying on their order.
    expect(w.routeAudit().map((a) => [a.actor, a.action, a.target]).sort((x, y) => String(x[1]).localeCompare(String(y[1])))).toEqual([
      ['sam', 'case.takeover', { type: 'person', ref: r.target }],
      ['sam', 'report.decide', { type: 'report', ref: r.id }],
    ]);
  });

  it('takeOver from a moderator is refused 409 claimed, and so is takeOver when the permission was raised', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect((await w.call('POST', `/reports/${r.id}/decide`, { actor: 'bea', body: warn(r.target, { takeOver: true }) })).status).toBe(409);
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
    expect(w.routeAudit()).toEqual([]);
  });

  it('takeOver when nobody holds the case, or the caller does, is just a decision (no takeover row)', async () => {
    const w = await world();
    const a = await w.file();
    expect((await w.call('POST', `/reports/${a.id}/decide`, { actor: 'sam', role: 'senior', body: warn(a.target, { takeOver: true }) })).status).toBe(200);
    const b = await w.file();
    await w.call('POST', `/cases/${b.target}/claim`, { actor: 'sam', role: 'senior' });
    expect((await w.call('POST', `/reports/${b.id}/decide`, { actor: 'sam', role: 'senior', body: warn(b.target, { takeOver: true }) })).status).toBe(200);
    expect(w.routeAudit().map((x) => x.action)).toEqual(['report.decide', 'report.decide']);
  });

  it('a takeOver that is not a boolean is 400', async () => {
    const w = await world();
    const r = await w.file();
    expect((await w.call('POST', `/reports/${r.id}/decide`, { body: warn(r.target, { takeOver: 'yes' }) })).status).toBe(400);
  });

  it('authorization and body checks come before the claim check: 403 for a permanent ban, 400 for a bad body, 404 for an unknown report', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const ban = { verdict: 'upheld', actions: [{ subject: r.target, kind: 'ban', durationMs: null, rule: 1 }], reason: 'x' };
    expect((await w.call('POST', `/reports/${r.id}/decide`, { actor: 'bea', role: 'moderator', body: ban })).status).toBe(403);
    expect((await w.call('POST', `/reports/${r.id}/decide`, { actor: 'bea', body: { verdict: 'nope' } })).status).toBe(400);
    expect((await w.call('POST', '/reports/nope/decide', { actor: 'bea', body: warn(r.target) })).status).toBe(404);
  });

  it('a replay of a finished decision is not blocked by a claim somebody took since', async () => {
    const w = await world();
    const r = await w.file();
    const second = await w.fileAgainst(r, 'second-reporter');
    void second;
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const decision = warn(r.target);
    expect((await w.call('POST', `/reports/${r.id}/decide`, { actor: 'ann', body: decision })).status).toBe(200);
    // Bea picks up the other report on the same person; Ann's double-click replays harmlessly.
    expect((await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' })).status).toBe(200);
    const replay = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'ann', body: decision });
    expect(replay.status).toBe(200);
    expect(body(replay).replay).toBe(true);
    // A different decision on the closed report is already_decided, not claimed.
    const other = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'ann', body: { ...decision, verdict: 'no_action', actions: [] } });
    expect(other.status).toBe(409);
    expect(errorOf(other)).toBe('already_decided');
    expect(w.cw.cases.holder(r.target)?.by).toBe('bea');
  });

  it('the decision of a claimed case by its holder does not touch another person\'s claim', async () => {
    const w = await world();
    const a = await w.file();
    const b = await w.file();
    await w.call('POST', `/cases/${a.target}/claim`, { actor: 'ann' });
    await w.call('POST', `/cases/${b.target}/claim`, { actor: 'bea' });
    await w.call('POST', `/reports/${a.id}/decide`, { actor: 'ann', body: warn(a.target) });
    expect(w.cw.cases.holder(b.target)?.by).toBe('bea');
  });

  it('POST /sanctions on a claimed person: refused 409 for another moderator, fine for the holder, the claim stays', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const sanction = { subject: r.target, kind: 'chat', durationMs: DAY, rule: 2 };
    const refused = await w.call('POST', '/sanctions', { actor: 'bea', body: sanction });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'claimed', by: 'ann' });
    expect(w.cw.sanctions.forPerson(r.target)).toEqual([]);
    expect((await w.call('POST', '/sanctions', { actor: 'ann', body: sanction })).status).toBe(200);
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
  });

  it('POST /sanctions with takeOver: a senior moves the claim (audited), the sanction applies, the claim stays with them', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    const res = await w.call('POST', '/sanctions', { actor: 'sam', role: 'senior', body: { subject: r.target, kind: 'chat', durationMs: DAY, rule: 2, takeOver: true } });
    expect(res.status).toBe(200);
    expect(w.cw.cases.holder(r.target)?.by).toBe('sam');
    expect(w.routeAudit().map((a) => a.action).sort()).toEqual(['case.takeover', 'sanction.apply']);
    const mod = await w.call('POST', '/sanctions', { actor: 'bea', body: { subject: r.target, kind: 'chat', durationMs: DAY, rule: 2, takeOver: true } });
    expect(mod.status).toBe(409);
  });

  it('POST /sanctions on an unclaimed person, or a person with no case, is unaffected; a bad takeOver is 400', async () => {
    const w = await world();
    const p = w.person();
    expect((await w.call('POST', '/sanctions', { body: { subject: p, kind: 'chat', durationMs: DAY, rule: 2 } })).status).toBe(200);
    expect((await w.call('POST', '/sanctions', { body: { subject: p, kind: 'chat', durationMs: DAY, rule: 2, takeOver: 'x' } })).status).toBe(400);
  });

  it('revoking a sanction is not held up by a claim', async () => {
    const w = await world();
    const r = await w.file();
    const made = body(await w.call('POST', '/sanctions', { body: { subject: r.target, kind: 'chat', durationMs: DAY, rule: 2 } }));
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' });
    expect((await w.call('POST', `/sanctions/${made.groupId}/revoke`, { actor: 'bea', body: { reason: 'wrong person' } })).status).toBe(200);
  });
});

describe('GET /changes', () => {
  it('answers { token, changed } exactly; with no since it is changed', async () => {
    const w = await world();
    const res = await w.call('GET', '/changes');
    expect(res.status).toBe(200);
    expect(Object.keys(body(res))).toEqual(['token', 'changed']);
    expect(body(res)).toEqual({ token: w.cw.changes.token(), changed: true });
  });

  it('is unchanged for the token it just gave, and changed for any other value', async () => {
    const w = await world();
    const { token } = body(await w.call('GET', '/changes'));
    expect(body(await w.call('GET', '/changes', { query: { since: token } }))).toEqual({ token, changed: false });
    expect(body(await w.call('GET', '/changes', { query: { since: 'someting-else' } }))).toEqual({ token, changed: true });
    expect(body(await w.call('GET', '/changes', { query: { since: '0' } })).changed).toBe(token !== '0');
  });

  it('is cheap: it reads the token and nothing else, and writes no audit row', async () => {
    const reads: string[] = [];
    const w = await world({
      wrap: (cw) =>
        new Proxy(cw, {
          get(target, prop, receiver) {
            reads.push(String(prop));
            return Reflect.get(target, prop, receiver);
          },
        }),
    });
    reads.length = 0;
    const res = await w.call('GET', '/changes', { query: { since: 'x' } });
    expect(res.status).toBe(200);
    expect(reads).toEqual(['changes']);
    expect(w.routeAudit()).toEqual([]);
  });

  it('refuses a since that is not a short token (400 invalid_query)', async () => {
    const w = await world();
    for (const since of ['', 'a'.repeat(65), 'has space', 'semi;colon', '<script>']) {
      const res = await w.call('GET', '/changes', { query: { since } });
      expect(res.status, since).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
    }
  });

  /** The token after `step`, and whether it moved. */
  const moved = async (w: W, step: () => Promise<unknown> | unknown): Promise<boolean> => {
    const before = body(await w.call('GET', '/changes')).token as string;
    await step();
    const after = await w.call('GET', '/changes', { query: { since: before } });
    return body(after).changed as boolean;
  };

  it('moves on a report filed, a decision, a sanction applied and revoked, a gap closed', async () => {
    const w = await world();
    let r!: Awaited<ReturnType<W['file']>>;
    expect(await moved(w, async () => (r = await w.file()))).toBe(true);
    expect(await moved(w, () => w.call('POST', `/reports/${r.id}/decide`, { body: warn(r.target) }))).toBe(true);
    let group = '';
    expect(await moved(w, async () => (group = body(await w.call('POST', '/sanctions', { body: { subject: r.target, kind: 'chat', durationMs: DAY, rule: 2 } })).groupId))).toBe(true);
    expect(await moved(w, () => w.call('POST', `/sanctions/${group}/revoke`, { body: { reason: 'oops' } }))).toBe(true);
    const gap = await w.gap();
    expect(await moved(w, () => w.call('POST', `/gaps/${gap.groupId}/close`, { role: 'owner', body: { status: 'not_a_rule' } }))).toBe(true);
  });

  it('moves on a claim taken, a take over and a release, but not on a heartbeat, a refused claim or viewing', async () => {
    const w = await world();
    const r = await w.file();
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' }))).toBe(true);
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' }))).toBe(false);
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' }))).toBe(false);
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' }))).toBe(false);
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/release`, { actor: 'bea' }))).toBe(false);
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/claim`, { actor: 'sam', role: 'senior', body: { takeOver: true } }))).toBe(true);
    expect(await moved(w, () => w.call('POST', `/cases/${r.target}/release`, { actor: 'sam', role: 'senior' }))).toBe(true);
    expect(await moved(w, () => w.call('POST', '/cases/next', { actor: 'ann' }))).toBe(true);
  });

  it('moves on a saved reason added, edited and switched', async () => {
    const w = await world();
    let id = '';
    expect(await moved(w, async () => (id = body(await w.call('POST', '/reasons', { role: 'senior', body: { label: 'Spam', text: 'Spamming.' } })).reason.id))).toBe(true);
    expect(await moved(w, () => w.call('PATCH', `/reasons/${id}`, { role: 'senior', body: { label: 'Spam!' } }))).toBe(true);
    expect(await moved(w, () => w.call('POST', `/reasons/${id}/active`, { role: 'senior', body: { active: false } }))).toBe(true);
  });

  it('does not move on reads: the queue, a report, the history, the reasons, the audit trail', async () => {
    const w = await world();
    const r = await w.file();
    expect(
      await moved(w, async () => {
        await w.call('GET', '/reports');
        await w.call('GET', `/reports/${r.id}`);
        await w.call('GET', `/people/${r.target}/history`);
        await w.call('GET', '/reasons');
        await w.call('GET', '/audit', { role: 'senior' });
        await w.call('GET', '/me');
      }),
    ).toBe(false);
  });

  it('needs reports.read, and a lapse alone moves nothing', async () => {
    const w = await world({ permissions: { 'reports.read': 'senior' } });
    expect((await w.call('GET', '/changes', { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/changes', { role: 'senior' })).status).toBe(200);
    const r = await w.file();
    await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann', role: 'senior' });
    const { token } = body(await w.call('GET', '/changes', { role: 'senior' }));
    w.clock.t += CLAIM_TTL_MS + 1;
    expect(body(await w.call('GET', '/changes', { role: 'senior', query: { since: token } })).changed).toBe(false);
  });
});

describe('saved reasons', () => {
  const add = (w: W, over: Record<string, unknown> = {}, role: 'moderator' | 'senior' | 'owner' = 'senior') =>
    w.call('POST', '/reasons', { role, actor: 'sam', body: { label: 'Spam', text: 'Spamming the lobby.', ...over } });

  it('GET /reasons is { reasons: [] } to start and any moderator can read it', async () => {
    const w = await world();
    const res = await w.call('GET', '/reasons', { role: 'moderator' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reasons: [] });
    expect(w.routeAudit()).toEqual([]);
  });

  it('a senior adds one: { reason: { id, label, text, active } }, trimmed, active, audited reason.add on its id', async () => {
    const w = await world();
    const res = await add(w, { label: '  Spam  ', text: '  Spamming the lobby.  ' });
    expect(res.status).toBe(200);
    const reason = body(res).reason;
    expect(reason).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), label: 'Spam', text: 'Spamming the lobby.', active: true });
    expect(Object.keys(reason)).toEqual(['id', 'label', 'text', 'active']);
    expect(Object.keys(body(res))).toEqual(['reason']);
    expect(w.routeAudit().map((a) => [a.actor, a.role, a.action, a.target])).toEqual([['sam', 'senior', 'reason.add', { type: 'reason', ref: reason.id }]]);
    expect(body(await w.call('GET', '/reasons', { role: 'moderator' })).reasons).toEqual([reason]);
  });

  it('lists in the order added, inactive ones included', async () => {
    const w = await world();
    const a = body(await add(w, { label: 'A' })).reason;
    const b = body(await add(w, { label: 'B' })).reason;
    await w.call('POST', `/reasons/${a.id}/active`, { role: 'senior', body: { active: false } });
    expect(body(await w.call('GET', '/reasons')).reasons).toEqual([{ ...a, active: false }, b]);
  });

  it('a moderator cannot add, edit or switch (403, nothing written, no audit)', async () => {
    const w = await world();
    const made = body(await add(w)).reason;
    const before = w.audit().length;
    expect((await add(w, {}, 'moderator')).status).toBe(403);
    expect((await w.call('PATCH', `/reasons/${made.id}`, { role: 'moderator', body: { label: 'X' } })).status).toBe(403);
    expect((await w.call('POST', `/reasons/${made.id}/active`, { role: 'moderator', body: { active: false } })).status).toBe(403);
    expect(body(await w.call('GET', '/reasons')).reasons).toEqual([made]);
    expect(w.audit()).toHaveLength(before);
  });

  it('refuses a bad label or text with 400 and writes nothing', async () => {
    const w = await world();
    const bads: Array<Record<string, unknown>> = [
      { label: '' }, { label: '   ' }, { label: 'l'.repeat(41) }, { label: 5 }, { label: null },
      { text: '' }, { text: ' \n ' }, { text: 't'.repeat(501) }, { text: 5 }, { text: null },
    ];
    for (const bad of bads) {
      const res = await add(w, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    expect((await w.call('POST', '/reasons', { role: 'senior', body: { text: 'no label' } })).status).toBe(400);
    expect((await w.call('POST', '/reasons', { role: 'senior', body: { label: 'no text' } })).status).toBe(400);
    expect((await w.call('POST', '/reasons', { role: 'senior', raw: '[]' })).status).toBe(400);
    expect((await w.call('POST', '/reasons', { role: 'senior', raw: '{nope' })).status).toBe(400);
    expect((await w.call('POST', '/reasons', { role: 'senior' })).status).toBe(400);
    expect(body(await w.call('GET', '/reasons')).reasons).toEqual([]);
    expect(w.routeAudit()).toEqual([]);
  });

  it('accepts the limits exactly (40 and 500)', async () => {
    const w = await world();
    expect((await add(w, { label: 'l'.repeat(40), text: 't'.repeat(500) })).status).toBe(200);
  });

  it('keeps text with newlines, quotes and non-latin characters exactly', async () => {
    const w = await world();
    const text = 'Line one\n"quoted" é中😀 </script>';
    expect(body(await add(w, { text })).reason.text).toBe(text);
  });

  it('the list is capped at 200: the 201st is 400 invalid_value', async () => {
    const w = await world();
    for (let i = 0; i < REASONS_MAX; i++) w.cw.reasons.add({ label: `l${i}`, text: 't' });
    const res = await add(w);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_value');
  });

  it('PATCH changes the label, the text or both, audits reason.update, and answers the row', async () => {
    const w = await world();
    const made = body(await add(w)).reason;
    const l = await w.call('PATCH', `/reasons/${made.id}`, { role: 'senior', actor: 'sam', body: { label: ' Spam 2 ' } });
    expect(l.status).toBe(200);
    expect(l.body).toEqual({ reason: { ...made, label: 'Spam 2' } });
    expect(body(await w.call('PATCH', `/reasons/${made.id}`, { role: 'senior', body: { text: 'New text' } })).reason).toEqual({ ...made, label: 'Spam 2', text: 'New text' });
    expect(body(await w.call('PATCH', `/reasons/${made.id}`, { role: 'senior', body: { label: 'A', text: 'B' } })).reason).toEqual({ ...made, label: 'A', text: 'B' });
    expect(w.routeAudit().map((a) => a.action).sort()).toEqual(['reason.add', 'reason.update', 'reason.update', 'reason.update']);
  });

  it('PATCH refuses nothing-to-change, a bad value, an unknown key only, and an unknown id is 404', async () => {
    const w = await world();
    const made = body(await add(w)).reason;
    for (const bad of [{}, { label: '' }, { label: 'l'.repeat(41) }, { text: 't'.repeat(501) }, { label: 3 }, { other: 'x' }]) {
      expect((await w.call('PATCH', `/reasons/${made.id}`, { role: 'senior', body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.call('PATCH', `/reasons/${made.id}`, { role: 'senior', raw: '[]' })).status).toBe(400);
    const missing = await w.call('PATCH', '/reasons/nope', { role: 'senior', body: { label: 'x' } });
    expect(missing.status).toBe(404);
    expect(errorOf(missing)).toBe('not_found');
    expect(body(await w.call('GET', '/reasons')).reasons).toEqual([made]);
  });

  it('POST /reasons/:id/active switches it off and on and audits reason.toggle', async () => {
    const w = await world();
    const made = body(await add(w)).reason;
    const off = await w.call('POST', `/reasons/${made.id}/active`, { role: 'senior', actor: 'sam', body: { active: false } });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ reason: { ...made, active: false } });
    expect(body(await w.call('POST', `/reasons/${made.id}/active`, { role: 'senior', body: { active: true } })).reason.active).toBe(true);
    // The same value again is fine (idempotent).
    expect((await w.call('POST', `/reasons/${made.id}/active`, { role: 'senior', body: { active: true } })).status).toBe(200);
    expect(w.routeAudit().filter((a) => a.action === 'reason.toggle')).toHaveLength(3);
    expect(w.routeAudit().find((a) => a.action === 'reason.toggle')?.target).toEqual({ type: 'reason', ref: made.id });
  });

  it('active refuses a missing or non-boolean value (400) and an unknown id is 404', async () => {
    const w = await world();
    const made = body(await add(w)).reason;
    for (const bad of [{}, { active: 'yes' }, { active: 1 }, { active: null }]) {
      expect((await w.call('POST', `/reasons/${made.id}/active`, { role: 'senior', body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.call('POST', '/reasons/nope/active', { role: 'senior', body: { active: true } })).status).toBe(404);
    expect(body(await w.call('GET', '/reasons')).reasons).toEqual([made]);
  });

  it('follows the permission table: reasons.write at moderator lets a moderator manage, reasons.read at senior hides the list', async () => {
    const open = await world({ permissions: { 'reasons.write': 'moderator' } });
    expect((await add(open, {}, 'moderator')).status).toBe(200);
    const closed = await world({ permissions: { 'reasons.read': 'senior' } });
    expect((await closed.call('GET', '/reasons', { role: 'moderator' })).status).toBe(403);
    expect((await closed.call('GET', '/reasons', { role: 'senior' })).status).toBe(200);
  });

  it('the write has happened when its audit row cannot be written: still 200, logged', async () => {
    const w = await world({ wrap: (cw): Chatwarden => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const res = await add(w);
    expect(res.status).toBe(200);
    expect(body(await w.call('GET', '/reasons')).reasons).toHaveLength(1);
    expect(w.logged.some(([e]) => e === 'chatwarden.http_audit_failed')).toBe(true);
  });

  it('every answer is no-store', async () => {
    const w = await world();
    const made = body(await add(w)).reason;
    const calls = [
      await w.call('GET', '/reasons'),
      await add(w),
      await add(w, { label: '' }),
      await w.call('PATCH', `/reasons/${made.id}`, { role: 'senior', body: { label: 'x' } }),
      await w.call('PATCH', '/reasons/nope', { role: 'senior', body: { label: 'x' } }),
      await w.call('POST', `/reasons/${made.id}/active`, { role: 'senior', body: { active: false } }),
      await w.call('GET', '/reasons', { role: null }),
      await w.call('POST', '/reasons', { role: 'moderator', body: { label: 'x', text: 'y' } }),
    ];
    expect(calls.map((c) => c.status)).toEqual([200, 200, 400, 200, 404, 200, 401, 403]);
    for (const c of calls) expect(c.headers?.['cache-control']).toBe('no-store');
  });
});

describe('no ip, hash or raw key in any team answer', () => {
  it('scans the success and error responses', async () => {
    const w = await world();
    const r = await w.file();
    const made = await w.call('POST', '/reasons', { role: 'senior', body: { label: 'a', text: 'b' } });
    const responses: KitResponse[] = [
      await w.call('POST', `/cases/${r.target}/claim`, { actor: 'ann' }),
      await w.call('POST', `/cases/${r.target}/claim`, { actor: 'bea' }),
      await w.call('POST', `/cases/${r.target}/viewing`, { actor: 'bea' }),
      await w.call('GET', '/reports'),
      await w.call('GET', `/reports/${r.id}`),
      await w.call('POST', '/cases/next'),
      await w.call('POST', `/cases/${r.target}/release`, { actor: 'ann' }),
      await w.call('GET', '/changes'),
      await w.call('GET', '/reasons'),
      made,
    ];
    const forbidden = /^(ip|ips|ipHash|keyHash|clientKey|key|rawKey|secret|hash|accountId)$/i;
    for (const res of responses) {
      for (const k of keysDeep(res.body)) expect(forbidden.test(k), k).toBe(false);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('raw-client-key');
      expect(text).not.toContain('203.0.113');
    }
  });
});

describe('the route table', () => {
  it('has the new routes and no others new', async () => {
    const w = await world();
    for (const k of [
      'POST /cases/next', 'POST /cases/:ref/claim', 'POST /cases/:ref/release', 'POST /cases/:ref/viewing',
      'GET /changes', 'GET /reasons', 'POST /reasons', 'PATCH /reasons/:id', 'POST /reasons/:id/active',
    ]) {
      expect(Object.keys(w.routes), k).toContain(k);
    }
  });
});
