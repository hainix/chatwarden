// Run in the ESM consumer after `chatwarden init` and the compile: starts the server the bin wrote (src/chatwarden, compiled to dist/chatwarden) on a
// port the system picks, and checks what a first run must give: the health route answers, the staff hub refuses a request with no token, and the chat
// stream's first frame is `hello`. Copied into the project by scripts/smoke.mjs. The values below are made-up test values, not credentials.
/* global AbortController, fetch, TextDecoder */
import express from 'express';

process.env.CHATWARDEN_SECRET = 'smoke-secret-0123456789-0123456789-abcdef';
process.env.CHATWARDEN_ADMIN_TOKEN = 'smoke-staff-token-0123456789-abcdef';
process.env.NODE_ENV = 'test';

const { mountChatwarden } = await import('./dist/chatwarden/express.js');

const app = express();
const kit = await mountChatwarden(app);
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
const controller = new AbortController();

let failure;
try {
  const health = await fetch(`${base}/chatwarden/healthz`);
  if (health.status !== 200) throw new Error(`/chatwarden/healthz answered ${health.status}, expected 200`);

  const hub = await fetch(`${base}/chatwarden/mod`);
  if (hub.status !== 401) throw new Error(`/chatwarden/mod with no token answered ${hub.status}, expected 401`);

  const stream = await fetch(`${base}/chatwarden/chat/rooms/lobby/stream`, {
    headers: { accept: 'text/event-stream', 'x-chatwarden-key': 'snerp-key-smoke-0001-secret' },
    signal: controller.signal,
  });
  if (stream.status !== 200) throw new Error(`the chat stream answered ${stream.status}, expected 200`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 5000;
  while (!/^data: /m.test(text)) {
    if (Date.now() > deadline) throw new Error(`no chat frame within 5 s; got ${JSON.stringify(text.slice(0, 200))}`);
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const first = /^data: (.*)$/m.exec(text);
  const frame = first === null ? undefined : JSON.parse(first[1]);
  if (frame?.type !== 'hello') throw new Error(`the first chat frame is ${JSON.stringify(frame?.type)}, expected 'hello'`);
  console.log('[smoke] the generated server: healthz 200, the hub 401 without a token, the first chat frame is hello');
} catch (error) {
  failure = error;
} finally {
  controller.abort();
  await kit.close();
  await new Promise((resolve) => server.close(resolve));
}
if (failure !== undefined) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(1);
}
process.exit(0);
