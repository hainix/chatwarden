import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Two processes (or two worker threads) opening one database file at the same moment: the first to run `PRAGMA journal_mode = WAL` takes the locks that the
// other needs, and without a busy timeout the other one throws "database is locked" at open (seen with two workers of the shared pacer, about one run in three).
// So the busy timeout must be set before anything that takes a lock. A source-order check, because the race itself is not repeatable on demand.

const source = readFileSync(fileURLToPath(new URL('../src/open.ts', import.meta.url)), 'utf8');
const body = source.slice(source.indexOf('export function openStore'));

describe('openStore: the busy timeout comes before the first statement that takes a lock', () => {
  it('sets busy_timeout before journal_mode', () => {
    const timeout = body.indexOf('PRAGMA busy_timeout = ');
    const journal = body.indexOf('PRAGMA journal_mode = WAL');
    expect(timeout).toBeGreaterThan(-1);
    expect(journal).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(journal);
  });

  it('sets busy_timeout before the schema is read or created', () => {
    const timeout = body.indexOf('PRAGMA busy_timeout = ');
    for (const later of ['CREATE TABLE IF NOT EXISTS kit_meta', 'currentVersion(db)']) expect(timeout, later).toBeLessThan(body.indexOf(later));
  });

  it('still leaves a busy timeout the caller already set alone (only a zero one is replaced)', () => {
    expect(body).toMatch(/\.timeout \?\? 0\) === 0/);
  });
});
