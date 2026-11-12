import { describe, expect, it } from 'vitest';
import type { SubjectId } from '../src/types.js';
import { sworld } from './signalsWorld.js';

// The third guard (new-account weighting) and the stored weight: computed once at record time, only with the hook.

const NEW_ACCOUNT = { belowDays: 7, factor: 0.25 };

/** The weight stored for a source: counts() with one muter reports exactly that source's weight. */
const weightOf = (w: Awaited<ReturnType<typeof sworld>>, target: SubjectId): number | undefined => w.cw.signals.counts(target)[0]?.weight;

async function world(over: Parameters<typeof sworld>[0] = {}, ages: Record<string, number | null | undefined> = {}) {
  const asked: Array<readonly string[]> = [];
  const w = await sworld({
    guards: { newAccount: NEW_ACCOUNT },
    signals: {
      accountAgeDays: (accountIds) => {
        asked.push([...accountIds]);
        return ages[accountIds[0] as string];
      },
    },
    ...over,
  });
  const target = w.person('target');
  const muter = (account: string, key = `key-${account}`): SubjectId => w.person(key, { accountId: account });
  return { ...w, target, muter, asked };
}

describe('the new-account guard', () => {
  it('no hook means no weighting even when the profile sets newAccount', async () => {
    const w = await sworld({ guards: { newAccount: NEW_ACCOUNT } });
    const target = w.person('target');
    const by = w.person('by', { accountId: 'acct-new' });
    expect(w.cw.signals.record({ kind: 'muted_by_player', subject: target, by })).toBe(true);
    expect(weightOf(w, target)).toBe(1);
  });

  it('an age below belowDays multiplies the stored weight, at or above does not', async () => {
    const w = await world({}, { 'acct-6': 6.9, 'acct-7': 7, 'acct-8': 8, 'acct-0': 0 });
    for (const [account, expected] of [['acct-6', 0.25], ['acct-7', 1], ['acct-8', 1], ['acct-0', 0.25]] as const) {
      const target = w.person(`t-${account}`);
      const by = w.muter(account);
      expect(w.cw.signals.record({ kind: 'muted_by_player', subject: target, by }), account).toBe(true);
      expect(weightOf(w, target), account).toBe(expected);
    }
  });

  it('the factor multiplies the kind weight and a per-call weight', async () => {
    const w = await world({}, { 'acct-new': 1 });
    const t1 = w.person('t1');
    const t2 = w.person('t2');
    const by = w.muter('acct-new');
    w.cw.signals.record({ kind: 'kicked_from_room', subject: t1, by });
    w.cw.signals.record({ kind: 'muted_by_player', subject: t2, by, weight: 8 });
    expect(weightOf(w, t1)).toBe(0.5);
    expect(weightOf(w, t2)).toBe(2);
  });

  it('it never counts for more than one: a factor of 1 changes nothing', async () => {
    const w = await world({ guards: { newAccount: { belowDays: 30, factor: 1 } } }, { 'acct-new': 1 });
    w.cw.signals.record({ kind: 'muted_by_player', subject: w.target, by: w.muter('acct-new') });
    expect(weightOf(w, w.target)).toBe(1);
  });

  it('null, undefined, NaN, a negative and a non-number are unknown: factor 1', async () => {
    const w = await world({}, { 'acct-null': null, 'acct-nan': Number.NaN, 'acct-neg': -3, 'acct-str': '2' as unknown as number });
    for (const account of ['acct-null', 'acct-undef', 'acct-nan', 'acct-str']) {
      const target = w.person(`t-${account}`);
      w.cw.signals.record({ kind: 'muted_by_player', subject: target, by: w.muter(account) });
      expect(weightOf(w, target), account).toBe(1);
    }
  });

  it('a hook that throws is unknown (factor 1), logged by error class only', async () => {
    const logged: Array<[string, unknown]> = [];
    const w = await sworld({
      guards: { newAccount: NEW_ACCOUNT },
      logger: { warn: (e, d) => void logged.push([e, d]) },
      signals: {
        accountAgeDays: () => {
          throw new RangeError('acct-secret-123');
        },
      },
    });
    const target = w.person('target');
    const by = w.person('by', { accountId: 'acct-secret-123' });
    logged.length = 0;
    expect(w.cw.signals.record({ kind: 'muted_by_player', subject: target, by })).toBe(true);
    expect(weightOf(w, target)).toBe(1);
    expect(logged).toEqual([['chatwarden.signal_age_failed', { error: 'RangeError' }]]);
  });

  it('the hook is called with the account ids the kit has for the player, folded across a merge', async () => {
    const w = await world({}, { 'acct-a': 100 });
    const by = w.muter('acct-a');
    w.cw.rooms.seat('extra', 'p1', { clientKey: 'key-acct-a', accountId: 'acct-a2' }, 'X');
    w.asked.length = 0;
    w.cw.signals.record({ kind: 'muted_by_player', subject: w.target, by });
    expect(w.asked).toHaveLength(1);
    expect([...(w.asked[0] ?? [])].sort()).toEqual(['acct-a', 'acct-a2']);
  });

  it('it is called for by only: not for a record without by, and not for a player with no account', async () => {
    const w = await world({}, {});
    w.cw.signals.record({ kind: 'left_mid_game', subject: w.target, roomId: 'r1' });
    const noAccount = w.person('no-account');
    w.cw.signals.record({ kind: 'muted_by_player', subject: w.target, by: noAccount });
    expect(w.asked).toEqual([]);
    expect(w.cw.signals.counts(w.target)).toHaveLength(2);
  });

  it('a refused record does not call the hook', async () => {
    const w = await world({}, {});
    w.cw.signals.record({ kind: 'nope_kind', subject: w.target, by: w.muter('acct-x') });
    w.cw.signals.record({ kind: 'muted_by_player', subject: w.target, by: w.target });
    expect(w.asked).toEqual([]);
  });

  it('changing the guard leaves stored rows alone', async () => {
    const store = (await sworld()).store;
    const first = await sworld({ guards: { newAccount: NEW_ACCOUNT }, signals: { accountAgeDays: () => 1 } }, store);
    const target = first.person('target');
    const by = first.person('by', { accountId: 'acct-new' });
    first.cw.signals.record({ kind: 'muted_by_player', subject: target, by });
    expect(weightOf(first, target)).toBe(0.25);
    await first.cw.flush();
    // A second kit over the same store with a different factor reads the stored weight as it was.
    const second = await sworld({ guards: { newAccount: { belowDays: 7, factor: 0.9 } }, signals: { accountAgeDays: () => 1 } }, store);
    expect(second.cw.signals.counts(target)).toMatchObject([{ weight: 0.25 }]);
  });

  it('a hook that is not a function is refused at creation', async () => {
    await expect(sworld({ signals: { accountAgeDays: 5 as never } })).rejects.toThrow(/accountAgeDays/);
  });

  it('a per-call weight of 10 with a factor stays in range', async () => {
    const w = await world({}, { 'acct-new': 0 });
    w.cw.signals.record({ kind: 'muted_by_player', subject: w.target, by: w.muter('acct-new'), weight: 10 });
    expect(weightOf(w, w.target)).toBe(2.5);
  });
});
