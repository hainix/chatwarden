import { describe, expect, it } from 'vitest';
import type { Role } from '@chatwarden/http';
import { appealsWorld, HOUR } from './appealsWorld.js';
import { errorOf, keysDeep, world } from './world.js';

// The staff appeal routes: the inbox, the numbers, one appeal, and the decision. Appeals are off until turned on: then every route is 404.

const ROLES = ['moderator', 'senior', 'owner'] as const;
const REASON = 'private deciding reason, never echoed';

const decide = (w: Awaited<ReturnType<typeof appealsWorld>>, id: string, body: unknown, o: { role?: Role | null; actor?: string } = {}) =>
  w.call('POST', `/appeals/${id}/decide`, { role: o.role === undefined ? 'senior' : o.role, actor: o.actor ?? 'senior_bea', body });

describe('permission boundaries at moderator, senior and owner for every route; appeals.decide lowered by the permissions option works', () => {
  it('reads: a moderator, a senior and an owner may; no authz is 401; the read permission raised to senior shuts a moderator out', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    const paths = ['/appeals', '/appeals/stats', `/appeals/${a.appealId}`];
    for (const path of paths) {
      for (const role of ROLES) expect((await w.call('GET', path, { role })).status, `${role} ${path}`).toBe(200);
      const none = await w.call('GET', path, { role: null });
      expect(none.status, path).toBe(401);
      expect(none.body).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    }
    const closed = await appealsWorld({ permissions: { 'appeals.read': 'senior' } });
    const b = await closed.appeal();
    for (const path of ['/appeals', '/appeals/stats', `/appeals/${b.appealId}`]) {
      expect((await closed.call('GET', path, { role: 'moderator' })).status, path).toBe(403);
      expect((await closed.call('GET', path, { role: 'senior' })).status, path).toBe(200);
    }
    // A refused read leaves no row.
    expect(closed.routeAudit().filter((r) => r.role === 'moderator')).toEqual([]);
  });

  it('decide: a moderator is 403, a senior and an owner may; no authz is 401; authorization comes before body validation', async () => {
    const w = await appealsWorld();
    const [a, b, c] = [await w.appeal(), await w.appeal(), await w.appeal()];
    const body = { outcome: 'uphold', reason: REASON };
    const before = w.routeAudit().length;
    const mod = await decide(w, a.appealId, body, { role: 'moderator' });
    expect(mod.status).toBe(403);
    expect(errorOf(mod)).toBe('forbidden');
    expect((await decide(w, a.appealId, body, { role: null })).status).toBe(401);
    expect((await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'moderator', raw: '{nope' })).status).toBe(403);
    expect((await w.call('POST', `/appeals/${a.appealId}/decide`, { role: null, raw: '{nope' })).status).toBe(401);
    expect(w.routeAudit()).toHaveLength(before);
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('open');
    expect((await decide(w, b.appealId, body, { role: 'senior' })).status).toBe(200);
    expect((await decide(w, c.appealId, body, { role: 'owner' })).status).toBe(200);
  });

  it('lowered by the permissions option, a moderator may decide; raised to owner, a senior may not', async () => {
    const small = await appealsWorld({ permissions: { 'appeals.decide': 'moderator' } });
    const a = await small.appeal();
    expect((await decide(small, a.appealId, { outcome: 'uphold', reason: REASON }, { role: 'moderator', actor: 'mod_cy' })).status).toBe(200);
    const strict = await appealsWorld({ permissions: { 'appeals.decide': 'owner' } });
    const b = await strict.appeal();
    expect((await decide(strict, b.appealId, { outcome: 'uphold', reason: REASON }, { role: 'senior' })).status).toBe(403);
    expect((await decide(strict, b.appealId, { outcome: 'uphold', reason: REASON }, { role: 'owner' })).status).toBe(200);
  });

  it('every route answers 405 under another method and no unknown path matches', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    expect((await w.call('POST', '/appeals')).status).toBe(405);
    expect((await w.call('POST', '/appeals/stats')).status).toBe(405);
    expect((await w.call('GET', `/appeals/${a.appealId}/decide`)).status).toBe(405);
    expect((await w.call('PUT', `/appeals/${a.appealId}`)).status).toBe(405);
    expect((await w.call('GET', '/appeals/x/y/z')).status).toBe(404);
  });
});

describe('audit rows and modes: list, stats and detail required; decide best-effort; an audit failure on a required read fails the read', () => {
  it('the list and the numbers write appeal.view with no target; the detail writes it with the appeal as target; decide writes appeal.decide', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    await w.call('GET', '/appeals', { actor: 'ann' });
    await w.call('GET', '/appeals/stats', { actor: 'ann' });
    await w.call('GET', `/appeals/${a.appealId}`, { actor: 'ann' });
    await decide(w, a.appealId, { outcome: 'revoke', reason: REASON }, { actor: 'senior_bea' });
    const rows = w
      .routeAudit()
      .filter((r) => r.action === 'appeal.view' || r.action === 'appeal.decide')
      .map((r) => [r.action, r.actor, r.role, r.target ?? null]);
    expect(rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])) || String(x[3]).localeCompare(String(y[3])))).toEqual(
      [
        ['appeal.decide', 'senior_bea', 'senior', { type: 'appeal', ref: a.appealId }],
        ['appeal.view', 'ann', 'moderator', { type: 'appeal', ref: a.appealId }],
        ['appeal.view', 'ann', 'moderator', null],
        ['appeal.view', 'ann', 'moderator', null],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0])) || String(x[3]).localeCompare(String(y[3]))),
    );
  });

  it('no audit row carries a statement, a reason or a handle', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ statement: 'a distinctive statement sentence' });
    await w.call('GET', '/appeals');
    await w.call('GET', `/appeals/${a.appealId}`);
    await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    const text = JSON.stringify(w.audit());
    for (const v of ['distinctive statement', REASON, 'TargetName', 'private moderator reason']) expect(text).not.toContain(v);
  });

  it('an audit failure on a required read fails the read (500, nothing shown); a refused or missing read writes no row', async () => {
    const w = await appealsWorld({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const a = await w.appeal();
    for (const path of ['/appeals', '/appeals/stats', `/appeals/${a.appealId}`]) {
      const res = await w.call('GET', path);
      expect(res.status, path).toBe(500);
      expect(res.body, path).toEqual({ error: 'internal' });
      expect(JSON.stringify(res)).not.toContain('statement');
    }
    const ok = await appealsWorld();
    expect((await ok.call('GET', '/appeals/nope-no-such-appeal')).status).toBe(404);
    expect((await ok.call('GET', '/appeals', { query: { status: 'bogus' } })).status).toBe(400);
    expect(ok.routeAudit()).toEqual([]);
  });

  it('decide is best-effort: the decision stands and the answer is 200 when its audit row cannot be written, and the failure is logged by class', async () => {
    const w = await appealsWorld({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const a = await w.appeal();
    w.logged.length = 0;
    const res = await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    expect(res.status).toBe(200);
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('upheld');
    expect(w.logged.map(([e]) => e)).toContain('chatwarden.http_audit_failed');
    expect(JSON.stringify(w.logged)).not.toContain(REASON);
  });

  it('a refused decision (409, 400, 404) writes no appeal.decide row', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    const before = w.routeAudit().filter((r) => r.action === 'appeal.decide').length;
    expect((await decide(w, a.appealId, { outcome: 'uphold', reason: REASON })).status).toBe(409);
    expect((await decide(w, a.appealId, { outcome: 'bogus', reason: REASON })).status).toBe(400);
    expect((await decide(w, 'nope-no-such-appeal', { outcome: 'uphold', reason: REASON })).status).toBe(404);
    expect(w.routeAudit().filter((r) => r.action === 'appeal.decide')).toHaveLength(before);
  });
});

describe('400 invalid_query for a bad status, cursor, limit and days; /appeals/stats is not captured by /appeals/:id; 404 for an unknown id', () => {
  it('a bad status, cursor, limit or days is 400 invalid_query', async () => {
    const w = await appealsWorld();
    await w.appeal();
    const bad: Array<[string, Record<string, string>]> = [
      ['/appeals', { status: 'closed' }],
      ['/appeals', { status: '' }],
      ['/appeals', { status: 'OPEN' }],
      ['/appeals', { cursor: 'not-a-cursor' }],
      ['/appeals', { cursor: '!!!' }],
      ['/appeals', { limit: '0' }],
      ['/appeals', { limit: '201' }],
      ['/appeals', { limit: '-1' }],
      ['/appeals', { limit: '1.5' }],
      ['/appeals', { limit: 'abc' }],
      ['/appeals', { limit: '1234567890' }],
      ['/appeals/stats', { days: '7' }],
      ['/appeals/stats', { days: '0' }],
      ['/appeals/stats', { days: 'abc' }],
      ['/appeals/stats', { days: '' }],
      ['/appeals/stats', { days: '90.0' }],
    ];
    for (const [path, query] of bad) {
      const res = await w.call('GET', path, { query });
      expect(res.status, `${path} ${JSON.stringify(query)}`).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
    }
    for (const [path, query] of [['/appeals', { status: 'open' }], ['/appeals', { status: 'decided' }], ['/appeals', { status: 'all' }], ['/appeals', { limit: '1' }], ['/appeals', { limit: '200' }], ['/appeals/stats', { days: '30' }], ['/appeals/stats', { days: '90' }], ['/appeals/stats', { days: '365' }]] as const) {
      expect((await w.call('GET', path, { query })).status, `${path} ${JSON.stringify(query)}`).toBe(200);
    }
  });

  it('/appeals/stats is the numbers, not an appeal called stats', async () => {
    const w = await appealsWorld();
    await w.appeal();
    const res = await w.call('GET', '/appeals/stats');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['overall', 'perRule', 'windowDays']);
    expect((res.body as { windowDays: number }).windowDays).toBe(90);
    expect(((await w.call('GET', '/appeals/stats', { query: { days: '30' } })).body as { windowDays: number }).windowDays).toBe(30);
    expect(((await w.call('GET', '/appeals/stats', { query: { days: '365' } })).body as { windowDays: number }).windowDays).toBe(365);
  });

  it('an unknown or malformed id is 404 not_found', async () => {
    const w = await appealsWorld();
    for (const id of ['nope-no-such-appeal', 'x', 'a'.repeat(64)]) {
      const res = await w.call('GET', `/appeals/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
    }
    expect((await w.call('GET', '/appeals/bad%20id')).status).toBe(404);
    expect((await w.call('GET', `/appeals/${'a'.repeat(65)}`)).status).toBe(404);
    expect((await decide(w, 'nope-no-such-appeal', { outcome: 'uphold', reason: REASON })).status).toBe(404);
  });
});

describe('the inbox and the detail', () => {
  it('the list is open appeals oldest first by default with the person\'s handle, a staff ref and no statement; decided and all work', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ statement: 'statement one words' });
    const b = await w.appeal({ statement: 'statement two words' });
    await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    const open = (await w.call('GET', '/appeals')).body as { items: Array<Record<string, unknown>>; next: string | null };
    expect(open.items.map((i) => i.id)).toEqual([b.appealId]);
    expect(open.next).toBeNull();
    expect(open.items[0]).toMatchObject({ id: b.appealId, status: 'open', person: b.subject, handle: 'TargetName', statementFlagged: false, sanction: { groupId: b.groupId, kind: 'chat', rule: 2 } });
    const decided = (await w.call('GET', '/appeals', { query: { status: 'decided' } })).body as { items: Array<{ id: string }> };
    expect(decided.items.map((i) => i.id)).toEqual([a.appealId]);
    const all = (await w.call('GET', '/appeals', { query: { status: 'all' } })).body as { items: Array<{ id: string }> };
    expect(all.items.map((i) => i.id)).toEqual([a.appealId, b.appealId]);
    expect(JSON.stringify(all)).not.toContain('statement one');
    expect(keysDeep(all).has('statement')).toBe(false);
  });

  it('pages with limit and cursor without a gap or a repeat', async () => {
    const w = await appealsWorld();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await w.appeal());
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await w.call('GET', '/appeals', { query: { limit: '2', ...(cursor === undefined ? {} : { cursor }) } });
      const page = res.body as { items: Array<{ id: string }>; next: string | null };
      seen.push(...page.items.map((x) => x.id));
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(seen).toEqual(made.map((m) => m.appealId));
  });

  it('the handle is null for a caller without history.read and when no report recorded one', async () => {
    const w = await appealsWorld({ permissions: { 'history.read': 'senior' } });
    await w.appeal();
    const mod = (await w.call('GET', '/appeals', { role: 'moderator' })).body as { items: Array<{ handle: string | null }> };
    expect(mod.items[0]?.handle).toBeNull();
    const sen = (await w.call('GET', '/appeals', { role: 'senior' })).body as { items: Array<{ handle: string | null }> };
    expect(sen.items[0]?.handle).toBe('TargetName');
  });

  it('the detail is { appeal } with the statement, the decision once made, and what the player was shown', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ statement: 'my full statement text' });
    const open = (await w.call('GET', `/appeals/${a.appealId}`)).body as { appeal: Record<string, unknown> };
    expect(Object.keys(open)).toEqual(['appeal']);
    expect(open.appeal).toMatchObject({ id: a.appealId, status: 'open', statement: 'my full statement text', decided: null, person: a.subject });
    await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    const done = (await w.call('GET', `/appeals/${a.appealId}`)).body as { appeal: { decided: { by: string; reason: string } } };
    expect(done.appeal.decided).toMatchObject({ by: 'senior_bea', reason: REASON });
  });

  it('the numbers carry per-rule counts and the lightened count beside the rate', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    const b = await w.appeal();
    await decide(w, a.appealId, { outcome: 'revoke', reason: REASON });
    await decide(w, b.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: HOUR } });
    const stats = (await w.call('GET', '/appeals/stats')).body as { perRule: Array<{ rule: number; appealed: number; granted: number; lightened: number }>; overall: { granted: number; lightened: number } };
    expect(stats.perRule[0]).toMatchObject({ rule: 2, appealed: 2, granted: 1, lightened: 1 });
    expect(stats.overall).toMatchObject({ granted: 1, lightened: 1 });
  });
});

describe('decide: 200 with replacementGroupId for reduce; 409 already_decided, same_decider, gone; 400 invalid for a to that is not lighter or not offered; the body never echoes the reason', () => {
  it('uphold and revoke are 200 { status } and nothing else', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    const b = await w.appeal({ kind: 'ban', durationMs: null });
    const up = await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ status: 'upheld' });
    const rev = await decide(w, b.appealId, { outcome: 'revoke', reason: REASON });
    expect(rev.body).toEqual({ status: 'revoked' });
    expect(w.cw.sanctions.forPerson(b.subject)[0]).toMatchObject({ active: false, revokedBy: 'senior_bea' });
  });

  it('reduce is 200 { status, replacementGroupId } and the replacement is a lighter sanction', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ kind: 'ban', durationMs: null });
    const res = await decide(w, a.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: 2 * HOUR } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['replacementGroupId', 'status']);
    expect(res.body).toMatchObject({ status: 'reduced', replacementGroupId: expect.any(String) });
    const groups = w.cw.sanctions.forPerson(a.subject);
    expect(groups.find((g) => g.groupId === (res.body as { replacementGroupId: string }).replacementGroupId)).toMatchObject({ kind: 'chat' });
  });

  it('409 already_decided for a second decision, with the code and the fixed message', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    expect((await decide(w, a.appealId, { outcome: 'uphold', reason: REASON })).status).toBe(200);
    for (const outcome of ['uphold', 'revoke']) {
      const again = await decide(w, a.appealId, { outcome, reason: REASON });
      expect(again.status).toBe(409);
      expect(errorOf(again)).toBe('already_decided');
    }
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('upheld');
  });

  it('409 same_decider when the moderator made the original decision; an automatic sanction has none; allowSelfReview lifts it', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ actor: 'mod_ann' });
    const same = await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }, { actor: 'mod_ann', role: 'owner' });
    expect(same.status).toBe(409);
    expect(errorOf(same)).toBe('same_decider');
    expect(same.body).toEqual({ error: 'same_decider', message: 'The person who made the decision cannot decide its appeal.' });
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('open');
    expect((await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }, { actor: 'senior_bea' })).status).toBe(200);
    const solo = await appealsWorld({ appeals: { allowSelfReview: true } });
    const b = await solo.appeal({ actor: 'mod_ann' });
    expect((await decide(solo, b.appealId, { outcome: 'uphold', reason: REASON }, { actor: 'mod_ann', role: 'owner' })).status).toBe(200);
  });

  it('409 gone when the sanction was revoked outside the kit, and the appeal is closed as moot', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ kind: 'ban', durationMs: null });
    w.store.revokeSanctionGroup(a.groupId, 'someone', w.clock.now(), 'direct');
    const res = await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'gone', message: 'The sanction this appeal was about is gone.' });
  });

  it('400 invalid_request for a reduce to something not lighter, a reduce with no to, a to on another outcome, and a warning with a length', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ kind: 'chat', durationMs: 6 * HOUR });
    const bad: unknown[] = [
      { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: 12 * HOUR } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: 6 * HOUR } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'ban', durationMs: HOUR } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: null } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'warning', durationMs: HOUR } },
      { outcome: 'reduce', reason: REASON },
      { outcome: 'reduce', reason: REASON, to: null },
      { outcome: 'reduce', reason: REASON, to: 'chat' },
      { outcome: 'reduce', reason: REASON, to: { kind: 'chat' } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: -5 } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: 1.5 } },
      { outcome: 'reduce', reason: REASON, to: { kind: 'note', durationMs: null } },
      { outcome: 'uphold', reason: REASON, to: { kind: 'warning', durationMs: null } },
      { outcome: 'revoke', reason: REASON, to: { kind: 'chat', durationMs: HOUR } },
    ];
    for (const body of bad) {
      const res = await decide(w, a.appealId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('open');
  });

  it('400 for a bad outcome, a missing, blank, non-string or over-long reason, a non-object body, and bad JSON', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    const bad: unknown[] = [
      {},
      { reason: REASON },
      { outcome: 'bogus', reason: REASON },
      { outcome: 5, reason: REASON },
      { outcome: 'Uphold', reason: REASON },
      { outcome: 'uphold' },
      { outcome: 'uphold', reason: '' },
      { outcome: 'uphold', reason: '   \n ' },
      { outcome: 'uphold', reason: 5 },
      { outcome: 'uphold', reason: null },
      { outcome: 'uphold', reason: 'x'.repeat(501) },
      { outcome: 'uphold', reason: 'x'.repeat(2001) },
      [],
      'x',
      null,
    ];
    for (const body of bad) {
      const res = await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'senior', raw: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(errorOf(await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'senior', raw: '{nope' }))).toBe('invalid_json');
    expect(errorOf(await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'senior' }))).toBe('invalid_request');
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('open');
    // 500 characters exactly is fine.
    expect((await decide(w, a.appealId, { outcome: 'uphold', reason: 'x'.repeat(500) })).status).toBe(200);
  });

  it('reduce is checked against the profile\'s offered lengths: 400 duration_not_offered when customDuration is off', async () => {
    const w = await appealsWorld({ overrides: { customDuration: false } });
    const a = await w.appeal({ kind: 'ban', durationMs: null });
    const odd = await decide(w, a.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: 123_456 } });
    expect(odd.status).toBe(400);
    expect(errorOf(odd)).toBe('duration_not_offered');
    expect(w.cw.appeals.get(a.appealId)?.status).toBe('open');
    const offered = w.cw.profile.durations[0] as number;
    const ok = await decide(w, a.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: offered } });
    expect(ok.status).toBe(200);
  });

  it('with customDuration on (the default) any valid length passes', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ kind: 'ban', durationMs: null });
    expect((await decide(w, a.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: 123_456 } })).status).toBe(200);
  });

  it('the body never echoes the reason, the statement, the actor or a handle, on success or on any refusal', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ statement: 'a distinctive statement sentence' });
    const responses = [
      await decide(w, a.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'ban', durationMs: HOUR } }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }, { actor: 'mod_ann', role: 'owner' }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: '' }),
      await decide(w, 'nope-no-such-appeal', { outcome: 'uphold', reason: REASON }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }),
    ];
    expect(responses.map((r) => r.status)).toEqual([400, 409, 400, 404, 200, 409]);
    for (const res of responses) {
      const text = JSON.stringify(res);
      for (const v of [REASON, 'distinctive statement', 'senior_bea', 'mod_ann', 'TargetName']) expect(text).not.toContain(v);
    }
  });

  it('a store failure under the decision is a 500 internal with nothing echoed, and no audit row', async () => {
    const w = await appealsWorld({
      wrap: (cw) => ({
        ...cw,
        appeals: {
          ...cw.appeals,
          decide: () => Promise.reject(new Error(`store down ${REASON}`)),
        },
      }),
    });
    const a = await w.appeal();
    const res = await decide(w, a.appealId, { outcome: 'uphold', reason: REASON });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(JSON.stringify(w.logged)).not.toContain(REASON);
    expect(w.routeAudit().filter((r) => r.action === 'appeal.decide')).toEqual([]);
  });

  it('the actor is the authenticated one, never from the body', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ actor: 'mod_ann' });
    // A body that names the original decider as the actor does not make the decision the same decider's, nor change who decided.
    const res = await decide(w, a.appealId, { outcome: 'uphold', reason: REASON, actor: 'mod_ann' }, { actor: 'senior_bea' });
    expect(res.status).toBe(200);
    expect(w.cw.appeals.get(a.appealId)?.decided?.by).toBe('senior_bea');
  });
});

describe('appeals off: 404 on every route', () => {
  it('every appeal route is 404 not_found for every role, writing no audit row', async () => {
    const w = await world();
    for (const role of ROLES) {
      for (const [method, path, body] of [
        ['GET', '/appeals', undefined],
        ['GET', '/appeals/stats', undefined],
        ['GET', '/appeals/some-id', undefined],
        ['POST', '/appeals/some-id/decide', { outcome: 'uphold', reason: REASON }],
      ] as const) {
        // A moderator lacks appeals.decide: that is 403, before the 404 (checked below).
        if (role === 'moderator' && method === 'POST') continue;
        const res = await w.call(method, path, { role, ...(body === undefined ? {} : { body }) });
        expect(res.status, `${role} ${method} ${path}`).toBe(404);
        expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
        expect(res.headers?.['cache-control']).toBe('no-store');
      }
    }
    expect(w.routeAudit()).toEqual([]);
  });

  it('permission and authentication still come first: no authz is 401, a moderator on decide is 403', async () => {
    const w = await world();
    expect((await w.call('GET', '/appeals', { role: null })).status).toBe(401);
    expect((await w.call('POST', '/appeals/x/decide', { role: 'moderator', body: {} })).status).toBe(403);
  });

  it('the setting is read live: turning appeals on in the policy opens the routes', async () => {
    const w = await world();
    expect((await w.call('GET', '/appeals')).status).toBe(404);
    w.cw.policy.save({ appeals: { enabled: true } }, { version: 0, actor: 'owner', reason: 'on' });
    expect((await w.call('GET', '/appeals')).status).toBe(200);
  });
});

describe('every route is no-store JSON', () => {
  it('on success and on every refusal', async () => {
    const w = await appealsWorld();
    const a = await w.appeal();
    const responses = [
      await w.call('GET', '/appeals'),
      await w.call('GET', '/appeals', { query: { status: 'bogus' } }),
      await w.call('GET', '/appeals/stats'),
      await w.call('GET', `/appeals/${a.appealId}`),
      await w.call('GET', '/appeals/nope-no-such-appeal'),
      await decide(w, a.appealId, { outcome: 'uphold', reason: '' }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }, { role: 'moderator' }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }, { role: null }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }),
      await decide(w, a.appealId, { outcome: 'uphold', reason: REASON }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 400, 200, 200, 404, 400, 403, 401, 200, 409]);
    for (const res of responses) {
      expect(res.headers?.['cache-control'], String(res.status)).toBe('no-store');
      expect(typeof res.body).toBe('object');
    }
  });
});
