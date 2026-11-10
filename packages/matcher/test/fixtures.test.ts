import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as viaAlias from '@chatwarden/matcher/test-fixtures';
import * as fixtures from '@chatwarden/matcher/fixtures';
import { LiveTerms, buildMatcher, loadTermPack } from '../src/index.js';

describe('@chatwarden/matcher/fixtures (shipped synthetic fixtures)', () => {
  it('exports the synthetic pack, its data and the in-memory term store', () => {
    expect(Object.keys(fixtures).sort()).toEqual(
      ['MemoryTermStore', 'SYNTHETIC_EXCEPTIONS', 'SYNTHETIC_TERMS', 'UNLISTED_WORDS', 'syntheticTermPack'].sort(),
    );
  });
  it('syntheticTermPack loads and blocks its own invented terms', () => {
    const pack = loadTermPack(fixtures.syntheticTermPack());
    expect(pack.id).toBe('synthetic');
    const matcher = buildMatcher(
      pack.terms.map((t) => ({ id: t.id, term: t.term, language: t.language, active: t.active })),
      pack.exceptions,
    );
    expect(matcher.match('you zorbak')).toEqual({ termId: 'syn:zorbak' });
    expect(matcher.match('hello there friend')).toBeNull();
  });
  it('syntheticTermPack accepts overrides and returns fresh copies', () => {
    const a = fixtures.syntheticTermPack({ id: 'other' });
    expect(a.id).toBe('other');
    a.terms[0]!.positive.push('mutated');
    expect(fixtures.syntheticTermPack().terms[0]!.positive).not.toContain('mutated');
  });
  it('MemoryTermStore plugs into LiveTerms', async () => {
    const store = new fixtures.MemoryTermStore();
    const live = new LiveTerms({ store, pack: fixtures.syntheticTermPack(), clock: { now: () => 1 } });
    await live.load();
    expect(live.match('zorbak')).toEqual({ termId: expect.any(String) });
    expect(store.isSeeded('synthetic')).toBe(true);
  });
  it('every synthetic term is an invented word (no listed term is a dictionary-style placeholder of a real list)', () => {
    for (const t of fixtures.SYNTHETIC_TERMS) expect(t.id).toMatch(/^syn:/);
    expect(fixtures.UNLISTED_WORDS.length).toBeGreaterThan(0);
  });
});

describe('@chatwarden/matcher/test-fixtures (deprecated alias)', () => {
  it('re-exports exactly the same names as ./fixtures', () => {
    expect(Object.keys(viaAlias).sort()).toEqual(Object.keys(fixtures).sort());
  });
  it('re-exports the same values', () => {
    expect(viaAlias.SYNTHETIC_TERMS).toBe(fixtures.SYNTHETIC_TERMS);
    expect(viaAlias.MemoryTermStore).toBe(fixtures.MemoryTermStore);
    expect(viaAlias.syntheticTermPack().id).toBe(fixtures.syntheticTermPack().id);
  });
  it('carries a @deprecated TSDoc tag on every re-export', () => {
    const src = readFileSync(new URL('../src/fixtures/testFixtures.ts', import.meta.url), 'utf8');
    const exports = src.match(/^export /gm) ?? [];
    const tags = src.match(/@deprecated/g) ?? [];
    expect(exports.length).toBeGreaterThan(0);
    expect(tags.length).toBeGreaterThanOrEqual(exports.length);
  });
});

describe('matcher package manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, { types: string; default: string }>;
    typesVersions: { '*': Record<string, string[]> };
  };
  it('exposes ./fixtures and the deprecated ./test-fixtures, both from dist/src, with typesVersions', () => {
    expect(pkg.exports['./fixtures']).toEqual({
      types: './dist/src/fixtures/index.d.ts',
      default: './dist/src/fixtures/index.js',
    });
    expect(pkg.exports['./test-fixtures']).toEqual({
      types: './dist/src/fixtures/testFixtures.d.ts',
      default: './dist/src/fixtures/testFixtures.js',
    });
    expect(pkg.typesVersions['*']).toEqual({
      fixtures: ['dist/src/fixtures/index.d.ts'],
      'test-fixtures': ['dist/src/fixtures/testFixtures.d.ts'],
    });
  });
  it('no export points into dist/test', () => {
    expect(JSON.stringify(pkg)).not.toContain('dist/test');
  });
});
