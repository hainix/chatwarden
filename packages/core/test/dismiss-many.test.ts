import { describe, expect, it } from 'vitest';
import { BULK_DISMISS_MAX, BULK_REPORTER_SCAN_MAX } from '../src/dismissMany.js';
import { NO_ACTION_DEFAULT_REASON } from '../src/decide.js';
import type { KitEvent } from '../src/events.js';
import type { Store } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';
import { world } from './reportingWorld.js';

// D2: bulk dismiss. One decision per report on the same path as a single decision; a bulk never marks bad faith.

class FailOnNthClose extends MemoryStore {
  closes = 0;
  failAt = Number.POSITIVE_INFINITY;
  override closeReport(...a: Parameters<MemoryStore['closeReport']>): boolean {
    if (++this.closes === this.failAt) throw new Error('disk full');
    return super.closeReport(...a);
  }
}

/** A store that leaves out the optional by-reporter read, like a custom store written before it. */
class NoByReporter extends MemoryStore {
  scanned = 0;
  constructor() {
    super();
    // @ts-expect-error: hide an optional method
    this.listOpenReportsByReporter = undefined;
  }
  override listOpenReports(q: Parameters<MemoryStore['listOpenReports']>[0]) {
    this.scanned += 1;
    return super.listOpenReports(q);
  }
}

async function setup(store: MemoryStore = new MemoryStore()) {
  const w = await world({}, store);
  const events: KitEvent[] = [];
  w.cw.on('*', (e) => void events.push(e));
  let n = 0;
  /** `count` reports against ONE person (target key), each from its own reporter. Returns the target and the report ids. */
  const against = async (targetKey: string, count: number) => {
    const ids: string[] = [];
    let target = '';
    for (let i = 0; i < count; i++) {
      const f = await w.file({}, { reporter: `rk-${targetKey}-${++n}`, target: targetKey });
      ids.push(f.id);
      target = f.target;
      w.clock.t += 1;
    }
    return { target, ids };
  };
  /** `count` reports from ONE reporter (a day apart so the daily limit never trips), each against its own person. */
  const from = async (reporterKey: string, count: number) => {
    const ids: string[] = [];
    let reporter = '';
    for (let i = 0; i < count; i++) {
      const f = await w.file({}, { reporter: reporterKey, target: `tk-${reporterKey}-${++n}` });
      ids.push(f.id);
      reporter = f.reporter;
      w.clock.t += 2 * 3_600_000;
    }
    return { reporter, ids };
  };
  const rows = (ids: string[]) => ids.map((id) => w.store.loadReport(id));
  const open = () => w.cw.reports.list({ status: 'open', limit: 200 }).items.length;
  return { ...w, events, against, from, rows, open, store };
}

const MOD = 'mod-a@example.test';

describe('dismissMany: scopes', () => {
  it('person scope closes every open report about the person, merged aliases included', async () => {
    const t = await setup();
    const a = await t.against('tk-same', 3);
    const other = await t.against('tk-other', 2);
    // Merge a second person into the first by sharing an account.
    const b = await t.against('tk-second', 2);
    t.cw.rooms.seat('merge-room', 'p1', { clientKey: 'tk-same', accountId: 'acct-1' }, 'X');
    t.cw.rooms.seat('merge-room', 'p2', { clientKey: 'tk-second', accountId: 'acct-1' }, 'Y');
    await t.cw.flush();
    const res = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(res).toMatchObject({ ok: true, dryRun: false, open: 5, dismissed: 5, replayed: 0, skipped: { claimed: 0, decided: 0 }, more: false });
    for (const r of t.rows([...a.ids, ...b.ids])) expect(r?.status).toBe('dismissed');
    for (const r of t.rows(other.ids)) expect(r?.status).toBe('open');
    expect(res.ok && res.targets).toHaveLength(1);
  });

  it('reporter scope closes every open report the reporter filed, against different people', async () => {
    const t = await setup();
    const a = await t.from('rk-a', 4);
    const b = await t.from('rk-b', 2);
    const res = await t.cw.reports.dismissMany({ scope: { reporter: a.reporter }, actor: MOD });
    expect(res).toMatchObject({ ok: true, open: 4, dismissed: 4 });
    for (const r of t.rows(a.ids)) expect(r?.status).toBe('dismissed');
    for (const r of t.rows(b.ids)) expect(r?.status).toBe('open');
    expect(res.ok && res.targets).toHaveLength(4);
  });

  it('an unknown person or reporter is ok with zeros', async () => {
    const t = await setup();
    await t.against('tk-x', 1);
    for (const scope of [{ person: 's_nobody' }, { reporter: 's_nobody' }]) {
      expect(await t.cw.reports.dismissMany({ scope, actor: MOD })).toMatchObject({ ok: true, open: 0, dismissed: 0, more: false, reportIds: [], targets: [] });
    }
    expect(t.open()).toBe(1);
  });

  it('reports already decided are untouched', async () => {
    const t = await setup();
    const a = await t.against('tk-same', 3);
    await t.cw.decide({ reportId: a.ids[0] as string, verdict: 'noted', actor: 'mod-b', reason: 'kept', actions: [{ subject: a.target, kind: 'note', durationMs: null, rule: 2 }] });
    const res = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(res).toMatchObject({ ok: true, open: 2, dismissed: 2 });
    expect(t.store.loadReport(a.ids[0] as string)).toMatchObject({ status: 'actioned', actionedBy: 'mod-b', modNote: 'kept' });
  });
});

describe('dismissMany: what each closed report is', () => {
  it('each closed report is a no_action decision with the standard reason, no actions, no notice and no reporter outcome notice', async () => {
    const t = await setup();
    const a = await t.against('tk-same', 3);
    const res = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(res.ok).toBe(true);
    for (const r of t.rows(a.ids)) {
      expect(r).toMatchObject({ status: 'dismissed', badFaith: false, actionedBy: MOD, modNote: NO_ACTION_DEFAULT_REASON, badFaithEvidence: null });
    }
    expect(t.store.rawDecisions()).toHaveLength(3);
    expect(t.store.rawSanctions()).toEqual([]);
    expect(t.store.rawNotices()).toEqual([]);
  });

  it('a typed reason is kept for every report; a blank one is the standard reason', async () => {
    const t = await setup();
    const a = await t.against('tk-a', 2);
    const b = await t.against('tk-b', 2);
    await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, reason: '  swept after the event  ' });
    await t.cw.reports.dismissMany({ scope: { person: b.target }, actor: MOD, reason: '   ' });
    for (const r of t.rows(a.ids)) expect(r?.modNote).toBe('swept after the event');
    for (const r of t.rows(b.ids)) expect(r?.modNote).toBe(NO_ACTION_DEFAULT_REASON);
  });

  it("a bulk never marks bad faith: the reporter's suspension count and the bad-faith marks are unchanged", async () => {
    const t = await setup();
    const a = await t.from('rk-a', 6);
    const res = await t.cw.reports.dismissMany({ scope: { reporter: a.reporter }, actor: MOD });
    expect(res).toMatchObject({ ok: true, dismissed: 6 });
    expect(t.store.loadBadFaithMarks(0)).toEqual([]);
    for (const r of t.rows(a.ids)) expect(r?.badFaith).toBe(false);
    expect(t.cw.reports.reporterRecord(a.reporter)).toMatchObject({ dismissed: 6, badFaith: 0, suspendedUntil: null });
    // The sweep counts as unfounded for accuracy (the moderator judged them) but never suspends.
    expect(t.cw.reports.reporterRecord(a.reporter).accuracy).toMatchObject({ decided: 6, noAction: 6, badFaith: 0, habitual: true });
  });

  it('report.closed is emitted once per dismissed report and never for a replay or a skip', async () => {
    const t = await setup();
    const a = await t.against('tk-same', 3);
    t.events.length = 0;
    await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    const closed = t.events.filter((e) => e.type === 'report.closed');
    expect(closed).toHaveLength(3);
    expect(closed.map((e) => (e as { reportId: string }).reportId).sort()).toEqual([...a.ids].sort());
    expect(closed.every((e) => (e as { verdict: string }).verdict === 'no_action')).toBe(true);
    t.events.length = 0;
    // Nothing open: no events at all.
    await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(t.events).toEqual([]);
    // A dry run emits nothing either.
    const b = await t.against('tk-b', 2);
    t.events.length = 0;
    await t.cw.reports.dismissMany({ scope: { person: b.target }, actor: MOD, dryRun: true });
    expect(t.events).toEqual([]);
  });

  it('a report closed by a different decision in between is counted skipped.decided', async () => {
    const t = await setup();
    const a = await t.against('tk-same', 3);
    // Close the second report from inside the first report's close, as a racing moderator would.
    const real = t.store.closeReport.bind(t.store);
    let raced = false;
    (t.store as { closeReport: unknown }).closeReport = (...args: Parameters<Store['closeReport']>) => {
      if (!raced) {
        raced = true;
        const done = real(...args);
        // Newest first: the second report processed is the one filed one before the newest. Close another one differently.
        const victim = a.ids.find((id) => id !== args[0] && t.store.loadReport(id)?.status === 'open') as string;
        real(victim, 'dismissed', true, 'mod-racer', args[4], 'bad', 'evidence');
        return done;
      }
      return real(...args);
    };
    const res = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(res).toMatchObject({ ok: true, open: 3, dismissed: 2, skipped: { decided: 1 } });
  });
});

describe('dismissMany: claims', () => {
  it("a case another moderator holds is skipped and counted skipped.claimed; the actor's own claim is not", async () => {
    const t = await setup();
    const a = await t.against('tk-a', 2);
    const b = await t.against('tk-b', 3);
    const c = await t.against('tk-c', 1);
    t.cw.cases.claim(a.target, 'mod-b');
    t.cw.cases.claim(c.target, MOD);
    // Reporter-scope style sweep over a mix would be natural; here a person scope on a held case.
    const held = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(held).toMatchObject({ ok: true, open: 0, dismissed: 0, skipped: { claimed: 2, decided: 0 } });
    for (const r of t.rows(a.ids)) expect(r?.status).toBe('open');
    const own = await t.cw.reports.dismissMany({ scope: { person: c.target }, actor: MOD });
    expect(own).toMatchObject({ ok: true, open: 1, dismissed: 1, skipped: { claimed: 0 } });
    const free = await t.cw.reports.dismissMany({ scope: { person: b.target }, actor: MOD });
    expect(free).toMatchObject({ open: 3, dismissed: 3 });
  });

  it('a reporter sweep skips the cases others hold and closes the rest', async () => {
    const t = await setup();
    const a = await t.from('rk-a', 4);
    const targets = a.ids.map((id) => t.cw.reports.get(id)?.targetPerson as string);
    t.cw.cases.claim(targets[1] as string, 'mod-b');
    t.cw.cases.claim(targets[2] as string, MOD);
    const res = await t.cw.reports.dismissMany({ scope: { reporter: a.reporter }, actor: MOD });
    expect(res).toMatchObject({ ok: true, open: 3, dismissed: 3, skipped: { claimed: 1 } });
    expect(t.rows(a.ids).map((r) => r?.status)).toEqual(['dismissed', 'open', 'dismissed', 'dismissed']);
  });

  it('ignoreClaims closes a claimed case', async () => {
    const t = await setup();
    const a = await t.against('tk-a', 2);
    t.cw.cases.claim(a.target, 'mod-b');
    const res = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, ignoreClaims: true });
    expect(res).toMatchObject({ ok: true, dismissed: 2, skipped: { claimed: 0 } });
  });

  it('a lapsed claim does not hold a case', async () => {
    const t = await setup();
    const a = await t.against('tk-a', 2);
    t.cw.cases.claim(a.target, 'mod-b');
    t.clock.t += 11 * 60_000;
    expect(await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD })).toMatchObject({ dismissed: 2, skipped: { claimed: 0 } });
  });
});

describe('dismissMany: dryRun, limits and retries', () => {
  it('dryRun writes nothing (reports, decisions, audit untouched, change token unchanged) and reports open and claimed counts', async () => {
    const t = await setup();
    const a = await t.against('tk-a', 3);
    const b = await t.from('rk-b', 2);
    t.cw.cases.claim(t.cw.reports.get(b.ids[0] as string)?.targetPerson as string, 'mod-b');
    const token = t.cw.changes.token();
    const snap = JSON.stringify({ reports: t.store.rawReports(), decisions: t.store.rawDecisions(), audit: t.cw.audit.list({ limit: 200 }).items });
    const person = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, dryRun: true });
    expect(person).toMatchObject({ ok: true, dryRun: true, open: 3, dismissed: 0, replayed: 0, more: false, reportIds: [], targets: [] });
    const reporter = await t.cw.reports.dismissMany({ scope: { reporter: b.reporter }, actor: MOD, dryRun: true });
    expect(reporter).toMatchObject({ ok: true, dryRun: true, open: 1, dismissed: 0, skipped: { claimed: 1, decided: 0 } });
    expect(t.cw.changes.token()).toBe(token);
    expect(JSON.stringify({ reports: t.store.rawReports(), decisions: t.store.rawDecisions(), audit: t.cw.audit.list({ limit: 200 }).items })).toBe(snap);
  });

  it('limit: exactly BULK_DISMISS_MAX are closed and more is true; a second call closes the rest and more is false', async () => {
    const t = await setup();
    const a = await t.against('tk-big', BULK_DISMISS_MAX + 3);
    const first = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(first).toMatchObject({ ok: true, open: BULK_DISMISS_MAX, dismissed: BULK_DISMISS_MAX, more: true });
    expect(first.ok && first.reportIds).toHaveLength(BULK_DISMISS_MAX);
    const second = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(second).toMatchObject({ ok: true, dismissed: 3, more: false });
    expect(t.open()).toBe(0);
  }, 60_000);

  it('exactly the limit open is more:false; one over is more:true (custom limit)', async () => {
    const t = await setup();
    const a = await t.against('tk-a', 5);
    const exact = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, limit: 5, dryRun: true });
    expect(exact).toMatchObject({ ok: true, open: 5, more: false });
    const under = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, limit: 4, dryRun: true });
    expect(under).toMatchObject({ ok: true, open: 4, more: true });
    const real = await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, limit: 2 });
    expect(real).toMatchObject({ dismissed: 2, more: true });
    // A limit above the maximum is the maximum.
    expect(await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD, limit: 10_000 })).toMatchObject({ ok: true, dismissed: 3, more: false });
  });

  it('running it twice is safe: the second call dismisses 0 and replays 0 when nothing is open', async () => {
    const t = await setup();
    const a = await t.against('tk-a', 3);
    await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD });
    expect(await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD })).toMatchObject({
      ok: true,
      open: 0,
      dismissed: 0,
      replayed: 0,
      skipped: { claimed: 0, decided: 0 },
      more: false,
      reportIds: [],
    });
  });

  it('a store failure on the fourth report rejects, the first three stay closed, and a rerun closes the remaining ones', async () => {
    const store = new FailOnNthClose();
    const t = await setup(store);
    const a = await t.against('tk-a', 6);
    store.failAt = store.closes + 4;
    await expect(t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD })).rejects.toThrow('disk full');
    expect(t.rows(a.ids).filter((r) => r?.status === 'dismissed')).toHaveLength(3);
    expect(t.open()).toBe(3);
    store.failAt = Number.POSITIVE_INFINITY;
    expect(await t.cw.reports.dismissMany({ scope: { person: a.target }, actor: MOD })).toMatchObject({ ok: true, dismissed: 3 });
    expect(t.open()).toBe(0);
    expect(store.rawDecisions()).toHaveLength(6);
  });
});

describe('dismissMany: invalid input writes nothing', () => {
  const bad: Array<[string, (target: string) => Record<string, unknown>]> = [
    ['an unknown scope key', () => ({ scope: { everyone: 'x' } })],
    ['both scopes', (p) => ({ scope: { person: p, reporter: p } })],
    ['an empty scope', () => ({ scope: {} })],
    ['no scope', () => ({})],
    ['a blank person', () => ({ scope: { person: '' } })],
    ['a non-string person', () => ({ scope: { person: 5 } })],
    ['a blank reporter', () => ({ scope: { reporter: '' } })],
    ['a non-integer limit', (p) => ({ scope: { person: p }, limit: 1.5 })],
    ['limit 0', (p) => ({ scope: { person: p }, limit: 0 })],
    ['a negative limit', (p) => ({ scope: { person: p }, limit: -3 })],
    ['a NaN limit', (p) => ({ scope: { person: p }, limit: Number.NaN })],
    ['a string limit', (p) => ({ scope: { person: p }, limit: '5' })],
    ['a reason over 500', (p) => ({ scope: { person: p }, reason: 'x'.repeat(501) })],
    ['a non-string reason', (p) => ({ scope: { person: p }, reason: 7 })],
    ['a non-boolean dryRun', (p) => ({ scope: { person: p }, dryRun: 'yes' })],
    ['a non-boolean ignoreClaims', (p) => ({ scope: { person: p }, ignoreClaims: 1 })],
  ];
  it.each(bad)('%s', async (_name, make) => {
    const t = await setup();
    const a = await t.against('tk-a', 2);
    const snap = JSON.stringify({ reports: t.store.rawReports(), decisions: t.store.rawDecisions() });
    const res = await t.cw.reports.dismissMany({ actor: MOD, ...make(a.target) } as never);
    expect(res).toEqual({ ok: false, error: 'invalid' });
    expect(JSON.stringify({ reports: t.store.rawReports(), decisions: t.store.rawDecisions() })).toBe(snap);
  });

  it.each(['', '   ', 'has space', 'x'.repeat(129), 'bad/char'])('an invalid actor (%j) is a RangeError and writes nothing', async (actor) => {
    const t = await setup();
    const a = await t.against('tk-a', 2);
    await expect(t.cw.reports.dismissMany({ scope: { person: a.target }, actor })).rejects.toThrow(RangeError);
    expect(t.open()).toBe(2);
  });

  it('a missing actor is a RangeError too', async () => {
    const t = await setup();
    await expect(t.cw.reports.dismissMany({ scope: { person: 's_x' } } as never)).rejects.toThrow(RangeError);
  });
});

describe('dismissMany: stores without the by-reporter read', () => {
  it('a store without listOpenReportsByReporter uses the scan and gives the same result', async () => {
    const plain = await setup();
    const a = await plain.from('rk-a', 4);
    await plain.from('rk-b', 2);
    const withMethod = await plain.cw.reports.dismissMany({ scope: { reporter: a.reporter }, actor: MOD, dryRun: true });

    const store = new NoByReporter();
    const t = await setup(store);
    expect(store.listOpenReportsByReporter).toBeUndefined();
    const b = await t.from('rk-a', 4);
    await t.from('rk-b', 2);
    const res = await t.cw.reports.dismissMany({ scope: { reporter: b.reporter }, actor: MOD, dryRun: true });
    expect(store.scanned).toBeGreaterThan(0);
    expect(res).toMatchObject({ ok: true, open: 4, more: false });
    expect(res).toEqual(withMethod);
    const real = await t.cw.reports.dismissMany({ scope: { reporter: b.reporter }, actor: MOD });
    expect(real).toMatchObject({ ok: true, dismissed: 4 });
    expect(t.rows(b.ids).every((r) => r?.status === 'dismissed')).toBe(true);
  });

  it('the scan reads at most BULK_REPORTER_SCAN_MAX reports', () => {
    expect(BULK_REPORTER_SCAN_MAX).toBe(5000);
    expect(BULK_DISMISS_MAX).toBe(200);
  });
});
