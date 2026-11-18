// A worker for open.wal.test.ts: one connection that opens a FRESH file (still in the default rollback-journal mode) at the same moment as its siblings, so they race to switch it to WAL.
// Uses the built store (dist), because a worker thread does not run the test runner's TypeScript transform.
import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from '../dist/src/index.js';

const { path, gate, size } = workerData;
const flag = new Int32Array(gate);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < size) Atomics.wait(flag, 0, 1, 1);

let result;
try {
  const store = openStore({ path });
  result = { ok: true };
  store.close();
} catch (err) {
  result = { ok: false, message: String(err?.message ?? err) };
}
parentPort?.postMessage(result);
