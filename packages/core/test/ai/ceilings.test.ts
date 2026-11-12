import { describe, expect, it } from 'vitest';
import { AI_MAX_KIND, AI_MAX_PREFILL_MS, assertWithinCeilings, automationAllowed } from '../../src/ai/ceilings.js';

const HOUR = 3_600_000;
const own = { cited: ['L1', 'L2'], ownRefs: new Set(['L2']) };
const none = { cited: ['L1'], ownRefs: new Set<string>() };

describe('AI ceilings', () => {
  it('has the exact constants', () => {
    expect(AI_MAX_PREFILL_MS).toBe(24 * HOUR);
    expect(AI_MAX_PREFILL_MS).toBe(86_400_000);
    expect([...AI_MAX_KIND].sort()).toEqual(['chat', 'note', 'warning']);
  });

  it('assertWithinCeilings refuses a ban, an area ban, 25 hours, no own line', () => {
    expect(() => assertWithinCeilings({ kind: 'ban', durationMs: null }, own)).toThrow(/kind/);
    expect(() => assertWithinCeilings({ kind: 'ban', durationMs: HOUR }, own)).toThrow(/kind/);
    expect(() => assertWithinCeilings({ kind: 'area', durationMs: HOUR }, own)).toThrow(/kind/);
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: 25 * HOUR }, own)).toThrow(/duration/);
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: AI_MAX_PREFILL_MS + 1 }, own)).toThrow(/duration/);
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: null }, own)).toThrow(/duration/);
    expect(() => assertWithinCeilings({ kind: 'warning', durationMs: null }, none)).toThrow(/evidence/);
    expect(() => assertWithinCeilings({ kind: 'note', durationMs: null }, none)).toThrow(/evidence/);
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: HOUR }, { cited: [], ownRefs: new Set(['L2']) })).toThrow(/evidence/);
  });

  it('accepts a warning, a note, a 24 hour chat restriction', () => {
    expect(() => assertWithinCeilings({ kind: 'warning', durationMs: null }, own)).not.toThrow();
    expect(() => assertWithinCeilings({ kind: 'note', durationMs: null }, own)).not.toThrow();
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: AI_MAX_PREFILL_MS }, own)).not.toThrow();
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: 30 * 60_000 }, own)).not.toThrow();
  });

  it('refuses a malformed duration', () => {
    for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertWithinCeilings({ kind: 'chat', durationMs: d }, own)).toThrow(/duration/);
    }
  });

  it('refuses an unknown kind', () => {
    expect(() => assertWithinCeilings({ kind: 'mystery' as never, durationMs: null }, own)).toThrow(/kind/);
  });

  it('throws a typed error with a fixed code', () => {
    try {
      assertWithinCeilings({ kind: 'ban', durationMs: null }, own);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('ceiling_kind');
      expect((e as Error).name).toBe('AICeilingError');
    }
    try {
      assertWithinCeilings({ kind: 'chat', durationMs: 25 * HOUR }, own);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('ceiling_duration');
    }
    try {
      assertWithinCeilings({ kind: 'warning', durationMs: null }, none);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('ceiling_evidence');
    }
  });

  it('counts only cited refs that are really by the reported person', () => {
    // A ref cited but not in ownRefs does not count; an own ref that was not cited does not count.
    expect(() => assertWithinCeilings({ kind: 'warning', durationMs: null }, { cited: ['L1'], ownRefs: new Set(['L2']) })).toThrow(/evidence/);
    expect(() => assertWithinCeilings({ kind: 'warning', durationMs: null }, { cited: ['L2', 'L9'], ownRefs: new Set(['L2']) })).not.toThrow();
  });

  it('automationAllowed is true for any person', () => {
    expect(automationAllowed('anyone')).toBe(true);
  });
});
