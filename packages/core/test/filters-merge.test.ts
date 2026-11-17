import { describe, expect, it } from 'vitest';
import { mergeFilters, overlayFilters, resolveFilters, type FilterSettings, type ResolvedFilters } from '../src/filters.js';
import { ProfileError } from '../src/profile.js';

const base = (): ResolvedFilters =>
  resolveFilters({
    links: { action: 'flag', allow: ['example.com'], deny: ['zorbak.example'], newAccountDays: 3 },
    personalInfo: { action: 'mask', kinds: ['email'] },
    ratio: { action: 'count' },
    phrases: [{ id: 'rmt', action: 'flag', phrases: ['buy gold'] }],
    ignore: ['e.g.'],
    flagCapPerDay: 20,
  });

describe('mergeFilters', () => {
  it('a field left out inherits', () => {
    expect(mergeFilters(base(), {})).toEqual(base());
    const merged = mergeFilters(base(), { flagCapPerDay: 9 });
    expect(merged.flagCapPerDay).toBe(9);
    expect(merged.links).toEqual(base().links);
    expect(merged.phrases).toEqual(base().phrases);
  });

  it('null turns a block off', () => {
    const merged = mergeFilters(base(), { links: null, personalInfo: null, ratio: null });
    expect(merged.links).toBeNull();
    expect(merged.personalInfo).toBeNull();
    expect(merged.ratio).toBeNull();
    expect(merged.phrases).toHaveLength(1);
  });

  it('phrases are replaced whole, and an empty list clears them', () => {
    const merged = mergeFilters(base(), { phrases: [{ id: 'scam', action: 'refuse', phrases: ['free zorbak'] }] });
    expect(merged.phrases.map((p) => p.id)).toEqual(['scam']);
    expect(mergeFilters(base(), { phrases: [] }).phrases).toEqual([]);
  });

  it('ignore is replaced whole', () => {
    expect(mergeFilters(base(), { ignore: ['i.e.'] }).ignore).toEqual(['i.e.']);
    expect(mergeFilters(base(), { ignore: [] }).ignore).toEqual([]);
  });

  it('links are replaced whole, not by member', () => {
    const merged = mergeFilters(base(), { links: { action: 'refuse' } });
    expect(merged.links).toEqual({ action: 'refuse', rule: 4, allow: [], deny: [], unlisted: 'act', invites: true, shorteners: true, newAccountDays: null });
  });

  it('personalInfo and ratio are replaced whole too', () => {
    expect(mergeFilters(base(), { personalInfo: { action: 'refuse' } }).personalInfo?.kinds).toEqual(['phone', 'email', 'card', 'contact']);
    expect(mergeFilters(base(), { ratio: { action: 'mask', caps: null } }).ratio).toMatchObject({ action: 'mask', caps: null, repeats: { maxRun: 6 } });
  });

  it('a block can be turned on over an off base', () => {
    const merged = mergeFilters(resolveFilters(undefined), { links: { action: 'count' } });
    expect(merged.links?.action).toBe('count');
  });

  it('the over side is validated, with a filters path', () => {
    for (const [over, path] of [
      [{ links: { allow: [] } }, 'filters.links.action'],
      [{ links: { action: 'count', allow: ['https://x.example'] } }, 'filters.links.allow[0]'],
      [{ flagCapPerDay: 0 }, 'filters.flagCapPerDay'],
      [{ nope: 1 }, 'filters.nope'],
    ] as const) {
      try {
        mergeFilters(base(), over as FilterSettings);
        throw new Error('expected a ProfileError');
      } catch (e) {
        expect(e).toBeInstanceOf(ProfileError);
        expect((e as ProfileError).path).toBe(path);
      }
    }
  });

  it('the inputs are not changed or shared', () => {
    const b = base();
    const snapshot = JSON.stringify(b);
    const over: FilterSettings = { links: { action: 'count', allow: ['cdn.example'] }, phrases: [{ id: 'x', action: 'count', phrases: ['zorbak vlemmo'] }], ignore: ['q'] };
    const overSnapshot = JSON.stringify(over);
    const merged = mergeFilters(b, over);
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(JSON.stringify(over)).toBe(overSnapshot);
    // Nothing in the result is the same object as anything in an input.
    const inherited = mergeFilters(b, { flagCapPerDay: 3 });
    expect(inherited.links).not.toBe(b.links);
    expect(inherited.links?.allow).not.toBe(b.links?.allow);
    expect(inherited.phrases).not.toBe(b.phrases);
    expect(inherited.phrases[0]).not.toBe(b.phrases[0]);
    expect(inherited.phrases[0]?.phrases).not.toBe(b.phrases[0]?.phrases);
    expect(inherited.ratio?.caps).not.toBe(b.ratio?.caps);
    expect(inherited.ignore).not.toBe(b.ignore);
    merged.links?.allow.push('mutated.example');
    expect(over.links?.allow).toEqual(['cdn.example']);
  });
});

describe('overlayFilters (a room supplies its own links, never editing the profile)', () => {
  it('a member patch changes that member only', () => {
    const o = overlayFilters(base(), { links: { unlisted: 'act' } });
    expect(o.links).toEqual({ ...base().links, unlisted: 'act' });
    expect(o.personalInfo).toEqual(base().personalInfo);
    expect(o.phrases).toEqual(base().phrases);
  });

  it('a member patch keeps the base lists and action', () => {
    const o = overlayFilters(base(), { links: { action: 'refuse' } });
    expect(o.links).toMatchObject({ action: 'refuse', allow: ['example.com'], deny: ['zorbak.example'], newAccountDays: 3 });
  });

  it('a patch on a block that is off leaves it off unless the patch names an action', () => {
    const off = resolveFilters(undefined);
    expect(overlayFilters(off, { links: { unlisted: 'act' } }).links).toBeNull();
    expect(overlayFilters(off, { links: { action: 'refuse', unlisted: 'act' } }).links).toMatchObject({ action: 'refuse', unlisted: 'act', rule: 4 });
  });

  it('null turns a block off', () => {
    expect(overlayFilters(base(), { links: null }).links).toBeNull();
  });

  it('phrases, ignore and the cap are replaced whole when given', () => {
    const o = overlayFilters(base(), { phrases: [], ignore: ['q'], flagCapPerDay: 3 });
    expect([o.phrases, o.ignore, o.flagCapPerDay]).toEqual([[], ['q'], 3]);
  });

  it('is validated like a setting, and shares nothing with the base', () => {
    expect(() => overlayFilters(base(), { links: { unlisted: 'maybe' as never } })).toThrow(ProfileError);
    const b = base();
    const snapshot = JSON.stringify(b);
    const o = overlayFilters(b, { links: { unlisted: 'act' } });
    o.links?.allow.push('x.example');
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});
