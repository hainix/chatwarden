import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, RawWho } from '@chatwarden/core';
import { openStore } from '../src/index.js';

// S4: the shared pacer over SQLite: two kits (two "processes") on one database file. A player alternating lines between them is slowed by the burst limit as if on one process.

const T = 1_800_000_000_000;
const ROOM = 'arena';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c();
    } catch {
      /* gone */
    }
  }
});

async function kitOver(path: string, clock: { t: number; now: () => number }): Promise<Chatwarden> {
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  const store = openStore({ db });
  return createChatwarden({
    store,
    secret: 'shared-pacing-sqlite-secret-1',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    retention: false,
    profanity: { apply: (t) => ({ hit: false, text: t }) },
    overrides: { pace: { slowModeMs: 1000, burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 } },
    sharedPacing: true,
  });
}
const reason = (r: ReturnType<Chatwarden['chat']['accept']>): string => ('deliver' in r ? 'ok' : r.refuse.reason);

describe('shared pacing over one SQLite file', () => {
  it('two kits on one file: lines alternated between them are slowed by the burst limit as if on one process; a repeat sent to the second after the first is refused duplicate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-pace-kits-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'kit.db');
    const clock = { t: T, now: () => clock.t };
    const a = await kitOver(path, clock);
    a.rooms.seat(ROOM, 'p', { clientKey: 'alice-client-key-0001' }, 'alice');
    await new Promise((r) => setTimeout(r, 20));
    const b = await kitOver(path, clock);
    b.rooms.seat(ROOM, 'p', { clientKey: 'alice-client-key-0001' }, 'alice');
    expect(b.rooms.subjectAt(ROOM, 'p')).toBe(a.rooms.subjectAt(ROOM, 'p'));

    expect(reason(a.chat.accept(ROOM, 'p', 'first line of text'))).toBe('ok');
    clock.t += 1100;
    expect(reason(b.chat.accept(ROOM, 'p', 'second line of text'))).toBe('ok');
    clock.t += 1100;
    expect(reason(a.chat.accept(ROOM, 'p', 'third line of text'))).toBe('ok');
    clock.t += 1100;
    expect(reason(b.chat.accept(ROOM, 'p', 'fourth line of text'))).toBe('flood');
    expect(reason(a.chat.accept(ROOM, 'p', 'fifth line of text'))).toBe('flood');
    clock.t += 40_000;
    expect(reason(a.chat.accept(ROOM, 'p', 'a repeated line here'))).toBe('ok');
    clock.t += 2000;
    expect(reason(b.chat.accept(ROOM, 'p', 'A repeated line here!'))).toBe('duplicate');
  });

  it('the rows are in the file: a third connection reads one row for the person in the room, with digests and times only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-pace-kits2-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'kit.db');
    const clock = { t: T, now: () => clock.t };
    const a = await kitOver(path, clock);
    a.rooms.seat(ROOM, 'p', { clientKey: 'alice-client-key-0001' }, 'alice');
    expect(reason(a.chat.accept(ROOM, 'p', 'a line mentioning secret-marker-text'))).toBe('ok');
    const reader = new DatabaseSync(path);
    cleanups.push(() => reader.close());
    const rows = reader.prepare('SELECT * FROM kit_pace').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('secret-marker');
    expect(String(rows[0]?.who)).toBe(a.rooms.subjectAt(ROOM, 'p'));
  });
});
