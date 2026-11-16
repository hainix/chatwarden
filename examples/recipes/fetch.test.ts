import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_WORD, LONG_TOKEN, ROOM, SECRET, hasHello, keyOf, listen, settle, withEnv } from './harness.js';
import type { Listening } from './harness.js';
import { getKit as getPlainKit, handler as plainHandler } from './cases/fetch-memory-element-none/chatwarden/handler.js';

// The generated Web fetch recipe (anything on Request and Response: Hono, Bun, Deno, SvelteKit, Remix), run by calling its handler.

const ORIGIN = 'http://localhost:3000';
const as = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'x-chatwarden-key': keyOf(name), ...extra });
const streams: Listening[] = [];

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, NODE_ENV: 'test', CHATWARDEN_TRUST_PROXY: undefined });
});
afterEach(() => {
  for (const s of streams.splice(0)) s.stop();
});
afterAll(async () => {
  await (await getPlainKit()).close();
  restoreEnv();
});

type Handler = (request: Request) => Promise<Response | null>;
const via = (handler: Handler) => async (url: string, init?: RequestInit): Promise<Response> => {
  const res = await handler(new Request(url, init));
  if (res === null) throw new Error('the handler passed');
  return res;
};

describe('fetch-memory-element-none: the handler answers Web Requests', () => {
  const handler = plainHandler as Handler;
  const getKit = getPlainKit;
  const call = via(handler);

  it('/admin/me is 401 without a token or with a short one, and owner with the long one', async () => {
    expect((await call(`${ORIGIN}/chatwarden/admin/me`)).status).toBe(401);
    expect((await call(`${ORIGIN}/chatwarden/admin/me`, { headers: { 'x-admin-token': 'short' } })).status).toBe(401);
    const ok = await call(`${ORIGIN}/chatwarden/admin/me`, { headers: { 'x-admin-token': LONG_TOKEN } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ role: 'owner' });
  });

  it('a blocked line is refused with rule 1 and reaches no other stream; the first frame is hello', async () => {
    const a = await listen(call, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('alice'));
    const b = await listen(call, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('bob'));
    streams.push(a, b);
    await a.until(hasHello);
    await b.until(hasHello);
    expect(a.frames()[0]).toMatchObject({ type: 'hello' });
    const post = (text: string): Promise<Response> =>
      call(`${ORIGIN}/chatwarden/chat/rooms/${ROOM}/lines`, { method: 'POST', headers: as('alice', { 'content-type': 'application/json' }), body: JSON.stringify({ text }) });
    expect(await (await post('hello bob')).json()).toMatchObject({ ok: true });
    await b.until((f) => f.some((x) => x.type === 'line'));
    expect(await (await post(`no ${BLOCKED_WORD}`)).json()).toMatchObject({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    await settle();
    expect(a.text() + b.text()).not.toContain(BLOCKED_WORD);
  });

  it('HEAD, a body over the cap (413) and a form type (400)', async () => {
    expect((await call(`${ORIGIN}/chatwarden/healthz`, { method: 'HEAD' })).status).toBe(200);
    const big = await call(`${ORIGIN}/chatwarden/chat/rooms/${ROOM}/lines`, { method: 'POST', headers: as('erin', { 'content-type': 'application/json' }), body: JSON.stringify({ text: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    const form = await call(`${ORIGIN}/chatwarden/chat/rooms/${ROOM}/lines`, { method: 'POST', headers: as('erin', { 'content-type': 'text/plain' }), body: '{"text":"hi"}' });
    expect(form.status).toBe(400);
  });

  it('an abort cancels the stream and stats().streams returns to 0', async () => {
    const kit = await getKit();
    const l = await listen(call, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('cara'));
    await l.until(hasHello);
    l.stop();
    const deadline = Date.now() + 3000;
    while (kit.chat.stats().streams > 0 && Date.now() < deadline) await settle(25);
    expect(kit.chat.stats().streams).toBe(0);
  });

  it('a path outside the prefix is not the handler: it resolves null so the host answers, and a path under it that the kit does not know passes too', async () => {
    expect(await handler(new Request(`${ORIGIN}/somewhere/else`))).toBeNull();
    expect(await handler(new Request(`${ORIGIN}/`))).toBeNull();
    expect(await handler(new Request(`${ORIGIN}/chatwarden-other/admin/me`))).toBeNull();
  });
});
