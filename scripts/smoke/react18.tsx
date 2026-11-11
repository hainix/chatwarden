// The React 18 smoke scenario: scripts/smoke.mjs copies this into a fourth consumer project (ESM, JSX) that holds @chatwarden/core, http,
// hub-react and player-react and React 18.3 (react@18.3, react-dom@18.3, @types/react@18). The packages say `react: ^18.3.0 || ^19.0.0`; the
// other projects get React 19 from npm, so this is the one that runs the 18.3 half of that range for real: the hub and the player components are
// rendered on the server with `renderToString` (React, the hooks and the stores all execute; no DOM is needed), and the headless entry is imported.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderToString } from 'react-dom/server';
import { Hub, createHubClient, memoryRouter } from '@chatwarden/hub-react';
import type { Transport as HubTransport } from '@chatwarden/hub-react';
import { createHubController, createStore } from '@chatwarden/hub-react/headless';
import { MyRecord, NoticeQueue, ReportDialog, RestrictedChatLine, RulesPage, createPlayerClient } from '@chatwarden/player-react';
import type { Transport as PlayerTransport } from '@chatwarden/player-react';

const require = createRequire(import.meta.url);
const versionOf = (name: string): string => (require(`${name}/package.json`) as { version: string }).version;

async function main(): Promise<void> {
  // 1. It is React 18.3 that is installed, not whatever npm finds newest.
  const react = versionOf('react');
  const reactDom = versionOf('react-dom');
  assert.ok(react.startsWith('18.3'), `react is 18.3.x, got ${react}`);
  assert.ok(reactDom.startsWith('18.3'), `react-dom is 18.3.x, got ${reactDom}`);

  // 2. The hub, on the server, over a stub client (a canned transport: GET /me answers, nothing else is asked for on a server render).
  const asked: string[] = [];
  const hubTransport: HubTransport = (req) => {
    asked.push(`${req.method} ${req.path}`);
    if (req.path === '/me') return Promise.resolve({ status: 200, headers: {}, body: { actor: 'smoke-staff', role: 'owner', can: { 'reports.read': true } } });
    return Promise.resolve({ status: 404, headers: {}, body: { error: 'not_found', message: 'no such route' } });
  };
  const hubClient = createHubClient(hubTransport);
  assert.equal((await hubClient.me()).role, 'owner', 'the stub client answers');
  const hubHtml = renderToString(<Hub client={hubClient} router={memoryRouter('/')} />);
  assert.ok(hubHtml.includes('cw-hub'), 'the hub renders on the server with React 18.3');
  assert.ok(asked.length >= 1, 'the stub client was reached');

  // 3. The player components, on the server, over a stub player client.
  const playerTransport: PlayerTransport = () => Promise.resolve({ status: 200, headers: {}, body: [] });
  const player = createPlayerClient({ transport: playerTransport });
  const parts: Record<string, string> = {
    NoticeQueue: renderToString(<NoticeQueue client={player} />),
    MyRecord: renderToString(<MyRecord client={player} />),
    RulesPage: renderToString(<RulesPage client={player} />),
    ReportDialog: renderToString(<ReportDialog onSubmit={() => Promise.resolve({ ok: true, reportId: 'r', remaining: 9 })} onClose={() => undefined} />),
    RestrictedChatLine: renderToString(<RestrictedChatLine until={null} byModerator />),
  };
  assert.ok(parts.ReportDialog?.includes('cw-dialog'), 'the report dialog renders (one tap: no reporting given)');
  assert.ok(parts.RestrictedChatLine?.includes('cw-player'), 'the restricted-chat line renders');
  for (const [name, html] of Object.entries(parts)) assert.equal(typeof html, 'string', `${name} rendered to a string`);

  // 4. The headless entry loads beside React 18.3 and builds the controller and a store.
  assert.equal(typeof createHubController, 'function');
  const store = createStore(1);
  store.set(2);
  assert.equal(store.getSnapshot(), 2);
  console.log(`smoke scenario (react ${react}): ok`);
}

main().catch((err: unknown) => {
  console.error('smoke scenario: FAILED', err);
  process.exit(1);
});
