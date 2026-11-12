import { describe, expect, it } from 'vitest';
import { lighterKinds, lighterLengths } from '../src/appeals/lighter.js';

// What "Make it lighter..." offers: the kit's own rule (core `reductionOf`) as the picker draws it. A reduction goes to a lower kind (any length up to the
// original's, permanent only from a permanent one), or to the same kind and strictly shorter; a warning has no length and cannot be reduced.

const H = 3_600_000;
const D = 24 * H;
const OFFERED = [H, 6 * H, D, 7 * D];
const sanction = (kind: 'warning' | 'chat' | 'area' | 'ban', length: number | null) => ({ kind, length });

describe('lighterKinds', () => {
  it('a warning has nothing lighter', () => {
    expect(lighterKinds(sanction('warning', null), OFFERED)).toEqual([]);
  });
  it('a chat restriction can become a warning, or a shorter chat restriction', () => {
    expect(lighterKinds(sanction('chat', D), OFFERED)).toEqual(['warning', 'chat']);
  });
  it('the same kind is left out when no offered length is shorter', () => {
    expect(lighterKinds(sanction('chat', H), OFFERED)).toEqual(['warning']);
    expect(lighterKinds(sanction('chat', 30 * 60_000), OFFERED)).toEqual(['warning']);
  });
  it('an area restriction and a ban keep every kind below, in order', () => {
    expect(lighterKinds(sanction('area', 7 * D), OFFERED)).toEqual(['warning', 'chat', 'area']);
    expect(lighterKinds(sanction('ban', null), OFFERED)).toEqual(['warning', 'chat', 'area', 'ban']);
    expect(lighterKinds(sanction('ban', D), [])).toEqual(['warning', 'chat', 'area']);
  });
});

describe('lighterLengths', () => {
  it('a warning has no length', () => {
    expect(lighterLengths('warning', sanction('chat', D), OFFERED)).toEqual([]);
  });
  it('the same kind: strictly shorter than the original', () => {
    expect(lighterLengths('chat', sanction('chat', D), OFFERED)).toEqual([H, 6 * H]);
    expect(lighterLengths('ban', sanction('ban', null), OFFERED)).toEqual(OFFERED);
  });
  it('a lower kind: up to the original, equal included', () => {
    expect(lighterLengths('chat', sanction('area', D), OFFERED)).toEqual([H, 6 * H, D, null].filter((x) => x !== null));
    expect(lighterLengths('chat', sanction('area', 90 * 60_000), OFFERED)).toEqual([H]);
  });
  it('permanent only for a lower kind from a permanent one', () => {
    expect(lighterLengths('area', sanction('ban', null), OFFERED)).toEqual([...OFFERED, null]);
    expect(lighterLengths('area', sanction('ban', 7 * D), OFFERED)).toEqual(OFFERED);
  });
  it('is sorted shortest first and takes no length twice, whatever the profile lists', () => {
    expect(lighterLengths('chat', sanction('chat', 7 * D), [D, H, D, 6 * H])).toEqual([H, 6 * H, D]);
  });
});
