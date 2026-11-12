import { describe, expect, it } from 'vitest';
import { suggest } from '../src/ladder.js';
import type { ActionRecord, SignalHit, SuggestContext } from '../src/ladder.js';
import { PRESETS, resolveProfile } from '../src/profile.js';
import { CONDUCT_LEVELS } from '../src/types.js';
import type { ConductLevel, SanctionKind, SubjectId } from '../src/types.js';
import { OWNER } from './reportingWorld.js';
import { DAY, sworld } from './signalsWorld.js';

// The ladder feed (design 5.6): `note` adds a sentence, `raise` moves the suggestion one step, never into a permanent cell, never a
// sanction by itself. suggest() is pure; the facade computes the hits from feeds.ladder.

const NOW = 1_800_000_000_000;
const standard = PRESETS.standard;

const rec = (kind: SanctionKind, durationMs: number | null): ActionRecord => ({ kind, durationMs, startsAt: NOW - DAY, revoked: false, automated: false, roomId: null });
// Record steps (see actionStep): warning 1, chat or area under 7 days 2, chat 7 days 3, ban 7 days 4 (a ban from 30 days or any permanent one is 5).
const AT: Record<number, ActionRecord[]> = {
  0: [],
  1: [rec('warning', 0)],
  2: [rec('chat', DAY)],
  3: [rec('chat', 7 * DAY)],
  4: [rec('ban', 7 * DAY)],
  5: [rec('ban', 30 * DAY)],
};

const note = (text = 'Muted by other players: 5 players in 14 days', id = 'muted-a-lot'): SignalHit => ({ id, effect: 'note', text });
const raise = (text = 'Blocked by other players: 3 players in 14 days', id = 'blocked-a-lot'): SignalHit => ({ id, effect: 'raise', text });
const run = (step: number, level: ConductLevel | null, rule: number | 'uncovered', hits?: readonly SignalHit[], profile = standard) =>
  suggest(profile, AT[step] ?? [], level, rule, NOW, hits === undefined ? {} : { signals: hits });

describe('no feed: nothing changes', () => {
  it('with no hits the suggestion is deep-equal to the one without a context, for every level, step and rule kind', () => {
    for (const level of [...CONDUCT_LEVELS, null] as const) {
      for (let step = 0; step <= 5; step += 1) {
        for (const rule of [2, 1, 5, 'uncovered'] as const) {
          const plain = suggest(standard, AT[step] ?? [], level, rule, NOW);
          expect(run(step, level, rule, []), `${String(level)} step ${step} rule ${rule}`).toEqual(plain);
          expect(run(step, level, rule, undefined)).toEqual(plain);
          expect('signals' in plain).toBe(false);
        }
      }
    }
  });

  it('the golden outcomes of the standard ladder are as they were', () => {
    expect(run(0, 'rude', 2).outcome).toBe('warning');
    expect(run(0, 'hostile', 2).outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(run(1, 'rude', 2).outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(run(2, 'hostile', 2).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
    expect(run(0, 'severe', 1).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });
});

describe('note', () => {
  it('appends the sentence to why and keeps the outcome and label', () => {
    const plain = run(1, 'rude', 2);
    const out = run(1, 'rude', 2, [note()]);
    expect(out.outcome).toEqual(plain.outcome);
    expect(out.label).toBe(plain.label);
    expect(out.why).toBe(`${plain.why} Also: Muted by other players: 5 players in 14 days.`);
    expect(out.signals).toEqual({ raised: false, ids: ['muted-a-lot'] });
  });

  it('several notes each get a sentence, in order', () => {
    const out = run(1, 'rude', 2, [note('A: 3 players in 7 days', 'a'), note('B: 2 players in 7 days', 'b')]);
    expect(out.why).toMatch(/ Also: A: 3 players in 7 days\. Also: B: 2 players in 7 days\.$/);
    expect(out.signals).toEqual({ raised: false, ids: ['a', 'b'] });
  });

  it('a positive-only hit only notes (a note hit never changes the outcome, whatever the step)', () => {
    for (let step = 0; step <= 5; step += 1) {
      const plain = run(step, 'hostile', 2);
      const out = run(step, 'hostile', 2, [note('Commended by other players: 4 players in 30 days', 'kind')]);
      expect(out.outcome, `step ${step}`).toEqual(plain.outcome);
      expect(out.signals).toEqual({ raised: false, ids: ['kind'] });
    }
  });
});

describe('raise', () => {
  it('moves one step in the same column: rude reads the low/medium column, hostile the high one, severe the high one', () => {
    // rude, a warning on the record (step 1): the low/medium cell of step 1 is chat 24 h; one step on is chat 7 days.
    expect(run(1, 'rude', 2).outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(run(1, 'rude', 2, [raise()]).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    // hostile at step 2: high column ban 7 days -> step 3 high: ban 30 days.
    expect(run(2, 'hostile', 2).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
    expect(run(2, 'hostile', 2, [raise()]).outcome).toEqual({ kind: 'ban', durationMs: 30 * DAY });
    // rude at step 2: low/medium chat 7 days -> step 3 low/medium ban 7 days.
    expect(run(2, 'rude', 2, [raise()]).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
  });

  it('on a clean record it takes the first row\'s cell when that is stronger than the first-offence pick', () => {
    expect(run(0, 'rude', 2).outcome).toBe('warning');
    expect(run(0, 'rude', 2, [raise()]).outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(run(0, 'hostile', 2, [raise()]).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    const out = run(0, 'rude', 2, [raise()]);
    expect(out.signals).toEqual({ raised: true, ids: ['blocked-a-lot'] });
    expect(out.why).toContain('Raised one step: Blocked by other players: 3 players in 14 days.');
    expect(out.label).toBe('Restrict chat 24 hours');
  });

  it('never goes past step 5, never into a permanent cell (note only), and a permanent pick stays', () => {
    // Step 4 hostile: the high column is permanent ban already; step 5 is permanent: note only.
    const s4 = run(4, 'hostile', 2);
    const out4 = run(4, 'hostile', 2, [raise()]);
    expect(out4.outcome).toEqual(s4.outcome);
    expect(out4.signals).toEqual({ raised: false, ids: ['blocked-a-lot'] });
    expect(out4.why).toContain('Also: Blocked by other players');
    expect(out4.why).not.toContain('Raised');
    // Step 4 rude: low/medium is ban 30 d; the next cell (step 5) is a permanent ban: skipped.
    const s4r = run(4, 'rude', 2);
    expect(run(4, 'rude', 2, [raise()]).outcome).toEqual(s4r.outcome);
    expect(run(4, 'rude', 2, [raise()]).signals?.raised).toBe(false);
    // Step 5: nothing beyond.
    expect(run(5, 'hostile', 2, [raise()]).outcome).toEqual(run(5, 'hostile', 2).outcome);
    expect(run(5, 'rude', 2, [raise()]).signals).toEqual({ raised: false, ids: ['blocked-a-lot'] });
    // And across the whole table a raise never produces a permanent outcome that was not already there.
    for (const level of ['rude', 'hostile', 'severe'] as const) {
      for (let step = 0; step <= 5; step += 1) {
        const before = run(step, level, 2).outcome;
        const after = run(step, level, 2, [raise()]).outcome;
        const permanent = (o: unknown): boolean => typeof o === 'object' && o !== null && (o as { durationMs: number | null }).durationMs === null;
        if (permanent(after)) expect(permanent(before), `${level} step ${step}`).toBe(true);
      }
    }
  });

  it('never below the first-offence outcome', () => {
    // A profile whose first offence for hostile conduct is already a 30 day ban: the next ladder cell is weaker, so nothing moves.
    const harsh = resolveProfile('standard', { firstOffense: { hostile: { kind: 'ban', durationMs: 30 * DAY } } });
    const plain = run(0, 'hostile', 2, undefined, harsh);
    expect(plain.outcome).toEqual({ kind: 'ban', durationMs: 30 * DAY });
    const out = run(0, 'hostile', 2, [raise()], harsh);
    expect(out.outcome).toEqual(plain.outcome);
    expect(out.signals?.raised).toBe(false);
  });

  it('two raise rules firing give one step', () => {
    const one = run(1, 'rude', 2, [raise('A: 3 players in 7 days', 'a')]);
    const two = run(1, 'rude', 2, [raise('A: 3 players in 7 days', 'a'), raise('B: 2 players in 7 days', 'b')]);
    expect(two.outcome).toEqual(one.outcome);
    expect(two.outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(two.signals).toEqual({ raised: true, ids: ['a', 'b'] });
    expect(two.why).toContain('Raised one step: A: 3 players in 7 days.');
    expect(two.why).toContain('Also: B: 2 players in 7 days.');
    // A raise and a note together: one step, both sentences.
    const mixed = run(1, 'rude', 2, [note(), raise()]);
    expect(mixed.outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('the area swap still applies after a raise', () => {
    // Rule 5 swaps a chat restriction for a ban from public rooms at the same length.
    const plain = run(1, 'rude', 5);
    expect(plain.outcome).toEqual({ kind: 'area', durationMs: DAY });
    const out = run(1, 'rude', 5, [raise()]);
    expect(out.outcome).toEqual({ kind: 'area', durationMs: 7 * DAY });
    expect(out.label).toBe('Ban from public rooms 7 days');
    expect(out.why).toContain('this rule bans from public rooms instead of restricting chat');
  });
});

describe('what a signal never does', () => {
  it('banter returns unchanged with hits, and carries no signals', () => {
    const plain = run(2, 'banter', 2);
    const out = run(2, 'banter', 2, [note(), raise()]);
    expect(out).toEqual(plain);
    expect(out.outcome).toBe('none');
    expect('signals' in out).toBe(false);
    expect(run(0, 'banter', 2, [raise()]).outcome).toBe('none');
  });

  it('a note can never turn a no-action outcome into an action', () => {
    expect(run(0, 'banter', 5, [note()]).outcome).toBe('none');
  });

  it('hits that are not well formed are ignored', () => {
    const plain = run(1, 'rude', 2);
    const junk: unknown[] = [null, 5, 'x', {}, { id: 1, effect: 'note', text: 't' }, { id: 'a', effect: 'ban', text: 't' }, { id: 'a', effect: 'raise', text: 5 }, [], { id: 'a', effect: 'raise' }];
    const out = suggest(standard, AT[1] ?? [], 'rude', 2, NOW, { signals: junk } as unknown as SuggestContext);
    expect(out).toEqual(plain);
    expect('signals' in out).toBe(false);
    expect(suggest(standard, AT[1] ?? [], 'rude', 2, NOW, { signals: 'x' } as unknown as SuggestContext)).toEqual(plain);
  });

  it('suggest returns a fresh object and does not change its hits', () => {
    const hits = [note(), raise()];
    const copy = JSON.parse(JSON.stringify(hits)) as SignalHit[];
    const a = run(1, 'rude', 2, hits);
    const b = run(1, 'rude', 2, hits);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(hits).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The facade: cw.suggest computes the hits from feeds.ladder for the reported person.

const FEEDS = {
  ladder: [
    { id: 'muted-a-lot', kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14, effect: 'note' as const },
    { id: 'blocked-a-lot', kinds: ['blocked_by_player'], minDistinct: 2, windowDays: 14, effect: 'raise' as const },
  ],
};

async function world() {
  const w = await sworld({ feeds: FEEDS });
  const target = w.person('target');
  const bys = [1, 2, 3, 4].map((i) => w.person(`by-${i}`));
  const record = (kind: string, subject: SubjectId, by: SubjectId, over: Record<string, unknown> = {}): void => {
    expect(w.cw.signals.record({ kind, subject, by, ...over } as never), kind).toBe(true);
  };
  return { ...w, target, bys, record };
}

describe('cw.suggest with the ladder feed', () => {
  it('with no rule met the suggestion is the one without a feed', async () => {
    const w = await world();
    const plain = (await sworld()).cw.suggest(w.target, 'rude', 2);
    const out = w.cw.suggest(w.target, 'rude', 2);
    expect(out.outcome).toEqual(plain.outcome);
    expect(out.why).toBe(plain.why);
    expect('signals' in out).toBe(false);
  });

  it('a note rule met appends the sentence with the label, the count and the window', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    const out = w.cw.suggest(w.target, 'rude', 2);
    expect(out.why).toMatch(/ Also: Muted by other players: 3 players in 14 days\.$/);
    expect(out.signals).toEqual({ raised: false, ids: ['muted-a-lot'] });
    expect(out.outcome).toBe('warning');
  });

  it('a raise rule met moves the suggestion one step, and says so', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 2)) w.record('blocked_by_player', w.target, by);
    const out = w.cw.suggest(w.target, 'rude', 2);
    expect(out.outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(out.signals).toEqual({ raised: true, ids: ['blocked-a-lot'] });
    expect(out.why).toContain('Raised one step: Blocked by other players: 2 players in 14 days.');
  });

  it('both rules met: one step and two sentences, in the order of the rules', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    for (const by of w.bys.slice(0, 2)) w.record('blocked_by_player', w.target, by);
    const out = w.cw.suggest(w.target, 'rude', 2);
    expect(out.signals).toEqual({ raised: true, ids: ['muted-a-lot', 'blocked-a-lot'] });
    expect(out.outcome).toEqual({ kind: 'chat', durationMs: DAY });
  });

  it('banter is untouched, and a signal never turns it into action', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    for (const by of w.bys.slice(0, 2)) w.record('blocked_by_player', w.target, by);
    const out = w.cw.suggest(w.target, 'banter', 2);
    expect(out.outcome).toBe('none');
    expect('signals' in out).toBe(false);
  });

  it('a signals list passed by the caller in the context is ignored', async () => {
    const w = await world();
    const fake: SignalHit[] = [{ id: 'fake', effect: 'raise', text: 'FAKE TEXT' }];
    const plain = w.cw.suggest(w.target, 'rude', 2);
    const out = w.cw.suggest(w.target, 'rude', 2, { signals: fake, roomId: 'room-1' });
    expect(out).toEqual(plain);
    expect(JSON.stringify(out)).not.toContain('FAKE');
    // Real hits replace what was passed, they do not add to it.
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    const real = w.cw.suggest(w.target, 'rude', 2, { signals: fake });
    expect(real.signals).toEqual({ raised: false, ids: ['muted-a-lot'] });
    expect(JSON.stringify(real)).not.toContain('FAKE');
  });

  it('an alias of the reported person is counted with them', async () => {
    const w = await world();
    w.cw.rooms.seat('acct', 'p1', { accountId: 'acct-t' }, 'T');
    const alias = w.cw.rooms.subjectAt('acct', 'p1') as SubjectId;
    w.record('muted_by_player', w.target, w.bys[0]!);
    w.record('muted_by_player', alias, w.bys[1]!);
    w.record('muted_by_player', alias, w.bys[2]!);
    w.cw.rooms.seat('merge', 'p1', { clientKey: 'target', accountId: 'acct-t' }, 'T');
    expect(w.cw.suggest(w.target, 'rude', 2).signals?.ids).toEqual(['muted-a-lot']);
    expect(w.cw.suggest(alias, 'rude', 2).signals?.ids).toEqual(['muted-a-lot']);
  });

  it('a source older than the rule window does not count', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by, { at: w.clock.t - 15 * DAY });
    expect('signals' in w.cw.suggest(w.target, 'rude', 2)).toBe(false);
  });

  it('a store failure leaves the plain suggestion', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    w.store.listSignalSources = () => {
      throw new Error('disk');
    };
    const out = w.cw.suggest(w.target, 'rude', 2);
    expect('signals' in out).toBe(false);
    expect(out.outcome).toBe('warning');
  });

  it('singular text at one player and one day', async () => {
    const w = await sworld({ feeds: { ladder: [{ id: 'one', kinds: ['muted_by_player'], minDistinct: 1, windowDays: 1, effect: 'note' }] } });
    const target = w.person('target');
    w.cw.signals.record({ kind: 'muted_by_player', subject: target, by: w.person('by') });
    expect(w.cw.suggest(target, 'rude', 2).why).toMatch(/Also: Muted by other players: 1 player in 1 day\.$/);
  });

  it('a rule over two kinds names both labels and sums the sources', async () => {
    const w = await sworld({ feeds: { ladder: [{ id: 'both', kinds: ['muted_by_player', 'blocked_by_player'], minDistinct: 3, windowDays: 14, effect: 'note' }] } });
    const target = w.person('target');
    const [b1, b2] = [w.person('b1'), w.person('b2')];
    w.cw.signals.record({ kind: 'muted_by_player', subject: target, by: b1 });
    w.cw.signals.record({ kind: 'blocked_by_player', subject: target, by: b1 });
    w.cw.signals.record({ kind: 'muted_by_player', subject: target, by: b2 });
    expect(w.cw.suggest(target, 'rude', 2).why).toMatch(/Also: Muted by other players, Blocked by other players: 3 players in 14 days\.$/);
  });

  it('a positive-kind note rule only notes', async () => {
    const w = await sworld({ feeds: { ladder: [{ id: 'nice', kinds: ['commended'], minDistinct: 2, windowDays: 30, effect: 'note' }] } });
    const target = w.person('target');
    for (const k of ['c1', 'c2']) w.cw.signals.record({ kind: 'commended', subject: target, by: w.person(k) });
    const out = w.cw.suggest(target, 'hostile', 2);
    expect(out.outcome).toEqual(w.cw.suggest(w.person('other'), 'hostile', 2).outcome);
    expect(out.signals).toEqual({ raised: false, ids: ['nice'] });
  });

  it('the preview with sample records is unchanged by signals', async () => {
    const w = await world();
    const before = w.cw.policy.preview({});
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    for (const by of w.bys.slice(0, 2)) w.record('blocked_by_player', w.target, by);
    const after = w.cw.policy.preview({});
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('Also:');
    void OWNER;
  });

  it('a saved layer that changes the rules changes the hits at once', async () => {
    const w = await world();
    for (const by of w.bys.slice(0, 3)) w.record('muted_by_player', w.target, by);
    expect(w.cw.suggest(w.target, 'rude', 2).signals?.ids).toEqual(['muted-a-lot']);
    w.cw.policy.save({ signals: { feeds: {} } }, { version: 0, ...OWNER });
    expect('signals' in w.cw.suggest(w.target, 'rude', 2)).toBe(false);
  });
});
