import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, RawWho, ReportCategory } from '@chatwarden/core';
import { discordFeed } from '@chatwarden/discord';
import type { DiscordFeed } from '@chatwarden/discord';
import { MemoryStore } from '@chatwarden/store-memory';
import { decideAs } from '../src/admin/decideAs.js';
import { discordBot } from '../src/discord/index.js';
import type { DiscordBot } from '../src/discord/index.js';
import { toExpress } from '../src/express.js';
import { resolvePermissions } from '../src/permissions.js';
import { createRouter } from '../src/router.js';
import type { KitRequest } from '../src/types.js';
import { APP_ID, GUILD_ID, PATH, ROLE_MOD, ROLE_OWNER, ROLE_SENIOR, USER_ID, fakeDiscordClient, hubLink } from './discord-world.js';
import type { Answer } from './discord-world.js';

// The whole loop (K5 D8): the real core over the memory store, the real `discordFeed` with `components: bot.components` posting to a fake Discord webhook,
// the real `discordBot` routes behind the real router and `toExpress`, listening on port 0, and a real `fetch` as Discord. No network beyond localhost.
// The kit, the feed and the bot all use the real clock, so a request is signed with the real time.

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/tok_E2E-fake_123';
const DAY = 86_400_000;

interface Posted {
  method: string;
  url: URL;
  body: Record<string, unknown>;
}

/** A fake application-owned Discord webhook: it records every request and answers the way a bot-made webhook does. */
function fakeWebhook() {
  const calls: Posted[] = [];
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const n = calls.length;
    calls.push({ method: init?.method ?? 'GET', url: u, body: JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown> });
    if (init?.method === 'PATCH') return Promise.resolve(new Response('{}', { status: 200 }));
    const answer = u.searchParams.has('thread_id') ? { id: `m${n}`, application_id: APP_ID } : { id: `m${n}`, application_id: APP_ID, channel_id: `T${n}` };
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

interface Boot {
  cw: Chatwarden;
  bot: DiscordBot;
  feed: DiscordFeed;
  hook: ReturnType<typeof fakeWebhook>;
  client: ReturnType<typeof fakeDiscordClient>;
  base: string;
  /** Send a signed request over a real socket; the JSON answer. */
  http: (req: KitRequest) => Promise<{ status: number; body: unknown }>;
  click: (customId: string, roles?: string[]) => Promise<Answer>;
  file: (category?: ReportCategory) => Promise<{ id: string; target: string; key: string }>;
  close: () => Promise<void>;
}

async function boot(options: { actions?: { dismiss?: boolean; suggestion?: boolean; confirm?: boolean } } = {}): Promise<Boot> {
  const cw = await createChatwarden({
    store: new MemoryStore(),
    secret: 'discord-e2e-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    retention: false,
    // This world has no matcher and no profanity filter, which the kit says once on stderr; that is not what these tests are about.
    logger: { warn: () => undefined },
  });
  const client = fakeDiscordClient({ now: () => Date.now() });
  const bot = discordBot(cw, {
    applicationId: APP_ID,
    publicKey: client.publicKeyHex,
    guildId: GUILD_ID,
    roles: { moderator: [ROLE_MOD], senior: [ROLE_SENIOR], owner: [ROLE_OWNER] },
    hubLink,
    actions: options.actions ?? { dismiss: true, suggestion: true },
    // The follow-up is never needed here (the work is fast); a fetch that would leave the machine is refused.
    fetch: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch,
  });
  const hook = fakeWebhook();
  const feed = discordFeed(cw, { webhookUrl: WEBHOOK, hubLink, fetch: hook.fn, components: bot.components });
  const app = express();
  app.use('/', toExpress(bot.routes));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async (): Promise<void> => {
    feed.dispose();
    bot.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(close);

  const http = async (req: KitRequest): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...req.headers }, body: req.rawBody });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };
  let reportN = 0;
  const file = async (category: ReportCategory = 'harassment') => {
    const n = ++reportN;
    const room = `e2e-room-${n}`;
    const key = `raw-client-key-target-e2e-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-reporter-e2e-${n}`, ip: '198.51.100.23' }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: key, ip: '203.0.113.99' }, 'Tgt');
    cw.chat.accept(room, 'p2', 'a line from the target');
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = cw.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    return { id: res.reportId, target: report.targetPerson, key };
  };
  const click = async (customId: string, roles: string[] = [ROLE_MOD]): Promise<Answer> => {
    const res = await http(client.click(customId, { roles }));
    expect(res.status).toBe(200);
    return res.body as Answer;
  };
  return { cw, bot, feed, hook, client, base, http, click, file, close };
}

const buttonsOf = (a: Answer | Record<string, unknown> | undefined): Array<Record<string, unknown>> =>
  ((a as { components?: Array<{ components: Array<Record<string, unknown>> }> } | undefined)?.components ?? []).flatMap((row) => row.components);
const customIdOf = (buttons: Array<Record<string, unknown>>, prefix: string): string => {
  const hit = buttons.find((b) => typeof b.custom_id === 'string' && b.custom_id.startsWith(prefix));
  if (hit === undefined) throw new Error(`no button ${prefix}`);
  return hit.custom_id as string;
};

describe('Discord end to end: the real feed, the real bot, the real kit', () => {
  it('a report is filed: the feed posts it with the two buttons; the click on Nothing wrong here previews, Confirm decides, the feed posts the outcome and strips the buttons', async () => {
    const b = await boot();
    const f = await b.file();
    await until(() => b.hook.calls.length >= 1, 'the report post');
    const post = b.hook.calls[0]!;
    expect(post.method).toBe('POST');
    expect(post.url.searchParams.get('with_components')).toBe('true');
    const rows = post.body.components as Array<{ components: Array<Record<string, unknown>> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.components.map((c) => c.label)).toEqual(['Nothing wrong here', 'Apply suggestion', 'Open report']);
    expect(rows[0]!.components[2]).toMatchObject({ style: 5, url: hubLink('report', f.id) });

    const dis = customIdOf(rows[0]!.components, 'cw1:dis:');
    const preview = await b.click(dis);
    expect(preview).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    expect(preview.data?.content).toContain('Nothing wrong here?');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');

    const confirm = customIdOf(buttonsOf(preview.data), 'cw1:ok:');
    const done = await b.click(confirm);
    expect(done.type).toBe(7);
    expect(done.data?.content).toBe('Done \u00B7 No action');
    expect(b.cw.reports.get(f.id)?.status).toBe('dismissed');

    // The feed hears report.closed: the outcome is posted into the thread, then the buttons come off the first post.
    await until(() => b.hook.calls.some((c) => c.method === 'PATCH'), 'the strip');
    const closing = b.hook.calls[1]!;
    expect(closing.method).toBe('POST');
    expect(String(closing.body.content)).toContain('**Report closed**');
    const strip = b.hook.calls.find((c) => c.method === 'PATCH')!;
    expect(strip.url.pathname).toBe(`/api/webhooks/123456789012345678/tok_E2E-fake_123/messages/m0`);
    expect(strip.body).toEqual({ components: [], allowed_mentions: { parse: [] } });
    // A second click on the old button is answered from the report, not applied again.
    const late = await b.click(dis);
    expect(late.data?.content).toMatch(/^This report was already decided \(no action\)\./);
  });

  it('the same report decided in the hub first: the click answers already decided and the feed has already stripped the buttons', async () => {
    const b = await boot();
    const f = await b.file();
    await until(() => b.hook.calls.length >= 1, 'the report post');
    const rows = b.hook.calls[0]!.body.components as Array<{ components: Array<Record<string, unknown>> }>;
    const dis = customIdOf(rows[0]!.components, 'cw1:dis:');
    const sug = customIdOf(rows[0]!.components, 'cw1:sug:');
    // A moderator decides in the hub (the same path the staff route takes).
    await decideAs(b.cw, {
      reportId: f.id,
      decision: { verdict: 'no_action', actions: [] },
      actor: 'ann-the-moderator',
      role: 'moderator',
      permissions: resolvePermissions(undefined),
      claims: 'gate',
    });
    await until(() => b.hook.calls.some((c) => c.method === 'PATCH'), 'the strip');
    const strip = b.hook.calls.find((c) => c.method === 'PATCH')!;
    expect(strip.body.components).toEqual([]);
    for (const id of [dis, sug]) {
      const answer = await b.click(id);
      expect(answer.type).toBe(4);
      expect(answer.data?.content).toMatch(/^This report was already decided/);
    }
    expect(b.cw.reports.get(f.id)?.status).toBe('dismissed');
  });

  it("a suggestion click applies the ladder step; the player's notice exists (cw.notices.pending) and has no Discord identifier", async () => {
    const b = await boot();
    const f = await b.file();
    await until(() => b.hook.calls.length >= 1, 'the report post');
    const rows = b.hook.calls[0]!.body.components as Array<{ components: Array<Record<string, unknown>> }>;
    const sug = customIdOf(rows[0]!.components, 'cw1:sug:');
    const preview = await b.click(sug);
    expect(preview.data?.content).toContain('Apply this step?');
    const confirm = customIdOf(buttonsOf(preview.data), 'cw1:ok:');
    const done = await b.click(confirm);
    expect(done.type).toBe(7);
    expect(done.data?.content).toMatch(/^Done \u00B7 .+ \u00B7 M-[A-Z0-9]{5}$/);
    expect(b.cw.reports.get(f.id)?.status).toBe('actioned');

    const notices = b.cw.notices.pending({ clientKey: f.key });
    expect(notices.length).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(notices);
    for (const id of [USER_ID, GUILD_ID, APP_ID, ROLE_MOD]) expect(text).not.toContain(id);
    expect(text.toLowerCase()).not.toContain('discord');
    // The sanction row's actor is the Discord user as the audit shows it, never in the player's notice.
    expect(b.cw.sanctions.forPerson(f.target).some((s) => s.source === 'moderator')).toBe(true);
  });

  it('lookup answers a ref code from a sanction that the same test just applied', async () => {
    const b = await boot();
    const f = await b.file();
    const applied = await b.cw.sanctions.apply({
      kind: 'chat',
      subject: f.target,
      includeIp: false,
      durationMs: DAY,
      reason: 'a reason',
      actor: 'ann-the-moderator',
      source: 'moderator',
      automated: false,
      rule: 2,
    });
    const res = await b.http(b.client.lookup(applied.refCode));
    expect(res.status).toBe(200);
    const answer = res.body as Answer;
    expect(answer.type).toBe(4);
    expect(answer.data?.content).toContain(`**${applied.refCode}**`);
    expect(answer.data?.content).toContain('24 hours');
    // The same code in lower case, and one nobody holds.
    expect(((await b.http(b.client.lookup(applied.refCode.toLowerCase()))).body as Answer).data?.content).toContain(applied.refCode);
    expect(((await b.http(b.client.lookup('M-ZZZZZ'))).body as Answer).data?.content).toBe('No sanction found for that code.');
  });

  it('an unsigned POST to the real route is 401 over real HTTP; rawBody is the exact bytes (a body with unicode and a trailing newline verifies)', async () => {
    const b = await boot();
    const unsigned = await fetch(`${b.base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":1}' });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ error: 'unauthorized' });
    // Signed by someone else.
    const other = fakeDiscordClient({ now: () => Date.now() });
    expect((await b.http(other.ping())).status).toBe(401);
    // The exact bytes: non-ASCII text, odd spacing and a trailing newline all verify when signed as sent, and a changed byte does not.
    const word = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2603)} ${String.fromCodePoint(0x1f600)}`;
    const raw = `{ "type": 1,\n  "note": "${word}" }\n`;
    const ok = await b.http(b.client.raw(raw));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ type: 1 });
    const tampered = b.client.raw(raw, { sendRaw: raw.replace('caf', 'cag') });
    expect((await b.http(tampered)).status).toBe(401);
    // The same signed request sent twice is a replay (a signature is accepted once).
    const once = b.client.raw(`{ "type": 1, "note": "${word}", "n": 2 }
`);
    expect((await b.http(once)).status).toBe(200);
    expect((await b.http(once)).status).toBe(401);
  });

  it('dispose of the feed and the bot leaves no timer and no listener', async () => {
    const before = timeouts();
    const b = await boot();
    const f = await b.file();
    await until(() => b.hook.calls.length >= 1, 'the report post');
    const rows = b.hook.calls[0]!.body.components as Array<{ components: Array<Record<string, unknown>> }>;
    await b.click(customIdOf(rows[0]!.components, 'cw1:dis:'));
    const seen = b.hook.calls.length;
    await b.close();
    closers.length = 0;
    // The feed listens no more: a report after dispose posts nothing. The bot answers 401 to everything once disposed (the server is closed, so ask it directly).
    await b.file();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(b.hook.calls).toHaveLength(seen);
    const direct = await createRouter(b.bot.routes)(b.client.ping());
    expect(direct.status).toBe(401);
    expect(f.id).toBeTruthy();
    // No timer of ours is left behind (the answers cancelled theirs; dispose cleared the rest).
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(timeouts()).toBeLessThanOrEqual(before);
  });
});
