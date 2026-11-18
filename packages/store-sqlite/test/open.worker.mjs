// A worker for open.race.test.ts: one connection that opens a shared file at the same moment as its siblings and reports what happened. Uses the built store (dist), because a worker thread does not
// run the test runner's TypeScript transform. The list holds the shipped migrations plus one test-only migration that counts how often it ran: a second run would add a second row (or fail).
import { parentPort, workerData } from 'node:worker_threads';
import { MIGRATIONS, openStore } from '../dist/src/index.js';

const { path, gate, size } = workerData;
const probe = { version: MIGRATIONS.at(-1).version + 1, sql: 'CREATE TABLE kit_race_probe (n INTEGER NOT NULL); INSERT INTO kit_race_probe (n) VALUES (1);' };
// Wait for every sibling, so the opens really overlap.
const flag = new Int32Array(gate);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < size) Atomics.wait(flag, 0, 1, 2);

let result;
try {
  const store = openStore({ path, migrations: [...MIGRATIONS, probe] });
  result = { ok: true, version: store.schemaVersion() };
  store.close();
} catch (err) {
  result = { ok: false, message: String(err?.message ?? err) };
}
parentPort?.postMessage(result);
