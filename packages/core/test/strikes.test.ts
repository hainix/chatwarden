import { describe, expect, it } from 'vitest';
import { applySanction } from '../src/sanctions.js';
import {
  REPEAT_LOOKBACK_MS,
  REPEAT_RESTRICT_MS,
  STRIKE_FIRST_RESTRICT_MS,
  STRIKE_WINDOW_MS,
  STRIKES_TO_RESTRICT,
  StrikeService,
} from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SanctionKind, Source, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

const who = (clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash,
});

type Logs = Array<{ event: string; detail?: Record<string, string | number | boolean> }>;

function setup(opts: { store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Logs = [];
  const logger: Logger = {
    warn(event, detail) {
      logs.push({ event, detail });
    },
  };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const strikes = new StrikeService(store, clock, subjects, { logger });
  const person = (ids: Identifiers): SubjectId => {
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  /** One strike by `subject` at absolute time `t`. */
  const strike = (subject: SubjectId | null, t: number, rateKey = 'rk1', line = 'a line') => {
    clock.t = t;
    return strikes.record(subject, rateKey, 'ROOM1', 'term-1', line);
  };
  /** What the chat path does with a decision: apply an automatic chat sanction starting at `t`. */
  const applyAuto = async (
    subject: SubjectId,
    t: number,
    over: { kind?: SanctionKind; source?: Source; automated?: boolean } = {},
  ) => {
    await applySanction(
      store,
      subjects,
      {
        kind: over.kind ?? 'chat',
        subject,
        includeIp: false,
        durationMs: 30 * MIN,
        reason: 'auto',
        actor: 'auto',
        source: over.source ?? 'auto_filter',
        automated: over.automated ?? true,
        rule: 1,
      },
      t,
    );
  };
  return { store, clock, subjects, strikes, logs, person, strike, applyAuto };
}

/** Three strikes at t, t+1, t+2 from one subject; returns the third's decision. */
function thirdStrike(env: ReturnType<typeof setup>, subject: SubjectId, t = NOW) {
  env.strike(subject, t);
  env.strike(subject, t + 1);
  return env.strike(subject, t + 2).autoRestrict;
}

describe('values', () => {
  it('uses the Global Constraints values verbatim', () => {
    expect(STRIKES_TO_RESTRICT).toBe(3);
    expect(STRIKE_WINDOW_MS).toBe(3_600_000);
    expect(STRIKE_FIRST_RESTRICT_MS).toBe(30 * MIN);
    expect(REPEAT_RESTRICT_MS).toBe(24 * H);
    expect(REPEAT_LOOKBACK_MS).toBe(7 * DAY);
  });
});

describe('record (subject path)', () => {
  it('writes a strike row with the subject, room, term and the raw line', () => {
    const env = setup();
    const s = env.person(who('k1', 'a1', 'ip1'));
    env.strike(s, NOW, 'rk1', 'zorbak you');
    expect(env.store.rawStrikes()).toEqual([
      expect.objectContaining({ at: NOW, subject: s, roomId: 'ROOM1', termId: 'term-1', rawLine: 'zorbak you' }),
    ]);
  });

  it('never stores an identifier in the row: no client key, account id or ip', () => {
    const env = setup();
    const s = env.person(who('hashed-key', 'acct-1', 'hashed-ip'));
    env.strike(s, NOW);
    const blob = JSON.stringify(env.store.rawStrikes());
    for (const id of ['hashed-key', 'acct-1', 'hashed-ip']) expect(blob).not.toContain(id);
  });

  it('gives each strike its own id', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW);
    expect(new Set(env.store.rawStrikes().map((r) => r.id)).size).toBe(2);
  });

  it('two strikes do nothing', () => {
    const env = setup();
    const s = env.person(who('k1'));
    expect(env.strike(s, NOW).autoRestrict).toBeNull();
    expect(env.strike(s, NOW + MIN).autoRestrict).toBeNull();
  });

  it('the 3rd strike within 60 min gives 30 min', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + 10 * MIN);
    expect(env.strike(s, NOW + 59 * MIN).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('three strikes in the very same millisecond count', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW);
    expect(env.strike(s, NOW).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('the 3rd spread over 61 min gives nothing', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + 30 * MIN);
    expect(env.strike(s, NOW + 61 * MIN).autoRestrict).toBeNull();
  });

  it('a strike exactly 60 min old still counts', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + 30 * MIN);
    expect(env.strike(s, NOW + 60 * MIN).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('a rolling window: old strikes age out so a later cluster of 3 triggers', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + 30 * MIN);
    expect(env.strike(s, NOW + 61 * MIN).autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 62 * MIN).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('counts per subject: other people do not add to the tally', () => {
    const env = setup();
    const a = env.person(who('k1'));
    env.strike(env.person(who('other')), NOW);
    env.strike(env.person(who('other2')), NOW);
    expect(env.strike(a, NOW).autoRestrict).toBeNull();
  });

  it('does not touch the rateKey fallback tally when it records against a subject', () => {
    const env = setup();
    const s = env.person(who('k1'));
    // Two subject strikes, then the same rateKey with no subject: must start from zero.
    env.strike(s, NOW, 'rk');
    env.strike(s, NOW + 1, 'rk');
    expect(env.strike(null, NOW + 2, 'rk').autoRestrict).toBeNull();
  });

  it('a firing consumes the strikes: the 4th and 5th after it do not re-fire, a fresh 3 does', () => {
    const env = setup();
    const s = env.person(who('k1'));
    const out = [0, 1, 2, 3, 4, 5].map((i) => env.strike(s, NOW + i).autoRestrict !== null);
    expect(out).toEqual([false, false, true, false, false, true]);
  });

  it('strikes at t=0,1,2 fire; a strike at t=33 does not; t=33,34,35 fire again at 24 h', () => {
    const env = setup();
    const s = env.person(who('k1'));
    for (let i = 0; i < 2; i++) expect(env.strike(s, NOW + i * MIN).autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 2 * MIN).autoRestrict).toEqual({ durationMs: 30 * MIN });
    expect(env.strike(s, NOW + 33 * MIN).autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 34 * MIN).autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 35 * MIN).autoRestrict).toEqual({ durationMs: 24 * H });
  });

  it('a strike in the same millisecond as the firing is consumed too', () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW);
    expect(env.strike(s, NOW).autoRestrict).not.toBeNull();
    expect(env.strike(s, NOW).autoRestrict).toBeNull();
    expect(env.strike(s, NOW).autoRestrict).toBeNull();
  });

  it('keeps writing rows for strikes that are consumed (evidence for K2)', () => {
    const env = setup();
    const s = env.person(who('k1'));
    for (let i = 0; i < 5; i++) env.strike(s, NOW + i);
    expect(env.store.rawStrikes()).toHaveLength(5);
  });

  it('writes the row and the tally together: a rolled-back outer transaction leaves no row', () => {
    const env = setup();
    const s = env.person(who('k1'));
    expect(() =>
      env.store.transaction(() => {
        env.strike(s, NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(env.store.rawStrikes()).toEqual([]);
  });
});

describe('escalation', () => {
  it('escalates to 24 h when an automatic chat restriction started within the last 7 days', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - 3 * DAY);
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 24 * H });
  });

  it('escalates even when that earlier restriction was revoked (rows count whatever happened to them)', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - DAY);
    const row = env.store.rawSanctions()[0];
    expect(env.store.revokeSanctionGroup(row?.groupId ?? '', 'mod', NOW - DAY + 1, 'sorry')).toBe(1);
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 24 * H });
  });

  it('escalates when that earlier restriction has long expired (6 days, 30 min long)', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - 6 * DAY);
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 24 * H });
  });

  it('does not escalate for an automatic restriction older than 7 days', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - 7 * DAY - MIN);
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 30 * MIN });
  });

  it('pins the 7-day boundary: exactly 7 days before the firing escalates, 1 ms older does not', async () => {
    const exact = setup();
    const a = exact.person(who('k1'));
    await exact.applyAuto(a, NOW + 2 - 7 * DAY);
    await exact.strikes.load();
    expect(thirdStrike(exact, a)).toEqual({ durationMs: 24 * H });

    const older = setup();
    const b = older.person(who('k1'));
    await older.applyAuto(b, NOW + 2 - 7 * DAY - 1);
    await older.strikes.load();
    expect(thirdStrike(older, b)).toEqual({ durationMs: 30 * MIN });
  });

  it('does not escalate for a moderator chat sanction', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - DAY, { source: 'moderator', automated: false });
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 30 * MIN });
  });

  it('does not escalate for an automatic sanction of another kind', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - DAY, { kind: 'area' });
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 30 * MIN });
  });

  it('does not escalate for somebody else\'s automatic sanction', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    const other = env.person(who('zz', 'zza', 'zzi'));
    await env.applyAuto(other, NOW - DAY);
    await env.strikes.load();
    expect(thirdStrike(env, s)).toEqual({ durationMs: 30 * MIN });
  });

  it('an IP-only automatic row never escalates a stranger (shared addresses must not compound)', async () => {
    const env = setup();
    const owner = env.person(who('k1', 'a1', 'ip1'));
    // A sanction with an IP row for `owner`; a different person on the same IP stays at 30 min.
    await applySanction(
      env.store,
      env.subjects,
      { kind: 'chat', subject: owner, includeIp: true, durationMs: 30 * MIN, reason: 'auto', actor: 'auto', source: 'auto_filter', automated: true },
      NOW - DAY,
    );
    const stranger = env.person(who('fresh', null, 'ip1'));
    await env.strikes.load();
    expect(thirdStrike(env, stranger)).toEqual({ durationMs: 30 * MIN });
  });

  it('escalates the second time within one process without a reload', () => {
    const env = setup();
    const s = env.person(who('k1'));
    expect(thirdStrike(env, s, NOW)).toEqual({ durationMs: 30 * MIN });
    expect(thirdStrike(env, s, NOW + 2 * H)).toEqual({ durationMs: 24 * H });
    expect(thirdStrike(env, s, NOW + 5 * DAY)).toEqual({ durationMs: 24 * H }); // 2nd firing was < 7 d before
    expect(thirdStrike(env, s, NOW + 13 * DAY)).toEqual({ durationMs: 30 * MIN }); // 8 d since the last one
  });
});

describe('consumption by the latest automatic restriction', () => {
  it('after the restriction the player starts again from zero (restriction applied by the caller)', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    for (let i = 0; i < 2; i++) env.strike(s, NOW + i * MIN);
    expect(env.strike(s, NOW + 2 * MIN).autoRestrict).not.toBeNull();
    await env.applyAuto(s, NOW + 2 * MIN);
    expect(env.strike(s, NOW + 3 * MIN).autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 4 * MIN).autoRestrict).toBeNull();
  });

  it('a restriction loaded from the store consumes earlier strikes loaded from the store', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    await env.applyAuto(s, NOW + 2 * MIN);
    // A fresh process.
    const again = new StrikeService(env.store, env.clock, env.subjects, { logger: { warn() {} } });
    env.clock.t = NOW + 3 * MIN;
    await again.load();
    expect(again.record(s, 'rk1', 'ROOM1', 'term-1', 'x').autoRestrict).toBeNull();
    expect(again.record(s, 'rk1', 'ROOM1', 'term-1', 'x').autoRestrict).toBeNull();
  });

  it('a moderator chat sanction does not consume strikes', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    await env.applyAuto(s, NOW + 2 * MIN, { source: 'moderator', automated: false });
    await env.strikes.load();
    expect(env.strike(s, NOW + 3 * MIN).autoRestrict).not.toBeNull();
  });

  it('an automatic sanction of another kind does not consume strikes', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    await env.applyAuto(s, NOW + 2 * MIN, { kind: 'area' });
    await env.strikes.load();
    expect(env.strike(s, NOW + 3 * MIN).autoRestrict).not.toBeNull();
  });

  it('a revoked restriction still consumes (a lifted sanction does not erase the behaviour)', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    await env.applyAuto(s, NOW + 2 * MIN);
    const row = env.store.rawSanctions()[0];
    env.store.revokeSanctionGroup(row?.groupId ?? '', 'mod', NOW + 3 * MIN, 'sorry');
    await env.strikes.load();
    expect(env.strike(s, NOW + 4 * MIN).autoRestrict).toBeNull();
  });
});

describe('merged aliases', () => {
  it('strikes against two subjects count together once they are one person', () => {
    const env = setup();
    const a = env.person(who('ka'));
    env.clock.t = NOW + 1;
    const b = env.person(who('kb'));
    env.strike(a, NOW + 2);
    env.strike(b, NOW + 3);
    // Signing in on both browsers links them.
    env.clock.t = NOW + 4;
    const merged = env.person(who('ka', 'acct'));
    expect(env.person(who('kb', 'acct'))).toBe(merged);
    expect(env.strike(a, NOW + 5).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('strikes recorded under the surviving id and the absorbed id both count', () => {
    const env = setup();
    const a = env.person(who('ka'));
    env.clock.t = NOW + 1;
    const b = env.person(who('kb'));
    env.person(who('ka', 'acct'));
    env.person(who('kb', 'acct'));
    env.strike(b, NOW + 2); // caller still holds the absorbed id
    env.strike(a, NOW + 3);
    expect(env.strike(b, NOW + 4).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('a restriction on one alias consumes strikes recorded on the other', async () => {
    const env = setup();
    const a = env.person(who('ka'));
    env.clock.t = NOW + 1;
    const b = env.person(who('kb'));
    env.strike(a, NOW + 2);
    env.strike(b, NOW + 3);
    env.person(who('ka', 'acct'));
    env.person(who('kb', 'acct'));
    expect(env.strike(a, NOW + 4).autoRestrict).not.toBeNull();
    // Fires once; afterwards both ids start from zero.
    expect(env.strike(b, NOW + 5).autoRestrict).toBeNull();
    expect(env.strike(a, NOW + 6).autoRestrict).toBeNull();
  });

  it('a merge after a firing keeps the escalation (the restriction was on the absorbed id)', () => {
    const env = setup();
    const a = env.person(who('ka'));
    env.clock.t = NOW + 1;
    const b = env.person(who('kb'));
    expect(thirdStrike(env, b, NOW + 10)).toEqual({ durationMs: 30 * MIN });
    env.person(who('ka', 'acct'));
    env.person(who('kb', 'acct'));
    expect(thirdStrike(env, a, NOW + 2 * H)).toEqual({ durationMs: 24 * H });
  });

  it('a load rebuilds the tally for an absorbed id', async () => {
    const env = setup();
    const a = env.person(who('ka'));
    env.clock.t = NOW + 1;
    const b = env.person(who('kb'));
    env.strike(b, NOW + 2);
    env.strike(b, NOW + 3);
    env.person(who('ka', 'acct'));
    env.person(who('kb', 'acct'));
    const again = new StrikeService(env.store, env.clock, env.subjects, { logger: { warn() {} } });
    env.clock.t = NOW + 4;
    await again.load();
    expect(again.record(a, 'rk', 'R', 't', 'x').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });
});

describe('load', () => {
  it('rebuilds the tally from strikes in the last hour', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    const again = new StrikeService(env.store, env.clock, env.subjects, { logger: { warn() {} } });
    env.clock.t = NOW + 2 * MIN;
    await again.load();
    expect(again.record(s, 'rk', 'R', 't', 'x').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('ignores stored strikes older than an hour', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    const again = new StrikeService(env.store, env.clock, env.subjects, { logger: { warn() {} } });
    env.clock.t = NOW + 2 * H;
    await again.load();
    expect(again.record(s, 'rk', 'R', 't', 'x').autoRestrict).toBeNull();
  });

  it('keeps a strike exactly an hour old', async () => {
    const env = setup();
    const s = env.person(who('k1'));
    env.strike(s, NOW);
    env.strike(s, NOW + MIN);
    const again = new StrikeService(env.store, env.clock, env.subjects, { logger: { warn() {} } });
    env.clock.t = NOW + H;
    await again.load();
    expect(again.record(s, 'rk', 'R', 't', 'x').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('on an empty store it just works', async () => {
    const env = setup();
    await expect(env.strikes.load()).resolves.toBeUndefined();
  });

  it('rejects when the store read throws', async () => {
    class Broken extends MemoryStore {
      override loadStrikes(): never {
        throw new Error('disk gone');
      }
    }
    const env = setup({ store: new Broken() });
    await expect(env.strikes.load()).rejects.toThrow('disk gone');
  });
});

describe('record (no subject, in-memory fallback)', () => {
  it('keys by rateKey when the subject is null', () => {
    const env = setup();
    expect(env.strike(null, NOW, 'rk').autoRestrict).toBeNull();
    expect(env.strike(null, NOW + MIN, 'rk').autoRestrict).toBeNull();
    expect(env.strike(null, NOW + 2 * MIN, 'rk').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('writes no row (nothing to key a row by; never by IP)', () => {
    const env = setup();
    for (let i = 0; i < 3; i++) env.strike(null, NOW + i, 'rk');
    expect(env.store.rawStrikes()).toEqual([]);
  });

  it('different rateKeys do not share a tally', () => {
    const env = setup();
    env.strike(null, NOW, 'a');
    env.strike(null, NOW, 'b');
    expect(env.strike(null, NOW, 'a').autoRestrict).toBeNull();
    expect(env.strike(null, NOW, 'b').autoRestrict).toBeNull();
  });

  it('the 3rd spread over 61 min gives nothing; exactly 60 min old still counts', () => {
    const env = setup();
    env.strike(null, NOW);
    env.strike(null, NOW + 30 * MIN);
    expect(env.strike(null, NOW + 61 * MIN).autoRestrict).toBeNull();
    const env2 = setup();
    env2.strike(null, NOW);
    env2.strike(null, NOW + 30 * MIN);
    expect(env2.strike(null, NOW + 60 * MIN).autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('clears the key when it fires, so the 4th and 5th do not re-trigger and a fresh 3 does', () => {
    const env = setup();
    const out = [0, 1, 2, 3, 4, 5].map((i) => env.strike(null, NOW + i).autoRestrict !== null);
    expect(out).toEqual([false, false, true, false, false, true]);
  });

  it('is always 30 min: there is no history to escalate from', () => {
    const env = setup();
    const fired = [0, 1, 2, 33, 34, 35].map((m) => env.strike(null, NOW + m * MIN).autoRestrict);
    expect(fired).toEqual([null, null, { durationMs: 30 * MIN }, null, null, { durationMs: 30 * MIN }]);
  });

  it('after a long gap a stale tally restarts from zero', () => {
    const env = setup();
    env.strike(null, NOW);
    env.strike(null, NOW + MIN);
    expect(env.strike(null, NOW + 2 * H).autoRestrict).toBeNull();
  });

  it('prunes every key on each call, so a quiet key cannot pile up (observable: it restarts at zero)', () => {
    const env = setup();
    env.strike(null, NOW, 'quiet');
    env.strike(null, NOW + MIN, 'quiet');
    env.strike(null, NOW + 3 * H, 'other'); // prunes 'quiet'
    // The two old strikes are over an hour old: pruned, so three fresh ones are needed.
    expect(env.strike(null, NOW + 3 * H + 1, 'quiet').autoRestrict).toBeNull();
    expect(env.strike(null, NOW + 3 * H + 2, 'quiet').autoRestrict).toBeNull();
    expect(env.strike(null, NOW + 3 * H + 3, 'quiet').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('an empty subject id is treated like no subject', () => {
    const env = setup();
    for (let i = 0; i < 2; i++) env.strike('', NOW + i, 'rk');
    expect(env.strike('', NOW + 2, 'rk').autoRestrict).toEqual({ durationMs: 30 * MIN });
    expect(env.store.rawStrikes()).toEqual([]);
  });
});

describe('store failure (Review Focus 5)', () => {
  class FlakyStore extends MemoryStore {
    failInsert = false;
    override insertStrike(row: Parameters<MemoryStore['insertStrike']>[0]): void {
      if (this.failInsert) throw new TypeError('db is locked');
      super.insertStrike(row);
    }
  }

  it('a throwing write still returns a decision from memory, and never throws', () => {
    const store = new FlakyStore();
    const env = setup({ store });
    const s = env.person(who('k1'));
    store.failInsert = true;
    expect(() => env.strike(s, NOW, 'rk')).not.toThrow();
    expect(env.strike(s, NOW + 1, 'rk').autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 2, 'rk').autoRestrict).toEqual({ durationMs: 30 * MIN });
    expect(store.rawStrikes()).toEqual([]);
  });

  it('logs the failure with the event and the error class only: no line, term or id', () => {
    const store = new FlakyStore();
    const env = setup({ store });
    const s = env.person(who('k1', 'acct-9', 'ip-9'));
    store.failInsert = true;
    env.strike(s, NOW, 'rk-secret', 'zorbak secret line');
    expect(env.logs).toEqual([{ event: 'strikes.write_failed', detail: { error: 'TypeError' } }]);
    const blob = JSON.stringify(env.logs);
    for (const leak of ['zorbak', 'secret', s, 'acct-9', 'ip-9', 'term-1', 'ROOM1']) expect(blob).not.toContain(leak);
  });

  it('the fallback fires the first-offence duration even for a repeat offender', async () => {
    const store = new FlakyStore();
    const env = setup({ store });
    const s = env.person(who('k1'));
    await env.applyAuto(s, NOW - DAY);
    await env.strikes.load();
    store.failInsert = true;
    env.strike(s, NOW, 'rk');
    env.strike(s, NOW + 1, 'rk');
    expect(env.strike(s, NOW + 2, 'rk').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('a failed write does not leave a half-counted strike in the subject tally', () => {
    const store = new FlakyStore();
    const env = setup({ store });
    const s = env.person(who('k1'));
    store.failInsert = true;
    env.strike(s, NOW, 'rk');
    env.strike(s, NOW + 1, 'rk');
    store.failInsert = false;
    // Two failed strikes sit in the rateKey tally only; the subject tally is empty.
    expect(env.strike(s, NOW + 2, 'rk').autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 3, 'rk').autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 4, 'rk').autoRestrict).toEqual({ durationMs: 30 * MIN });
  });

  it('a fallback firing consumes the subject\'s later strikes like any other firing', () => {
    const store = new FlakyStore();
    const env = setup({ store });
    const s = env.person(who('k1'));
    store.failInsert = true;
    for (let i = 0; i < 3; i++) env.strike(s, NOW + i, 'rk');
    store.failInsert = false;
    // The fallback firing at NOW+2 started a restriction: the next three are fresh, and (a repeat) cost 24 h.
    expect(env.strike(s, NOW + 2, 'rk2').autoRestrict).toBeNull(); // same ms as the firing: consumed
    expect(env.strike(s, NOW + 3, 'rk2').autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 4, 'rk2').autoRestrict).toBeNull();
    expect(env.strike(s, NOW + 5, 'rk2').autoRestrict).toEqual({ durationMs: 24 * H });
  });

  it('a throwing logger does not make record throw', () => {
    const store = new FlakyStore();
    const clock = { t: NOW, now: () => clock.t };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const strikes = new StrikeService(store, clock, subjects, {
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
    });
    const s = subjects.resolve(who('k1')) as SubjectId;
    store.failInsert = true;
    expect(() => strikes.record(s, 'rk', 'R', 't', 'x')).not.toThrow();
  });

  it('a subject that cannot be canonicalised does not throw either', () => {
    const env = setup();
    expect(() => env.strike('s_never_seen', NOW, 'rk')).not.toThrow();
  });
});
