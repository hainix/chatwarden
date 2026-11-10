import { describe, expect, it } from 'vitest';
import {
  actionStep,
  HISTORY_LOOKBACK_MS,
  historyOf,
  LADDER_TABLE,
  recordStep,
  suggest,
  type ActionRecord,
  type LadderCell,
} from '../src/ladder.js';
import { PRESETS, resolveProfile } from '../src/profile.js';
import type { ModerationProfile } from '../src/profile.js';
import { parseRuleRef } from '../src/rules.js';
import type { RuleRef } from '../src/rules.js';
import { SubjectIndex } from '../src/subjects.js';
import { CONDUCT_LEVELS } from '../src/types.js';
import type { ConductLevel, Identifiers, SanctionKind, SanctionRow } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

function rec(kind: SanctionKind, durationMs: number | null, over: Partial<ActionRecord> = {}): ActionRecord {
  return { kind, durationMs, startsAt: NOW - DAY, revoked: false, automated: false, roomId: null, ...over };
}
const warn = (over: Partial<ActionRecord> = {}) => rec('warning', 0, over);
const note = (over: Partial<ActionRecord> = {}) => rec('note', 0, over);

describe('actionStep: kind and length to a step', () => {
  it('a note is step 0, whatever its duration: it is on the record but moves nothing', () => {
    expect(actionStep(note())).toBe(0);
    expect(actionStep(rec('note', null))).toBe(0);
    expect(actionStep(rec('note', 30 * DAY))).toBe(0);
    expect(actionStep(note({ revoked: true }))).toBe(0);
    expect(actionStep(note({ roomId: 'R1', automated: true }))).toBe(0);
  });

  it('a warning is step 1, whatever its duration', () => {
    expect(actionStep(warn())).toBe(1);
    expect(actionStep(rec('warning', null))).toBe(1);
    expect(actionStep(rec('warning', 30 * DAY))).toBe(1);
  });

  it.each<[SanctionKind, number]>([
    ['chat', 1],
    ['chat', 30 * 60_000],
    ['chat', DAY],
    ['chat', 7 * DAY - 1],
    ['area', 1],
    ['area', DAY],
    ['area', 7 * DAY - 1],
  ])('%s under 7 days (%i ms) is step 2', (kind, ms) => {
    expect(actionStep(rec(kind, ms))).toBe(2);
  });

  it('an auto timeout counts like any chat restriction of its length', () => {
    expect(actionStep(rec('chat', 30 * 60_000, { automated: true }))).toBe(2);
    expect(actionStep(rec('chat', DAY, { automated: true }))).toBe(2);
  });

  it.each<[SanctionKind, number]>([
    ['chat', 7 * DAY],
    ['chat', 30 * DAY],
    ['chat', 400 * DAY],
    ['area', 7 * DAY],
    ['area', 90 * DAY],
    ['ban', 1],
    ['ban', DAY],
    ['ban', 7 * DAY - 1],
  ])('%s of %i ms is step 3', (kind, ms) => {
    expect(actionStep(rec(kind, ms))).toBe(3);
  });

  it.each<number>([7 * DAY, 14 * DAY, 30 * DAY - 1])('a ban of %i ms is step 4', (ms) => {
    expect(actionStep(rec('ban', ms))).toBe(4);
  });

  it.each<number>([30 * DAY, 31 * DAY, 365 * DAY])('a ban of %i ms is step 5', (ms) => {
    expect(actionStep(rec('ban', ms))).toBe(5);
  });

  it.each<SanctionKind>(['chat', 'area', 'ban'])('a permanent %s is step 5', (kind) => {
    expect(actionStep(rec(kind, null))).toBe(5);
  });

  it('a revoked record still maps to its own step (recordStep is what ignores it)', () => {
    expect(actionStep(rec('ban', 40 * DAY, { revoked: true }))).toBe(5);
  });
});

describe('recordStep: the highest step of the live records', () => {
  it('no records is step 0', () => {
    expect(recordStep([])).toBe(0);
  });

  it('one warning is step 1', () => {
    expect(recordStep([warn()])).toBe(1);
  });

  it('two or more warnings make step 2; three stay at 2', () => {
    expect(recordStep([warn(), warn()])).toBe(2);
    expect(recordStep([warn(), warn(), warn()])).toBe(2);
  });

  it('a revoked warning does not count toward the pair', () => {
    expect(recordStep([warn(), warn({ revoked: true })])).toBe(1);
    expect(recordStep([warn({ revoked: true }), warn({ revoked: true })])).toBe(0);
  });

  it('takes the maximum across kinds', () => {
    expect(recordStep([warn(), rec('chat', DAY)])).toBe(2);
    expect(recordStep([warn(), rec('chat', 7 * DAY), rec('chat', DAY)])).toBe(3);
    expect(recordStep([rec('chat', DAY), rec('ban', 10 * DAY)])).toBe(4);
    expect(recordStep([rec('ban', 10 * DAY), rec('ban', null)])).toBe(5);
  });

  it('two warnings never outrank a higher single action', () => {
    expect(recordStep([warn(), warn(), rec('ban', 8 * DAY)])).toBe(4);
  });

  it('notes never move the step: alone they are 0, beside other actions they change nothing', () => {
    expect(recordStep([note()])).toBe(0);
    expect(recordStep([note(), note(), note(), note()])).toBe(0);
    expect(recordStep([note(), warn()])).toBe(1);
    expect(recordStep([note(), rec('chat', DAY)])).toBe(2);
    expect(recordStep([note(), rec('ban', null), note()])).toBe(5);
  });

  it('a note is not a warning: one warning plus notes stays step 1, never the "two warnings" step 2', () => {
    expect(recordStep([warn(), note(), note()])).toBe(1);
    expect(recordStep([note(), note(), warn(), warn()])).toBe(2);
  });

  it('ignores revoked records of every kind', () => {
    expect(recordStep([rec('ban', null, { revoked: true })])).toBe(0);
    expect(recordStep([rec('ban', null, { revoked: true }), rec('chat', DAY)])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// historyOf
// ---------------------------------------------------------------------------

function row(over: Partial<SanctionRow> = {}): SanctionRow {
  return {
    id: 'r1',
    groupId: 'g1',
    refCode: 'M-AAAAA',
    kind: 'chat',
    targetType: 'subject',
    value: 's_x',
    startsAt: NOW - DAY,
    endsAt: NOW - DAY + H,
    reason: 'private',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod',
    source: 'moderator',
    automated: false,
    pending: false,
    ...over,
  };
}

let seq = 0;
function put(store: MemoryStore, over: Partial<SanctionRow>): void {
  seq += 1;
  const rows = [row({ id: `r${seq}`, groupId: `g${seq}`, refCode: `M-${String(10000 + seq)}`, ...over })];
  expect(store.insertSanctionGroup(rows)).toBe(true);
}

function setup() {
  const store = new MemoryStore();
  const clock = { t: 100, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  return { store, clock, subjects };
}
const who = (clientKey: string | null, accountId: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash: null,
});
function must<T>(v: T | null): T {
  if (v === null) throw new Error('expected a value');
  return v;
}

describe('historyOf: the canonical person over the last 90 days', () => {
  it('maps a row to a record: duration from endsAt - startsAt, null when permanent', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const s = must(subjects.resolve(who('k1')));
    put(store, { value: s, kind: 'chat', startsAt: NOW - DAY, endsAt: NOW - DAY + 2 * H, automated: true });
    put(store, { value: s, kind: 'ban', startsAt: NOW - 2 * DAY, endsAt: null });
    put(store, { value: s, kind: 'warning', startsAt: NOW - 3 * DAY, endsAt: NOW - 3 * DAY });
    const h = historyOf(store, subjects, s, NOW);
    expect(h).toHaveLength(3);
    const byKind = new Map(h.map((r) => [r.kind, r]));
    expect(byKind.get('chat')).toEqual({
      kind: 'chat', durationMs: 2 * H, startsAt: NOW - DAY, revoked: false, automated: true, roomId: null,
    });
    expect(byKind.get('ban')).toMatchObject({ durationMs: null, automated: false });
    expect(byKind.get('warning')).toMatchObject({ durationMs: 0, revoked: false });
  });

  it('a note is in the history with its room; a row stored without a room reads null', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const s = must(subjects.resolve(who('k1')));
    put(store, { value: s, kind: 'note', startsAt: NOW - DAY, endsAt: NOW - DAY, roomId: 'room-A' });
    put(store, { value: s, kind: 'note', startsAt: NOW - 2 * DAY, endsAt: NOW - 2 * DAY, roomId: 'room-B' });
    put(store, { value: s, kind: 'chat', startsAt: NOW - 3 * DAY, endsAt: NOW - 3 * DAY + H });
    const h = historyOf(store, subjects, s, NOW);
    expect(h).toHaveLength(3);
    const notes = h.filter((r) => r.kind === 'note');
    expect(notes.map((r) => r.roomId)).toEqual(['room-A', 'room-B']);
    expect(notes[0]).toEqual({ kind: 'note', durationMs: 0, startsAt: NOW - DAY, revoked: false, automated: false, roomId: 'room-A' });
    expect(h.find((r) => r.kind === 'chat')?.roomId).toBeNull();
    // Notes do not move the step.
    expect(recordStep(h)).toBe(2);
    expect(recordStep(notes)).toBe(0);
  });

  it('a revoked note is flagged revoked and keeps its room', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const s = must(subjects.resolve(who('k1')));
    put(store, { value: s, kind: 'note', startsAt: NOW - DAY, endsAt: NOW - DAY, roomId: 'room-A' });
    const group = store.rawSanctions()[0]?.groupId as string;
    store.revokeSanctionGroup(group, 'mod', NOW, 'mistake');
    expect(historyOf(store, subjects, s, NOW)).toEqual([
      { kind: 'note', durationMs: 0, startsAt: NOW - DAY, revoked: true, automated: false, roomId: 'room-A' },
    ]);
  });

  it('the 90-day lookback is measured from startsAt and is inclusive', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const s = must(subjects.resolve(who('k1')));
    const edge = NOW - HISTORY_LOOKBACK_MS;
    expect(HISTORY_LOOKBACK_MS).toBe(90 * DAY);
    put(store, { value: s, kind: 'ban', startsAt: edge, endsAt: edge + H });
    put(store, { value: s, kind: 'chat', startsAt: edge - 1, endsAt: edge + 5 * DAY });
    const h = historyOf(store, subjects, s, NOW);
    expect(h.map((r) => r.kind)).toEqual(['ban']);
  });

  it('a row that started long ago but is still running is outside the window (starts_at decides)', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const s = must(subjects.resolve(who('k1')));
    put(store, { value: s, kind: 'ban', startsAt: NOW - 91 * DAY, endsAt: null });
    expect(historyOf(store, subjects, s, NOW)).toEqual([]);
  });

  it('includes revoked rows, flagged', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const s = must(subjects.resolve(who('k1')));
    put(store, { value: s, kind: 'ban', startsAt: NOW - DAY, endsAt: NOW + DAY });
    put(store, { value: s, kind: 'chat', startsAt: NOW - 2 * DAY, endsAt: NOW - DAY });
    const group = store.rawSanctions().find((r) => r.kind === 'ban')?.groupId as string;
    store.revokeSanctionGroup(group, 'mod', NOW, 'mistake');
    const h = historyOf(store, subjects, s, NOW);
    expect(h.find((r) => r.kind === 'ban')?.revoked).toBe(true);
    expect(h.find((r) => r.kind === 'chat')?.revoked).toBe(false);
    expect(recordStep(h)).toBe(2);
  });

  it('leaves out IP rows and other people', async () => {
    const { store, subjects } = setup();
    await subjects.load();
    const a = must(subjects.resolve(who('k1')));
    const b = must(subjects.resolve(who('k2')));
    put(store, { value: a, kind: 'ban', startsAt: NOW - DAY, endsAt: NOW + DAY });
    put(store, { value: 'iphash', targetType: 'ip', kind: 'ban', startsAt: NOW - DAY, endsAt: NOW + DAY });
    put(store, { value: b, kind: 'ban', startsAt: NOW - DAY, endsAt: null });
    const h = historyOf(store, subjects, a, NOW);
    expect(h).toHaveLength(1);
    expect(h[0]?.durationMs).toBe(2 * DAY);
    expect(historyOf(store, subjects, 's_nobody', NOW)).toEqual([]);
  });

  it('folds aliases: rows on a merged-away subject count for the survivor, whichever id is asked for', async () => {
    const { store, clock, subjects } = setup();
    await subjects.load();
    const older = must(subjects.resolve(who('k1')));
    clock.t = 200;
    const newer = must(subjects.resolve(who(null, 'a1')));
    expect(older).not.toBe(newer);
    put(store, { value: older, kind: 'warning', startsAt: NOW - DAY, endsAt: NOW - DAY });
    put(store, { value: newer, kind: 'warning', startsAt: NOW - 2 * DAY, endsAt: NOW - 2 * DAY });
    // Before the link they are two people.
    expect(historyOf(store, subjects, older, NOW)).toHaveLength(1);
    // The account ties them together.
    clock.t = 300;
    const merged = must(subjects.resolve(who('k1', 'a1')));
    expect(merged).toBe(older);
    for (const id of [older, newer]) {
      const h = historyOf(store, subjects, id, NOW);
      expect(h).toHaveLength(2);
      expect(recordStep(h)).toBe(2);
    }
  });
});


// ---------------------------------------------------------------------------
// the ladder table (the feature contract's cells) and conduct levels
// ---------------------------------------------------------------------------

type Cell = [kind: SanctionKind, durationMs: number | null, label: string];
const WARNING: Cell = ['warning', null, 'Warning'];
const CHAT_24H: Cell = ['chat', DAY, 'Restrict chat 24 hours'];
const CHAT_7D: Cell = ['chat', 7 * DAY, 'Restrict chat 7 days'];
const BAN_7D: Cell = ['ban', 7 * DAY, 'Full ban 7 days'];
const BAN_30D: Cell = ['ban', 30 * DAY, 'Full ban 30 days'];
const BAN_PERM: Cell = ['ban', null, 'Full ban permanent'];

// The feature contract's table, cell for cell: [step, low/medium, high or CR 1].
const CONTRACT: Array<[0 | 1 | 2 | 3 | 4 | 5, Cell, Cell]> = [
  [0, WARNING, CHAT_7D],
  [1, CHAT_24H, CHAT_7D],
  [2, CHAT_7D, BAN_7D],
  [3, BAN_7D, BAN_30D],
  [4, BAN_30D, BAN_PERM],
  [5, BAN_PERM, BAN_PERM],
];

const asCell = (s: LadderCell): Cell => [s.kind, s.durationMs, s.label];
const outcomeOf = (c: Cell) => (c[0] === 'warning' ? 'warning' : { kind: c[0], durationMs: c[1] });

describe('LADDER_TABLE', () => {
  it('holds the same 12 cells, for the Guide to render', () => {
    expect(LADDER_TABLE).toHaveLength(6);
    for (const [step, low, high] of CONTRACT) {
      const r = LADDER_TABLE[step];
      expect(r?.step).toBe(step);
      expect(asCell(r?.lowMedium as LadderCell)).toEqual(low);
      expect(asCell(r?.high as LadderCell)).toEqual(high);
    }
  });
});

describe('conduct levels', () => {
  it('CONDUCT_LEVELS is the ordered ladder of levels, frozen', () => {
    expect([...CONDUCT_LEVELS]).toEqual(['banter', 'rude', 'hostile', 'severe']);
    expect(Object.isFrozen(CONDUCT_LEVELS)).toBe(true);
  });

  it('an old K2 severity throws rather than quietly reading the mild column', () => {
    for (const old of ['none', 'low', 'medium', 'high']) {
      expect(() => suggest(PRESETS.relaxed, [], old as never, 2, NOW)).toThrow(RangeError);
      expect(() => suggest(PRESETS.relaxed, [], old as never, 1, NOW)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------

const RELAXED = PRESETS.relaxed;
const STANDARD = PRESETS.standard;
const STRICT = PRESETS.strict;

const sug = (
  profile: ModerationProfile,
  records: ActionRecord[],
  level: ConductLevel | null,
  rule: RuleRef = 2,
  roomId?: string | null,
) => suggest(profile, records, level, rule, NOW, roomId === undefined ? {} : { roomId });

/** One record per step on the ladder, from step 1 to step 5. */
const AT_STEP: Record<1 | 2 | 3 | 4 | 5, ActionRecord[]> = {
  1: [warn()],
  2: [rec('chat', DAY)],
  3: [rec('chat', 7 * DAY)],
  4: [rec('ban', 7 * DAY)],
  5: [rec('ban', 30 * DAY)],
};

describe('suggest: banter never punishes', () => {
  it('"loser" under relaxed with a clean record is no action', () => {
    const s = sug(RELAXED, [], 'banter');
    expect(s).toMatchObject({ outcome: 'none', label: 'No action' });
    expect(s.why).toMatch(/^Relaxed profile: /);
  });

  it('under every preset, record, rule and override, banter is none', () => {
    const heavy = [rec('ban', null), warn(), note({ roomId: 'a' }), note({ roomId: 'b' })];
    const profiles = [RELAXED, STANDARD, STRICT, resolveProfile('strict', { severeRules: [2, 5], areaRules: [2] })];
    for (const p of profiles) {
      for (const records of [[], heavy]) {
        for (const rule of [1, 2, 5, 6, 'uncovered'] as RuleRef[]) {
          expect(sug(p, records, 'banter', rule, 'x')).toMatchObject({ outcome: 'none', label: 'No action' });
        }
      }
    }
  });
});

describe('suggest: relaxed, the moderator\'s scenarios', () => {
  it('a first "go f-- yourself" (rude) with a clean record is a note', () => {
    const s = sug(RELAXED, [], 'rude', 2, 'game-1');
    expect(s.outcome).toBe('note');
    expect(s.label).toBe('Note');
    expect(s.why).toBe('Relaxed profile: first aggressive message with a clean record is noted.');
  });

  it('a second rude in ANOTHER game within 30 days is a warning', () => {
    const s = sug(RELAXED, [note({ roomId: 'game-1', startsAt: NOW - 2 * DAY })], 'rude', 2, 'game-2');
    expect(s).toMatchObject({ outcome: 'warning', label: 'Warning' });
    expect(s.why).toContain('2 notes in 30 days from different games');
  });

  it('a second rude in the SAME game stays a note (Review Focus 3)', () => {
    const s = sug(RELAXED, [note({ roomId: 'game-1' })], 'rude', 2, 'game-1');
    expect(s).toMatchObject({ outcome: 'note', label: 'Note' });
    expect(s.why).toContain('do not yet add up');
  });

  it('the 30 day boundary: a note exactly 30 days old counts, one millisecond older has aged out', () => {
    expect(sug(RELAXED, [note({ roomId: 'g1', startsAt: NOW - 30 * DAY })], 'rude', 2, 'g2').outcome).toBe('warning');
    expect(sug(RELAXED, [note({ roomId: 'g1', startsAt: NOW - 30 * DAY - 1 })], 'rude', 2, 'g2').outcome).toBe('note');
    expect(sug(RELAXED, [note({ roomId: 'g1', startsAt: NOW - 30 * DAY + 1 })], 'rude', 2, 'g2').outcome).toBe('warning');
  });

  it('a revoked note does not count', () => {
    expect(sug(RELAXED, [note({ roomId: 'g1', revoked: true })], 'rude', 2, 'g2').outcome).toBe('note');
  });

  it('two earlier notes from the same game are one game, so they do not make a repeat with a third incident in it', () => {
    const r = [note({ roomId: 'g1' }), note({ roomId: 'g1' })];
    expect(sug(RELAXED, r, 'rude', 2, 'g1').outcome).toBe('note');
    expect(sug(RELAXED, r, 'rude', 2, 'g2').outcome).toBe('warning');
  });

  it('an unknown room for this incident never pairs with an earlier note', () => {
    const r = [note({ roomId: 'g1' })];
    expect(sug(RELAXED, r, 'rude', 2).outcome).toBe('note');
    expect(sug(RELAXED, r, 'rude', 2, null).outcome).toBe('note');
    expect(sug(RELAXED, r, 'rude', 2, '').outcome).toBe('note');
  });

  it('an earlier note with no room is an unknown game and never pairs either', () => {
    expect(sug(RELAXED, [note({ roomId: null })], 'rude', 2, 'g2').outcome).toBe('note');
  });

  it('two earlier notes from different games already make a repeat, whatever room this incident is in', () => {
    const r = [note({ roomId: 'g1' }), note({ roomId: 'g2' })];
    expect(sug(RELAXED, r, 'rude', 2).outcome).toBe('warning');
    expect(sug(RELAXED, r, 'rude', 2, 'g1').outcome).toBe('warning');
  });

  it('hostile on a clean record is a warning', () => {
    expect(sug(RELAXED, [], 'hostile')).toMatchObject({ outcome: 'warning', label: 'Warning' });
  });

  it('rude after a warning follows the ladder: chat 24 hours', () => {
    const s = sug(RELAXED, [warn()], 'rude', 2, 'g9');
    expect(s).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY }, label: 'Restrict chat 24 hours' });
    expect(s.why).toContain('ladder');
  });

  it('notes on top of a warning change nothing: the ladder alone decides', () => {
    const r = [warn(), note({ roomId: 'a' }), note({ roomId: 'b' })];
    expect(sug(RELAXED, r, 'rude', 2, 'c').outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(sug(RELAXED, [note({ roomId: 'a' }), note({ roomId: 'b' })], 'rude', 2, 'c').outcome).toBe('warning');
  });

  it('severe on a clean record is chat for 7 days', () => {
    const s = sug(RELAXED, [], 'severe');
    expect(s).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY }, label: 'Restrict chat 7 days' });
    expect(s.why).toMatch(/^Relaxed profile: severe conduct/);
  });

  it('severe ignores notes and the repeat rule, and climbs with the record', () => {
    expect(sug(RELAXED, [note({ roomId: 'a' })], 'severe', 2, 'b').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(sug(RELAXED, AT_STEP[2], 'severe').outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
    expect(sug(RELAXED, AT_STEP[5], 'severe').outcome).toEqual({ kind: 'ban', durationMs: null });
  });
});

describe('suggest: the ladder cells, step by step', () => {
  for (const [step, low, high] of CONTRACT) {
    if (step === 0) continue;
    it(`step ${step}: rude reads the low column; hostile and severe read the high column`, () => {
      const records = AT_STEP[step as 1 | 2 | 3 | 4 | 5];
      expect(sug(RELAXED, records, 'rude', 2, 'g')).toMatchObject({ label: low[2] });
      expect(sug(RELAXED, records, 'hostile', 2, 'g')).toMatchObject({ label: high[2] });
      expect(sug(RELAXED, records, 'severe', 2, 'g')).toMatchObject({ label: high[2] });
      expect(sug(RELAXED, records, 'rude', 2, 'g').outcome).toEqual(outcomeOf(low));
      expect(sug(RELAXED, records, 'hostile', 2, 'g').outcome).toEqual(outcomeOf(high));
      expect(sug(RELAXED, records, 'severe', 2, 'g').outcome).toEqual(outcomeOf(high));
    });
  }

  it('the per-level contract holds under every preset: rude = low, hostile = high, severe = high (never below the first offense)', () => {
    for (const p of [RELAXED, STANDARD, STRICT]) {
      for (const [step, low, high] of CONTRACT) {
        if (step === 0) continue;
        const records = AT_STEP[step as 1 | 2 | 3 | 4 | 5];
        for (const [level, cell] of [['rude', low], ['hostile', high], ['severe', high]] as const) {
          const got = sug(p, records, level, 2, 'g').outcome;
          const want = outcomeOf(cell);
          const floor = p.firstOffense[level];
          // the answer is the contract cell, or the profile's own (stronger) first offense when that is harder
          expect([JSON.stringify(want), JSON.stringify(floor)]).toContain(JSON.stringify(got));
        }
      }
    }
  });

  it('a revoked warning does not move the ladder', () => {
    expect(sug(RELAXED, [warn({ revoked: true })], 'rude', 2, 'g').outcome).toBe('note');
    expect(sug(RELAXED, [warn({ revoked: true })], 'hostile').outcome).toBe('warning');
    expect(sug(RELAXED, [warn({ revoked: true }), warn()], 'hostile').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(sug(RELAXED, [rec('ban', 7 * DAY, { revoked: true })], 'severe').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('step 0 severe is the high column of row 0', () => {
    expect(sug(RELAXED, [], 'severe').label).toBe('Restrict chat 7 days');
  });

  it('two warnings make step 2', () => {
    expect(sug(RELAXED, [warn(), warn()], 'hostile', parseRuleRef('2')).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
    expect(sug(RELAXED, [warn(), warn()], 'rude', parseRuleRef('2'), 'g').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('a stored rule text goes through parseRuleRef', () => {
    expect(sug(RELAXED, [warn(), warn()], 'rude', parseRuleRef('5'), 'g').outcome).toEqual({ kind: 'area', durationMs: 7 * DAY });
    expect(sug(RELAXED, [warn(), warn()], 'rude', parseRuleRef('uncovered'), 'g').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(sug(RELAXED, [warn(), warn()], 'hostile', parseRuleRef('5')).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
  });
});

describe('suggest: standard and strict, key cells', () => {
  it('standard first offenses: rude warning, hostile chat 24 h, severe chat 7 d', () => {
    expect(sug(STANDARD, [], 'rude')).toMatchObject({ outcome: 'warning', label: 'Warning' });
    expect(sug(STANDARD, [], 'hostile')).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY }, label: 'Restrict chat 24 hours' });
    expect(sug(STANDARD, [], 'severe')).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY } });
    expect(sug(STANDARD, [], 'rude').why).toMatch(/^Standard profile: /);
  });

  it('standard repeat: 2 notes in 30 days, any game, is chat 24 hours', () => {
    const s = sug(STANDARD, [note({ roomId: 'g1' })], 'rude', 2, 'g1');
    expect(s.outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(s.why).toContain('2 notes in 30 days counts as repeated');
    expect(s.why).not.toContain('different games');
    expect(sug(STANDARD, [], 'rude').outcome).toBe('warning');
  });

  it('standard after a warning: rude steps up the ladder', () => {
    expect(sug(STANDARD, [warn()], 'rude').outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(sug(STANDARD, AT_STEP[2], 'rude').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('strict first offenses: rude chat 1 h, hostile chat 24 h, severe ban 7 d', () => {
    expect(sug(STRICT, [], 'rude')).toMatchObject({ outcome: { kind: 'chat', durationMs: H }, label: 'Restrict chat 1 hour' });
    expect(sug(STRICT, [], 'hostile').outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(sug(STRICT, [], 'severe')).toMatchObject({ outcome: { kind: 'ban', durationMs: 7 * DAY }, label: 'Full ban 7 days' });
  });

  it('strict notes: 1 pins "any EARLIER note": a lone incident on a clean record is not repeated', () => {
    const lone = sug(STRICT, [], 'rude');
    expect(lone.outcome).toEqual({ kind: 'chat', durationMs: H });
    expect(lone.why).not.toContain('repeated');
    expect(lone.why).toContain('clean record');
    expect(sug(STRICT, [], 'rude', 2, 'g1').outcome).toEqual({ kind: 'chat', durationMs: H });
    // an earlier note that has aged out, or been revoked, is not an earlier note either
    expect(sug(STRICT, [note({ startsAt: NOW - 30 * DAY - 1 })], 'rude').outcome).toEqual({ kind: 'chat', durationMs: H });
    expect(sug(STRICT, [note({ revoked: true })], 'rude').outcome).toEqual({ kind: 'chat', durationMs: H });
  });

  it('strict rude with an earlier note is repeated: chat 24 hours, and the reason says so', () => {
    const s = sug(STRICT, [note({ roomId: 'g1' })], 'rude', 2, 'g1');
    expect(s).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY }, label: 'Restrict chat 24 hours' });
    expect(s.why).toContain('repeated');
    expect(s.why).toMatch(/^Strict profile: /);
    expect(sug(STRICT, [note()], 'hostile').outcome).toEqual({ kind: 'chat', durationMs: DAY });
  });

  it('an escalation never goes below the first offense, even if a custom repeat outcome is milder', () => {
    const p = resolveProfile('relaxed', {
      firstOffense: { rude: { kind: 'chat', durationMs: 2 * H } },
      repeat: { windowDays: 30, notes: 2, distinctGames: false, outcome: 'warning' },
    });
    const s = sug(p, [note({ roomId: 'a' })], 'rude', 2, 'b');
    expect(s.outcome).toEqual({ kind: 'chat', durationMs: 2 * H });
    expect(s.label).toBe('Restrict chat 2 hours');
  });

  it('strict severe on a record climbs the ladder: step 3 is a 30 day ban', () => {
    expect(sug(STRICT, AT_STEP[3], 'severe').outcome).toEqual({ kind: 'ban', durationMs: 30 * DAY });
    expect(sug(STRICT, AT_STEP[1], 'severe').outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
  });

  it('standard severe is never below its first offense even if the ladder cell is weaker', () => {
    const weak = LADDER_TABLE.map((r) => ({ ...r, high: { kind: 'warning' as const, durationMs: null, label: 'Warning' } }));
    const p = resolveProfile('standard', { ladder: weak });
    expect(sug(p, [], 'severe').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });
});

describe('suggest: custom profiles', () => {
  it('an overridden firstOffense.rude is used, and its siblings are kept', () => {
    const p = resolveProfile('relaxed', { firstOffense: { rude: { kind: 'chat', durationMs: 2 * H } } });
    expect(sug(p, [], 'rude')).toMatchObject({ outcome: { kind: 'chat', durationMs: 2 * H }, label: 'Restrict chat 2 hours' });
    expect(sug(p, [], 'hostile').outcome).toBe('warning');
    expect(sug(p, [], 'rude').why).toMatch(/^Relaxed profile: /);
  });

  it('a rude of "none" is not acted on', () => {
    const p = resolveProfile('relaxed', { firstOffense: { rude: 'none' } });
    expect(sug(p, [], 'rude')).toMatchObject({ outcome: 'none', label: 'No action' });
    expect(sug(p, [], 'rude').why).toContain('not acted on');
  });

  it('a custom name is the one cited', () => {
    const p = resolveProfile('relaxed', { name: 'Arena' });
    expect(sug(p, [], 'rude').why).toMatch(/^Arena profile: /);
  });

  it('a custom repeat rule: 3 notes in 7 days, any game, a 24 hour chat restriction', () => {
    const p = resolveProfile('relaxed', {
      repeat: { notes: 3, windowDays: 7, distinctGames: false, outcome: { kind: 'chat', durationMs: DAY } },
    });
    const two = [note({ startsAt: NOW - DAY }), note({ startsAt: NOW - 2 * DAY })];
    expect(sug(p, two, 'rude').outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(sug(p, [two[0] as ActionRecord], 'rude').outcome).toBe('note');
    expect(sug(p, [two[0] as ActionRecord, note({ startsAt: NOW - 8 * DAY })], 'rude').outcome).toBe('note');
  });

  it('a custom ladder cell keeps its own label while it is the answer', () => {
    const ladder = LADDER_TABLE.map((r) =>
      r.step === 1 ? { ...r, lowMedium: { kind: 'ban' as const, durationMs: 3 * DAY, label: 'Cool-off ban' } } : r,
    );
    const p = resolveProfile('relaxed', { ladder });
    expect(sug(p, [warn()], 'rude')).toMatchObject({ outcome: { kind: 'ban', durationMs: 3 * DAY }, label: 'Cool-off ban' });
  });

  it('a ladder cell weaker than the first offense does not lower it', () => {
    const p = resolveProfile('relaxed', { firstOffense: { rude: { kind: 'ban', durationMs: 7 * DAY } } });
    expect(sug(p, [warn()], 'rude').outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
  });
});

describe('suggest: areaRules and severeRules', () => {
  it('rules 5 and 6 turn a chat suggestion into a ban from public rooms of the same length', () => {
    for (const rule of [5, 6]) {
      const s = sug(RELAXED, AT_STEP[1], 'rude', rule, 'g');
      expect(s).toMatchObject({ outcome: { kind: 'area', durationMs: DAY }, label: 'Ban from public rooms 24 hours' });
      expect(s.why).toContain('public rooms');
      expect(sug(RELAXED, AT_STEP[1], 'hostile', rule)).toMatchObject({ outcome: { kind: 'area', durationMs: 7 * DAY } });
      expect(sug(RELAXED, [], 'severe', rule)).toMatchObject({ outcome: { kind: 'area', durationMs: 7 * DAY }, label: 'Ban from public rooms 7 days' });
    }
    expect(sug(RELAXED, AT_STEP[1], 'rude', 4, 'g').outcome).toEqual({ kind: 'chat', durationMs: DAY });
  });

  it('a warning, a note and a full ban are left alone', () => {
    expect(sug(RELAXED, [], 'rude', 5).outcome).toBe('note');
    expect(sug(RELAXED, [], 'hostile', 5).outcome).toBe('warning');
    expect(sug(RELAXED, AT_STEP[2], 'severe', 5).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
  });

  it('the swap reaches first-offense and repeat outcomes too', () => {
    expect(sug(STRICT, [], 'rude', 6)).toMatchObject({ outcome: { kind: 'area', durationMs: H }, label: 'Ban from public rooms 1 hour' });
    expect(sug(STANDARD, [note({ roomId: 'a' })], 'rude', 5, 'b').outcome).toEqual({ kind: 'area', durationMs: DAY });
  });

  it('areaRules override: only the listed rules swap', () => {
    const p = resolveProfile('relaxed', { areaRules: [7] });
    expect(sug(p, AT_STEP[1], 'rude', 5, 'g').outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(sug(p, AT_STEP[1], 'rude', 7, 'g').outcome).toEqual({ kind: 'area', durationMs: DAY });
    expect(sug(resolveProfile('relaxed', { areaRules: [] }), AT_STEP[1], 'rude', 5, 'g').outcome).toEqual({ kind: 'chat', durationMs: DAY });
  });

  it('a profile without areaRules or severeRules falls back to [5, 6] and [1]', () => {
    const bare = { ...RELAXED } as Partial<ModerationProfile>;
    delete bare.areaRules;
    delete bare.severeRules;
    const p = bare as ModerationProfile;
    expect(sug(p, AT_STEP[1], 'rude', 5, 'g').outcome).toEqual({ kind: 'area', durationMs: DAY });
    expect(sug(p, [], 'rude', 1).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('rule 1 reads the severe column whatever the level (default severeRules)', () => {
    expect(sug(RELAXED, [], 'rude', 1)).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY } });
    expect(sug(RELAXED, [], 'hostile', 1).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(sug(RELAXED, AT_STEP[1], 'rude', 1).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(sug(RELAXED, AT_STEP[2], 'rude', 1).outcome).toEqual({ kind: 'ban', durationMs: 7 * DAY });
    expect(sug(RELAXED, [], 'banter', 1).outcome).toBe('none');
  });

  it('severeRules override: [] switches rule 1 back to the plain reading, [3] adds rule 3', () => {
    expect(sug(resolveProfile('relaxed', { severeRules: [] }), [], 'rude', 1).outcome).toBe('note');
    const p = resolveProfile('relaxed', { severeRules: [3] });
    expect(sug(p, [], 'rude', 3).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(sug(p, [], 'rude', 1).outcome).toBe('note');
  });

  it('the uncovered rule is neither severe nor area', () => {
    expect(sug(RELAXED, AT_STEP[1], 'rude', 'uncovered', 'g').outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(sug(RELAXED, AT_STEP[1], 'hostile', 'uncovered').outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('a null level reads as hostile', () => {
    expect(sug(RELAXED, [], null).outcome).toBe('warning');
    expect(sug(RELAXED, AT_STEP[1], null).outcome).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    for (const step of [1, 2, 3, 4, 5] as const) {
      expect(sug(RELAXED, AT_STEP[step], null)).toEqual(sug(RELAXED, AT_STEP[step], 'hostile'));
    }
  });
});

describe('suggest: the "why" is plain, names the profile and carries no identifier', () => {
  it('every combination yields a non-empty single sentence naming the profile, with no room or id', () => {
    const records: ActionRecord[][] = [
      [],
      [note({ roomId: 'room-secret-77' })],
      [note({ roomId: 'room-secret-77' }), note({ roomId: 'room-secret-88' })],
      ...Object.values(AT_STEP),
    ];
    for (const p of [RELAXED, STANDARD, STRICT]) {
      for (const level of [...CONDUCT_LEVELS, null] as Array<ConductLevel | null>) {
        for (const rs of records) {
          for (const rule of [1, 2, 5, 'uncovered'] as RuleRef[]) {
            const s = sug(p, rs, level, rule, 'room-secret-99');
            expect(s.why.length).toBeGreaterThan(20);
            expect(s.label.length).toBeGreaterThan(0);
            expect(s.why.startsWith(`${p.name} profile: `)).toBe(true);
            expect(s.why.endsWith('.')).toBe(true);
            expect(s.why.slice(0, -1)).not.toContain('. ');
            for (const text of [s.why, s.label]) {
              expect(text).not.toContain('room-secret');
              expect(text).not.toMatch(/[0-9a-f]{16,}/);
            }
          }
        }
      }
    }
  });
});

describe('suggest: purity', () => {
  it('returns a fresh object each call, and editing it changes neither the profile nor the next answer', () => {
    const a = sug(STRICT, [], 'rude');
    (a.outcome as { durationMs: number | null }).durationMs = 1;
    a.label = 'x';
    expect(sug(STRICT, [], 'rude').outcome).toEqual({ kind: 'chat', durationMs: H });
    expect(STRICT.firstOffense.rude).toEqual({ kind: 'chat', durationMs: H });
  });

  it('does not change the records it is given', () => {
    const records = [note({ roomId: 'a' }), warn()];
    const snapshot = JSON.stringify(records);
    sug(RELAXED, records, 'rude', 5, 'b');
    expect(JSON.stringify(records)).toBe(snapshot);
  });
});
