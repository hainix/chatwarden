import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { PUBLISH_ORDER, publishOrder, publishSpecs } from './publish-order.mjs';

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const root = fileURLToPath(new URL('..', import.meta.url));
const manifests: Manifest[] = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => JSON.parse(readFileSync(join(root, 'packages', d.name, 'package.json'), 'utf8')) as Manifest);

const order = (m: Manifest[]): string[] => publishOrder(m);
const m = (name: string, peers: string[] = [], extra: Partial<Manifest> = {}): Manifest => ({
  name,
  version: '1.0.0',
  peerDependencies: Object.fromEntries(peers.map((p) => [p, '^1.0.0'])),
  ...extra,
});

describe('the real manifests', () => {
  it('publish in the documented order: core first, then store-memory, matcher, store-sqlite, profanity, http, discord', () => {
    expect(order(manifests)).toEqual([
      '@chatwarden/core',
      '@chatwarden/store-memory',
      '@chatwarden/matcher',
      '@chatwarden/store-sqlite',
      '@chatwarden/profanity',
      '@chatwarden/http',
      '@chatwarden/discord',
    ]);
    expect(PUBLISH_ORDER).toEqual(order(manifests));
  });

  it('never publishes a package before an @chatwarden package it requires as a peer', () => {
    const at = new Map(order(manifests).map((n, i) => [n, i]));
    for (const pkg of manifests) {
      for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
        if (dep.startsWith('@chatwarden/')) expect(at.get(dep), `${dep} before ${pkg.name}`).toBeLessThan(at.get(pkg.name) as number);
      }
    }
  });

  it('lists every published package exactly once, and no private one', () => {
    const published = manifests.filter((p) => p.private !== true).map((p) => p.name).sort();
    expect([...order(manifests)].sort()).toEqual(published);
  });

  it('publishSpecs gives name@version in the same order', () => {
    expect(publishSpecs(manifests)).toEqual(order(manifests).map((n) => `${n}@0.1.0`));
  });
});

describe('publishOrder', () => {
  it('puts a dependency before its dependent regardless of input order', () => {
    const a = m('@chatwarden/a');
    const b = m('@chatwarden/b', ['@chatwarden/a']);
    const c = m('@chatwarden/c', ['@chatwarden/b']);
    for (const input of [[a, b, c], [c, b, a], [b, c, a], [c, a, b]]) expect(order(input)).toEqual(['@chatwarden/a', '@chatwarden/b', '@chatwarden/c']);
  });

  it('is deterministic: the same set in any input order gives the same list', () => {
    const set = [m('@chatwarden/x'), m('@chatwarden/y', ['@chatwarden/x']), m('@chatwarden/z', ['@chatwarden/x'])];
    const forward = order(set);
    expect(order([...set].reverse())).toEqual(forward);
    expect(order([set[1] as Manifest, set[2] as Manifest, set[0] as Manifest])).toEqual(forward);
  });

  it('handles a diamond', () => {
    const out = order([m('@chatwarden/d', ['@chatwarden/b', '@chatwarden/c']), m('@chatwarden/b', ['@chatwarden/a']), m('@chatwarden/c', ['@chatwarden/a']), m('@chatwarden/a')]);
    expect(out[0]).toBe('@chatwarden/a');
    expect(out[3]).toBe('@chatwarden/d');
    expect(out).toHaveLength(4);
  });

  it('counts runtime dependencies as edges too', () => {
    const out = order([m('@chatwarden/b', [], { dependencies: { '@chatwarden/a': '^1.0.0' } }), m('@chatwarden/a')]);
    expect(out).toEqual(['@chatwarden/a', '@chatwarden/b']);
  });

  it('ignores devDependencies: they are stripped on publish, so they do not constrain the order', () => {
    const out = order([m('@chatwarden/a', [], { devDependencies: { '@chatwarden/b': '1.0.0' } }), m('@chatwarden/b', ['@chatwarden/a'])]);
    expect(out).toEqual(['@chatwarden/a', '@chatwarden/b']);
  });

  it('ignores edges to packages outside the set and outside the scope', () => {
    expect(order([m('@chatwarden/a', ['express', '@chatwarden/not-here'])])).toEqual(['@chatwarden/a']);
  });

  it('leaves private packages out', () => {
    expect(order([m('@chatwarden/a'), m('@chatwarden/example', ['@chatwarden/a'], { private: true })])).toEqual(['@chatwarden/a']);
  });

  it('puts a package it has not heard of after the known ones, in name order', () => {
    const out = order([m('@chatwarden/zzz'), m('@chatwarden/new'), m('@chatwarden/core'), m('@chatwarden/discord', ['@chatwarden/core'])]);
    expect(out).toEqual(['@chatwarden/core', '@chatwarden/discord', '@chatwarden/new', '@chatwarden/zzz']);
  });

  it('throws on a cycle, naming the packages', () => {
    expect(() => order([m('@chatwarden/a', ['@chatwarden/b']), m('@chatwarden/b', ['@chatwarden/a'])])).toThrow(/cycle.*@chatwarden\/a.*@chatwarden\/b/s);
  });

  it('returns an empty list for no packages', () => {
    expect(order([])).toEqual([]);
  });
});
