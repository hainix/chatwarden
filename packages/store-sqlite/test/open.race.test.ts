import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

// Review I-2 of 0.2.0: several connections (the server's processes, `CHATWARDEN_PROCESSES`) opening one file at the old schema at the same moment. The version was read before any write lock, so a connection that
// read "25" waited for the first one's migration 26 to commit and then ran 26 again: "duplicate column name". openStore now takes the write lock first and reads the version inside it.
// The workers are threads with their own handles on one file (a thread has no TypeScript transform, so they run the built store: `npm run typecheck` builds it).

const WORKER = fileURLToPath(new URL('./open.worker.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const LATEST = MIGRATIONS.at(-1)!.version;

type Outcome = { ok: true; version: number } | { ok: false; message: string };

function run(path: string, gate: SharedArrayBuffer, size: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { path, gate, size } });
    let outcome: Outcome | undefined;
    worker.once('message', (m: Outcome) => {
      outcome = m;
    });
    worker.once('error', reject);
    // Resolve on the exit, not the message: the file handles are released when the thread ends (Windows cannot remove a temp directory while one is open).
    worker.once('exit', (code) => (code === 0 && outcome !== undefined ? resolve(outcome) : reject(new Error(`worker exited with ${code}`))));
  });
}

/** A file at the schema of the previous release (version 25): the shipped migrations up to 25. */
function oldFile(path: string): void {
  const db = new DatabaseSync(path);
  openStore({ db, migrations: MIGRATIONS.filter((m) => m.version <= 25) });
  db.close();
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

describe('several connections opening one file at an old schema at the same moment', () => {
  it('the built store is there (the workers need it) and the latest shipped migration is newer than 25', () => {
    expect(existsSync(BUILT)).toBe(true);
    expect(LATEST).toBeGreaterThan(25);
  });

  it.each([2, 3, 4])('%i connections, six rounds: every open succeeds, the file ends at the newest version, and each migration ran exactly once', async (size) => {
    for (let round = 0; round < 6; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'cw-open-race-'));
      try {
        const path = join(dir, 'race.db');
        oldFile(path);
        const gate = new SharedArrayBuffer(4);
        const outcomes = await Promise.all(Array.from({ length: size }, () => run(path, gate, size)));
        expect(outcomes, `round ${round}`).toEqual(Array.from({ length: size }, () => ({ ok: true, version: LATEST + 1 })));
        const db = new DatabaseSync(path);
        try {
          expect(db.prepare('SELECT value FROM kit_meta WHERE key = ?').get('schema_version')?.value).toBe(String(LATEST + 1));
          expect(db.prepare('SELECT COUNT(*) AS n FROM kit_race_probe').get()?.n).toBe(1);
          expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
          const columns = db.prepare("SELECT name FROM pragma_table_info('kit_reports')").all().map((r) => String(r.name));
          expect(columns.filter((c) => c === 'origin')).toHaveLength(1);
        } finally {
          db.close();
        }
      } finally {
        removeDir(dir);
      }
    }
  }, 120_000);

  it('a host connection that already holds a transaction still migrates (the savepoint path), and a failing migration leaves the earlier ones applied', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('BEGIN');
    expect(openStore({ db, migrations: MIGRATIONS.filter((m) => m.version <= 25) }).schemaVersion()).toBe(25);
    expect(openStore({ db }).schemaVersion()).toBe(LATEST);
    db.exec('COMMIT');
    const failing = new DatabaseSync(':memory:');
    const list = [...MIGRATIONS.filter((m) => m.version <= 2), { version: 3, sql: 'CREATE TABLE kit_ok (a); SELECT nope FROM nowhere;' }];
    expect(() => openStore({ db: failing, migrations: list })).toThrow();
    expect(failing.prepare('SELECT value FROM kit_meta WHERE key = ?').get('schema_version')?.value).toBe('2');
    expect(failing.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_ok'").get()).toBeUndefined();
  });

  it('a file that is already current is opened by several connections at once without a write (control)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-open-race-ctl-'));
    try {
      const path = join(dir, 'race.db');
      const first = openStore({ path });
      first.close();
      const gate = new SharedArrayBuffer(4);
      const outcomes = await Promise.all([run(path, gate, 3), run(path, gate, 3), run(path, gate, 3)]);
      // the probe migration is new to this file: the three race for the one pending migration: one applies it, the others find it done
      expect(outcomes.every((o) => o.ok)).toBe(true);
      const db = new DatabaseSync(path);
      expect(db.prepare('SELECT COUNT(*) AS n FROM kit_race_probe').get()?.n).toBe(1);
      db.close();
    } finally {
      removeDir(dir);
    }
  }, 60_000);
});
