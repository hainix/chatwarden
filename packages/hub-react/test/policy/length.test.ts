import { describe, expect, it } from 'vitest';
import { MAX_DURATION_MS } from '../../src/decision.js';
import { MAX_LISTED, MIN_LENGTH_MS, addDuration, parseAmount, removeDuration, resolveLength, lengthValue, nearestLength } from '../../src/policy/length.js';
import type { LengthDraft } from '../../src/policy/length.js';

// A custom length is typed as a number and a unit and must land between 1 minute and 365 days, in whole minutes, the bounds the
// kit checks. The list of offered lengths stays sorted and without repeats.

const H = 3_600_000;
const D = 24 * H;

describe('parseAmount: a number and a unit', () => {
  it.each<[string, 'hours' | 'days', number]>([
    ['6', 'hours', 6 * H],
    ['1', 'days', D],
    ['0.5', 'hours', 30 * 60_000],
    ['1.5', 'hours', 90 * 60_000],
    [' 12 ', 'hours', 12 * H],
    ['365', 'days', 365 * D],
    ['8760', 'hours', 365 * D],
    ['0.25', 'hours', 15 * 60_000],
    ['0.1', 'hours', 6 * 60_000],
    ['1', 'hours', H],
  ])('%s %s is %i ms', (amount, unit, ms) => {
    expect(parseAmount(amount, unit)).toEqual({ ok: true, ms });
  });

  it.each<[string, 'hours' | 'days', string]>([
    ['', 'hours', 'hub.length.error.empty'],
    ['   ', 'days', 'hub.length.error.empty'],
    ['abc', 'hours', 'hub.length.error.number'],
    ['-1', 'hours', 'hub.length.error.number'],
    ['1e3', 'hours', 'hub.length.error.number'],
    ['6,5', 'hours', 'hub.length.error.number'],
    ['Infinity', 'days', 'hub.length.error.number'],
    ['0', 'hours', 'hub.length.error.short'],
    ['0.00', 'days', 'hub.length.error.short'],
    ['0.01', 'hours', 'hub.length.error.short'],
    ['366', 'days', 'hub.length.error.long'],
    ['8761', 'hours', 'hub.length.error.long'],
    ['99999999999', 'days', 'hub.length.error.long'],
    ['1.00001', 'hours', 'hub.length.error.whole'],
    ['0.0168', 'hours', 'hub.length.error.whole'],
  ])('%j %s is refused: %s', (amount, unit, key) => {
    const r = parseAmount(amount, unit);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.key).toBe(key);
  });

  it('the bounds are one minute and 365 days, as the kit has them', () => {
    expect(MIN_LENGTH_MS).toBe(60_000);
    expect(MAX_DURATION_MS).toBe(365 * D);
    expect(MAX_LISTED).toBe(50);
  });
});

describe('addDuration and removeDuration: sorted, unique, at most 50', () => {
  it('inserts in order', () => {
    expect(addDuration([H, D], 6 * H)).toEqual({ ok: true, list: [H, 6 * H, D] });
    expect(addDuration([H, D], 2 * D)).toEqual({ ok: true, list: [H, D, 2 * D] });
    expect(addDuration([H, D], 30 * 60_000)).toEqual({ ok: true, list: [30 * 60_000, H, D] });
    expect(addDuration([], H)).toEqual({ ok: true, list: [H] });
  });
  it('refuses one that is already there', () => {
    const r = addDuration([H, D], D);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.key).toBe('hub.length.error.duplicate');
  });
  it('refuses a 51st length, and out of range ones', () => {
    const fifty = Array.from({ length: MAX_LISTED }, (_, i) => (i + 1) * H);
    const r = addDuration(fifty, 99 * D);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.key).toBe('hub.length.error.tooMany');
    expect(addDuration([], 30_000).ok).toBe(false);
    expect(addDuration([], 366 * D).ok).toBe(false);
    expect(addDuration([], 1.5).ok).toBe(false);
  });
  it('does not change the list it was given', () => {
    const list = [H];
    addDuration(list, D);
    removeDuration(list, H);
    expect(list).toEqual([H]);
  });
  it('removes one, and an absent one changes nothing', () => {
    expect(removeDuration([H, 6 * H, D], 6 * H)).toEqual([H, D]);
    expect(removeDuration([H], 5)).toEqual([H]);
    expect(removeDuration([H], H)).toEqual([]);
  });
});

describe('resolveLength: what a length field says', () => {
  const draft = (value: string, amount = '', unit: 'hours' | 'days' = 'hours'): LengthDraft => ({ value, amount, unit });
  it('a listed length, permanent, and the old keys', () => {
    expect(resolveLength(draft(String(6 * H)))).toEqual({ ok: true, ms: 6 * H });
    expect(resolveLength(draft('permanent'))).toEqual({ ok: true, ms: null });
    expect(resolveLength(draft('24h'))).toEqual({ ok: true, ms: D });
    expect(resolveLength(draft('1h'))).toEqual({ ok: true, ms: H });
    expect(resolveLength(draft('7d'))).toEqual({ ok: true, ms: 7 * D });
    expect(resolveLength(draft('30d'))).toEqual({ ok: true, ms: 30 * D });
  });
  it('custom reads the number and unit', () => {
    expect(resolveLength(draft('custom', '2', 'days'))).toEqual({ ok: true, ms: 2 * D });
    const bad = resolveLength(draft('custom', '', 'days'));
    expect(bad.ok).toBe(false);
  });
  it('anything else is refused, never read as permanent', () => {
    for (const value of ['', 'forever', '0', '-5', '1.5', String(MAX_DURATION_MS + 1), 'NaN']) {
      expect(resolveLength(draft(value)).ok, value).toBe(false);
    }
  });
  it('lengthValue names a length for a menu (the four old keys keep their names), and permanent', () => {
    expect(lengthValue(6 * H)).toBe(String(6 * H));
    expect([H, D, 7 * D, 30 * D].map(lengthValue)).toEqual(['1h', '24h', '7d', '30d']);
    expect(lengthValue(null)).toBe('permanent');
  });
});

describe('nearestLength: a default that is on the menu', () => {
  it('keeps one that is listed, else the nearest to a day', () => {
    expect(nearestLength([H, 6 * H, D, 7 * D], D)).toBe(D);
    expect(nearestLength([H, 6 * H, 12 * H], D)).toBe(12 * H);
    expect(nearestLength([3 * D, 7 * D], D)).toBe(3 * D);
    expect(nearestLength([], D)).toBeNull();
  });
});
