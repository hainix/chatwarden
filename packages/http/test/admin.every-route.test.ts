import { describe, expect, it } from 'vitest';
import { adminRoutes, createRouter } from '@chatwarden/http';
import type { KitResponse } from '@chatwarden/http';
import { DAY, IP_TARGET, KEY_TARGET, SECRET, errorOf, keysDeep, world } from './world.js';

// The Task 4 every-route checks (401 without authz, 403 below the role, fail closed, no ip/hash/key leak), extended
// to the sanction, gap, terms, policy and audit routes.

interface Ids {
  group: string;
  gap: string;
  term: string;
  exception: string;
  subject: string;
  /** A person with one open report, so a case can be claimed. */
  person: string;
  /** A saved reason. */
  reason: string;
}
interface Spec {
  name: string;
  method: string;
  path: (i: Ids) => string;
  body?: unknown;
  /** Permissions that put the route out of the moderator's and senior's reach. */
  lock: Record<string, 'owner'>;
  /** The lowest role that may call it with the default permissions. */
  min: 'moderator' | 'senior' | 'owner';
}

const SPECS: Spec[] = [
  { name: 'POST /sanctions', method: 'POST', path: () => '/sanctions', body: { subject: 'SUBJ', kind: 'chat', durationMs: 1000, rule: 2 }, lock: { 'sanctions.apply': 'owner' }, min: 'moderator' },
  { name: 'POST /sanctions/:groupId/revoke', method: 'POST', path: (i) => `/sanctions/${i.group}/revoke`, body: { reason: 'ok' }, lock: { 'sanctions.revoke': 'owner' }, min: 'moderator' },
  { name: 'GET /gaps', method: 'GET', path: () => '/gaps', lock: { 'gaps.read': 'owner' }, min: 'moderator' },
  { name: 'POST /gaps/:groupId/close', method: 'POST', path: (i) => `/gaps/${i.gap}/close`, body: { status: 'not_a_rule' }, lock: { 'gaps.close': 'owner' }, min: 'owner' },
  { name: 'GET /terms', method: 'GET', path: () => '/terms', lock: { 'terms.read': 'owner' }, min: 'moderator' },
  { name: 'POST /terms/check', method: 'POST', path: () => '/terms/check', body: { term: 'glarn', language: 'en' }, lock: { 'terms.read': 'owner' }, min: 'moderator' },
  { name: 'POST /terms', method: 'POST', path: () => '/terms', body: { term: 'glarn', language: 'en' }, lock: { 'terms.write': 'owner' }, min: 'moderator' },
  { name: 'PATCH /terms/:id', method: 'PATCH', path: (i) => `/terms/${i.term}`, body: { note: 'n' }, lock: { 'terms.write': 'owner' }, min: 'moderator' },
  { name: 'POST /terms/:id/active', method: 'POST', path: (i) => `/terms/${i.term}/active`, body: { active: true }, lock: { 'terms.write': 'owner' }, min: 'moderator' },
  { name: 'POST /exceptions', method: 'POST', path: () => '/exceptions', body: { phrase: 'zorbak party', language: 'en' }, lock: { 'terms.write': 'owner' }, min: 'moderator' },
  { name: 'PATCH /exceptions/:id', method: 'PATCH', path: (i) => `/exceptions/${i.exception}`, body: { note: 'n' }, lock: { 'terms.write': 'owner' }, min: 'moderator' },
  { name: 'POST /exceptions/:id/active', method: 'POST', path: (i) => `/exceptions/${i.exception}/active`, body: { active: true }, lock: { 'terms.write': 'owner' }, min: 'moderator' },
  { name: 'GET /sanctions', method: 'GET', path: () => '/sanctions', lock: { 'history.read': 'owner' }, min: 'moderator' },
  { name: 'GET /blocked', method: 'GET', path: () => '/blocked', lock: { 'blocked.read': 'owner' }, min: 'moderator' },
  { name: 'POST /terms/test', method: 'POST', path: () => '/terms/test', body: { text: 'a harmless line' }, lock: { 'terms.read': 'owner' }, min: 'moderator' },
  { name: 'GET /policy', method: 'GET', path: () => '/policy', lock: { 'policy.read': 'owner' }, min: 'moderator' },
  { name: 'GET /policy/profile', method: 'GET', path: () => '/policy/profile', lock: { 'policy.read': 'owner' }, min: 'moderator' },
  { name: 'PUT /policy/profile', method: 'PUT', path: () => '/policy/profile', body: { layer: { customDuration: true }, version: 0, reason: 'tune' }, lock: { 'policy.write': 'owner' }, min: 'owner' },
  { name: 'POST /policy/profile/preview', method: 'POST', path: () => '/policy/profile/preview', body: { layer: {} }, lock: { 'policy.read': 'owner' }, min: 'moderator' },
  { name: 'DELETE /policy/profile', method: 'DELETE', path: () => '/policy/profile', body: { reason: 'reset' }, lock: { 'policy.write': 'owner' }, min: 'owner' },
  { name: 'POST /reports/dismiss-open', method: 'POST', path: () => '/reports/dismiss-open', body: { scope: 'person', ref: 'SUBJ' }, lock: { 'reports.decide.bulk': 'owner' }, min: 'moderator' },
  { name: 'POST /cases/next', method: 'POST', path: () => '/cases/next', body: {}, lock: { 'reports.decide': 'owner' }, min: 'moderator' },
  { name: 'POST /cases/:ref/claim', method: 'POST', path: (i) => `/cases/${i.person}/claim`, body: {}, lock: { 'reports.decide': 'owner' }, min: 'moderator' },
  { name: 'POST /cases/:ref/release', method: 'POST', path: (i) => `/cases/${i.person}/release`, body: {}, lock: { 'reports.decide': 'owner' }, min: 'moderator' },
  { name: 'POST /cases/:ref/viewing', method: 'POST', path: (i) => `/cases/${i.person}/viewing`, body: {}, lock: { 'reports.read': 'owner' }, min: 'moderator' },
  { name: 'GET /changes', method: 'GET', path: () => '/changes', lock: { 'reports.read': 'owner' }, min: 'moderator' },
  { name: 'GET /reasons', method: 'GET', path: () => '/reasons', lock: { 'reasons.read': 'owner' }, min: 'moderator' },
  { name: 'POST /reasons', method: 'POST', path: () => '/reasons', body: { label: 'Spam', text: 'Spamming the lobby.' }, lock: { 'reasons.write': 'owner' }, min: 'senior' },
  { name: 'PATCH /reasons/:id', method: 'PATCH', path: (i) => `/reasons/${i.reason}`, body: { label: 'Spam!' }, lock: { 'reasons.write': 'owner' }, min: 'senior' },
  { name: 'POST /reasons/:id/active', method: 'POST', path: (i) => `/reasons/${i.reason}/active`, body: { active: false }, lock: { 'reasons.write': 'owner' }, min: 'senior' },
  { name: 'GET /audit', method: 'GET', path: () => '/audit', lock: { 'audit.read': 'owner' }, min: 'senior' },
];

async function ids(w: Awaited<ReturnType<typeof world>>): Promise<Ids> {
  const subject = w.person();
  const made = await w.cw.sanctions.apply({
    kind: 'chat',
    subject,
    includeIp: false,
    durationMs: DAY,
    reason: 'r',
    actor: 'ann',
    source: 'moderator',
    automated: false,
    rule: 2,
  });
  const gap = await w.gap();
  const term = w.live.rows.terms[0]?.id as string;
  const exception = w.live.rows.exceptions[0]?.id as string;
  const filed = await w.file();
  const reason = w.cw.reasons.add({ label: 'Seed', text: 'A seeded reason.' });
  return { group: made.groupId, gap: gap.groupId, term, exception, subject, person: filed.target, reason: reason.id };
}
const bodyOf = (s: Spec, i: Ids): unknown =>
  s.body === undefined ? undefined : JSON.parse(JSON.stringify(s.body).replace('SUBJ', i.subject));

describe('every new admin route: 401 without authz, 403 below the needed role', () => {
  it('the route table has exactly the new routes plus the report and team routes', async () => {
    const { routes } = await world();
    // `:id~ref` is the audit-ref charset for a term id; the shape is the same.
    expect(Object.keys(routes).map((k) => k.replace('~ref', '')).sort()).toEqual(
      [
        'GET /me',
        'GET /people/:ref/history',
        'GET /reports',
        'GET /reports/:id',
        'POST /reports/:id/decide',
        'POST /reports/:id/suggest',
        // The AI routes (their own checks are in admin.ai.test.ts: they need a world with an adapter).
        'GET /ai/status',
        'POST /reports/:id/ai/read',
        'POST /reports/:id/ai/dont-teach',
        ...SPECS.map((s) => s.name),
      ].sort(),
    );
  });

  for (const spec of SPECS) {
    it(`${spec.name}: 401 when authorize returns null, and nothing runs`, async () => {
      const w = await world();
      const i = await ids(w);
      const before = w.audit().length;
      const termsBefore = JSON.stringify(w.live.rows);
      const body = bodyOf(spec, i);
      const res = await w.call(spec.method, spec.path(i), { role: null, ...(body === undefined ? {} : { body }) });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
      expect(w.audit()).toHaveLength(before);
      expect(JSON.stringify(w.live.rows)).toBe(termsBefore);
      expect(w.cw.gaps.list().every((g) => g.status === 'open')).toBe(true);
    });

    it(`${spec.name}: 403 when the role is below the needed one, 200 for the owner`, async () => {
      const w = await world({ permissions: spec.lock });
      const i = await ids(w);
      const before = w.audit().length;
      const body = bodyOf(spec, i);
      for (const role of ['moderator', 'senior'] as const) {
        const res = await w.call(spec.method, spec.path(i), { role, ...(body === undefined ? {} : { body }) });
        expect(res.status, role).toBe(403);
        expect(errorOf(res)).toBe('forbidden');
      }
      expect(w.audit()).toHaveLength(before);
      const ok = await w.call(spec.method, spec.path(i), { role: 'owner', ...(body === undefined ? {} : { body }) });
      expect(ok.status).toBe(200);
    });

    it(`${spec.name}: the default minimum role is ${spec.min}`, async () => {
      const roles = ['moderator', 'senior', 'owner'] as const;
      for (const role of roles) {
        // A fresh world per role: a gap closes once and a sanction is revoked once.
        const w = await world();
        const i = await ids(w);
        const body = bodyOf(spec, i);
        const res = await w.call(spec.method, spec.path(i), { role, ...(body === undefined ? {} : { body }) });
        if (roles.indexOf(role) >= roles.indexOf(spec.min)) expect(res.status, role).toBe(200);
        else expect(res.status, role).toBe(403);
      }
    });

    if (spec.method !== 'GET') {
      it(`${spec.name}: authorization comes before body validation`, async () => {
        const w = await world({ permissions: spec.lock });
        const i = await ids(w);
        expect((await w.call(spec.method, spec.path(i), { role: 'moderator', raw: '{nope' })).status).toBe(403);
        expect((await w.call(spec.method, spec.path(i), { role: null, raw: '{nope' })).status).toBe(401);
      });
    }
  }

  it('a malformed authz from the hook (empty actor, unknown role) is 401 on the new routes too', async () => {
    const { cw, live } = await world();
    const bads: unknown[] = [{ actor: '', role: 'moderator' }, { actor: 'x', role: 'admin' }, { role: 'owner' }, 'owner', 7];
    for (const bad of bads) {
      const router = createRouter(adminRoutes(cw, { authorize: () => bad as never, terms: live }));
      for (const [method, path] of [
        ['GET', '/gaps'],
        ['GET', '/terms'],
        ['GET', '/sanctions'],
        ['GET', '/blocked'],
        ['POST', '/terms/test'],
        ['GET', '/policy'],
        ['GET', '/audit'],
        ['POST', '/sanctions'],
      ] as const) {
        const res = await router({ method, path, query: {}, headers: {}, body: undefined });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it('an actor the audit trail cannot hold is a 500 on a new route, not a write', async () => {
    const { cw, live } = await world();
    const router = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'Ann Smith', role: 'owner' }), terms: live }));
    const res = await router({ method: 'GET', path: '/policy', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(500);
    expect(cw.audit.list({ limit: 10 }).items).toEqual([]);
  });

  it('a viewing route that is audited fails closed (500) when its audit row cannot be written', async () => {
    const w = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const res = await w.call('GET', '/policy');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    // GET /gaps, GET /terms and GET /audit write no audit row, so they do not depend on one.
    expect((await w.call('GET', '/gaps')).status).toBe(200);
    expect((await w.call('GET', '/terms')).status).toBe(200);
    expect((await w.call('GET', '/audit', { role: 'senior' })).status).toBe(200);
  });

  it('the router answers 404 for unknown paths and 405 for a wrong method before auth', async () => {
    const { call } = await world();
    expect((await call('GET', '/nope', { role: null })).status).toBe(404);
    expect((await call('DELETE', '/sanctions', { role: null })).status).toBe(405);
    expect((await call('PUT', '/sanctions', { role: null })).status).toBe(405);
    expect((await call('GET', '/sanctions', { role: null })).status).toBe(401);
    expect((await call('GET', '/blocked', { role: null })).status).toBe(401);
    expect((await call('POST', '/blocked', { role: null })).status).toBe(405);
    expect((await call('PUT', '/terms', { role: null })).status).toBe(405);
  });
});

describe('the new responses carry no ip, hash or raw key at any depth', () => {
  it('scans every new route (success and error) for forbidden keys and raw credentials', async () => {
    const w = await world();
    const { call } = w;
    const i = await ids(w);
    const responses: KitResponse[] = [];
    const made = await call('POST', '/sanctions', { body: { subject: i.subject, kind: 'ban', durationMs: DAY, rule: 2, includeIp: true } });
    responses.push(made);
    responses.push(await call('POST', '/sanctions', { body: { subject: i.subject, kind: 'warning', durationMs: null, rule: 'uncovered', gapNote: 'n' } }));
    responses.push(await call('POST', '/sanctions', { body: { subject: i.subject, kind: 'nope' } }));
    responses.push(await call('POST', `/sanctions/${(made.body as { groupId: string }).groupId}/revoke`, { body: { reason: 'r' } }));
    responses.push(await call('POST', `/sanctions/${i.group}/revoke`, { role: null, body: { reason: 'r' } }));
    responses.push(await call('GET', '/gaps'));
    responses.push(await call('POST', `/gaps/${i.gap}/close`, { role: 'owner', body: { status: 'ruled', ref: 3 } }));
    responses.push(await call('POST', `/gaps/${i.gap}/close`, { role: 'owner', body: { status: 'ruled', ref: 3 } }));
    responses.push(await call('GET', '/gaps'));
    responses.push(await call('GET', '/terms'));
    responses.push(await call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } }));
    const added = await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } });
    responses.push(added);
    responses.push(await call('PATCH', `/terms/${(added.body as { id: string }).id}`, { body: { note: 'x' } }));
    responses.push(await call('POST', `/terms/${(added.body as { id: string }).id}/active`, { body: { active: false } }));
    responses.push(await call('POST', '/exceptions', { body: { phrase: 'zorbak party', language: 'en' } }));
    responses.push(await call('GET', '/policy'));
    responses.push(await call('GET', '/audit', { role: 'owner' }));
    responses.push(await call('GET', '/audit', { role: 'owner', query: { limit: '3' } }));
    responses.push(await call('GET', '/audit', { role: 'owner', query: { limit: '0' } }));
    expect(responses.every((r) => r.status < 500)).toBe(true);
    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(14);

    const forbidden = /^(ip|ips|ipHash|keyHash|clientKey|key|rawKey|secret|hash)$/i;
    for (const res of responses) {
      for (const k of keysDeep(res.body)) expect(forbidden.test(k), k).toBe(false);
      const text = JSON.stringify(res.body);
      for (const raw of [KEY_TARGET, IP_TARGET, SECRET]) expect(text).not.toContain(raw);
    }
  });
});
