import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// CW_DEMO_FILTERS=1 (or the `demoFilters` option) turns on three chat filters, so they can be seen with the chat box and over the WebSocket with no
// setup: a link is refused, a phone number is masked, and a "buy gold" phrase is delivered and files a report with no reporter that a moderator reads in
// the queue. Without it none of this exists.

const AMBIENT = ['CW_DEMO_FILTERS', 'DISCORD_WEBHOOK_URL', 'DISCORD_MENTION_ROLE_ID'] as const;
const ambient = Object.fromEntries(AMBIENT.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of AMBIENT) delete process.env[k];
});
afterEach(() => {
  delete process.env.CW_DEMO_FILTERS;
});
afterAll(() => {
  for (const k of AMBIENT) {
    if (ambient[k] === undefined) delete process.env[k];
    else process.env[k] = ambient[k];
  }
});

const servers: TinyChat[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const ws of sockets) ws.close();
  for (const s of servers) await s.close();
});

const TOKEN = 'tiny-chat-filters-admin-token';
async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({ port: 0, secret: 'filters-test-secret-not-for-production', discordWebhookUrl: '', adminToken: TOKEN, ...opts });
  servers.push(server);
  return server;
}

type Frame = Record<string, unknown>;
const keyOf = (name: string): string => `demo-key-${name}-0001-secret`;

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
  return { say, frames, until };
}

async function chatLine(server: TinyChat, name: string, text: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/chat/rooms/lobby/lines`, {
    method: 'POST',
    headers: { 'x-chatwarden-key': keyOf(name), 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const admin = async (server: TinyChat, path: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${server.port}/admin${path}`, { headers: { 'x-admin-token': TOKEN } });
  return (await res.json()) as Record<string, unknown>;
};

describe('tiny-chat with CW_DEMO_FILTERS', () => {
  it('refuses a link, masks a phone number and files a flag report a second moderator sees with reporter null; without the variable none of it exists', async () => {
    const without = await boot();
    const plain = await connect(without, 'plenk');
    expect(await plain.say('see blorf.com now')).toMatchObject({ type: 'chat', text: 'see blorf.com now' });
    expect(await plain.say('call 555-010-9999 ok')).toMatchObject({ type: 'chat', text: 'call 555-010-9999 ok' });
    expect(await plain.say('buy gold now please')).toMatchObject({ type: 'chat' });
    expect(without.chatwarden.reports.list({}).items).toEqual([]);
    expect(without.chatwarden.profile.filters.links).toBeNull();

    process.env.CW_DEMO_FILTERS = '1';
    const server = await boot();
    const a = await connect(server, 'plenk');
    const refused = await a.say('see blorf.com now');
    expect(refused).toMatchObject({ type: 'refused', reason: 'link' });
    expect(Object.keys(refused).sort()).toEqual(['reason', 'rule', 'type']);
    expect(JSON.stringify(refused)).not.toContain('blorf');
    const masked = await a.say('call 555-010-9999 ok');
    expect(masked).toMatchObject({ type: 'chat', text: 'call ************ ok' });
    const flagged = await a.say('buy gold now please');
    expect(flagged).toMatchObject({ type: 'chat', text: 'buy gold now please' });
    await server.chatwarden.filters.stats({ days: 7 });
    const queue = (await admin(server, '/reports?status=open')) as { items: Array<Record<string, unknown>> };
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ reporterPerson: null, origin: 'filter', originKey: 'phrase.gold', reportedReason: 'spam', status: 'open' });
    const one = (await admin(server, `/reports/${queue.items[0]!.id as string}`)) as { report: Record<string, unknown> };
    expect(one.report).toMatchObject({ reporterPerson: null, origin: 'filter' });
    const stats = (await admin(server, '/filters/stats?days=7')) as { keys: Record<string, Record<string, number>> };
    expect(stats.keys['link.unlisted']).toMatchObject({ refuse: 1 });
    expect(stats.keys['phrase.gold']).toMatchObject({ flag: 1 });
  });

  it('the HTTP chat route answers the same refusals, and a second flag from the same person files nothing more', async () => {
    const server = await boot({ demoFilters: true });
    const link = await chatLine(server, 'quissel', 'visit blorf.com');
    expect(link.json).toMatchObject({ ok: false, refused: { reason: 'link' } });
    expect((link.json.refused as { rule: number }).rule).toBe(4);
    expect(JSON.stringify(link.json)).not.toContain('blorf');
    expect(await chatLine(server, 'quissel', 'buy gold now')).toMatchObject({ json: { ok: true } });
    await new Promise((r) => setTimeout(r, 10));
    expect(await chatLine(server, 'quissel', 'free gold buy gold now')).toMatchObject({ json: { ok: true } });
    await server.chatwarden.filters.stats({ days: 7 });
    expect(server.chatwarden.reports.list({ status: 'open' }).items).toHaveLength(1);
  });

  it('only exactly 1 turns it on; the option wins over the environment, and false forces it off', async () => {
    process.env.CW_DEMO_FILTERS = 'yes';
    expect((await boot()).chatwarden.profile.filters.links).toBeNull();
    process.env.CW_DEMO_FILTERS = '1';
    const on = await boot();
    expect(on.chatwarden.profile.filters.links?.action).toBe('refuse');
    expect(on.chatwarden.profile.filters.personalInfo?.action).toBe('mask');
    expect(on.chatwarden.profile.filters.phrases.map((p) => [p.id, p.action])).toEqual([['gold', 'flag']]);
    expect((await boot({ demoFilters: false })).chatwarden.profile.filters.links).toBeNull();
  });

  it('with nothing set, every filter block is off and the profile has no filters at all', async () => {
    const server = await boot();
    const f = server.chatwarden.profile.filters;
    expect([f.links, f.personalInfo, f.ratio, f.phrases]).toEqual([null, null, null, []]);
  });

  it('an adopter\'s own filters override still applies beside the demo switch (its blocks win)', async () => {
    const server = await boot({ demoFilters: true, overrides: { filters: { links: { action: 'count' } } } });
    expect(server.chatwarden.profile.filters.links?.action).toBe('count');
    expect(server.chatwarden.profile.filters.personalInfo?.action).toBe('mask');
  });
});
