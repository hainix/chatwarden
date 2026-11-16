import { describe, expect, it } from 'vitest';
import { AI_GATE_BANDS, AI_GATE_DEFAULTS, checkGateConfig, evaluateCell, wilsonLower, wilsonUpper } from '../../src/ai/gates.js';
import type { AiAppealFacts, AiCellCounts, AiGateCheck, AiGateConfig, AiGateName } from '../../src/ai/gates.js';

// The gates, pure (design 5, 6.3): numbers in, verdicts out. No store, no clock but `now`, no writer. These tests pin the maths at the boundaries
// (zero decisions, tiny samples, the Wilson bounds) and every number of the design's tables.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** A cell that passes every gate at the defaults: 200 qualifying, no misses, three deciders over 59 days, a clean recent month, nothing reviewed. */
const counts = (o: Partial<AiCellCounts> = {}): AiCellCounts => ({
  qualifying: 200,
  cleanAgree: 200,
  hardOverride: 0,
  reduced: 0,
  deciders: 3,
  firstAt: NOW - 60 * DAY,
  lastAt: NOW - DAY,
  recent: { n: 20, cleanAgree: 20 },
  reviewed: { n: 0, confirmed: 0, hardUndo: 0, lastHardUndoAt: null, secondLastHardUndoAt: null },
  ...o,
});
const appeals = (o: Partial<AiAppealFacts> = {}): AiAppealFacts => ({ available: true, ruleSanctions: 0, ruleRevokes: 0, ruleReduces: 0, actRevokeAt: null, ...o });

const check = (c: AiCellCounts, a: AiAppealFacts, name: AiGateName, cfg: AiGateConfig = AI_GATE_DEFAULTS, now = NOW): AiGateCheck => {
  const found = evaluateCell(c, a, cfg, now).checks.find((k) => k.name === name);
  if (found === undefined) throw new Error(`no check ${name}`);
  return found;
};
const okOf = (c: AiCellCounts, a: AiAppealFacts, name: AiGateName, cfg?: AiGateConfig, now?: number): boolean => check(c, a, name, cfg, now).ok;

describe('wilsonLower and wilsonUpper', () => {
  // [n, k, lower, upper]: computed once with an independent implementation, to six places.
  const REFERENCE: Array<[number, number, number, number]> = [
    [1, 0, 0, 0.793457],
    [1, 1, 0.206543, 1],
    [50, 0, 0, 0.07135],
    [50, 1, 0.003539, 0.104957],
    [50, 25, 0.366443, 0.633557],
    [50, 49, 0.895043, 0.996461],
    [50, 50, 0.92865, 1],
    [100, 0, 0, 0.036995],
    [100, 1, 0.001767, 0.054488],
    [100, 50, 0.40383, 0.59617],
    [100, 99, 0.945512, 0.998233],
    [100, 100, 0.963005, 1],
    [150, 0, 0, 0.024971],
    [150, 1, 0.001178, 0.036794],
    [150, 75, 0.420989, 0.579011],
    [150, 149, 0.963206, 0.998822],
    [150, 150, 0.975029, 1],
    [200, 0, 0, 0.018846],
    [200, 1, 0.000883, 0.027774],
    [200, 100, 0.43136, 0.56864],
    [200, 199, 0.972226, 0.999117],
    [200, 200, 0.981154, 1],
    [300, 0, 0, 0.012643],
    [300, 1, 0.000589, 0.018637],
    [300, 150, 0.443778, 0.556222],
    [300, 299, 0.981363, 0.999411],
    [300, 300, 0.987357, 1],
    [500, 0, 0, 0.007625],
    [500, 1, 0.000353, 0.011241],
    [500, 250, 0.45634, 0.54366],
    [500, 499, 0.988759, 0.999647],
    [500, 500, 0.992375, 1],
  ];

  it.each(REFERENCE)('n %i, k %i equals the reference values', (n, k, lower, upper) => {
    expect(wilsonLower(k, n)).toBeCloseTo(lower, 6);
    expect(wilsonUpper(k, n)).toBeCloseTo(upper, 6);
  });

  it('wilsonLower and wilsonUpper equal the reference values for n 0, 1, 50, 100, 150, 200, 300, 500 and k 0, 1, half, n-1, n (the table above covers each pair)', () => {
    const ns = new Set(REFERENCE.map(([n]) => n));
    expect([...ns].sort((a, b) => a - b)).toEqual([1, 50, 100, 150, 200, 300, 500]);
    for (const n of ns) {
      const ks = REFERENCE.filter(([m]) => m === n).map(([, k]) => k);
      expect(ks).toEqual(n === 1 ? [0, 1] : [0, 1, n / 2, n - 1, n]);
    }
  });

  it('n 0 gives lower 0 and upper 1', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonUpper(0, 0)).toBe(1);
  });

  it('always stays inside [0, 1], with lower <= k/n <= upper', () => {
    for (const n of [1, 2, 3, 7, 10, 33, 100, 1000, 100_000]) {
      for (const k of [0, 1, Math.floor(n / 3), Math.floor(n / 2), n - 1, n]) {
        if (k < 0 || k > n) continue;
        const lo = wilsonLower(k, n);
        const up = wilsonUpper(k, n);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(up).toBeLessThanOrEqual(1);
        expect(lo).toBeLessThanOrEqual(k / n + 1e-12);
        expect(up).toBeGreaterThanOrEqual(k / n - 1e-12);
      }
    }
  });

  it('is monotone: more successes raise the lower bound, a larger sample at the same rate tightens it', () => {
    expect(wilsonLower(96, 100)).toBeLessThan(wilsonLower(97, 100));
    expect(wilsonLower(48, 50)).toBeLessThan(wilsonLower(96, 100));
    expect(wilsonUpper(1, 100)).toBeGreaterThan(wilsonUpper(0, 100));
    expect(wilsonUpper(2, 200)).toBeLessThan(wilsonUpper(1, 100));
  });

  it('a different z moves the bound the right way', () => {
    expect(wilsonLower(90, 100, 1.645)).toBeGreaterThan(wilsonLower(90, 100));
    expect(wilsonUpper(5, 100, 2.576)).toBeGreaterThan(wilsonUpper(5, 100));
  });

  it('k above n or negative throws, and so does a fraction or a non-number', () => {
    for (const [k, n] of [
      [3, 2],
      [1, 0],
      [-1, 5],
      [1.5, 10],
      [Number.NaN, 10],
      [5, Number.NaN],
      [5, -1],
      [Number.POSITIVE_INFINITY, 10],
    ] as Array<[number, number]>) {
      expect(() => wilsonLower(k, n), `lower ${k}/${n}`).toThrow(RangeError);
      expect(() => wilsonUpper(k, n), `upper ${k}/${n}`).toThrow(RangeError);
    }
  });
});

// The design's table (5.2): the most misses G3 allows and the most hard overrides G4 allows, at each n. `null` means none can hold.
const TABLE: Array<[number, number | null, number | null]> = [
  [50, 0, null],
  [100, 4, 0],
  [150, 7, 2],
  [200, 11, 3],
  [300, 19, 7],
  [500, 36, 15],
];

describe('the design table of misses and hard overrides', () => {
  it("the design's max-misses and max-hard-overrides table is exactly what evaluateCell accepts and refuses", () => {
    for (const [n, maxMisses, maxOverrides] of TABLE) {
      if (maxMisses !== null) {
        expect(okOf(counts({ qualifying: n, cleanAgree: n - maxMisses, hardOverride: 0 }), appeals(), 'agreement'), `n ${n}: ${maxMisses} misses is allowed`).toBe(true);
        expect(okOf(counts({ qualifying: n, cleanAgree: n - maxMisses - 1, hardOverride: 0 }), appeals(), 'agreement'), `n ${n}: ${maxMisses + 1} misses is refused`).toBe(false);
      }
      if (maxOverrides !== null) {
        expect(okOf(counts({ qualifying: n, cleanAgree: n - maxOverrides, hardOverride: maxOverrides }), appeals(), 'override'), `n ${n}: ${maxOverrides} overrides is allowed`).toBe(true);
        expect(okOf(counts({ qualifying: n, cleanAgree: n - maxOverrides - 1, hardOverride: maxOverrides + 1 }), appeals(), 'override'), `n ${n}: ${maxOverrides + 1} overrides is refused`).toBe(false);
      } else {
        // 50 cases cannot hold the override bound at all: even zero overrides leaves a 7% upper bound.
        expect(okOf(counts({ qualifying: n, cleanAgree: n, hardOverride: 0 }), appeals(), 'override'), `n ${n}: nothing holds`).toBe(false);
      }
    }
  });

  it('loops every k: the accepted k are exactly those the Wilson bound allows (no gaps, no early failure)', () => {
    for (const [n, maxMisses, maxOverrides] of TABLE) {
      for (let miss = 0; miss <= Math.min(n, 60); miss += 1) {
        const expected = maxMisses !== null && miss <= maxMisses;
        expect(okOf(counts({ qualifying: n, cleanAgree: n - miss }), appeals(), 'agreement'), `n ${n} misses ${miss}`).toBe(expected);
        const expectedOverride = maxOverrides !== null && miss <= maxOverrides;
        expect(okOf(counts({ qualifying: n, cleanAgree: n - miss, hardOverride: miss }), appeals(), 'override'), `n ${n} overrides ${miss}`).toBe(expectedOverride);
      }
    }
  });
});

describe('volume', () => {
  it('99 fails, 100 passes', () => {
    expect(okOf(counts({ qualifying: 99, cleanAgree: 99 }), appeals(), 'volume')).toBe(false);
    expect(okOf(counts({ qualifying: 100, cleanAgree: 100 }), appeals(), 'volume')).toBe(true);
  });
  it('reports its value and a fixed need code', () => {
    expect(check(counts({ qualifying: 99, cleanAgree: 99 }), appeals(), 'volume')).toEqual({ name: 'volume', ok: false, value: 99, need: 'min:100' });
  });
  it('zero decisions fails everything that needs decisions, and never throws', () => {
    const z = counts({ qualifying: 0, cleanAgree: 0, deciders: 0, firstAt: null, lastAt: null, recent: { n: 0, cleanAgree: 0 } });
    const v = evaluateCell(z, appeals(), AI_GATE_DEFAULTS, NOW);
    expect(v.open).toBe(false);
    const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['volume', 'breadth', 'agreement', 'override', 'recency']);
  });
  it('a tiny sample (1 of 1) is not enough however clean', () => {
    const t = counts({ qualifying: 1, cleanAgree: 1, deciders: 1, firstAt: NOW, lastAt: NOW, recent: { n: 1, cleanAgree: 1 } });
    const v = evaluateCell(t, appeals(), AI_GATE_DEFAULTS, NOW);
    expect(v.open).toBe(false);
    expect(v.checks.find((c) => c.name === 'agreement')?.ok).toBe(false);
  });
});

describe('breadth', () => {
  it('one moderator fails, two pass', () => {
    expect(okOf(counts({ deciders: 1 }), appeals(), 'breadth')).toBe(false);
    expect(okOf(counts({ deciders: 2 }), appeals(), 'breadth')).toBe(true);
  });
  it('a span of 13 days fails and 14 passes (boundary on the exact millisecond)', () => {
    expect(okOf(counts({ firstAt: NOW - 14 * DAY, lastAt: NOW }), appeals(), 'breadth')).toBe(true);
    expect(okOf(counts({ firstAt: NOW - 14 * DAY + 1, lastAt: NOW }), appeals(), 'breadth')).toBe(false);
    expect(okOf(counts({ firstAt: NOW - 13 * DAY, lastAt: NOW }), appeals(), 'breadth')).toBe(false);
    expect(okOf(counts({ firstAt: NOW - 14 * DAY - 1, lastAt: NOW }), appeals(), 'breadth')).toBe(true);
  });
  it('no first or last decision is a failed span, and both parts must hold', () => {
    expect(okOf(counts({ firstAt: null, lastAt: null }), appeals(), 'breadth')).toBe(false);
    expect(okOf(counts({ deciders: 1, firstAt: NOW - 60 * DAY, lastAt: NOW }), appeals(), 'breadth')).toBe(false);
    expect(okOf(counts({ deciders: 5, firstAt: NOW, lastAt: NOW }), appeals(), 'breadth')).toBe(false);
  });
  it('a lone moderator may be allowed in code (band 1) and the span in code too (band 7 to 90 days)', () => {
    const cfg = checkGateConfig({ moderators: 1, spanDays: 7 });
    expect(okOf(counts({ deciders: 1, firstAt: NOW - 7 * DAY, lastAt: NOW }), appeals(), 'breadth', cfg)).toBe(true);
    expect(okOf(counts({ deciders: 1, firstAt: NOW - 7 * DAY + 1, lastAt: NOW }), appeals(), 'breadth', cfg)).toBe(false);
  });
});

describe('agreement and override', () => {
  it('are separate checks: a cell can pass one and fail the other', () => {
    // 100 qualifying, 4 misses, all four hard overrides: agreement holds (4 allowed), override fails (0 allowed).
    const c = counts({ qualifying: 100, cleanAgree: 96, hardOverride: 4 });
    expect(okOf(c, appeals(), 'agreement')).toBe(true);
    expect(okOf(c, appeals(), 'override')).toBe(false);
    // 100 qualifying, 5 misses none of them hard (a milder step): agreement fails, override holds.
    const d = counts({ qualifying: 100, cleanAgree: 95, hardOverride: 0 });
    expect(okOf(d, appeals(), 'agreement')).toBe(false);
    expect(okOf(d, appeals(), 'override')).toBe(true);
  });
  it('a reduced decision is neither a clean agree nor a hard override (it is a miss for agreement only)', () => {
    const c = counts({ qualifying: 100, cleanAgree: 96, hardOverride: 0, reduced: 4 });
    expect(okOf(c, appeals(), 'agreement')).toBe(true);
    expect(okOf(c, appeals(), 'override')).toBe(true);
    expect(okOf({ ...c, cleanAgree: 95 }, appeals(), 'agreement')).toBe(false);
  });
  it('reports the bounds as the value, rounded by nobody', () => {
    const c = counts({ qualifying: 100, cleanAgree: 96, hardOverride: 0 });
    expect(check(c, appeals(), 'agreement').value).toBeCloseTo(wilsonLower(96, 100), 12);
    expect(check(c, appeals(), 'agreement').need).toBe('lower>=0.90');
    expect(check(c, appeals(), 'override').value).toBeCloseTo(wilsonUpper(0, 100), 12);
    expect(check(c, appeals(), 'override').need).toBe('upper<=0.05');
  });
  it('the need codes follow a number moved inside its band', () => {
    const cfg = checkGateConfig({ agreementLower: 0.95, overrideUpper: 0.02, volume: 250 });
    expect(check(counts(), appeals(), 'agreement', cfg).need).toBe('lower>=0.95');
    expect(check(counts(), appeals(), 'override', cfg).need).toBe('upper<=0.02');
    expect(check(counts(), appeals(), 'volume', cfg).need).toBe('min:250');
  });
});

describe('recency', () => {
  it('4 recent decisions fails, 5 passes', () => {
    expect(okOf(counts({ recent: { n: 4, cleanAgree: 4 } }), appeals(), 'recency')).toBe(false);
    expect(okOf(counts({ recent: { n: 5, cleanAgree: 5 } }), appeals(), 'recency')).toBe(true);
  });
  it('recent rate 0.89 fails and 0.90 passes', () => {
    expect(okOf(counts({ recent: { n: 100, cleanAgree: 89 } }), appeals(), 'recency')).toBe(false);
    expect(okOf(counts({ recent: { n: 100, cleanAgree: 90 } }), appeals(), 'recency')).toBe(true);
    expect(okOf(counts({ recent: { n: 10, cleanAgree: 9 } }), appeals(), 'recency')).toBe(true);
    expect(okOf(counts({ recent: { n: 10, cleanAgree: 8 } }), appeals(), 'recency')).toBe(false);
  });
  it('zero recent decisions fails, with no value', () => {
    const c = counts({ recent: { n: 0, cleanAgree: 0 } });
    expect(check(c, appeals(), 'recency')).toMatchObject({ ok: false, value: null });
  });
  it('is the raw rate, not the Wilson bound (5 of 5 is a rate of 1)', () => {
    expect(check(counts({ recent: { n: 5, cleanAgree: 5 } }), appeals(), 'recency').value).toBe(1);
  });
});

describe('appeals', () => {
  it('available false fails both appeals checks, and the cell is closed', () => {
    const a = appeals({ available: false });
    expect(okOf(counts(), a, 'appeals_rule')).toBe(false);
    expect(okOf(counts(), a, 'appeals_acts')).toBe(false);
    expect(evaluateCell(counts(), a, AI_GATE_DEFAULTS, NOW).open).toBe(false);
  });
  it('a rule with 9 sanctions has no rate and passes; with 10 the rate counts', () => {
    expect(check(counts(), appeals({ ruleSanctions: 9, ruleRevokes: 9 }), 'appeals_rule')).toMatchObject({ ok: true, value: null });
    expect(okOf(counts(), appeals({ ruleSanctions: 10, ruleRevokes: 1 }), 'appeals_rule')).toBe(false);
    expect(okOf(counts(), appeals({ ruleSanctions: 10, ruleRevokes: 0 }), 'appeals_rule')).toBe(true);
  });
  it('10 sanctions with 0.05 fails and 0.049 passes (the bar is strictly below)', () => {
    expect(okOf(counts(), appeals({ ruleSanctions: 1000, ruleRevokes: 50 }), 'appeals_rule')).toBe(false);
    expect(okOf(counts(), appeals({ ruleSanctions: 1000, ruleRevokes: 49 }), 'appeals_rule')).toBe(true);
    expect(okOf(counts(), appeals({ ruleSanctions: 20, ruleRevokes: 1 }), 'appeals_rule')).toBe(false); // 0.05 exactly
    expect(okOf(counts(), appeals({ ruleSanctions: 21, ruleRevokes: 1 }), 'appeals_rule')).toBe(true); // 0.0476
    expect(check(counts(), appeals({ ruleSanctions: 1000, ruleRevokes: 49 }), 'appeals_rule')).toEqual({ name: 'appeals_rule', ok: true, value: 0.049, need: 'rate<0.05;min:10' });
  });
  it('reduces are shown apart and never count against the rule', () => {
    expect(okOf(counts(), appeals({ ruleSanctions: 100, ruleRevokes: 0, ruleReduces: 100 }), 'appeals_rule')).toBe(true);
  });
  it('an AI-act revoke 30 days minus 1 ms ago closes the cell and 30 days ago does not', () => {
    const recent = appeals({ actRevokeAt: NOW - 30 * DAY + 1 });
    expect(okOf(counts(), recent, 'appeals_acts')).toBe(false);
    const v = evaluateCell(counts(), recent, AI_GATE_DEFAULTS, NOW);
    expect(v.open).toBe(false);
    expect(v.coolingUntil).toBe(NOW + 1);
    expect(v.coolingCode).toBe('appeal_revoked');
    const old = appeals({ actRevokeAt: NOW - 30 * DAY });
    expect(okOf(counts(), old, 'appeals_acts')).toBe(true);
    const w = evaluateCell(counts(), old, AI_GATE_DEFAULTS, NOW);
    expect(w.open).toBe(true);
    expect(w.coolingUntil).toBeNull();
    expect(w.coolingCode).toBeNull();
  });
});

describe('need codes show the number as configured (review R1a M3)', () => {
  it('a value moved inside its band is not rounded across the cut', () => {
    const cfg = checkGateConfig({ agreementLower: 0.875, overrideUpper: 0.045, recentRate: 0.855, appealsRate: 0.015, keepLower: 0.025 });
    const needs = Object.fromEntries(evaluateCell(counts(), appeals(), cfg, NOW).checks.map((k) => [k.name, k.need]));
    expect(needs.agreement).toBe('lower>=0.875');
    expect(needs.override).toBe('upper<=0.045');
    expect(needs.recency).toBe('recent>=5;rate>=0.855');
    expect(needs.appeals_rule).toBe('rate<0.015;min:10');
    expect(needs.keep).toBe('lower<=0.025;pair>14d');
  });
  it('the defaults and round values keep two decimals, so the existing codes do not change', () => {
    const needs = Object.fromEntries(evaluateCell(counts(), appeals(), AI_GATE_DEFAULTS, NOW).checks.map((k) => [k.name, k.need]));
    expect(needs.agreement).toBe('lower>=0.90');
    expect(needs.override).toBe('upper<=0.05');
    expect(needs.recency).toBe('recent>=5;rate>=0.90');
    expect(check(counts(), appeals(), 'recency', checkGateConfig({ recentRate: 1 })).need).toBe('recent>=5;rate>=1.00');
    expect(check(counts(), appeals(), 'agreement', checkGateConfig({ agreementLower: 0.95 })).need).toBe('lower>=0.95');
  });
  it('the code and the check agree: a bound one step off the displayed number changes the verdict', () => {
    // 0.875 shown as 0.88 would have read as "need 0.88" while the check used 0.875
    const c = counts({ qualifying: 100, cleanAgree: 94, hardOverride: 1, recent: { n: 20, cleanAgree: 20 } });
    const lower = wilsonLower(94, 100);
    expect(lower).toBeGreaterThan(0.875);
    expect(lower).toBeLessThan(0.88);
    const cfg = checkGateConfig({ agreementLower: 0.875 });
    expect(check(c, appeals(), 'agreement', cfg)).toMatchObject({ ok: true, need: 'lower>=0.875' });
    expect(okOf(c, appeals(), 'agreement', checkGateConfig({ agreementLower: 0.88 }))).toBe(false);
  });
});

describe('keep', () => {
  const reviewed = (o: Partial<AiCellCounts['reviewed']>): AiCellCounts['reviewed'] => ({ n: 0, confirmed: 0, hardUndo: 0, lastHardUndoAt: null, secondLastHardUndoAt: null, ...o });

  it('fewer than 20 reviewed does not apply (it passes, with no value), even with undos', () => {
    const c = counts({ reviewed: reviewed({ n: 19, confirmed: 17, hardUndo: 2, lastHardUndoAt: NOW - 20 * DAY, secondLastHardUndoAt: NOW - 21 * DAY }) });
    expect(check(c, appeals(), 'keep')).toMatchObject({ ok: true, value: null });
  });
  it('20 reviewed with 2 hard undos within 14 days fails', () => {
    const c = counts({ reviewed: reviewed({ n: 20, confirmed: 18, hardUndo: 2, lastHardUndoAt: NOW - 20 * DAY, secondLastHardUndoAt: NOW - 25 * DAY }) });
    expect(okOf(c, appeals(), 'keep')).toBe(false);
    const big = counts({ reviewed: reviewed({ n: 500, confirmed: 498, hardUndo: 2, lastHardUndoAt: NOW - 20 * DAY, secondLastHardUndoAt: NOW - 25 * DAY }) });
    expect(okOf(big, appeals(), 'keep')).toBe(false); // the pair rule: 5 days apart
  });
  it('two undos 15 days apart pass the pair rule (and 13 days apart do not), at a sample where the bound holds', () => {
    const apart = (ms: number): AiCellCounts => counts({ reviewed: reviewed({ n: 500, confirmed: 498, hardUndo: 2, lastHardUndoAt: NOW - 20 * DAY, secondLastHardUndoAt: NOW - 20 * DAY - ms }) });
    expect(okOf(apart(15 * DAY), appeals(), 'keep')).toBe(true);
    expect(okOf(apart(14 * DAY), appeals(), 'keep')).toBe(true);
    expect(okOf(apart(14 * DAY - 1), appeals(), 'keep')).toBe(false);
    expect(okOf(apart(13 * DAY), appeals(), 'keep')).toBe(false);
    expect(okOf(apart(DAY), appeals(), 'keep')).toBe(false);
  });
  // Ruling (2026-11-16): G8 is a LOSS test. A licence is lost when the Wilson LOWER bound of the undo rate is above the cut (0.05): evidence of harm. An upper-bound
  // keep test cannot be met below 73 reviewed actions even with no undo, so every new licence would be pulled by construction.
  it('with no undo a cell keeps its licence at any size, from 20 reviewed up (the old upper-bound test failed 20 to 72)', () => {
    for (const n of [20, 21, 50, 72, 73, 100, 500, 5000]) {
      expect(okOf(counts({ reviewed: reviewed({ n, confirmed: n }) }), appeals(), 'keep'), `n=${n}`).toBe(true);
    }
    expect(check(counts({ reviewed: reviewed({ n: 20, confirmed: 20 }) }), appeals(), 'keep')).toMatchObject({ ok: true, value: 0, need: 'lower<=0.05;pair>14d' });
  });
  it('at n = 19 the gate does not apply even when every action was undone; at n = 20 it does', () => {
    const lots = (n: number): AiCellCounts => counts({ reviewed: reviewed({ n, confirmed: 0, hardUndo: n, lastHardUndoAt: NOW - 100 * DAY, secondLastHardUndoAt: NOW - 200 * DAY }) });
    expect(check(lots(19), appeals(), 'keep')).toMatchObject({ ok: true, value: null });
    expect(check(lots(20), appeals(), 'keep')).toMatchObject({ ok: false });
  });
  it('at n = 20 the smallest undo count whose lower bound crosses 0.05 is 3; at n = 100 it is 10', () => {
    const at = (n: number, k: number): AiCellCounts => counts({ reviewed: reviewed({ n, confirmed: n - k, hardUndo: k, lastHardUndoAt: NOW - 100 * DAY, secondLastHardUndoAt: k > 1 ? NOW - 200 * DAY : null }) });
    expect(wilsonLower(2, 20)).toBeLessThanOrEqual(0.05);
    expect(wilsonLower(3, 20)).toBeGreaterThan(0.05);
    expect(okOf(at(20, 0), appeals(), 'keep')).toBe(true);
    expect(okOf(at(20, 1), appeals(), 'keep')).toBe(true);
    expect(okOf(at(20, 2), appeals(), 'keep')).toBe(true);
    expect(okOf(at(20, 3), appeals(), 'keep')).toBe(false);
    expect(check(at(20, 3), appeals(), 'keep').value).toBeCloseTo(0.052368, 5);
    expect(wilsonLower(9, 100)).toBeLessThanOrEqual(0.05);
    expect(wilsonLower(10, 100)).toBeGreaterThan(0.05);
    expect(okOf(at(100, 9), appeals(), 'keep')).toBe(true);
    expect(okOf(at(100, 10), appeals(), 'keep')).toBe(false);
    // more undos never help
    for (let k = 3; k <= 20; k++) expect(okOf(at(20, k), appeals(), 'keep'), `k=${k}`).toBe(false);
  });
  it('exactly at the cut passes (the licence is lost only when the lower bound is above it); a hair below the cut fails', () => {
    const c = counts({ reviewed: reviewed({ n: 20, confirmed: 17, hardUndo: 3, lastHardUndoAt: NOW - 100 * DAY, secondLastHardUndoAt: NOW - 200 * DAY }) });
    const lower = wilsonLower(3, 20);
    expect(okOf(c, appeals(), 'keep', { ...AI_GATE_DEFAULTS, keepLower: lower })).toBe(true);
    expect(okOf(c, appeals(), 'keep', { ...AI_GATE_DEFAULTS, keepLower: lower - 1e-6 })).toBe(false);
    expect(okOf(c, appeals(), 'keep', { ...AI_GATE_DEFAULTS, keepLower: lower + 1e-6 })).toBe(true);
  });
  it('the cut can be moved inside its band, and the need code says so', () => {
    const c = counts({ reviewed: reviewed({ n: 20, confirmed: 17, hardUndo: 3, lastHardUndoAt: NOW - 100 * DAY, secondLastHardUndoAt: NOW - 200 * DAY }) });
    expect(okOf(c, appeals(), 'keep', checkGateConfig({ keepLower: 0.08 }))).toBe(true);
    expect(okOf(c, appeals(), 'keep', checkGateConfig({ keepLower: 0.01 }))).toBe(false);
    expect(check(c, appeals(), 'keep', checkGateConfig({ keepLower: 0.045 })).need).toBe('lower<=0.045;pair>14d');
  });
  it('a large cell with a few undos keeps its licence (500 reviewed: up to 34 undos; 35 lose it)', () => {
    const at = (k: number): AiCellCounts => counts({ reviewed: reviewed({ n: 500, confirmed: 500 - k, hardUndo: k, lastHardUndoAt: NOW - 100 * DAY }) });
    expect(wilsonLower(34, 500)).toBeLessThanOrEqual(0.05);
    expect(wilsonLower(35, 500)).toBeGreaterThan(0.05);
    expect(okOf(at(34), appeals(), 'keep')).toBe(true);
    expect(okOf(at(35), appeals(), 'keep')).toBe(false);
  });
  it('the pair rule still counts under the loss test: two undos within 14 days fail at any size', () => {
    const c = counts({ reviewed: reviewed({ n: 5000, confirmed: 4998, hardUndo: 2, lastHardUndoAt: NOW - 20 * DAY, secondLastHardUndoAt: NOW - 25 * DAY }) });
    expect(okOf(c, appeals(), 'keep')).toBe(false);
  });
  it('inconsistent counts (more undos than reviewed) fail closed', () => {
    const c = counts({ reviewed: reviewed({ n: 20, confirmed: 0, hardUndo: 25 }) });
    expect(okOf(c, appeals(), 'keep')).toBe(false);
  });
  it('a single undo has no pair', () => {
    const c = counts({ reviewed: reviewed({ n: 500, confirmed: 499, hardUndo: 1, lastHardUndoAt: NOW - 1 * DAY, secondLastHardUndoAt: null }) });
    expect(okOf(c, appeals(), 'keep')).toBe(true);
  });
});

describe('cooling', () => {
  const undo = (ago: number): AiCellCounts =>
    counts({ reviewed: { n: 500, confirmed: 499, hardUndo: 1, lastHardUndoAt: NOW - ago, secondLastHardUndoAt: null } });

  it('a hard undo 13 days ago sets coolingUntil, 14 days ago does not; the cooling code is reported', () => {
    const v = evaluateCell(undo(13 * DAY), appeals(), AI_GATE_DEFAULTS, NOW);
    expect(v.coolingUntil).toBe(NOW - 13 * DAY + 14 * DAY);
    expect(v.coolingCode).toBe('not_a_violation');
    expect(v.open).toBe(false);
    const edge = evaluateCell(undo(14 * DAY - 1), appeals(), AI_GATE_DEFAULTS, NOW);
    expect(edge.coolingUntil).toBe(NOW + 1);
    expect(edge.open).toBe(false);
    const gone = evaluateCell(undo(14 * DAY), appeals(), AI_GATE_DEFAULTS, NOW);
    expect(gone.coolingUntil).toBeNull();
    expect(gone.coolingCode).toBeNull();
    expect(gone.open).toBe(true);
  });
  it('the latch closes the cell although every check passes', () => {
    const v = evaluateCell(undo(1 * DAY), appeals(), AI_GATE_DEFAULTS, NOW);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.open).toBe(false);
  });
  it('with both latches the later end and its code are reported', () => {
    const c = undo(13 * DAY); // ends in 1 day
    const v = evaluateCell(c, appeals({ actRevokeAt: NOW - 5 * DAY }), AI_GATE_DEFAULTS, NOW); // ends in 25 days
    expect(v.coolingUntil).toBe(NOW + 25 * DAY);
    expect(v.coolingCode).toBe('appeal_revoked');
    const w = evaluateCell(undo(1 * DAY), appeals({ actRevokeAt: NOW - 29 * DAY - 12 * 3_600_000 }), AI_GATE_DEFAULTS, NOW); // 13 days vs 12 h
    expect(w.coolingCode).toBe('not_a_violation');
    expect(w.coolingUntil).toBe(NOW + 13 * DAY);
  });
  it('without appeals data no appeal latch can be known (the checks fail instead)', () => {
    const v = evaluateCell(counts(), appeals({ available: false, actRevokeAt: NOW - DAY }), AI_GATE_DEFAULTS, NOW);
    expect(v.coolingUntil).toBeNull();
    expect(v.open).toBe(false);
  });
});

describe('every check is returned, in order, and nothing short-circuits', () => {
  it('a cell failing everything still lists all eight checks', () => {
    const bad = counts({
      qualifying: 0,
      cleanAgree: 0,
      deciders: 0,
      firstAt: null,
      lastAt: null,
      recent: { n: 0, cleanAgree: 0 },
      reviewed: { n: 500, confirmed: 0, hardUndo: 500, lastHardUndoAt: NOW, secondLastHardUndoAt: NOW },
    });
    const v = evaluateCell(bad, appeals({ available: false }), AI_GATE_DEFAULTS, NOW);
    expect(v.checks.map((c) => c.name)).toEqual(['volume', 'breadth', 'agreement', 'override', 'recency', 'appeals_rule', 'appeals_acts', 'keep']);
    expect(v.checks.every((c) => !c.ok)).toBe(true);
    expect(v.open).toBe(false);
  });
  it('a clean cell passes all eight and is open', () => {
    const v = evaluateCell(counts(), appeals(), AI_GATE_DEFAULTS, NOW);
    expect(v.checks.map((c) => [c.name, c.ok])).toEqual([
      ['volume', true],
      ['breadth', true],
      ['agreement', true],
      ['override', true],
      ['recency', true],
      ['appeals_rule', true],
      ['appeals_acts', true],
      ['keep', true],
    ]);
    expect(v.open).toBe(true);
    expect(v.coolingUntil).toBeNull();
  });
  it('each need is a fixed code: it carries no free text and no number that came from outside', () => {
    const v = evaluateCell(counts({ qualifying: 7777, cleanAgree: 7000, deciders: 4242 }), appeals({ ruleSanctions: 99_999, ruleRevokes: 12_345 }), AI_GATE_DEFAULTS, NOW);
    for (const c of v.checks) expect(c.need).toMatch(/^[a-z_]+[<>=:]+[0-9.a-z;<>=:]*$/);
    expect(v.checks.map((c) => c.need)).toEqual(['min:100', 'deciders>=2;span>=14d', 'lower>=0.90', 'upper<=0.05', 'recent>=5;rate>=0.90', 'rate<0.05;min:10', 'none:30d', 'lower<=0.05;pair>14d']);
  });
  it('malformed counts (a clean agree above the qualifying, negatives, NaN) never throw and never open a cell', () => {
    for (const bad of [
      counts({ qualifying: 10, cleanAgree: 50 }),
      counts({ qualifying: -5, cleanAgree: -5 }),
      counts({ qualifying: Number.NaN, cleanAgree: Number.NaN }),
      counts({ hardOverride: 9999 }),
      counts({ recent: { n: 3, cleanAgree: 90 } }),
    ]) {
      expect(() => evaluateCell(bad, appeals(), AI_GATE_DEFAULTS, NOW)).not.toThrow();
      expect(evaluateCell(bad, appeals(), AI_GATE_DEFAULTS, NOW).open).toBe(false);
    }
  });
});

describe('the config', () => {
  const FIELDS = Object.keys(AI_GATE_DEFAULTS) as Array<keyof AiGateConfig>;

  it('defaults equal the design table (one assertion per number)', () => {
    expect(AI_GATE_DEFAULTS.windowDays).toBe(90);
    expect(AI_GATE_DEFAULTS.volume).toBe(100);
    expect(AI_GATE_DEFAULTS.moderators).toBe(2);
    expect(AI_GATE_DEFAULTS.spanDays).toBe(14);
    expect(AI_GATE_DEFAULTS.agreementLower).toBe(0.9);
    expect(AI_GATE_DEFAULTS.overrideUpper).toBe(0.05);
    expect(AI_GATE_DEFAULTS.recentCount).toBe(5);
    expect(AI_GATE_DEFAULTS.recentRate).toBe(0.9);
    expect(AI_GATE_DEFAULTS.appealsRate).toBe(0.05);
    expect(AI_GATE_DEFAULTS.reviewedMin).toBe(20);
    expect(AI_GATE_DEFAULTS.keepLower).toBe(0.05);
    expect(FIELDS.sort()).toEqual(['agreementLower', 'appealsRate', 'keepLower', 'moderators', 'overrideUpper', 'recentCount', 'recentRate', 'reviewedMin', 'spanDays', 'volume', 'windowDays']);
  });

  it('the bands are the design table (5.4)', () => {
    expect(AI_GATE_BANDS).toEqual({
      windowDays: { min: 30, max: 365 },
      volume: { min: 50, max: 1000 },
      moderators: { min: 1, max: 10 },
      spanDays: { min: 7, max: 90 },
      agreementLower: { min: 0.85, max: 0.99 },
      overrideUpper: { min: 0.01, max: 0.08 },
      recentCount: { min: 3, max: 50 },
      recentRate: { min: 0.85, max: 1 },
      appealsRate: { min: 0.01, max: 0.1 },
      reviewedMin: { min: 10, max: 200 },
      keepLower: { min: 0.01, max: 0.08 },
    });
  });

  it('defaults are inside their own bands, and are frozen', () => {
    for (const f of FIELDS) {
      expect(AI_GATE_DEFAULTS[f], f).toBeGreaterThanOrEqual(AI_GATE_BANDS[f].min);
      expect(AI_GATE_DEFAULTS[f], f).toBeLessThanOrEqual(AI_GATE_BANDS[f].max);
    }
    expect(Object.isFrozen(AI_GATE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(AI_GATE_BANDS)).toBe(true);
    expect(checkGateConfig({})).toEqual(AI_GATE_DEFAULTS);
    expect(checkGateConfig(undefined)).toEqual(AI_GATE_DEFAULTS);
  });

  it('a value on each band edge is accepted', () => {
    for (const f of FIELDS) {
      expect(checkGateConfig({ [f]: AI_GATE_BANDS[f].min })[f], `${f} min`).toBe(AI_GATE_BANDS[f].min);
      expect(checkGateConfig({ [f]: AI_GATE_BANDS[f].max })[f], `${f} max`).toBe(AI_GATE_BANDS[f].max);
    }
  });

  it('a config outside any band throws, naming only the field', () => {
    for (const f of FIELDS) {
      const { min, max } = AI_GATE_BANDS[f];
      const step = Number.isInteger(min) && Number.isInteger(max) ? 1 : 0.01;
      for (const v of [min - step, max + step, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -7]) {
        let error: unknown;
        try {
          checkGateConfig({ [f]: v });
        } catch (e) {
          error = e;
        }
        expect(error, `${f} = ${v}`).toBeInstanceOf(RangeError);
        const message = (error as Error).message;
        expect(message, `${f} = ${v}`).toContain(f);
        expect(message, `${f} = ${v} names no value and no band`).not.toMatch(/\d/);
      }
    }
  });

  it('a whole-number field refuses a fraction, and a non-number is refused', () => {
    for (const f of ['windowDays', 'volume', 'moderators', 'spanDays', 'recentCount', 'reviewedMin'] as const) {
      expect(() => checkGateConfig({ [f]: AI_GATE_BANDS[f].min + 0.5 }), f).toThrow(RangeError);
    }
    expect(() => checkGateConfig({ volume: '100' as unknown as number })).toThrow(/volume/);
    expect(() => checkGateConfig({ volume: null as unknown as number })).toThrow(/volume/);
  });

  it('an unknown field is refused by name (a typo must not silently keep a default)', () => {
    expect(() => checkGateConfig({ volumee: 10 } as unknown as Partial<AiGateConfig>)).toThrow(/volumee/);
  });

  it('merges onto the defaults and leaves the input untouched', () => {
    const input = Object.freeze({ volume: 300 });
    const cfg = checkGateConfig(input);
    expect(cfg.volume).toBe(300);
    expect(cfg.spanDays).toBe(14);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(input).toEqual({ volume: 300 });
  });

  it('an undefined field is the default; an inherited field is not read', () => {
    expect(checkGateConfig({ volume: undefined }).volume).toBe(100);
    const proto = Object.create({ volume: 9999 }) as Partial<AiGateConfig>;
    expect(checkGateConfig(proto).volume).toBe(100);
  });

  it('a number moved in its band moves the verdict (and only that one)', () => {
    const c = counts({ qualifying: 60, cleanAgree: 60 });
    expect(okOf(c, appeals(), 'volume')).toBe(false);
    expect(okOf(c, appeals(), 'volume', checkGateConfig({ volume: 50 }))).toBe(true);
    expect(okOf(counts({ recent: { n: 3, cleanAgree: 3 } }), appeals(), 'recency', checkGateConfig({ recentCount: 3 }))).toBe(true);
    expect(okOf(counts({ recent: { n: 100, cleanAgree: 86 } }), appeals(), 'recency', checkGateConfig({ recentRate: 0.85 }))).toBe(true);
    expect(okOf(counts({ qualifying: 1000, cleanAgree: 965 }), appeals(), 'agreement', checkGateConfig({ agreementLower: 0.95 }))).toBe(true);
    expect(okOf(counts({ qualifying: 200, cleanAgree: 195, hardOverride: 5 }), appeals(), 'override', checkGateConfig({ overrideUpper: 0.08 }))).toBe(true);
    expect(okOf(counts(), appeals({ ruleSanctions: 100, ruleRevokes: 9 }), 'appeals_rule', checkGateConfig({ appealsRate: 0.1 }))).toBe(true);
    expect(okOf(counts({ reviewed: { n: 10, confirmed: 10, hardUndo: 0, lastHardUndoAt: null, secondLastHardUndoAt: null } }), appeals(), 'keep', checkGateConfig({ reviewedMin: 200 }))).toBe(true);
  });
});

describe('evaluateCell is pure', () => {
  it('the same input gives the same output and nothing is mutated (frozen inputs)', () => {
    const deep = <T extends object>(o: T): T => {
      for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) deep(v);
      return Object.freeze(o);
    };
    const c = deep(counts({ reviewed: { n: 500, confirmed: 498, hardUndo: 2, lastHardUndoAt: NOW - 20 * DAY, secondLastHardUndoAt: NOW - 25 * DAY } }));
    const a = deep(appeals({ ruleSanctions: 50, ruleRevokes: 1, actRevokeAt: NOW - 40 * DAY }));
    const cfg = deep({ ...AI_GATE_DEFAULTS });
    const snapshot = JSON.stringify([c, a, cfg]);
    const first = evaluateCell(c, a, cfg, NOW);
    const second = evaluateCell(c, a, cfg, NOW);
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(JSON.stringify([c, a, cfg])).toBe(snapshot);
  });
  it('the result shares nothing with the input (changing it later cannot change the counts)', () => {
    const c = counts();
    const v = evaluateCell(c, appeals(), AI_GATE_DEFAULTS, NOW);
    v.checks.length = 0;
    expect(evaluateCell(c, appeals(), AI_GATE_DEFAULTS, NOW).checks).toHaveLength(8);
  });
  it('`now` is the only clock: the same counts at a later now cool down', () => {
    const c = counts({ reviewed: { n: 500, confirmed: 499, hardUndo: 1, lastHardUndoAt: NOW, secondLastHardUndoAt: null } });
    expect(evaluateCell(c, appeals(), AI_GATE_DEFAULTS, NOW + 13 * DAY).open).toBe(false);
    expect(evaluateCell(c, appeals(), AI_GATE_DEFAULTS, NOW + 14 * DAY).open).toBe(true);
  });
});
