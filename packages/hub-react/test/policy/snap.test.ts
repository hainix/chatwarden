import { describe, expect, it } from 'vitest';
import { resolveLength } from '../../src/policy/length.js';
import { snapLength } from '../../src/policy/lengths.js';

// A form starts on 24 hours, which the profile may not list. `snapLength` moves the field to a length that is offered, and never
// to a destructive default: with nothing to pick, the field is left unset (and says so), or asks for a typed number.

const H = 3_600_000;
const D = 24 * H;
const menu = (durations: number[], permanent: boolean, custom: boolean) => ({ durations, permanent, custom });

describe('snapLength: the value kept, or the nearest offered length', () => {
  it('keeps a length that is offered, in either spelling', () => {
    expect(snapLength('24h', menu([H, D], true, true))).toBe('24h');
    expect(snapLength(String(6 * H), menu([H, 6 * H], true, false))).toBe(String(6 * H));
  });
  it('keeps permanent when it is offered, and custom when it is allowed', () => {
    expect(snapLength('permanent', menu([H], true, false))).toBe('permanent');
    expect(snapLength('custom', menu([H], false, true))).toBe('custom');
  });
  it('a list without a match goes to the length nearest a day', () => {
    expect(snapLength('24h', menu([3 * D, 7 * D], true, true))).toBe(String(3 * D));
    expect(snapLength('24h', menu([H, 6 * H], false, false))).toBe(String(6 * H));
  });
  it('a permanent the role may not give, or a custom the profile does not allow, goes to a listed length', () => {
    expect(snapLength('permanent', menu([H, D], false, true))).toBe('24h');
    expect(snapLength('custom', menu([H, D], true, false))).toBe('24h');
  });
});

describe('snapLength: an empty list never defaults to permanent', () => {
  it.each<[boolean, boolean, string]>([
    [true, true, 'custom'],
    [false, true, 'custom'],
    [true, false, ''],
    [false, false, ''],
  ])('permanent allowed %s, custom allowed %s: %j', (permanent, custom, want) => {
    expect(snapLength('24h', menu([], permanent, custom))).toBe(want);
  });
  it('a value that is not offered is replaced, not kept, when nothing is offered', () => {
    expect(snapLength('custom', menu([], true, false))).toBe('');
    expect(snapLength('permanent', menu([], false, false))).toBe('');
  });
  it('permanent stays when the moderator chose it themselves', () => {
    expect(snapLength('permanent', menu([], true, false))).toBe('permanent');
  });
  it('an unset length asks to be chosen, and is never read as a length', () => {
    const r = resolveLength({ value: '', amount: '', unit: 'hours' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.key).toBe('hub.length.error.choose');
  });
});
