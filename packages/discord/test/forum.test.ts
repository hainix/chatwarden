import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_TIMEOUT_MS,
  BACKOFF_BASE_MS,
  CONTENT_MAX,
  MAX_RETRIES,
  RETRY_AFTER_CAP_MS,
  RETRY_AFTER_FLOOR_MS,
  THREAD_NAME_MAX,
  makeForumClient,
  parseWebhookUrl,
} from '../src/forum.js';
import type { ForumClientOptions } from '../src/forum.js';
import { NOW, ROLE, TOKEN, WEBHOOK, fakeDiscord, settle } from './support.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;
function client(plan?: Parameters<typeof fakeDiscord>[0], over: Partial<ForumClientOptions> = {}) {
  const d = fakeDiscord(plan);
  const logged: Logged = [];
  const forum = makeForumClient({
    webhookUrl: WEBHOOK,
    fetch: d.fetch,
    logger: { warn: (e, detail) => void logged.push([e, detail]) },
    random: () => 0.5,
    ...over,
  });
  return { forum, d, logged };
}

describe('parseWebhookUrl', () => {
  it.each([
    'https://discord.com/api/webhooks/123456789012345678/abc-DEF_123',
    'https://discordapp.com/api/webhooks/123456789012345678/abc',
    'https://ptb.discord.com/api/webhooks/123456789012345678/abc',
    'https://canary.discord.com/api/webhooks/123456789012345678/abc',
    'https://ptb.discordapp.com/api/webhooks/123456789012345678/abc',
    'https://canary.discordapp.com/api/webhooks/123456789012345678/abc',
    'HTTPS://DISCORD.COM/api/webhooks/123456789012345678/abc',
    'https://discord.com/api/webhooks/123456789012345678/abc/',
  ])('accepts %s', (url) => {
    expect(() => parseWebhookUrl(url)).not.toThrow();
  });

  it('accepts the shortest and the longest snowflake (17 and 20 digits)', () => {
    expect(() => parseWebhookUrl('https://discord.com/api/webhooks/12345678901234567/abc')).not.toThrow();
    expect(() => parseWebhookUrl('https://discord.com/api/webhooks/12345678901234567890/abc')).not.toThrow();
  });

  it('returns the bare webhook URL (query and fragment dropped)', () => {
    expect(parseWebhookUrl(`${WEBHOOK}?wait=false&thread_id=9#frag`)).toBe(WEBHOOK);
    expect(parseWebhookUrl(`${WEBHOOK}/`)).toBe(WEBHOOK);
  });

  it.each([
    ['http', 'http://discord.com/api/webhooks/123456789012345678/abc'],
    ['another host', 'https://example.com/api/webhooks/123456789012345678/abc'],
    ['a lookalike suffix', 'https://discord.com.evil.test/api/webhooks/123456789012345678/abc'],
    ['a lookalike prefix', 'https://evildiscord.com/api/webhooks/123456789012345678/abc'],
    ['a dotless lookalike', 'https://notdiscord.com/api/webhooks/123456789012345678/abc'],
    ['an unknown subdomain', 'https://evil.discord.com/api/webhooks/123456789012345678/abc'],
    ['a nested subdomain', 'https://a.ptb.discord.com/api/webhooks/123456789012345678/abc'],
    ['credentials in the URL', 'https://user:pw@discord.com/api/webhooks/123456789012345678/abc'],
    ['a port', 'https://discord.com:8443/api/webhooks/123456789012345678/abc'],
    ['no token', 'https://discord.com/api/webhooks/123456789012345678'],
    ['a one-digit id', 'https://discord.com/api/webhooks/1/abc'],
    ['a 16-digit id', 'https://discord.com/api/webhooks/1234567890123456/abc'],
    ['a 21-digit id', 'https://discord.com/api/webhooks/123456789012345678901/abc'],
    ['a non-digit id', 'https://discord.com/api/webhooks/abc/def'],
    ['the wrong path', 'https://discord.com/webhooks/123456789012345678/abc'],
    ['an extra path segment', 'https://discord.com/api/webhooks/123456789012345678/abc/messages'],
    ['a token with odd characters', 'https://discord.com/api/webhooks/123456789012345678/a%20b'],
    ['not a URL', 'discord'],
    ['an empty string', ''],
  ])('rejects %s with a RangeError that does not echo it', (_n, url) => {
    let error: unknown;
    try {
      parseWebhookUrl(url);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).not.toContain('abc');
    expect((error as Error).message).not.toContain('123456789012345678');
  });

  it.each([[undefined], [null], [42], [{}]])('rejects the non-string %j', (v) => {
    expect(() => parseWebhookUrl(v)).toThrow(RangeError);
  });
});

describe('requests', () => {
  it('opens a thread with POST ?wait=true, thread_name and content, and answers channel_id as the thread id', async () => {
    const { forum, d } = client();
    const r = forum.openThread('Case 7K2QX', { content: 'hello' });
    await settle();
    expect(await r).toEqual({ threadId: 'T1' });
    const c = d.calls[0]!;
    expect(c.init.method).toBe('POST');
    expect(c.href).toBe(`${WEBHOOK}?wait=true`);
    expect(c.body).toMatchObject({ thread_name: 'Case 7K2QX', content: 'hello' });
    expect(c.init.headers['content-type']).toBe('application/json');
    expect(c.init.redirect).toBe('manual');
  });

  it('posts into a thread with ?wait=true&thread_id=', async () => {
    const { forum, d } = client();
    const r = forum.post('T9', { content: 'again' });
    await settle();
    expect(await r).toEqual({ ok: true });
    expect(d.calls[0]!.url.searchParams.get('wait')).toBe('true');
    expect(d.calls[0]!.url.searchParams.get('thread_id')).toBe('T9');
    expect(d.calls[0]!.url.pathname).toBe(new URL(WEBHOOK).pathname);
    expect(d.calls[0]!.body).not.toHaveProperty('thread_name');
  });

  it('encodes the thread id into the query', async () => {
    const { forum, d } = client();
    void forum.post('a&b=c', { content: 'x' });
    await settle();
    expect(d.calls[0]!.url.searchParams.get('thread_id')).toBe('a&b=c');
    expect([...d.calls[0]!.url.searchParams.keys()].sort()).toEqual(['thread_id', 'wait']);
  });

  it('always sends allowed_mentions with parse: [] and suppresses link embeds', async () => {
    const { forum, d } = client();
    void forum.openThread('t', { content: '@everyone @here <@123> <@&456>' });
    void forum.post('T1', { content: '@everyone' });
    await settle();
    expect(d.calls).toHaveLength(2);
    for (const c of d.calls) {
      expect(c.body.allowed_mentions).toEqual({ parse: [] });
      expect(c.body.flags).toBe(4);
    }
  });

  it('a message that names a role mentions that role only', async () => {
    const { forum, d } = client();
    void forum.openThread('t', { content: `<@&${ROLE}> severe`, mentionRoleId: ROLE });
    await settle();
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
  });

  it('a mentionRoleId that is not a snowflake is never sent', async () => {
    const { forum, d } = client();
    void forum.openThread('t', { content: 'x', mentionRoleId: 'everyone' });
    await settle();
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('cuts the thread name to 100 and the content to 2000 without splitting a surrogate pair', async () => {
    const { forum, d } = client();
    void forum.openThread(`${'a'.repeat(99)}\u{1F600}tail`, { content: `${'b'.repeat(1999)}\u{1F600}tail` });
    await settle();
    const body = d.calls[0]!.body as { thread_name: string; content: string };
    expect(THREAD_NAME_MAX).toBe(100);
    expect(CONTENT_MAX).toBe(2000);
    expect(body.thread_name).toBe('a'.repeat(99));
    expect(body.content).toBe('b'.repeat(1999));
  });

  it('answers null when the response has no usable thread id', async () => {
    const { forum, logged } = client(() => ({ status: 200, json: { id: 'm1' } }));
    const r = forum.openThread('t', { content: 'x' });
    await settle();
    expect(await r).toBeNull();
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'openThread', error: 'bad_response', attempts: 1 }]]);
  });

  it('a non-JSON success body is null for openThread but ok for post', async () => {
    const { forum } = client(() => ({ status: 200, text: 'not json' }));
    const a = forum.openThread('t', { content: 'x' });
    const b = forum.post('T1', { content: 'x' });
    await settle();
    expect(await a).toBeNull();
    expect(await b).toEqual({ ok: true });
  });
});

describe('gone threads and refusals', () => {
  it('404 with Unknown Channel (10003) is gone', async () => {
    const { forum } = client(() => ({ status: 404, json: { code: 10003, message: 'Unknown Channel' } }));
    const r = forum.post('T1', { content: 'x' });
    await settle();
    expect(await r).toEqual({ gone: true });
  });

  it('a bare 404 (no Discord code) is gone', async () => {
    const { forum } = client(() => 404);
    const r = forum.post('T1', { content: 'x' });
    await settle();
    expect(await r).toEqual({ gone: true });
  });

  it('404 with another code (the webhook itself, 10015) is not a gone thread, is not retried, and is logged', async () => {
    const { forum, d, logged } = client(() => ({ status: 404, json: { code: 10015 } }));
    const r = forum.post('T1', { content: 'x' });
    await settle();
    expect(await r).toBeNull();
    expect(d.calls).toHaveLength(1);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'post', status: 404, attempts: 1 }]]);
  });

  it.each([400, 401, 403, 413])('%i is final: no retry, null, logged once with the status', async (status) => {
    const { forum, d, logged } = client(() => status);
    const r = forum.post('T1', { content: 'x' });
    await settle(120_000);
    expect(await r).toBeNull();
    expect(d.calls).toHaveLength(1);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'post', status, attempts: 1 }]]);
  });

  it('a redirect is final too', async () => {
    const { forum, d } = client(() => ({ status: 302, headers: { location: 'https://evil.test/' } }));
    const r = forum.openThread('t', { content: 'x' });
    await settle(120_000);
    expect(await r).toBeNull();
    expect(d.calls).toHaveLength(1);
  });
});

describe('429 handling', () => {
  const limited = (retryAfter: unknown, extra: Record<string, string> = {}) => ({
    status: 429,
    json: { message: 'You are being rate limited.', retry_after: retryAfter, global: false },
    headers: extra,
  });

  it('honours the JSON retry_after in seconds, floats included', async () => {
    const { forum, d } = client((n) => (n === 0 ? limited(1.5) : undefined));
    const r = forum.post('T1', { content: 'x' });
    await settle(1499);
    expect(d.calls).toHaveLength(1);
    await settle(1);
    expect(d.calls).toHaveLength(2);
    expect(await r).toEqual({ ok: true });
  });

  it('floors a short retry_after at 0.5 s', async () => {
    expect(RETRY_AFTER_FLOOR_MS).toBe(500);
    const { forum, d } = client((n) => (n === 0 ? limited(0.05) : undefined));
    void forum.post('T1', { content: 'x' });
    await settle(499);
    expect(d.calls).toHaveLength(1);
    await settle(1);
    expect(d.calls).toHaveLength(2);
  });

  it('floors a zero or negative retry_after the same way', async () => {
    const { forum, d } = client((n) => (n === 0 ? limited(0) : n === 1 ? limited(-3) : undefined));
    void forum.post('T1', { content: 'x' });
    await settle(499);
    expect(d.calls).toHaveLength(1);
    await settle(1);
    expect(d.calls).toHaveLength(2);
    await settle(499);
    expect(d.calls).toHaveLength(2);
    await settle(1);
    expect(d.calls).toHaveLength(3);
  });

  it('caps a long retry_after at 60 s', async () => {
    expect(RETRY_AFTER_CAP_MS).toBe(60_000);
    const { forum, d } = client((n) => (n === 0 ? limited(86_400) : undefined));
    void forum.post('T1', { content: 'x' });
    await settle(59_999);
    expect(d.calls).toHaveLength(1);
    await settle(1);
    expect(d.calls).toHaveLength(2);
  });

  it('falls back to the retry-after header (seconds) when the body has none', async () => {
    const { forum, d } = client((n) => (n === 0 ? { status: 429, text: 'Too Many Requests', headers: { 'retry-after': '3' } } : undefined));
    void forum.post('T1', { content: 'x' });
    await settle(2999);
    expect(d.calls).toHaveLength(1);
    await settle(1);
    expect(d.calls).toHaveLength(2);
  });

  it('the JSON retry_after wins over the header', async () => {
    const { forum, d } = client((n) => (n === 0 ? limited(1, { 'retry-after': '30' }) : undefined));
    void forum.post('T1', { content: 'x' });
    await settle(1000);
    expect(d.calls).toHaveLength(2);
  });

  it('a header with a float is honoured; a junk header and no body hint fall back to the backoff', async () => {
    const a = client((n) => (n === 0 ? { status: 429, text: '', headers: { 'retry-after': '1.25' } } : undefined));
    void a.forum.post('T1', { content: 'x' });
    await settle(1249);
    expect(a.d.calls).toHaveLength(1);
    await settle(1);
    expect(a.d.calls).toHaveLength(2);

    const b = client((n) => (n === 0 ? { status: 429, text: '', headers: { 'retry-after': 'soon' } } : undefined));
    void b.forum.post('T1', { content: 'x' });
    await settle(BACKOFF_BASE_MS - 1);
    expect(b.d.calls).toHaveLength(1);
    await settle(1);
    expect(b.d.calls).toHaveLength(2);
  });

  it('a junk JSON retry_after (a string, null, an object, a boolean) is ignored in favour of the header', async () => {
    for (const bad of ['5', null, 'NaN', {}, true]) {
      const { forum, d } = client((n) => (n === 0 ? { status: 429, json: { retry_after: bad }, headers: { 'retry-after': '2' } } : undefined));
      void forum.post('T1', { content: 'x' });
      await settle(1999);
      expect(d.calls).toHaveLength(1);
      await settle(1);
      expect(d.calls).toHaveLength(2);
    }
  });

  it('gives up after 5 retries (6 attempts), logs the status and attempts once, and then resolves null', async () => {
    expect(MAX_RETRIES).toBe(5);
    const { forum, d, logged } = client(() => limited(1));
    const r = forum.post('T1', { content: 'x' });
    await settle(60_000);
    expect(await r).toBeNull();
    expect(d.calls).toHaveLength(6);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'post', status: 429, attempts: 6 }]]);
  });

  it('a 429 that clears on the last retry succeeds', async () => {
    const { forum, d } = client((n) => (n < 5 ? limited(0.5) : undefined));
    const r = forum.openThread('t', { content: 'x' });
    await settle(10_000);
    expect(await r).toEqual({ threadId: 'T1' });
    expect(d.calls).toHaveLength(6);
  });

  it('requests wait their turn: the next one starts only after the 429 retry finishes', async () => {
    const { forum, d } = client((n) => (n === 0 ? limited(2) : undefined));
    void forum.post('T1', { content: 'first' });
    void forum.post('T2', { content: 'second' });
    await settle(1999);
    expect(d.calls.map((c) => c.body.content)).toEqual(['first']);
    await settle(1);
    expect(d.calls.map((c) => c.body.content)).toEqual(['first', 'first', 'second']);
  });
});

describe('5xx, network errors and timeouts', () => {
  it('retries a 5xx with exponential backoff 1, 2, 4, 8, 16 s, then gives up', async () => {
    expect(BACKOFF_BASE_MS).toBe(1000);
    const { forum, d, logged } = client(() => 503);
    const r = forum.post('T1', { content: 'x' });
    const seen: number[] = [];
    for (const wait of [1000, 2000, 4000, 8000, 16000]) {
      await settle(wait - 1);
      seen.push(d.calls.length);
      await settle(1);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(await r).toBeNull();
    expect(d.calls).toHaveLength(6);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'post', status: 503, attempts: 6 }]]);
  });

  it('jitters the backoff by plus or minus 20 percent', async () => {
    const lo = client(() => 500, { random: () => 0 });
    void lo.forum.post('T1', { content: 'x' });
    await settle(799);
    expect(lo.d.calls).toHaveLength(1);
    await settle(1);
    expect(lo.d.calls).toHaveLength(2);
    const hi = client(() => 500, { random: () => 0.999999 });
    void hi.forum.post('T1', { content: 'x' });
    await settle(1199);
    expect(hi.d.calls).toHaveLength(1);
    await settle(1);
    expect(hi.d.calls).toHaveLength(2);
  });

  it('retries a network error and succeeds', async () => {
    const { forum, d } = client((n) => (n < 2 ? new TypeError('fetch failed') : undefined));
    const r = forum.post('T1', { content: 'x' });
    await settle(3000);
    expect(await r).toEqual({ ok: true });
    expect(d.calls).toHaveLength(3);
  });

  it('a network error that never clears logs the error class only', async () => {
    const { forum, logged } = client(() => new TypeError(`fetch failed for ${WEBHOOK}`));
    const r = forum.post('T1', { content: 'x' });
    await settle(60_000);
    expect(await r).toBeNull();
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'post', error: 'TypeError', attempts: 6 }]]);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
    expect(JSON.stringify(logged)).not.toContain('discord.com');
  });

  it('a fetch that throws synchronously is a network error', async () => {
    const { forum, d } = client((n) => (n === 0 ? 'throw-sync' : undefined));
    const r = forum.post('T1', { content: 'x' });
    await settle(1000);
    expect(await r).toEqual({ ok: true });
    expect(d.calls).toHaveLength(2);
  });

  it('a fetch that rejects with a non-Error is classified by its type, never rethrown', async () => {
    const logged: Logged = [];
    const forum = makeForumClient({
      webhookUrl: WEBHOOK,
      fetch: (() => Promise.reject('plain string')) as unknown as typeof fetch,
      logger: { warn: (e, x) => void logged.push([e, x]) },
      random: () => 0.5,
    });
    const r = forum.post('T1', { content: 'x' });
    await settle(60_000);
    expect(await r).toBeNull();
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'post', error: 'string', attempts: 6 }]]);
  });

  it('aborts an attempt after 10 s and retries it', async () => {
    expect(ATTEMPT_TIMEOUT_MS).toBe(10_000);
    const { forum, d } = client((n) => (n === 0 ? 'hang' : undefined));
    const r = forum.post('T1', { content: 'x' });
    await settle(9999);
    expect(d.calls[0]!.init.signal.aborted).toBe(false);
    await settle(1);
    expect(d.calls[0]!.init.signal.aborted).toBe(true);
    await settle(1000);
    expect(await r).toEqual({ ok: true });
    expect(d.calls).toHaveLength(2);
  });

  it('a response whose body never arrives is cut at 10 s too', async () => {
    let calls = 0;
    const fetchFn = ((_u: string, init: RequestInit) => {
      calls++;
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        text: () =>
          new Promise<string>((_res, rej) => {
            init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
          }),
      });
    }) as unknown as typeof fetch;
    const forum = makeForumClient({ webhookUrl: WEBHOOK, fetch: fetchFn, logger: { warn: () => undefined }, random: () => 0.5 });
    void forum.openThread('t', { content: 'x' });
    await settle(10_000);
    await settle(1000);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('dispose', () => {
  it('aborts the attempt in flight, clears timers, resolves pending work null and refuses new work', async () => {
    const { forum, d } = client(() => 'hang');
    const a = forum.post('T1', { content: 'a' });
    const b = forum.post('T2', { content: 'b' });
    await settle();
    forum.dispose();
    expect(d.calls[0]!.init.signal.aborted).toBe(true);
    await settle(120_000);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(d.calls).toHaveLength(1);
    expect(await forum.post('T3', { content: 'c' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposing during a 429 wait stops the retry', async () => {
    const { forum, d } = client(() => ({ status: 429, json: { retry_after: 5 } }));
    const r = forum.post('T1', { content: 'x' });
    await settle(1000);
    forum.dispose();
    await settle(60_000);
    expect(await r).toBeNull();
    expect(d.calls).toHaveLength(1);
  });

  it('an answer that already arrived is not thrown away by a dispose that follows it', async () => {
    let answer: (r: Response) => void = () => undefined;
    const fetchFn = (() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch;
    const forum = makeForumClient({ webhookUrl: WEBHOOK, fetch: fetchFn, logger: { warn: () => undefined }, random: () => 0.5 });
    const r = forum.openThread('t', { content: 'x' });
    await settle();
    forum.dispose();
    answer(new Response(JSON.stringify({ id: 'm', channel_id: 'T7' }), { status: 200 }));
    await settle();
    expect(await r).toEqual({ threadId: 'T7' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is idempotent', () => {
    const { forum } = client();
    forum.dispose();
    expect(() => forum.dispose()).not.toThrow();
  });
});
