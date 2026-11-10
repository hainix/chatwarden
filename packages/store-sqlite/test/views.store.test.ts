import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

// The staff read views over a database written by an earlier 0.1.x: the K4 views add no migration of their own, so a database at the
// current schema is exactly "0.1.x-shaped" for them. Rows are written with raw SQL the way the old code wrote them (no revoke
// actor on a row that was never revoked, a NULL rule from before rules existed, a pre-room sanction), then reopened.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmpPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-views-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
};

describe('the staff read views on an existing 0.1.x database', () => {
  it('the staff views add no migration of their own: the latest one is the team workbench tables (15)', () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(15);
  });

  it('reads old rows through the new store queries, and revoke info that was always stored', () => {
    const path = tmpPath();
    openStore({ path }).close();
    const raw = new DatabaseSync(path);
    const ins = raw.prepare(
      `INSERT INTO kit_sanctions
         (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending,
          revoked_by, revoked_at, revoke_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // An old timed chat restriction with no rule, an old revoked ban, and the IP row of the first.
    ins.run('r1', 'g1', 'M-OLD01', 'chat', 'subject', 's_old', NOW - 5 * DAY, NOW - 4 * DAY, 'old reason', null, 'ann', 'moderator', 0, 0, null, null, null);
    ins.run('r1ip', 'g1', 'M-OLD01', 'chat', 'ip', 'hashed-ip-value', NOW - 5 * DAY, NOW - 4 * DAY, 'old reason', null, 'ann', 'moderator', 0, 0, null, null, null);
    ins.run('r2', 'g2', 'M-OLD02', 'ban', 'subject', 's_old', NOW - 3 * DAY, null, 'bad', '3', 'bob', 'moderator', 0, 0, 'cat', NOW - 2 * DAY, 'lifted early');
    raw.close();

    const store = openStore({ path });
    const rows = store.listSubjectSanctions({ subjects: ['s_old'], limit: 10 });
    expect(rows.map((r) => [r.groupId, r.rule, r.revokedAt, r.revokedBy, r.revokeReason, r.roomId])).toEqual([
      ['g2', '3', NOW - 2 * DAY, 'cat', 'lifted early', null],
      ['g1', null, null, null, null, null],
    ]);
    expect(rows.some((r) => r.targetType === 'ip')).toBe(false);
    expect(store.reporterTally(['s_old'])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
    expect(store.listStrikes(0, 10)).toEqual([]);
    expect(store.countStrikesByTerm(0)).toEqual([]);
    store.close();
  });

  it('serves the facade views over old rows: the legacy rule reads null and the revoke shows', async () => {
    const path = tmpPath();
    openStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        `INSERT INTO kit_sanctions
           (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending,
            revoked_by, revoked_at, revoke_reason)
         VALUES ('r1', 'g1', 'M-OLD01', 'ban', 'subject', 's_old', ?, NULL, 'why', NULL, 'ann', 'moderator', 0, 0, 'cat', ?, 'mistake')`,
      )
      .run(NOW - 400 * DAY, NOW - 399 * DAY);
    raw
      .prepare(
        `INSERT INTO kit_sanctions
           (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending)
         VALUES ('r2', 'g2', 'M-OLD02', 'ban', 'subject', 's_old', ?, NULL, 'still on', NULL, 'ann', 'moderator', 0, 0)`,
      )
      .run(NOW - 399 * DAY);
    raw.close();

    const clock = { now: () => NOW };
    const cw = await createChatwarden({
      store: openStore({ path }),
      secret: 'views-secret',
      platform: { identify: (c) => c as RawWho },
      clock,
      logger: { warn() {} },
      retention: false,
    });
    try {
      // The old permanent ban that was never revoked is "active" and listed by person; the revoked one is not.
      expect(cw.sanctions.forPerson('s_old').map((v) => [v.groupId, v.rule, v.active, v.revokedBy])).toEqual([['g2', null, true, null]]);
      // The global list is not windowed: both show, revoke info and all.
      expect(cw.sanctions.list().items.map((v) => [v.groupId, v.active, v.revokedBy, v.revokeReason, v.person])).toEqual([
        ['g2', true, null, null, 's_old'],
        ['g1', false, 'cat', 'mistake', 's_old'],
      ]);
    } finally {
      await cw.close();
    }
  });

  it('counts strikes and lists them newest first with the same ordering as the memory store', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    for (const [id, at, term] of [['a', NOW - 3, 't1'], ['b', NOW - 2, 't1'], ['c', NOW - 2, 't2']] as const) {
      store.insertStrike({ id, at, subject: 's_x', roomId: 'R', termId: term, rawLine: 'line' });
    }
    expect(store.listStrikes(0, 10).map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(store.countStrikesByTerm(NOW - 2)).toEqual([{ termId: 't1', count: 1 }, { termId: 't2', count: 1 }]);
    store.close();
  });
});
