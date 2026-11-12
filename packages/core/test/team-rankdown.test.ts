import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { REPORTER_ACCURACY_MIN_DECIDED, REPORTER_RANK_LAPSE_MS, RANK_DOWN_SCAN_MAX, createChatwarden } from '../src/index.js';
import type { Chatwarden, RawWho, Store, StoredReport } from '../src/index.js';

// Take-next with `rankDownHabitual`: a case whose reports all come from habitual false reporters (and none has waited 24 hours) is
// served after the ordinary cases; nothing is skipped for good, and the default is unchanged.

const NOW = 1_800_000_000_000;
const SEC = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANK = { rankDownHabitual: true };

async function setup(store: Store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const cw: Chatwarden = await createChatwarden({
    store,
    secret: 'rankdown-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    retention: false,
    logger: { warn() {} },
  });
  let n = 0;
  let seeded = 0;
  /** Give the reporter (by client key) a history of decided reports: `dismissed` unfounded and `upheld` founded, a few days old. */
  const history = (key: string, dismissed: number, upheld = 0) => {
    const room = `hist-${key}`;
    cw.rooms.seat(room, 'p1', { clientKey: key }, 'Rep');
    const reporter = cw.rooms.subjectAt(room, 'p1') as string;
    const add = (status: 'dismissed' | 'actioned') => {
      const id = `hist${++seeded}`;
      const rec: StoredReport = {
        id,
        createdAt: clock.t - 3 * DAY,
        roomId: `hroom-${id}`,
        tags: {},
        reporterSubject: reporter,
        reporterSeat: 'p1',
        reporterHandle: 'Rep',
        targetSubject: `s_old_${id}`,
        targetSeat: 'p2',
        targetHandle: 'Tgt',
        category: 'harassment',
        note: null,
        lineId: null,
        excerpt: [],
        people: [],
        status: 'open',
      };
      store.insertReport(rec);
      store.closeReport(id, status, false, 'mod', clock.t - 2 * DAY, 'n');
    };
    for (let i = 0; i < dismissed; i++) add('dismissed');
    for (let i = 0; i < upheld; i++) add('actioned');
    return reporter;
  };
  /** A habitual reporter: 5 of 5 unfounded (a rate of 1). */
  const habitual = (key: string) => history(key, REPORTER_ACCURACY_MIN_DECIDED);
  /** File a report by `reporterKey` against `targetKey` (a person made on first use). Time moves on a second. */
  const fileFrom = async (reporterKey: string, targetKey: string, category: 'harassment' | 'spam' | 'cheating' = 'harassment') => {
    n += 1;
    const room = `rk-room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: reporterKey }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: targetKey }, 'Tgt');
    cw.chat.accept(room, 'p2', 'a line');
    clock.t += SEC;
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { id: res.reportId, person: cw.reports.get(res.reportId)!.targetPerson };
  };
  return { cw, store, clock, history, habitual, fileFrom };
}

describe('constants', () => {
  it('the lapse is 24 hours and the scan reads at most 1000 reports', () => {
    expect(REPORTER_RANK_LAPSE_MS).toBe(24 * HOUR);
    expect(RANK_DOWN_SCAN_MAX).toBe(1_000);
  });
});

describe('cases.next: default behaviour is unchanged', () => {
  it('oldest case first, whoever reported it, with the flag absent, false or undefined', async () => {
    for (const filter of [undefined, {}, { rankDownHabitual: false }, { rankDownHabitual: undefined }]) {
      const t = await setup();
      t.habitual('hab');
      const a = await t.fileFrom('hab', 'tk-a');
      const b = await t.fileFrom('ordinary', 'tk-b');
      expect(t.cw.cases.next('mod-a', filter)).toMatchObject({ person: a.person, reportId: a.id });
      expect(t.cw.cases.next('mod-b', filter)).toMatchObject({ person: b.person });
    }
  });

  it('a non-boolean rankDownHabitual is a RangeError that claims nothing', async () => {
    const t = await setup();
    const a = await t.fileFrom('ordinary', 'tk-a');
    for (const bad of ['yes', 1, null, {}]) {
      expect(() => t.cw.cases.next('mod-a', { rankDownHabitual: bad } as never)).toThrow(RangeError);
    }
    expect(t.cw.cases.holder(a.person)).toBeNull();
  });
});

describe('cases.next: rankDownHabitual', () => {
  it('a case whose only reporters are habitual is served after a newer normal case', async () => {
    const t = await setup();
    t.habitual('hab');
    const old = await t.fileFrom('hab', 'tk-old');
    const newer = await t.fileFrom('ordinary', 'tk-new');
    expect(t.cw.cases.next('mod-a', RANK)).toMatchObject({ person: newer.person, reportId: newer.id });
    // Then the ranked-down case, not nothing.
    expect(t.cw.cases.next('mod-a', RANK)).toMatchObject({ person: old.person, reportId: old.id });
    expect(t.cw.cases.next('mod-a', RANK)).toBeNull();
  });

  it('a case with one habitual and one ordinary reporter is not ranked down', async () => {
    const t = await setup();
    t.habitual('hab');
    const mixed = await t.fileFrom('hab', 'tk-mixed');
    await t.fileFrom('ordinary-1', 'tk-mixed');
    const later = await t.fileFrom('ordinary-2', 'tk-later');
    // The mixed case is older and has an ordinary reporter, so it stays first.
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(mixed.person);
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(later.person);
  });

  it('two habitual reporters together still rank a case down', async () => {
    const t = await setup();
    t.habitual('hab-1');
    t.habitual('hab-2');
    const down = await t.fileFrom('hab-1', 'tk-down');
    await t.fileFrom('hab-2', 'tk-down');
    const normal = await t.fileFrom('ordinary', 'tk-normal');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(normal.person);
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(down.person);
  });

  it('a case waiting longer than the lapse is not ranked down (23:59:59 vs 24:00:00 vs 24:00:01 on the injected clock)', async () => {
    for (const [waited, rankedDown] of [
      [REPORTER_RANK_LAPSE_MS - SEC, true],
      [REPORTER_RANK_LAPSE_MS - 1, true],
      [REPORTER_RANK_LAPSE_MS, false],
      [REPORTER_RANK_LAPSE_MS + SEC, false],
    ] as const) {
      const t = await setup();
      t.habitual('hab');
      const old = await t.fileFrom('hab', 'tk-old');
      const filedAt = t.clock.t;
      const newer = await t.fileFrom('ordinary', 'tk-new');
      t.clock.t = filedAt + waited;
      const first = t.cw.cases.next('mod-a', RANK);
      expect(first?.person, `waited ${waited}`).toBe(rankedDown ? newer.person : old.person);
    }
  });

  it('one report over the lapse makes the whole case normal, even when a newer report is from a habitual reporter too', async () => {
    const t = await setup();
    t.habitual('hab-1');
    t.habitual('hab-2');
    const old = await t.fileFrom('hab-1', 'tk-old');
    t.clock.t += 2 * HOUR;
    await t.fileFrom('hab-2', 'tk-old');
    const middle = await t.fileFrom('ordinary', 'tk-mid');
    t.clock.t = NOW + 25 * HOUR; // the first report is past the lapse
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(old.person);
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(middle.person);
  });

  it('only habitual cases left: they are all served, oldest first', async () => {
    const t = await setup();
    t.habitual('hab');
    const a = await t.fileFrom('hab', 'tk-a');
    const b = await t.fileFrom('hab', 'tk-b');
    const c = await t.fileFrom('hab', 'tk-c');
    expect([t.cw.cases.next('mod-a', RANK)?.person, t.cw.cases.next('mod-a', RANK)?.person, t.cw.cases.next('mod-a', RANK)?.person]).toEqual([
      a.person,
      b.person,
      c.person,
    ]);
    expect(t.cw.cases.next('mod-a', RANK)).toBeNull();
  });

  it('ranked-down cases keep their own order among themselves: oldest first, after all the normal ones', async () => {
    const t = await setup();
    t.habitual('hab');
    const h1 = await t.fileFrom('hab', 'tk-h1');
    const n1 = await t.fileFrom('ordinary-1', 'tk-n1');
    const h2 = await t.fileFrom('hab', 'tk-h2');
    const n2 = await t.fileFrom('ordinary-2', 'tk-n2');
    const served = [1, 2, 3, 4].map(() => t.cw.cases.next('mod-a', RANK)?.person);
    expect(served).toEqual([n1.person, n2.person, h1.person, h2.person]);
  });

  it('below the minimum sample nobody is ranked down', async () => {
    const t = await setup();
    t.history('few', REPORTER_ACCURACY_MIN_DECIDED - 1); // 4 of 4 unfounded, but too few to say
    const old = await t.fileFrom('few', 'tk-old');
    await t.fileFrom('ordinary', 'tk-new');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(old.person);
  });

  it('exactly the minimum sample at the habitual rate ranks down; one founded report in five is still 0.8', async () => {
    const t = await setup();
    t.history('edge', 4, 1); // 4 of 5 unfounded = 0.8
    t.history('under', 3, 2); // 3 of 5 = 0.6: noticeable, not habitual
    const edge = await t.fileFrom('edge', 'tk-edge');
    const under = await t.fileFrom('under', 'tk-under');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(under.person);
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(edge.person);
  });

  it('a ranked-down case held by another moderator is skipped without a write', async () => {
    const t = await setup();
    t.habitual('hab');
    const down1 = await t.fileFrom('hab', 'tk-d1');
    const down2 = await t.fileFrom('hab', 'tk-d2');
    t.cw.cases.claim(down1.person, 'mod-b');
    const claimCase = vi.spyOn(t.store as MemoryStore, 'claimCase');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(down2.person);
    // One write: the winning claim. The held ranked-down case was never attempted.
    expect(claimCase).toHaveBeenCalledTimes(1);
    expect(claimCase.mock.calls[0]?.[0]).toBe(down2.person);
  });

  it('with a normal case free, no ranked-down case is written to at all', async () => {
    const t = await setup();
    t.habitual('hab');
    await t.fileFrom('hab', 'tk-d1');
    await t.fileFrom('hab', 'tk-d2');
    const normal = await t.fileFrom('ordinary', 'tk-n');
    const claimCase = vi.spyOn(t.store as MemoryStore, 'claimCase');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(normal.person);
    expect(claimCase).toHaveBeenCalledTimes(1);
  });

  it('the scan stops at RANK_DOWN_SCAN_MAX and serves the oldest ranked-down case', async () => {
    const t = await setup();
    t.habitual('hab');
    const down = await t.fileFrom('hab', 'tk-down');
    // RANK_DOWN_SCAN_MAX - 1 more cases, every one held by someone else, then one free normal case beyond the cap.
    let at = t.clock.t;
    const seed = (i: number, reporter: string, target: string) => {
      t.store.insertReport({
        id: `bulk${String(i).padStart(5, '0')}`,
        createdAt: at + i,
        roomId: `bulk-room-${i}`,
        tags: {},
        reporterSubject: reporter,
        reporterSeat: 'p1',
        reporterHandle: 'Rep',
        targetSubject: target,
        targetSeat: 'p2',
        targetHandle: 'Tgt',
        category: 'harassment',
        note: null,
        lineId: null,
        excerpt: [],
        people: [],
        status: 'open',
      });
    };
    for (let i = 1; i < RANK_DOWN_SCAN_MAX; i++) {
      seed(i, `s_nr${i}`, `s_nt${i}`);
      expect(t.cw.cases.claim(`s_nt${i}`, 'mod-x').ok).toBe(true);
    }
    seed(RANK_DOWN_SCAN_MAX, 's_nr_free', 's_nt_free');
    at += 0;
    const got = t.cw.cases.next('mod-a', RANK);
    expect(got?.person).toBe(down.person);
    // Without the flag the scan has no cap: it finds the free case beyond the 1000th report... after the (oldest) down case.
    const plain = await setup();
    plain.habitual('hab');
    await plain.fileFrom('hab', 'tk-down');
    expect(plain.cw.cases.next('mod-a')).not.toBeNull();
  }, 60_000);

  it('two moderators racing never get the same case in either mode', async () => {
    for (const filter of [undefined, RANK]) {
      const t = await setup();
      t.habitual('hab');
      const cases = [await t.fileFrom('hab', 'tk-1'), await t.fileFrom('ordinary', 'tk-2'), await t.fileFrom('hab', 'tk-3'), await t.fileFrom('ordinary-2', 'tk-4')];
      const got = [
        t.cw.cases.next('mod-a', filter),
        t.cw.cases.next('mod-b', filter),
        t.cw.cases.next('mod-a', filter),
        t.cw.cases.next('mod-b', filter),
        t.cw.cases.next('mod-c', filter),
      ];
      const people = got.map((g) => g?.person);
      expect(people.slice(0, 4).sort()).toEqual(cases.map((c) => c.person).sort());
      expect(new Set(people.slice(0, 4)).size).toBe(4);
      expect(got[4]).toBeNull();
    }
  });

  it('the category and reason filters still apply', async () => {
    const t = await setup();
    t.habitual('hab');
    const spamDown = await t.fileFrom('hab', 'tk-spam-down', 'spam');
    await t.fileFrom('ordinary', 'tk-harass', 'harassment');
    const spamNormal = await t.fileFrom('ordinary-2', 'tk-spam', 'spam');
    expect(t.cw.cases.next('mod-a', { ...RANK, category: 'spam' })?.person).toBe(spamNormal.person);
    expect(t.cw.cases.next('mod-a', { ...RANK, category: 'spam' })?.person).toBe(spamDown.person);
    expect(t.cw.cases.next('mod-a', { ...RANK, category: 'spam' })).toBeNull();
    // The harassment case was never handed out by a spam-only filter.
    expect(t.cw.cases.next('mod-a', { ...RANK, category: 'cheating' })).toBeNull();
    expect(t.cw.cases.next('mod-a', { ...RANK, reason: null })).toBeNull();
  });

  it('a store with no reporterOutcomes ranks nobody down', async () => {
    const mem = new MemoryStore();
    const bare = new Proxy(mem, {
      get(target, prop, receiver) {
        if (prop === 'reporterOutcomes') return undefined;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const t = await setup(bare);
    t.habitual('hab');
    const old = await t.fileFrom('hab', 'tk-old');
    await t.fileFrom('ordinary', 'tk-new');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(old.person);
  });

  it('a merged reporter alias counts: the reporter is judged on all their accounts together', async () => {
    const t = await setup();
    // Half of the unfounded history is under one key, half under another; an account links them into one person.
    t.history('hab-a', 3);
    t.history('hab-b', 2);
    t.cw.rooms.seat('merge-room', 'p1', { clientKey: 'hab-a', accountId: 'acct-9' }, 'X');
    t.cw.rooms.seat('merge-room', 'p2', { clientKey: 'hab-b', accountId: 'acct-9' }, 'Y');
    await t.cw.flush();
    const old = await t.fileFrom('hab-a', 'tk-old');
    const newer = await t.fileFrom('ordinary', 'tk-new');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(newer.person);
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(old.person);
  });

  it('is lazy: with an ordinary case first, only a slice of candidates is ranked, not the whole page', async () => {
    const t = await setup();
    for (let i = 0; i < 40; i++) await t.fileFrom(`ordinary-${i}`, `tk-${i}`);
    const reads = vi.spyOn(t.store as MemoryStore, 'listOpenReportsByPerson');
    const first = t.cw.cases.next('mod-a', RANK);
    expect(first).not.toBeNull();
    // One read per ranked candidate (at most a slice of 20) plus the one that opens the winner on its newest report.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(21);
    // The default path never ranks: only the winner's read.
    reads.mockClear();
    t.cw.cases.next('mod-b');
    expect(reads.mock.calls.length).toBe(1);
  });

  it('later slices are still ranked: a normal case behind more than one slice of ranked-down ones is found first', async () => {
    const t = await setup();
    const downs = [];
    for (let i = 0; i < 25; i++) {
      t.habitual(`hab-${i}`);
      downs.push(await t.fileFrom(`hab-${i}`, `tk-down-${i}`));
    }
    const normal = await t.fileFrom('ordinary', 'tk-normal');
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(normal.person);
    expect(t.cw.cases.next('mod-a', RANK)?.person).toBe(downs[0]?.person);
  });

  it('records no audit row and does not change a claim it did not take', async () => {
    const t = await setup();
    t.habitual('hab');
    const down = await t.fileFrom('hab', 'tk-down');
    t.cw.cases.claim(down.person, 'mod-b');
    const before = t.cw.cases.holder(down.person);
    expect(t.cw.cases.next('mod-a', RANK)).toBeNull();
    expect(t.cw.cases.holder(down.person)).toEqual(before);
    expect(t.cw.audit.list({ limit: 10 }).items).toEqual([]);
  });
});
