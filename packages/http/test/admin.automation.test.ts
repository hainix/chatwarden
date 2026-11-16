import { describe, expect, it } from 'vitest';
import type { Role } from '@chatwarden/http';
import { errorOf, world } from './world.js';

// `PUT /people/:id/automation { allowed, code? }` (AI levels 3 and 4, design 6.4 and 6.6): a senior marks a person "do not automate" (a closed reason code, no free
// text) or clears the mark. Permission `automation.write` (senior, lowerable). Audited as `person.automation` with the person as target, after the write,
// best-effort. The actor is the caller, never the body. Nothing here lets the AI act: it only records who the AI must leave alone.

type W = Awaited<ReturnType<typeof world>>;

const put = (w: W, ref: string, body: unknown = { allowed: false, code: 'vulnerable' }, o: { role?: Role | null; actor?: string } = {}) =>
  w.call('PUT', `/people/${ref}/automation`, { role: o.role === undefined ? 'senior' : o.role, actor: o.actor ?? 'sen_ann', body });

describe('PUT /people/:id/automation', () => {
  it('a senior gets 200 { ok: true }, the mark is set, and an audit row person.automation names the person, the caller and the role', async () => {
    const w = await world();
    const person = w.person();
    const res = await put(w, person);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(w.cw.people.automation.get(person)).toMatchObject({ allowed: false, code: 'vulnerable' });
    expect(w.routeAudit().map((r) => [r.actor, r.role, r.action, r.target])).toEqual([['sen_ann', 'senior', 'person.automation', { type: 'person', ref: person }]]);
    // the row carries ids only: no code, no reason, no detail
    expect(w.routeAudit()[0]).not.toHaveProperty('detail');
    expect(JSON.stringify(w.routeAudit())).not.toContain('vulnerable');
  });

  it('a moderator gets 403 and nothing is written (no mark, no audit row)', async () => {
    const w = await world();
    const person = w.person();
    const res = await put(w, person, { allowed: false, code: 'vulnerable' }, { role: 'moderator' });
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe('forbidden');
    expect(w.cw.people.automation.get(person).allowed).toBe(true);
    expect(w.routeAudit()).toEqual([]);
  });

  it('no authz is 401 before the body is read, and a moderator is 403 before the body is read', async () => {
    const w = await world();
    const person = w.person();
    expect((await w.call('PUT', `/people/${person}/automation`, { role: null, raw: '{nope' })).status).toBe(401);
    expect((await w.call('PUT', `/people/${person}/automation`, { role: 'moderator', raw: '{nope' })).status).toBe(403);
    expect(w.routeAudit()).toEqual([]);
  });

  it('the owner may too', async () => {
    const w = await world();
    const person = w.person();
    expect((await put(w, person, undefined, { role: 'owner' })).status).toBe(200);
  });

  it('the permissions option lowers it to moderator, and raises it to owner', async () => {
    const low = await world({ permissions: { 'automation.write': 'moderator' } });
    const a = low.person();
    expect((await put(low, a, undefined, { role: 'moderator' })).status).toBe(200);
    const high = await world({ permissions: { 'automation.write': 'owner' } });
    const b = high.person();
    expect((await put(high, b, undefined, { role: 'senior' })).status).toBe(403);
    expect((await put(high, b, undefined, { role: 'owner' })).status).toBe(200);
  });

  it('clearing (allowed true, no code) removes the mark and is audited too', async () => {
    const w = await world();
    const person = w.person();
    await put(w, person);
    const res = await put(w, person, { allowed: true });
    expect(res.status).toBe(200);
    expect(w.cw.people.automation.get(person)).toEqual({ allowed: true, code: null, at: null });
    expect(w.routeAudit().map((r) => r.action)).toEqual(['person.automation', 'person.automation']);
  });

  it('every code is accepted', async () => {
    const w = await world();
    for (const code of ['vulnerable', 'under_review', 'staff', 'sensitive_case', 'other']) {
      const person = w.person();
      expect((await put(w, person, { allowed: false, code })).status, code).toBe(200);
      expect(w.cw.people.automation.get(person)).toMatchObject({ allowed: false, code });
    }
  });

  it('a bad body is 400 and writes nothing: no mark, no audit row', async () => {
    const w = await world();
    const person = w.person();
    const bad: unknown[] = [
      {},
      { code: 'vulnerable' },
      { allowed: 'false', code: 'vulnerable' },
      { allowed: 0, code: 'vulnerable' },
      { allowed: null },
      { allowed: false },
      { allowed: false, code: '' },
      { allowed: false, code: 'because I said so' },
      { allowed: false, code: 'VULNERABLE' },
      { allowed: false, code: 7 },
      { allowed: false, code: ['other'] },
      { allowed: false, code: null },
      { allowed: true, code: 'other' },
      // free text, an actor and an unknown field never ride along
      { allowed: false, code: 'other', note: 'they are a minor' },
      { allowed: false, code: 'other', reason: 'x' },
      { allowed: false, code: 'other', actor: 'someone_else' },
      [],
      'false',
      null,
      7,
    ];
    for (const body of bad) {
      const res = await put(w, person, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await w.call('PUT', `/people/${person}/automation`, { role: 'senior', raw: '{nope' })).status).toBe(400);
    expect((await w.call('PUT', `/people/${person}/automation`, { role: 'senior' })).status).toBe(400);
    expect(w.cw.people.automation.get(person).allowed).toBe(true);
    expect(w.routeAudit()).toEqual([]);
  });

  it('an unknown person is 404 and writes nothing', async () => {
    const w = await world();
    for (const ref of ['s_nobody', 'x', 'S_NOBODY']) {
      const res = await put(w, ref);
      expect(res.status, ref).toBe(404);
      expect(errorOf(res)).toBe('not_found');
    }
    expect(w.routeAudit()).toEqual([]);
  });

  it('the actor is the authenticated caller: the stored setBy is the actor header, whatever the body says is refused', async () => {
    const w = await world();
    const person = w.person();
    await put(w, person, { allowed: false, code: 'staff' }, { actor: 'sen_bea' });
    const store = w.store as unknown as { loadNoAutomation(s: string): { setBy: string } | null };
    expect(store.loadNoAutomation(person)?.setBy).toBe('sen_bea');
    expect(w.routeAudit()[0]?.actor).toBe('sen_bea');
  });

  it('the audit target is the canonical person: a mark through an alias is recorded against the person it marks', async () => {
    const w = await world();
    // two clients that are one person: the same account on two keys
    w.cw.rooms.seat('r-a', 'p1', { clientKey: 'k-alias-a', accountId: 'acct-merge' }, 'A');
    const a = w.cw.rooms.subjectAt('r-a', 'p1') as string;
    w.cw.rooms.seat('r-b', 'p1', { clientKey: 'k-alias-b' }, 'B');
    const b = w.cw.rooms.subjectAt('r-b', 'p1') as string;
    w.cw.rooms.seat('r-b2', 'p1', { clientKey: 'k-alias-b', accountId: 'acct-merge' }, 'B');
    const root = w.cw.people.canonical(a);
    expect(w.cw.people.canonical(b)).toBe(root);
    const alias = a === root ? b : a;
    expect((await put(w, alias)).status).toBe(200);
    expect(w.routeAudit()[0]?.target).toEqual({ type: 'person', ref: root });
    expect(w.cw.people.automation.get(root).allowed).toBe(false);
  });

  it('the audit is best-effort: when the row cannot be written the mark stands and the answer is still 200', async () => {
    const w = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const person = w.person();
    const res = await put(w, person);
    expect(res.status).toBe(200);
    expect(w.cw.people.automation.get(person).allowed).toBe(false);
  });

  it('a store without the methods answers 404, with nothing written and no audit row', async () => {
    const w = await world({
      wrap: (cw) => ({
        ...cw,
        people: { ...cw.people, automation: { ...cw.people.automation, set: () => ({ ok: false, error: 'unsupported' }) } },
      }),
    });
    const person = w.person();
    const res = await put(w, person);
    expect(res.status).toBe(404);
    expect(w.routeAudit()).toEqual([]);
  });

  it('other methods on the path are 405', async () => {
    const w = await world();
    const person = w.person();
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const res = await w.call(method, `/people/${person}/automation`, { role: 'owner', body: { allowed: true } });
      expect(res.status, method).toBe(405);
    }
  });

  it('the route reads nothing the AI uses: setting the mark makes no AI call and changes no gate', async () => {
    const w = await world({ ai: { level: 2 } });
    const before = JSON.stringify(w.cw.ai.gates());
    const person = w.person();
    await put(w, person);
    expect(w.adapter?.callCount).toBe(0);
    expect(JSON.stringify(w.cw.ai.gates())).toBe(before);
  });
});
