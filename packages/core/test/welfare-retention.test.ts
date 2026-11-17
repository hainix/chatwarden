import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { defaultReporting } from '../src/reporting.js';
import { purge, RETENTION_DEFAULTS } from '../src/retention.js';
import { DAY, NOW, world } from './reportingWorld.js';
import type { StoredReport } from '../src/types.js';

// U4: a welfare report (its excerpt, note, comments and decision row) is deleted after retention.welfareReportsMs, 30 days by default: it is the most sensitive text the kit holds.
// Other reports follow reportsMs as before. A report held for legal reasons is skipped.

const report = (id: string, createdAt: number, reportedReason: string | null, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt,
  roomId: `R-${id}`,
  tags: {},
  reporterSubject: `s_r_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'R',
  targetSubject: `s_t_${id}`,
  targetSeat: 'p2',
  targetHandle: 'T',
  category: 'other',
  reportedReason,
  note: 'tarvo note',
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  ...over,
});

/** The retention tests write rows for bare subject ids with no subject row; the stray sweep would delete them, so it is switched off here. */
const store = (): MemoryStore => {
  const s = new MemoryStore();
  s.purgeStrayRows = () => 0;
  return s;
};

describe('the welfare clock', () => {
  it('deletes welfare reports older than welfareReportsMs (strict) and keeps younger ones; ordinary reports follow reportsMs as before', async () => {
    const s = store();
    s.insertReport(report('w_old', NOW - 31 * DAY, 'welfare'));
    s.insertReport(report('w_line', NOW - 30 * DAY, 'welfare'));
    s.insertReport(report('w_new', NOW - 29 * DAY, 'welfare'));
    s.insertReport(report('h_mid', NOW - 60 * DAY, 'harassment'));
    s.insertReport(report('h_old', NOW - 100 * DAY, 'harassment'));
    const res = await purge(s, NOW);
    expect(res).toMatchObject({ reports: 1, welfareReports: 1 });
    expect(s.loadReport('w_old')).toBeNull();
    expect(s.loadReport('w_line')).not.toBeNull();
    expect(s.loadReport('w_new')).not.toBeNull();
    expect(s.loadReport('h_mid')).not.toBeNull();
    expect(s.loadReport('h_old')).toBeNull();
  });

  it('a decided welfare report goes with its decision row, comments and AI read, on the same clock', async () => {
    const s = store();
    s.insertReport(report('w', NOW - 40 * DAY, 'welfare'));
    s.insertDecision('k1', 'w', NOW - 39 * DAY, '{"groups":[]}');
    s.closeReport('w', 'dismissed', false, 'mod', NOW - 39 * DAY, 'n');
    s.insertComment?.({ id: 'c1', reportId: 'w', at: NOW - 39 * DAY, actor: 'mod', role: 'moderator', kind: 'comment', text: 'hello' });
    await purge(s, NOW);
    expect(s.loadReport('w')).toBeNull();
    expect(s.findDecision('k1')).toBeNull();
    expect(s.listComments?.('w')).toEqual([]);
  });

  it('welfareReportsMs is read from the policy: a longer window keeps them, 1 day (the floor) deletes after a day', async () => {
    const s = store();
    s.insertReport(report('w', NOW - 40 * DAY, 'welfare'));
    expect((await purge(s, NOW, { welfareReportsMs: 60 * DAY })).welfareReports).toBe(0);
    expect(s.loadReport('w')).not.toBeNull();
    s.insertReport(report('w2', NOW - 2 * DAY, 'welfare'));
    expect((await purge(s, NOW, { welfareReportsMs: DAY })).welfareReports).toBe(2);
    expect(s.loadReport('w2')).toBeNull();
    expect(s.loadReport('w')).toBeNull();
  });

  it('the default is 30 days, and the clock is the welfare one even when reportsMs is longer', async () => {
    expect(RETENTION_DEFAULTS.welfareReportsMs).toBe(30 * DAY);
    const s = store();
    s.insertReport(report('w', NOW - 35 * DAY, 'welfare'));
    s.insertReport(report('h', NOW - 35 * DAY, 'harassment'));
    const res = await purge(s, NOW, { reportsMs: 365 * DAY });
    expect(res).toMatchObject({ reports: 0, welfareReports: 1 });
    expect(s.loadReport('h')).not.toBeNull();
  });

  it('a report held for legal reasons is skipped by the welfare purge', async () => {
    const s = store();
    s.insertReport(report('held', NOW - 40 * DAY, 'welfare'));
    s.insertReport(report('free', NOW - 40 * DAY, 'welfare'));
    s.placeHold({ reportId: 'held', code: 'other', heldBy: 'sen', heldAt: NOW, releasedBy: null, releasedAt: null });
    const res = await purge(s, NOW);
    expect(res.welfareReports).toBe(1);
    expect(s.loadReport('held')).not.toBeNull();
    expect(s.loadReport('free')).toBeNull();
  });

  it('a store without the method purges the rest and reports 0 for welfare', async () => {
    const s = store();
    (s as { purgeReportsByReason?: unknown }).purgeReportsByReason = undefined;
    s.insertReport(report('w', NOW - 40 * DAY, 'welfare'));
    s.insertReport(report('h', NOW - 100 * DAY, 'harassment'));
    const res = await purge(s, NOW);
    expect(res).toMatchObject({ reports: 1, welfareReports: 0 });
    expect(s.loadReport('w')).not.toBeNull();
  });

  it('the welfare purge runs before the general one in the same transaction: a failure in the general purge keeps the welfare reports', async () => {
    const s = store();
    s.insertReport(report('w', NOW - 40 * DAY, 'welfare'));
    s.purgeSanctions = () => {
      throw new Error('boom');
    };
    await expect(purge(s, NOW)).rejects.toThrow('boom');
    expect(s.loadReport('w')).not.toBeNull();
  });

  it('through the facade: cw.purge deletes an old welfare report and counts it', async () => {
    const reasons = defaultReporting().reasons.map((r) => (r.id === 'welfare' ? { ...r, enabled: true } : r));
    const w = await world({ overrides: { reporting: { reasons } } });
    const f = await w.file({ reason: 'welfare' });
    w.clock.t += 31 * DAY;
    const res = await w.cw.purge();
    expect(res.welfareReports).toBe(1);
    expect(w.store.loadReport(f.id)).toBeNull();
  });

  it('a welfare report younger than the window is not purged by the facade', async () => {
    const reasons = defaultReporting().reasons.map((r) => (r.id === 'welfare' ? { ...r, enabled: true } : r));
    const w = await world({ overrides: { reporting: { reasons } } });
    const f = await w.file({ reason: 'welfare' });
    w.clock.t += 29 * DAY;
    expect((await w.cw.purge()).welfareReports).toBe(0);
    expect(w.store.loadReport(f.id)).not.toBeNull();
  });
});
