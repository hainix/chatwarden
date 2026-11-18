import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/index.js';

// S3: two connections (two threads, each with its own database handle on one file) update one key at once, 200 times each. paceUpdate is one BEGIN IMMEDIATE transaction around the load,
// the function and the upsert, so the two serialise and no stamp is lost. The workers run the built store (a worker thread has no TypeScript transform): `npm run typecheck` builds it.

const WORKER = fileURLToPath(new URL('./pace.worker.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

function run(path: string, id: number, gate: SharedArrayBuffer, rounds: number, keep: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { path, id, rounds, gate, keep } });
    worker.once('message', () => resolve());
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with ${code}`));
    });
  });
}

describe('shared pace state across connections', () => {
  it('the built store is there (the workers need it)', () => {
    expect(existsSync(BUILT)).toBe(true);
  });

  it('two connections to one file update one key at once, 200 times each: the stored row holds every stamp up to the burst limit and no update is lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-pace-conc-'));
    try {
      const path = join(dir, 'pace.db');
      // create the file and the schema once, so the workers only open it
      const seed = new DatabaseSync(path);
      openStore({ db: seed });
      seed.close();
      const gate = new SharedArrayBuffer(4);
      await Promise.all([run(path, 1, gate, 200, 400), run(path, 2, gate, 200, 400)]);
      const db = new DatabaseSync(path);
      const row = openStore({ db }).paceLoad?.('room', 'who');
      db.close();
      expect(row?.stamps).toHaveLength(400);
      const stamps = new Set(row?.stamps);
      for (let i = 0; i < 200; i++) {
        expect(stamps.has(100_000 + i), `worker 1 update ${i}`).toBe(true);
        expect(stamps.has(200_000 + i), `worker 2 update ${i}`).toBe(true);
      }
      // each worker's own updates stay in the order it made them
      const mine = (id: number) => (row?.stamps ?? []).filter((s) => Math.floor(s / 100_000) === id);
      for (const id of [1, 2]) expect(mine(id)).toEqual([...mine(id)].sort((a, b) => a - b));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('with a smaller limit the row keeps the newest stamps and never exceeds it, whatever the order the two interleave in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-pace-conc2-'));
    try {
      const path = join(dir, 'pace.db');
      const seed = new DatabaseSync(path);
      openStore({ db: seed });
      seed.close();
      const gate = new SharedArrayBuffer(4);
      await Promise.all([run(path, 1, gate, 100, 30), run(path, 2, gate, 100, 30)]);
      const db = new DatabaseSync(path);
      const row = openStore({ db }).paceLoad?.('room', 'who');
      db.close();
      expect(row?.stamps.length).toBeLessThanOrEqual(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
