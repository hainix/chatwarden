import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEosClient } from '../src/eos/client.js';
import { TokenError, createTokenSource } from '../src/eos/token.js';
import { CLIENT_ID, CLIENT_SECRET, DEPLOYMENT, EOS_URL, fakeEos, recordingLogger } from './eos-world.js';
import type { FakeEosOptions } from './eos-world.js';

// K5 E1: the client-credentials token (cache, one shared request, refresh before expiry) and the small typed client over `fetch` (one refresh after a 401).
// Nothing here touches the network: `fetch` is the fake EOS and the clock is injected.

afterEach(() => {
  vi.useRealTimers();
});

function setup(over: { fake?: FakeEosOptions; fetch?: typeof fetch } = {}) {
  const fake = fakeEos(over.fake);
  const clock = { t: 1_800_000_000_000, now: () => clock.t };
  const { logged, logger } = recordingLogger();
  const f = over.fetch ?? fake.fetch;
  const tokens = createTokenSource({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, deploymentId: DEPLOYMENT, baseUrl: EOS_URL, fetch: f, clock, logger });
  const client = createEosClient({ tokens, baseUrl: EOS_URL, deploymentId: DEPLOYMENT, fetch: f });
  return { fake, clock, logged, logger, tokens, client };
}

const basic = (id = CLIENT_ID, secret = CLIENT_SECRET) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe('token', () => {
  it('asks the token endpoint as documented: Basic header, form body with grant_type and deployment_id, no redirects', async () => {
    const t = setup();
    const token = await t.tokens.get();
    expect(token).toBe('fake-access-token-1');
    const [call] = t.fake.calls;
    expect(call).toMatchObject({ method: 'POST', url: `${EOS_URL}/auth/v1/oauth/token`, redirect: 'manual' });
    expect(call?.headers['authorization']).toBe(basic());
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call?.body).toBe(`grant_type=client_credentials&deployment_id=${DEPLOYMENT}`);
    expect(t.logged).toEqual([]);
  });

  it('one request for concurrent callers, who all get the same token', async () => {
    const t = setup();
    const got = await Promise.all([t.tokens.get(), t.tokens.get(), t.tokens.get(), t.tokens.get(), t.tokens.get()]);
    expect(new Set(got).size).toBe(1);
    expect(t.fake.state.tokenRequests).toBe(1);
  });

  it('the token is reused until 60 s before expiry and refreshed after; the Basic header is built for each request', async () => {
    const t = setup({ fake: { expiresIn: 3600 } });
    expect(await t.tokens.get()).toBe('fake-access-token-1');
    t.clock.t += 3539_000;
    expect(await t.tokens.get()).toBe('fake-access-token-1');
    expect(t.fake.state.tokenRequests).toBe(1);
    t.clock.t += 1000; // 3540 s: exactly 60 s before the end
    expect(await t.tokens.get()).toBe('fake-access-token-2');
    expect(t.fake.state.tokenRequests).toBe(2);
    expect(t.fake.callsTo('/token').map((c) => c.headers['authorization'])).toEqual([basic(), basic()]);
  });

  it('a token that lives 60 s or less is never reused', async () => {
    const t = setup({ fake: { expiresIn: 60 } });
    await t.tokens.get();
    await t.tokens.get();
    expect(t.fake.state.tokenRequests).toBe(2);
  });

  it('invalidate() drops the token: the next get asks again', async () => {
    const t = setup();
    await t.tokens.get();
    t.tokens.invalidate();
    expect(await t.tokens.get()).toBe('fake-access-token-2');
  });

  it('a failed token request is logged by status and class only, rejects with a TokenError, and is not cached', async () => {
    const t = setup();
    t.fake.script.push({ on: 'token', status: 500, body: { access_token: 'leaked-token-in-error-body', secret: CLIENT_SECRET } });
    const err = await t.tokens.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect((err as TokenError).status).toBe(500);
    expect(t.logged).toEqual([['chatwarden.eos_failed', { op: 'token', status: 500 }]]);
    t.fake.script.push({ on: 'token', fail: true });
    const err2 = await t.tokens.get().catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(TokenError);
    expect((err2 as TokenError).status).toBeUndefined();
    expect(t.logged[1]).toEqual(['chatwarden.eos_failed', { op: 'token', error: 'TypeError' }]);
    // The next call asks again and succeeds.
    expect(await t.tokens.get()).toBe('fake-access-token-1');
    expect(t.fake.state.tokenRequests).toBe(3);
  });

  it('wrong credentials answer 401 from the token endpoint: a TokenError with status 401', async () => {
    const fake = fakeEos();
    const clock = { now: () => 1 };
    const { logged, logger } = recordingLogger();
    const tokens = createTokenSource({ clientId: CLIENT_ID, clientSecret: 'wrong-secret-0123456789', deploymentId: DEPLOYMENT, baseUrl: EOS_URL, fetch: fake.fetch, clock, logger });
    await expect(tokens.get()).rejects.toMatchObject({ name: 'TokenError', status: 401 });
    expect(logged).toEqual([['chatwarden.eos_failed', { op: 'token', status: 401 }]]);
  });

  it('a 429 carries the retry-after in milliseconds on the error', async () => {
    const t = setup();
    t.fake.script.push({ on: 'token', status: 429, headers: { 'retry-after': '7' } });
    await expect(t.tokens.get()).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
    t.fake.script.push({ on: 'token', status: 429, headers: { 'retry-after': 'soon' } });
    const err = (await t.tokens.get().catch((e: unknown) => e)) as TokenError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('hostile answers are a TokenError "BadAnswer": a missing, empty, spaced or huge token, a bad expires_in, text, an array, null', async () => {
    const answers: unknown[] = [
      {},
      { access_token: '', expires_in: 3599 },
      { access_token: 5, expires_in: 3599 },
      { access_token: 'has space', expires_in: 3599 },
      { access_token: 'x'.repeat(5000), expires_in: 3599 },
      { access_token: 'ok-token', expires_in: 0 },
      { access_token: 'ok-token', expires_in: -5 },
      { access_token: 'ok-token', expires_in: '3599' },
      { access_token: 'ok-token' },
      { access_token: 'ok-token', expires_in: null },
      [],
      null,
      'text',
    ];
    for (const body of answers) {
      const t = setup();
      t.fake.script.push({ on: 'token', status: 200, body });
      await expect(t.tokens.get(), JSON.stringify(body)?.slice(0, 40)).rejects.toBeInstanceOf(TokenError);
      expect(t.logged, JSON.stringify(body)?.slice(0, 40)).toEqual([['chatwarden.eos_failed', { op: 'token', error: 'BadAnswer' }]]);
    }
  });

  it('an answer that is not JSON, or is huge, is a BadAnswer and the huge one is not buffered', async () => {
    const pulled = { n: 0 };
    const chunk = new TextEncoder().encode('x'.repeat(8192));
    const huge = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled.n += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    const t = setup({ fetch: huge });
    await expect(t.tokens.get()).rejects.toBeInstanceOf(TokenError);
    expect(pulled.n).toBeLessThan(200_000);
    expect(t.logged).toEqual([['chatwarden.eos_failed', { op: 'token', error: 'BadAnswer' }]]);
    const plain = setup({ fetch: (() => Promise.resolve(new Response('<html>nope</html>', { status: 200 }))) as unknown as typeof fetch });
    await expect(plain.tokens.get()).rejects.toBeInstanceOf(TokenError);
  });

  it('a token request that never answers is aborted after 10 s and is a failure by class', async () => {
    const t = setup();
    vi.useFakeTimers();
    t.fake.script.push({ on: 'token', hang: true });
    const pending = t.tokens.get().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBeInstanceOf(TokenError);
    expect(t.logged).toHaveLength(1);
    expect(t.logged[0]?.[0]).toBe('chatwarden.eos_failed');
    expect(t.logged[0]?.[1]).toMatchObject({ op: 'token' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose aborts the request in flight, clears timers and every later get is a TokenError without a request', async () => {
    const t = setup();
    vi.useFakeTimers();
    t.fake.script.push({ on: 'token', hang: true });
    const pending = t.tokens.get().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5);
    t.tokens.dispose();
    expect(await pending).toBeInstanceOf(TokenError);
    expect(vi.getTimerCount()).toBe(0);
    const before = t.fake.calls.length;
    await expect(t.tokens.get()).rejects.toBeInstanceOf(TokenError);
    expect(t.fake.calls).toHaveLength(before);
    t.tokens.dispose();
  });
});

describe('client', () => {
  it('sends a Bearer token, JSON headers, no redirects, repeated query keys and an encoded path', async () => {
    const t = setup();
    const res = await t.client.findReports({ reportedPlayerIds: ['p-1', 'p-2'], startTime: '2026-11-16T10:00:00.000Z', offset: 0, limit: 50 });
    expect(res.status).toBe(200);
    const call = t.fake.callsTo(`/report/${DEPLOYMENT}`)[0];
    expect(call?.headers['authorization']).toBe('Bearer fake-access-token-1');
    expect(call?.headers['accept']).toBe('application/json');
    expect(call?.headers['content-type']).toBeUndefined();
    expect(call?.redirect).toBe('manual');
    expect(call?.query).toEqual([
      ['reportedPlayerId', 'p-1'],
      ['reportedPlayerId', 'p-2'],
      ['startTime', '2026-11-16T10:00:00.000Z'],
      ['pagination', 'true'],
      ['offset', '0'],
      ['limit', '50'],
      ['order', 'time:asc'],
    ]);
    expect(call?.headers['authorization']).not.toContain(CLIENT_SECRET);
    await t.client.userSanctions('a/b?c#d', { limit: 100, offset: 0 });
    expect(t.fake.calls.at(-1)?.path).toBe(`/sanctions/v1/${DEPLOYMENT}/users/a%2Fb%3Fc%23d`);
  });

  it('a 401 from an API call invalidates the token and retries once with a new one', async () => {
    const t = setup();
    await t.client.userSanctions('p-1', { limit: 100, offset: 0 });
    t.fake.expireTokens();
    const res = await t.client.userSanctions('p-1', { limit: 100, offset: 0 });
    expect(res.status).toBe(200);
    expect(t.fake.tokensIssued()).toBe(2);
    expect(t.fake.callsTo('/users/p-1').map((c) => c.headers['authorization'])).toEqual(['Bearer fake-access-token-1', 'Bearer fake-access-token-1', 'Bearer fake-access-token-2']);
  });

  it('a second 401 is the answer: exactly one refresh, never a loop', async () => {
    const t = setup();
    t.fake.script.push({ on: 'user', status: 401 }, { on: 'user', status: 401 });
    // Scripted answers come after the auth check, so a valid token reaches them: both attempts are scripted 401s.
    const res = await t.client.userSanctions('p-1', { limit: 100, offset: 0 });
    expect(res.status).toBe(401);
    expect(t.fake.callsTo('/users/p-1')).toHaveLength(2);
    expect(t.fake.tokensIssued()).toBe(2);
  });

  it('a token failure is an answer with the status (or 0 for no answer), never a throw, and no API call is made', async () => {
    const t = setup();
    t.fake.script.push({ on: 'token', status: 503 });
    expect((await t.client.userSanctions('p-1', { limit: 100, offset: 0 })).status).toBe(503);
    t.fake.script.push({ on: 'token', fail: true });
    expect((await t.client.userSanctions('p-1', { limit: 100, offset: 0 })).status).toBe(0);
    expect(t.fake.callsTo('/users/p-1')).toHaveLength(0);
    t.fake.script.push({ on: 'token', status: 429, headers: { 'retry-after': '3' } });
    expect(await t.client.userSanctions('p-1', { limit: 100, offset: 0 })).toMatchObject({ status: 429, retryAfterMs: 3000 });
  });

  it('a 429 gives retry-after in seconds as milliseconds; anything else is no wait', async () => {
    const t = setup();
    for (const [header, want] of [['5', 5000], ['0', 0], ['abc', undefined], ['Wed, 21 Oct 2026 07:28:00 GMT', undefined], ['-3', undefined], ['9999999999999', undefined]] as const) {
      t.fake.script.push({ on: 'user', status: 429, headers: { 'retry-after': header } });
      const res = await t.client.userSanctions('p-1', { limit: 100, offset: 0 });
      expect(res.status).toBe(429);
      expect(res.retryAfterMs, header).toBe(want);
    }
  });

  it('a 5xx and a 4xx are passed on with no body read; a 204 has no json', async () => {
    const t = setup();
    t.fake.script.push({ on: 'user', status: 503 });
    expect((await t.client.userSanctions('p-1', { limit: 100, offset: 0 })).status).toBe(503);
    t.fake.script.push({ on: 'delete', status: 400, body: { errorCode: 'x' } });
    const bad = await t.client.deleteSanctions(['00000000-0000-4000-8000-000000000001'], 'Lifted: M-AAAAA');
    expect(bad).toMatchObject({ status: 400 });
    expect(bad.json).toBeUndefined();
  });

  it('a 200 that is not JSON, or is huge, has no json and is not buffered', async () => {
    const pulled = { n: 0 };
    const chunk = new TextEncoder().encode('x'.repeat(8192));
    const huge = ((input: string | URL | Request) =>
      String(input).includes('/oauth/')
        ? Promise.resolve(new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }), { status: 200 }))
        : Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  pulled.n += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              }),
              { status: 200 },
            ),
          )) as unknown as typeof fetch;
    const t = setup({ fetch: huge });
    const res = await t.client.userSanctions('p-1', { limit: 100, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.json).toBeUndefined();
    expect(pulled.n).toBeLessThan(2_200_000);
    const text = setup({ fetch: ((input: string | URL | Request) => Promise.resolve(String(input).includes('/oauth/') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 })) : new Response('nope'))) as unknown as typeof fetch });
    expect((await text.client.userSanctions('p-1', { limit: 100, offset: 0 })).json).toBeUndefined();
  });

  it('a network failure on an API call rejects (the queue retries it by class)', async () => {
    const t = setup();
    t.fake.script.push({ on: 'user', fail: true });
    await expect(t.client.userSanctions('p-1', { limit: 100, offset: 0 })).rejects.toBeInstanceOf(TypeError);
  });

  it('the signal aborts a request in flight', async () => {
    const t = setup();
    t.fake.script.push({ on: 'user', hang: true });
    const controller = new AbortController();
    const pending = t.client.userSanctions('p-1', { limit: 100, offset: 0, signal: controller.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(new Error('stop'));
    expect(await pending).toBeInstanceOf(Error);
  });
});

describe('the client secret and the access token appear in no log line, error or stored row', () => {
  it('every failure path, seeded: logs, thrown errors and replies carry neither', async () => {
    const seededToken = 'SNERP-ACCESS-TOKEN-0123456789';
    const t = setup();
    const seen: string[] = [];
    const take = (v: unknown): void => void seen.push(typeof v === 'string' ? v : `${String(v)} ${JSON.stringify(v)} ${(v as Error | undefined)?.message ?? ''} ${(v as Error | undefined)?.stack ?? ''}`);
    t.fake.script.push({ on: 'token', status: 500, body: { access_token: seededToken, client_secret: CLIENT_SECRET } });
    take(await t.tokens.get().catch((e: unknown) => e));
    t.fake.script.push({ on: 'token', status: 200, body: { access_token: `${seededToken} with space`, expires_in: 5 } });
    take(await t.tokens.get().catch((e: unknown) => e));
    t.fake.script.push({ on: 'token', fail: true });
    take(await t.tokens.get().catch((e: unknown) => e));
    t.fake.script.push({ on: 'user', status: 400, body: { echoed: seededToken, secret: CLIENT_SECRET } });
    take(await t.client.userSanctions('p-1', { limit: 100, offset: 0 }));
    t.fake.script.push({ on: 'user', fail: true });
    take(await t.client.userSanctions('p-1', { limit: 100, offset: 0 }).catch((e: unknown) => e));
    take(JSON.stringify(t.logged));
    const all = seen.join('\n');
    for (const secret of [CLIENT_SECRET, Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'), seededToken, 'fake-access-token-']) expect(all).not.toContain(secret);
  });
});
