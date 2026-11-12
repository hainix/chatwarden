import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { CATEGORY_TO_RULE, createChatwarden } from '@chatwarden/core';
import type { Chatwarden, Logger, RawWho, ReportCategory } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, createRouter } from '@chatwarden/http';
import type { Authz, KitRequest, KitResponse, Role } from '@chatwarden/http';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

// Raw credentials that must never appear in any response.
const KEY_REPORTER = 'raw-client-key-reporter-0001';
const KEY_TARGET = 'raw-client-key-target-0002';
const KEY_BYSTANDER = 'raw-client-key-bystander-0003';
const IP_TARGET = '203.0.113.77';
const IP_REPORTER = '198.51.100.23';
const SECRET = 'admin-reports-secret';

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

async function world(over: { wrap?: (cw: Chatwarden) => Chatwarden; permissions?: Parameters<typeof adminRoutes>[1]['permissions'] } = {}) {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const real = await createChatwarden({
    store,
    secret: SECRET,
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
  });
  logged.length = 0;

  let n = 0;
  /** A new room with a reporter (p1), the target (p2) and a bystander (p3), each with a line; one report filed. */
  const file = async (category: ReportCategory = 'harassment') => {
    const room = `room-${++n}`;
    real.rooms.seat(room, 'p1', { clientKey: `${KEY_REPORTER}-${n}`, ip: IP_REPORTER }, 'Rep');
    real.rooms.seat(room, 'p2', { clientKey: `${KEY_TARGET}-${n}`, ip: IP_TARGET }, 'Tgt');
    real.rooms.seat(room, 'p3', { clientKey: `${KEY_BYSTANDER}-${n}` }, 'Bys');
    real.chat.accept(room, 'p1', 'hello from the reporter');
    real.chat.accept(room, 'p2', 'a line from the target');
    real.chat.accept(room, 'p3', 'a line from the bystander');
    clock.t += 1000;
    const res = await real.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = real.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    return {
      room,
      id: res.reportId,
      report,
      target: report.targetPerson,
      reporter: report.reporterPerson,
      bystander: real.rooms.subjectAt(room, 'p3') as string,
    };
  };

  const cw = over.wrap === undefined ? real : over.wrap(real);
  const authorize = (req: KitRequest): Authz | null => {
    const role = req.headers['x-role'];
    if (role === undefined) return null;
    return { actor: req.headers['x-actor'] ?? 'ann', role: role as Role };
  };
  const routes = adminRoutes(cw, { authorize, ...(over.permissions === undefined ? {} : { permissions: over.permissions }), logger });
  const router = createRouter(routes);

  const call = (
    method: string,
    path: string,
    o: { role?: Role | null; actor?: string; query?: Record<string, string>; body?: unknown; raw?: string } = {},
  ): Promise<KitResponse> => {
    const headers: Record<string, string> = {};
    if (o.role !== null) headers['x-role'] = o.role ?? 'moderator';
    if (o.actor !== undefined) headers['x-actor'] = o.actor;
    const rawBody = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    return router({ method, path, query: o.query ?? {}, headers, body: undefined, ...(rawBody === undefined ? {} : { rawBody }) });
  };
  const audit = () => real.audit.list({ limit: 200 }).items;
  return { cw: real, routes, router, call, file, audit, clock, logged, store };
}

const warning = (subject: string, over: Record<string, unknown> = {}) => ({ subject, kind: 'warning', durationMs: null, rule: 2, ...over });
const decideBody = (actions: unknown[], over: Record<string, unknown> = {}) => ({
  verdict: 'upheld',
  actions,
  reason: 'Clear harassment in chat.',
  ...over,
});

const errorOf = (res: KitResponse): string => (res.body as { error: string }).error;

/** Every key at any depth. */
function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe('adminRoutes: shape', () => {
  it('includes exactly the report/decision/history routes and the two AI report routes (the other groups have their own files)', async () => {
    const { routes } = await world();
    expect(Object.keys(routes).filter((k) => /\/(reports|people)/.test(k)).sort()).toEqual([
      'GET /people/:ref/history',
      'GET /reports',
      'GET /reports/:id',
      'POST /reports/:id/ai/dont-teach',
      'POST /reports/:id/ai/read',
      'POST /reports/:id/decide',
      'POST /reports/:id/suggest',
      'POST /reports/dismiss-open',
    ]);
  });

  it('can be extended with more routes by spreading (the Task 5 pattern)', async () => {
    const { routes } = await world();
    const router = createRouter({ ...routes, 'GET /extra': () => ({ status: 200, body: { extra: true } }) });
    const res = await router({ method: 'GET', path: '/extra', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(200);
  });
});

describe('GET /reports', () => {
  it('lists the queue, newest first, and audits report.view with no target', async () => {
    const { call, file, audit, clock } = await world();
    const a = await file();
    clock.t += 5000;
    const b = await file();
    const res = await call('GET', '/reports', { actor: 'ann', role: 'senior' });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: string; status: string }>; next: string | null };
    expect(body.items.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(body.next).toBeNull();
    expect(audit()).toEqual([
      { id: expect.any(String), at: clock.t, actor: 'ann', role: 'senior', action: 'report.view' },
    ]);
  });

  it('a list item is a summary: exactly these keys, nothing of the evidence', async () => {
    const { call, file } = await world();
    const r = await file();
    const res = await call('GET', '/reports');
    const item = (res.body as { items: Array<Record<string, unknown>> }).items[0] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      ['actionedAt', 'actionedBy', 'badFaith', 'category', 'claim', 'createdAt', 'id', 'reportedReason', 'reportedReasonLabel', 'reporterAccuracy', 'ai', 'reporterPerson', 'reporterHandle', 'roomId', 'status', 'tags', 'targetHandle', 'targetPerson', 'viewing'].sort(),
    );
    expect(item).toMatchObject({ id: r.id, category: 'harassment', status: 'open', roomId: r.room, targetPerson: r.target, reporterPerson: r.reporter, badFaith: false, actionedAt: null, actionedBy: null });
    // Keys are the same on a decided report, and the decision shows through status / badFaith / actioned*.
    await call('POST', `/reports/${r.id}/decide`, { actor: 'ann', body: decideBody([warning(r.target)]) });
    const after = ((await call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items[0] as Record<string, unknown>;
    expect(Object.keys(after).sort()).toEqual(Object.keys(item).sort());
    expect(after).toMatchObject({ status: 'actioned', actionedBy: 'ann', actionedAt: expect.any(Number) });
  });

  it('the list never carries the excerpt, a planted chat line, notes or evidence (in any key, at any depth); the only handles are the reported and the reporting person, each in its own field', async () => {
    const { cw, call, file } = await world();
    const room = 'room-plant';
    cw.rooms.seat(room, 'p1', { clientKey: `${KEY_REPORTER}-x`, ip: IP_REPORTER }, 'RepHandle');
    cw.rooms.seat(room, 'p2', { clientKey: `${KEY_TARGET}-x`, ip: IP_TARGET }, 'TgtHandle');
    const PLANTED = 'planted-excerpt-line-zzz-4417';
    cw.chat.accept(room, 'p2', PLANTED);
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment', note: 'planted-reporter-note-8842' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The record itself does hold the planted line (so the control is real).
    expect(JSON.stringify(cw.reports.get(res.reportId))).toContain(PLANTED);
    await call('POST', `/reports/${res.reportId}/decide`, { body: decideBody([], { verdict: 'noted', reason: 'planted-mod-note-5530' }) });
    await file();
    const listed = (await call('GET', '/reports')).body;
    const text = JSON.stringify(listed);
    for (const needle of [PLANTED, 'planted-reporter-note-8842', 'planted-mod-note-5530']) expect(text).not.toContain(needle);
    // The two handles are what the queue shows so a row can carry a name: each is in its own field and nowhere else.
    expect(text.split('TgtHandle')).toHaveLength(2);
    expect(text.split('RepHandle')).toHaveLength(2);
    expect((listed as { items: Array<{ id: string; reporterHandle: string | null }> }).items.find((i) => i.id === res.reportId)?.reporterHandle).toBe('RepHandle');
    expect((listed as { items: Array<{ id: string; targetHandle: string | null }> }).items.find((i) => i.id === res.reportId)?.targetHandle).toBe('TgtHandle');
    const keys = keysDeep(listed);
    expect(keys.has('targetHandle')).toBe(true);
    expect(keys.has('reporterHandle')).toBe(true);
    for (const k of ['excerpt', 'note', 'modNote', 'badFaithEvidence', 'people', 'ownLineIds', 'lineId', 'reporterSubject', 'targetSubject', 'reporterSeat', 'targetSeat']) {
      expect(keys.has(k), k).toBe(false);
    }
    // The audited single-report route still carries the evidence.
    const one = (await call('GET', `/reports/${res.reportId}`)).body as { report: { excerpt: unknown } };
    expect(JSON.stringify(one.report.excerpt)).toContain(PLANTED);
  });

  it('a dismissed bad-faith report is a summary too, evidence withheld', async () => {
    const { call, file } = await world();
    const r = await file();
    await call('POST', `/reports/${r.id}/decide`, {
      body: decideBody([], { verdict: 'bad_faith', evidence: 'planted-bad-faith-evidence-9901' }),
    });
    const body = (await call('GET', '/reports')).body as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ status: 'dismissed', badFaith: true });
    expect(JSON.stringify(body)).not.toContain('planted-bad-faith-evidence-9901');
  });

  it('filters by status', async () => {
    const { call, file } = await world();
    const a = await file();
    await file();
    await call('POST', `/reports/${a.id}/decide`, { body: decideBody([warning(a.target)]) });
    const open = (await call('GET', '/reports', { query: { status: 'open' } })).body as { items: unknown[] };
    const actioned = (await call('GET', '/reports', { query: { status: 'actioned' } })).body as { items: Array<{ id: string }> };
    expect(open.items).toHaveLength(1);
    expect(actioned.items.map((r) => r.id)).toEqual([a.id]);
  });

  it('pages with limit and the cursor', async () => {
    const { call, file, clock } = await world();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.unshift((await file()).id);
      clock.t += 1000;
    }
    const p1 = (await call('GET', '/reports', { query: { limit: '2' } })).body as { items: Array<{ id: string }>; next: string };
    expect(p1.items.map((r) => r.id)).toEqual(ids.slice(0, 2));
    expect(p1.next).toEqual(expect.any(String));
    const p2 = (await call('GET', '/reports', { query: { limit: '2', cursor: p1.next } })).body as { items: Array<{ id: string }>; next: string | null };
    expect(p2.items.map((r) => r.id)).toEqual(ids.slice(2));
    expect(p2.next).toBeNull();
  });

  it('parses limit as an integer: a whole number is accepted, anything else is 400 invalid_query', async () => {
    const { call, file } = await world();
    await file();
    for (const ok of ['1', '50', '200', '999', '0', '007']) {
      expect((await call('GET', '/reports', { query: { limit: ok } })).status, ok).toBe(200);
    }
    for (const bad of ['abc', '1.5', '-1', '', ' 2', '2 ', '1e3', '0x10', 'NaN', 'Infinity', '10abc', '99999999999999999999', '+3']) {
      const res = await call('GET', '/reports', { query: { limit: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
    }
  });

  it('an unknown status and a malformed cursor are 400 invalid_query, with a fixed message', async () => {
    const { call } = await world();
    const queries: Array<Record<string, string>> = [{ status: 'weird' }, { status: '' }, { status: 'OPEN' }, { cursor: 'nope' }, { cursor: '!!!' }, { cursor: '' }];
    for (const query of queries) {
      const res = await call('GET', '/reports', { query });
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_query', message: 'The query is not valid.' });
    }
  });

  it('does not audit a refused query', async () => {
    const { call, audit } = await world();
    await call('GET', '/reports', { query: { status: 'weird' } });
    expect(audit()).toEqual([]);
  });
});

describe('GET /reports/:id', () => {
  it('returns the report, the history of each person, the suggestion and the rule; audits report.view with the report', async () => {
    const { call, file, audit, cw } = await world();
    const r = await file('harassment');
    const res = await call('GET', `/reports/${r.id}`, { actor: 'bob', role: 'moderator' });
    expect(res.status).toBe(200);
    const body = res.body as {
      report: { id: string; targetPerson: string; excerpt: unknown[] };
      history: Record<string, unknown[]>;
      suggest: { outcome: string; label: string; why: string };
      rule: number | string;
    };
    expect(body.report.id).toBe(r.id);
    expect(body.report.targetPerson).toBe(r.target);
    expect(body.report.excerpt.length).toBeGreaterThan(0);
    expect(body.rule).toBe(CATEGORY_TO_RULE.harassment);
    expect(body.suggest).toEqual(cw.suggest(r.target, null, CATEGORY_TO_RULE.harassment, { roomId: r.report.roomId }));
    expect(Object.keys(body.history).sort()).toEqual([r.target, r.reporter, r.bystander].sort());
    for (const h of Object.values(body.history)) expect(h).toEqual([]);
    expect(audit().map((a) => [a.actor, a.role, a.action, a.target])).toEqual([
      ['bob', 'moderator', 'report.view', { type: 'report', ref: r.id }],
    ]);
  });

  it('shows the target\'s recent actions in history after a decision', async () => {
    const { call, file } = await world();
    const r = await file();
    await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
    const body = (await call('GET', `/reports/${r.id}`)).body as { history: Record<string, Array<{ kind: string }>> };
    expect(body.history[r.target]?.map((h) => h.kind)).toEqual(['warning']);
  });

  it('passes the report\'s roomId into suggest (spy)', async () => {
    const spy = vi.fn();
    const { call, file } = await world({
      wrap: (cw) => ({
        ...cw,
        suggest: (...args: Parameters<Chatwarden['suggest']>) => {
          spy(...args);
          return cw.suggest(...args);
        },
      }),
    });
    const r = await file('cheating');
    await call('GET', `/reports/${r.id}`);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(r.target, null, CATEGORY_TO_RULE.cheating, { roomId: r.report.roomId });
  });

  it('reads the level from ?level=, defaulting to null', async () => {
    const spy = vi.fn();
    const { call, file } = await world({
      wrap: (cw) => ({
        ...cw,
        suggest: (...args: Parameters<Chatwarden['suggest']>) => {
          spy(...args);
          return cw.suggest(...args);
        },
      }),
    });
    const r = await file();
    for (const level of ['banter', 'rude', 'hostile', 'severe']) {
      expect((await call('GET', `/reports/${r.id}`, { query: { level } })).status, level).toBe(200);
    }
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['banter', 'rude', 'hostile', 'severe']);
    spy.mockClear();
    await call('GET', `/reports/${r.id}`);
    expect(spy.mock.calls[0]?.[1]).toBeNull();
  });

  it('a level that is not a conduct level is 400 invalid_query and writes no audit row', async () => {
    const { call, file, audit } = await world();
    const r = await file();
    for (const level of ['', 'RUDE', 'null', 'mild', '1']) {
      const res = await call('GET', `/reports/${r.id}`, { query: { level } });
      expect(res.status, level).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
    }
    expect(audit()).toEqual([]);
  });

  it('maps the category to its rule (other is uncovered)', async () => {
    const { call, file } = await world();
    for (const category of ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'] as const) {
      const r = await file(category);
      const body = (await call('GET', `/reports/${r.id}`)).body as { rule: unknown };
      expect(body.rule, category).toBe(CATEGORY_TO_RULE[category]);
    }
  });

  it('404 for an unknown id (and no audit row); 404 from the router for an id with a bad shape', async () => {
    const { call, audit } = await world();
    const res = await call('GET', '/reports/doesnotexist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
    expect((await call('GET', '/reports/bad%20id')).status).toBe(404);
    expect(audit()).toEqual([]);
  });
});

describe('POST /reports/:id/suggest', () => {
  it('defaults the person to the target and the rule to the category rule; the roomId comes from the report', async () => {
    const spy = vi.fn();
    const { call, file, cw, audit } = await world({
      wrap: (cw) => ({
        ...cw,
        suggest: (...args: Parameters<Chatwarden['suggest']>) => {
          spy(...args);
          return cw.suggest(...args);
        },
      }),
    });
    const r = await file('spam');
    const res = await call('POST', `/reports/${r.id}/suggest`, { body: { level: 'rude' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(cw.suggest(r.target, 'rude', CATEGORY_TO_RULE.spam, { roomId: r.report.roomId }));
    expect(spy).toHaveBeenCalledWith(r.target, 'rude', CATEGORY_TO_RULE.spam, { roomId: r.report.roomId });
    expect(audit().map((a) => [a.action, a.target])).toEqual([['suggest', { type: 'report', ref: r.id }]]);
  });

  it('a body roomId is ignored: the report decides it', async () => {
    const spy = vi.fn();
    const { call, file } = await world({
      wrap: (cw) => ({
        ...cw,
        suggest: (...args: Parameters<Chatwarden['suggest']>) => {
          spy(...args);
          return cw.suggest(...args);
        },
      }),
    });
    const r = await file();
    await call('POST', `/reports/${r.id}/suggest`, { body: { level: 'rude', roomId: 'elsewhere' } });
    expect(spy.mock.calls[0]?.[3]).toEqual({ roomId: r.report.roomId });
  });

  it('accepts every conduct level and null; a missing level is null', async () => {
    const spy = vi.fn();
    const { call, file } = await world({
      wrap: (cw) => ({
        ...cw,
        suggest: (...args: Parameters<Chatwarden['suggest']>) => {
          spy(...args);
          return cw.suggest(...args);
        },
      }),
    });
    const r = await file();
    for (const level of ['banter', 'rude', 'hostile', 'severe', null]) {
      expect((await call('POST', `/reports/${r.id}/suggest`, { body: { level } })).status, String(level)).toBe(200);
    }
    expect((await call('POST', `/reports/${r.id}/suggest`, { body: {} })).status).toBe(200);
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['banter', 'rude', 'hostile', 'severe', null, null]);
  });

  it('takes a rule override (a number or uncovered) and a person from the report', async () => {
    const { call, file, cw } = await world();
    const r = await file();
    const a = await call('POST', `/reports/${r.id}/suggest`, { body: { level: 'severe', rule: 1, person: r.bystander } });
    expect(a.body).toEqual(cw.suggest(r.bystander, 'severe', 1, { roomId: r.report.roomId }));
    const b = await call('POST', `/reports/${r.id}/suggest`, { body: { level: null, rule: 'uncovered', person: r.reporter } });
    expect(b.body).toEqual(cw.suggest(r.reporter, null, 'uncovered', { roomId: r.report.roomId }));
  });

  it('400 for an invalid body, level, rule or person, and writes no audit row', async () => {
    const { call, file, audit } = await world();
    const r = await file();
    const other = await file();
    const bads: Array<[string, Parameters<typeof call>[2]]> = [
      ['no body', {}],
      ['not json', { raw: '{nope' }],
      ['array body', { body: [] }],
      ['string body', { body: 'rude' }],
      ['null body', { raw: 'null' }],
      ['level number', { body: { level: 3 } }],
      ['level unknown', { body: { level: 'mild' } }],
      ['level case', { body: { level: 'Rude' } }],
      ['rule zero', { body: { level: null, rule: 0 } }],
      ['rule fraction', { body: { level: null, rule: 1.5 } }],
      ['rule negative', { body: { level: null, rule: -1 } }],
      ['rule text', { body: { level: null, rule: 'one' } }],
      ['rule unknown number', { body: { level: null, rule: 9999 } }],
      ['rule null', { body: { level: null, rule: null } }],
      ['person number', { body: { level: null, person: 5 } }],
      ['person empty', { body: { level: null, person: '' } }],
      ['person not in report', { body: { level: null, person: other.target } }],
      ['person stranger', { body: { level: null, person: 's_stranger' } }],
      ['forbidden key', { raw: '{"level":null,"__proto__":{"x":1}}' }],
    ];
    for (const [name, o] of bads) {
      const res = await call('POST', `/reports/${r.id}/suggest`, o);
      expect(res.status, name).toBe(400);
    }
    expect(audit()).toEqual([]);
  });

  it('404 for an unknown report', async () => {
    const { call, audit } = await world();
    expect((await call('POST', '/reports/nope/suggest', { body: { level: null } })).status).toBe(404);
    expect(audit()).toEqual([]);
  });

  it('413 for a body over 64 KiB', async () => {
    const { call, file } = await world();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/suggest`, { raw: JSON.stringify({ level: null, pad: 'x'.repeat(70_000) }) });
    expect(res.status).toBe(413);
  });
});

describe('POST /reports/:id/decide', () => {
  it('applies a warning, answers { ok, replay, groups: [{ refCode, kind }] } and audits report.decide', async () => {
    const { call, file, audit, cw } = await world();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, { actor: 'carol', role: 'senior', body: decideBody([warning(r.target)]) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, replay: false, groups: [{ refCode: expect.any(String), kind: 'warning' }] });
    expect(cw.history(r.target).map((h) => h.kind)).toEqual(['warning']);
    expect(cw.reports.get(r.id)?.status).toBe('actioned');
    expect(audit().map((a) => [a.actor, a.role, a.action, a.target])).toEqual([
      ['carol', 'senior', 'report.decide', { type: 'report', ref: r.id }],
    ]);
  });

  it('the group keys are exactly refCode and kind: no subject, group id or notice id', async () => {
    const { call, file } = await world();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
    const groups = (res.body as { groups: Array<Record<string, unknown>> }).groups;
    expect(Object.keys(groups[0] as object).sort()).toEqual(['kind', 'refCode']);
    expect(Object.keys(res.body as object).sort()).toEqual(['groups', 'ok', 'replay']);
  });

  it('pairs each group with its action kind when one person gets several, in any request order', async () => {
    const { call, file } = await world();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, {
      body: decideBody([
        { subject: r.target, kind: 'warning', durationMs: null, rule: 2 },
        { subject: r.target, kind: 'chat', durationMs: HOUR, rule: 2 },
        { subject: r.bystander, kind: 'note', durationMs: null, rule: 2 },
        { subject: r.target, kind: 'ban', durationMs: 2 * HOUR, rule: 2 },
      ]),
    });
    expect(res.status).toBe(200);
    const kinds = (res.body as { groups: Array<{ kind: string }> }).groups.map((g) => g.kind);
    // The facade writes groups sorted by canonical subject, then kind; each group must carry its own action's kind.
    const pairs: Array<[string, string]> = [[r.target, 'warning'], [r.target, 'chat'], [r.bystander, 'note'], [r.target, 'ban']];
    pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1));
    expect(kinds).toEqual(pairs.map((p) => p[1]));
  });

  it('takes the actor from the authz and the source from the route; a body actor and source are ignored', async () => {
    const decide = vi.fn();
    const { call, file, cw } = await world({
      wrap: (cw) => ({
        ...cw,
        decide: (input: Parameters<Chatwarden['decide']>[0]) => {
          decide(input);
          return cw.decide(input);
        },
      }),
    });
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, {
      actor: 'dave',
      body: { ...decideBody([warning(r.target)]), actor: 'evil', source: 'api', reportId: 'other', role: 'owner' },
    });
    expect(res.status).toBe(200);
    expect(decide).toHaveBeenCalledTimes(1);
    const input = decide.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.actor).toBe('dave');
    expect(input.source).toBe('moderator');
    expect(input.reportId).toBe(r.id);
    expect(cw.reports.get(r.id)?.actionedBy).toBe('dave');
  });

  it('only whitelisted action fields reach the facade', async () => {
    const decide = vi.fn();
    const { call, file } = await world({
      wrap: (cw) => ({
        ...cw,
        decide: (input: Parameters<Chatwarden['decide']>[0]) => {
          decide(input);
          return cw.decide(input);
        },
      }),
    });
    const r = await file();
    await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target, { actor: 'x', source: 'api', automated: true })]) });
    const action = (decide.mock.calls[0]?.[0] as { actions: Array<Record<string, unknown>> }).actions[0] as Record<string, unknown>;
    expect(Object.keys(action).sort()).toEqual(['durationMs', 'kind', 'rule', 'subject']);
  });

  it('a double decide replays: the same groups, no second sanction, and both calls are audited', async () => {
    const { call, file, audit, cw } = await world();
    const r = await file();
    const body = decideBody([warning(r.target)]);
    const first = await call('POST', `/reports/${r.id}/decide`, { body });
    const second = await call('POST', `/reports/${r.id}/decide`, { actor: 'erin', body: { ...body, reason: 'worded differently' } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const g1 = (first.body as { groups: unknown[] }).groups;
    expect(second.body).toEqual({ ok: true, replay: true, groups: g1 });
    expect(cw.history(r.target)).toHaveLength(1);
    expect(audit().map((a) => a.action)).toEqual(['report.decide', 'report.decide']);
  });

  it('a different decision on a closed report is 409 already_decided, with no audit row for it', async () => {
    const { call, file, audit } = await world();
    const r = await file();
    await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
    const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([], { verdict: 'no_action' }) });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already_decided', message: 'The report has already been decided.' });
    expect(audit()).toHaveLength(1);
  });

  it('a decision with no actions (no_action) is allowed and needs only reports.decide', async () => {
    const { call, file } = await world({ permissions: { 'sanctions.apply': 'owner' } });
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([], { verdict: 'no_action' }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, replay: false, groups: [] });
  });

  it('bad_faith needs evidence, and evidence is refused on other verdicts (400 from the facade)', async () => {
    const { call, file } = await world();
    const r = await file();
    const evidence = 'filed the same false report three times in one evening';
    expect((await call('POST', `/reports/${r.id}/decide`, { body: decideBody([], { verdict: 'bad_faith' }) })).status).toBe(400);
    expect((await call('POST', `/reports/${r.id}/decide`, { body: decideBody([], { verdict: 'no_action', evidence }) })).status).toBe(400);
    expect((await call('POST', `/reports/${r.id}/decide`, { body: decideBody([], { verdict: 'bad_faith', evidence: 5 }) })).status).toBe(400);
    expect((await call('POST', `/reports/${r.id}/decide`, { body: decideBody([], { verdict: 'bad_faith', evidence }) })).status).toBe(200);
  });

  describe('permissions', () => {
    it('a permanent ban needs senior; a moderator is 403 and nothing is written', async () => {
      const { call, file, cw, audit } = await world();
      const r = await file();
      const body = decideBody([{ subject: r.target, kind: 'ban', durationMs: null, rule: 2 }]);
      const denied = await call('POST', `/reports/${r.id}/decide`, { role: 'moderator', body });
      expect(denied.status).toBe(403);
      expect(errorOf(denied)).toBe('forbidden');
      expect(cw.reports.get(r.id)?.status).toBe('open');
      expect(cw.history(r.target)).toEqual([]);
      expect(audit()).toEqual([]);
      const allowed = await call('POST', `/reports/${r.id}/decide`, { role: 'senior', body });
      expect(allowed.status).toBe(200);
      expect(cw.history(r.target).map((h) => [h.kind, h.durationMs])).toEqual([['ban', null]]);
    });

    it('owner may too; a temporary ban, a permanent chat restriction and a warning need only a moderator', async () => {
      const { call, file } = await world();
      const a = await file();
      expect(
        (await call('POST', `/reports/${a.id}/decide`, { role: 'owner', body: decideBody([{ subject: a.target, kind: 'ban', durationMs: null, rule: 2 }]) })).status,
      ).toBe(200);
      const b = await file();
      expect(
        (await call('POST', `/reports/${b.id}/decide`, { role: 'moderator', body: decideBody([{ subject: b.target, kind: 'ban', durationMs: 3 * HOUR, rule: 2 }]) })).status,
      ).toBe(200);
      const c = await file();
      expect(
        (await call('POST', `/reports/${c.id}/decide`, { role: 'moderator', body: decideBody([{ subject: c.target, kind: 'chat', durationMs: null, rule: 2 }]) })).status,
      ).toBe(200);
    });

    it('a permanent ban among several actions still needs senior', async () => {
      const { call, file } = await world();
      const r = await file();
      const body = decideBody([warning(r.bystander), { subject: r.target, kind: 'ban', durationMs: null, rule: 2 }]);
      expect((await call('POST', `/reports/${r.id}/decide`, { role: 'moderator', body })).status).toBe(403);
    });

    it('applying sanctions needs sanctions.apply (an override can raise it); a no-action verdict does not', async () => {
      const { call, file } = await world({ permissions: { 'sanctions.apply': 'senior' } });
      const r = await file();
      const denied = await call('POST', `/reports/${r.id}/decide`, { role: 'moderator', body: decideBody([warning(r.target)]) });
      expect(denied.status).toBe(403);
      expect((await call('POST', `/reports/${r.id}/decide`, { role: 'senior', body: decideBody([warning(r.target)]) })).status).toBe(200);
    });

    it('the ban_permanent override is honoured (moderator allowed when lowered)', async () => {
      const { call, file } = await world({ permissions: { 'sanctions.apply.ban_permanent': 'moderator' } });
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, { role: 'moderator', body: decideBody([{ subject: r.target, kind: 'ban', durationMs: null, rule: 2 }]) });
      expect(res.status).toBe(200);
    });

    it('authorization comes before validation: a too-low role with a bad body is 403, no authz is 401', async () => {
      const { call, file } = await world({ permissions: { 'reports.decide': 'senior' } });
      const r = await file();
      expect((await call('POST', `/reports/${r.id}/decide`, { role: 'moderator', raw: '{nope' })).status).toBe(403);
      expect((await call('POST', `/reports/${r.id}/decide`, { role: null, raw: '{nope' })).status).toBe(401);
    });
  });

  describe('validation (400)', () => {
    const cases: Array<[string, (r: { target: string }) => unknown]> = [
      ['verdict missing', (r) => ({ actions: [warning(r.target)], reason: 'x' })],
      ['verdict unknown', (r) => decideBody([warning(r.target)], { verdict: 'fair' })],
      ['verdict number', (r) => decideBody([warning(r.target)], { verdict: 1 })],
      ['actions missing', () => ({ verdict: 'upheld', reason: 'x' })],
      ['actions object', (r) => decideBody([], { actions: warning(r.target) })],
      ['actions null', () => decideBody([], { actions: null })],
      ['actions too many', (r) => decideBody(Array.from({ length: 21 }, () => warning(r.target)))],
      ['action not an object', () => decideBody(['warning'])],
      ['action null', () => decideBody([null])],
      ['action array', () => decideBody([[]])],
      ['subject missing', () => decideBody([{ kind: 'warning', durationMs: null, rule: 2 }])],
      ['subject number', () => decideBody([warning(7 as never)])],
      ['subject empty', () => decideBody([warning('')])],
      ['subject outside the report', () => decideBody([warning('s_stranger')])],
      ['kind unknown', (r) => decideBody([warning(r.target, { kind: 'jail' })])],
      ['kind missing', (r) => decideBody([{ subject: r.target, durationMs: null, rule: 2 }])],
      ['durationMs missing', (r) => decideBody([{ subject: r.target, kind: 'chat', rule: 2 }])],
      ['durationMs string', (r) => decideBody([warning(r.target, { kind: 'chat', durationMs: '3600000' })])],
      ['durationMs negative', (r) => decideBody([warning(r.target, { kind: 'chat', durationMs: -5 })])],
      ['durationMs zero', (r) => decideBody([warning(r.target, { kind: 'chat', durationMs: 0 })])],
      ['durationMs fraction', (r) => decideBody([warning(r.target, { kind: 'chat', durationMs: 1.5 })])],
      ['durationMs unsafe', (r) => decideBody([warning(r.target, { kind: 'chat', durationMs: 2 ** 60 })])],
      ['durationMs on a warning', (r) => decideBody([warning(r.target, { durationMs: HOUR })])],
      ['rule missing', (r) => decideBody([{ subject: r.target, kind: 'warning', durationMs: null }])],
      ['rule zero', (r) => decideBody([warning(r.target, { rule: 0 })])],
      ['rule fraction', (r) => decideBody([warning(r.target, { rule: 2.5 })])],
      ['rule text', (r) => decideBody([warning(r.target, { rule: 'two' })])],
      ['rule unknown number', (r) => decideBody([warning(r.target, { rule: 9999 })])],
      ['uncovered without a gap note', (r) => decideBody([warning(r.target, { rule: 'uncovered' })])],
      ['gapNote number', (r) => decideBody([warning(r.target, { rule: 'uncovered', gapNote: 5 })])],
      ['includeIp string', (r) => decideBody([warning(r.target, { kind: 'chat', durationMs: HOUR, includeIp: 'yes' })])],
      ['lineIds not an array', (r) => decideBody([warning(r.target, { lineIds: 'a' })])],
      ['lineIds with a number', (r) => decideBody([warning(r.target, { lineIds: [1] })])],
      ['lineIds too many', (r) => decideBody([warning(r.target, { lineIds: ['a', 'b', 'c', 'd', 'e', 'f'] })])],
      ['reason missing', (r) => ({ verdict: 'upheld', actions: [warning(r.target)] })],
      ['reason number', (r) => decideBody([warning(r.target)], { reason: 5 })],
      ['reason blank', (r) => decideBody([warning(r.target)], { reason: '   ' })],
      ['reason too long', (r) => decideBody([warning(r.target)], { reason: 'x'.repeat(501) })],
      ['noted with a warning', (r) => decideBody([warning(r.target)], { verdict: 'noted' })],
      ['no_action against the target', (r) => decideBody([warning(r.target)], { verdict: 'no_action' })],
      ['two warnings for one person', (r) => decideBody([warning(r.target), warning(r.target)])],
    ];
    for (const [name, make] of cases) {
      it(`${name} -> 400 and nothing is decided or audited`, async () => {
        const { call, file, cw, audit } = await world();
        const r = await file();
        const res = await call('POST', `/reports/${r.id}/decide`, { body: make(r) });
        expect(res.status).toBe(400);
        expect(['invalid_request', 'invalid_value']).toContain(errorOf(res));
        expect(cw.reports.get(r.id)?.status).toBe('open');
        expect(audit()).toEqual([]);
      });
    }

    it('no body, bad JSON, non-object bodies and forbidden keys are 400', async () => {
      const { call, file } = await world();
      const r = await file();
      const path = `/reports/${r.id}/decide`;
      expect((await call('POST', path, {})).status).toBe(400);
      for (const raw of ['{nope', '[]', 'null', '"x"', '5', 'true']) expect((await call('POST', path, { raw })).status, raw).toBe(400);
      const res = await call('POST', path, { raw: '{"verdict":"upheld","constructor":{}}' });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('forbidden_key');
    });

    it('413 over 64 KiB', async () => {
      const { call, file } = await world();
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, { raw: JSON.stringify(decideBody([], { verdict: 'no_action', reason: 'x'.repeat(70_000) })) });
      expect(res.status).toBe(413);
    });

    it('404 for an unknown report with a valid body; no audit', async () => {
      const { call, audit } = await world();
      const res = await call('POST', '/reports/nope/decide', { body: decideBody([], { verdict: 'no_action' }) });
      expect(res.status).toBe(404);
      expect(audit()).toEqual([]);
    });

    it('the error body never echoes the request input', async () => {
      const { call, file } = await world();
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning('s_leaky_subject_value')], { reason: 'secret-reason-text' }) });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('s_leaky_subject_value');
      expect(text).not.toContain('secret-reason-text');
    });
  });

  describe('failures', () => {
    it('a store failure inside decide (a rejection) is 500 { error: internal }, logged by class only', async () => {
      const { call, file, logged } = await world({
        wrap: (cw) => ({ ...cw, decide: () => Promise.reject(new TypeError('disk full: secret-detail')) }),
      });
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal' });
      expect(logged.some(([e, d]) => e === 'chatwarden.http_error' && d?.error === 'TypeError')).toBe(true);
      expect(JSON.stringify(logged)).not.toContain('secret-detail');
    });

    it('a synchronous throw from decide is 500 too, and no audit row is written', async () => {
      const { call, file, audit } = await world({
        wrap: (cw) => ({
          ...cw,
          decide: () => {
            throw new Error('boom');
          },
        }),
      });
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
      expect(res.status).toBe(500);
      expect(audit()).toEqual([]);
    });

    it('a decision that committed is still answered 200 when the audit write fails (and the failure is logged)', async () => {
      const { call, file, cw, logged } = await world({
        wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }),
      });
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
      expect(res.status).toBe(200);
      expect(cw.reports.get(r.id)?.status).toBe('actioned');
      expect(logged.some(([e]) => e === 'chatwarden.http_audit_failed')).toBe(true);
    });
  });
});

describe('GET /people/:ref/history', () => {
  it('returns the actions and a recent-reports summary (id, date, category), and audits history.view', async () => {
    const { call, file, audit, clock } = await world();
    const r = await file('cheating');
    await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)]) });
    const res = await call('GET', `/people/${r.target}/history`, { actor: 'fay', role: 'moderator' });
    expect(res.status).toBe(200);
    const body = res.body as { history: Array<{ kind: string }>; reports: Array<Record<string, unknown>> };
    expect(body.history.map((h) => h.kind)).toEqual(['warning']);
    expect(body.reports).toEqual([{ id: r.id, createdAt: r.report.createdAt, category: 'cheating' }]);
    expect(audit().filter((a) => a.action === 'history.view').map((a) => [a.actor, a.role, a.target])).toEqual([
      ['fay', 'moderator', { type: 'person', ref: r.target }],
    ]);
    expect(clock.t).toBeGreaterThan(0);
  });

  it('lists only reports against that person, newest first, and honours limit', async () => {
    const { call, file, clock } = await world();
    const a = await file();
    clock.t += 1000;
    const b = await file();
    const body = (await call('GET', `/people/${a.target}/history`)).body as { reports: Array<{ id: string }> };
    expect(body.reports.map((x) => x.id)).toEqual([a.id]);
    const reporter = (await call('GET', `/people/${a.reporter}/history`)).body as { reports: unknown[] };
    expect(reporter.reports).toEqual([]);
    expect(b.id).not.toBe(a.id);
  });

  it('parses limit as an integer, 400 invalid_query otherwise', async () => {
    const { call, file } = await world();
    const r = await file();
    expect((await call('GET', `/people/${r.target}/history`, { query: { limit: '1' } })).status).toBe(200);
    for (const bad of ['x', '1.5', '-2', '', '1e2']) {
      const res = await call('GET', `/people/${r.target}/history`, { query: { limit: bad } });
      expect(res.status, bad).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
    }
  });

  it('an unknown person has an empty history and no reports (200), audited', async () => {
    const { call, audit } = await world();
    const res = await call('GET', '/people/s_nobody/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      history: [],
      reports: [],
      sanctions: [],
      asReporter: {
        reports: 0, open: 0, actioned: 0, dismissed: 0, badFaith: 0, suspendedUntil: null, reasonMatched: 0, reasonDecided: 0,
        accuracy: { decided: 0, noAction: 0, badFaith: 0, unfounded: 0, falseRate: null, noticeable: false, habitual: false, windowMs: 30 * 86_400_000 },
      },
      handle: null,
    });
    expect(audit().map((a) => a.action)).toEqual(['history.view']);
  });

  it('a ref with a bad shape is 404 from the router', async () => {
    const { call, audit } = await world();
    expect((await call('GET', '/people/bad%20ref/history')).status).toBe(404);
    expect((await call('GET', `/people/${'a'.repeat(65)}/history`)).status).toBe(404);
    expect(audit()).toEqual([]);
  });
});

describe('every admin route: 401 without authz, 403 below the needed role', () => {
  const routes: Array<[string, string, (id: string, ref: string) => string, unknown]> = [
    ['GET', 'list', () => '/reports', undefined],
    ['GET', 'get', (id) => `/reports/${id}`, undefined],
    ['POST', 'suggest', (id) => `/reports/${id}/suggest`, { level: null }],
    ['POST', 'decide', (id) => `/reports/${id}/decide`, { verdict: 'no_action', actions: [], reason: 'ok' }],
    ['GET', 'history', (_id, ref) => `/people/${ref}/history`, undefined],
  ];

  for (const [method, name, path, body] of routes) {
    it(`${method} ${name}: 401 when authorize returns null, and the handler does not run`, async () => {
      const { call, file, audit, cw } = await world();
      const r = await file();
      const res = await call(method, path(r.id, r.target), { role: null, ...(body === undefined ? {} : { body }) });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
      expect(audit()).toEqual([]);
      expect(cw.reports.get(r.id)?.status).toBe('open');
    });

    it(`${method} ${name}: 403 when the role is below the needed one`, async () => {
      const { call, file, audit, cw } = await world({
        permissions: { 'reports.read': 'owner', 'reports.decide': 'owner', 'history.read': 'owner' },
      });
      const r = await file();
      for (const role of ['moderator', 'senior'] as const) {
        const res = await call(method, path(r.id, r.target), { role, ...(body === undefined ? {} : { body }) });
        expect(res.status, role).toBe(403);
        expect(errorOf(res)).toBe('forbidden');
      }
      expect(audit()).toEqual([]);
      expect(cw.reports.get(r.id)?.status).toBe('open');
      // Control: the owner gets through.
      const ok = await call(method, path(r.id, r.target), { role: 'owner', ...(body === undefined ? {} : { body }) });
      expect(ok.status).toBe(200);
    });
  }

  it('a malformed authz from the hook (empty actor, unknown role) is 401', async () => {
    const { cw } = await world();
    const bads: unknown[] = [{ actor: '', role: 'moderator' }, { actor: 'x', role: 'admin' }, { role: 'owner' }, 'owner', 7];
    for (const bad of bads) {
      const router = createRouter(adminRoutes(cw, { authorize: () => bad as never }));
      const res = await router({ method: 'GET', path: '/reports', query: {}, headers: {}, body: undefined });
      expect(res.status).toBe(401);
    }
  });

  it('an async authorize works, and one that throws or rejects is 500 (fail closed, not 200)', async () => {
    const { cw } = await world();
    const ask = (authorize: never) =>
      createRouter(adminRoutes(cw, { authorize }))({ method: 'GET', path: '/reports', query: {}, headers: {}, body: undefined });
    expect((await ask((async () => ({ actor: 'a', role: 'moderator' })) as never)).status).toBe(200);
    expect((await ask((async () => null) as never)).status).toBe(401);
    expect((await ask((async () => Promise.reject(new Error('idp down'))) as never)).status).toBe(500);
    expect(
      (
        await ask((() => {
          throw new Error('sync');
        }) as never)
      ).status,
    ).toBe(500);
  });

  it('a viewing route fails closed (500) when its audit row cannot be written', async () => {
    const { call, file } = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const r = await file();
    for (const [method, , path, body] of routes) {
      if (path(r.id, r.target).endsWith('/decide')) continue;
      const res = await call(method, path(r.id, r.target), body === undefined ? {} : { body });
      expect(res.status, path(r.id, r.target)).toBe(500);
      expect(res.body).toEqual({ error: 'internal' });
    }
  });

  it('the router answers 404 for unknown paths and 405 for a wrong method before auth (accepted)', async () => {
    const { call } = await world();
    expect((await call('GET', '/nope', { role: null })).status).toBe(404);
    const res = await call('DELETE', '/reports', { role: null });
    expect(res.status).toBe(405);
  });
});

describe('responses carry no ip, hash or raw key', () => {
  it('no ip, ipHash, keyHash or key at any depth, and no raw credential value in any response', async () => {
    const { call, file } = await world();
    const r = await file();
    const other = await file('spam');
    const responses: KitResponse[] = [];
    responses.push(await call('GET', '/reports'));
    responses.push(await call('GET', `/reports/${r.id}`));
    responses.push(await call('POST', `/reports/${r.id}/suggest`, { body: { level: 'hostile' } }));
    responses.push(
      await call('POST', `/reports/${r.id}/decide`, {
        body: decideBody([{ subject: r.target, kind: 'chat', durationMs: HOUR, rule: 2, includeIp: true }]),
      }),
    );
    responses.push(await call('POST', `/reports/${r.id}/decide`, { body: decideBody([{ subject: r.target, kind: 'chat', durationMs: HOUR, rule: 2, includeIp: true }]) }));
    responses.push(await call('GET', `/people/${r.target}/history`));
    responses.push(await call('GET', `/reports/${other.id}`, { query: { level: 'severe' } }));
    responses.push(await call('GET', '/reports/nope'));
    responses.push(await call('GET', '/reports', { role: null }));
    expect(responses.every((x) => x.status < 500)).toBe(true);
    expect(responses.filter((x) => x.status === 200).length).toBeGreaterThanOrEqual(6);

    const forbidden = /^(ip|ips|ipHash|keyHash|clientKey|key|rawKey|secret|hash)$/i;
    for (const res of responses) {
      for (const k of keysDeep(res.body)) expect(forbidden.test(k), k).toBe(false);
      const text = JSON.stringify(res.body);
      for (const raw of [KEY_REPORTER, KEY_TARGET, KEY_BYSTANDER, IP_TARGET, IP_REPORTER, SECRET]) expect(text).not.toContain(raw);
    }
  });
});

describe('durations are capped at 365 days: null is the only permanent value', () => {
  const YEAR = 365 * 24 * HOUR;
  it('exactly the cap is accepted for a moderator (chat and ban)', async () => {
    const { call, file } = await world();
    for (const kind of ['chat', 'ban'] as const) {
      const r = await file();
      const res = await call('POST', `/reports/${r.id}/decide`, {
        role: 'moderator',
        body: decideBody([{ subject: r.target, kind, durationMs: YEAR, rule: 2 }]),
      });
      expect(res.status, kind).toBe(200);
    }
  });

  it('one millisecond over, 9e15 and MAX_SAFE_INTEGER are 400 and decide nothing', async () => {
    const { call, file, cw, audit } = await world();
    const r = await file();
    for (const durationMs of [YEAR + 1, 2 * YEAR, 9e15, Number.MAX_SAFE_INTEGER]) {
      for (const kind of ['chat', 'area', 'ban']) {
        const res = await call('POST', `/reports/${r.id}/decide`, {
          role: 'senior',
          body: decideBody([{ subject: r.target, kind, durationMs, rule: 2 }]),
        });
        expect(res.status, `${kind} ${durationMs}`).toBe(400);
      }
    }
    expect(cw.reports.get(r.id)?.status).toBe('open');
    expect(audit()).toEqual([]);
  });

  it('a moderator can no longer get a near-permanent ban: 9e15 is 400, null is 403, only a senior gets permanent', async () => {
    const { call, file } = await world();
    const r = await file();
    const path = `/reports/${r.id}/decide`;
    const ban = (durationMs: number | null) => decideBody([{ subject: r.target, kind: 'ban', durationMs, rule: 2 }]);
    expect((await call('POST', path, { role: 'moderator', body: ban(9e15) })).status).toBe(400);
    expect((await call('POST', path, { role: 'moderator', body: ban(null) })).status).toBe(403);
    expect((await call('POST', path, { role: 'senior', body: ban(null) })).status).toBe(200);
  });
});

describe('an authorize result with an actor the audit trail cannot hold is an adopter bug (500)', () => {
  const bad = ['Jane Doe', 'jane\ndoe', 'a/b', 'x'.repeat(129), 'ann<script>', 'é'];
  const ask = (cw: Chatwarden, logger: Logger, actor: string, method: string, path: string, body?: unknown) =>
    createRouter(adminRoutes(cw, { authorize: () => ({ actor, role: 'owner' }), logger }))({
      method,
      path,
      query: {},
      headers: {},
      body: undefined,
      ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }),
    });

  it('every route answers 500 internal before the handler runs, and logs chatwarden.http_bad_actor without the value', async () => {
    const { cw, file, audit, logged } = await world();
    const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
    const r = await file();
    logged.length = 0;
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/reports', undefined],
      ['GET', `/reports/${r.id}`, undefined],
      ['POST', `/reports/${r.id}/suggest`, { level: null }],
      ['POST', `/reports/${r.id}/decide`, decideBody([warning(r.target)])],
      ['GET', `/people/${r.target}/history`, undefined],
    ];
    for (const actor of bad) {
      for (const [method, path, body] of routes) {
        const res = await ask(cw, logger, actor, method, path, body);
        expect(res.status, `${actor} ${path}`).toBe(500);
        expect(res.body).toEqual({ error: 'internal' });
      }
    }
    expect(audit()).toEqual([]);
    expect(cw.reports.get(r.id)?.status).toBe('open');
    expect(logged.some(([e]) => e === 'chatwarden.http_bad_actor')).toBe(true);
    for (const actor of bad) expect(JSON.stringify(logged)).not.toContain(actor);
  });

  it('controls: actors of the allowed charset (logins, emails, refs) are served', async () => {
    const { cw, file, logged } = await world();
    const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
    const r = await file();
    for (const actor of ['ann', 'a.b@x.com', 'staff:42', 'u_1-2+3', 'x'.repeat(128)]) {
      const res = await ask(cw, logger, actor, 'GET', `/reports/${r.id}`);
      expect(res.status, actor).toBe(200);
    }
  });

  it('an empty or non-string actor is still 401 (a malformed authz), not 500', async () => {
    const { cw } = await world();
    const logger: Logger = { warn() {} };
    for (const actor of ['', 5 as never, null as never]) {
      const res = await ask(cw, logger, actor, 'GET', '/reports');
      expect(res.status).toBe(401);
    }
  });
});

describe('decide answers each group with the kind the facade recorded', () => {
  it('a mixed decision on a merged person, then a replay, report the same correct kinds', async () => {
    const { call, file, cw } = await world();
    const r = await file();
    const body = decideBody([
      { subject: r.target, kind: 'warning', durationMs: null, rule: 2 },
      { subject: r.target, kind: 'chat', durationMs: HOUR, rule: 2 },
      { subject: r.bystander, kind: 'note', durationMs: null, rule: 2 },
      { subject: r.target, kind: 'ban', durationMs: 2 * HOUR, rule: 2 },
    ]);
    // Merge the target with another person first, so the decision is keyed by the surviving id.
    cw.rooms.seat('merge-room', 'm1', { clientKey: 'merge-other-key', accountId: 'acct-merge-http' }, 'Other');
    cw.rooms.seat('merge-room', 'm2', { clientKey: `${KEY_TARGET}-1`, accountId: 'acct-merge-http' }, 'Tgt');
    const first = await call('POST', `/reports/${r.id}/decide`, { body });
    expect(first.status).toBe(200);
    const kinds = (first.body as { groups: Array<{ kind: string }> }).groups.map((g) => g.kind);
    expect([...kinds].sort()).toEqual(['ban', 'chat', 'note', 'warning']);
    const again = await call('POST', `/reports/${r.id}/decide`, { body });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, replay: true, groups: (first.body as { groups: unknown[] }).groups });
  });
});

describe('audit rows hold ids and the action name only', () => {
  it('no reason, evidence or chat text is stored', async () => {
    const { call, file, audit } = await world();
    const r = await file();
    await call('GET', '/reports');
    await call('GET', `/reports/${r.id}`);
    await call('POST', `/reports/${r.id}/suggest`, { body: { level: 'rude' } });
    await call('POST', `/reports/${r.id}/decide`, { body: decideBody([warning(r.target)], { reason: 'private-moderator-reason' }) });
    await call('GET', `/people/${r.target}/history`);
    const rows = audit();
    expect(rows.map((a) => a.action).sort()).toEqual(['history.view', 'report.decide', 'report.view', 'report.view', 'suggest']);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('private-moderator-reason');
    expect(text).not.toContain('a line from the target');
    for (const row of rows) expect(Object.keys(row).filter((k) => k !== 'target').sort()).toEqual(['action', 'actor', 'at', 'id', 'role']);
  });
});

describe('GET /reports: reporterAccuracy on the open rows', () => {
  type Item = { id: string; status: string; reporterPerson: string; reporterAccuracy: Record<string, unknown> | null };
  type Wd = Awaited<ReturnType<typeof world>>;

  /** A reporter (a fixed key) with `unfounded` dismissed and `founded` actioned reports in the last days, and one fresh open report. */
  async function withHistory(w: Wd, key: string, unfounded: number, founded: number) {
    const seatRoom = `hist-room-${key}`;
    w.cw.rooms.seat(seatRoom, 'p1', { clientKey: key }, 'Rep');
    const reporter = w.cw.rooms.subjectAt(seatRoom, 'p1') as string;
    for (let i = 0; i < unfounded + founded; i++) {
      const id = `hist-${key}-${i}`;
      w.store.insertReport({
        id,
        createdAt: NOW - 3 * 24 * HOUR,
        roomId: `hr-${id}`,
        tags: {},
        reporterSubject: reporter,
        reporterSeat: 'p1',
        reporterHandle: 'Rep',
        targetSubject: `s_old_${id}`,
        targetSeat: 'p2',
        targetHandle: 'Tgt',
        category: 'harassment',
        note: null,
        lineId: null,
        excerpt: [],
        people: [],
        status: 'open',
      });
      w.store.closeReport(id, i < unfounded ? 'dismissed' : 'actioned', false, 'mod', NOW - 2 * 24 * HOUR, 'n');
    }
    const room = `fresh-room-${key}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: key }, 'Rep');
    w.cw.rooms.seat(room, 'p2', { clientKey: `fresh-target-${key}` }, 'Tgt');
    w.cw.chat.accept(room, 'p2', 'a line');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { id: res.reportId, reporter };
  }
  const items = async (w: Wd, o: { role?: Role } = {}) =>
    ((await w.call('GET', '/reports', { ...(o.role === undefined ? {} : { role: o.role }) })).body as { items: Item[] }).items;

  it('an open row carries decided, unfounded, falseRate and habitual for a history.read caller, and nothing else', async () => {
    const w = await world();
    const r = await withHistory(w, 'habitual-key', 5, 1);
    const row = (await items(w)).find((i) => i.id === r.id) as Item;
    expect(row.reporterAccuracy).toEqual({ decided: 6, unfounded: 5, falseRate: 5 / 6, habitual: true });
  });

  it('below the minimum sample the rate is null and the reporter is not habitual; with no history the figure is null', async () => {
    const w = await world();
    const few = await withHistory(w, 'few-key', 3, 0);
    const none = await w.file();
    const rows = await items(w);
    expect((rows.find((i) => i.id === few.id) as Item).reporterAccuracy).toEqual({ decided: 3, unfounded: 3, falseRate: null, habitual: false });
    expect((rows.find((i) => i.id === none.id) as Item).reporterAccuracy).toBeNull();
  });

  it('a mostly-founded reporter is not habitual', async () => {
    const w = await world();
    const r = await withHistory(w, 'good-key', 1, 7);
    expect(((await items(w)).find((i) => i.id === r.id) as Item).reporterAccuracy).toEqual({ decided: 8, unfounded: 1, falseRate: 1 / 8, habitual: false });
  });

  it('decided rows carry null', async () => {
    const w = await world();
    const r = await withHistory(w, 'habitual-key', 5, 0);
    await w.call('POST', `/reports/${r.id}/decide`, { body: { verdict: 'no_action', actions: [] } });
    const row = (await items(w)).find((i) => i.id === r.id) as Item;
    expect(row.status).toBe('dismissed');
    expect(row.reporterAccuracy).toBeNull();
  });

  it('a caller without history.read gets null on every row, and still gets the queue', async () => {
    const w = await world({ permissions: { 'history.read': 'senior' } });
    const r = await withHistory(w, 'habitual-key', 6, 0);
    const mod = await items(w, { role: 'moderator' });
    expect(mod.map((i) => i.id)).toContain(r.id);
    expect(mod.every((i) => i.reporterAccuracy === null)).toBe(true);
    const senior = await items(w, { role: 'senior' });
    expect((senior.find((i) => i.id === r.id) as Item).reporterAccuracy).toMatchObject({ habitual: true });
  });

  it('is read in one batch for the page, each reporter once', async () => {
    const calls: number[] = [];
    const w = await world({
      wrap: (cw) => ({ ...cw, reports: { ...cw.reports, reporterAccuracy: (people) => (calls.push(people.length), cw.reports.reporterAccuracy(people)) } }),
    });
    await withHistory(w, 'habitual-key', 6, 0);
    await w.file();
    await w.file();
    await items(w);
    expect(calls).toEqual([3]);
  });

  it('a failing accuracy read does not fail the queue: the figure is null and one line is logged', async () => {
    const w = await world({
      wrap: (cw) => ({
        ...cw,
        reports: {
          ...cw.reports,
          reporterAccuracy: () => {
            throw new Error('disk full');
          },
        },
      }),
    });
    await w.file();
    const res = await w.call('GET', '/reports');
    expect(res.status).toBe(200);
    expect((res.body as { items: Item[] }).items.every((i) => i.reporterAccuracy === null)).toBe(true);
    expect(w.logged.some(([e]) => e === 'chatwarden.http_accuracy_failed')).toBe(true);
    expect(JSON.stringify(w.logged)).not.toContain('disk full');
  });

  it('the figure appears on no other route (the report page carries history, not the row figure)', async () => {
    const w = await world();
    const r = await withHistory(w, 'habitual-key', 6, 0);
    const page = await w.call('GET', `/reports/${r.id}`);
    expect(JSON.stringify(page.body)).not.toContain('reporterAccuracy');
  });
});
