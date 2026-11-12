import { afterEach, describe, expect, it, vi } from 'vitest';
import { keysDeep } from './world.js';
import { ALICE, BOB, bodyOf, CAROL, errorOf, HOUR, identifyFromHeaders, playerWorld, RAW_VALUES } from './playerWorld.js';
import type { PlayerWorld } from './playerWorld.js';

// The player's appeal routes: GET /appeals, POST /appeals, and the request limiter in front of the second. Appeals are off until turned on:
// then every answer is 404 not_found, as if the route did not exist.

afterEach(() => vi.restoreAllMocks());

const FIELDS = ['createdAt', 'decidedAt', 'id', 'noticeId', 'status'];
const SUBJECT_RE = /s_[A-Za-z0-9_-]{22}/;
const FORBIDDEN_KEYS = ['ip', 'ipHash', 'keyHash', 'hash', 'roomId', 'groupId', 'actor', 'reason', 'subject', 'person', 'decidedBy', 'decided', 'sanction', 'statement', 'clientKey', 'accountId', 'staff', 'reportId'];

const file = (w: PlayerWorld, who: typeof ALICE | undefined, noticeId: unknown, statement: unknown = 'I did not do this.') =>
  w.call('POST', '/appeals', { ...(who === undefined ? {} : { who }), body: { noticeId, statement } });

/** Fails when a response carries an identifier, a raw credential or a staff-only field. */
function expectNoLeak(res: { status: number; headers?: Record<string, string> | undefined; body?: unknown }): void {
  const text = JSON.stringify(res);
  expect(text).not.toMatch(SUBJECT_RE);
  expect(text).not.toMatch(/\b[0-9a-f]{32,}\b/);
  for (const v of RAW_VALUES) expect(text).not.toContain(v);
  for (const v of ['private moderator reason text', 'mod_ann', 'I did not do this']) expect(text).not.toContain(v);
  const keys = keysDeep(res.body);
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `key ${k}`).toBe(false);
}

describe('the route table', () => {
  it('holds the eight player routes, appeals on or off (a hub can turn them on at runtime)', async () => {
    for (const appeals of [{}, false] as const) {
      const w = await playerWorld({ appeals });
      expect(Object.keys(w.routes).sort()).toEqual([
        'GET /appeals',
        'GET /code-of-conduct',
        'GET /notices',
        'GET /record',
        'GET /rules',
        'POST /appeals',
        'POST /names/check',
        'POST /notices/:id/ack',
      ]);
    }
  });

  it('other methods on /appeals are 405 with allow', async () => {
    const w = await playerWorld();
    expect((await w.call('PUT', '/appeals', { who: ALICE })).status).toBe(405);
    expect((await w.call('DELETE', '/appeals', { who: ALICE })).status).toBe(405);
    expect((await w.call('PUT', '/appeals')).headers?.allow).toBe('GET, HEAD, POST');
  });
});

describe('GET returns only documented fields (id, noticeId, status, createdAt, decidedAt); empty for an unknown identity; 404 when off', () => {
  it('lists the caller\'s own appeals with exactly the documented fields, newest first', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanction(ALICE);
    const a2 = await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    const first = bodyOf(await file(w, ALICE, a.noticeId)).appeal as { id: string };
    w.clock.t += 1000;
    const second = bodyOf(await file(w, ALICE, a2.noticeId)).appeal as { id: string };
    const res = await w.call('GET', '/appeals', { who: ALICE });
    expect(res.status).toBe(200);
    const list = bodyOf(res).appeals as Array<Record<string, unknown>>;
    expect(Object.keys(bodyOf(res))).toEqual(['appeals']);
    expect(list.map((x) => x.id)).toEqual([second.id, first.id]);
    for (const item of list) expect(Object.keys(item).sort()).toEqual(FIELDS);
    expect(list[1]).toEqual({ id: first.id, noticeId: a.noticeId, status: 'open', createdAt: expect.any(Number), decidedAt: null });
    expectNoLeak(res);
  });

  it('shows the outcome and the decision time, never the reason', async () => {
    const w = await playerWorld();
    const a = await w.sanction(ALICE);
    const filed = bodyOf(await file(w, ALICE, a.noticeId)).appeal as { id: string };
    w.clock.t += HOUR;
    const done = await w.cw.appeals.decide({ appealId: filed.id, outcome: 'revoke', actor: 'senior_bea', reason: 'private moderator reason text' });
    expect(done.ok).toBe(true);
    const res = await w.call('GET', '/appeals', { who: ALICE });
    expect(bodyOf(res).appeals).toEqual([{ id: filed.id, noticeId: a.noticeId, status: 'revoked', createdAt: expect.any(Number), decidedAt: w.clock.t }]);
    expectNoLeak(res);
  });

  it('only the caller\'s own: another player sees none of them', async () => {
    const w = await playerWorld();
    const a = await w.sanction(ALICE);
    await file(w, ALICE, a.noticeId);
    expect(bodyOf(await w.call('GET', '/appeals', { who: BOB })).appeals).toEqual([]);
    expect(bodyOf(await w.call('GET', '/appeals', { who: ALICE })).appeals).toHaveLength(1);
  });

  it('is an empty list for an unknown, IP-only and empty identity (still 200)', async () => {
    const w = await playerWorld();
    for (const who of [CAROL, { ip: '198.51.100.9' }, {}, { clientKey: '', accountId: '' }, undefined]) {
      const res = await w.call('GET', '/appeals', who === undefined ? {} : { who });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ appeals: [] });
    }
  });

  it('is 404 not_found with appeals off, for a known and an unknown caller alike, the same body as an unknown path would give', async () => {
    const w = await playerWorld({ appeals: false });
    const a = await w.sanction(ALICE);
    for (const who of [ALICE, BOB, undefined]) {
      const res = await w.call('GET', '/appeals', who === undefined ? {} : { who });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
    }
    expect(a.noticeId).toBeTruthy();
  });

  it('with appeals off the hook is not asked who the caller is: nothing is called for either route, and the answer is the same 404', async () => {
    const identify = vi.fn(identifyFromHeaders);
    const w = await playerWorld({ appeals: false, routes: { identify } });
    const answers: unknown[] = [];
    for (const who of [ALICE, undefined]) {
      for (const res of [
        await w.call('GET', '/appeals', who === undefined ? {} : { who }),
        await w.call('POST', '/appeals', { ...(who === undefined ? {} : { who }), body: { noticeId: 'x', statement: 'y' } }),
        await w.call('POST', '/appeals', { ...(who === undefined ? {} : { who }), raw: '{not json' }),
        await w.call('GET', '/appeals', { headers: { 'x-identify': 'throw' } }),
      ]) {
        expect(res.status).toBe(404);
        answers.push(JSON.stringify([res.status, res.headers, res.body]));
      }
    }
    expect(identify).not.toHaveBeenCalled();
    expect(new Set(answers).size).toBe(1);
    expect(w.logged).toEqual([]);
  });

  it('control: with appeals on the hook is called once per request, and turning them on later starts calling it', async () => {
    const identify = vi.fn(identifyFromHeaders);
    const w = await playerWorld({ appeals: { enabled: false }, routes: { identify } });
    await w.call('GET', '/appeals', { who: ALICE });
    expect(identify).not.toHaveBeenCalled();
    w.cw.policy.save({ appeals: { enabled: true } }, { version: 0, actor: 'owner', reason: 'turn them on' });
    await w.call('GET', '/appeals', { who: ALICE });
    await w.call('POST', '/appeals', { who: ALICE, body: { noticeId: 'x', statement: 'y' } });
    expect(identify).toHaveBeenCalledTimes(2);
  });

  it('is 404 when the profile has appeals enabled: false explicitly, and live when turned on later', async () => {
    const w = await playerWorld({ appeals: { enabled: false } });
    expect((await w.call('GET', '/appeals', { who: ALICE })).status).toBe(404);
    w.cw.policy.save({ appeals: { enabled: true } }, { version: 0, actor: 'owner', reason: 'turn them on' });
    expect((await w.call('GET', '/appeals', { who: ALICE })).status).toBe(200);
  });

  it('a failing identify hook reads as nobody: an empty list, not an error', async () => {
    const w = await playerWorld();
    const res = await w.call('GET', '/appeals', { headers: { 'x-identify': 'throw' } });
    expect(res.status).toBe(200);
  });

  it('copies the documented fields by name: nothing else the core might hand back reaches the player', async () => {
    const w = await playerWorld({
      wrap: (cw) => ({
        ...cw,
        appeals: {
          ...cw.appeals,
          mine: () => [{ id: 'a1', noticeId: 'n1', status: 'open', createdAt: 5, decidedAt: null, person: 's_leak', reason: 'secret', groupId: 'g1' }],
        },
      }),
    });
    const res = await w.call('GET', '/appeals', { who: ALICE });
    expect(res.body).toEqual({ appeals: [{ id: 'a1', noticeId: 'n1', status: 'open', createdAt: 5, decidedAt: null }] });
  });
});

describe('POST: 200, 400, 404 for off, someone else\'s notice and a bad id with identical bodies, 409, 429 with retry-after', () => {
  it('200 { appeal } with the documented fields; the appeal is then on the list', async () => {
    const w = await playerWorld();
    const a = await w.sanction(ALICE);
    const res = await file(w, ALICE, a.noticeId, '  I was joking with a friend.  ');
    expect(res.status).toBe(200);
    expect(Object.keys(bodyOf(res))).toEqual(['appeal']);
    const appeal = bodyOf(res).appeal as Record<string, unknown>;
    expect(Object.keys(appeal).sort()).toEqual(FIELDS);
    expect(appeal).toMatchObject({ noticeId: a.noticeId, status: 'open', decidedAt: null });
    expectNoLeak(res);
    expect(JSON.stringify(res)).not.toContain('joking');
    expect(w.cw.appeals.get(appeal.id as string)?.statement).toBe('I was joking with a friend.');
    expect((bodyOf(await w.call('GET', '/appeals', { who: ALICE })).appeals as unknown[]).length).toBe(1);
  });

  it('400 invalid_statement: empty, blank, over 1000 characters, not a string, missing', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanction(ALICE);
    const statements: unknown[] = ['', '   \n\t ', 'x'.repeat(1001), [...'y'.repeat(1001)].join(''), 5, null, ['a'], { a: 1 }, true, undefined];
    for (const s of statements) {
      const res = await w.call('POST', '/appeals', { who: ALICE, raw: JSON.stringify({ noticeId: a.noticeId, ...(s === undefined ? {} : { statement: s }) }) });
      expect(res.status, JSON.stringify(s)).toBe(400);
      expect(res.body, JSON.stringify(s)).toEqual({ error: 'invalid_statement', message: 'The statement is not valid.' });
    }
    expect(w.cw.appeals.mine(ALICE)).toEqual([]);
  });

  it('a statement of exactly 1000 characters is accepted (counted in characters, not UTF-16 units)', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanction(ALICE);
    const a2 = await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    expect((await file(w, ALICE, a.noticeId, 'x'.repeat(1000))).status).toBe(200);
    expect((await file(w, ALICE, a2.noticeId, '\u{1F600}'.repeat(1000))).status).toBe(200);
  });

  it('400 invalid_request for a body that is not a JSON object; 400 invalid_json for bad JSON; 413 for a huge body', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 20 } });
    for (const b of [[], ['x'], 'x', 7, null]) {
      const res = await w.call('POST', '/appeals', { who: ALICE, raw: JSON.stringify(b) });
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    expect(errorOf(await w.call('POST', '/appeals', { who: ALICE }))).toBe('invalid_request');
    expect(errorOf(await w.call('POST', '/appeals', { who: ALICE, raw: '{nope' }))).toBe('invalid_json');
    expect(errorOf(await w.call('POST', '/appeals', { who: ALICE, raw: '{"noticeId":"x","statement":"y","__proto__":{"a":1}}' }))).toBe('forbidden_key');
    expect((await w.call('POST', '/appeals', { who: ALICE, raw: JSON.stringify({ noticeId: 'x', statement: 'a'.repeat(70_000) }) })).status).toBe(413);
  });

  it('404 not_found is ONE answer: appeals off, someone else\'s notice, an unknown notice, a bad id, a notice that is not a sanction', async () => {
    const w = await playerWorld();
    const a = await w.sanction(ALICE);
    const bobs = await w.sanction(BOB);
    const outcomes = new Set<string>();
    const plain = (res: { status: number; headers?: Record<string, string> | undefined; body?: unknown }): string => JSON.stringify({ status: res.status, headers: res.headers, body: res.body });
    const answers: Array<[string, Awaited<ReturnType<typeof file>>]> = [
      ['someone else\'s notice', await file(w, ALICE, bobs.noticeId)],
      ['an unknown notice', await file(w, ALICE, 'nope-no-such-notice')],
      ['a bad id', await file(w, ALICE, 'bad id with spaces \u0000')],
      ['an empty id', await file(w, ALICE, '')],
      ['a huge id', await file(w, ALICE, 'n'.repeat(5000))],
      ['a number', await file(w, ALICE, 5)],
      ['null', await file(w, ALICE, null)],
      ['a missing id', await w.call('POST', '/appeals', { who: ALICE, body: { statement: 'hello' } })],
      ['an unknown caller', await file(w, CAROL, a.noticeId)],
      ['an IP-only caller', await file(w, { ip: '198.51.100.9' }, a.noticeId)],
      ['nobody', await file(w, undefined, a.noticeId)],
    ];
    for (const [label, res] of answers) {
      expect(res.status, label).toBe(404);
      outcomes.add(plain(res));
    }
    expect(outcomes.size).toBe(1);
    expect([...outcomes][0]).toBe(JSON.stringify({ status: 404, headers: { 'cache-control': 'no-store' }, body: { error: 'not_found', message: 'Not found.' } }));
    // Appeals off is the same answer again.
    const off = await playerWorld({ appeals: false });
    const o = await off.sanction(ALICE);
    expect(plain(await file(off, ALICE, o.noticeId))).toBe([...outcomes][0]);
    // A notice that is the caller's own but is not a sanction in their record (a report outcome): also not found.
    const reporter = { clientKey: 'raw-key-reporter-1-secret', ip: '198.51.100.20' };
    const outcome = (w.cw.notices.pending(reporter) as Array<{ id: string; kind: string }>).find((n) => n.kind === 'report_outcome');
    expect(outcome).toBeDefined();
    expect(plain(await file(w, reporter, (outcome as { id: string }).id))).toBe([...outcomes][0]);
    expect(w.cw.appeals.mine(ALICE)).toEqual([]);
  });

  it('the validation order is the core\'s: a notice that is not yours is 404 even with a bad statement', async () => {
    const w = await playerWorld();
    const bobs = await w.sanction(BOB);
    expect((await file(w, ALICE, bobs.noticeId, '')).status).toBe(404);
  });

  it('409 already_appealed for the same sanction again; the second statement is not kept', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanction(ALICE);
    expect((await file(w, ALICE, a.noticeId)).status).toBe(200);
    const again = await file(w, ALICE, a.noticeId, 'second try');
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'already_appealed', message: 'This has already been appealed.' });
    expect(w.cw.appeals.mine(ALICE)).toHaveLength(1);
    // Also once decided: one per sanction for its lifetime.
    const id = (w.cw.appeals.mine(ALICE)[0] as { id: string }).id;
    await w.cw.appeals.decide({ appealId: id, outcome: 'uphold', actor: 'senior_bea', reason: 'stands' });
    expect((await file(w, ALICE, a.noticeId)).status).toBe(409);
  });

  it('429 rate_limited with retry-after in whole seconds when the weekly cap is reached; the cap is the core\'s', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 1 } });
    const a = await w.sanction(ALICE);
    const a2 = await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    expect((await file(w, ALICE, a.noticeId)).status).toBe(200);
    const res = await file(w, ALICE, a2.noticeId);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    const wait = Number(res.headers?.['retry-after']);
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(7 * 24 * 3600);
    expectNoLeak(res);
    // A week on, the same appeal goes through.
    w.clock.t += 7 * 24 * HOUR + 1;
    expect((await file(w, ALICE, a2.noticeId)).status).toBe(200);
  });

  it('retry-after rounds up', async () => {
    const w = await playerWorld({
      wrap: (cw) => ({ ...cw, appeals: { ...cw.appeals, file: () => ({ ok: false, refused: 'rate', retryAfterMs: 1500 }) } }),
    });
    expect((await file(w, ALICE, 'x')).headers?.['retry-after']).toBe('2');
    const w2 = await playerWorld({
      wrap: (cw) => ({ ...cw, appeals: { ...cw.appeals, file: () => ({ ok: false, refused: 'rate', retryAfterMs: 1 }) } }),
    });
    expect((await file(w2, ALICE, 'x')).headers?.['retry-after']).toBe('1');
    const w3 = await playerWorld({
      wrap: (cw) => ({ ...cw, appeals: { ...cw.appeals, file: () => ({ ok: false, refused: 'rate' }) } }),
    });
    expect((await file(w3, ALICE, 'x')).headers?.['retry-after']).toBe('1');
    const w4 = await playerWorld({
      wrap: (cw) => ({ ...cw, appeals: { ...cw.appeals, file: () => ({ ok: false, refused: 'rate', retryAfterMs: 3_600_000 }) } }),
    });
    expect((await file(w4, ALICE, 'x')).headers?.['retry-after']).toBe('3600');
  });

  it('every refusal the core can give has an answer, and none is a 5xx: off and not_appealable read as 404', async () => {
    for (const [refused, status] of [['off', 404], ['not_found', 404], ['not_appealable', 404], ['statement_invalid', 400], ['already_appealed', 409], ['rate', 429]] as const) {
      const w = await playerWorld({ wrap: (cw) => ({ ...cw, appeals: { ...cw.appeals, file: () => ({ ok: false, refused }) } }) });
      expect((await file(w, ALICE, 'x')).status, refused).toBe(status);
    }
  });

  it('404 for a caller with appeals off even when the body is malformed or the statement is bad', async () => {
    const w = await playerWorld({ appeals: false });
    for (const raw of ['{', '[]', JSON.stringify({ noticeId: 5 }), JSON.stringify({ noticeId: 'x', statement: '' })]) {
      const res = await w.call('POST', '/appeals', { who: ALICE, raw });
      expect(res.status, raw).toBe(404);
    }
    expect((await w.call('POST', '/appeals', { who: ALICE })).status).toBe(404);
  });
});

describe('the request limiter: the 11th request in an hour is 429 even for malformed bodies; salted-hash keys; the key map is bounded', () => {
  it('allows 10 an hour per identity by default, then 429 rate_limited with retry-after, malformed bodies included', async () => {
    const w = await playerWorld();
    for (let i = 0; i < 5; i++) expect((await w.call('POST', '/appeals', { who: ALICE, raw: '{' })).status, `bad ${i + 1}`).toBe(400);
    for (let i = 5; i < 10; i++) expect((await file(w, ALICE, 'nope')).status, `call ${i + 1}`).toBe(404);
    w.clock.t += 10_000;
    const res = await w.call('POST', '/appeals', { who: ALICE, raw: '{' });
    expect(res.status).toBe(429);
    expect(res.headers?.['retry-after']).toBe(String(3590));
    expect(res.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    // Even a well-formed, valid request is refused until the window reopens.
    const a = await w.sanction(ALICE);
    expect((await file(w, ALICE, a.noticeId)).status).toBe(429);
    w.clock.t += 3_590_000;
    expect((await file(w, ALICE, a.noticeId)).status).toBe(200);
  });

  it('is per identity and does not touch the other routes or GET /appeals', async () => {
    const w = await playerWorld({ routes: { appealsRateLimit: { max: 1, windowMs: 60_000 } } });
    expect((await file(w, ALICE, 'x')).status).toBe(404);
    expect((await file(w, ALICE, 'x')).status).toBe(429);
    expect((await file(w, BOB, 'x')).status).toBe(404);
    for (const [m, p] of [['GET', '/appeals'], ['GET', '/notices'], ['GET', '/record'], ['GET', '/rules']] as const) expect((await w.call(m, p, { who: ALICE })).status, p).toBe(200);
    // and not the names check's bucket either
    expect((await w.call('POST', '/names/check', { who: ALICE, body: { name: 'fine' } })).status).toBe(200);
  });

  it('is configurable, and refuses a bad option at start-up', async () => {
    const w = await playerWorld({ routes: { appealsRateLimit: { max: 3, windowMs: 1000 } } });
    for (let i = 0; i < 3; i++) expect((await file(w, ALICE, 'x')).status).toBe(404);
    expect((await file(w, ALICE, 'x')).status).toBe(429);
    w.clock.t += 1000;
    expect((await file(w, ALICE, 'x')).status).toBe(404);
    for (const bad of [{ max: 0, windowMs: 1000 }, { max: 1.5, windowMs: 1000 }, { max: 1, windowMs: -1 }, { max: 1 }, null, 5]) {
      await expect(playerWorld({ routes: { appealsRateLimit: bad } }), JSON.stringify(bad)).rejects.toThrow(/appealsRateLimit/);
    }
  });

  it('is not counted while appeals are off (a 404 for everything), and counted once they are on', async () => {
    const w = await playerWorld({ appeals: false, routes: { appealsRateLimit: { max: 1, windowMs: 3_600_000 } } });
    for (let i = 0; i < 5; i++) expect((await file(w, ALICE, 'x')).status).toBe(404);
    w.cw.policy.save({ appeals: { enabled: true } }, { version: 0, actor: 'owner', reason: 'on' });
    expect((await file(w, ALICE, 'x')).status).toBe(404);
    expect((await file(w, ALICE, 'x')).status).toBe(429);
  });

  it('keys on accountId first, then clientKey, then ip; one shared bucket for nobody', async () => {
    const w = await playerWorld({ routes: { appealsRateLimit: { max: 1, windowMs: 60_000 } } });
    expect((await file(w, { accountId: 'acct-1', clientKey: 'k1', ip: '198.51.100.1' }, 'x')).status).toBe(404);
    expect((await file(w, { accountId: 'acct-1', clientKey: 'k2', ip: '198.51.100.2' }, 'x')).status).toBe(429);
    expect((await file(w, { clientKey: 'k3', ip: '198.51.100.3' }, 'x')).status).toBe(404);
    expect((await file(w, { clientKey: 'k3', ip: '198.51.100.4' }, 'x')).status).toBe(429);
    expect((await file(w, { ip: '198.51.100.5' }, 'x')).status).toBe(404);
    expect((await file(w, { ip: '198.51.100.5' }, 'x')).status).toBe(429);
    expect((await file(w, undefined, 'x')).status).toBe(404);
    expect((await file(w, { ip: 'unknown' }, 'x')).status).toBe(429);
  });

  it('stores only a salted SHA-256 of the identity, never the raw value, and a different salt per instance', async () => {
    const keys: string[] = [];
    const real = Map.prototype.set;
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === 'string') keys.push(k);
      return real.call(this, k, v);
    });
    const a = await playerWorld();
    const b = await playerWorld();
    keys.length = 0;
    for (const who of [ALICE, CAROL, { ip: '198.51.100.77' }, undefined]) await file(a, who, 'x');
    const first = [...keys];
    keys.length = 0;
    await file(b, ALICE, 'x');
    const second = [...keys];
    for (const k of [...first, ...second]) for (const v of [...RAW_VALUES, '198.51.100.77']) expect(k.includes(v), k).toBe(false);
    const hashes = first.filter((k) => /^[0-9a-f]{64}$/.test(k));
    expect(hashes.length).toBe(4);
    expect(new Set(hashes).size).toBe(4);
    expect(second.filter((k) => /^[0-9a-f]{64}$/.test(k))).not.toContain(hashes[0]);
  });

  it('the key map is bounded: at 10000 live keys the oldest is evicted', async () => {
    const w = await playerWorld({ routes: { appealsRateLimit: { max: 1, windowMs: 3_600_000 } } });
    expect((await file(w, { ip: '10.0.0.1' }, 'x')).status).toBe(404);
    expect((await file(w, { ip: '10.0.0.1' }, 'x')).status).toBe(429);
    for (let i = 0; i < 100; i++) await file(w, { accountId: `ctl-${i}` }, 'x');
    expect((await file(w, { ip: '10.0.0.1' }, 'x')).status).toBe(429);
    for (let i = 0; i < 10_000; i++) await file(w, { accountId: `flood-${i}` }, 'x');
    expect((await file(w, { ip: '10.0.0.1' }, 'x')).status).toBe(404);
  }, 30_000);
});

describe('the response never holds a staff ref, reason, sanction id or person id', () => {
  it('across every answer, headers included', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 1 } });
    const a = await w.sanction(ALICE);
    const a2 = await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    const bobs = await w.sanction(BOB);
    const responses = [
      await file(w, ALICE, a.noticeId),
      await file(w, ALICE, a.noticeId),
      await file(w, ALICE, a2.noticeId),
      await file(w, ALICE, bobs.noticeId),
      await file(w, ALICE, ''),
      await file(w, ALICE, a.noticeId, ''),
      await w.call('POST', '/appeals', { who: ALICE, raw: '{' }),
      await w.call('GET', '/appeals', { who: ALICE }),
      await w.call('GET', '/appeals', { who: BOB }),
    ];
    for (const res of responses) expectNoLeak(res);
    // After a decision with a private reason and a staff actor.
    const id = (w.cw.appeals.mine(ALICE)[0] as { id: string }).id;
    await w.cw.appeals.decide({ appealId: id, outcome: 'reduce', actor: 'senior_bea', reason: 'private moderator reason text', to: { kind: 'chat', durationMs: HOUR } });
    expectNoLeak(await w.call('GET', '/appeals', { who: ALICE }));
    expect(w.cw.appeals.get(id)?.status).toBe('reduced');
  });

  it('no statement, notice id or identity is logged, success or failure', async () => {
    const w = await playerWorld({ routes: { appealsRateLimit: { max: 2, windowMs: 60_000 } } });
    const a = await w.sanction(ALICE);
    await file(w, ALICE, a.noticeId, 'my private statement words');
    await file(w, ALICE, a.noticeId, 'my private statement words');
    await file(w, ALICE, a.noticeId, 'my private statement words');
    await w.call('POST', '/appeals', { who: ALICE, raw: '{' });
    await w.call('GET', '/appeals', { who: ALICE });
    const text = JSON.stringify(w.logged);
    for (const v of [...RAW_VALUES, a.noticeId, 'my private statement words']) expect(text).not.toContain(v);
  });

  it('a failure under the route is a 500 internal with nothing echoed', async () => {
    const w = await playerWorld({
      wrap: (cw) => ({
        ...cw,
        appeals: {
          ...cw.appeals,
          file: () => {
            throw new Error(`boom ${ALICE.clientKey}`);
          },
        },
      }),
    });
    const a = await w.sanction(ALICE);
    const res = await file(w, ALICE, a.noticeId, 'statement words');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(JSON.stringify(w.logged)).not.toContain(ALICE.clientKey);
    expect(JSON.stringify(w.logged)).not.toContain('statement words');
  });
});

describe('every response is no-store JSON', () => {
  it('on GET and on every POST answer', async () => {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 1 }, routes: { appealsRateLimit: { max: 6, windowMs: 60_000 } } });
    const a = await w.sanction(ALICE);
    const responses = [
      await w.call('GET', '/appeals', { who: ALICE }),
      await file(w, ALICE, a.noticeId),
      await file(w, ALICE, a.noticeId),
      await file(w, ALICE, 'nope'),
      await file(w, ALICE, a.noticeId, ''),
      await w.call('POST', '/appeals', { who: ALICE, raw: '{' }),
      await w.call('POST', '/appeals', { who: ALICE, raw: '[]' }),
      await file(w, ALICE, a.noticeId),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 409, 404, 400, 400, 400, 429]);
    for (const res of responses) {
      expect(res.headers?.['cache-control'], String(res.status)).toBe('no-store');
      expect(typeof res.body).toBe('object');
      expect(res.headers?.['content-type']).toBeUndefined();
    }
    const off = await playerWorld({ appeals: false });
    for (const res of [await off.call('GET', '/appeals', { who: ALICE }), await file(off, ALICE, 'x')]) expect(res.headers?.['cache-control']).toBe('no-store');
  });
});
