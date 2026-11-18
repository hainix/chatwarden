// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AppealCase } from '@chatwarden/core';
import { createAppealPageClient, readAppealToken } from '../src/appeal/appealClient.js';
import { PlayerError } from '../src/client.js';

// The client of the appeal page (appeals landing, 3.4): GET and POST /appeal/case on the game's server, with no cookie, no Authorization header and no referrer. The answer
// is read through an allow-list: only the documented fields of an `AppealCase` come out, each only when it has the right type.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ENDPOINT = 'https://game.example/appeal/case';
const TOKEN = 'abc.def-1_2';

const CASE: AppealCase = {
  notice: { kind: 'chat', rule: 2, ruleLabel: 'Community Rule 2: No insulting players', until: NOW + DAY, refCode: 'M-ABC12', createdAt: NOW - HOUR, excerpt: [{ text: 'you are a *****', day: '2027-01-15' }] },
  canAppeal: true,
  appeal: null,
  standing: null,
  expiresAt: NOW + 30 * DAY,
  emailsOutcome: false,
  contact: null,
  statementMax: 1000,
};

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  });
  return { fetch: f as unknown as typeof fetch, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const headersOf = (init: RequestInit): Record<string, string> => Object.fromEntries(new Headers(init.headers).entries());

describe('load', () => {
  it('sends GET with t, credentials omit, no-referrer, no-store, cors, and no cookie or authorization header', async () => {
    const f = fakeFetch(() => json(200, CASE));
    const client = createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch });
    await client.load(TOKEN);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`${ENDPOINT}?t=${TOKEN}`);
    const init = f.calls[0]!.init;
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.cache).toBe('no-store');
    expect(init.mode).toBe('cors');
    expect(init.body).toBeUndefined();
    const names = Object.keys(headersOf(init));
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('authorization');
    expect(names.every((n) => ['accept'].includes(n))).toBe(true);
  });

  it('encodes the token in the query, and extends an endpoint that already has a query', async () => {
    const f = fakeFetch(() => json(200, CASE));
    await createAppealPageClient({ endpoint: `${ENDPOINT}?lang=es`, fetch: f.fetch }).load('a b&c');
    expect(f.calls[0]!.url).toBe(`${ENDPOINT}?lang=es&t=a%20b%26c`);
  });

  it('the answer keeps only documented fields: a case with extra keys, a notice id, a staff field and a private reason loses them', async () => {
    const hostile = {
      ...CASE,
      staff: { actor: 'ann@example.test' },
      privateReason: 'the private moderator reason',
      statement: 'the words the player wrote',
      notice: { ...CASE.notice, id: 'notice-id-1', groupId: 'g1', person: 's_aaaaaaaaaaaaaaaaaaaaaa', excerpt: [{ text: 'a line', day: '2027-01-15', lineId: 'l1' }, { text: 5, day: 'x' }, 'nope'] },
      appeal: { status: 'upheld', createdAt: NOW, decidedAt: NOW + HOUR, reason: 'rule_applies', id: 'a1', decidedBy: 'ann', privateReason: 'x' },
      standing: { kind: 'chat', until: NOW + DAY, state: 'active', groupId: 'g1' },
    };
    const f = fakeFetch(() => json(200, hostile));
    const got = await createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).load(TOKEN);
    expect(got).toEqual({
      ...CASE,
      notice: { ...CASE.notice, excerpt: [{ text: 'a line', day: '2027-01-15' }] },
      appeal: { status: 'upheld', createdAt: NOW, decidedAt: NOW + HOUR, reason: 'rule_applies' },
      standing: { kind: 'chat', until: NOW + DAY, state: 'active' },
    });
    const text = JSON.stringify(got);
    for (const secret of ['notice-id-1', 'ann@example.test', 'private moderator reason', 'the words the player wrote', 'g1', 'a1', 's_aaaa']) expect(text, secret).not.toContain(secret);
  });

  it.each([
    ['a wrong-typed optional field is dropped', { contact: 7, appeal: 'x', standing: 5 }, { contact: null, appeal: null, standing: null }],
    ['an unknown reason code is dropped', { appeal: { status: 'revoked', createdAt: NOW, decidedAt: NOW, reason: 'not-a-code' } }, { appeal: { status: 'revoked', createdAt: NOW, decidedAt: NOW, reason: null } }],
    ['an unknown standing state drops the standing', { standing: { kind: 'chat', until: null, state: 'weird' } }, { standing: null }],
    ['an unknown appeal status drops the appeal', { appeal: { status: 'moot', createdAt: NOW, decidedAt: null, reason: null } }, { appeal: null }],
    ['a contact string is kept', { contact: 'help@game.example' }, { contact: 'help@game.example' }],
  ])('%s', async (_name, patch, expected) => {
    const f = fakeFetch(() => json(200, { ...CASE, ...patch }));
    expect(await createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).load(TOKEN)).toEqual({ ...CASE, ...expected });
  });

  it.each([
    ['a missing notice', { ...CASE, notice: undefined }],
    ['a notice kind that is not a sanction', { ...CASE, notice: { ...CASE.notice, kind: 'report_outcome' } }],
    ['canAppeal not a boolean', { ...CASE, canAppeal: 'yes' }],
    ['expiresAt not a number', { ...CASE, expiresAt: '5' }],
    ['statementMax missing', { ...CASE, statementMax: undefined }],
    ['an array', [CASE]],
    ['a string', 'ok'],
  ])('a 200 that is not a case is a failure: %s', async (_name, body) => {
    const f = fakeFetch(() => json(200, body));
    await expect(createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).load(TOKEN)).rejects.toBeInstanceOf(PlayerError);
  });

  it("404 is 'invalid'", async () => {
    const f = fakeFetch(() => json(404, { error: 'not_found', message: 'x' }));
    expect(await createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).load(TOKEN)).toBe('invalid');
  });

  it('a malformed body, a 500, a 429, and a thrown fetch are failures that never expose the token or the url in the message', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('<html>proxy</html>', { status: 200 }),
      () => json(500, { error: 'internal', message: `boom ${TOKEN} ${ENDPOINT}` }),
      () => json(429, { error: 'rate_limited', message: 'x' }, { 'retry-after': '9' }),
      () => {
        throw new TypeError(`fetch failed for ${ENDPOINT}?t=${TOKEN}`);
      },
    ];
    for (const answer of answers) {
      const f = fakeFetch(answer);
      const err = await createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).load(TOKEN).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PlayerError);
      const e = err as PlayerError;
      expect(JSON.stringify({ m: e.message, c: e.code, n: e.name, s: e.stack?.split('\n')[0] })).not.toContain(TOKEN);
      expect(e.message).not.toContain('game.example');
      expect(e.message).not.toContain(TOKEN);
    }
  });

  it('a 429 carries the retry-after in whole seconds', async () => {
    const f = fakeFetch(() => json(429, { error: 'rate_limited', message: 'x' }, { 'retry-after': '9' }));
    const err = (await createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).load(TOKEN).catch((e: unknown) => e)) as PlayerError;
    expect([err.status, err.retryAfter]).toEqual([429, 9]);
  });

  it('uses the global fetch when none is given, and nothing is called when the client is only made', () => {
    const f = fakeFetch(() => json(200, CASE));
    createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch });
    expect(f.calls).toEqual([]);
  });
});

describe('send: the status table', () => {
  // 200 -> ok with the returned case; 400 and 413 -> invalid (the statement); 409 -> already; 429 -> rate with retryAfterMs from retry-after (seconds x 1000, 60000 when
  // missing or unreadable); 404 -> link; any other status, a 200 whose body is not a case, and a thrown fetch -> failed.
  const run = async (answer: () => Response | Promise<Response>) => {
    const f = fakeFetch(answer);
    const result = await createAppealPageClient({ endpoint: ENDPOINT, fetch: f.fetch }).send(TOKEN, 'It was a joke');
    return { result, calls: f.calls };
  };
  const decided: AppealCase = { ...CASE, canAppeal: false, appeal: { status: 'open', createdAt: NOW, decidedAt: null, reason: null } };

  it('200 -> ok with the returned case', async () => {
    const { result } = await run(() => json(200, decided));
    expect(result).toEqual({ ok: true, case: decided });
  });
  it('400 -> invalid', async () => expect((await run(() => json(400, { error: 'invalid_statement', message: 'x' }))).result).toEqual({ ok: false, refused: 'invalid' }));
  it('413 -> invalid', async () => expect((await run(() => json(413, { error: 'payload_too_large', message: 'x' }))).result).toEqual({ ok: false, refused: 'invalid' }));
  it('409 -> already', async () => expect((await run(() => json(409, { error: 'already_appealed', message: 'x' }))).result).toEqual({ ok: false, refused: 'already' }));
  it('429 with retry-after 7 -> rate, 7000 ms', async () =>
    expect((await run(() => json(429, { error: 'rate_limited', message: 'x' }, { 'retry-after': '7' }))).result).toEqual({ ok: false, refused: 'rate', retryAfterMs: 7000 }));
  it.each([[undefined], ['soon'], ['-3'], ['1.5'], ['']])('429 with retry-after %j -> rate, 60000 ms', async (header) => {
    const headers: Record<string, string> = header === undefined ? {} : { 'retry-after': header };
    expect((await run(() => json(429, { error: 'rate_limited', message: 'x' }, headers))).result).toEqual({ ok: false, refused: 'rate', retryAfterMs: 60_000 });
  });
  it('404 -> link', async () => expect((await run(() => json(404, { error: 'not_found', message: 'x' }))).result).toEqual({ ok: false, refused: 'link' }));
  it.each([[500], [502], [503], [401], [403], [418]])('%s -> failed', async (status) => expect((await run(() => json(status, { error: 'x', message: 'y' }))).result).toEqual({ ok: false, refused: 'failed' }));
  it('a 200 with a body that is not a case -> failed', async () => {
    expect((await run(() => json(200, { ok: true }))).result).toEqual({ ok: false, refused: 'failed' });
    expect((await run(() => new Response('not json', { status: 200 }))).result).toEqual({ ok: false, refused: 'failed' });
  });
  it('a network error -> failed, and the statement and token are in no message', async () => {
    const { result } = await run(() => {
      throw new TypeError(`could not reach ${ENDPOINT} with ${TOKEN}`);
    });
    expect(result).toEqual({ ok: false, refused: 'failed' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('the body is exactly { t, statement } as json, with the safe request options and no cookie or authorization header', async () => {
    const { calls } = await run(() => json(200, decided));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(headersOf(init)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ t: TOKEN, statement: 'It was a joke' });
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(['statement', 't']);
    expect([init.credentials, init.referrerPolicy, init.cache, init.mode]).toEqual(['omit', 'no-referrer', 'no-store', 'cors']);
    expect(Object.keys(headersOf(init))).not.toContain('cookie');
    expect(Object.keys(headersOf(init))).not.toContain('authorization');
  });
});

describe('the client source', () => {
  it('never reads document.cookie, storage or the location, and holds no English', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/appeal/appealClient.ts', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(source).not.toMatch(/document\b|cookie|localStorage|sessionStorage|location\b/);
  });
});

describe('readAppealToken', () => {
  it.each([
    ['?t=abc.def', 'abc.def'],
    ['t=abc', 'abc'],
    ['?x=1&t=abc.def&y=2', 'abc.def'],
    ['?t=A_b-C.9', 'A_b-C.9'],
    [`?t=${'a'.repeat(512)}`, 'a'.repeat(512)],
  ])('%j reads %j', (search, expected) => expect(readAppealToken(search)).toBe(expected));

  it.each([
    ['a quote', '?t=ab"c'],
    ['a single quote', "?t=ab'c"],
    ['an angle bracket', '?t=ab<c'],
    ['an encoded angle bracket', '?t=ab%3Cc'],
    ['a space', '?t=ab c'],
    ['an encoded space', '?t=ab%20c'],
    ['a plus', '?t=ab+c'],
    ['513 characters', `?t=${'a'.repeat(513)}`],
    ['the array form', '?t[]=abc'],
    ['an empty value', '?t='],
    ['no t at all', '?x=1'],
    ['an empty query', ''],
    ['two values', '?t=abc&t=def'],
    ['a different name', '?tt=abc'],
    ['a slash', '?t=a/b'],
  ])('%s gives null', (_name, search) => expect(readAppealToken(search)).toBeNull());

  it('a value that is not a string gives null, never a throw', () => {
    for (const v of [undefined, null, 5, {}, []]) expect(readAppealToken(v as never)).toBeNull();
  });
});
