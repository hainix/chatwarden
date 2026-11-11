import { describe, expect, it } from 'vitest';
import { PlayerError, createPlayerClient, toPlayerError } from '../src/client.js';
import type { Transport, TransportResponse } from '../src/transport.js';
import { ALICE, BOB, CARA, DAY, playerWorld } from './world.js';

const fake = (res: TransportResponse | Error): Transport => () => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res));
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers, body });
const caught = (p: Promise<unknown>): Promise<PlayerError> => p.then(() => Promise.reject(new Error('expected a rejection')), (e: unknown) => e as PlayerError);

describe('PlayerError', () => {
  it('carries status, code, message and an optional retryAfter, and is an Error', () => {
    const e = new PlayerError({ status: 429, code: 'rate_limited', message: 'Slow down.', retryAfter: 7 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PlayerError');
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter }).toEqual({ status: 429, code: 'rate_limited', message: 'Slow down.', retryAfter: 7 });
    expect(new PlayerError({ status: 404, code: 'not_found', message: 'x' }).retryAfter).toBeUndefined();
  });
  it('toPlayerError keeps a PlayerError and wraps anything else as status 0, code unexpected', () => {
    const e = new PlayerError({ status: 404, code: 'not_found', message: 'x' });
    expect(toPlayerError(e)).toBe(e);
    expect(toPlayerError(new RangeError('boom'))).toMatchObject({ status: 0, code: 'unexpected' });
    expect(toPlayerError('text')).toMatchObject({ status: 0, code: 'unexpected' });
    expect(toPlayerError(null).message).toBe('Something went wrong.');
  });
});

describe('the four calls, against the real player routes', () => {
  it('notices(): nothing yet is an empty list', async () => {
    const w = await playerWorld();
    expect(await w.client.notices()).toEqual([]);
    expect(w.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /notices']);
  });

  it('notices(): a warned player gets the warning, oldest first, with the fields the kit sends', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { rule: 2, lines: ['you are a snerp'] });
    w.clock.t += DAY;
    await w.sanction(ALICE, 'chat', { rule: 1, durationMs: DAY });
    const list = await w.client.notices();
    expect(list.map((n) => n.kind)).toEqual(['warning', 'chat']);
    expect(list[0]).toMatchObject({ rule: 2, until: null, mustAcknowledge: true, excerpt: [{ text: 'you are a snerp' }] });
    expect(list[0]?.ruleLabel).toMatch(/^Community Rule 2/);
    expect(list[1]?.until).toBeGreaterThan(w.now() - DAY);
    expect(list).toEqual(w.pending());
  });

  it('notices(): the reporter hears that action was taken, with no rule, code or excerpt', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    w.caller.key = BOB.key;
    const [n] = await w.client.notices();
    expect(n).toMatchObject({ kind: 'report_outcome', rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], mustAcknowledge: false });
  });

  it('ack(): true for the player own notice, and the notice is gone from the next list; true again for a replay', async () => {
    const w = await playerWorld();
    await w.warn();
    const [n] = await w.client.notices();
    expect(await w.client.ack(n?.id as string)).toBe(true);
    expect(await w.client.notices()).toEqual([]);
    expect(await w.client.ack(n?.id as string)).toBe(true);
    expect(w.sent.at(-1)).toMatchObject({ method: 'POST', path: `/notices/${n?.id}/ack` });
  });

  it('ack(): false (still a 200) for an unknown id, and for another player notice', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    const [n] = await w.client.notices();
    expect(await w.client.ack('no-such-notice')).toBe(false);
    w.caller.key = CARA.key;
    expect(await w.client.ack(n?.id as string)).toBe(false);
    w.caller.key = ALICE.key;
    expect(await w.client.notices()).toHaveLength(1);
  });

  it('ack(): an id is encoded so it cannot add a path segment or a query', async () => {
    const w = await playerWorld();
    await w.client.ack('a/b?c=d e').catch(() => undefined);
    expect(w.sent[0]?.path).toBe('/notices/a%2Fb%3Fc%3Dd%20e/ack');
    expect(w.sent[0]?.query).toBeUndefined();
  });

  it('record(): a warning stays on the record after it is acknowledged; a report outcome never does', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    const [n] = await w.client.notices();
    await w.client.ack(n?.id as string);
    expect((await w.client.record()).map((r) => r.kind)).toEqual(['warning']);
    w.caller.key = BOB.key;
    expect(await w.client.record()).toEqual([]);
  });

  it('rules(): the summary and the active rules as number, title, text; a retired rule is left out', async () => {
    const w = await playerWorld({ retire: [2] });
    const r = await w.client.rules();
    expect(r.summary).toBe(w.cw.summary);
    expect(r.rules.map((x) => x.number)).not.toContain(2);
    expect(r.rules.length).toBeGreaterThan(2);
    for (const rule of r.rules) expect(Object.keys(rule).sort()).toEqual(['number', 'text', 'title']);
    expect(w.sent.at(-1)).toMatchObject({ method: 'GET', path: '/rules' });
  });

  it('every call sends the right method and path and no body or query', async () => {
    const w = await playerWorld();
    await w.client.notices();
    await w.client.record();
    await w.client.rules();
    await w.client.ack('abc');
    expect(w.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /notices', 'GET /record', 'GET /rules', 'POST /notices/abc/ack']);
    for (const r of w.sent) expect(r.body).toBeUndefined();
  });
});

describe('errors from the transport', () => {
  const notices = (t: Transport) => createPlayerClient({ transport: t }).notices();

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'internal'],
  ])('turns a %i kit error body into a PlayerError with the code %s', async (status, code) => {
    const err = await caught(notices(fake(reply(status, { error: code, message: 'Server text.' }))));
    expect(err).toBeInstanceOf(PlayerError);
    expect(err).toMatchObject({ status, code, message: 'Server text.' });
  });

  it('reads retry-after (seconds) on a 429, and ignores one that is not a whole number', async () => {
    const ok = await caught(notices(fake(reply(429, { error: 'rate_limited', message: 'm' }, { 'retry-after': '7' }))));
    expect(ok.retryAfter).toBe(7);
    for (const value of ['soon', '-1', '1.5', '', '1234567890123']) {
      const err = await caught(notices(fake(reply(429, { error: 'rate_limited', message: 'm' }, { 'retry-after': value }))));
      expect(err.retryAfter, value).toBeUndefined();
    }
  });

  it('names an error whose body is not the kit shape by its status, and never echoes the body', async () => {
    const html = await caught(notices(fake(reply(502, '<html>bad gateway private-detail</html>'))));
    expect(html).toMatchObject({ status: 502, code: 'http_502' });
    expect(html.message).not.toContain('private-detail');
    expect(await caught(notices(fake(reply(500, null))))).toMatchObject({ status: 500, code: 'http_500' });
    expect(await caught(notices(fake(reply(400, { error: 5 }))))).toMatchObject({ status: 400, code: 'http_400' });
  });

  it('turns a dropped connection into status 0, code network', async () => {
    const err = await caught(notices(fake(new TypeError('fetch failed'))));
    expect(err).toMatchObject({ status: 0, code: 'network' });
    expect(err.message).not.toContain('fetch failed');
  });

  it('says the request was cancelled for an AbortError', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(await caught(notices(fake(abort)))).toMatchObject({ status: 0, code: 'network', message: 'The request was cancelled.' });
  });

  it.each([
    ['a string', 'oops'],
    ['null', null],
    ['an array', []],
    ['an object with no list', { nope: true }],
    ['a list that is not a list', { notices: 'x' }],
  ])('rejects a 200 whose body is %s as bad_response', async (_name, body) => {
    expect(await caught(notices(fake(reply(200, body))))).toMatchObject({ code: 'bad_response' });
  });

  it('drops a list entry that is not a notice instead of showing it', async () => {
    const good = { id: 'n1', kind: 'warning', rule: 1, ruleLabel: 'Community Rule 1: x', until: null, refCode: 'M-ABCDE', excerpt: [], createdAt: 1, mustAcknowledge: true };
    const list = await notices(fake(reply(200, { notices: [good, null, 5, { id: 3 }, { kind: 'warning' }, { id: 'n2', kind: 5 }] })));
    expect(list.map((n) => n.id)).toEqual(['n1']);
  });

  it('keeps only the fields it knows from a notice: nothing else the server sent reaches the page', async () => {
    const raw = {
      id: 'n1',
      kind: 'ban',
      rule: 1,
      ruleLabel: 'L',
      until: 5,
      refCode: 'M-ABCDE',
      excerpt: [{ text: 't', day: '2027-01-01', roomId: 'room-9' }],
      createdAt: 1,
      mustAcknowledge: false,
      subject: 's_abc',
      actor: 'x@y.test',
    };
    const [n] = await notices(fake(reply(200, { notices: [raw] })));
    expect(Object.keys(n ?? {}).sort()).toEqual(['createdAt', 'excerpt', 'id', 'kind', 'mustAcknowledge', 'refCode', 'rule', 'ruleLabel', 'until']);
    expect(n?.excerpt[0]).toEqual({ text: 't', day: '2027-01-01' });
  });

  it('keeps a notice of a kind this version does not know, so nothing is dropped', async () => {
    const odd = { id: 'n1', kind: 'future_kind', rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: 1, mustAcknowledge: false };
    const [n] = await notices(fake(reply(200, { notices: [odd] })));
    expect(n?.kind).toBe('future_kind');
  });

  it('treats a field of the wrong type as absent, not as a crash', async () => {
    const odd = { id: 'n1', kind: 'ban', rule: 'x', ruleLabel: 5, until: 'soon', refCode: 7, excerpt: 'no', createdAt: 'now', mustAcknowledge: 'yes' };
    const [n] = await notices(fake(reply(200, { notices: [odd] })));
    expect(n).toMatchObject({ rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: 0, mustAcknowledge: false });
  });

  it('rules(): a body without a summary and a list is bad_response; a rule that is malformed is dropped', async () => {
    const rules = (b: unknown) => createPlayerClient({ transport: fake(reply(200, b)) }).rules();
    expect(await caught(rules({ summary: 5, rules: [] }))).toMatchObject({ code: 'bad_response' });
    expect(await caught(rules({ summary: 's' }))).toMatchObject({ code: 'bad_response' });
    const kept = await rules({ summary: 's', rules: [{ number: 1, title: 't', text: 'x', extra: 1 }, { number: 'a', title: 't', text: 'x' }, null] });
    expect(kept.rules).toEqual([{ number: 1, title: 't', text: 'x' }]);
  });

  it('ack() on a 404 rejects with status 404 (the component decides what that means)', async () => {
    const err = await caught(createPlayerClient({ transport: fake(reply(404, { error: 'not_found', message: 'gone' })) }).ack('x'));
    expect(err.status).toBe(404);
  });

  it('ack() with a body that is not { ok: boolean } is bad_response', async () => {
    expect(await caught(createPlayerClient({ transport: fake(reply(200, { ok: 'yes' })) }).ack('x'))).toMatchObject({ code: 'bad_response' });
    expect(await caught(createPlayerClient({ transport: fake(reply(200, null)) }).ack('x'))).toMatchObject({ code: 'bad_response' });
  });
});
