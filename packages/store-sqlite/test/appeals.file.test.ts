import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, RawWho } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// Filing over real SQLite: two kits (two connections, two processes in effect) on one database file. The unique group is the arbiter, so of
// two filings for one sanction exactly one wins and the other says already_appealed; the rate is counted over the one table.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const dirs: string[] = [];
const stores: SqliteStore[] = [];
const kits: Chatwarden[] = [];
afterEach(async () => {
  for (const k of kits.splice(0)) await k.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const kit = async (path: string, perPlayerPerWeek = 3): Promise<Chatwarden> => {
  const store = openStore({ path });
  stores.push(store);
  const cw = await createChatwarden({
    store,
    secret: 'appeal-race-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock: { now: () => NOW },
    retention: false,
    overrides: { appeals: { enabled: true, perPlayerPerWeek } },
  });
  kits.push(cw);
  return cw;
};

/** Sanction `key` through a real decision on the first kit and return the notice ids. */
async function sanction(cw: Chatwarden, key: string, room: string): Promise<{ noticeId: string }> {
  cw.rooms.seat(room, 'p1', { clientKey: 'reporter' }, 'Rep');
  cw.rooms.seat(room, 'p2', { clientKey: key }, 'Tgt');
  const reported = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2' });
  if (!reported.ok) throw new Error('report refused');
  const target = cw.rooms.subjectAt(room, 'p2') as string;
  const res = await cw.decide({ reportId: reported.reportId, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: target, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] }] });
  if (!res.ok) throw new Error('decision refused');
  return { noticeId: res.groups[0]?.noticeId as string };
}

describe('filing from two connections', () => {
  it('two filings for one sanction leave one row; the loser is already_appealed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-appfile-'));
    dirs.push(dir);
    const path = join(dir, 'kit.db');
    const a = await kit(path);
    const { noticeId } = await sanction(a, 'key-target', 'room-1');
    const b = await kit(path); // opened after the decision, so it knows the person
    const who: RawWho = { clientKey: 'key-target' };
    const first = a.appeals.file(who, { noticeId, statement: 'from a' });
    const second = b.appeals.file(who, { noticeId, statement: 'from b' });
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, refused: 'already_appealed' });
    // each kit sees the one appeal
    expect(a.appeals.mine(who)).toHaveLength(1);
    expect(b.appeals.mine(who)).toHaveLength(1);
    expect(b.appeals.mine(who)[0]?.id).toBe((first as { appeal: { id: string } }).appeal.id);
  });

  it('the weekly rate is counted over the one table: a cap of 1 refuses the second sanction from the other connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-appfile-'));
    dirs.push(dir);
    const path = join(dir, 'kit.db');
    const a = await kit(path, 1);
    const one = await sanction(a, 'key-target', 'room-1');
    const two = await sanction(a, 'key-target', 'room-2');
    const b = await kit(path, 1);
    const who: RawWho = { clientKey: 'key-target' };
    expect(a.appeals.file(who, { noticeId: one.noticeId, statement: '1' })).toMatchObject({ ok: true });
    expect(b.appeals.file(who, { noticeId: two.noticeId, statement: '2' })).toMatchObject({ ok: false, refused: 'rate', retryAfterMs: 7 * 24 * HOUR });
    expect(a.appeals.mine(who)).toHaveLength(1);
  });

  it('a refusal writes nothing, on SQLite too: the rolled-back row is gone and the change token did not move', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-appfile-'));
    dirs.push(dir);
    const path = join(dir, 'kit.db');
    const a = await kit(path, 1);
    const one = await sanction(a, 'key-target', 'room-1');
    const two = await sanction(a, 'key-target', 'room-2');
    const who: RawWho = { clientKey: 'key-target' };
    a.appeals.file(who, { noticeId: one.noticeId, statement: '1' });
    const token = a.changes.token();
    expect(a.appeals.file(who, { noticeId: two.noticeId, statement: '2' })).toMatchObject({ refused: 'rate' });
    expect(a.changes.token()).toBe(token);
    expect(a.appeals.mine(who)).toHaveLength(1);
  });
});
