import { describe, expect, it } from 'vitest';
import type { KitResponse, Role } from '../src/index.js';
import { PERMISSION_KEYS } from '../src/index.js';
import { SCOPED_DEFAULT_LIMITS, isScopeAware } from '../src/admin/context.js';
import { communityWorld } from './communityWorld.js';
import { DAY, HOUR, errorOf, world } from './world.js';

// M2: the guard over EVERY admin route. A route is either marked scope-aware (and then its own tests below prove what it does for a scoped caller) or answers 403 to one.
// Adding a route to the admin table without deciding which fails the table test here: that is the point (a later theme's route is denied until it declares itself).

const A = 'creator:alice';
const B = 'creator:bob';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: KitResponse): Record<string, any> => res.body as Record<string, any>;

const SCOPE_AWARE_ROUTES = [
  'GET /changes',
  'GET /me',
  'GET /people/:ref/history',
  'GET /reasons',
  'GET /reports',
  'GET /reports/:id',
  'GET /sanctions',
  'POST /cases/:ref/claim',
  'POST /cases/:ref/release',
  'POST /cases/:ref/viewing',
  'POST /cases/next',
  'POST /reports/:id/decide',
  'POST /reports/:id/suggest',
  'POST /sanctions',
  'POST /sanctions/:groupId/revoke',
];

/** Everything else in the table today. A route a later theme adds must be put in one of the two lists. */
const DENIED_ROUTES = [
  'DELETE /policy/profile',
  'DELETE /reports/:id/comments/:cid',
  'DELETE /reports/:id/escalate',
  'DELETE /reports/:id/hold',
  'GET /ai/acting',
  'GET /ai/actions',
  'GET /ai/gates',
  'GET /ai/status',
  'GET /appeals',
  'GET /appeals/:id',
  'GET /appeals/stats',
  'GET /audit',
  'GET /blocked',
  'GET /community',
  'GET /filters/stats',
  'GET /gaps',
  'GET /insights',
  'GET /people/:ref/links',
  'GET /people/:ref/privacy/export',
  'GET /policy',
  'GET /policy/profile',
  'GET /privacy/statement',
  'GET /reports/:id/bundle',
  'GET /rooms',
  'GET /terms',
  'GET /terms/:id~ref',
  'GET /terms/:id~ref/share',
  'PATCH /exceptions/:id~ref',
  'PATCH /reasons/:id',
  'PATCH /terms/:id~ref',
  'POST /ai/acting/off',
  'POST /ai/acting/pause',
  'POST /ai/acting/resume',
  'POST /ai/acting/shadow',
  'POST /ai/acting/start',
  'POST /appeals/:id/decide',
  'POST /community/apply',
  'POST /community/refresh',
  'POST /exceptions',
  'POST /exceptions/:id~ref/active',
  'POST /filters/check',
  'POST /filters/test',
  'POST /gaps/:groupId/close',
  'POST /people/:ref/privacy/erase',
  'POST /people/:ref/rename',
  'POST /policy/profile/preview',
  'POST /privacy/find',
  'POST /reasons',
  'POST /reasons/:id/active',
  'POST /reports/:id/ai/dont-teach',
  'POST /reports/:id/ai/read',
  'POST /reports/:id/comments',
  'POST /reports/:id/escalate',
  'POST /reports/:id/handoff',
  'POST /reports/:id/urgent',
  'POST /reports/dismiss-open',
  'POST /rooms/:room~room/lines/:line/retract',
  'POST /rooms/:room~room/mode',
  'POST /terms',
  'POST /terms/:id~ref/active',
  'POST /terms/:id~ref/report',
  'POST /terms/:id~ref/share',
  'POST /terms/check',
  'POST /terms/lookup',
  'POST /terms/test',
  'PUT /people/:id/automation',
  'PUT /policy/profile',
  'PUT /reports/:id/hold',
];

/** A concrete path for a route key: every param filled with something the router accepts. */
const concrete = (key: string): { method: string; path: string } => {
  const [method, pattern] = key.split(' ') as [string, string];
  return { method, path: pattern.replace(/:room~room/, 'R1').replace(/:[A-Za-z]+(~ref)?/g, 'x1') };
};

describe('the table: every admin route is scope-aware or 403 to a scoped caller', () => {
  it('every route in the table is classified; the marked ones are exactly the scope-aware list (adding a route without deciding fails here)', async () => {
    const w = await communityWorld();
    const all = Object.keys(w.routes).sort();
    expect(all).toEqual([...SCOPE_AWARE_ROUTES, ...DENIED_ROUTES].sort());
    const marked = all.filter((k) => isScopeAware(w.routes[k]!));
    expect(marked).toEqual([...SCOPE_AWARE_ROUTES].sort());
    expect(new Set([...SCOPE_AWARE_ROUTES, ...DENIED_ROUTES]).size).toBe(SCOPE_AWARE_ROUTES.length + DENIED_ROUTES.length);
  });

  it('every route that is not scope-aware answers 403 forbidden to a scoped caller, even in a kit that lowered every permission; the same call from a global owner is not 403', async () => {
    const lowered = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'moderator'])) as Record<string, Role>;
    const w = await communityWorld({ permissions: lowered });
    for (const key of DENIED_ROUTES) {
      const { method, path } = concrete(key);
      for (const role of ['moderator', 'senior'] as const) {
        const res = await w.call(method, path, { role, scope: [A], body: {} });
        expect(res.status, `${key} as ${role}`).toBe(403);
        expect(errorOf(res), key).toBe('forbidden');
      }
      const control = await w.call(method, path, { role: 'owner', body: {} });
      expect(control.status, `${key} control (global owner)`).not.toBe(403);
    }
  });

  it('a scoped caller is 401 without authz, as before, on a denied route too (the scope check never replaces authentication)', async () => {
    const w = await world();
    expect((await w.call('GET', '/policy', { role: null })).status).toBe(401);
    expect((await w.call('GET', '/policy', { scope: [A] })).status).toBe(403);
  });

  it('the denied routes write no audit row and run no handler for a scoped caller', async () => {
    const w = await world();
    const r = await w.fileIn(A);
    const before = w.routeAudit().length;
    for (const [m, p, b] of [
      ['POST', `/reports/${r.id}/urgent`, { on: true }],
      ['POST', `/reports/${r.id}/handoff`, {}],
      ['POST', '/reports/dismiss-open', { scope: 'person', ref: r.target }],
      ['POST', `/people/${r.target}/rename`, { rule: 1, reason: 'x' }],
      ['PUT', `/reports/${r.id}/hold`, { code: 'other' }],
    ] as const) {
      expect((await w.call(m, p, { role: 'senior', scope: [A], body: b })).status, `${m} ${p}`).toBe(403);
    }
    expect(w.routeAudit()).toHaveLength(before);
    expect(w.cw.reports.get(r.id)).toMatchObject({ status: 'open', urgent: false });
  });

  it('a decision with a rename is refused to a scoped caller before anything is written', async () => {
    const w = await world({ overrides: { names: { renames: true } } });
    const a = await w.fileIn(A);
    const res = await w.call('POST', `/reports/${a.id}/decide`, { role: 'senior', scope: [A], body: { verdict: 'upheld', actions: [{ subject: a.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'x', rename: { rule: 1 } } });
    expect(res.status).toBe(403);
    expect(w.cw.reports.get(a.id)?.status).toBe('open');
  });
});

describe('GET /people/:ref/history, scoped', () => {
  it('returns the reports in scope and the sanctions from them, with no account ids, signals or linked-account fields; a person with nothing in scope is 404', async () => {
    const w = await world();
    const a = await w.fileIn(A, { targetKey: 'history-person-aaaaaaaaaaaaa' });
    w.clock.t += HOUR;
    const b = await w.fileIn(B, { targetKey: 'history-person-aaaaaaaaaaaaa' });
    await w.call('POST', `/reports/${a.id}/decide`, { body: { verdict: 'upheld', actions: [{ subject: a.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'in A' } });
    await w.call('POST', `/reports/${b.id}/decide`, { body: { verdict: 'upheld', actions: [{ subject: a.target, kind: 'chat', durationMs: HOUR, rule: 1 }], reason: 'in B' } });
    await w.call('POST', '/sanctions', { body: { subject: a.target, kind: 'ban', durationMs: DAY, rule: 1, reason: 'direct' } });

    const global = body(await w.call('GET', `/people/${a.target}/history`));
    expect(global.reports).toHaveLength(2);
    expect(global.sanctions).toHaveLength(3);
    expect(global.asReporter).toBeDefined();

    const res = await w.call('GET', `/people/${a.target}/history`, { scope: [A] });
    expect(res.status).toBe(200);
    const s = body(res);
    expect(s.reports.map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect(s.sanctions.map((x: { kind: string }) => x.kind)).toEqual(['warning']);
    expect(s.history.map((h: { kind: string }) => h.kind)).toEqual(['warning']);
    expect(s.handle).toBe('TargetName');
    for (const k of ['asReporter', 'signals', 'appeals', 'renames', 'automation', 'accounts', 'accountIds', 'devices', 'links', 'inForceOnLinked', 'merged']) expect(s[k], k).toBeUndefined();
    expect(Object.keys(s).sort()).toEqual(['handle', 'history', 'reports', 'sanctions']);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(b.id);
    expect(text).not.toContain('in B');
    expect(text).not.toContain('direct');

    const bs = body(await w.call('GET', `/people/${a.target}/history`, { scope: [B] }));
    expect(bs.sanctions.map((x: { kind: string }) => x.kind)).toEqual(['chat']);
    const nothing = await w.call('GET', `/people/${a.target}/history`, { scope: ['creator:carol'] });
    expect(nothing.status).toBe(404);
    expect(nothing).toEqual(await w.call('GET', '/people/s_never_seen_here/history', { scope: ['creator:carol'] }));
    // an unscoped report does not put a person in anyone's scope
    const none = await w.fileIn(null, { targetKey: 'only-unscoped-person-aaaaaa' });
    expect((await w.call('GET', `/people/${none.target}/history`, { scope: [A, B] })).status).toBe(404);
    expect((await w.call('GET', `/people/${none.target}/history`)).status).toBe(200);
  });

  it('audits history.view on the person for a scoped read, and not for a 404', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    await w.call('GET', `/people/${a.target}/history`, { scope: ['creator:carol'] });
    expect(w.routeAudit()).toEqual([]);
    await w.call('GET', `/people/${a.target}/history`, { scope: [A] });
    expect(w.routeAudit().map((r) => r.action)).toEqual(['history.view']);
  });
});

describe('GET /sanctions and POST /sanctions, scoped', () => {
  it('GET /sanctions lists only the sanctions that came from reports in scope', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(B);
    for (const r of [a, b]) await w.call('POST', `/reports/${r.id}/decide`, { body: { verdict: 'upheld', actions: [{ subject: r.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'r' } });
    await w.call('POST', '/sanctions', { body: { subject: a.target, kind: 'warning', durationMs: null, rule: 1, reason: 'direct' } });
    expect(body(await w.call('GET', '/sanctions')).items).toHaveLength(3);
    expect(body(await w.call('GET', '/sanctions', { scope: [A] })).items.map((i: { person: string }) => i.person)).toEqual([a.target]);
    expect(body(await w.call('GET', '/sanctions', { scope: [B] })).items.map((i: { person: string }) => i.person)).toEqual([b.target]);
    expect(body(await w.call('GET', '/sanctions', { scope: ['creator:nobody'] })).items).toEqual([]);
  });

  const apply = (w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown>, o: { scope?: string[]; role?: Role } = { scope: [A] }) =>
    w.call('POST', '/sanctions', { ...o, body: { kind: 'warning', durationMs: null, rule: 1, reason: 'scoped', ...over } });

  it('a warning with an in-scope reportId is accepted and then appears in the scoped list; area, ban, permanent, 8 days, no reportId and an out-of-scope reportId are refused', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(B);
    const ok = await apply(w, { subject: a.target, reportId: a.id });
    expect(ok.status).toBe(200);
    expect(body(await w.call('GET', '/sanctions', { scope: [A] })).items).toHaveLength(1);
    expect((await apply(w, { subject: a.target, reportId: a.id, kind: 'chat', durationMs: 7 * DAY })).status).toBe(200);
    for (const [name, over, status, error] of [
      ['area', { kind: 'area', durationMs: HOUR }, 400, 'invalid_sanction'],
      ['ban', { kind: 'ban', durationMs: HOUR }, 400, 'invalid_sanction'],
      ['permanent chat', { kind: 'chat', durationMs: null }, 400, 'invalid_sanction'],
      ['8 days', { kind: 'chat', durationMs: 8 * DAY }, 400, 'invalid_sanction'],
      ['no reportId', { reportId: undefined }, 404, 'not_found'],
      ['out-of-scope reportId', { reportId: b.id }, 404, 'not_found'],
      ['unknown reportId', { reportId: 'r_unknown_000000' }, 404, 'not_found'],
    ] as const) {
      const res = await apply(w, { subject: a.target, reportId: a.id, ...over });
      expect(res.status, name).toBe(status);
      expect(errorOf(res), name).toBe(error);
    }
    // nothing was written by the refusals: the two accepted sanctions are all there is
    expect(body(await w.call('GET', '/sanctions')).items).toHaveLength(2);
  });

  it('the sanction must be on a person the report names; another person is refused', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const other = await w.fileIn(A);
    const res = await apply(w, { subject: other.target, reportId: a.id });
    expect([400, 404]).toContain(res.status);
    expect(body(await w.call('GET', '/sanctions')).items).toEqual([]);
  });

  it('a global caller is not limited: the same ban, permanent and area sanctions go through with or without a reportId', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    expect((await apply(w, { subject: a.target, kind: 'ban', durationMs: 30 * DAY }, {})).status).toBe(200);
    expect((await apply(w, { subject: a.target, kind: 'area', durationMs: HOUR }, { role: 'senior' })).status).toBe(200);
    expect((await apply(w, { subject: a.target, kind: 'chat', durationMs: null, reportId: a.id }, { role: 'senior' })).status).toBe(200);
  });

  it('scopedLimits widens or narrows it', async () => {
    const wide = await world({ scopedLimits: { kinds: ['warning', 'chat', 'area'], maxDurationMs: 30 * DAY } });
    const a = await wide.fileIn(A);
    expect((await apply(wide, { subject: a.target, reportId: a.id, kind: 'area', durationMs: 20 * DAY })).status).toBe(200);
    expect((await apply(wide, { subject: a.target, reportId: a.id, kind: 'ban', durationMs: HOUR })).status).toBe(400);
    expect((await apply(wide, { subject: a.target, reportId: a.id, kind: 'chat', durationMs: 31 * DAY })).status).toBe(400);
    const narrow = await world({ scopedLimits: { kinds: ['warning'], maxDurationMs: DAY } });
    const b = await narrow.fileIn(A);
    expect((await apply(narrow, { subject: b.target, reportId: b.id })).status).toBe(200);
    expect((await apply(narrow, { subject: b.target, reportId: b.id, kind: 'chat', durationMs: HOUR })).status).toBe(400);
    expect(SCOPED_DEFAULT_LIMITS).toEqual({ kinds: ['warning', 'chat'], maxDurationMs: 7 * DAY });
  });

  it('a decision by a scoped moderator is held to the same limits (an action of another kind, a longer length or a permanent one is refused) and writes nothing', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const decide = (action: Record<string, unknown>) => w.call('POST', `/reports/${a.id}/decide`, { scope: [A], role: 'senior', body: { verdict: 'upheld', actions: [{ subject: a.target, rule: 1, ...action }], reason: 'x' } });
    for (const action of [{ kind: 'ban', durationMs: HOUR }, { kind: 'area', durationMs: HOUR }, { kind: 'chat', durationMs: 8 * DAY }, { kind: 'chat', durationMs: null }, { kind: 'ban', durationMs: null }]) {
      const res = await decide(action);
      expect(res.status, JSON.stringify(action)).toBe(400);
      expect(errorOf(res)).toBe('invalid_sanction');
    }
    expect(w.cw.reports.get(a.id)?.status).toBe('open');
    expect((await decide({ kind: 'chat', durationMs: 7 * DAY })).status).toBe(200);
    expect(w.cw.reports.get(a.id)?.status).toBe('actioned');
  });

  it('a no_action decision and a bad_faith dismissal by a scoped moderator are allowed (they apply nothing)', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    expect((await w.call('POST', `/reports/${a.id}/decide`, { scope: [A], body: { verdict: 'no_action', actions: [] } })).status).toBe(200);
  });

  it('revoke works only for a sanction that came from an in-scope report; a direct sanction and another scope\'s are 404, the same body as an unknown group', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(B);
    await w.call('POST', `/reports/${a.id}/decide`, { body: { verdict: 'upheld', actions: [{ subject: a.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'r' } });
    await w.call('POST', `/reports/${b.id}/decide`, { body: { verdict: 'upheld', actions: [{ subject: b.target, kind: 'warning', durationMs: null, rule: 1 }], reason: 'r' } });
    const direct = body(await w.call('POST', '/sanctions', { body: { subject: a.target, kind: 'warning', durationMs: null, rule: 1, reason: 'direct' } })).groupId as string;
    const groups = body(await w.call('GET', '/sanctions')).items as Array<{ groupId: string; person: string }>;
    const ga = body(await w.call('GET', '/sanctions', { scope: [A] })).items[0].groupId as string;
    const gb = groups.find((g) => g.person === b.target)!.groupId;
    const revoke = (id: string, o: Record<string, unknown> = { scope: [A] }) => w.call('POST', `/sanctions/${id}/revoke`, { ...o, body: { reason: 'lifting it' } });
    const ghost = await revoke('g_unknown_000000');
    expect(ghost.status).toBe(404);
    for (const id of [direct, gb]) expect(await revoke(id), id).toEqual(ghost);
    expect((await revoke(ga)).status).toBe(200);
    // the control: a global caller may revoke the others
    expect((await revoke(direct, {})).status).toBe(200);
    expect((await revoke(gb, {})).status).toBe(200);
  });

  it('GET /reasons is open to a scoped caller', async () => {
    const w = await world();
    expect((await w.call('GET', '/reasons', { scope: [A] })).status).toBe(200);
  });
});
