import { describe, expect, it } from 'vitest';
import type { KitResponse } from '../src/index.js';
import { PERMISSION_KEYS } from '../src/index.js';
import { SCOPE_AWARE_PERMISSIONS } from '../src/admin/context.js';
import { DAY, errorOf, world } from './world.js';
import type { Role } from '../src/index.js';

// M2: staff scope over the real routes and the real SQLite store. A scoped caller (`authorize` returned `scope`) sees and acts on the reports whose room carried one of its
// labels, and nothing else: an out-of-scope id is 404 (the body of an unknown id), a report with no scope is invisible, a route that did not declare itself is 403.

const A = 'creator:alice';
const B = 'creator:bob';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: KitResponse): Record<string, any> => res.body as Record<string, any>;
const labels = (n: number): string[] => Array.from({ length: n }, (_, i) => `l${i}`);

describe('Authz.scope is checked like the rest of Authz: a malformed one is 401 (fail closed)', () => {
  it('1 and 20 labels of the grammar are accepted', async () => {
    const w = await world();
    for (const scope of [[A], labels(20), ['0abc'], ['a:b_c.d-e'], ['x'.repeat(64)]]) {
      expect((await w.call('GET', '/me', { scopeRaw: scope })).status, JSON.stringify(scope)).toBe(200);
    }
  });

  it('0 labels, 21 labels, a label with a space or 65 characters or an upper-case letter, a non-array, a non-string label and role owner with a scope are 401', async () => {
    const w = await world();
    const bad: unknown[] = [[], labels(21), ['a b'], ['x'.repeat(65)], ['Creator'], [''], [':x'], 'creator:alice', 5, {}, null, [5], [null], [A, 5], [['a']], [A, A + ' ']];
    for (const scope of bad) {
      const res = await w.call('GET', '/me', { scopeRaw: scope });
      // `null` is JSON for a missing scope on the wire of this world: it reaches authorize as `scope: null`, which is not a list of labels
      expect(res.status, JSON.stringify(scope)).toBe(401);
      expect(errorOf(res)).toBe('unauthorized');
    }
    const owner = await w.call('GET', '/me', { role: 'owner', scope: [A] });
    expect(owner.status).toBe(401);
    // a malformed scope is refused on every route kind, not only /me
    expect((await w.call('GET', '/reports', { scopeRaw: [] })).status).toBe(401);
    expect((await w.call('GET', '/policy', { scopeRaw: ['a b'] })).status).toBe(401);
    expect((await w.call('POST', '/cases/next', { scopeRaw: 'x', body: {} })).status).toBe(401);
  });

  it('a senior may be scoped; the label list is not changed by the kit (a duplicate is allowed and harmless)', async () => {
    const w = await world();
    expect((await w.call('GET', '/me', { role: 'senior', scope: [A, A] })).status).toBe(200);
  });
});

describe('GET /me', () => {
  it('for a scoped caller lists scope and only the scope-aware permissions; for a global caller it is unchanged', async () => {
    const w = await world();
    const global = body(await w.call('GET', '/me', { role: 'senior' }));
    expect(Object.keys(global).sort()).toEqual(['actor', 'can', 'features', 'role']);
    expect(global.scope).toBeUndefined();
    expect(global.can['policy.write']).toBe(false);
    expect(global.can['settings']).toBeDefined();

    const scoped = body(await w.call('GET', '/me', { role: 'senior', scope: [A, B] }));
    expect(scoped.scope).toEqual([A, B]);
    expect(Object.keys(scoped).sort()).toEqual(['actor', 'can', 'features', 'role', 'scope', 'scopedLimits']);
    expect(Object.keys(scoped.can).sort()).toEqual([...PERMISSION_KEYS].sort());
    const on = Object.entries(scoped.can as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k).sort();
    // exactly the scope-aware permissions the senior holds, and the ones a scoped caller may never use are false even where the senior holds them
    const aware = [...SCOPE_AWARE_PERMISSIONS].filter((k) => global.can[k] === true).sort();
    expect(on).toEqual(aware);
    for (const k of ['settings', 'policy.read', 'policy.write', 'terms.read', 'terms.write', 'audit.read', 'blocked.read', 'appeals.read', 'appeals.decide', 'gaps.read', 'rooms.manage', 'reports.decide.bulk', 'sanctions.apply.ban_permanent', 'automation.write', 'legal.hold', 'insights.read']) {
      expect(scoped.can[k], k).toBe(false);
    }
    for (const k of ['reports.read', 'reports.decide', 'history.read', 'sanctions.apply', 'sanctions.revoke', 'reasons.read']) expect(scoped.can[k], k).toBe(true);
  });

  it('a scoped moderator is not shown what a moderator could do in a kit that lowered every permission', async () => {
    const low = await world({ permissions: { 'terms.write': 'moderator', 'policy.write': 'moderator', 'audit.read': 'moderator' } });
    const g = body(await low.call('GET', '/me', { role: 'moderator' }));
    expect(g.can['terms.write'] && g.can['policy.write'] && g.can['audit.read']).toBe(true);
    const s = body(await low.call('GET', '/me', { role: 'moderator', scope: [A] }));
    expect(s.can['terms.write'] || s.can['policy.write'] || s.can['audit.read']).toBe(false);
  });
});

describe('the queue, take next and the change counts', () => {
  it('a global caller sees every report exactly as before; an unscoped report is invisible to a scoped caller; a report in scope appears', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(B);
    const none = await w.fileIn(null);
    const idsOf = async (o: { scope?: string[] }) => body(await w.call('GET', '/reports', o)).items.map((i: { id: string }) => i.id).sort();
    expect(await idsOf({})).toEqual([a.id, b.id, none.id].sort());
    expect(await idsOf({ scope: [A] })).toEqual([a.id]);
    expect(await idsOf({ scope: [B] })).toEqual([b.id]);
    expect(await idsOf({ scope: [A, B] })).toEqual([a.id, b.id].sort());
    expect(await idsOf({ scope: ['creator:nobody'] })).toEqual([]);
    expect(body(await w.call('GET', '/reports', { scope: [A] })).next).toBeNull();
  });

  it('the scoped queue rows carry the same keys as the global ones for the same report, with no reporter accuracy or signal boost', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const g = body(await w.call('GET', '/reports')).items.find((i: { id: string }) => i.id === a.id);
    const s = body(await w.call('GET', '/reports', { scope: [A] })).items[0];
    expect(s.id).toBe(a.id);
    for (const k of Object.keys(s)) expect(Object.keys(g), k).toContain(k);
    expect(s.reporterAccuracy ?? null).toBeNull();
    expect(s.boosted ?? false).toBe(false);
  });

  it('paging, status and urgent filters keep the scope', async () => {
    const w = await world();
    const mine: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      mine.push((await w.fileIn(A)).id);
      await w.fileIn(B);
    }
    const p1 = body(await w.call('GET', '/reports', { scope: [A], query: { limit: '2' } }));
    expect(p1.items).toHaveLength(2);
    const p2 = body(await w.call('GET', '/reports', { scope: [A], query: { limit: '2', cursor: p1.next } }));
    expect([...p1.items, ...p2.items].map((i: { id: string }) => i.id)).toEqual([...mine].reverse());
    expect(body(await w.call('GET', '/reports', { scope: [A], query: { status: 'actioned' } })).items).toEqual([]);
    expect(body(await w.call('GET', '/reports', { scope: [A], query: { urgent: '1' } })).items).toEqual([]);
  });

  it('take next serves only a case in scope and answers { case: null } when none is', async () => {
    const w = await world();
    const b = await w.fileIn(B);
    await w.fileIn(null);
    expect(body(await w.call('POST', '/cases/next', { scope: [A], body: {} })).case).toBeNull();
    const a = await w.fileIn(A);
    const next = body(await w.call('POST', '/cases/next', { scope: [A], body: {} }));
    expect(next.case.reportId).toBe(a.id);
    expect(body(await w.call('POST', '/cases/next', { scope: [B], actor: 'bea', body: {} })).case.reportId).toBe(b.id);
  });

  it('GET /changes counts only the urgent reports in scope and leaves out the appeals and asked counts', async () => {
    const w = await world();
    await w.fileIn(A, { urgent: true });
    await w.fileIn(B, { urgent: true });
    await w.fileIn(B, { urgent: true });
    expect(body(await w.call('GET', '/changes')).urgent).toBe(3);
    const mine = body(await w.call('GET', '/changes', { scope: [A] }));
    expect(mine.urgent).toBe(1);
    expect(Object.keys(mine).sort()).toEqual(['changed', 'token', 'urgent']);
    expect(body(await w.call('GET', '/changes', { scope: [B] })).urgent).toBe(2);
    expect(body(await w.call('GET', '/changes', { scope: ['creator:nobody'] })).urgent).toBe(0);
  });

  it('the urgent queue (urgent=1) is scoped', async () => {
    const w = await world();
    const a = await w.fileIn(A, { urgent: true });
    await w.fileIn(B, { urgent: true });
    expect(body(await w.call('GET', '/reports', { scope: [A], query: { urgent: '1' } })).items.map((i: { id: string }) => i.id)).toEqual([a.id]);
  });
});

describe('an id out of scope is 404 with the body of an unknown id', () => {
  const same = (res: KitResponse, unknown: KitResponse): void => {
    expect(res.status).toBe(404);
    expect(res).toEqual(unknown);
    expect(errorOf(res)).toBe('not_found');
  };

  it('GET /reports/:id, decide, suggest, claim, release and viewing answer exactly what an unknown id answers', async () => {
    const w = await world();
    const b = await w.fileIn(B);
    const none = await w.fileIn(null);
    const decide = { verdict: 'upheld', actions: [{ subject: b.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'x' };
    for (const r of [b, none]) {
      const o = { scope: [A], role: 'moderator' as Role };
      const ghost = 'r_unknown_000000';
      same(await w.call('GET', `/reports/${r.id}`, o), await w.call('GET', `/reports/${ghost}`, o));
      same(await w.call('POST', `/reports/${r.id}/suggest`, { ...o, body: {} }), await w.call('POST', `/reports/${ghost}/suggest`, { ...o, body: {} }));
      same(await w.call('POST', `/reports/${r.id}/decide`, { ...o, body: decide }), await w.call('POST', `/reports/${ghost}/decide`, { ...o, body: { ...decide, actions: [{ ...decide.actions[0], subject: 's_unknown' }] } }));
      same(await w.call('POST', `/cases/${r.target}/claim`, { ...o, body: {} }), await w.call('POST', '/cases/s_unknown_person/claim', { ...o, body: {} }));
      same(await w.call('POST', `/cases/${r.target}/release`, { ...o, body: {} }), await w.call('POST', '/cases/s_unknown_person/release', { ...o, body: {} }));
      same(await w.call('POST', `/cases/${r.target}/viewing`, { ...o, body: {} }), await w.call('POST', '/cases/s_unknown_person/viewing', { ...o, body: {} }));
    }
    // nothing was written or claimed by the refused calls, and the reports are untouched
    expect(w.cw.reports.get(b.id)?.status).toBe('open');
    expect(w.cw.cases.holder(b.target)).toBeNull();
    expect(w.routeAudit().filter((r) => r.action !== 'report.view')).toEqual([]);
  });

  it('the same calls as a global caller (or one with the right scope) work, so the 404 is the scope and nothing else', async () => {
    const w = await world();
    const b = await w.fileIn(B);
    for (const o of [{}, { scope: [B] }, { scope: [A, B] }]) {
      expect((await w.call('GET', `/reports/${b.id}`, o)).status, JSON.stringify(o)).toBe(200);
      expect((await w.call('POST', `/reports/${b.id}/suggest`, { ...o, body: {} })).status).toBe(200);
      expect((await w.call('POST', `/cases/${b.target}/viewing`, { ...o, body: {} })).status).toBe(200);
    }
    expect((await w.call('POST', `/cases/${b.target}/claim`, { scope: [B], body: {} })).status).toBe(200);
    expect((await w.call('POST', `/cases/${b.target}/release`, { scope: [B], body: {} })).status).toBe(200);
  });

  it('a person with an open report in two scopes is two cases: neither scope sees the other\'s report, and a decision in one leaves the other open', async () => {
    const w = await world();
    const a = await w.fileIn(A, { targetKey: 'one-person-aaaaaaaaaaaaaaaa' });
    const b = await w.fileIn(B, { targetKey: 'one-person-aaaaaaaaaaaaaaaa' });
    expect(a.target).toBe(b.target);
    expect(body(await w.call('GET', '/reports', { scope: [A] })).items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    expect((await w.call('GET', `/reports/${b.id}`, { scope: [A] })).status).toBe(404);
    const done = await w.call('POST', `/reports/${a.id}/decide`, { scope: [A], actor: 'alice_mod', body: { verdict: 'upheld', actions: [{ subject: a.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'in scope' } });
    expect(done.status).toBe(200);
    expect(w.cw.reports.get(b.id)?.status).toBe('open');
    expect(w.cw.reports.get(a.id)?.status).toBe('actioned');
  });

  it('a decision a scoped moderator makes is audited with the same actor and the same detail as a global one', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const g = await w.fileIn(null);
    const act = (r: { target: string }) => ({ verdict: 'upheld', actions: [{ subject: r.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'a decision' });
    expect((await w.call('POST', `/reports/${a.id}/decide`, { scope: [A], actor: 'scoped_sam', body: act(a) })).status).toBe(200);
    expect((await w.call('POST', `/reports/${g.id}/decide`, { actor: 'global_gus', body: act(g) })).status).toBe(200);
    const rows = w.routeAudit().filter((r) => r.action === 'report.decide');
    expect(rows).toHaveLength(2);
    const scoped = rows.find((r) => r.actor === 'scoped_sam')!;
    const global = rows.find((r) => r.actor === 'global_gus')!;
    expect({ ...scoped, actor: '', at: 0, id: '', target: scoped.target && { ...scoped.target, ref: '' } }).toEqual({ ...global, actor: '', at: 0, id: '', target: global.target && { ...global.target, ref: '' } });
    expect(JSON.stringify(scoped)).not.toContain(A);
  });

  it('a spy logger sees no scope label, no actor and no report id in any log line of a refused call', async () => {
    const w = await world();
    const b = await w.fileIn(B);
    w.logged.length = 0;
    for (const [m, p, o] of [
      ['GET', `/reports/${b.id}`, {}],
      ['POST', `/reports/${b.id}/decide`, { body: { verdict: 'no_action', actions: [], reason: 'x' } }],
      ['POST', `/cases/${b.target}/claim`, { body: {} }],
      ['GET', '/audit', {}],
      ['GET', '/policy', {}],
    ] as const) {
      await w.call(m, p, { scope: [A], actor: 'secret_actor', ...o });
    }
    const text = JSON.stringify(w.logged);
    for (const leak of [A, B, 'secret_actor', b.id, b.target]) expect(text).not.toContain(leak);
  });

  it('refused calls and 404s write no audit row (a read of a case in scope does)', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(B);
    await w.call('GET', `/reports/${b.id}`, { scope: [A] });
    await w.call('GET', '/audit', { scope: [A] });
    expect(w.routeAudit()).toEqual([]);
    await w.call('GET', `/reports/${a.id}`, { scope: [A] });
    expect(w.routeAudit().map((r) => r.action)).toEqual(['report.view']);
  });
});

describe('the case a scoped moderator reads', () => {
  it('the history inside it is the scoped one, the surge and AI are left out, and the report body is otherwise the global one', async () => {
    const w = await world();
    const a = await w.fileIn(A, { targetKey: 'case-person-aaaaaaaaaaaaaaa' });
    w.clock.t += DAY;
    const b = await w.fileIn(B, { targetKey: 'case-person-aaaaaaaaaaaaaaa' });
    expect((await w.call('POST', `/reports/${b.id}/decide`, { scope: [B], body: { verdict: 'upheld', actions: [{ subject: b.target, kind: 'chat', durationMs: 3_600_000, rule: 1 }], reason: 'other room' } })).status).toBe(200);
    const g = body(await w.call('GET', `/reports/${a.id}`));
    const s = body(await w.call('GET', `/reports/${a.id}`, { scope: [A] }));
    expect(g.history[a.target]).toHaveLength(1);
    expect(s.history[a.target]).toEqual([]);
    expect(s.report.id).toBe(a.id);
    expect(s.ai ?? null).toBeNull();
    expect(Object.keys(s).filter((k) => k !== 'ai').sort()).toEqual(Object.keys(g).filter((k) => k !== 'ai').sort());
    // the suggestion is built from what the scoped moderator can see: a chat restriction in another room does not raise it
    expect(JSON.stringify(s.suggest)).not.toEqual(JSON.stringify(g.suggest));
    expect(JSON.stringify(s)).not.toContain(B);
  });

  it('the report body carries no scope column of its own (the room tags already do)', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    expect(body(await w.call('GET', `/reports/${a.id}`, { scope: [A] })).report.scope).toBeUndefined();
    expect(body(await w.call('GET', `/reports/${a.id}`)).report.scope).toBeUndefined();
  });
});
