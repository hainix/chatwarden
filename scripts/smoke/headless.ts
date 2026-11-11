// The headless smoke scenario: scripts/smoke.mjs copies this into a third consumer project (ESM) that holds only
// @chatwarden/core, @chatwarden/http and @chatwarden/hub-react, and NO React: react and react-dom are optional peers of hub-react, so
// npm does not install them, and this project asks for nothing that would (player-react and hub-element do).
// It must succeed: `@chatwarden/hub-react/headless` is the hub's behaviour with no React and no DOM, for Vue, Svelte, Solid or plain code.
// It also says, by testing it, what does NOT work without React: the React entry `@chatwarden/hub-react`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHubClient, createHubController, createStore, createT, en, formatDuration } from '@chatwarden/hub-react/headless';
import type { Transport } from '@chatwarden/hub-react/headless';

// The specifiers are held in variables on purpose: this project has no React types, so a literal import of them would fail the
// typecheck. Whether Node can load them is the question being asked here.
const react: string = 'react';
const reactEntry: string = '@chatwarden/hub-react';

async function main(): Promise<void> {
  // 1. React is absent, by resolve and by import.
  const require = createRequire(import.meta.url);
  assert.throws(() => require.resolve('react'), /Cannot find module/, 'react is not installed in this project');
  assert.throws(() => require.resolve('react-dom'), /Cannot find module/, 'react-dom is not installed in this project');
  await assert.rejects(import(react), 'import(react) fails');

  // 2. The headless entry loads and runs anyway. A canned transport stands in for the staff API.
  const calls: string[] = [];
  const transport: Transport = (req) => {
    calls.push(`${req.method} ${req.path}`);
    if (req.path === '/me') return Promise.resolve({ status: 200, headers: {}, body: { actor: 'smoke-staff', role: 'owner', can: { 'reports.read': true } } });
    return Promise.resolve({ status: 404, headers: {}, body: { error: 'not_found', message: 'no such route' } });
  };
  const client = createHubClient(transport);
  const me = await client.me();
  assert.equal(me.role, 'owner');
  assert.deepEqual(calls, ['GET /me']);

  // 3. The controller and the stores are built without a DOM.
  assert.equal(typeof createHubController, 'function');
  const store = createStore(1);
  let told = 0;
  const off = store.subscribe(() => told++);
  store.set(2);
  store.set(2);
  off();
  store.set(3);
  assert.equal(store.getSnapshot(), 3);
  assert.equal(told, 1, 'a listener hears each change once, and none after it unsubscribes');

  // 4. The words and the formatters need no DOM either.
  const t = createT(en, 'en');
  assert.equal(typeof t, 'function');
  assert.equal(typeof formatDuration(90 * 60_000, 'en'), 'string');

  // 5. The same entry through require(): the CommonJS way in, on Node 22.13 or newer (require of an ES module). One module, not two.
  const viaRequire = require('@chatwarden/hub-react/headless') as { createHubController: unknown; createStore: unknown };
  assert.equal(viaRequire.createHubController, createHubController, 'require() and import give the same module');
  assert.equal(viaRequire.createStore, createStore);

  // 6. What does not work without React, tested rather than assumed: the React entry needs it.
  await assert.rejects(import(reactEntry), 'the React entry cannot load without React');

  console.log('smoke scenario (headless, no React): ok');
}

main().catch((err: unknown) => {
  console.error('smoke scenario (headless): FAILED', err);
  process.exit(1);
});
