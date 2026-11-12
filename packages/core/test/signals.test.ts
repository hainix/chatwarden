import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SIGNAL_KINDS,
  kindSpecOf,
  resolveSignals,
  SIGNAL_KIND_PATTERN,
  SIGNAL_KINDS_MAX,
  SIGNAL_WINDOW_DAYS_MAX,
} from '../src/signals.js';
import type { SignalSettings } from '../src/signals.js';
import { applyPolicyLayer, defineProfile, PRESETS, ProfileError, resolveProfile, validateProfile } from '../src/profile.js';
import type { ModerationProfile } from '../src/profile.js';
import { MemoryStore, withMemorySignals } from '@chatwarden/store-memory';
import { world as plainWorld } from './reportingWorld.js';
import type { Store } from '../src/types.js';

/** A kit over an in-memory store that keeps signals (a kit that declares kinds or feeds needs one). */
const world = (over: Parameters<typeof plainWorld>[0] = {}, store: Store = withMemorySignals(new MemoryStore())) => plainWorld(over, store);

// Signal declarations: the kinds a game declares, the guards, and the `signals` section of the profile.

const DAY = 86_400_000;

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

const kind = (over: Record<string, unknown> = {}) => ({ label: 'Muted by other players', polarity: 'negative', ...over });
const declare = (kinds: Record<string, unknown>): SignalSettings => ({ kinds } as SignalSettings);
const bad = (kinds: Record<string, unknown>) => failure(() => resolveSignals(declare(kinds)));

describe('constants', () => {
  it('has the spec values', () => {
    expect(SIGNAL_KIND_PATTERN.source).toBe('^[a-z][a-z0-9_]{0,39}$');
    expect(SIGNAL_KINDS_MAX).toBe(40);
    expect(SIGNAL_WINDOW_DAYS_MAX).toBe(90);
  });

  it('flood_triggered is the one built-in kind, negative, and frozen', () => {
    expect(Object.keys(BUILTIN_SIGNAL_KINDS)).toEqual(['flood_triggered']);
    expect(BUILTIN_SIGNAL_KINDS.flood_triggered.polarity).toBe('negative');
    expect(BUILTIN_SIGNAL_KINDS.flood_triggered.label.length).toBeGreaterThan(0);
    expect(Object.isFrozen(BUILTIN_SIGNAL_KINDS)).toBe(true);
    expect(Object.isFrozen(BUILTIN_SIGNAL_KINDS.flood_triggered)).toBe(true);
  });
});

describe('resolveSignals', () => {
  it('nothing given resolves to the built-in kind, default guards and no feeds', () => {
    const r = resolveSignals(undefined);
    expect(Object.keys(r.kinds)).toEqual(['flood_triggered']);
    expect(r.kinds.flood_triggered).toEqual({ ...BUILTIN_SIGNAL_KINDS.flood_triggered, weight: 1 });
    expect(r.guards).toEqual({ perByWindowMs: DAY, newAccount: null });
    expect(r.feeds).toEqual({});
    expect(resolveSignals({})).toEqual(r);
  });

  it('declared kinds are merged over the built-ins, weight defaults to 1', () => {
    const r = resolveSignals(declare({ muted_by_player: kind(), kicked_from_room: kind({ label: 'Kicked', weight: 2 }), commended: kind({ label: 'Commended', polarity: 'positive' }) }));
    expect(Object.keys(r.kinds).sort()).toEqual(['commended', 'flood_triggered', 'kicked_from_room', 'muted_by_player']);
    expect(r.kinds.muted_by_player).toEqual({ label: 'Muted by other players', polarity: 'negative', weight: 1 });
    expect(r.kinds.kicked_from_room?.weight).toBe(2);
    expect(r.kinds.commended?.polarity).toBe('positive');
  });

  it('is idempotent: a resolved value resolves to itself, and shares nothing with its input', () => {
    const input = declare({ muted_by_player: kind({ weight: 0.5 }) });
    const r = resolveSignals(input);
    expect(resolveSignals(r)).toEqual(r);
    expect(r.kinds.muted_by_player).not.toBe((input.kinds as Record<string, unknown>).muted_by_player);
  });

  it('a bad slug, a 0 or 61 character label, a label with markup, a polarity outside the two, a weight outside 0 to 10, 41 kinds: each refused with its path', () => {
    for (const id of ['Muted', '1abc', 'a-b', 'a b', '', 'x'.repeat(41), '_a', 'é', 'toString', '__proto__']) {
      expect(bad({ [id]: kind() }).path, JSON.stringify(id)).toBe('signals.kinds');
    }
    expect(bad({ x: kind({ label: '' }) }).path).toBe('signals.kinds.x.label');
    expect(bad({ x: kind({ label: 'y'.repeat(61) }) }).path).toBe('signals.kinds.x.label');
    for (const label of ['<b>bold</b>', 'a > b', 'two\nlines', 'tab\there', '   ', '\u0000x', 5, null, ['x']]) {
      expect(bad({ x: kind({ label }) }).path, JSON.stringify(label)).toBe('signals.kinds.x.label');
    }
    for (const polarity of ['neutral', 'Negative', '', 5, null, undefined]) {
      expect(bad({ x: kind({ polarity }) }).path, String(polarity)).toBe('signals.kinds.x.polarity');
    }
    for (const weight of [-0.1, 10.01, 11, Number.NaN, Number.POSITIVE_INFINITY, '1', null, true]) {
      expect(bad({ x: kind({ weight }) }).path, String(weight)).toBe('signals.kinds.x.weight');
    }
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 41; i += 1) many[`kind_${i}`] = kind();
    expect(bad(many).path).toBe('signals.kinds');
  });

  it('accepts the edges: a 1 and a 60 character label, weights 0 and 10 and 0.5, 40 kinds, a 40 character id', () => {
    expect(() => resolveSignals(declare({ x: kind({ label: 'y' }) }))).not.toThrow();
    expect(() => resolveSignals(declare({ x: kind({ label: 'y'.repeat(60) }) }))).not.toThrow();
    for (const weight of [0, 10, 0.5, 3.25]) expect(resolveSignals(declare({ x: kind({ weight }) })).kinds.x?.weight).toBe(weight);
    const forty: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) forty[`kind_${i}`] = kind();
    expect(() => resolveSignals(declare(forty))).not.toThrow();
    expect(() => resolveSignals(declare({ ['a' + 'b'.repeat(39)]: kind() }))).not.toThrow();
  });

  it('refuses a kind spec that is not an object, has an unknown key, or lacks a label or polarity', () => {
    expect(bad({ x: 5 }).path).toBe('signals.kinds.x');
    expect(bad({ x: null }).path).toBe('signals.kinds.x');
    expect(bad({ x: [] }).path).toBe('signals.kinds.x');
    expect(bad({ x: kind({ nope: 1 }) }).path).toBe('signals.kinds.x.nope');
    expect(bad({ x: { polarity: 'negative' } }).path).toBe('signals.kinds.x.label');
    expect(bad({ x: { label: 'L' } }).path).toBe('signals.kinds.x.polarity');
  });

  it('refuses kinds that are not a plain object, signals that are not an object, and unknown top-level keys', () => {
    for (const v of [5, 'x', null, [], true]) {
      expect(failure(() => resolveSignals({ kinds: v } as never)).path).toBe('signals.kinds');
      expect(failure(() => resolveSignals(v as never)).path, String(v)).toBe('signals');
    }
    expect(failure(() => resolveSignals({ nope: 1 } as never)).path).toBe('signals.nope');
  });

  it('redeclaring flood_triggered may relabel and re-weight but not make it positive', () => {
    const r = resolveSignals(declare({ flood_triggered: kind({ label: 'Spammed chat', weight: 3 }) }));
    expect(r.kinds.flood_triggered).toEqual({ label: 'Spammed chat', polarity: 'negative', weight: 3 });
    expect(Object.keys(r.kinds)).toEqual(['flood_triggered']);
    expect(bad({ flood_triggered: kind({ polarity: 'positive' }) }).path).toBe('signals.kinds.flood_triggered.polarity');
    // The built-in is untouched by anything a profile declares.
    expect(BUILTIN_SIGNAL_KINDS.flood_triggered.label).not.toBe('Spammed chat');
  });

  it('kinds named constructor, toString and __proto__ are accepted only when declared and never resolve from the prototype', () => {
    const none = resolveSignals(undefined);
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(kindSpecOf(none.kinds, id), id).toBeUndefined();
    }
    // `constructor` is a valid slug: declaring it works and resolves to the declared spec.
    const declared = resolveSignals(declare({ constructor: kind({ label: 'Ctor' }) }));
    expect(kindSpecOf(declared.kinds, 'constructor')).toEqual({ label: 'Ctor', polarity: 'negative', weight: 1 });
    expect(kindSpecOf(declared.kinds, 'toString')).toBeUndefined();
    // `toString` and `__proto__` are not slugs, so they cannot be declared, not even as an own key from parsed JSON.
    expect(bad({ toString: kind() }).path).toBe('signals.kinds');
    const parsed = JSON.parse('{"__proto__": {"label": "x", "polarity": "negative"}}') as Record<string, unknown>;
    expect(failure(() => resolveSignals({ kinds: parsed } as never)).path).toBe('signals.kinds');
    expect(kindSpecOf(declared.kinds, 'x'.repeat(5))).toBeUndefined();
  });

  it('kindSpecOf answers undefined for a non-string id', () => {
    const r = resolveSignals(undefined);
    for (const id of [5, null, undefined, {}, [], Symbol('x')]) expect(kindSpecOf(r.kinds, id as never)).toBeUndefined();
  });
});

describe('guards', () => {
  const g = (guards: unknown) => resolveSignals({ guards } as never).guards;
  const badGuard = (guards: unknown) => failure(() => resolveSignals({ guards } as never));

  it('defaults to a day and no new-account weighting', () => {
    expect(resolveSignals({}).guards).toEqual({ perByWindowMs: DAY, newAccount: null });
  });

  it('perByWindowMs: 60 000 to 30 days, whole numbers', () => {
    expect(g({ perByWindowMs: 60_000 }).perByWindowMs).toBe(60_000);
    expect(g({ perByWindowMs: 30 * DAY }).perByWindowMs).toBe(30 * DAY);
    for (const v of [59_999, 30 * DAY + 1, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3600000', null]) {
      expect(badGuard({ perByWindowMs: v }).path, String(v)).toBe('signals.guards.perByWindowMs');
    }
  });

  it('newAccount: belowDays 1 to 365 whole, factor above 0 and at most 1', () => {
    expect(g({ newAccount: { belowDays: 1, factor: 1 } }).newAccount).toEqual({ belowDays: 1, factor: 1 });
    expect(g({ newAccount: { belowDays: 365, factor: 0.25 } }).newAccount).toEqual({ belowDays: 365, factor: 0.25 });
    expect(g({ newAccount: null }).newAccount).toBeNull();
    for (const v of [0, 366, 1.5, -3, Number.NaN, '7', null]) {
      expect(badGuard({ newAccount: { belowDays: v, factor: 0.5 } }).path, String(v)).toBe('signals.guards.newAccount.belowDays');
    }
    for (const v of [0, -0.1, 1.01, 2, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      expect(badGuard({ newAccount: { belowDays: 7, factor: v } }).path, String(v)).toBe('signals.guards.newAccount.factor');
    }
    expect(badGuard({ newAccount: { belowDays: 7 } }).path).toBe('signals.guards.newAccount.factor');
    expect(badGuard({ newAccount: { factor: 0.5 } }).path).toBe('signals.guards.newAccount.belowDays');
    expect(badGuard({ newAccount: { belowDays: 7, factor: 0.5, nope: 1 } }).path).toBe('signals.guards.newAccount.nope');
    expect(badGuard({ newAccount: 5 }).path).toBe('signals.guards.newAccount');
  });

  it('refuses an unknown guard and a guards value that is not an object', () => {
    expect(badGuard({ nope: 1 }).path).toBe('signals.guards.nope');
    for (const v of [5, 'x', null, []]) expect(badGuard(v).path).toBe('signals.guards');
  });

  it('a refusal never echoes the value', () => {
    expect(badGuard({ perByWindowMs: 987654321.5 }).message).not.toContain('987654321');
    expect(bad({ x: kind({ label: '<script>zorbak</script>' }) }).message).not.toContain('zorbak');
    expect(bad({ x: kind({ weight: 98765.4321 }) }).message).not.toContain('98765');
  });
});

describe('the signals section of the profile', () => {
  it('presets ship signals unset: only the built-in kind, no feeds', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      const s = PRESETS[name].signals;
      expect(Object.keys(s.kinds)).toEqual(['flood_triggered']);
      expect(s.feeds).toEqual({});
      expect(s.guards).toEqual({ perByWindowMs: DAY, newAccount: null });
    }
  });

  it('a profile written without signals resolves to the defaults', () => {
    const { signals: _drop, ...without } = PRESETS.standard as ModerationProfile & { signals?: unknown };
    void _drop;
    expect(defineProfile(without as ModerationProfile).signals.feeds).toEqual({});
  });

  it('a code profile with signals resolves it, frozen, and the preset is untouched', () => {
    const p = resolveProfile('standard', {
      signals: {
        kinds: { muted_by_player: { label: 'Muted by other players', polarity: 'negative' } },
        feeds: { record: { kinds: '*', windowDays: 14 }, ladder: [{ id: 'muted-a-lot', kinds: ['muted_by_player'], minDistinct: 5, windowDays: 14, effect: 'note' }] },
      },
    });
    expect(Object.keys(p.signals.kinds).sort()).toEqual(['flood_triggered', 'muted_by_player']);
    expect(p.signals.feeds.record).toEqual({ kinds: '*', windowDays: 14 });
    expect(Object.isFrozen(p.signals)).toBe(true);
    expect(Object.isFrozen(p.signals.kinds.muted_by_player)).toBe(true);
    expect(Object.keys(PRESETS.standard.signals.kinds)).toEqual(['flood_triggered']);
  });

  it('a bad signals section in code names profile.signals...', () => {
    expect(failure(() => resolveProfile('standard', { signals: { kinds: { Bad: { label: 'x', polarity: 'negative' } } } })).path).toBe('profile.signals.kinds');
    expect(failure(() => resolveProfile('standard', { signals: { kinds: { x: { label: '', polarity: 'negative' } } } })).path).toBe('profile.signals.kinds.x.label');
    expect(failure(() => resolveProfile('standard', { signals: { feeds: { queue: { kinds: ['nope_kind'], minDistinct: 3, windowDays: 7 } } } })).path).toBe('profile.signals.feeds.queue.kinds[0]');
    expect(failure(() => resolveProfile('standard', { signals: 5 as never })).path).toBe('profile.signals');
  });

  it('a resolved profile passes validateProfile again', () => {
    const p = resolveProfile('strict', { signals: { kinds: { x: { label: 'X', polarity: 'positive' } }, feeds: { ai: { kinds: ['x'], windowDays: 30 } } } });
    expect(() => validateProfile(p)).not.toThrow();
    expect(defineProfile(p).signals).toEqual(p.signals);
  });

  it('is part of the overrides merge key by key (kinds add, guards merge)', () => {
    const coded = defineProfile({ ...PRESETS.standard, signals: { kinds: { a_kind: { label: 'A', polarity: 'negative' } }, guards: { perByWindowMs: 3_600_000 } } });
    const p = resolveProfile(coded, { signals: { kinds: { b_kind: { label: 'B', polarity: 'negative' } } } });
    expect(Object.keys(p.signals.kinds).sort()).toEqual(['a_kind', 'b_kind', 'flood_triggered']);
    expect(p.signals.guards.perByWindowMs).toBe(3_600_000);
  });

  it('policyJson and agentBrief carry nothing of it', async () => {
    const { cw } = await world({ overrides: { signals: { kinds: { muted_by_player: { label: 'Zorbak muted', polarity: 'negative' } } } } });
    expect(JSON.stringify(cw.documents.policyJson())).not.toContain('signals');
    expect(JSON.stringify(cw.documents.policyJson())).not.toContain('Zorbak muted');
    expect(cw.documents.agentBrief()).not.toContain('Zorbak muted');
    expect(cw.profile.signals.kinds.muted_by_player?.label).toBe('Zorbak muted');
  });

  it('a layer cannot declare a kind or a guard (they are code only)', () => {
    const base = PRESETS.standard;
    expect(failure(() => applyPolicyLayer(base, { signals: { kinds: { x: kind() } } } as never)).path).toBe('layer.signals.kinds');
    expect(failure(() => applyPolicyLayer(base, { signals: { guards: { perByWindowMs: 60_000 } } } as never)).path).toBe('layer.signals.guards');
    expect(failure(() => applyPolicyLayer(base, { signals: { nope: 1 } } as never)).path).toBe('layer.signals.nope');
  });
});
