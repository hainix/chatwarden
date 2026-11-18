import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { enableWal } from '../src/open.js';

// "database is locked" at `PRAGMA journal_mode = WAL` (seen in CI in pace.concurrency): switching the journal mode can return SQLITE_BUSY without going through the busy handler, so
// the busy timeout does not cover it. The mode persists in the file, so only the first open needs the switch: later opens read the mode and leave it alone, and the one that must switch
// retries a busy answer for a bounded time.

const WORKER = fileURLToPath(new URL('./open.wal.worker.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

type Outcome = { ok: true } | { ok: false; message: string };

function run(path: string, gate: SharedArrayBuffer, size: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { path, gate, size } });
    let outcome: Outcome | undefined;
    worker.once('message', (m: Outcome) => {
      outcome = m;
    });
    worker.once('error', reject);
    // Resolve on the exit: the file handles are released when the thread ends (Windows cannot remove a temp directory while one is open).
    worker.once('exit', (code) => (code === 0 && outcome !== undefined ? resolve(outcome) : reject(new Error(`worker exited with ${code}`))));
  });
}

const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

describe('several connections opening one fresh file at the same moment', () => {
  it('the built store is there (the workers need it)', () => {
    expect(existsSync(BUILT)).toBe(true);
  });

  it.each([2, 4, 6])('%i connections, 40 rounds: every open succeeds and the file ends in WAL mode', async (size) => {
    for (let round = 0; round < 40; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'cw-open-wal-'));
      try {
        const path = join(dir, 'fresh.db');
        const gate = new SharedArrayBuffer(4);
        const outcomes = await Promise.all(Array.from({ length: size }, () => run(path, gate, size)));
        expect(outcomes, `round ${round}`).toEqual(Array.from({ length: size }, () => ({ ok: true })));
        const db = new DatabaseSync(path);
        try {
          expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        } finally {
          db.close();
        }
      } finally {
        removeDir(dir);
      }
    }
  }, 120_000);
});

/** A stand-in for a connection: records what ran, and answers `PRAGMA journal_mode` (read) and the switch as the script says. */
function stub(opts: { mode: string; busyTimeout?: number; switches: Array<Error | 'ok'> }) {
  const log: string[] = [];
  let mode = opts.mode;
  const db = {
    exec(sql: string): void {
      log.push(sql);
      if (sql.startsWith('PRAGMA journal_mode =')) {
        const next = opts.switches.shift() ?? 'ok';
        if (next !== 'ok') throw next;
        mode = 'wal';
      }
    },
    prepare(sql: string) {
      log.push(sql);
      return { get: () => (sql === 'PRAGMA journal_mode' ? { journal_mode: mode } : { timeout: opts.busyTimeout ?? 5000 }) };
    },
  };
  return { db: db as unknown as DatabaseSync, log, mode: () => mode };
}
const locked = (message = 'database is locked'): Error => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
const switches = (log: string[]): string[] => log.filter((s) => s.startsWith('PRAGMA journal_mode ='));

describe('enableWal', () => {
  it('a file already in WAL mode never runs the switch statement', () => {
    const s = stub({ mode: 'wal', switches: [] });
    enableWal(s.db);
    expect(switches(s.log)).toEqual([]);
  });

  it('a real file already in WAL mode never runs the switch (checked on a connection that records its statements)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-open-wal-'));
    const real = new DatabaseSync(join(dir, 'w.db'));
    try {
      real.exec('PRAGMA journal_mode = WAL');
      const seen: string[] = [];
      const spy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'exec') return (sql: string) => (seen.push(sql), target.exec(sql));
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      enableWal(spy);
      expect(seen.filter((s) => /journal_mode\s*=/i.test(s))).toEqual([]);
    } finally {
      real.close();
      removeDir(dir);
    }
  });

  it('the mode compares case-insensitively and a rollback-journal file is switched once', () => {
    const upper = stub({ mode: 'WAL', switches: [] });
    enableWal(upper.db);
    expect(switches(upper.log)).toEqual([]);
    for (const mode of ['delete', 'truncate', 'persist', 'memory']) {
      const s = stub({ mode, switches: [] });
      enableWal(s.db);
      expect(switches(s.log), mode).toEqual(['PRAGMA journal_mode = WAL']);
      expect(s.mode()).toBe('wal');
    }
  });

  it('retries "database is locked" and succeeds after two failures', () => {
    const s = stub({ mode: 'delete', switches: [locked(), locked(), 'ok'] });
    enableWal(s.db);
    expect(switches(s.log)).toHaveLength(3);
    expect(s.mode()).toBe('wal');
  });

  it('retries the SQLITE_BUSY code even when the message says something else', () => {
    const s = stub({ mode: 'delete', switches: [locked('some other words'), 'ok'] });
    enableWal(s.db);
    expect(switches(s.log)).toHaveLength(2);
  });

  it('stops looking once another connection has switched the file meanwhile', () => {
    // The switch fails busy, and by the time of the retry the other connection has made the file WAL: no further switch statement.
    const s = stub({ mode: 'delete', switches: [locked()] });
    const read = s.db.prepare.bind(s.db);
    let reads = 0;
    (s.db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      if (sql === 'PRAGMA journal_mode' && ++reads === 2) return { get: () => ({ journal_mode: 'wal' }) };
      return read(sql);
    };
    enableWal(s.db);
    expect(switches(s.log)).toHaveLength(1);
  });

  it('gives up after the busy timeout and rethrows the lock error', () => {
    const s = stub({ mode: 'delete', busyTimeout: 150, switches: Array.from({ length: 100 }, () => locked()) });
    const started = Date.now();
    expect(() => enableWal(s.db)).toThrow(/database is locked/);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(100);
    expect(took).toBeLessThan(2000);
    expect(switches(s.log).length).toBeGreaterThanOrEqual(2);
    expect(switches(s.log).length).toBeLessThanOrEqual(6);
  });

  it('rethrows any other error at once, without a retry', () => {
    const s = stub({ mode: 'delete', switches: [new Error('disk I/O error'), 'ok'] });
    expect(() => enableWal(s.db)).toThrow('disk I/O error');
    expect(switches(s.log)).toHaveLength(1);
  });
});
