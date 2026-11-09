import { describe, expect, it } from 'vitest';
import {
  actionStep,
  HISTORY_LOOKBACK_MS,
  historyOf,
  LADDER_TABLE,
  recordStep,
  suggestAction,
  type ActionRecord,
  type LadderCell,
} from '../src/ladder.js';
import { parseRuleRef } from '../src/rules.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, SanctionKind, SanctionRow, Severity } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

function rec(kind: SanctionKind, durationMs: number | null, over: Partial<ActionRecord> = {}): ActionRecord {
  return { kind, durationMs, startsAt: NOW - DAY, revoked: false, automated: false, ...over };
}
const warn = (over: Partial<ActionRecord> = {}) => rec('warning', 0, over);

describe('actionStep: kind and length to a step', () => {
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
      kind: 'chat', durationMs: 2 * H, startsAt: NOW - DAY, revoked: false, automated: true,
    });
    expect(byKind.get('ban')).toMatchObject({ durationMs: null, automated: false });
    expect(byKind.get('warning')).toMatchObject({ durationMs: 0, revoked: false });
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
// suggestAction
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

describe('suggestAction: the 12 ladder cells', () => {
  for (const [step, low, high] of CONTRACT) {
    it(`step ${step}, low severity (rule 2)`, () => {
      expect(asCell(suggestAction(step, 'low', 2))).toEqual(low);
    });
    it(`step ${step}, medium severity (rule 2)`, () => {
      expect(asCell(suggestAction(step, 'medium', 2))).toEqual(low);
    });
    it(`step ${step}, high severity (rule 2)`, () => {
      expect(asCell(suggestAction(step, 'high', 2))).toEqual(high);
    });
  }

  it("'none' is treated like 'low'", () => {
    for (const [step, low] of CONTRACT) expect(asCell(suggestAction(step, 'none', 2))).toEqual(low);
  });

  it('LADDER_TABLE holds the same 12 cells, for the Guide to render', () => {
    expect(LADDER_TABLE).toHaveLength(6);
    for (const [step, low, high] of CONTRACT) {
      const r = LADDER_TABLE[step];
      expect(r?.step).toBe(step);
      expect(asCell(r?.lowMedium as LadderCell)).toEqual(low);
      expect(asCell(r?.high as LadderCell)).toEqual(high);
    }
  });
});

describe('suggestAction: null severity defaults', () => {
  it('null is medium for an ordinary rule', () => {
    for (const [step, low] of CONTRACT) {
      for (const rule of [2, 3, 4, 7, 8, 'uncovered'] as const) {
        expect(asCell(suggestAction(step, null, rule))).toEqual(low);
      }
    }
  });

  it('null is high when the rule is 1', () => {
    for (const [step, , high] of CONTRACT) expect(asCell(suggestAction(step, null, 1))).toEqual(high);
  });

  it('CR 1 reads the high column whatever the severity (the contract: "High severity, or CR 1")', () => {
    const sev: Severity[] = ['high', 'medium', 'low', 'none'];
    for (const [step, , high] of CONTRACT) {
      for (const s of sev) expect(asCell(suggestAction(step, s, 1))).toEqual(high);
    }
  });
});

describe('suggestAction: rules 5 and 6 turn a chat suggestion into area', () => {
  it.each([5, 6])('rule %i: chat becomes area at the same length', (rule) => {
    const a = suggestAction(1, 'medium', rule);
    expect(a).toEqual({ kind: 'area', durationMs: DAY, label: 'Ban from public rooms 24 hours' });
    const b = suggestAction(2, 'low', rule);
    expect(b).toEqual({ kind: 'area', durationMs: 7 * DAY, label: 'Ban from public rooms 7 days' });
    const c = suggestAction(0, 'high', rule);
    expect(c).toEqual({ kind: 'area', durationMs: 7 * DAY, label: 'Ban from public rooms 7 days' });
  });

  it.each([5, 6])('rule %i: a warning and a full ban are left alone', (rule) => {
    expect(suggestAction(0, 'low', rule)).toEqual({ kind: 'warning', durationMs: null, label: 'Warning' });
    expect(suggestAction(3, 'low', rule)).toEqual({ kind: 'ban', durationMs: 7 * DAY, label: 'Full ban 7 days' });
    expect(suggestAction(5, 'high', rule).kind).toBe('ban');
  });

  it.each([1, 2, 3, 4, 7, 8, 9, 'uncovered'] as const)('rule %s does not swap', (rule) => {
    expect(suggestAction(1, 'medium', rule).kind).toBe('chat');
    expect(suggestAction(1, 'low', rule).kind).toBe('chat');
  });

  it('every area suggestion keeps the length of the chat cell it replaces', () => {
    for (const [step, low, high] of CONTRACT) {
      for (const [sev, cell] of [['low', low], ['high', high]] as const) {
        const swapped = suggestAction(step, sev, 5);
        expect(swapped.durationMs).toBe(cell[1]);
        expect(swapped.kind).toBe(cell[0] === 'chat' ? 'area' : cell[0]);
      }
    }
  });
});

describe('suggestAction: guards and purity', () => {
  it('rejects a step outside 0..5', () => {
    expect(() => suggestAction(6 as never, 'low', 2)).toThrow(RangeError);
    expect(() => suggestAction(-1 as never, 'low', 2)).toThrow(RangeError);
    expect(() => suggestAction(1.5 as never, 'low', 2)).toThrow(RangeError);
  });

  it('returns a fresh object each call, so a caller cannot edit the table', () => {
    const a = suggestAction(1, 'low', 2);
    (a as { durationMs: number | null }).durationMs = 1;
    expect(suggestAction(1, 'low', 2).durationMs).toBe(DAY);
  });
});

describe('end to end: history to suggestion', () => {
  it('a stored rule text goes through parseRuleRef; two warnings suggest 7 days of chat', () => {
    const step = recordStep([warn(), warn()]);
    expect(asCell(suggestAction(step, 'medium', parseRuleRef('2')))).toEqual(CHAT_7D);
    expect(suggestAction(step, null, parseRuleRef('5')).kind).toBe('area');
    expect(suggestAction(step, null, parseRuleRef('uncovered')).kind).toBe('chat');
  });
});
