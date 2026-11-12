import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, withMemorySignals } from '@chatwarden/store-memory';
import { CaseDesk, SIGNAL_BOOST_SCAN_MAX } from '../src/team.js';
import { REPORTER_ACCURACY_MIN_DECIDED, REPORTER_RANK_LAPSE_MS } from '../src/index.js';
import { CLAIM_TTL_MS } from '../src/types.js';
import { SubjectIndex } from '../src/subjects.js';
import type { StoredReport, SubjectId } from '../src/types.js';
import { DAY, sworld } from './signalsWorld.js';

// Take-next with `signalBoost`: a boosted case is claimed ahead of older ordinary ones, an overdue case ahead of everything newer, and
// nothing ever leaves the queue.

const SEC = 1000;
const HOUR = 3_600_000;
const BOOST = { signalBoost: true };
const FEED = { queue: { kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14 } };

async function setup(feeds: Record<string, unknown> | null = FEED) {
  const w = await sworld(feeds === null ? {} : { feeds });
  let n = 0;
  let seeded = 0;
  const muters = [1, 2, 3, 4].map((i) => w.person(`muter-${i}`));
  /** File one report by a fresh reporter (or the given key) against a fresh target. Time moves on a second. */
  const file = async (reporterKey?: string) => {
    n += 1;
    const room = `tr-room-${n}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: reporterKey ?? `reporter-${n}` }, 'Rep');
    w.cw.rooms.seat(room, 'p2', { clientKey: `target-${n}` }, 'Tgt');
    w.cw.chat.accept(room, 'p2', 'a line');
    w.clock.t += SEC;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { id: res.reportId, person: w.cw.reports.get(res.reportId)!.targetPerson as SubjectId };
  };
  /** Make a person meet the queue feed: three distinct players muted them. */
  const boost = (person: SubjectId): void => {
    for (const by of muters.slice(0, 3)) expect(w.cw.signals.record({ kind: 'muted_by_player', subject: person, by })).toBe(true);
  };
  /** A reporter with a history of dismissed reports (habitual). */
  const habitual = (key: string): void => {
    const room = `hist-${key}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: key }, 'Rep');
    const reporter = w.cw.rooms.subjectAt(room, 'p1') as string;
    for (let i = 0; i < REPORTER_ACCURACY_MIN_DECIDED; i += 1) {
      const id = `hist${++seeded}`;
      const rec: StoredReport = {
        id,
        createdAt: w.clock.t - 3 * DAY,
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
      w.store.insertReport(rec);
      w.store.closeReport(id, 'dismissed', false, 'mod', w.clock.t - 2 * DAY, 'n');
    }
  };
  return { ...w, file, boost, habitual };
}

describe('constants', () => {
  it('the scan reads at most 200 people', () => {
    expect(SIGNAL_BOOST_SCAN_MAX).toBe(200);
  });
});

describe('without the filter take-next is unchanged', () => {
  it('oldest case first, boosted or not, with the flag absent, false or undefined', async () => {
    for (const filter of [undefined, {}, { signalBoost: false }, { signalBoost: undefined }]) {
      const t = await setup();
      const a = await t.file();
      const b = await t.file();
      t.boost(b.person);
      expect(t.cw.cases.next('mod-a', filter)).toMatchObject({ person: a.person, reportId: a.id });
      expect(t.cw.cases.next('mod-b', filter)).toMatchObject({ person: b.person });
    }
  });

  it('signalBoost must be a boolean: anything else is a RangeError that claims nothing', async () => {
    const t = await setup();
    const a = await t.file();
    for (const bad of ['yes', 1, null, {}, [], 0]) {
      expect(() => t.cw.cases.next('mod-a', { signalBoost: bad } as never), String(bad)).toThrow(RangeError);
    }
    expect(t.cw.cases.holder(a.person)).toBeNull();
  });

  it('with the flag on but nobody boosted (or the feed off) it is oldest first', async () => {
    for (const feeds of [FEED, null]) {
      const t = await setup(feeds);
      const a = await t.file();
      const b = await t.file();
      if (feeds !== null) t.boost(b.person);
      else for (const by of [1, 2, 3].map((i) => t.person(`m${i}`))) t.cw.signals.record({ kind: 'muted_by_player', subject: b.person, by });
      const first = t.cw.cases.next('mod-a', BOOST);
      expect(first?.person).toBe(feeds === null ? a.person : b.person);
    }
  });
});

describe('cases.next with signalBoost', () => {
  it('a boosted newer case is claimed before an ordinary older one, and nothing is dropped', async () => {
    const t = await setup();
    const old = await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
    expect(t.cw.cases.next('mod-a', BOOST)).toBeNull();
  });

  it('an overdue ordinary case is claimed before a newer boosted one', async () => {
    const t = await setup();
    const old = await t.file();
    t.clock.t += REPORTER_RANK_LAPSE_MS;
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
  });

  it('a case that has waited just under 24 hours is not overdue; at 24 hours it is', async () => {
    const t = await setup();
    const old = await t.file();
    t.clock.t += REPORTER_RANK_LAPSE_MS - 2 * SEC;
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    t.cw.cases.release(newer.person, 'mod-a');
    t.clock.t += 2 * SEC;
    expect(t.cw.cases.next('mod-b', BOOST)).toMatchObject({ person: old.person });
  });

  it('among boosted, oldest first', async () => {
    const t = await setup();
    const ordinary = await t.file();
    const b1 = await t.file();
    const b2 = await t.file();
    t.boost(b2.person);
    t.boost(b1.person);
    const order = [1, 2, 3].map(() => t.cw.cases.next('mod-a', BOOST)?.person);
    expect(order).toEqual([b1.person, b2.person, ordinary.person]);
  });

  it('a boosted case held by someone is skipped (and costs no claim write)', async () => {
    const t = await setup();
    const old = await t.file();
    const boosted = await t.file();
    t.boost(boosted.person);
    expect(t.cw.cases.claim(boosted.person, 'mod-x')).toMatchObject({ ok: true });
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
  });

  it('a stream of boosted cases cannot starve an old case past 24 hours', async () => {
    const t = await setup();
    const old = await t.file();
    // Boosted cases arrive all day; each is claimed ahead of the old one until it is 24 hours old, and never after.
    const claimed: SubjectId[] = [];
    for (let i = 0; i < 4; i += 1) {
      t.clock.t += 5 * HOUR;
      const b = await t.file();
      t.boost(b.person);
      claimed.push(t.cw.cases.next('mod-a', BOOST)!.person);
    }
    expect(claimed).not.toContain(old.person);
    t.clock.t += 5 * HOUR;
    const late = await t.file();
    t.boost(late.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
    // Then the boosted ones (the earlier claims have lapsed), oldest first: the old case was not starved, and nothing else was lost.
    const rest = [1, 2, 3, 4, 5].map(() => t.cw.cases.next('mod-a', BOOST)?.person);
    expect(new Set(rest).size).toBe(5);
    expect(rest).not.toContain(old.person);
    expect(rest[4]).toBe(late.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toBeNull();
  });

  it('nothing is dropped: draining the queue claims every case once', async () => {
    const t = await setup();
    const all = [];
    for (let i = 0; i < 12; i += 1) {
      const c = await t.file();
      if (i % 3 === 0) t.boost(c.person);
      all.push(c.person);
    }
    const got: SubjectId[] = [];
    for (;;) {
      const next = t.cw.cases.next('mod-a', BOOST);
      if (next === null) break;
      got.push(next.person);
    }
    expect([...got].sort()).toEqual([...all].sort());
    expect(new Set(got).size).toBe(all.length);
    // The boosted ones came first, oldest first among them.
    expect(got.slice(0, 4)).toEqual([all[0], all[3], all[6], all[9]]);
  });

  it('the category and reason filters still apply', async () => {
    const t = await setup();
    const a = await t.file();
    t.boost(a.person);
    expect(t.cw.cases.next('mod-a', { ...BOOST, category: 'cheating' })).toBeNull();
    expect(t.cw.cases.next('mod-a', { ...BOOST, category: 'harassment' })).toMatchObject({ person: a.person });
  });
});

describe('it composes with rankDownHabitual', () => {
  it('a boosted habitual-reporter case is not ranked down; an unboosted one still is', async () => {
    const t = await setup();
    t.habitual('hab-1');
    t.habitual('hab-2');
    const downOld = await t.file('hab-1');
    const ordinary = await t.file();
    const boostedHabitual = await t.file('hab-2');
    t.boost(boostedHabitual.person);
    const both = { rankDownHabitual: true, signalBoost: true };
    expect(t.cw.cases.next('mod-a', both)).toMatchObject({ person: boostedHabitual.person });
    expect(t.cw.cases.next('mod-a', both)).toMatchObject({ person: ordinary.person });
    expect(t.cw.cases.next('mod-a', both)).toMatchObject({ person: downOld.person });
    expect(t.cw.cases.next('mod-a', both)).toBeNull();
  });

  it('rankDownHabitual alone is as it was, and an overdue habitual case ranks normally with both', async () => {
    const t = await setup();
    t.habitual('hab-1');
    const downOld = await t.file('hab-1');
    t.clock.t += REPORTER_RANK_LAPSE_MS;
    const ordinary = await t.file();
    t.boost(ordinary.person);
    // The habitual case has waited 24 hours: it ranks normally, and being the oldest overdue case it comes first.
    expect(t.cw.cases.next('mod-a', { rankDownHabitual: true, signalBoost: true })).toMatchObject({ person: downOld.person });
  });
});

describe('the scan', () => {
  /** Synthetic open reports straight into the store: `count` ordinary cases, then (optionally) one boosted case at the end. */
  async function queued(count: number, boostedLast: boolean) {
    const t = await setup();
    const people: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `bulk-${String(i).padStart(4, '0')}`;
      t.store.insertReport({
        id,
        createdAt: t.clock.t - 10 * HOUR + i,
        roomId: `bulk-room-${i}`,
        tags: {},
        reporterSubject: `s_rep_${i}`,
        reporterSeat: 'p1',
        reporterHandle: 'Rep',
        targetSubject: `s_bulk_${i}`,
        targetSeat: 'p2',
        targetHandle: 'Tgt',
        category: 'harassment',
        note: null,
        lineId: null,
        excerpt: [],
        people: [],
        status: 'open',
      });
      people.push(`s_bulk_${i}`);
    }
    const last = people[people.length - 1] as string;
    if (boostedLast) {
      for (let k = 0; k < 3; k += 1) {
        t.store.insertSignal?.({ id: `sg${k}`, kind: 'muted_by_player', subject: last, sourceKey: `b:s_by_${k}`, bySubject: `s_by_${k}`, roomId: null, at: t.clock.t, weight: 1, capBucket: Math.floor(t.clock.t / DAY) });
      }
    }
    return { ...t, people, last };
  }

  it('a boosted case inside the first 200 people is found', async () => {
    const t = await queued(200, true);
    expect(t.cw.cases.next('mod-a', BOOST)?.person).toBe(t.last);
  });

  it('the scan cap falls back to the oldest free case: a boosted case beyond the 200th person is not looked for', async () => {
    const t = await queued(205, true);
    expect(t.cw.cases.next('mod-a', BOOST)?.person).toBe(t.people[0]);
  });

  it('boosted is asked in slices of the scan, never for more than 200 people in all', async () => {
    const t = await queued(230, false);
    const people: number[] = [];
    const desk = new CaseDesk({
      store: t.store,
      subjects: new SubjectIndex(t.store, t.clock, { logger: { warn() {} } }),
      clock: t.clock,
      boosted: (p) => {
        people.push(p.length);
        return new Set();
      },
    });
    expect(desk.next('mod-a', BOOST)?.person).toBe(t.people[0]);
    expect(people.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SIGNAL_BOOST_SCAN_MAX);
    expect(people.length).toBeGreaterThan(0);
  });
});

describe('the dependency', () => {
  const deskOver = async () => {
    const t = await setup();
    const a = await t.file();
    const b = await t.file();
    const boosted = vi.fn((people: readonly SubjectId[]) => new Set(people.filter((p) => p === b.person)));
    const desk = new CaseDesk({ store: t.store, subjects: new SubjectIndex(t.store, t.clock, { logger: { warn() {} } }), clock: t.clock, boosted });
    return { t, a, b, boosted, desk };
  };

  it('with the filter off boosted is not called', async () => {
    const { boosted, desk, a } = await deskOver();
    for (const filter of [undefined, {}, { signalBoost: false }]) {
      const got = desk.next('mod-z', filter);
      expect(got?.person).toBe(a.person);
      desk.release(got!.person, 'mod-z');
    }
    expect(boosted).not.toHaveBeenCalled();
  });

  it('with the filter on it is asked, and claims the boosted case', async () => {
    const { boosted, desk, b } = await deskOver();
    expect(desk.next('mod-z', BOOST)?.person).toBe(b.person);
    expect(boosted).toHaveBeenCalled();
  });

  it('with no boosted dependency the filter changes only the overdue rule (nothing boosted)', async () => {
    const t = await setup();
    const a = await t.file();
    await t.file();
    const desk = new CaseDesk({ store: t.store, subjects: new SubjectIndex(t.store, t.clock, { logger: { warn() {} } }), clock: t.clock });
    expect(desk.next('mod-z', BOOST)?.person).toBe(a.person);
  });

  it('a boosted that throws is a failure of the dependency, not of take-next: the oldest case is claimed', async () => {
    const t = await setup();
    const a = await t.file();
    await t.file();
    const desk = new CaseDesk({
      store: t.store,
      subjects: new SubjectIndex(t.store, t.clock, { logger: { warn() {} } }),
      clock: t.clock,
      boosted: () => {
        throw new Error('boom');
      },
    });
    expect(desk.next('mod-z', BOOST)?.person).toBe(a.person);
  });

  it('with the feed off the facade never reads signals for take-next', async () => {
    const t = await setup(null);
    await t.file();
    const b = await t.file();
    const spy = vi.spyOn(t.store as ReturnType<typeof withMemorySignals<MemoryStore>>, 'listSignalSources');
    t.cw.cases.next('mod-a', BOOST);
    expect(spy).not.toHaveBeenCalled();
    void b;
  });
});

// A claim this moderator let lapse (fc-report): the boosted case is claimed ahead of everything, so a moderator who lets it lapse would be
// handed the same case again and again. The rule: for one claim window after the claim lapsed, that case is served to that moderator after
// every other free case. Nothing is skipped for good (it is still served when it is all that is left), and other moderators are not affected.
describe('a claim this moderator let lapse', () => {
  const lapse = (t: { clock: { t: number } }): void => {
    t.clock.t += CLAIM_TTL_MS + SEC;
  };

  it('is served after the other free cases: the boosted case does not come straight back', async () => {
    const t = await setup();
    const old = await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    lapse(t);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
    // Nothing else is free for mod-a now (its own claim on the old case is live): the lapsed one is served, not skipped for good.
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
  });

  it('is only about that moderator: another one is handed the boosted case at once', async () => {
    const t = await setup();
    await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    lapse(t);
    expect(t.cw.cases.next('mod-b', BOOST)).toMatchObject({ person: newer.person });
  });

  it('wears off after one claim window: the boosted case is first again', async () => {
    const t = await setup();
    const old = await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    lapse(t);
    t.clock.t += CLAIM_TTL_MS;
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    void old;
  });

  it('a case still held (not lapsed) is skipped as before; the lapsed rule adds nothing to it', async () => {
    const t = await setup();
    const old = await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    t.clock.t += SEC;
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
    expect(t.cw.cases.next('mod-a', BOOST)).toBeNull();
  });

  it('holds for an overdue case too: an old case this moderator let lapse goes behind a newer ordinary one', async () => {
    const t = await setup();
    const old = await t.file();
    t.clock.t += REPORTER_RANK_LAPSE_MS;
    const newer = await t.file();
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
    lapse(t);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
  });

  it('a lapse two windows old no longer counts: the boosted case is first again', async () => {
    const t = await setup();
    const a = await t.file();
    const boosted = await t.file();
    t.boost(boosted.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: boosted.person });
    lapse(t);
    lapse(t);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: boosted.person });
    void a;
  });

  it('without signalBoost nothing changes: the same oldest case is handed back after a lapse', async () => {
    const t = await setup();
    const old = await t.file();
    await t.file();
    expect(t.cw.cases.next('mod-a')).toMatchObject({ person: old.person });
    lapse(t);
    expect(t.cw.cases.next('mod-a')).toMatchObject({ person: old.person });
  });

  it('many claims by many moderators do not break take-next (the markers stay bounded)', async () => {
    const t = await setup();
    const cases = [];
    for (let i = 0; i < 30; i += 1) cases.push(await t.file());
    for (let i = 0; i < 30; i += 1) expect(t.cw.cases.next(`mod-${i}`, BOOST)).not.toBeNull();
    lapse(t);
    expect(t.cw.cases.next('mod-0', BOOST)).not.toBeNull();
  });
});

// FC M7: the lapsed marker means "let it lapse", nothing wider. A moderator who released the case, decided it, or kept it alive is not
// treated as one who let it lapse.
describe('the lapsed marker is only for a claim that ran out unheld', () => {
  const lapse = (t: { clock: { t: number } }): void => {
    t.clock.t += CLAIM_TTL_MS + SEC;
  };

  it('a case released early is first again after the old expiry, not pushed behind', async () => {
    const t = await setup();
    await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    expect(t.cw.cases.release(newer.person, 'mod-a')).toBe(true);
    lapse(t);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
  });

  it('a case decided and released (releaseWhenDone) is not read as lapsed when the same person is reported again later', async () => {
    const t = await setup();
    const old = await t.file();
    const file = async (seat: string): Promise<string> => {
      t.clock.t += SEC;
      const res = await t.cw.reports.submit({ roomId: 'dec-room', reporterSeat: seat, targetSeat: 'p2', category: 'harassment' });
      if (!res.ok) throw new Error(`refused: ${res.refused}`);
      return res.reportId;
    };
    t.cw.rooms.seat('dec-room', 'p1', { clientKey: 'dec-rep-1' }, 'R1');
    t.cw.rooms.seat('dec-room', 'p3', { clientKey: 'dec-rep-2' }, 'R2');
    t.cw.rooms.seat('dec-room', 'p2', { clientKey: 'dec-target' }, 'T');
    t.cw.chat.accept('dec-room', 'p2', 'a line');
    const first = await file('p1');
    const person = t.cw.reports.get(first)!.targetPerson as SubjectId;
    t.boost(person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person });
    t.store.closeReport(first, 'dismissed', false, 'mod-a', t.clock.t, 'n');
    expect(t.cw.cases.releaseWhenDone(person, 'mod-a')).toBe(true);
    lapse(t);
    await file('p3');
    // Not "let it lapse": the boosted case is claimed ahead of the older ordinary one.
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person });
    void old;
  });

  it('a decision that leaves another report open keeps the claim, and the marker for it (it can still lapse)', async () => {
    const t = await setup();
    const old = await t.file();
    t.cw.rooms.seat('keep-room', 'p1', { clientKey: 'keep-rep-1' }, 'R1');
    t.cw.rooms.seat('keep-room', 'p3', { clientKey: 'keep-rep-2' }, 'R2');
    t.cw.rooms.seat('keep-room', 'p2', { clientKey: 'keep-target' }, 'T');
    t.cw.chat.accept('keep-room', 'p2', 'a line');
    const ids: string[] = [];
    for (const seat of ['p1', 'p3']) {
      t.clock.t += SEC;
      const res = await t.cw.reports.submit({ roomId: 'keep-room', reporterSeat: seat, targetSeat: 'p2', category: 'harassment' });
      if (!res.ok) throw new Error('refused');
      ids.push(res.reportId);
    }
    const person = t.cw.reports.get(ids[0]!)!.targetPerson as SubjectId;
    t.boost(person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person });
    t.store.closeReport(ids[0]!, 'dismissed', false, 'mod-a', t.clock.t, 'n');
    expect(t.cw.cases.releaseWhenDone(person, 'mod-a')).toBe(false);
    lapse(t);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
  });

  it('a claim renewed by its holder forgets the marker: the case is not read as lapsed at the original expiry', async () => {
    const t = await setup();
    const old = await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    t.clock.t += CLAIM_TTL_MS - SEC;
    expect(t.cw.cases.claim(newer.person, 'mod-a')).toMatchObject({ ok: true });
    t.clock.t += 2 * SEC;
    expect(t.cw.cases.release(newer.person, 'mod-a')).toBe(true);
    // The old expiry passed while the claim was alive: the marker is gone, so the boosted case is first again.
    expect(t.cw.cases.next('mod-b', BOOST)).toMatchObject({ person: newer.person });
    t.cw.cases.release(newer.person, 'mod-b');
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    void old;
  });

  it('a claim that really ran out unheld is still deprioritised (the rule itself is unchanged)', async () => {
    const t = await setup();
    const old = await t.file();
    const newer = await t.file();
    t.boost(newer.person);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: newer.person });
    lapse(t);
    expect(t.cw.cases.next('mod-a', BOOST)).toMatchObject({ person: old.person });
  });
});
