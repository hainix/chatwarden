import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, purgeExpired } from '../src/counters.js';
import { makeWorld, type World } from './world.js';

// PRIVACY.md and the contributor page promise that the network hash lives two days and an installation hash 180: the channel key of a report is the
// same hash, so the daily job replaces it too (with a value that holds nothing: `gone:` and the report's own random id).

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});
const rows = async (sql: string) => (await w.db.prepare(sql).all<Record<string, unknown>>()).results;
const add = (id: string, channel: string, day: string, status = 'received', term = 'CWT-2026-00001', kind = 'removal') =>
  w.db.prepare('INSERT INTO reports (id, term_id, kind, channel, status, received_day) VALUES (?,?,?,?,?,?)').bind(id, term, kind, channel, status, day).run();
const channels = async (): Promise<Record<string, string>> => Object.fromEntries((await rows('SELECT id, channel FROM reports')).map((r) => [r.id as string, r.channel as string]));

describe('purgeExpired and the channel key of a report', () => {
  it('the limits are two days for the network hash and 180 for the installation hash', () => {
    expect(LIMITS.reportNetworkDays).toBe(2);
    expect(LIMITS.reportInstallationDays).toBe(180);
  });

  it('replaces a web (network) channel once its day is more than two days old, and not before', async () => {
    await add('rep_old', 'web:aaaa', '2026-11-29'); // 3 days before 2026-12-02
    await add('rep_edge', 'web:bbbb', '2026-11-30'); // 2 days before: kept (older than two days goes)
    await add('rep_new', 'web:cccc', '2026-12-01');
    await add('rep_today', 'web:dddd', '2026-12-02');
    const out = await purgeExpired(w.db, w.clock);
    expect(out.reports).toBe(1);
    expect(await channels()).toEqual({ rep_old: 'gone:rep_old', rep_edge: 'web:bbbb', rep_new: 'web:cccc', rep_today: 'web:dddd' });
  });

  it('replaces an installation channel 180 days after the report day and not before, whatever its status', async () => {
    await add('rep_old', 'inst:aaaa', '2026-05-01', 'declined');
    await add('rep_open', 'inst:bbbb', '2026-05-02', 'received');
    await add('rep_edge', 'inst:cccc', '2026-06-05', 'restored'); // exactly 180 days
    await add('rep_new', 'inst:dddd', '2026-06-06', 'declined'); // 179 days
    const out = await purgeExpired(w.db, w.clock);
    expect(out.reports).toBe(3);
    expect(await channels()).toEqual({ rep_old: 'gone:rep_old', rep_open: 'gone:rep_open', rep_edge: 'gone:rep_edge', rep_new: 'inst:dddd' });
  });

  it('keeps the status, term, kind and day (the decision stays), and no identifier is left in the row', async () => {
    await add('rep_old', 'web:aaaa', '2026-11-20', 'declined', 'CWT-2026-00007', 'wrong_category');
    await purgeExpired(w.db, w.clock);
    const [row] = await rows('SELECT * FROM reports');
    expect(row).toEqual({ id: 'rep_old', term_id: 'CWT-2026-00007', kind: 'wrong_category', channel: 'gone:rep_old', status: 'declined', received_day: '2026-11-20' });
  });

  it('two open reports of one term on one day from different old channels do not collide on the unique index', async () => {
    await add('rep_a', 'web:aaaa', '2026-11-20');
    await add('rep_b', 'web:bbbb', '2026-11-20');
    await expect(purgeExpired(w.db, w.clock)).resolves.toMatchObject({ reports: 2 });
    expect(Object.values(await channels())).toEqual(['gone:rep_a', 'gone:rep_b']);
  });

  it('counts each row once and is safe to run again', async () => {
    await add('rep_a', 'web:aaaa', '2026-11-20');
    expect((await purgeExpired(w.db, w.clock)).reports).toBe(1);
    expect((await purgeExpired(w.db, w.clock)).reports).toBe(0);
    expect(await channels()).toEqual({ rep_a: 'gone:rep_a' });
  });

  it('a channel that is not a hash of ours is left alone (nothing to learn from it either way)', async () => {
    await add('rep_x', 'other', '2026-01-01');
    expect((await purgeExpired(w.db, w.clock)).reports).toBe(0);
  });

  it('the review code does not mistake a purged channel for an installation or a network', async () => {
    await add('rep_a', 'inst:aaaa', '2026-05-01');
    await purgeExpired(w.db, w.clock);
    const [row] = await rows('SELECT channel FROM reports');
    expect(String(row?.channel).startsWith('inst:')).toBe(false);
    expect(String(row?.channel).startsWith('web:')).toBe(false);
  });
});
