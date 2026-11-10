// The consumer smoke scenario. scripts/smoke.mjs copies this file into a fresh ESM project and a fresh CommonJS project
// (as src/index.ts), installs the packed tarballs, typechecks it and runs it. It imports every entry point and subpath, and
// must compile under both NodeNext and `module: commonjs` + `moduleResolution: node`, so: no top-level await, no import.meta.
// Any failed assertion throws and the process exits non-zero.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createChatwarden } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { discordFeed } from '@chatwarden/discord';
import { healthRoutes } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import { LiveTerms } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { syntheticTermPack as legacySyntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { createProfanityFilter } from '@chatwarden/profanity';
import { openStore } from '@chatwarden/store-sqlite';

const ROOM = 'lobby';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/smoke-token_ABC';

async function main(): Promise<void> {
  // The deprecated alias still resolves, and hands out the same pack.
  assert.equal(typeof legacySyntheticTermPack, 'function', 'matcher/test-fixtures alias exports syntheticTermPack');
  assert.deepEqual(legacySyntheticTermPack(), syntheticTermPack(), 'the alias and /fixtures agree');

  // 1. An in-memory store.
  const store = openStore({ path: ':memory:' });
  assert.ok(store, 'openStore returned a store');

  // 2. The kit, with the synthetic pack through LiveTerms.
  const clock = { now: () => Date.now() };
  const terms = new LiveTerms({ store, pack: syntheticTermPack(), clock });
  await terms.load();
  const cw = await createChatwarden({
    store,
    secret: 'smoke-secret-not-for-production',
    platform: { identify: (ctx) => ctx as RawWho },
    matcher: terms,
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

  // 9. The Discord feed, with a fake fetch that never leaves the machine.
  const posted: string[] = [];
  const feed = discordFeed(cw, {
    webhookUrl: WEBHOOK,
    hubLink: (kind, id) => `https://hub.example/${kind}/${encodeURIComponent(id)}`,
    fetch: (input) => {
      posted.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  });
  assert.equal(typeof feed.dispose, 'function');
  feed.dispose();
  feed.dispose(); // safe to call twice

  // 10. Close everything.
  await cw.close();
  await store.close();
  console.log('smoke scenario: ok');
}

main().catch((err: unknown) => {
  console.error('smoke scenario: FAILED', err);
  process.exit(1);
});
