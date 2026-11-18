import { describe, expect, it } from 'vitest';
import type { ChatResult } from '../src/chat.js';
import { AccountAges } from '../src/accountAge.js';
import { PACE_REASONS } from '../src/pace.js';
import { MIN, roomsWorld, SEC } from './roomsWorld.js';

// R2: probation is a pace floor for new accounts and nothing else: no strike, notice, audit row, signal or record, and never on "My record". It uses the same account-age hook as the emergency's
// read-only rule, cached ten minutes per person.

const ON = { overrides: { rooms: { probation: { enabled: true } } } } as const;
const delivered = (r: ChatResult): boolean => 'deliver' in r;
const reasonOf = (r: ChatResult): string | undefined => ('refuse' in r ? r.refuse.reason : undefined);

describe('probation off and on', () => {
  it('off: a player of 1 day can send lines as fast as the rate budget lets them, as before', async () => {
    const w = await roomsWorld();
    const a = w.player('R1', { ageDays: 1 });
    expect(delivered(w.cw.chat.accept('R1', a, 'one'))).toBe(true);
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', a, 'two'))).toBe(true);
    expect(w.asked).toEqual([]);
  });

  it('on: a player of 1 day gets at least 5 s between lines in a room with no slow mode, a player of 3 days does not', async () => {
    const w = await roomsWorld(ON);
    const young = w.player('R1', { ageDays: 1 });
    const older = w.player('R1', { ageDays: 3 });
    expect(delivered(w.cw.chat.accept('R1', young, 'one'))).toBe(true);
    w.clock.t += 4999;
    expect(w.cw.chat.accept('R1', young, 'two')).toEqual({ refuse: { reason: 'probation', retryAfterMs: 1 } });
    w.clock.t += 1;
    expect(delivered(w.cw.chat.accept('R1', young, 'two'))).toBe(true);
    expect(delivered(w.cw.chat.accept('R1', older, 'one'))).toBe(true);
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', older, 'two'))).toBe(true);
  });

  it('ageDays is exclusive: an account of exactly ageDays days is not on probation', async () => {
    const w = await roomsWorld(ON);
    const edge = w.player('R1', { ageDays: 2 });
    w.cw.chat.accept('R1', edge, 'one');
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', edge, 'two'))).toBe(true);
  });

  it('the refusal is probation with retryAfterMs and nothing else: no rule, until, notice or text', async () => {
    const w = await roomsWorld({ overrides: { rooms: { probation: { enabled: true, slowModeMs: 20_000 } } } });
    const a = w.player('R1', { ageDays: 0 });
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += 5 * SEC;
    expect(w.cw.chat.accept('R1', a, 'two')).toEqual({ refuse: { reason: 'probation', retryAfterMs: 15_000 } });
  });

  it('PACE_REASONS ends with probation', () => {
    expect(PACE_REASONS[PACE_REASONS.length - 1]).toBe('probation');
  });
});

describe('the stricter pace wins', () => {
  it('a room slow mode longer than probation answers slow_mode with its own wait', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setPace('R1', { slowModeMs: 10_000 });
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += 6 * SEC;
    expect(w.cw.chat.accept('R1', a, 'two')).toEqual({ refuse: { reason: 'slow_mode', retryAfterMs: 4000 } });
  });

  it('a room slow mode shorter than probation: probation wins', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setPace('R1', { slowModeMs: 3000 });
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += 4 * SEC;
    expect(w.cw.chat.accept('R1', a, 'two')).toEqual({ refuse: { reason: 'probation', retryAfterMs: 1000 } });
  });

  it('probation alone paces a room whose own pace is off, and its burst and repeat checks still apply with the floor', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setPace('R1', { duplicateWindowMs: 60_000 });
    w.cw.chat.accept('R1', a, 'same line');
    w.clock.t += 6 * SEC;
    expect(reasonOf(w.cw.chat.accept('R1', a, 'same line'))).toBe('duplicate');
  });

  it('an emergency (30 s) is stricter than probation (5 s) for a young account that may still write', async () => {
    const w = await roomsWorld({ ...ON, overrides: { rooms: { probation: { enabled: true }, emergency: { newAccountDays: 0 } } } });
    const a = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: 10 * MIN });
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += 10 * SEC;
    expect(w.cw.chat.accept('R1', a, 'two')).toEqual({ refuse: { reason: 'slow_mode', retryAfterMs: 20_000 } });
  });

  it('a refused line spends nothing: waiting the stated time always works', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1 });
    w.cw.chat.accept('R1', a, 'one');
    for (let i = 0; i < 10; i += 1) {
      w.clock.t += 100;
      expect(reasonOf(w.cw.chat.accept('R1', a, `try ${i}`))).toBe('probation');
    }
    w.clock.t += 5 * SEC;
    expect(delivered(w.cw.chat.accept('R1', a, 'now'))).toBe(true);
  });
});

describe('the age', () => {
  it('is cached for 10 minutes and then asked again', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1 });
    for (let i = 0; i < 5; i += 1) {
      w.clock.t += 6 * SEC;
      w.cw.chat.accept('R1', a, `line ${i}`);
    }
    expect(w.asked).toHaveLength(1);
    w.clock.t += 10 * MIN;
    w.cw.chat.accept('R1', a, 'after the cache');
    expect(w.asked).toHaveLength(2);
  });

  it('the hook sees the account ids of the person and no key, ip or subject', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1, account: 'acct-probation-1' });
    w.cw.chat.accept('R1', a, 'one');
    expect(w.asked).toEqual([['acct-probation-1']]);
  });

  it('a throwing hook reads unknown; unknownAge allow lets them chat, treat_as_new puts them on probation', async () => {
    for (const [setting, onProbation] of [['allow', false], ['treat_as_new', true]] as const) {
      const w = await roomsWorld({
        overrides: { rooms: { probation: { enabled: true }, unknownAge: setting } },
        signals: {
          accountAgeDays: () => {
            throw new Error('hook down');
          },
        },
      });
      const a = w.player('R1');
      w.cw.chat.accept('R1', a, 'one');
      w.clock.t += SEC;
      expect(reasonOf(w.cw.chat.accept('R1', a, 'two')) === 'probation', setting).toBe(onProbation);
    }
  });

  it('unknown, negative and non-numeric answers are all unknown', async () => {
    for (const answer of [undefined, null, -1, NaN, 'young', {}, Infinity]) {
      const w = await roomsWorld({ overrides: { rooms: { probation: { enabled: true }, unknownAge: 'treat_as_new' } }, signals: { accountAgeDays: () => answer as never } });
      const a = w.player('R1');
      w.cw.chat.accept('R1', a, 'one');
      w.clock.t += SEC;
      expect(reasonOf(w.cw.chat.accept('R1', a, 'two')), String(answer)).toBe('probation');
    }
  });

  it('a guest with no account follows unknownAge, and the hook is never called for them', async () => {
    for (const [setting, onProbation] of [['allow', false], ['treat_as_new', true]] as const) {
      const w = await roomsWorld({ overrides: { rooms: { probation: { enabled: true }, unknownAge: setting } } });
      const guest = w.player('R1', { account: null });
      w.cw.chat.accept('R1', guest, 'one');
      w.clock.t += SEC;
      expect(reasonOf(w.cw.chat.accept('R1', guest, 'two')) === 'probation', setting).toBe(onProbation);
      expect(w.asked).toEqual([]);
    }
  });

  it('no hook at all: every age is unknown and nothing throws', async () => {
    const w = await roomsWorld({ ...ON, signals: {} });
    const a = w.player('R1');
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', a, 'two'))).toBe(true);
  });

  it('AccountAges forgets the people it is told to, and asks the hook again for them', () => {
    const clock = { t: 0, now: () => 0 };
    let calls = 0;
    const hook = (): number => {
      calls += 1;
      return 3;
    };
    const ages = new AccountAges({ hook, accountIds: (s) => [`acct-${s}`], canonical: (s) => s, clock, logger: undefined });
    expect(ages.ageOf('s_a')).toBe(3);
    expect(ages.ageOf('s_a')).toBe(3);
    expect(calls).toBe(1);
    ages.forget(new Set(['s_a']));
    expect(ages.ageOf('s_a')).toBe(3);
    expect(calls).toBe(2);
    expect(clock.t).toBe(0);
  });

  it('a person with no account id is unknown without asking the hook', () => {
    let calls = 0;
    const hook = (): number => {
      calls += 1;
      return 3;
    };
    const ages = new AccountAges({ hook, accountIds: () => [], canonical: (s) => s, clock: { now: () => 0 }, logger: undefined });
    expect(ages.ageOf('s_a')).toBeNull();
    expect(ages.ageOf(null)).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('a pause, not a sanction', () => {
  it('writes no strike, notice, audit row, signal or record, and never appears on My record', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1, account: 'acct-record-1' });
    const snapshot = () =>
      JSON.stringify([w.store.loadStrikes(0), w.cw.audit.list({ limit: 100 }).items, w.cw.notices.record({ clientKey: 'key-1-bbbbbbbbbbbb', accountId: 'acct-record-1' }), w.store.loadSanctions(w.clock.t)]);
    const before = snapshot();
    w.cw.chat.accept('R1', a, 'one');
    for (let i = 0; i < 4; i += 1) {
      w.clock.t += SEC;
      expect(reasonOf(w.cw.chat.accept('R1', a, `again ${i}`))).toBe('probation');
    }
    expect(snapshot()).toBe(before);
    expect(w.events).toEqual([]);
  });

  it('a probation refusal is not a flood: no signal count appears', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1 });
    w.cw.chat.accept('R1', a, 'one');
    for (let i = 0; i < 20; i += 1) {
      w.clock.t += 10;
      w.cw.chat.accept('R1', a, `spam ${i}`);
    }
    const subject = w.cw.rooms.subjectAt('R1', a) as string;
    expect(w.cw.signals.counts(subject, {})).toEqual([]);
  });

  it('when the account grows past ageDays the pause ends by itself (after the cache)', async () => {
    const w = await roomsWorld(ON);
    const a = w.player('R1', { ageDays: 1, account: 'acct-grow-1' });
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += SEC;
    expect(reasonOf(w.cw.chat.accept('R1', a, 'two'))).toBe('probation');
    w.ages.set('acct-grow-1', 3);
    w.clock.t += 10 * MIN + SEC;
    w.cw.chat.accept('R1', a, 'three');
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', a, 'four'))).toBe(true);
  });
});
