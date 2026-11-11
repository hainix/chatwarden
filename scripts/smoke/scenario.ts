// The consumer smoke scenario. scripts/smoke.mjs copies this file into a fresh ESM project and a fresh CommonJS project
// (as src/index.ts), installs the packed tarballs, typechecks it and runs it. It imports every entry point and subpath, and
// must compile under both NodeNext and `module: commonjs` + `moduleResolution: node`, so: no top-level await, no import.meta.
// Any failed assertion throws and the process exits non-zero.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createChatwarden, VERSION as CORE_VERSION } from '@chatwarden/core';
import type { RawWho, Store } from '@chatwarden/core';
import { discordFeed } from '@chatwarden/discord';
import { healthRoutes, playerRoutes, VERSION as HTTP_VERSION } from '@chatwarden/http';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';
import { toExpress } from '@chatwarden/http/express';
import { defineChatwardenHub, VERSION as ELEMENT_VERSION } from '@chatwarden/hub-element/standalone';
import { createHubClient, Hub, memoryRouter, routerTransport, VERSION as HUB_VERSION } from '@chatwarden/hub-react';
import { createHubController } from '@chatwarden/hub-react/headless';
import { buildMatcher, LiveTerms } from '@chatwarden/matcher';
import type { Matcher } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { syntheticTermPack as legacySyntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { createPlayerClient, routerTransport as playerTransport, VERSION as PLAYER_VERSION } from '@chatwarden/player-react';
import { createProfanityFilter } from '@chatwarden/profanity';
import { createMemoryStore } from '@chatwarden/store-memory';
import { openStore } from '@chatwarden/store-sqlite';

const ROOM = 'lobby';
const clock = { now: () => Date.now() };
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/smoke-token_ABC';

async function main(): Promise<void> {
  // The deprecated alias still resolves, and hands out the same pack.
  assert.equal(typeof legacySyntheticTermPack, 'function', 'matcher/test-fixtures alias exports syntheticTermPack');
  assert.deepEqual(legacySyntheticTermPack(), syntheticTermPack(), 'the alias and /fixtures agree');

  // The same scenario on both stores. SQLite (in memory) also keeps the term list, so LiveTerms reads the pack through it.
  const sqlite = openStore({ path: ':memory:' });
  assert.ok(sqlite, 'openStore returned a store');
  const terms = new LiveTerms({ store: sqlite, pack: syntheticTermPack(), clock });
  await terms.load();
  await scenario('store-sqlite', sqlite, terms);

  // store-memory has no term list; the matcher is built straight from the synthetic pack (what a browser demo does).
  const memory = createMemoryStore();
  assert.equal(memory.schemaVersion(), 0, 'a memory store has no schema');
  const pack = syntheticTermPack();
  await scenario('store-memory', memory, buildMatcher(pack.terms, pack.exceptions));

  console.log('smoke scenario: ok');
}

async function scenario(label: string, store: Store, matcher: Matcher): Promise<void> {
  // 2. The kit.
  const cw = await createChatwarden({
    store,
    secret: 'smoke-secret-not-for-production',
    platform: { identify: (ctx) => ctx as RawWho },
    matcher,
    profile: 'relaxed',
    profanityPackage: { createProfanityFilter },
    clock,
    retention: false,
  });

  // 3. Two players take seats.
  const alice: RawWho = { clientKey: 'smoke-key-alice-000000000001', ip: '127.0.0.1' };
  const bob: RawWho = { clientKey: 'smoke-key-bob-00000000000002', ip: '127.0.0.1' };
  cw.rooms.seat(ROOM, 'a', alice, 'Alice');
  cw.rooms.seat(ROOM, 'b', bob, 'Bob');
  const aliceSubject = cw.rooms.subjectAt(ROOM, 'a');
  const bobSubject = cw.rooms.subjectAt(ROOM, 'b');
  assert.ok(aliceSubject && bobSubject, 'both seats resolve to a subject');
  assert.notEqual(aliceSubject, bobSubject, 'two players are two subjects');

  // The Discord feed, with a fake fetch that never leaves the machine. It is wired before the report so it sees it.
  const posted: Array<{ url: string; body: { content?: unknown; thread_name?: unknown } }> = [];
  const feed = discordFeed(cw, {
    webhookUrl: WEBHOOK,
    hubLink: (kind, id) => `https://hub.example/${kind}/${encodeURIComponent(id)}`,
    fetch: (input, init) => {
      const url = String(input);
      posted.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as { content?: unknown; thread_name?: unknown } });
      // Discord answers a new thread with the message, whose channel_id is the thread id.
      return Promise.resolve(new Response(JSON.stringify({ id: '111111111111111111', channel_id: '222222222222222222' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  });

  // 4. A clean line is delivered; a synthetic slur line is refused.
  const clean = cw.chat.accept(ROOM, 'a', 'hello there');
  assert.ok('deliver' in clean, 'a clean line is delivered');
  assert.equal(clean.deliver.text, 'hello there');
  const slur = cw.chat.accept(ROOM, 'a', 'you zorbak');
  assert.ok('refuse' in slur, 'a synthetic slur line is refused');
  assert.equal(slur.refuse.reason, 'blocked');

  // 5. Bob reports Alice.
  const reported = await cw.reports.submit({ roomId: ROOM, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  assert.ok(reported.ok, 'the report was accepted');
  const reportId = reported.reportId;
  assert.equal(cw.reports.get(reportId)?.status, 'open');

  // The report reached the fake Discord: one request that opens a thread, in plain staff text with no chat text.
  for (let i = 0; i < 200 && posted.length === 0; i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.ok(posted.length >= 1, 'the Discord fake received a post for the report');
  const first = posted[0];
  assert.ok(first, 'the first post');
  assert.ok(first.url.startsWith(WEBHOOK), 'it was posted to the webhook');
  assert.equal(typeof first.body.thread_name, 'string', 'the first post opens a forum thread');
  assert.equal(typeof first.body.content, 'string');
  assert.ok(!String(first.body.content).includes('zorbak'), 'no chat text reaches Discord');

  // 6. A moderator decides: Alice gets a warning citing Community Rule 2.
  const decided = await cw.decide({
    reportId,
    verdict: 'upheld',
    reason: 'smoke test',
    actor: 'smoke-moderator',
    actions: [{ subject: aliceSubject, kind: 'warning', durationMs: null, rule: 2 }],
  });
  assert.ok(decided.ok, 'the decision was applied');
  assert.equal(decided.groups.length, 1);
  assert.equal(cw.reports.get(reportId)?.status, 'actioned');

  // 7. Alice reads her own notice through the player surface.
  const notices = cw.notices.pending(alice);
  assert.equal(notices.length, 1, 'one pending notice');
  const notice = notices[0];
  assert.ok(notice);
  assert.equal(notice.kind, 'warning');
  assert.equal(notice.rule, 2);
  assert.equal(notice.mustAcknowledge, true);
  assert.equal(cw.notices.pending({ clientKey: 'smoke-key-nobody-0000000003' }).length, 0, 'a stranger has none');

  // The browser-safe staff entry (`@chatwarden/http/admin`): the same routes, called without a server. GET /me needs only a
  // signed-in caller; a caller with no role is 401.
  const staff = createRouter(adminRoutes(cw, { authorize: (req) => (req.headers['x-role'] === 'owner' ? { actor: 'smoke-staff', role: 'owner' } : null) }));
  const me = await staff({ method: 'GET', path: '/me', query: {}, headers: { 'x-role': 'owner' }, body: undefined });
  assert.equal(me.status, 200, 'GET /me is 200 for a signed-in owner');
  const meBody = me.body as { actor: string; role: string; can: Record<string, boolean> };
  assert.equal(meBody.role, 'owner');
  assert.equal(meBody.actor, 'smoke-staff');
  assert.ok(Object.values(meBody.can).length > 0 && Object.values(meBody.can).every((v) => v === true), 'an owner may do everything');
  assert.equal(me.headers?.['cache-control'], 'no-store', 'staff answers are not cached');
  const anon = await staff({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
  assert.equal(anon.status, 401, 'GET /me is 401 with no caller');

  // The React packages, run for real. CommonJS reaches these ES-module packages through Node's require(esm) (Node 22.13 or newer,
  // the kit's floor), and the same compiled code runs here as in the ESM project. The hub is rendered to a string on the server
  // over the staff router above, so React, the hub's code and the staff client all execute; no DOM is needed for that.
  const hubClient = createHubClient(routerTransport(staff, { headers: { 'x-role': 'owner' } }));
  assert.equal((await hubClient.me()).role, 'owner', 'the hub client reads GET /me through the router transport');
  const hubHtml = renderToString(createElement(Hub, { client: hubClient, router: memoryRouter('/') }));
  assert.ok(hubHtml.includes('cw-hub'), 'the hub renders on the server');
  assert.equal(typeof createHubController, 'function', '@chatwarden/hub-react/headless is importable beside React');

  // The player side: the player client reads Alice's notice (step 7) over the real player routes, with her key as her identity.
  const playerHandle = createRouter(playerRoutes(cw, { identify: (req) => ({ clientKey: req.headers['x-chatwarden-key'] }) }));
  const player = createPlayerClient({ transport: playerTransport(playerHandle, { headers: { 'x-chatwarden-key': alice.clientKey ?? '' } }) });
  const pending = await player.notices();
  assert.equal(pending.length, 1, 'the player client sees the one pending notice');
  assert.equal(pending[0]?.kind, 'warning');
  assert.ok((await player.rules()).rules.length > 0, 'the player client reads the rules');

  // The element script loads in Node, where there is no custom element registry: it registers nothing and does not throw.
  assert.equal(typeof defineChatwardenHub(), 'function');
  assert.equal(typeof (globalThis as { customElements?: unknown }).customElements, 'undefined', 'no custom element registry in Node');

  // One release: every package that exports VERSION says the same.
  for (const v of [HTTP_VERSION, HUB_VERSION, PLAYER_VERSION, ELEMENT_VERSION]) assert.equal(v, CORE_VERSION, 'the packages share one version');

  // 8. The probes, mounted through the Express adapter on an ephemeral port.
  const app = express();
  app.use(toExpress(healthRoutes(cw), { fallthrough: false }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200, 'GET /healthz is 200');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 9. Close everything. The feed's dispose is safe to call twice.
  assert.equal(typeof feed.dispose, 'function');
  feed.dispose();
  feed.dispose();
  await cw.close();
  await store.close();
  console.log(`smoke scenario (${label}): ok`);
}

main().catch((err: unknown) => {
  console.error('smoke scenario: FAILED', err);
  process.exit(1);
});
