import { describe, expect, it } from 'vitest';
import { AI_ACT_KINDS, AI_MAX_PREFILL_MS, stepWithinActCeilings } from '../../src/ai/ceilings.js';
import { reachOf } from '../../src/ai/reach.js';
import type { AiReach, ReachSuggest } from '../../src/ai/reach.js';
import { suggest } from '../../src/ladder.js';
import type { Suggestion } from '../../src/ladder.js';
import { PRESETS } from '../../src/profile.js';

// The reach preview (design 5.5, ruling 3): for one cell, what step the ladder would give for a clean record, one warning, a 24 hour restriction
// and a 7 day ban, and whether that step is inside what the AI may ever apply. Pure over an injected `suggest`: no store, no clock.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A one-line view of a reach entry: `warning`, `chat 24h`, `chat 168h`, `ban 168h`, `ban`, or `-` for no step; `*` when inside the ceilings. */
const show = (r: AiReach): string => {
  const s = r.step;
  const text = s === null ? '-' : s.durationMs === null ? s.kind : `${s.kind} ${s.durationMs / HOUR}h`;
  return `${text}${r.withinCeilings ? ' *' : ''}`;
};
const shown = (reach: AiReach[]): Record<string, string> => Object.fromEntries(reach.map((r) => [r.record, show(r)]));

describe('reach: the shipped presets', () => {
  // Design ruling 3, for the two levels `aiAutoAct` can ever list. The first offence is the `clean` column; every later row moves up the ladder.
  const TABLE: Array<[preset: 'relaxed' | 'standard' | 'strict', level: 'hostile' | 'severe', clean: string, oneWarning: string, chat24h: string, ban7d: string]> = [
    ['relaxed', 'hostile', 'warning *', 'chat 168h', 'ban 168h', 'ban'],
    ['relaxed', 'severe', 'chat 168h', 'chat 168h', 'ban 168h', 'ban'],
    ['standard', 'hostile', 'chat 24h *', 'chat 168h', 'ban 168h', 'ban'],
    ['standard', 'severe', 'chat 168h', 'chat 168h', 'ban 168h', 'ban'],
    ['strict', 'hostile', 'chat 24h *', 'chat 168h', 'ban 168h', 'ban'],
    ['strict', 'severe', 'ban 168h', 'ban 168h', 'ban 168h', 'ban'],
  ];

  it.each(TABLE)('reach: the %s preset at %s gives the steps listed in design ruling 3', (preset, level, clean, oneWarning, chat24h, ban7d) => {
    expect(shown(reachOf(PRESETS[preset], 3, level, suggest))).toEqual({ clean, oneWarning, chat24h, ban7d });
  });

  it('reach: the relaxed, standard and strict presets give the steps listed in design ruling 3 (a table; fails if a preset changes)', () => {
    for (const [preset, level, clean, oneWarning, chat24h, ban7d] of TABLE) {
      expect(shown(reachOf(PRESETS[preset], 3, level, suggest)), `${preset} ${level}`).toEqual({ clean, oneWarning, chat24h, ban7d });
    }
    // The presets' own `aiAutoAct` (code only): which of these cells are ever reachable.
    expect(PRESETS.relaxed.aiAutoAct).toEqual(['severe']);
    expect(PRESETS.standard.aiAutoAct).toEqual(['severe']);
    expect(PRESETS.strict.aiAutoAct).toEqual(['hostile', 'severe']);
  });

  it('only a clean record at hostile can be acted on, in any preset: level 3 is quiet on a default install', () => {
    const actable: string[] = [];
    for (const preset of ['relaxed', 'standard', 'strict'] as const) {
      for (const level of ['hostile', 'severe'] as const) {
        for (const r of reachOf(PRESETS[preset], 3, level, suggest)) if (r.withinCeilings) actable.push(`${preset}/${level}/${r.record}`);
      }
    }
    expect(actable).toEqual(['relaxed/hostile/clean', 'standard/hostile/clean', 'strict/hostile/clean']);
  });

  it('the four records come in a fixed order, always four, for any rule', () => {
    for (const rule of [1, 2, 9, 12]) {
      expect(reachOf(PRESETS.strict, rule, 'hostile', suggest).map((r) => r.record)).toEqual(['clean', 'oneWarning', 'chat24h', 'ban7d']);
    }
  });

  it('agrees with suggest itself for every rule (the ladder decides, the preview only asks)', () => {
    for (const rule of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const direct = suggest(PRESETS.standard, [], 'hostile', rule, 1_700_000_000_000);
      const first = reachOf(PRESETS.standard, rule, 'hostile', suggest)[0] as AiReach;
      expect(first.step?.label, `rule ${rule}`).toBe(direct.label);
    }
  });
});

describe('reach: the ceilings', () => {
  const outcomes: Array<[name: string, outcome: Suggestion['outcome'], within: boolean]> = [
    ['a warning', 'warning', true],
    ['a 24 h chat restriction', { kind: 'chat', durationMs: DAY }, true],
    ['a 1 h chat restriction', { kind: 'chat', durationMs: HOUR }, true],
    ['a 1 ms chat restriction', { kind: 'chat', durationMs: 1 }, true],
    ['24 h plus 1 ms', { kind: 'chat', durationMs: DAY + 1 }, false],
    ['a 7 day chat restriction', { kind: 'chat', durationMs: 7 * DAY }, false],
    ['a permanent chat restriction', { kind: 'chat', durationMs: null }, false],
    ['a ban', { kind: 'ban', durationMs: HOUR }, false],
    ['a permanent ban', { kind: 'ban', durationMs: null }, false],
    ['an area ban', { kind: 'area', durationMs: HOUR }, false],
    ['a note', 'note', false],
    ['none', 'none', false],
  ];

  it.each(outcomes)('reach: %s is %s within ceilings', (_name, outcome, within) => {
    const fake: ReachSuggest = () => ({ outcome, label: 'x', why: 'y' });
    const reach = reachOf(PRESETS.standard, 3, 'hostile', fake);
    expect(reach.every((r) => r.withinCeilings === within)).toBe(true);
    expect(reach.every((r) => (outcome === 'none' ? r.step === null : r.step !== null))).toBe(true);
  });

  it('reach: a ban, an area ban, 24 h plus 1 ms, a note and none are not within ceilings; a warning and a 24 h chat restriction are', () => {
    const within = (outcome: Suggestion['outcome']): boolean => (reachOf(PRESETS.standard, 3, 'hostile', () => ({ outcome, label: '', why: '' }))[0] as AiReach).withinCeilings;
    expect(within({ kind: 'ban', durationMs: DAY })).toBe(false);
    expect(within({ kind: 'area', durationMs: DAY })).toBe(false);
    expect(within({ kind: 'chat', durationMs: DAY + 1 })).toBe(false);
    expect(within('note')).toBe(false);
    expect(within('none')).toBe(false);
    expect(within('warning')).toBe(true);
    expect(within({ kind: 'chat', durationMs: DAY })).toBe(true);
  });

  it('stepWithinActCeilings: the same rule, on a bare step, and a step with a wrong shape is outside', () => {
    expect(stepWithinActCeilings({ kind: 'warning', durationMs: null })).toBe(true);
    expect(stepWithinActCeilings({ kind: 'chat', durationMs: AI_MAX_PREFILL_MS })).toBe(true);
    expect(stepWithinActCeilings({ kind: 'chat', durationMs: AI_MAX_PREFILL_MS + 1 })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'chat', durationMs: null })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'chat', durationMs: 0 })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'chat', durationMs: -1 })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'chat', durationMs: Number.NaN })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'warning', durationMs: HOUR })).toBe(false); // a warning has no length
    expect(stepWithinActCeilings({ kind: 'note', durationMs: null })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'ban', durationMs: null })).toBe(false);
    expect(stepWithinActCeilings({ kind: 'area', durationMs: HOUR })).toBe(false);
    expect(stepWithinActCeilings(null)).toBe(false);
    expect(stepWithinActCeilings({ kind: 'toString', durationMs: null } as never)).toBe(false);
    expect(stepWithinActCeilings({ kind: '__proto__', durationMs: null } as never)).toBe(false);
  });

  it('the kinds the AI may act with are a frozen list of warning and chat: never a note, never a ban', () => {
    expect([...AI_ACT_KINDS]).toEqual(['warning', 'chat']);
    expect(Object.isFrozen(AI_ACT_KINDS)).toBe(true);
  });
});

describe('reach: purity and shape', () => {
  it('asks suggest for the four sample records of the policy preview, the same rule and level, and nothing else', () => {
    const seen: Array<{ records: unknown; level: unknown; rule: unknown }> = [];
    const spy: ReachSuggest = (_profile, records, level, rule) => {
      seen.push({ records: records.map((r) => [r.kind, r.durationMs, r.revoked, r.automated]), level, rule });
      return { outcome: 'none', label: '', why: '' };
    };
    reachOf(PRESETS.standard, 5, 'severe', spy);
    expect(seen).toEqual([
      { records: [], level: 'severe', rule: 5 },
      { records: [['warning', null, false, false]], level: 'severe', rule: 5 },
      { records: [['chat', DAY, false, false]], level: 'severe', rule: 5 },
      { records: [['ban', 7 * DAY, false, false]], level: 'severe', rule: 5 },
    ]);
  });

  it('is the same answer every time and does not mutate the profile', () => {
    const before = JSON.stringify(PRESETS.strict);
    const a = reachOf(PRESETS.strict, 3, 'hostile', suggest);
    const b = reachOf(PRESETS.strict, 3, 'hostile', suggest);
    expect(b).toEqual(a);
    expect(a).not.toBe(b);
    expect(JSON.stringify(PRESETS.strict)).toBe(before);
  });

  it('a suggest that throws gives an entry with no step that is not within the ceilings, and never throws', () => {
    const boom: ReachSuggest = () => {
      throw new Error('boom');
    };
    const reach = reachOf(PRESETS.strict, 3, 'hostile', boom);
    expect(reach).toHaveLength(4);
    expect(reach.every((r) => r.step === null && !r.withinCeilings)).toBe(true);
  });

  it('carries only the record, the step (kind, length, label) and the verdict: no text of the why, no id', () => {
    const reach = reachOf(PRESETS.standard, 3, 'hostile', suggest);
    for (const r of reach) {
      expect(Object.keys(r).sort()).toEqual(['record', 'step', 'withinCeilings']);
      if (r.step !== null) expect(Object.keys(r.step).sort()).toEqual(['durationMs', 'kind', 'label']);
    }
  });
});
