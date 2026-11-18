import { describe, expect, it, vi } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import {
  REPORTER_ACCURACY_BATCH_MAX,
  REPORTER_ACCURACY_MIN_DECIDED,
  REPORTER_ACCURACY_WINDOW_MS,
  REPORTER_FALSE_RATE_HABITUAL,
  REPORTER_FALSE_RATE_NOTICEABLE,
  reporterAccuracyFor,
  summarizeOutcomes,
} from '../src/reporterAccuracy.js';
import { SUSPEND_WINDOW_MS } from '../src/reports.js';
import type { Logger, Platform, RawWho, Store, StoredReport } from '../src/types.js';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import { appealsKit } from './appealsWorld.js';

// D3: reporter accuracy. A pure summary of outcome counts, and a service that reads them with ONE grouped store query.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

describe('thresholds', () => {
  it('are the documented values', () => {
    expect(REPORTER_ACCURACY_WINDOW_MS).toBe(30 * DAY);
    expect(REPORTER_ACCURACY_WINDOW_MS).toBe(SUSPEND_WINDOW_MS);
    expect(REPORTER_ACCURACY_MIN_DECIDED).toBe(5);
    expect(REPORTER_FALSE_RATE_NOTICEABLE).toBe(0.6);
    expect(REPORTER_FALSE_RATE_HABITUAL).toBe(0.8);
    expect(REPORTER_ACCURACY_BATCH_MAX).toBe(200);
  });
});

describe('summarizeOutcomes', () => {
  it('below the minimum sample the rate is null, and the reporter is neither noticeable nor habitual', () => {
    for (let decided = 0; decided < REPORTER_ACCURACY_MIN_DECIDED; decided++) {
      const s = summarizeOutcomes({ actioned: 0, noAction: decided, badFaith: 0 });
      expect(s).toMatchObject({ decided, unfounded: decided, falseRate: null, noticeable: false, habitual: false });
    }
  });

  it('exactly the minimum counts', () => {
    const s = summarizeOutcomes({ actioned: 0, noAction: 5, badFaith: 0 });
    expect(s).toMatchObject({ decided: 5, falseRate: 1, noticeable: true, habitual: true });
    const founded = summarizeOutcomes({ actioned: 5, noAction: 0, badFaith: 0 });
    expect(founded).toMatchObject({ decided: 5, falseRate: 0, noticeable: false, habitual: false });
  });

  it('no_action and bad_faith are unfounded; actioned (upheld and noted) is founded', () => {
    const s = summarizeOutcomes({ actioned: 3, noAction: 2, badFaith: 4 });
    expect(s).toEqual({
      decided: 9,
      noAction: 2,
      badFaith: 4,
      unfounded: 6,
      falseRate: 6 / 9,
      noticeable: true,
      habitual: false,
      windowMs: REPORTER_ACCURACY_WINDOW_MS,
      overturned: 0,
    });
  });

  it('bad faith counts in the numerator: five bad-faith dismissals are a rate of 1', () => {
    expect(summarizeOutcomes({ actioned: 0, noAction: 0, badFaith: 5 })).toMatchObject({ falseRate: 1, habitual: true, unfounded: 5 });
  });

  it('habitual at exactly 0.8 and not at 7 of 9', () => {
    expect(summarizeOutcomes({ actioned: 1, noAction: 4, badFaith: 0 })).toMatchObject({ falseRate: 0.8, habitual: true, noticeable: true });
    expect(summarizeOutcomes({ actioned: 2, noAction: 7, badFaith: 0 })).toMatchObject({ habitual: false, noticeable: true });
  });

  it('noticeable at exactly 0.6, and not just under it', () => {
    expect(summarizeOutcomes({ actioned: 2, noAction: 3, badFaith: 0 })).toMatchObject({ falseRate: 0.6, noticeable: true, habitual: false });
    expect(summarizeOutcomes({ actioned: 4, noAction: 5, badFaith: 0 })).toMatchObject({ falseRate: 5 / 9, noticeable: false });
  });

  it('all upheld gives falseRate 0', () => {
    expect(summarizeOutcomes({ actioned: 12, noAction: 0, badFaith: 0 })).toMatchObject({ falseRate: 0, noticeable: false, habitual: false });
  });

  it('a habitual reporter is also noticeable (habitual implies noticeable)', () => {
    for (const noAction of [4, 5, 20]) {
      const s = summarizeOutcomes({ actioned: 1, noAction, badFaith: 0 });
      if (s.habitual) expect(s.noticeable).toBe(true);
    }
  });
});

async function setup(store: Store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logger: Logger = { warn() {} };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store, secret: 'accuracy-secret', platform, clock, logger, retention: false });
  let n = 0;
  const person = (): string => {
    n += 1;
    const room = `pr-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-acc-${String(n).padStart(4, '0')}` }, `H${n}`);
    return cw.rooms.subjectAt(room, 'p1') as string;
  };
  let r = 0;
  type How = 'open' | 'upheld' | 'noted' | 'dismissed' | 'bad_faith';
  const file = (reporter: string, how: How, createdAt = NOW - H): string => {
    const id = `acc${++r}`;
    const rec: StoredReport = {
      id,
      createdAt,
      roomId: `room-${id}`,
      tags: {},
      reporterSubject: reporter,
      reporterSeat: 'p1',
      reporterHandle: 'Rep',
      targetSubject: `s_target_${id}`,
      targetSeat: 'p2',
      targetHandle: 'Tgt',
      category: 'harassment',
      note: null,
      lineId: null,
      excerpt: [],
      people: [],
      status: 'open',
    };
    (store as MemoryStore).insertReport(rec);
    if (how === 'upheld' || how === 'noted') store.closeReport(id, 'actioned', false, 'mod', NOW, 'n');
    if (how === 'dismissed') store.closeReport(id, 'dismissed', false, 'mod', NOW, 'n');
    if (how === 'bad_faith') store.closeReport(id, 'dismissed', true, 'mod', NOW, 'n', 'evidence');
    return id;
  };
  const many = (reporter: string, how: How, count: number, createdAt = NOW - H) => {
    for (let i = 0; i < count; i++) file(reporter, how, createdAt);
  };
  return { cw, store, clock, person, file, many };
}

describe('cw.reports.reporterAccuracy', () => {
  it('open reports are not counted', async () => {
    const t = await setup();
    const a = t.person();
    t.many(a, 'open', 10);
    t.many(a, 'dismissed', 5);
    expect(t.cw.reports.reporterAccuracy([a]).get(a)).toMatchObject({ decided: 5, noAction: 5, falseRate: 1 });
  });

  it('a report filed exactly at the window start counts and one a millisecond earlier does not', async () => {
    const t = await setup();
    const a = t.person();
    const start = NOW - REPORTER_ACCURACY_WINDOW_MS;
    t.many(a, 'dismissed', 5, start);
    t.many(a, 'dismissed', 3, start - 1);
    expect(t.cw.reports.reporterAccuracy([a]).get(a)).toMatchObject({ decided: 5 });
    t.clock.t += 1; // the boundary moves with the injected clock
    expect(t.cw.reports.reporterAccuracy([a]).get(a)).toBeUndefined();
  });

  it('splits upheld/noted from dismissed and counts bad faith as unfounded', async () => {
    const t = await setup();
    const a = t.person();
    t.file(a, 'upheld');
    t.file(a, 'noted');
    t.many(a, 'dismissed', 3);
    t.many(a, 'bad_faith', 2);
    expect(t.cw.reports.reporterAccuracy([a]).get(a)).toEqual({
      decided: 7,
      noAction: 3,
      badFaith: 2,
      unfounded: 5,
      falseRate: 5 / 7,
      noticeable: true,
      habitual: false,
      windowMs: REPORTER_ACCURACY_WINDOW_MS,
      overturned: 0,
    });
  });

  it('merged aliases are one reporter', async () => {
    const t = await setup();
    const a = t.person();
    const b = t.person();
    t.many(a, 'dismissed', 3);
    t.many(b, 'dismissed', 2);
    t.cw.rooms.seat('merge-room', 'p1', { clientKey: 'raw-client-key-acc-0001', accountId: 'acct-1' }, 'X');
    t.cw.rooms.seat('merge-room', 'p2', { clientKey: 'raw-client-key-acc-0002', accountId: 'acct-1' }, 'Y');
    await t.cw.flush();
    const byA = t.cw.reports.reporterAccuracy([a]);
    const byB = t.cw.reports.reporterAccuracy([b]);
    // Keyed by the canonical person: both asks give the same single entry, with all five reports folded in.
    expect([...byA.values()]).toHaveLength(1);
    expect([...byA.values()][0]).toMatchObject({ decided: 5 });
    expect([...byB.values()][0]).toMatchObject({ decided: 5 });
    expect([...byA.keys()]).toEqual([...byB.keys()]);
  });

  it('people with no decided reports are absent', async () => {
    const t = await setup();
    const a = t.person();
    const b = t.person();
    t.many(a, 'dismissed', 1);
    const got = t.cw.reports.reporterAccuracy([a, b, 'never-seen']);
    expect([...got.keys()]).toEqual([a]);
    expect(got.get(a)).toMatchObject({ decided: 1, falseRate: null });
  });

  it('an empty list is an empty map and asks the store nothing', async () => {
    const t = await setup();
    const spy = vi.spyOn(t.store as MemoryStore, 'reporterOutcomes');
    expect(t.cw.reports.reporterAccuracy([]).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a batch is one store call', async () => {
    const t = await setup();
    const people = Array.from({ length: 12 }, () => t.person());
    for (const p of people) t.many(p, 'dismissed', 2);
    const spy = vi.spyOn(t.store as MemoryStore, 'reporterOutcomes');
    const got = t.cw.reports.reporterAccuracy(people);
    expect(got.size).toBe(12);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('duplicates in the list are one entry', async () => {
    const t = await setup();
    const a = t.person();
    t.many(a, 'dismissed', 5);
    const got = t.cw.reports.reporterAccuracy([a, a, a]);
    expect(got.size).toBe(1);
    expect(got.get(a)).toMatchObject({ decided: 5 });
  });

  it('exactly REPORTER_ACCURACY_BATCH_MAX people is fine; one more is a RangeError', async () => {
    const t = await setup();
    const ok = Array.from({ length: REPORTER_ACCURACY_BATCH_MAX }, (_, i) => `s_x${i}`);
    expect(() => t.cw.reports.reporterAccuracy(ok)).not.toThrow();
    expect(() => t.cw.reports.reporterAccuracy([...ok, 's_one_more'])).toThrow(RangeError);
  });

  it('a store without reporterOutcomes gives an empty map and reporterRecord.accuracy is null', async () => {
    const mem = new MemoryStore();
    const bare = new Proxy(mem, {
      get(target, prop, receiver) {
        if (prop === 'reporterOutcomes') return undefined;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const t = await setup(bare);
    const a = t.person();
    t.many(a, 'dismissed', 6);
    expect(t.cw.reports.reporterAccuracy([a]).size).toBe(0);
    expect(t.cw.reports.reporterRecord(a)).toMatchObject({ reports: 6, dismissed: 6, accuracy: null });
  });

  it('reporterRecord carries accuracy and its other counts are unchanged', async () => {
    const t = await setup();
    const a = t.person();
    t.file(a, 'open');
    t.many(a, 'dismissed', 4);
    t.file(a, 'upheld');
    const rec = t.cw.reports.reporterRecord(a);
    expect(rec).toMatchObject({
      reports: 6,
      open: 1,
      actioned: 1,
      dismissed: 4,
      badFaith: 0,
      suspendedUntil: null,
      reasonMatched: 0,
      reasonDecided: 0,
    });
    expect(rec.accuracy).toMatchObject({ decided: 5, noAction: 4, unfounded: 4, falseRate: 0.8, habitual: true });
  });

  it('reporterRecord.accuracy for a person with no decided reports is a summary of zeros, not null', async () => {
    const t = await setup();
    const a = t.person();
    expect(t.cw.reports.reporterRecord(a).accuracy).toMatchObject({ decided: 0, falseRate: null, noticeable: false, habitual: false });
  });

  it('bulk-style dismissals count like any other and never suspend anyone', async () => {
    const t = await setup();
    const a = t.person();
    t.many(a, 'dismissed', 30);
    expect(t.cw.reports.reporterAccuracy([a]).get(a)).toMatchObject({ habitual: true, badFaith: 0 });
    expect(t.cw.reports.reporterRecord(a).suspendedUntil).toBeNull();
  });
});

describe('reporterAccuracyFor (the function)', () => {
  it('queries with since = now - window and canonical + alias ids', async () => {
    const t = await setup();
    const a = t.person();
    const spy = vi.spyOn(t.store as MemoryStore, 'reporterOutcomes');
    const subjects = { canonical: (s: string) => s, aliasesOf: (s: string) => [s, `${s}-alias`] };
    reporterAccuracyFor(t.store, subjects as never, [a], NOW);
    expect(spy).toHaveBeenCalledWith([a, `${a}-alias`], NOW - REPORTER_ACCURACY_WINDOW_MS);
  });
});

describe('overturned reports (0.2.1): a report whose sanction was overturned on appeal is neither upheld nor dismissed', () => {
  const overturn = (store: Store, groupId: string, reportId: string): void => {
    expect((store as ReturnType<typeof withMemoryAppeals<MemoryStore>>).recordOverturn({ groupId, at: NOW, subject: 's_x', aliases: ['s_x'], source: 'moderator', termId: null, filterKey: null, reportId, strikes: null })).toBe(true);
  };

  it('summarizeOutcomes: overturned is not in decided, defaults to 0 and is never a false report', () => {
    expect(summarizeOutcomes({ actioned: 2, noAction: 1, badFaith: 0 })).toMatchObject({ decided: 3, overturned: 0 });
    const s = summarizeOutcomes({ actioned: 3, noAction: 5, badFaith: 0, overturned: 2 });
    expect(s).toMatchObject({ decided: 8, noAction: 5, unfounded: 5, overturned: 2, falseRate: 5 / 8, noticeable: true, habitual: false });
    // an overturned report moves nothing: the same outcomes without it rate the same
    expect(summarizeOutcomes({ actioned: 3, noAction: 5, badFaith: 0 })).toMatchObject({ falseRate: 5 / 8, decided: 8 });
    // and a lot of them do not make a reporter noticeable
    expect(summarizeOutcomes({ actioned: 0, noAction: 0, badFaith: 0, overturned: 50 })).toMatchObject({ decided: 0, falseRate: null, noticeable: false, habitual: false, overturned: 50 });
  });

  it('an actioned report that was overturned is not in actioned, not in decided, and is in overturned', async () => {
    const t = await setup(withMemoryAppeals(new MemoryStore()));
    const a = t.person();
    const kept = t.file(a, 'upheld');
    const reversed = t.file(a, 'upheld');
    overturn(t.store, 'g1', reversed);
    expect(kept).not.toBe(reversed);
    expect(t.cw.reports.reporterAccuracy([a]).get(a)).toMatchObject({ decided: 1, noAction: 0, badFaith: 0, unfounded: 0, overturned: 1 });
    // the store row says the same
    expect(t.store.reporterOutcomes?.([a], 0)).toEqual([{ reporter: a, actioned: 1, noAction: 0, badFaith: 0, overturned: 1 }]);
  });

  it('five upheld and five dismissed with two of the upheld overturned: decided 8, falseRate 5/8', async () => {
    const t = await setup(withMemoryAppeals(new MemoryStore()));
    const a = t.person();
    const upheld = Array.from({ length: 5 }, () => t.file(a, 'upheld'));
    t.many(a, 'dismissed', 5);
    overturn(t.store, 'g1', upheld[0] as string);
    overturn(t.store, 'g2', upheld[1] as string);
    const got = t.cw.reports.reporterAccuracy([a]).get(a);
    expect(got).toMatchObject({ decided: 8, noAction: 5, unfounded: 5, overturned: 2, falseRate: 5 / 8, noticeable: true, habitual: false });
    // control: without the overturns the rate is 5/10
    const c = await setup(withMemoryAppeals(new MemoryStore()));
    const b = c.person();
    c.many(b, 'upheld', 5);
    c.many(b, 'dismissed', 5);
    expect(c.cw.reports.reporterAccuracy([b]).get(b)).toMatchObject({ decided: 10, falseRate: 0.5, overturned: 0 });
  });

  it('a reporter with only overturned reports appears with decided 0 and overturned 2 and no rate', async () => {
    const t = await setup(withMemoryAppeals(new MemoryStore()));
    const a = t.person();
    const other = t.person();
    overturn(t.store, 'g1', t.file(a, 'upheld'));
    overturn(t.store, 'g2', t.file(a, 'noted'));
    const got = t.cw.reports.reporterAccuracy([a, other]);
    expect([...got.keys()]).toEqual([a]);
    expect(got.get(a)).toMatchObject({ decided: 0, noAction: 0, badFaith: 0, unfounded: 0, falseRate: null, noticeable: false, habitual: false, overturned: 2 });
    // reporterRecord shows it too
    expect(t.cw.reports.reporterRecord(a).accuracy).toMatchObject({ decided: 0, overturned: 2 });
  });

  it('a person with no decided and no overturned report is still absent, and an open report is not an overturned one', async () => {
    const t = await setup(withMemoryAppeals(new MemoryStore()));
    const a = t.person();
    t.many(a, 'open', 3);
    expect(t.cw.reports.reporterAccuracy([a]).size).toBe(0);
  });

  it('a store whose rows have no overturned field (a 0.2.0 store) reads as 0', async () => {
    const mem = new MemoryStore();
    const old = new Proxy(mem, {
      get(target, prop, receiver) {
        if (prop === 'reporterOutcomes') {
          return (reporters: string[], since: number) => target.reporterOutcomes(reporters, since).map(({ reporter, actioned, noAction, badFaith }) => ({ reporter, actioned, noAction, badFaith }));
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const t = await setup(old);
    const a = t.person();
    t.many(a, 'upheld', 2);
    t.many(a, 'dismissed', 3);
    const got = t.cw.reports.reporterAccuracy([a]).get(a);
    expect(got).toMatchObject({ decided: 5, noAction: 3, overturned: 0, falseRate: 0.6 });
    expect(Number.isFinite(got?.overturned)).toBe(true);
  });

  it('merged aliases are one reporter for overturned reports too', async () => {
    const t = await setup(withMemoryAppeals(new MemoryStore()));
    const a = t.person();
    const b = t.person();
    overturn(t.store, 'g1', t.file(a, 'upheld'));
    overturn(t.store, 'g2', t.file(b, 'upheld'));
    t.cw.rooms.seat('merge-room-ov', 'p1', { clientKey: 'raw-client-key-acc-0001', accountId: 'acct-ov' }, 'X');
    t.cw.rooms.seat('merge-room-ov', 'p2', { clientKey: 'raw-client-key-acc-0002', accountId: 'acct-ov' }, 'Y');
    await t.cw.flush();
    expect([...t.cw.reports.reporterAccuracy([a]).values()][0]).toMatchObject({ decided: 0, overturned: 2 });
  });

  it('end to end: file, decide (upheld), appeal revoked, then reporterAccuracy shows it as overturned; an uphold on appeal changes nothing', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const s = await k.sanction();
    const reporter = k.store.loadReport(s.reportId)?.reporterSubject as string;
    expect(k.cw.reports.reporterAccuracy([reporter]).get(reporter)).toMatchObject({ decided: 1, overturned: 0 });
    const filed = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    expect((await k.cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'revoke', actor: 'senior_bea', reason: 'second look' })).ok).toBe(true);
    expect(k.cw.reports.reporterAccuracy([reporter]).get(reporter)).toMatchObject({ decided: 0, noAction: 0, unfounded: 0, falseRate: null, overturned: 1 });
    // a second report by the same reporter, upheld on appeal: it stays decided
    const t = await k.sanction();
    const f2 = k.cw.appeals.file(t.who, { noticeId: t.noticeId, statement: 'Please look again.' });
    if (!f2.ok) throw new Error('filing refused');
    await k.cw.appeals.decide({ appealId: f2.appeal.id, outcome: 'uphold', actor: 'senior_bea', reason: 'second look' });
    expect(k.cw.reports.reporterAccuracy([reporter]).get(reporter)).toMatchObject({ decided: 1, overturned: 1 });
  });
});
