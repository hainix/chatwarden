import { describe, expect, it } from 'vitest';
import { ACT_WORD, AI_SHADOW_DAYS_BAND, AI_SHADOW_DAYS_DEFAULT, planActing } from '../../src/ai/acting.js';
import type { ActingContext, AiActingRow } from '../../src/ai/acting.js';

// The acting state machine (design 3, rulings 1, 12, 13 and 16; 6.3): pure transitions. Every refusal has its own code, and the code decides: the
// facade only gathers the facts (`ActingContext`) and writes the row, and the route checks who may ask.

const T = 1_800_000_000_000;
const DAY = 86_400_000;
const OFF: AiActingRow = { mode: 'off', modeSince: null, modeBy: null, paused: false, pausedSince: null, pausedBy: null };
const SHADOW: AiActingRow = { ...OFF, mode: 'shadow', modeSince: T - 14 * DAY, modeBy: 'owner_ann' };
const ON: AiActingRow = { ...OFF, mode: 'on', modeSince: T - DAY, modeBy: 'owner_ann' };
const ctx = (over: Partial<ActingContext> = {}): ActingContext => ({
  now: T,
  level: 2,
  maxLevel: 3,
  actEnabled: true,
  adapter: true,
  storeSupported: true,
  appealsEnabled: true,
  shadowDays: 14,
  ...over,
});
const input = (over: Record<string, unknown> = {}) => ({ actor: 'owner_ann', confirm: 'ACT', reason: 'we are ready', ...over });

describe('off to shadow', () => {
  it('needs level 2, maxLevel 3 or more, an adapter, appeals enabled, the word ACT and a reason; with all of them it moves', () => {
    const r = planActing('shadow', OFF, input(), ctx());
    expect(r).toEqual({ ok: true, next: { ...OFF, mode: 'shadow', modeSince: T, modeBy: 'owner_ann' } });
  });

  it('refuses a level below 2 as not_allowed (level 0 and level 1)', () => {
    for (const level of [0, 1]) expect(planActing('shadow', OFF, input(), ctx({ level })), String(level)).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('refuses maxLevel 2 (and 1) as unsupported', () => {
    for (const maxLevel of [1, 2]) expect(planActing('shadow', OFF, input(), ctx({ maxLevel })), String(maxLevel)).toEqual({ ok: false, error: 'unsupported' });
    for (const maxLevel of [3, 4]) expect(planActing('shadow', OFF, input(), ctx({ maxLevel })).ok, String(maxLevel)).toBe(true);
  });

  it('refuses without an adapter, with act.enabled false and with a store that cannot keep the state as unsupported', () => {
    expect(planActing('shadow', OFF, input(), ctx({ adapter: false }))).toEqual({ ok: false, error: 'unsupported' });
    expect(planActing('shadow', OFF, input(), ctx({ actEnabled: false }))).toEqual({ ok: false, error: 'unsupported' });
    expect(planActing('shadow', OFF, input(), ctx({ storeSupported: false }))).toEqual({ ok: false, error: 'unsupported' });
  });

  it('refuses without enabled appeals as no_appeals', () => {
    expect(planActing('shadow', OFF, input(), ctx({ appealsEnabled: false }))).toEqual({ ok: false, error: 'no_appeals' });
  });

  it('refuses any word but ACT as invalid, in every other case too', () => {
    for (const confirm of ['act', 'Act', 'aCT', 'ACT ', ' ACT', 'ACTS', 'ACT\n', '', 'UNDO', undefined, null, 1, true, ['ACT'], { toString: () => 'ACT' }]) {
      expect(planActing('shadow', OFF, input({ confirm }), ctx()), String(confirm)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(ACT_WORD).toBe('ACT');
  });

  it('refuses a missing, empty, blank, too long or non-string reason as invalid', () => {
    for (const reason of [undefined, null, '', '   ', '\n\t', 3, {}, 'x'.repeat(2001)]) {
      expect(planActing('shadow', OFF, input({ reason }), ctx()), String(reason).slice(0, 5)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(planActing('shadow', OFF, input({ reason: 'x'.repeat(2000) }), ctx()).ok).toBe(true);
  });

  it('refuses an actor the audit trail cannot hold as invalid', () => {
    for (const actor of ['', ' ', 'two words', 'a'.repeat(129), undefined, 7, null]) {
      expect(planActing('shadow', OFF, input({ actor }), ctx()), String(actor)).toEqual({ ok: false, error: 'invalid' });
    }
  });

  it('a second shadow is wrong_state; trims the reason it stores nowhere (the row has no reason)', () => {
    expect(planActing('shadow', SHADOW, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
  });
});

describe('shadow to on', () => {
  it('needs shadowDays elapsed: 13 days refuses as too_early, 14 allows', () => {
    const at = (days: number): AiActingRow => ({ ...SHADOW, modeSince: T - days * DAY });
    expect(planActing('start', at(13), input(), ctx())).toEqual({ ok: false, error: 'too_early' });
    expect(planActing('start', { ...SHADOW, modeSince: T - 14 * DAY + 1 }, input(), ctx())).toEqual({ ok: false, error: 'too_early' });
    expect(planActing('start', at(14), input(), ctx())).toEqual({ ok: true, next: { ...OFF, mode: 'on', modeSince: T, modeBy: 'owner_ann' } });
    expect(planActing('start', at(40), input(), ctx()).ok).toBe(true);
  });

  it('follows the configured shadowDays inside the band, in both directions', () => {
    const row = (days: number): AiActingRow => ({ ...SHADOW, modeSince: T - days * DAY });
    expect(planActing('start', row(6), input(), ctx({ shadowDays: 7 }))).toEqual({ ok: false, error: 'too_early' });
    expect(planActing('start', row(7), input(), ctx({ shadowDays: 7 })).ok).toBe(true);
    expect(planActing('start', row(59), input(), ctx({ shadowDays: 60 }))).toEqual({ ok: false, error: 'too_early' });
    expect(planActing('start', row(60), input(), ctx({ shadowDays: 60 })).ok).toBe(true);
    expect(AI_SHADOW_DAYS_DEFAULT).toBe(14);
    expect(AI_SHADOW_DAYS_BAND).toEqual({ min: 7, max: 60 });
  });

  it('needs the word ACT and a reason, and the same prerequisites as shadow (a refusal each)', () => {
    expect(planActing('start', SHADOW, input({ confirm: 'act' }), ctx())).toEqual({ ok: false, error: 'invalid' });
    expect(planActing('start', SHADOW, input({ reason: ' ' }), ctx())).toEqual({ ok: false, error: 'invalid' });
    expect(planActing('start', SHADOW, input(), ctx({ appealsEnabled: false }))).toEqual({ ok: false, error: 'no_appeals' });
    expect(planActing('start', SHADOW, input(), ctx({ level: 1 }))).toEqual({ ok: false, error: 'not_allowed' });
    expect(planActing('start', SHADOW, input(), ctx({ maxLevel: 2 }))).toEqual({ ok: false, error: 'unsupported' });
    expect(planActing('start', SHADOW, input(), ctx({ actEnabled: false }))).toEqual({ ok: false, error: 'unsupported' });
  });

  it('is wrong_state from off and from on', () => {
    expect(planActing('start', OFF, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
    expect(planActing('start', ON, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
  });
});

describe('on to shadow, on to off, shadow to off (the owner lowers what it raised)', () => {
  it('on to shadow starts the shadow period again, with a reason and no word', () => {
    expect(planActing('shadow', ON, input({ confirm: undefined }), ctx())).toEqual({ ok: true, next: { ...OFF, mode: 'shadow', modeSince: T, modeBy: 'owner_ann' } });
  });

  it('on to off, shadow to off: a reason, no word, no prerequisite (code and appeals may be gone by now)', () => {
    const gone = ctx({ level: 0, maxLevel: 2, actEnabled: false, adapter: false, appealsEnabled: false });
    for (const row of [ON, SHADOW]) {
      expect(planActing('off', row, input({ confirm: undefined }), gone), row.mode).toEqual({ ok: true, next: { ...OFF, modeSince: T, modeBy: 'owner_ann' } });
    }
    expect(planActing('off', ON, input({ confirm: undefined, reason: '' }), ctx())).toEqual({ ok: false, error: 'invalid' });
  });

  it('off clears a pause; off from off is wrong_state', () => {
    expect(planActing('off', { ...ON, paused: true, pausedSince: T - 5, pausedBy: 'sen_ann' }, input(), ctx())).toEqual({ ok: true, next: { ...OFF, modeSince: T, modeBy: 'owner_ann' } });
    expect(planActing('off', OFF, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('on to shadow keeps a pause (the owner resumes it on purpose)', () => {
    const paused = { ...ON, paused: true, pausedSince: T - 5, pausedBy: 'sen_ann' };
    expect(planActing('shadow', paused, input(), ctx())).toEqual({ ok: true, next: { ...paused, mode: 'shadow', modeSince: T, modeBy: 'owner_ann' } });
  });
});

describe('pause and resume', () => {
  it('pause: from shadow or on, a reason, no word, no prerequisite; the pause is written with who and when and the mode is untouched', () => {
    for (const row of [SHADOW, ON]) {
      expect(planActing('pause', row, input({ confirm: undefined, actor: 'sen_ann' }), ctx({ appealsEnabled: false })), row.mode).toEqual({
        ok: true,
        next: { ...row, paused: true, pausedSince: T, pausedBy: 'sen_ann' },
      });
    }
  });

  it('pause is wrong_state when off and when already paused; it needs a reason', () => {
    expect(planActing('pause', OFF, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
    expect(planActing('pause', { ...ON, paused: true, pausedSince: 1, pausedBy: 's' }, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
    expect(planActing('pause', ON, input({ reason: '' }), ctx())).toEqual({ ok: false, error: 'invalid' });
  });

  it('resume: only from a pause, clears who and when, mode untouched', () => {
    const paused = { ...ON, paused: true, pausedSince: T - 5, pausedBy: 'sen_ann' };
    expect(planActing('resume', paused, input(), ctx())).toEqual({ ok: true, next: ON });
    expect(planActing('resume', ON, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
    expect(planActing('resume', OFF, input(), ctx())).toEqual({ ok: false, error: 'wrong_state' });
    expect(planActing('resume', paused, input({ reason: '' }), ctx())).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('purity', () => {
  it('does not change the row it is given, and an unknown action is invalid', () => {
    const row = Object.freeze({ ...SHADOW });
    expect(() => planActing('off', row, input(), ctx())).not.toThrow();
    expect(planActing('detonate' as never, row, input(), ctx())).toEqual({ ok: false, error: 'invalid' });
    expect(planActing('shadow', row, null as never, ctx())).toEqual({ ok: false, error: 'invalid' });
  });
});
