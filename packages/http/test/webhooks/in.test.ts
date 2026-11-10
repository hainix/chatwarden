import { describe, expect, it } from 'vitest';
import { MAX_SANCTION_DURATION_MS } from '@chatwarden/core';
import type { Chatwarden, KitEvent, Logger, Role } from '@chatwarden/core';
import { createRouter } from '../../src/router.js';
import type { KitRequest, KitResponse } from '../../src/types.js';
import { parseSanction, sanctionFingerprint } from '../../src/admin/apply.js';
import { webhookIn } from '../../src/webhooks/in.js';
import type { WebhookInOptions } from '../../src/webhooks/in.js';
import { ReplayCache, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '../../src/webhooks/sign.js';
import { errorOf, world } from '../world.js';

const SECRET = 'incoming-secret-at-least-32-characters!!';
const ACTOR = 'hook@example.test';
const PATH = '/webhooks/in/action';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PRIVATE_REASON = 'PRIVATE-MODERATOR-REASON';

const UNAUTHORIZED = { error: 'unauthorized', message: 'Authentication is required.' };

interface Setup {
  w: Awaited<ReturnType<typeof world>>;
  cw: Chatwarden;
  hook: (req: KitRequest) => Promise<KitResponse>;
  /** Build a signed request for `body` at the current clock (unless overridden). */
  req: (body: unknown, o?: ReqOptions) => KitRequest;
  /** Build, send and advance the clock one second, so every call is a distinct signature. */
  post: (body: unknown, o?: ReqOptions) => Promise<KitResponse>;
  send: (req: KitRequest) => Promise<KitResponse>;
  events: KitEvent[];
  filed: (n?: number) => Promise<{ reportId: string; target: string; reporter: string }>;
  sanctionRows: () => Array<Record<string, unknown>>;
  keyRows: () => Array<Record<string, unknown>>;
  logged: Array<[string, Record<string, string | number | boolean> | undefined]>;
}

interface ReqOptions {
  secret?: string;
  /** Seconds added to the clock's now for the signed timestamp. */
  skew?: number;
  headers?: Record<string, string | undefined>;
  raw?: string;
  /** Sign this body but send another. */
  sendRaw?: string;
}

async function setup(over: { hook?: Partial<WebhookInOptions>; wrap?: (cw: Chatwarden) => Chatwarden } = {}): Promise<Setup> {
  const w = await world();
  const cw = over.wrap === undefined ? w.cw : over.wrap(w.cw);
  const logger: Logger = { warn: (event, detail) => void w.logged.push([event, detail]) };
  const router = createRouter(webhookIn(cw, { secret: SECRET, actor: ACTOR, clock: w.clock, logger, ...over.hook }));
  const events: KitEvent[] = [];
  w.cw.on('*', (e) => void events.push(e));

  const req: Setup['req'] = (body, o = {}) => {
    const raw = o.raw ?? (typeof body === 'string' ? body : JSON.stringify(body));
    const ts = Math.floor(w.clock.t / 1000) + (o.skew ?? 0);
    const headers: Record<string, string> = {
      [TIMESTAMP_HEADER]: String(ts),
      [SIGNATURE_HEADER]: sign(o.secret ?? SECRET, ts, raw),
    };
    for (const [k, v] of Object.entries(o.headers ?? {})) {
      if (v === undefined) delete headers[k];
      else headers[k] = v;
    }
    return { method: 'POST', path: PATH, query: {}, headers, body: undefined, rawBody: o.sendRaw ?? raw };
  };
  const send = (r: KitRequest) => hook(r);
  const hook = (r: KitRequest) => router(r);
  const post: Setup['post'] = async (body, o) => {
    const res = await hook(req(body, o));
    w.clock.t += 1000;
    return res;
  };

  let n = 0;
  const filed: Setup['filed'] = async (k = ++n) => {
    const room = `room-in-${k}`;
    w.cw.rooms.seat(room, 'a', { clientKey: `key-target-aaaaaaaa-${k}`, ip: '198.51.100.7' }, 'Tgt');
    w.cw.rooms.seat(room, 'b', { clientKey: `key-reporter-bbbbbbb-${k}`, ip: '198.51.100.8' }, 'Rep');
    w.cw.chat.accept(room, 'a', 'an ordinary line of chat');
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    if (!res.ok) throw new Error('expected a stored report');
    events.length = 0; // the report.created event is not what these tests look at
    return {
      reportId: res.reportId,
      target: w.cw.rooms.subjectAt(room, 'a') as string,
      reporter: w.cw.rooms.subjectAt(room, 'b') as string,
    };
  };
  return {
    w,
    cw,
    hook,
    req,
    post,
    send,
    events,
    filed,
    sanctionRows: () => w.db.prepare("SELECT * FROM kit_sanctions WHERE target_type = 'subject' ORDER BY rowid").all(),
    keyRows: () => w.db.prepare('SELECT * FROM kit_webhook_keys ORDER BY rowid').all(),
    logged: w.logged,
  };
}

const decideBody = (reportId: string, target: string, over: Record<string, unknown> = {}): { action: string; input: Record<string, unknown> } => ({
  action: 'decide',
  input: {
    reportId,
    verdict: 'upheld',
    reason: PRIVATE_REASON,
    actions: [{ subject: target, kind: 'chat', durationMs: HOUR, rule: 1 }],
    ...over,
  },
});

const sanctionBody = (subject: string, key: unknown = 'key-1', over: Record<string, unknown> = {}) => ({
  action: 'sanction',
  input: { subject, kind: 'chat', durationMs: HOUR, rule: 1, reason: PRIVATE_REASON, idempotencyKey: key, ...over },
});

describe('construction', () => {
  const kit = async () => (await world()).cw;

  it('exposes exactly POST /webhooks/in/action', async () => {
    expect(Object.keys(webhookIn(await kit(), { secret: SECRET, actor: ACTOR }))).toEqual(['POST /webhooks/in/action']);
  });

  it('refuses a secret under 32 characters without echoing it', async () => {
    const short = 'z'.repeat(31);
    let caught: unknown;
    try {
      webhookIn(await kit(), { secret: short, actor: ACTOR });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(String((caught as Error).message)).not.toContain(short);
    expect(() => webhookIn({} as Chatwarden, { secret: 'z'.repeat(32), actor: ACTOR })).not.toThrow();
    expect(() => webhookIn({} as Chatwarden, { secret: undefined as never, actor: ACTOR })).toThrow(RangeError);
  });

  it.each([
    ['empty', ''],
    ['a space', 'hook agent'],
    ['129 characters', 'a'.repeat(129)],
    ['a slash', 'hook/agent'],
    ['not a string', 7],
    ['undefined', undefined],
  ])('refuses an actor the audit trail cannot hold: %s', (_n, actor) => {
    expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: actor as never })).toThrow(RangeError);
  });

  it('accepts the audit-ref actor charset, 128 characters at most', () => {
    expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: 'A-Z_a.z:0@9+-' })).not.toThrow();
    expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: 'a'.repeat(128) })).not.toThrow();
  });

  it('refuses a role that is not a role, and bad permission overrides (validated once, at construction)', () => {
    expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: ACTOR, role: 'admin' as never })).toThrow(RangeError);
    expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: ACTOR, role: undefined, permissions: { nope: 'owner' } as never })).toThrow(RangeError);
    expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: ACTOR, permissions: { 'terms.read': 'god' as never } })).toThrow(RangeError);
    for (const role of ['moderator', 'senior', 'owner'] as Role[]) {
      expect(() => webhookIn({} as Chatwarden, { secret: SECRET, actor: ACTOR, role })).not.toThrow();
    }
  });
});

describe('the signature gate', () => {
  it('a valid request passes', async () => {
    const s = await setup();
    const { target, reportId } = await s.filed();
    const res = await s.post(decideBody(reportId, target));
    expect(res.status).toBe(200);
  });

  const bad: Array<[string, (s: Setup) => ReqOptions]> = [
    ['a wrong secret', () => ({ secret: `${SECRET}-other` })],
    ['a stale timestamp (301 s old)', () => ({ skew: -301 })],
    ['a future timestamp (301 s ahead)', () => ({ skew: 301 })],
    ['a changed body', () => ({ sendRaw: '{"action":"sanction","input":{}}' })],
    ['a missing signature', () => ({ headers: { [SIGNATURE_HEADER]: undefined } })],
    ['a missing timestamp', () => ({ headers: { [TIMESTAMP_HEADER]: undefined } })],
    ['a non-numeric timestamp', () => ({ headers: { [TIMESTAMP_HEADER]: 'yesterday' } })],
    ['a signature without the v1= prefix', () => ({ headers: { [SIGNATURE_HEADER]: 'a'.repeat(64) } })],
    ['an uppercase signature', (s) => ({ headers: { [SIGNATURE_HEADER]: sign(SECRET, Math.floor(s.w.clock.t / 1000), '{}').toUpperCase() } })],
    ['a short signature', () => ({ headers: { [SIGNATURE_HEADER]: 'v1=abc' } })],
  ];

  it.each(bad)('%s is 401 with a fixed body, and nothing is applied', async (_name, opts) => {
    const s = await setup();
    const { target, reportId } = await s.filed();
    const res = await s.post(decideBody(reportId, target), opts(s));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
    expect(s.sanctionRows()).toHaveLength(0);
    expect(s.events).toEqual([]);
    expect(s.keyRows()).toHaveLength(0);
  });

  it('the 401 is the same whatever was wrong (no oracle)', async () => {
    const s = await setup();
    const bodies = new Set<string>();
    for (const [, opts] of bad) bodies.add(JSON.stringify((await s.post(sanctionBody(s.w.person()), opts(s))).body));
    expect([...bodies]).toEqual([JSON.stringify(UNAUTHORIZED)]);
  });

  it('exactly 300 s old and 300 s ahead are accepted', async () => {
    const s = await setup();
    const a = await s.filed();
    expect((await s.post(decideBody(a.reportId, a.target), { skew: -300 })).status).toBe(200);
    const b = await s.filed();
    expect((await s.post(decideBody(b.reportId, b.target), { skew: 300 })).status).toBe(200);
  });

  it('a replayed request (the same signature) is 401, and applies nothing more', async () => {
    const s = await setup();
    const subject = s.w.person();
    const r = s.req(sanctionBody(subject, 'replay-key'));
    expect((await s.send(r)).status).toBe(200);
    const again = await s.send(r);
    expect(again.status).toBe(401);
    expect(again.body).toEqual(UNAUTHORIZED);
    expect(s.sanctionRows()).toHaveLength(1);
  });

  it('a refused request does not burn its signature: the genuine one still passes', async () => {
    const s = await setup();
    const subject = s.w.person();
    const genuine = s.req(sanctionBody(subject, 'k-genuine'));
    const forged = { ...genuine, rawBody: `${genuine.rawBody}x` };
    expect((await s.send(forged)).status).toBe(401);
    expect((await s.send(genuine)).status).toBe(200);
  });

  it('verifies BEFORE parsing: garbage with a bad signature is 401, garbage with a good one is 400', async () => {
    const s = await setup();
    expect((await s.post('not json {', { secret: 'x'.repeat(40) })).status).toBe(401);
    const res = await s.post('not json {');
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_json');
  });

  it('verifies before the forbidden-key check too', async () => {
    const s = await setup();
    expect((await s.post('{"__proto__":{}}', { secret: 'x'.repeat(40) })).status).toBe(401);
    expect(errorOf(await s.post('{"__proto__":{}}'))).toBe('forbidden_key');
  });

  it('a request with no rawBody is an adapter mistake: 500, logged, nothing applied (a pre-parsed body is never trusted)', async () => {
    const s = await setup();
    const subject = s.w.person();
    const r = s.req(sanctionBody(subject));
    const { rawBody: _raw, ...rest } = r;
    void _raw;
    const res = await s.send({ ...rest, body: sanctionBody(subject) });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(s.logged.map(([e]) => e)).toContain('chatwarden.webhook_no_raw_body');
    expect(s.sanctionRows()).toHaveLength(0);
  });

  it('a body over 64 KiB is 413 before any signature work', async () => {
    const s = await setup();
    const res = await s.post(`{"pad":"${'x'.repeat(70_000)}"}`);
    expect(res.status).toBe(413);
    expect(errorOf(res)).toBe('payload_too_large');
  });

  it('an empty body with a valid signature is 400, not a crash', async () => {
    const s = await setup();
    const res = await s.post('');
    expect(res.status).toBe(400);
  });

  it('a multi-byte body verifies over the exact text', async () => {
    const s = await setup();
    const subject = s.w.person();
    const body = `{ "action" : "sanction",\n "input": ${JSON.stringify({ ...sanctionBody(subject).input, reason: 'é日本 \u{1F600}' })} }`;
    expect((await s.post(body)).status).toBe(200);
  });

  it('only POST on the path: other methods are 405, other paths 404', async () => {
    const s = await setup();
    expect((await s.hook({ ...s.req({}), method: 'GET' })).status).toBe(405);
    expect((await s.hook({ ...s.req({}), path: '/webhooks/in/other' })).status).toBe(404);
  });
});

describe('the request shape', () => {
  it.each([
    ['an array', []],
    ['a string', '"x"'],
    ['a number', '5'],
    ['null', 'null'],
  ])('a body that is %s is 400', async (_n, body) => {
    const s = await setup();
    expect((await s.post(body)).status).toBe(400);
  });

  it.each([
    ['no action', { input: {} }],
    ['an unknown action', { action: 'revoke', input: {} }],
    ['a non-string action', { action: 5, input: {} }],
    ['no input', { action: 'decide' }],
    ['an array input', { action: 'decide', input: [] }],
    ['a string input', { action: 'sanction', input: 'x' }],
    ['a null input', { action: 'sanction', input: null }],
  ])('%s is 400 invalid_request', async (_n, body) => {
    const s = await setup();
    const res = await s.post(body);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_request');
  });

  it('error bodies never echo the request', async () => {
    const s = await setup();
    const res = await s.post({ action: 'ECHO-ME-ACTION', input: { reason: 'ECHO-ME-REASON' } });
    expect(JSON.stringify(res.body)).not.toContain('ECHO-ME');
  });
});

describe('action: decide', () => {
  it('decides the report, as the configured actor, and writes the audit row with its role', async () => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    const res = await s.post(decideBody(reportId, target));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, replay: false, groups: [{ refCode: expect.any(String), kind: 'chat' }] });
    expect(s.cw.reports.get(reportId)).toMatchObject({ status: 'actioned', actionedBy: ACTOR });
    const rows = s.sanctionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: ACTOR, source: 'moderator', kind: 'chat', automated: 0 });
    expect(s.w.routeAudit()).toEqual([
      expect.objectContaining({ actor: ACTOR, role: 'moderator', action: 'report.decide', target: { type: 'report', ref: reportId } }),
    ]);
    expect(s.events.map((e) => e.type)).toEqual(['report.closed', 'sanction.applied']);
  });

  it('the actor, source and role in the body are ignored', async () => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    const body = decideBody(reportId, target, { actor: 'evil', source: 'api', role: 'owner' });
    const withTop = { ...body, actor: 'evil2', role: 'owner' };
    expect((await s.post(withTop)).status).toBe(200);
    expect(s.cw.reports.get(reportId)?.actionedBy).toBe(ACTOR);
    expect(s.sanctionRows()[0]).toMatchObject({ actor: ACTOR, source: 'moderator' });
    expect(s.w.routeAudit()[0]).toMatchObject({ actor: ACTOR, role: 'moderator' });
    expect(JSON.stringify(s.w.audit())).not.toContain('evil');
  });

  it('a decision replayed 5 times applies once (idempotent in the core)', async () => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    const results: KitResponse[] = [];
    for (let i = 0; i < 5; i++) results.push(await s.post(decideBody(reportId, target)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.map((r) => (r.body as { replay: boolean }).replay)).toEqual([false, true, true, true, true]);
    expect(s.sanctionRows()).toHaveLength(1);
    expect(s.events.filter((e) => e.type === 'report.closed')).toHaveLength(1);
    expect(s.events.filter((e) => e.type === 'sanction.applied')).toHaveLength(1);
    // The same refCode every time.
    expect(new Set(results.map((r) => JSON.stringify((r.body as { groups: unknown }).groups))).size).toBe(1);
  });

  it('a different decision on a closed report is 409 already_decided', async () => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    expect((await s.post(decideBody(reportId, target))).status).toBe(200);
    const res = await s.post(decideBody(reportId, target, { verdict: 'no_action', actions: [] }));
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('already_decided');
  });

  it('an unknown report is 404', async () => {
    const s = await setup();
    const { target } = await s.filed();
    const res = await s.post(decideBody('no-such-report', target));
    expect(res.status).toBe(404);
  });

  it.each([
    ['a bad verdict', { verdict: 'fair' }],
    ['no reason', { reason: undefined }],
    ['a non-string reason', { reason: 5 }],
    ['actions not a list', { actions: {} }],
    ['21 actions', { actions: Array.from({ length: 21 }, () => ({ subject: 'x', kind: 'note', durationMs: null, rule: 1 })) }],
    ['a bad reportId', { reportId: 'a b' }],
    ['a missing reportId', { reportId: undefined }],
    ['an action with no duration', { actions: [{ subject: 'x', kind: 'chat', rule: 1 }] }],
    ['a zero duration', { actions: [{ subject: 'x', kind: 'chat', durationMs: 0, rule: 1 }] }],
    ['a negative duration', { actions: [{ subject: 'x', kind: 'chat', durationMs: -5, rule: 1 }] }],
    ['a fractional duration', { actions: [{ subject: 'x', kind: 'chat', durationMs: 1.5, rule: 1 }] }],
    ['a duration over the 365 day cap', { actions: [{ subject: 'x', kind: 'chat', durationMs: MAX_SANCTION_DURATION_MS + 1, rule: 1 }] }],
    ['an unknown kind', { actions: [{ subject: 'x', kind: 'exile', durationMs: 5, rule: 1 }] }],
    ['a bad rule', { actions: [{ subject: 'x', kind: 'chat', durationMs: 5, rule: 0 }] }],
  ])('%s is 400 and applies nothing', async (_n, over) => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    const body = decideBody(reportId, target);
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete (body.input as Record<string, unknown>)[k];
      else (body.input as Record<string, unknown>)[k] = v;
    }
    // The subject placeholder 'x' stands for the report's target.
    if (Array.isArray(body.input.actions)) body.input.actions = body.input.actions.map((a: Record<string, unknown>) => (a.subject === 'x' ? { ...a, subject: target } : a));
    const res = await s.post(body);
    expect(res.status).toBe(400);
    expect(s.sanctionRows()).toHaveLength(0);
    expect(s.cw.reports.get(reportId)?.status).toBe('open');
  });

  it('an action naming someone not on the report is 400', async () => {
    const s = await setup();
    const { reportId } = await s.filed();
    const stranger = s.w.person();
    const res = await s.post(decideBody(reportId, stranger));
    expect(res.status).toBe(400);
    expect(s.sanctionRows()).toHaveLength(0);
  });

  it('a decision with no actions needs no sanction permission', async () => {
    const s = await setup({ hook: { permissions: { 'sanctions.apply': 'owner' } } });
    const { reportId } = await s.filed();
    const res = await s.post(decideBody(reportId, 'unused', { verdict: 'no_action', actions: [] }));
    expect(res.status).toBe(200);
  });

  describe('permissions are the admin routes\' own, at the configured role', () => {
    const permanentBan = (target: string) => [{ subject: target, kind: 'ban', durationMs: null, rule: 1 }];

    it('a moderator-role webhook cannot permanently ban: 403, nothing applied, the report stays open', async () => {
      const s = await setup();
      const { reportId, target } = await s.filed();
      const res = await s.post(decideBody(reportId, target, { actions: permanentBan(target) }));
      expect(res.status).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
      expect(s.sanctionRows()).toHaveLength(0);
      expect(s.cw.reports.get(reportId)?.status).toBe('open');
      expect(s.w.routeAudit()).toEqual([]);
    });

    it('a moderator can still ban for a fixed time; a senior can ban permanently', async () => {
      const s = await setup();
      const a = await s.filed();
      expect((await s.post(decideBody(a.reportId, a.target, { actions: [{ subject: a.target, kind: 'ban', durationMs: DAY, rule: 1 }] }))).status).toBe(200);
      const senior = await setup({ hook: { role: 'senior' } });
      const b = await senior.filed();
      const res = await senior.post(decideBody(b.reportId, b.target, { actions: permanentBan(b.target) }));
      expect(res.status).toBe(200);
      expect(senior.w.routeAudit()[0]).toMatchObject({ actor: ACTOR, role: 'senior' });
      expect(senior.sanctionRows()[0]).toMatchObject({ kind: 'ban', ends_at: null });
    });

    it('a duration over the cap cannot dodge the permanent-ban check', async () => {
      const s = await setup();
      const { reportId, target } = await s.filed();
      const res = await s.post(decideBody(reportId, target, { actions: [{ subject: target, kind: 'ban', durationMs: MAX_SANCTION_DURATION_MS * 1000, rule: 1 }] }));
      expect(res.status).toBe(400);
      expect(s.sanctionRows()).toHaveLength(0);
    });

    it('permission overrides apply: sanctions.apply raised to senior blocks a moderator webhook with actions', async () => {
      const s = await setup({ hook: { permissions: { 'sanctions.apply': 'senior' } } });
      const { reportId, target } = await s.filed();
      const res = await s.post(decideBody(reportId, target));
      expect(res.status).toBe(403);
      expect(s.sanctionRows()).toHaveLength(0);
    });

    it('reports.decide raised above the role blocks every decision', async () => {
      const s = await setup({ hook: { permissions: { 'reports.decide': 'owner' } } });
      const { reportId, target } = await s.filed();
      const res = await s.post(decideBody(reportId, target, { verdict: 'no_action', actions: [] }));
      expect(res.status).toBe(403);
      expect(s.cw.reports.get(reportId)?.status).toBe('open');
    });

    it('the base permission is checked before the input is read (a 403 for a forbidden role even with a bad input)', async () => {
      const s = await setup({ hook: { permissions: { 'reports.decide': 'owner' } } });
      const res = await s.post({ action: 'decide', input: { nonsense: true } });
      expect(res.status).toBe(403);
    });
  });

  it('idempotencyKey is optional for a decide; an invalid one is still 400 and a valid one is not stored', async () => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    const bad = await s.post(decideBody(reportId, target, { idempotencyKey: 'has space' }));
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toBe('invalid_idempotency_key');
    expect(s.sanctionRows()).toHaveLength(0);
    expect((await s.post(decideBody(reportId, target, { idempotencyKey: 'dec-1' }))).status).toBe(200);
    expect(s.keyRows()).toHaveLength(0);
  });

  it('an audit failure after the decision is logged, never turned into an error', async () => {
    const s = await setup({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const { reportId, target } = await s.filed();
    expect((await s.post(decideBody(reportId, target))).status).toBe(200);
    expect(s.logged.map(([e]) => e)).toContain('chatwarden.http_audit_failed');
  });
});

describe('action: sanction', () => {
  it('applies it as the configured actor, audits it, and answers the group id and ref code', async () => {
    const s = await setup();
    const subject = s.w.person();
    const res = await s.post(sanctionBody(subject, 'k-1', { actor: 'evil', source: 'api' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupId: expect.any(String), refCode: expect.any(String) });
    const rows = s.sanctionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: ACTOR, source: 'moderator', kind: 'chat', automated: 0, reason: PRIVATE_REASON });
    expect(s.w.routeAudit()).toEqual([
      expect.objectContaining({
        actor: ACTOR,
        role: 'moderator',
        action: 'sanction.apply',
        target: { type: 'sanction', ref: (res.body as { groupId: string }).groupId },
      }),
    ]);
    expect(JSON.stringify(s.w.audit())).not.toContain(PRIVATE_REASON);
  });

  describe('the idempotency key', () => {
    it.each([
      ['missing', undefined],
      ['null', null],
      ['a number', 5],
      ['an object', {}],
      ['an array', ['a']],
      ['empty', ''],
      ['65 characters', 'k'.repeat(65)],
      ['a space', 'has space'],
      ['a slash', 'a/b'],
      ['a newline', 'a\nb'],
      ['non-ASCII', 'clé'],
      ['a quote', "a'b"],
      ['a percent', 'a%20b'],
      ['a plus', 'a+b'],
    ])('%s is 400 invalid_idempotency_key, and applies nothing', async (_n, key) => {
      const s = await setup();
      const subject = s.w.person();
      const body = sanctionBody(subject, key);
      if (key === undefined) delete (body.input as Record<string, unknown>).idempotencyKey;
      const res = await s.post(body);
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('invalid_idempotency_key');
      expect(s.sanctionRows()).toHaveLength(0);
      expect(s.keyRows()).toHaveLength(0);
    });

    it.each(['a', 'k'.repeat(64), 'A-Z_a.z:0-9', 'order-2026.11.09:retry_1', '...', '-', '0'])('%j is accepted', async (key) => {
      const s = await setup();
      const res = await s.post(sanctionBody(s.w.person(), key));
      expect(res.status).toBe(200);
      expect(s.keyRows()).toHaveLength(1);
      expect(s.keyRows()[0]?.key).toBe(key);
    });

    it('the same key returns the first result and applies once', async () => {
      const s = await setup();
      const subject = s.w.person();
      const first = await s.post(sanctionBody(subject, 'dup'));
      const second = await s.post(sanctionBody(subject, 'dup'));
      const third = await s.post(sanctionBody(subject, 'dup'));
      expect(first.status).toBe(200);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(s.sanctionRows()).toHaveLength(1);
      expect(s.w.routeAudit()).toHaveLength(1);
      expect(s.events.filter((e) => e.type === 'sanction.applied')).toHaveLength(1);
    });

    it('different keys apply separately', async () => {
      const s = await setup();
      const subject = s.w.person();
      const a = await s.post(sanctionBody(subject, 'one'));
      const b = await s.post(sanctionBody(subject, 'two'));
      expect((a.body as { groupId: string }).groupId).not.toBe((b.body as { groupId: string }).groupId);
      expect(s.sanctionRows()).toHaveLength(2);
    });

    it('keys are case sensitive', async () => {
      const s = await setup();
      const subject = s.w.person();
      await s.post(sanctionBody(subject, 'Key'));
      await s.post(sanctionBody(subject, 'key'));
      expect(s.sanctionRows()).toHaveLength(2);
    });

    it('the stored row is done and holds the response body only: no text', async () => {
      const s = await setup();
      const res = await s.post(sanctionBody(s.w.person(), 'stored', { gapNote: undefined }));
      const rows = s.keyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'stored', state: 'done' });
      expect(JSON.parse(String(rows[0]?.result_json))).toEqual(res.body);
      expect(Object.keys(JSON.parse(String(rows[0]?.result_json))).sort()).toEqual(['groupId', 'refCode']);
      expect(String(rows[0]?.result_json)).not.toContain(PRIVATE_REASON);
    });

    it('a key is free again after 24 hours', async () => {
      const s = await setup();
      const subject = s.w.person();
      await s.post(sanctionBody(subject, 'daily'));
      // `post` moved the clock on one second; this puts the next request exactly 24 hours after the first.
      s.w.clock.t += DAY - 1000;
      expect((await s.post(sanctionBody(subject, 'daily'))).status).toBe(200);
      expect(s.sanctionRows()).toHaveLength(1);
      await s.post(sanctionBody(subject, 'daily'));
      expect(s.sanctionRows()).toHaveLength(2);
    });

    it('purge removes keys older than 24 hours', async () => {
      const s = await setup();
      await s.post(sanctionBody(s.w.person(), 'purged'));
      s.w.clock.t += DAY + 1;
      const res = await s.cw.purge();
      expect(res.webhookKeys).toBe(1);
      expect(s.keyRows()).toHaveLength(0);
    });
  });

  describe('a request that does not go through does not take the key', () => {
    it('an invalid sanction (400) leaves the key free', async () => {
      const s = await setup();
      const subject = s.w.person();
      expect((await s.post(sanctionBody(subject, 'free', { kind: 'exile' }))).status).toBe(400);
      expect(s.keyRows()).toHaveLength(0);
      expect((await s.post(sanctionBody(subject, 'free'))).status).toBe(200);
      expect(s.sanctionRows()).toHaveLength(1);
    });

    it('a refused permanent ban (403) leaves the key free', async () => {
      const s = await setup();
      const subject = s.w.person();
      const res = await s.post(sanctionBody(subject, 'free2', { kind: 'ban', durationMs: null }));
      expect(res.status).toBe(403);
      expect(s.keyRows()).toHaveLength(0);
      expect(s.sanctionRows()).toHaveLength(0);
    });

    it('a sanction the core refuses (SanctionError, 400) is caught before the key is taken, so the corrected retry applies', async () => {
      const s = await setup();
      const subject = s.w.person();
      // A warning must have a null duration: the core would refuse this; it is checked before the reserve.
      const refused = await s.post(sanctionBody(subject, 'fix', { kind: 'warning', durationMs: HOUR }));
      expect(refused.status).toBe(400);
      expect(s.keyRows()).toHaveLength(0);
      const fixed = await s.post(sanctionBody(subject, 'fix', { kind: 'warning', durationMs: null }));
      expect(fixed.status).toBe(200);
      expect(s.sanctionRows()).toHaveLength(1);
    });

    it('a store failure while applying (500) releases the key; the retry applies exactly once', async () => {
      let fail = true;
      const s = await setup({
        wrap: (cw) => ({
          ...cw,
          sanctions: {
            ...cw.sanctions,
            apply: (input) => {
              if (fail) return Promise.reject(new Error('disk on fire PRIVATE-STORE-DETAIL'));
              return cw.sanctions.apply(input);
            },
          },
        }),
      });
      const subject = s.w.person();
      const first = await s.post(sanctionBody(subject, 'retry'));
      expect(first.status).toBe(500);
      expect(first.body).toEqual({ error: 'internal' });
      expect(s.keyRows()).toHaveLength(0);
      expect(JSON.stringify(s.logged)).not.toContain('PRIVATE-STORE-DETAIL');
      fail = false;
      const second = await s.post(sanctionBody(subject, 'retry'));
      expect(second.status).toBe(200);
      expect(s.sanctionRows()).toHaveLength(1);
      const third = await s.post(sanctionBody(subject, 'retry'));
      expect(third).toEqual(second);
      expect(s.sanctionRows()).toHaveLength(1);
    });
  });

  describe('permissions are the admin route\'s own', () => {
    it('a moderator-role webhook cannot permanently ban (403); a fixed-time ban is fine', async () => {
      const s = await setup();
      const subject = s.w.person();
      const res = await s.post(sanctionBody(subject, 'ban-1', { kind: 'ban', durationMs: null }));
      expect(res.status).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
      expect((await s.post(sanctionBody(subject, 'ban-2', { kind: 'ban', durationMs: DAY }))).status).toBe(200);
      expect(s.sanctionRows()).toHaveLength(1);
    });

    it('a senior-role webhook can; the audit row says senior', async () => {
      const s = await setup({ hook: { role: 'senior' } });
      const res = await s.post(sanctionBody(s.w.person(), 'ban-3', { kind: 'ban', durationMs: null }));
      expect(res.status).toBe(200);
      expect(s.sanctionRows()[0]).toMatchObject({ kind: 'ban', ends_at: null, actor: ACTOR });
      expect(s.w.routeAudit()[0]).toMatchObject({ role: 'senior', action: 'sanction.apply' });
    });

    it('an override can lift the permanent ban to owner, or lower it to moderator', async () => {
      const owner = await setup({ hook: { role: 'senior', permissions: { 'sanctions.apply.ban_permanent': 'owner' } } });
      expect((await owner.post(sanctionBody(owner.w.person(), 'o', { kind: 'ban', durationMs: null }))).status).toBe(403);
      const lowered = await setup({ hook: { permissions: { 'sanctions.apply.ban_permanent': 'moderator' } } });
      expect((await lowered.post(sanctionBody(lowered.w.person(), 'l', { kind: 'ban', durationMs: null }))).status).toBe(200);
    });

    it('sanctions.apply above the role is 403 for every sanction', async () => {
      const s = await setup({ hook: { permissions: { 'sanctions.apply': 'senior' } } });
      const res = await s.post(sanctionBody(s.w.person(), 'nope'));
      expect(res.status).toBe(403);
      expect(s.keyRows()).toHaveLength(0);
    });
  });

  describe('validation is the admin route\'s own', () => {
    it.each([
      ['a duration over the cap', { durationMs: MAX_SANCTION_DURATION_MS + 1 }],
      ['no duration', { durationMs: undefined }],
      ['a zero duration', { durationMs: 0 }],
      ['lineIds (a decision\'s)', { lineIds: ['l1'] }],
      ['a bad subject', { subject: 'a b' }],
      ['no subject', { subject: undefined }],
      ['a rule that does not exist', { rule: 9999 }],
      ['an unknown kind', { kind: 'exile' }],
      ['a reason over 2000 characters', { reason: 'r'.repeat(2001) }],
      ['an uncovered rule with no gap note', { rule: 'uncovered' }],
    ])('%s is 400', async (_n, over) => {
      const s = await setup();
      const body = sanctionBody(s.w.person(), 'v', over);
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete (body.input as Record<string, unknown>)[k];
      const res = await s.post(body);
      expect(res.status).toBe(400);
      expect(s.sanctionRows()).toHaveLength(0);
      expect(s.keyRows()).toHaveLength(0);
    });

    it('an uncovered rule with a gap note applies and opens a gap', async () => {
      const s = await setup();
      const res = await s.post(sanctionBody(s.w.person(), 'gap-1', { rule: 'uncovered', gapNote: 'Griefing the exit.' }));
      expect(res.status).toBe(200);
      expect(s.cw.gaps.list()).toHaveLength(1);
    });
  });

  describe('the same key with a different request is refused', () => {
    const MISMATCH = { error: 'idempotency_mismatch', message: 'This idempotency key was used with a different request.' };

    it('done: 409 idempotency_mismatch with a fixed body; the first result is not returned and nothing is applied', async () => {
      const s = await setup();
      const first = await s.post(sanctionBody(s.w.person(), 'reuse'));
      expect(first.status).toBe(200);
      const other = await s.post(sanctionBody(s.w.person(), 'reuse'));
      expect(other.status).toBe(409);
      expect(other.body).toEqual(MISMATCH);
      expect(s.sanctionRows()).toHaveLength(1);
      expect(s.keyRows()).toHaveLength(1);
      expect(JSON.parse(String(s.keyRows()[0]?.result_json))).toEqual(first.body);
    });

    it.each([
      ['another kind', { kind: 'area' }],
      ['another duration', { durationMs: 2 * HOUR }],
      ['a warning instead', { kind: 'warning', durationMs: null }],
      ['another rule', { rule: 2 }],
      ['another reason', { reason: 'a different reason' }],
      ['includeIp', { includeIp: true }],
      ['an uncovered rule with a gap note', { rule: 'uncovered', gapNote: 'Something the rules miss.' }],
    ])('%s is a mismatch', async (_n, over) => {
      const s = await setup();
      const subject = s.w.person();
      await s.post(sanctionBody(subject, 'k'));
      const res = await s.post(sanctionBody(subject, 'k', over));
      expect(res.status).toBe(409);
      expect(errorOf(res)).toBe('idempotency_mismatch');
      expect(s.sanctionRows()).toHaveLength(1);
    });

    it('another subject is a mismatch', async () => {
      const s = await setup();
      await s.post(sanctionBody(s.w.person(), 'k'));
      const res = await s.post(sanctionBody(s.w.person(), 'k'));
      expect(errorOf(res)).toBe('idempotency_mismatch');
    });

    it('the same request written differently (key order, whitespace, defaults spelled out) is the same request', async () => {
      const s = await setup();
      const subject = s.w.person();
      const first = await s.post(sanctionBody(subject, 'same'));
      const reordered = `{ "action":"sanction",\n"input":{"idempotencyKey":"same","includeIp":false,"rule":1,"reason":"${PRIVATE_REASON}","durationMs":${HOUR},"kind":"chat","subject":"${subject}","extra":"ignored"}}`;
      const again = await s.post(reordered);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect(s.sanctionRows()).toHaveLength(1);
    });

    it('a mismatch is also refused while the first request is still running in this process', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const s = await setup({
        wrap: (cw) => ({
          ...cw,
          sanctions: {
            ...cw.sanctions,
            apply: async (i) => {
              await gate;
              return cw.sanctions.apply(i);
            },
          },
        }),
      });
      const a = s.w.person();
      const b = s.w.person();
      const first = s.hook(s.req(sanctionBody(a, 'busy')));
      s.w.clock.t += 1000;
      const second = await s.hook(s.req(sanctionBody(b, 'busy')));
      expect(second.status).toBe(409);
      expect(errorOf(second)).toBe('idempotency_mismatch');
      release();
      expect((await first).status).toBe(200);
      expect(s.sanctionRows()).toHaveLength(1);
    });

    it('pending in another process: the same request is in_progress, a different one is idempotency_mismatch', async () => {
      const s = await setup();
      const subject = s.w.person();
      const body = sanctionBody(subject, 'theirs');
      s.cw.webhookKeys.reserve('theirs', sanctionFingerprint(parseSanction(body.input)));
      expect(errorOf(await s.post(body))).toBe('in_progress');
      expect(errorOf(await s.post(sanctionBody(s.w.person(), 'theirs')))).toBe('idempotency_mismatch');
    });

    it('stores a SHA-256 fingerprint (hex) and no text in the key row', async () => {
      const s = await setup();
      await s.post(sanctionBody(s.w.person(), 'fp'));
      const row = s.keyRows()[0] as Record<string, unknown>;
      expect(String(row.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(PRIVATE_REASON);
    });

    it('the fingerprint is stable and depends on every field of the validated sanction', () => {
      const base = { subject: 'a', kind: 'chat', durationMs: 5, rule: 1, reason: 'r' };
      const fp = (over: Record<string, unknown> = {}) => sanctionFingerprint(parseSanction({ ...base, ...over }));
      expect(fp()).toBe(fp());
      expect(fp()).toBe(fp({ includeIp: false, idempotencyKey: 'ignored', unknown: 1 }));
      const all = new Set([
        fp(),
        fp({ subject: 'b' }),
        fp({ kind: 'area' }),
        fp({ durationMs: 6 }),
        fp({ rule: 2 }),
        fp({ reason: 's' }),
        fp({ includeIp: true }),
        fp({ rule: 'uncovered', gapNote: 'n' }),
      ]);
      expect(all.size).toBe(8);
    });
  });

  describe('a bad request never takes a key: pure validation runs before reserve', () => {
    function counting() {
      const calls = { reserve: 0 };
      const wrap = (cw: Chatwarden): Chatwarden => ({
        ...cw,
        webhookKeys: {
          ...cw.webhookKeys,
          reserve: (k, f) => {
            calls.reserve++;
            return cw.webhookKeys.reserve(k, f);
          },
        },
      });
      return { calls, wrap };
    }

    it.each([
      ['a rule that is not citable', { rule: 9999 }],
      ['a warning with a duration (core SanctionError)', { kind: 'warning', durationMs: HOUR }],
      ['a note with a duration (core SanctionError)', { kind: 'note', durationMs: HOUR }],
      ['a warning with includeIp (core SanctionError)', { kind: 'warning', durationMs: null, includeIp: true }],
      ['an uncovered rule with no gap note (core SanctionError)', { rule: 'uncovered' }],
      ['a gap note with a numbered rule (core SanctionError)', { gapNote: 'not allowed here' }],
      ['an over-long gap note (core SanctionError)', { rule: 'uncovered', gapNote: 'g'.repeat(501) }],
    ])('%s: 400, reserve is never called', async (_n, over) => {
      const c = counting();
      const s = await setup({ wrap: c.wrap });
      const res = await s.post(sanctionBody(s.w.person(), 'pure', over));
      expect(res.status).toBe(400);
      expect(c.calls.reserve).toBe(0);
      expect(s.keyRows()).toHaveLength(0);
    });

    it('a permanent ban the role may not do (403) never reserves either', async () => {
      const c = counting();
      const s = await setup({ wrap: c.wrap });
      expect((await s.post(sanctionBody(s.w.person(), 'p2', { kind: 'ban', durationMs: null }))).status).toBe(403);
      expect(c.calls.reserve).toBe(0);
    });

    it('a valid request reserves exactly once', async () => {
      const c = counting();
      const s = await setup({ wrap: c.wrap });
      expect((await s.post(sanctionBody(s.w.person(), 'good'))).status).toBe(200);
      expect(c.calls.reserve).toBe(1);
    });
  });

  describe('concurrency', () => {
    function slow() {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      let failWith: Error | null = null;
      const wrap = (cw: Chatwarden): Chatwarden => ({
        ...cw,
        sanctions: {
          ...cw.sanctions,
          apply: async (input) => {
            calls++;
            await gate;
            if (failWith !== null) throw failWith;
            return cw.sanctions.apply(input);
          },
        },
      });
      return { wrap, release: () => release(), calls: () => calls, failWith: (e: Error) => (failWith = e) };
    }
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

    it('two simultaneous requests with one key share one apply and one answer', async () => {
      const g = slow();
      const s = await setup({ wrap: g.wrap });
      const subject = s.w.person();
      const first = s.hook(s.req(sanctionBody(subject, 'race')));
      s.w.clock.t += 1000;
      const second = s.hook(s.req(sanctionBody(subject, 'race')));
      await flush();
      expect(g.calls()).toBe(1);
      g.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b).toEqual(a);
      expect(g.calls()).toBe(1);
      expect(s.sanctionRows()).toHaveLength(1);
      expect(s.w.routeAudit()).toHaveLength(1);
      expect(s.keyRows()[0]).toMatchObject({ state: 'done' });
    });

    it('a request that finds the key pending with no apply in this process is 409 in_progress', async () => {
      const s = await setup();
      const subject = s.w.person();
      const body = sanctionBody(subject, 'elsewhere');
      const fp = sanctionFingerprint(parseSanction(body.input));
      expect(s.cw.webhookKeys.reserve('elsewhere', fp)).toEqual({ reserved: true }); // another process holds it
      const res = await s.post(body);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toBe('in_progress');
      expect(s.sanctionRows()).toHaveLength(0);
      // Once the other process finishes, the stored result is returned.
      s.cw.webhookKeys.complete('elsewhere', '{"groupId":"g-other","refCode":"RC-OTHER"}');
      const done = await s.post(body);
      expect(done.status).toBe(200);
      expect(done.body).toEqual({ groupId: 'g-other', refCode: 'RC-OTHER' });
      expect(s.sanctionRows()).toHaveLength(0);
    });

    it('if the shared apply fails, both callers fail, the key is released and a retry applies once', async () => {
      const g = slow();
      g.failWith(new Error('apply failed'));
      const s = await setup({ wrap: g.wrap });
      const subject = s.w.person();
      const first = s.hook(s.req(sanctionBody(subject, 'boom')));
      s.w.clock.t += 1000;
      const second = s.hook(s.req(sanctionBody(subject, 'boom')));
      await flush();
      g.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(500);
      expect(b.status).toBe(500);
      expect(s.keyRows()).toHaveLength(0);
      expect(s.sanctionRows()).toHaveLength(0);
    });

    it('different keys do not wait for each other', async () => {
      const g = slow();
      const s = await setup({ wrap: g.wrap });
      const a = s.hook(s.req(sanctionBody(s.w.person(), 'k-a')));
      s.w.clock.t += 1000;
      const b = s.hook(s.req(sanctionBody(s.w.person(), 'k-b')));
      await flush();
      expect(g.calls()).toBe(2);
      g.release();
      await Promise.all([a, b]);
      expect(s.sanctionRows()).toHaveLength(2);
    });
  });

  it('a failure to store the result after the sanction is live is logged and the answer stands; the key stays pending (no double apply)', async () => {
    const s = await setup({
      wrap: (cw) => ({
        ...cw,
        webhookKeys: {
          ...cw.webhookKeys,
          complete: () => {
            throw new Error('store down');
          },
        },
      }),
    });
    const subject = s.w.person();
    const res = await s.post(sanctionBody(subject, 'half'));
    expect(res.status).toBe(200);
    expect(s.logged.map(([e]) => e)).toContain('chatwarden.webhook_key_failed');
    const retry = await s.post(sanctionBody(subject, 'half'));
    expect(retry.status).toBe(409);
    expect(s.sanctionRows()).toHaveLength(1);
  });

  it('an audit failure after the sanction is logged, never turned into an error', async () => {
    const s = await setup({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    expect((await s.post(sanctionBody(s.w.person(), 'aud'))).status).toBe(200);
    expect(s.logged.map(([e]) => e)).toContain('chatwarden.http_audit_failed');
  });
});

describe('logging and a shared replay cache', () => {
  it('logs no secret, key or body text on any path', async () => {
    const s = await setup();
    const { reportId, target } = await s.filed();
    await s.post(decideBody(reportId, target));
    await s.post(sanctionBody(s.w.person(), 'LOGGED-KEY-ABC'));
    await s.post('garbage', {});
    await s.post(sanctionBody(s.w.person(), 'x'), { secret: 'q'.repeat(40) });
    const text = JSON.stringify(s.logged);
    for (const forbidden of [SECRET, 'LOGGED-KEY-ABC', PRIVATE_REASON, ACTOR]) expect(text).not.toContain(forbidden);
  });

  it('two webhookIn routes can share a ReplayCache', async () => {
    const replay = new ReplayCache();
    const a = await setup({ hook: { replay } });
    const subject = a.w.person();
    const r = a.req(sanctionBody(subject, 'shared'));
    expect((await a.send(r)).status).toBe(200);
    expect((await a.send(r)).status).toBe(401);
    expect(replay.size).toBe(1);
  });
});
