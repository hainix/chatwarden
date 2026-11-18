import { describe, expect, it } from 'vitest';
import type { KitResponse, Role } from '../src/index.js';
import { isScopeAware } from '../src/admin/context.js';
import { PERMISSION_KEYS } from '../src/index.js';
import { communityWorld } from './communityWorld.js';
import { errorOf, world } from './world.js';

// C11 task 0: a scoped moderator cannot read GET /policy (it is the whole policy), but needs the rule list to act on a case. GET /policy/rules is that list and nothing else.

const A = 'creator:alice';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: KitResponse): Record<string, any> => res.body as Record<string, any>;

describe('GET /policy/rules', () => {
  it('a scoped moderator reads the rules: number, title and text, nothing else in the answer', async () => {
    const w = await world();
    const res = await w.call('GET', '/policy/rules', { role: 'moderator', scope: [A] });
    expect(res.status).toBe(200);
    expect(Object.keys(body(res))).toEqual(['rules']);
    const rules = body(res).rules as Array<Record<string, unknown>>;
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(typeof r.number).toBe('number');
      expect(typeof r.title).toBe('string');
      expect(typeof r.text).toBe('string');
    }
    expect(rules).toEqual(JSON.parse(JSON.stringify(w.cw.rules.all())));
  });

  it('exposes no profile, no summary, no documents, no settings, and no player data', async () => {
    const w = await world();
    const res = await w.call('GET', '/policy/rules', { role: 'senior', scope: [A] });
    for (const key of ['profile', 'summary', 'documents', 'notices', 'ladder', 'codeOfConduct', 'moderatorGuide', 'agentBrief', 'reporting', 'contexts']) expect(body(res)[key], key).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('"profile"');
  });

  it('the same read for an unscoped moderator, senior and owner answers the same list', async () => {
    const w = await world();
    const scoped = await w.call('GET', '/policy/rules', { role: 'moderator', scope: [A] });
    expect(scoped.status).toBe(200);
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const res = await w.call('GET', '/policy/rules', { role });
      expect(res.status, role).toBe(200);
      expect(res.body).toEqual(scoped.body);
    }
  });

  it('is 401 with no authentication and writes no audit row for a scoped or an unscoped read', async () => {
    const w = await world();
    const res = await w.call('GET', '/policy/rules', { role: null });
    expect(res.status).toBe(401);
    const before = w.routeAudit().length;
    await w.call('GET', '/policy/rules', { role: 'moderator', scope: [A] });
    await w.call('GET', '/policy/rules', { role: 'moderator' });
    expect(w.routeAudit()).toHaveLength(before);
  });

  it('a malformed scope is 401, as on every route', async () => {
    const w = await world();
    for (const scopeRaw of [[], ['a b'], 'creator:alice']) expect((await w.call('GET', '/policy/rules', { scopeRaw })).status).toBe(401);
  });

  it('needs reports.decide: a kit that raised it above the caller refuses a scoped caller (403), and an unscoped one', async () => {
    const w = await world({ permissions: { 'reports.decide': 'senior' } });
    for (const scope of [[A], undefined]) {
      const res = await w.call('GET', '/policy/rules', { role: 'moderator', ...(scope === undefined ? {} : { scope }) });
      expect(res.status).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
    }
    expect((await w.call('GET', '/policy/rules', { role: 'senior', scope: [A] })).status).toBe(200);
  });

  it('an unscoped caller still needs policy.read: a kit that raised it hides the rules from a moderator, but a scoped moderator who may decide still reads them', async () => {
    const w = await world({ permissions: { 'policy.read': 'owner' } });
    expect((await w.call('GET', '/policy/rules', { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/policy/rules', { role: 'owner' })).status).toBe(200);
    expect((await w.call('GET', '/policy/rules', { role: 'moderator', scope: [A] })).status).toBe(200);
  });

  it('is declared scope-aware, and GET /policy and every other policy route stay closed to a scoped caller', async () => {
    const w = await communityWorld();
    expect(isScopeAware(w.routes['GET /policy/rules']!)).toBe(true);
    for (const key of ['GET /policy', 'GET /policy/contexts', 'GET /policy/profile', 'PUT /policy/profile', 'DELETE /policy/profile', 'POST /policy/profile/preview']) {
      expect(isScopeAware(w.routes[key]!), key).toBe(false);
      const [method, path] = key.split(' ') as [string, string];
      const res = await w.call(method, path, { role: 'senior', scope: [A], body: {} });
      expect(res.status, key).toBe(403);
    }
  });

  it('a scoped caller holds no new permission: GET /me still trims policy.read and policy.write, and has every key', async () => {
    const w = await world();
    const me = body(await w.call('GET', '/me', { role: 'senior', scope: [A] }));
    expect(me.can['policy.read']).toBe(false);
    expect(me.can['policy.write']).toBe(false);
    expect(me.can['reports.decide']).toBe(true);
    expect(Object.keys(me.can).sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it('control: the list is exactly the one GET /policy carries (retired rules included, the hub filters them)', async () => {
    const w = await world();
    const policy = body(await w.call('GET', '/policy', { role: 'owner' }));
    const rules = body(await w.call('GET', '/policy/rules', { role: 'moderator', scope: [A] }));
    expect(rules.rules).toEqual(policy.rules);
  });
});

describe('a scoped moderator decides with the rules this route gives', () => {
  const decide = (w: Awaited<ReturnType<typeof world>>, id: string, target: string, over: Record<string, unknown>, role: Role = 'moderator') =>
    w.call('POST', `/reports/${id}/decide`, { role, scope: [A], body: { verdict: 'upheld', actions: [{ subject: target, kind: 'chat', durationMs: 3_600_000, rule: 1, ...over }], reason: 'scoped' } });

  it('within the limits (a 1 hour chat restriction under rule 1) is applied; beyond them (a ban, a permanent restriction, more than 7 days) is 400 invalid_sanction and nothing is written', async () => {
    const w = await world();
    const rules = body(await w.call('GET', '/policy/rules', { role: 'moderator', scope: [A] })).rules as Array<{ number: number }>;
    expect(rules.map((r) => r.number)).toContain(1);
    const ok = await w.fileIn(A);
    const done = await decide(w, ok.id, ok.target, {});
    expect(done.status).toBe(200);
    expect(w.cw.reports.get(ok.id)?.status).not.toBe('open');
    for (const over of [{ kind: 'ban', durationMs: 3_600_000 }, { kind: 'chat', durationMs: null }, { kind: 'chat', durationMs: 8 * 86_400_000 }]) {
      const r = await w.fileIn(A);
      const res = await decide(w, r.id, r.target, over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(errorOf(res)).toBe('invalid_sanction');
      expect(w.cw.reports.get(r.id)?.status).toBe('open');
    }
  });

  it('control: an unscoped senior may place the same ban', async () => {
    const w = await world();
    const r = await w.fileIn(A);
    const res = await w.call('POST', `/reports/${r.id}/decide`, { role: 'senior', body: { verdict: 'upheld', actions: [{ subject: r.target, kind: 'ban', durationMs: 3_600_000, rule: 1 }], reason: 'x' } });
    expect(res.status).toBe(200);
  });
});
