// The conversation of curl.sh as a Node script that exits non-zero on any surprise. Run it against a service you started (a `chatwarden serve`, the container of this folder):
//   BASE=http://127.0.0.1:8787 KEY=<a service key> node examples/service/conformance.mjs
// Each step names what it asks and checks the answer against expectations.json (strings the JSON answer must contain), the file the C# sample reads too. The rooms and the players are named afresh
// every run, so it can run twice against one service. It never prints the key. Exit codes: 0 every step passed, 1 a step failed, the key was refused or the service could not be reached.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const BASE = (process.env.BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.KEY;
if (KEY === undefined || KEY === '') {
  console.error('KEY is not set: pass a service key in the KEY variable.');
  process.exit(1);
}

const doc = JSON.parse(await readFile(new URL('./expectations.json', import.meta.url), 'utf8'));
const expectations = new Map(doc.steps.map((step) => [step.name, step]));
const failures = [];

class Unreachable extends Error {}

async function send(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Unreachable(`could not reach ${BASE}: is the service running?`);
  }
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/** One step: the call has been made; the answer is checked against the file. */
function step(name, res) {
  const want = expectations.get(name);
  if (want === undefined) throw new Error(`expectations.json has no step named ${name}`);
  if (res.status === 401) {
    console.error('unauthorized: the service refused the key.');
    process.exit(1);
  }
  const problems = [];
  if (res.status !== 200) problems.push(`status ${res.status}, wanted 200`);
  for (const text of want.expect) if (!res.text.includes(text)) problems.push(`the answer lacks ${text}`);
  for (const header of want.headers ?? []) if (!res.headers.has(header)) problems.push(`the answer has no ${header} header`);
  if (problems.length > 0) {
    failures.push(name);
    console.error(`FAILED ${name}: ${problems.join('; ')}`);
  } else {
    console.log(`ok  ${name}`);
  }
  return res;
}

try {
  const run = randomBytes(4).toString('hex');
  const room = `conf-${run}`;
  const alice = { clientKey: `conformance-alice-${run}` };
  const bob = { clientKey: `conformance-bob-${run}` };
  const json = (res) => {
    try {
      return JSON.parse(res.text);
    } catch {
      return {};
    }
  };

  step('handshake', await send('GET', '/v1'));
  step('seat alice', await send('PUT', `/v1/rooms/${room}/seats/alice`, { who: alice, handle: 'alice' }));
  step('seat bob', await send('PUT', `/v1/rooms/${room}/seats/bob`, { who: bob, handle: 'bob' }));
  const clean = step('clean line', await send('POST', `/v1/rooms/${room}/seats/alice/lines`, { text: 'good luck, have fun' }, { 'idempotency-key': `clean-${run}` }));
  const lineId = json(clean).line?.id;
  const slur = { text: 'you zorbak' };
  step('slur refused', await send('POST', `/v1/rooms/${room}/seats/alice/lines`, slur, { 'idempotency-key': `slur-${run}` }));
  step('slur retried', await send('POST', `/v1/rooms/${room}/seats/alice/lines`, slur, { 'idempotency-key': `slur-${run}` }));
  step('report', await send('POST', `/v1/rooms/${room}/seats/bob/reports`, { target: 'alice', ...(lineId === undefined ? {} : { lineId }), reason: 'harassment' }, { 'idempotency-key': `report-${run}` }));
  step('pending notices', await send('POST', '/v1/notices/pending', { who: alice }));
  step('ack unknown notice', await send('POST', '/v1/notices/not-a-notice/ack', { who: alice }));
  step('record', await send('POST', '/v1/record', { who: alice }));
  step('restriction', await send('POST', '/v1/restriction', { who: alice }));
  step('doors check', await send('POST', '/v1/doors/check', { kind: 'join', who: alice }));
  step('name check', await send('POST', '/v1/names/check', { name: 'Plenk the Brave' }));
  step('name refused', await send('POST', '/v1/names/check', { name: 'Mr zorbak' }));
  step('mute', await send('PUT', `/v1/rooms/${room}/seats/bob/mutes/alice`));
  step('mutes list', await send('GET', `/v1/rooms/${room}/seats/bob/mutes`));
  step('unseat', await send('DELETE', `/v1/rooms/${room}/seats/alice`));
  step('close room', await send('DELETE', `/v1/rooms/${room}`));
} catch (error) {
  console.error(error instanceof Unreachable ? error.message : 'the conformance run stopped on an unexpected error.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`all ${expectations.size} steps passed`);
