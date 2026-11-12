import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// CW_DEMO_PACE=1 (or the `demoPace` option) turns on a 2 second slow mode, so flood control can be seen with the chat box and over the
// WebSocket with no setup: a second line inside two seconds is refused with `slow_mode` and the wait. Without it nothing changes.

const ambient = { demo: process.env.CW_DEMO_PACE, url: process.env.DISCORD_WEBHOOK_URL, role: process.env.DISCORD_MENTION_ROLE_ID };
beforeAll(() => {
  delete process.env.CW_DEMO_PACE;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_MENTION_ROLE_ID;
});
afterEach(() => {
  delete process.env.CW_DEMO_PACE;
});
afterAll(() => {
  for (const [key, value] of [['CW_DEMO_PACE', ambient.demo], ['DISCORD_WEBHOOK_URL', ambient.url], ['DISCORD_MENTION_ROLE_ID', ambient.role]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const servers: TinyChat[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const ws of sockets) ws.close();
  for (const s of servers) await s.close();
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({ port: 0, secret: 'pace-test-secret-not-for-production', discordWebhookUrl: '', ...opts });
  servers.push(server);
  return server;
}

type Frame = Record<string, unknown>;
const keyOf = (name: string): string => `demo-key-${name}-0001-secret`;

/** A socket that has been welcomed; `say` sends a line and resolves with the next chat or refused frame. */
async function connect(server: TinyChat, name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${keyOf(name)}`);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (data) => void frames.push(JSON.parse(data.toString()) as Frame));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const until = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
    if (!pred()) throw new Error('timed out waiting for the server');
  };
  await until(() => frames.some((f) => f.type === 'welcome'));
  const say = async (text: string): Promise<Frame> => {
    const from = frames.length;
    ws.send(JSON.stringify({ type: 'chat', text }));
    await until(() => frames.slice(from).some((f) => f.type === 'chat' || f.type === 'refused'));
    return frames.slice(from).find((f) => f.type === 'chat' || f.type === 'refused') as Frame;
  };
  return { say, frames };
}

async function chatLine(server: TinyChat, name: string, text: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/chat/rooms/lobby/lines`, {
    method: 'POST',
    headers: { 'x-chatwarden-key': keyOf(name), 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('tiny-chat with CW_DEMO_PACE', () => {
  it('refuses a second line inside two seconds with slow_mode and no refusal without it', async () => {
    const without = await boot();
    const plain = await connect(without, 'quissel');
    expect((await plain.say('first line here')).type).toBe('chat');
    expect((await plain.say('second line right after')).type).toBe('chat');

    process.env.CW_DEMO_PACE = '1';
    const withPace = await boot();
    const paced = await connect(withPace, 'quissel');
    expect((await paced.say('first line here')).type).toBe('chat');
    const refused = await paced.say('second line right after');
    expect(refused).toMatchObject({ type: 'refused', reason: 'slow_mode' });
    const wait = refused.retryAfterMs;
    expect(typeof wait).toBe('number');
    expect(wait as number).toBeGreaterThan(0);
    expect(wait as number).toBeLessThanOrEqual(2000);
  });

  it('the refusal carries the reason and the wait only: no rule, no notice, no identifier', async () => {
    const server = await boot({ demoPace: true });
    const a = await connect(server, 'vlemmo');
    await a.say('hello there friend');
    const refused = await a.say('and again straight away');
    expect(Object.keys(refused).sort()).toEqual(['reason', 'retryAfterMs', 'type']);
    expect(JSON.stringify(refused)).not.toMatch(/s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}|vlemmo/);
  });

  it('refuses the second HTTP chat line inside two seconds (the chat box shows it as slow mode)', async () => {
    process.env.CW_DEMO_PACE = '1';
    const server = await boot();
    const first = await chatLine(server, 'drakkuun', 'hello from the box');
    expect(first.json).toMatchObject({ ok: true });
    const second = await chatLine(server, 'drakkuun', 'and one more');
    expect(second.json).toMatchObject({ ok: false, refused: { reason: 'slow_mode' } });
    const wait = (second.json.refused as { retryAfterMs: number }).retryAfterMs;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(2000);
  });

  it('is per player: another player in the same room is not held back by it', async () => {
    const server = await boot({ demoPace: true });
    expect((await chatLine(server, 'fenrisk', 'first from one')).json).toMatchObject({ ok: true });
    expect((await chatLine(server, 'tarvo', 'first from two')).json).toMatchObject({ ok: true });
    expect((await chatLine(server, 'fenrisk', 'second from one')).json).toMatchObject({ ok: false });
  });

  it('only exactly 1 turns it on; the option wins over the environment, and false forces it off', async () => {
    process.env.CW_DEMO_PACE = 'yes';
    const notOne = await boot();
    expect(notOne.chatwarden.profile.pace.slowModeMs).toBeNull();
    process.env.CW_DEMO_PACE = '1';
    const on = await boot();
    expect(on.chatwarden.profile.pace.slowModeMs).toBe(2000);
    const off = await boot({ demoPace: false });
    expect(off.chatwarden.profile.pace.slowModeMs).toBeNull();
  });

  it('with nothing set, nothing is paced and the profile has no pace at all', async () => {
    const server = await boot();
    expect(server.chatwarden.profile.pace).toEqual({ slowModeMs: null, burst: null, duplicateWindowMs: null });
  });

  it('an adopter\'s own pace override still applies beside the demo switch (its fields win)', async () => {
    const server = await boot({ demoPace: true, overrides: { pace: { slowModeMs: 3000, duplicateWindowMs: 10_000 } } });
    expect(server.chatwarden.profile.pace).toEqual({ slowModeMs: 3000, burst: null, duplicateWindowMs: 10_000 });
  });

  it('saying so on the console: the switch announces itself once', async () => {
    const logged: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      await boot({ demoPace: true });
    } finally {
      console.warn = real;
    }
    expect(logged.filter((l) => /CW_DEMO_PACE/.test(l))).toHaveLength(1);
  });
});
