import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import { LIMITS_DEFAULTS } from '../src/limits.js';
import { applySanction } from '../src/sanctions.js';
import { REPEAT_LOOKBACK_MS, REPEAT_RESTRICT_MS, STRIKE_FIRST_RESTRICT_MS, STRIKE_WINDOW_MS, StrikeService } from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SubjectId } from '../src/types.js';

// `StrikeService.forgive` (0.2.1): an automatic restriction was overturned on appeal, so the strikes that earned it and its start stop counting. The service holds
// only counts; the sanction rows the chat path writes are written here by hand, as `applySanction` does for it.

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const W = STRIKE_WINDOW_MS;
const FIRST = { durationMs: STRIKE_FIRST_RESTRICT_MS };
const REPEAT = { durationMs: REPEAT_RESTRICT_MS, second: true };

const who = (clientKey: string | null, accountId: string | null = null): Identifiers => ({ clientKey, accountId, ipHash: null });

type AppealsStore = ReturnType<typeof withMemoryAppeals<MemoryStore>>;
function setup(opts: { store?: MemoryStore } = {}) {
  const store = (opts.store ?? withMemoryAppeals(new MemoryStore())) as AppealsStore;
  const clock = { t: NOW, now: () => clock.t };
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const strikes = new StrikeService(store, clock, subjects, { logger });
  const person = (ids: Identifiers): SubjectId => {
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const strike = (subject: SubjectId, t: number) => {
    clock.t = t;
    return strikes.record(subject, 'rk', 'ROOM1', 'term-1', 'a line');
  };
  /** What the chat path does with a restriction: write the automatic chat sanction starting at `t`; returns its group id. */
  const restrict = async (subject: SubjectId, t: number, durationMs = STRIKE_FIRST_RESTRICT_MS): Promise<string> => {
    const res = await applySanction(
      store,
      subjects,
      { kind: 'chat', subject, includeIp: false, durationMs, reason: 'auto', actor: 'auto', source: 'auto_filter', automated: true, rule: 1 },
      t,
    );
    return res.groupId;
  };
  /** Three strikes in a row at t, t + 1 and t + 2; returns the third's decision. */
  const tip = (subject: SubjectId, t: number) => {
    strike(subject, t);
    strike(subject, t + 1);
    return strike(subject, t + 2).autoRestrict;
  };
  /** The overturn the appeal service records (the store's half); `forgive` is the in-memory half it calls after the commit. */
  const overturn = (groupId: string, subject: SubjectId, startsAt: number, at = startsAt + MIN): boolean =>
    store.recordOverturn({
      groupId,
      at,
      subject,
      aliases: subjects.aliasesOf(subject),
      source: 'auto_filter',
      termId: 'term-1',
      filterKey: null,
      reportId: null,
      strikes: { from: startsAt - W, to: startsAt },
    });
  return { store, clock, subjects, strikes, logs, person, strike, restrict, tip, overturn };
}

describe('forgive after an overturned restriction', () => {
  it('three strikes restrict; forgive then three more strikes restrict for the first-offence length, not the 24 hours repeat', async () => {
    // control: without forgive the second restriction is the repeat
    const c = setup();
    const a = c.person(who('k1'));
    expect(c.tip(a, NOW)).toEqual(FIRST);
    await c.restrict(a, NOW + 2);
    expect(c.tip(a, NOW + 3 * H)).toEqual(REPEAT);
    // with the overturn and the forgive
    const e = setup();
    const s = e.person(who('k1'));
    expect(e.tip(s, NOW)).toEqual(FIRST);
    const group = await e.restrict(s, NOW + 2);
    expect(e.overturn(group, s, NOW + 2)).toBe(true);
    e.strikes.forgive(s, NOW + 2);
    expect(e.tip(s, NOW + 3 * H)).toEqual(FIRST);
  });

  it("forgive keeps a strike made after the restriction's start: with it, two more strikes tip the next one", async () => {
    const e = setup();
    const s = e.person(who('k1'));
    e.tip(s, NOW);
    const start = NOW + 2;
    const group = await e.restrict(s, start);
    // a strike after the restriction began (a lifted timeout, or a second process)
    expect(e.strike(s, start + 1).autoRestrict).toBeNull();
    e.overturn(group, s, start);
    e.strikes.forgive(s, start);
    expect(e.strike(s, start + 2).autoRestrict).toBeNull();
    expect(e.strike(s, start + 3).autoRestrict).toEqual(FIRST);
  });

  describe('forgive drops only strikes inside [startsAt - windowMs, startsAt]', () => {
    /** Two strikes at NOW and NOW + 1, a restriction that began `offset` ms after NOW is forgiven, then new strikes until one tips: how many it took. */
    const needed = (offset: number): number => {
      const e = setup();
      const s = e.person(who(`edge-${offset}`));
      e.strike(s, NOW);
      e.strike(s, NOW + 1);
      e.strikes.forgive(s, NOW + offset);
      for (let i = 1; i <= 5; i += 1) if (e.strike(s, NOW + 30 * MIN + i).autoRestrict !== null) return i;
      return 99;
    };

    it.each([
      ['a restriction one ms in: both strikes are inside the closed window and go', 1, 3],
      ['exactly a window after the first strike: both are inside (both ends are inclusive)', W, 3],
      ['a window and a ms after the first strike: the first is a ms outside and stays, the second goes', W + 1, 2],
      ['a window and two ms after: both are outside and stay', W + 2, 1],
      ['far later: both stay', 2 * W, 1],
      ['a restriction before them both: neither is inside, both stay', -W - 1, 1],
      ['a restriction exactly at the first strike: the first is on the end and goes, the second is after and stays', 0, 2],
    ])('%s', (_name, offset, expected) => {
      expect(needed(offset)).toBe(expected);
    });

    it('control: with no forgive, two strikes and one more tip', () => {
      const e = setup();
      const s = e.person(who('k-control'));
      e.strike(s, NOW);
      e.strike(s, NOW + 1);
      expect(e.strike(s, NOW + 30 * MIN).autoRestrict).toEqual(FIRST);
    });
  });

  it('two restrictions: forgiving the later one restores the earlier start as the latest start; forgiving both gives the first-offence length', async () => {
    const e = setup();
    const s = e.person(who('k1'));
    expect(e.tip(s, NOW)).toEqual(FIRST);
    await e.restrict(s, NOW + 2);
    expect(e.tip(s, NOW + 2 * H)).toEqual(REPEAT);
    const g2 = await e.restrict(s, NOW + 2 * H + 2, REPEAT_RESTRICT_MS);
    // forgive the later one: the earlier restriction (inside the 7 day look-back) is the latest start again, so the next is still the repeat
    e.overturn(g2, s, NOW + 2 * H + 2);
    e.strikes.forgive(s, NOW + 2 * H + 2);
    expect(e.tip(s, NOW + 3 * H)).toEqual(REPEAT);

    // forgive the first as well: nothing is left to repeat
    const f = setup();
    const p = f.person(who('k2'));
    f.tip(p, NOW);
    const a = await f.restrict(p, NOW + 2);
    f.tip(p, NOW + 2 * H);
    const b = await f.restrict(p, NOW + 2 * H + 2, REPEAT_RESTRICT_MS);
    f.overturn(b, p, NOW + 2 * H + 2);
    f.strikes.forgive(p, NOW + 2 * H + 2);
    f.overturn(a, p, NOW + 2);
    f.strikes.forgive(p, NOW + 2);
    expect(f.tip(p, NOW + 3 * H)).toEqual(FIRST);
  });

  it('an earlier restriction older than the look-back is not restored: forgiving the later one leaves no repeat', async () => {
    const e = setup();
    const s = e.person(who('k1'));
    e.tip(s, NOW);
    await e.restrict(s, NOW + 2);
    const later = NOW + REPEAT_LOOKBACK_MS + DAY;
    expect(e.tip(s, later)).toEqual(FIRST);
    const g2 = await e.restrict(s, later + 2);
    e.overturn(g2, s, later + 2);
    e.strikes.forgive(s, later + 2);
    expect(e.tip(s, later + H)).toEqual(FIRST);
  });

  it('after a restart (a new StrikeService, load()) the overturned strikes and start do not come back', async () => {
    const e = setup();
    const s = e.person(who('k1'));
    expect(e.tip(s, NOW)).toEqual(FIRST);
    const group = await e.restrict(s, NOW + 2);
    // the real path: the store records the overturn, a restart reads the store
    e.overturn(group, s, NOW + 2);
    e.clock.t = NOW + 10 * MIN;
    const again = new StrikeService(e.store, e.clock, e.subjects, { logger: { warn() {} } });
    await again.load();
    expect(again.record(s, 'rk', 'R', 't', 'x').autoRestrict).toBeNull();
    expect(again.record(s, 'rk', 'R', 't', 'x').autoRestrict).toBeNull();
    expect(again.record(s, 'rk', 'R', 't', 'x').autoRestrict).toEqual(FIRST);

    // control: the same restart without the overturn keeps the start, so the next restriction is the repeat
    const c = setup();
    const p = c.person(who('k2'));
    c.tip(p, NOW);
    await c.restrict(p, NOW + 2);
    c.clock.t = NOW + 10 * MIN;
    const back = new StrikeService(c.store, c.clock, c.subjects, { logger: { warn() {} } });
    await back.load();
    back.record(p, 'rk', 'R', 't', 'x');
    back.record(p, 'rk', 'R', 't', 'x');
    expect(back.record(p, 'rk', 'R', 't', 'x').autoRestrict).toEqual(REPEAT);
  });

  it('without recordOverturn the in-memory forgive still works for the live service and does not throw (a store without latestAutoChatStart)', async () => {
    const bare = new MemoryStore();
    expect((bare as unknown as { latestAutoChatStart?: unknown }).latestAutoChatStart).toBeUndefined();
    const e = setup({ store: bare });
    const s = e.person(who('k1'));
    expect(e.tip(s, NOW)).toEqual(FIRST);
    await e.restrict(s, NOW + 2);
    // the service's own start is the instant the restriction fired (the third strike, NOW + 2)
    expect(() => e.strikes.forgive(s, NOW + 2)).not.toThrow();
    expect(e.tip(s, NOW + 3 * H)).toEqual(FIRST);
  });

  it('a store without the method keeps a start that is not the one forgiven', async () => {
    const e = setup({ store: new MemoryStore() });
    const s = e.person(who('k1'));
    expect(e.tip(s, NOW + 5)).toEqual(FIRST); // the service's start is NOW + 7
    e.strikes.forgive(s, NOW + 12345);
    expect(e.tip(s, NOW + 3 * H)).toEqual(REPEAT);
  });

  it('an alias merged into the person is folded: strikes and the start filed under the absorbed id go too', async () => {
    const e = setup();
    const a = e.person(who('ka'));
    e.clock.t = NOW + 1;
    const b = e.person(who('kb'));
    // the strikes and the restriction are filed under the id that will be absorbed
    e.strike(b, NOW + 2);
    e.strike(b, NOW + 3);
    expect(e.strike(b, NOW + 4).autoRestrict).toEqual(FIRST);
    const group = await e.restrict(b, NOW + 4);
    // signing in on both browsers links them
    e.person(who('ka', 'acct'));
    e.person(who('kb', 'acct'));
    const merged = e.subjects.canonical(a);
    expect(e.subjects.canonical(b)).toBe(merged);
    expect(e.overturn(group, merged, NOW + 4)).toBe(true);
    e.strikes.forgive(merged, NOW + 4);
    // no repeat: the start filed under the absorbed id is gone
    expect(e.tip(merged, NOW + 2 * H)).toEqual(FIRST);
  });

  it('strikes filed under the absorbed id and still in the tally are dropped by a forgive of the person', () => {
    const e = setup();
    const a = e.person(who('ka'));
    e.clock.t = NOW + 1;
    const b = e.person(who('kb'));
    e.strike(b, NOW + 2);
    e.strike(b, NOW + 3);
    e.person(who('ka', 'acct'));
    e.person(who('kb', 'acct'));
    const merged = e.subjects.canonical(a);
    e.strikes.forgive(merged, NOW + 3);
    expect(e.strike(merged, NOW + 4).autoRestrict).toBeNull();
    expect(e.strike(merged, NOW + 5).autoRestrict).toBeNull();
    expect(e.strike(merged, NOW + 6).autoRestrict).toEqual(FIRST);
  });

  it('forgive of an unknown person, an old start or a person with nothing is a no-op and never throws', () => {
    const e = setup();
    expect(() => e.strikes.forgive('s_nobody_at_all', NOW)).not.toThrow();
    const s = e.person(who('k1'));
    for (const at of [0, NOW - 400 * DAY, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => e.strikes.forgive(s, at)).not.toThrow();
    // nothing was invented and nothing lost: two strikes still do not tip, the third does
    expect(e.strike(s, NOW).autoRestrict).toBeNull();
    expect(e.strike(s, NOW + 1).autoRestrict).toBeNull();
    expect(e.strike(s, NOW + 2).autoRestrict).toEqual(FIRST);
    expect(e.logs).toEqual([]);
  });

  it('a store that throws on the lookup is logged by class and never escapes, and the in-memory strikes are still dropped', () => {
    const e = setup();
    const s = e.person(who('k1'));
    e.strike(s, NOW);
    e.strike(s, NOW + 1);
    (e.store as unknown as { latestAutoChatStart: () => never }).latestAutoChatStart = () => {
      throw new TypeError('boom');
    };
    e.clock.t = NOW + 2;
    expect(() => e.strikes.forgive(s, NOW + 2)).not.toThrow();
    expect(e.logs.map((l) => l.event)).toEqual(['strikes.forgive_failed']);
    expect(e.logs[0]?.detail).toEqual({ error: 'TypeError' });
    expect(JSON.stringify(e.logs)).not.toContain('boom');
    // the two strikes are gone: it takes three new ones
    expect(e.strike(s, NOW + 3).autoRestrict).toBeNull();
    expect(e.strike(s, NOW + 4).autoRestrict).toBeNull();
    expect(e.strike(s, NOW + 5).autoRestrict).toEqual(FIRST);
  });

  it("forgive does not change another person's strikes or start", async () => {
    const e = setup();
    const a = e.person(who('k1'));
    e.clock.t = NOW + 1;
    const b = e.person(who('k2'));
    e.strike(b, NOW + 2);
    e.strike(b, NOW + 3);
    e.tip(a, NOW + 10);
    const g = await e.restrict(a, NOW + 12);
    e.overturn(g, a, NOW + 12);
    e.strikes.forgive(a, NOW + 12);
    expect(e.strike(b, NOW + 20).autoRestrict).toEqual(FIRST);
  });

  it('uses the configured window: a ten minute window drops [startsAt - 10 min, startsAt] only', () => {
    const store = withMemoryAppeals(new MemoryStore());
    const clock = { t: NOW, now: () => clock.t };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const limits = { ...LIMITS_DEFAULTS.strikes, windowMs: 10 * MIN };
    const strikes = new StrikeService(store, clock, subjects, { limits });
    const s = subjects.resolve(who('kw'));
    if (s === null) throw new Error('expected a subject');
    clock.t = NOW;
    strikes.record(s, 'rk', 'R', 't', 'x');
    clock.t = NOW + 8 * MIN;
    strikes.record(s, 'rk', 'R', 't', 'x');
    // a restriction that began at NOW + 12 min: the window is [NOW + 2 min, NOW + 12 min], so the strike at NOW survives and the one at NOW + 8 min goes
    clock.t = NOW + 9 * MIN;
    strikes.forgive(s, NOW + 12 * MIN);
    clock.t = NOW + 9 * MIN + 1;
    expect(strikes.record(s, 'rk', 'R', 't', 'x').autoRestrict).toBeNull();
    clock.t = NOW + 9 * MIN + 2;
    expect(strikes.record(s, 'rk', 'R', 't', 'x').autoRestrict).toEqual({ durationMs: limits.firstMs });
  });
});
