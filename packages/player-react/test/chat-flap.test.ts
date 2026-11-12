// @vitest-environment node
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { MemoryStore } from '@chatwarden/store-memory';
import { chatRoutes, createRoomBroadcaster } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import { createSseTransport } from '../src/chat/transport.js';
import type { ChatFrame } from '../src/chat/wire.js';

// The whole path, no fakes: the real kit, the real broadcaster and routes, a real HTTP server, and the real sseTransport reading it.
// One player with more tabs open than the broadcaster allows must NOT make their tabs push each other out for ever.

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function serve() {
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'flap-secret', platform: { identify: (ctx) => ctx as RawWho }, retention: false });
  const chat = createRoomBroadcaster(cw, { maxStreamsPerMember: 3 });
  const opens = { count: 0 };
  const app = express();
  app.use('/chat', (req, _res, next) => {
    if (req.method === 'GET' && req.path.endsWith('/stream')) opens.count += 1;
    next();
  });
  app.use(
    '/chat',
    toExpress(
      chatRoutes(cw, chat, {
        identify: (req) => ({ clientKey: req.headers['x-key'] ?? '' }),
        join: () => ({ name: 'plenk' }),
        openRateLimit: { max: 1000, windowMs: 60_000 },
      }),
      { fallthrough: false },
    ),
  );
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    chat.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`, chat, opens };
}

/** One tab: a transport on the player's key, its frames and statuses. Quick retries, so a flap would show within a second. */
function tab(base: string) {
  const frames: ChatFrame[] = [];
  const statuses: string[] = [];
  const transport = createSseTransport({ baseUrl: base, headers: { 'x-key': 'raw-client-key-plenk-0001' }, retry: { initialMs: 50, maxMs: 50 } }, { random: () => 0 });
  const conn = transport.open('lobby', {
    frame: (f) => void frames.push(f),
    status: (s, why) => void statuses.push(why === undefined ? s : `${s}:${why}`),
  });
  closers.push(() => conn.close());
  return { frames, statuses, conn };
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('more tabs than the limit', () => {
  it('a fourth tab replaces the oldest: that tab is told, closes, and does not come back; the other three stay open and quiet', async () => {
    const { base, chat, opens } = await serve();
    const tabs = [] as Array<ReturnType<typeof tab>>;
    for (let i = 0; i < 4; i += 1) {
      const t = tab(base);
      tabs.push(t);
      await until(() => t.statuses.includes('open'), `tab ${i + 1} to open`);
    }
    await until(() => tabs[0]?.statuses.includes('closed:replaced') === true, 'the oldest tab to be told');
    expect(tabs[0]?.frames.at(-1)).toEqual({ type: 'bye', reason: 'replaced' });
    // watch for a flap: with a 50 ms back-off any reconnect would show many times over in a second and a half
    const before = opens.count;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(opens.count).toBe(before);
    expect(opens.count).toBe(4);
    expect(chat.stats().streams).toBe(3);
    expect(tabs[0]?.statuses.at(-1)).toBe('closed:replaced');
    for (const t of tabs.slice(1)) expect(t.statuses).toEqual(['connecting', 'open']);
  }, 15_000);
});
