// A worker for pace.concurrency.test.ts: one connection to a shared file, 200 pace updates of one key, each adding its own stamp. Uses the built store (dist), because a worker
// thread does not run the test runner's TypeScript transform.
import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from '../dist/src/index.js';

const { path, id, rounds, gate, keep } = workerData;
const store = openStore({ path });
// Wait for the other worker, so the two really overlap.
const flag = new Int32Array(gate);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < 2) Atomics.wait(flag, 0, 1, 5);

for (let i = 0; i < rounds; i += 1) {
  store.paceUpdate('room', 'who', (prev) => {
    const stamps = [...(prev?.stamps ?? []), id * 100_000 + i].slice(-keep);
    return { roomId: 'room', who: 'who', lastAt: id * 100_000 + i, stamps, recent: prev?.recent ?? [], floodSignalAt: null, touchedAt: 1 };
  });
}
store.close();
parentPort?.postMessage('done');
