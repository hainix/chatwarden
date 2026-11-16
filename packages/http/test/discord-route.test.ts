import { describe, expect, it } from 'vitest';
import { discordBot } from '../src/discord/index.js';
import type { DiscordBotOptions } from '../src/discord/index.js';
import { createRouter } from '../src/router.js';
import { BODY_MAX_BYTES } from '../src/body.js';
import type { KitRequest } from '../src/types.js';
import { APP_ID, GUILD_ID, PATH, ROLE_MOD, answerOf, fakeDiscordClient, newPair, recordingLogger } from './discord-world.js';
import { world } from './world.js';

// The interactions route, as the router serves it (K5 D3, Review Focus 1): verify before parse, one 401, a 413 before any crypto, PING.

const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${id}`;

async function setup(over: Partial<DiscordBotOptions> = {}) {
  const w = await world();
  const client = fakeDiscordClient({ now: () => w.clock.now() });
  const { logged, logger } = recordingLogger();
  const bot = discordBot(w.cw, {
    applicationId: APP_ID,
    publicKey: client.publicKeyHex,
    guildId: GUILD_ID,
    roles: { moderator: [ROLE_MOD] },
    hubLink,
    clock: w.clock,
    logger,
    ...over,
  });
  const router = createRouter(bot.routes);
  return { w, client, bot, router, logged, send: (req: KitRequest) => router(req) };
}

const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized', message: 'Authentication is required.' } };

describe('the route: verification', () => {
  it('serves POST /discord/interactions and nothing else', async () => {
    const { bot } = await setup();
    expect(Object.keys(bot.routes)).toEqual(['POST /discord/interactions']);
  });

  it('every verification failure is the same 401 body with the same headers', async () => {
    const { client, send } = await setup();
    const other = newPair();
    const body = JSON.stringify({ type: 1, id: '1' });
    const SEC = Math.floor(1_800_000_000_000 / 1000);
    const bad: KitRequest[] = [
      client.raw(body, { pair: other }),
      client.raw(body, { sendRaw: `${body} ` }),
      client.raw(body, { timestamp: SEC - 301 }),
      client.raw(body, { timestamp: SEC + 301 }),
      client.raw(body, { timestamp: 'abc' }),
      client.raw(body, { headers: { 'x-signature-ed25519': undefined } }),
      client.raw(body, { headers: { 'x-signature-timestamp': undefined } }),
      client.raw(body, { headers: { 'x-signature-ed25519': 'ab'.repeat(63) } }),
      client.raw(body, { headers: { 'x-signature-ed25519': 'zz'.repeat(64) } }),
      client.raw('not json at all', { pair: other }),
    ];
    const results = [];
    for (const req of bad) results.push(await send(req));
    for (const r of results) expect({ status: r.status, body: r.body, headers: r.headers }).toEqual({ ...UNAUTHORIZED, headers: undefined });
  });

  it('a replayed request is the same 401 the second time', async () => {
    const { client, send } = await setup();
    const req = client.ping();
    expect((await send(req)).status).toBe(200);
    const again = await send(req);
    expect({ status: again.status, body: again.body }).toEqual(UNAUTHORIZED);
  });

  it('the body is not parsed before it is verified: a forbidden key or broken JSON under a bad signature is a 401, under a good one a 400', async () => {
    const { client, send } = await setup();
    const other = newPair();
    for (const raw of ['{"__proto__":{"x":1}}', '{broken', '{"constructor":1}']) {
      const forged = await send(client.raw(raw, { pair: other }));
      expect({ status: forged.status, body: forged.body }).toEqual(UNAUTHORIZED);
    }
    expect((await send(client.raw('{broken'))).status).toBe(400);
    expect((await send(client.raw('{"__proto__":{"x":1}}'))).status).toBe(400);
  });

  it('a verified body that is not a JSON object is a 400, never acted on', async () => {
    const { client, send } = await setup();
    for (const raw of ['[]', '5', 'null', '"x"', '']) expect([400], raw).toContain((await send(client.raw(raw))).status);
  });

  it('an absent rawBody is a 500 and a log, never a pass', async () => {
    const { send, logged } = await setup();
    const res = await send({ method: 'POST', path: PATH, query: {}, headers: {}, body: { type: 1 } });
    expect(res).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(logged).toEqual([['chatwarden.discord_bot_failed', { op: 'no_raw_body' }]]);
  });

  it('a body of 64 KiB + 1 is a 413 before any crypto (a bad signature does not turn it into a 401), 64 KiB is verified', async () => {
    const { client, send } = await setup();
    const big = 'a'.repeat(BODY_MAX_BYTES + 1);
    const res = await send(client.raw(big, { pair: newPair() }));
    expect(res.status).toBe(413);
    // the cap counts UTF-8 bytes: a 21 846 character string of 3-byte characters is over it
    const wide = String.fromCharCode(0x20ac).repeat(Math.floor(BODY_MAX_BYTES / 3) + 1);
    expect((await send(client.raw(wide, { pair: newPair() }))).status).toBe(413);
    const exact = `{"type":1,"pad":"${'a'.repeat(BODY_MAX_BYTES - 19)}"}`;
    expect(exact.length).toBe(BODY_MAX_BYTES);
    expect((await send(client.raw(exact))).status).toBe(200);
  });

  it('a non-POST on the path is not routed (405), with no verification work', async () => {
    const { send } = await setup();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await send({ method, path: PATH, query: {}, headers: {}, body: undefined });
      expect(res.status, method).toBe(405);
    }
  });

  it('a log line never holds a signature, a timestamp, the key or the body', async () => {
    const { client, send, logged } = await setup();
    await send(client.ping({ pair: newPair() }));
    await send({ method: 'POST', path: PATH, query: {}, headers: {}, body: undefined });
    const text = JSON.stringify(logged);
    expect(text).not.toContain(client.publicKeyHex);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('the timestamp tolerance option moves the window', async () => {
    const { client, send, w } = await setup({ timestampToleranceMs: 10_000 });
    const sec = Math.floor(w.clock.t / 1000);
    expect((await send(client.ping({ timestamp: sec - 11 }))).status).toBe(401);
    expect((await send(client.ping({ timestamp: sec - 10 }))).status).toBe(200);
  });
});

describe('the route: PING and what is not handled yet', () => {
  it('a PING answers 200 { type: 1 } with content-type application/json', async () => {
    const { client, send } = await setup();
    const res = await send(client.ping());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 1 });
    expect(res.headers?.['content-type']).toBe('application/json');
  });

  it('a PING needs a valid signature like everything else (Discord probes on purpose)', async () => {
    const { client, send } = await setup();
    expect((await send(client.ping({ pair: newPair() }))).status).toBe(401);
    expect((await send(client.ping({ headers: { 'x-signature-ed25519': undefined } }))).status).toBe(401);
  });

  it('an autocomplete, a modal and an unknown interaction type get one fixed ephemeral refusal and nothing else', async () => {
    const { client, send } = await setup();
    const answers = [];
    for (const type of [4, 5, 99, 0]) answers.push(await send(client.ofType(type)));
    for (const res of answers) {
      expect(res.status).toBe(200);
      const a = answerOf(res);
      expect(a.type).toBe(4);
      expect(a.data?.flags).toBe(64);
      expect(a.data?.allowed_mentions).toEqual({ parse: [] });
    }
    expect(new Set(answers.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('a type that is not a number is refused the same way', async () => {
    const { client, send } = await setup();
    const res = await send(client.signed({ type: 'ping', id: '1' }));
    expect(res.status).toBe(200);
    expect(answerOf(res).data?.flags).toBe(64);
  });
});

describe('the bot object', () => {
  it('commands() is the /chatwarden definition, a fresh copy each time', async () => {
    const { bot } = await setup();
    const a = bot.commands();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ name: 'chatwarden', type: 1, default_member_permissions: '1099511627776' });
    (a[0] as { name: string }).name = 'changed';
    expect(bot.commands()[0]?.name).toBe('chatwarden');
  });

  it('components() answers nothing until actions are set (D5), and dispose is safe twice', async () => {
    const { bot } = await setup();
    expect(bot.components({ kind: 'report', reportId: 'r' })).toBeUndefined();
    bot.dispose();
    expect(() => bot.dispose()).not.toThrow();
  });
});
