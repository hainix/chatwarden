// The order in which the release workflow publishes the packages, derived from the manifests. A package is published after
// every @chatwarden package it needs when an adopter installs it (peerDependencies and dependencies). devDependencies are
// left out on purpose: npm does not strip them from the published manifest, but it never installs a dependency's
// devDependencies for a consumer, so they are harmless there, and http's devDependency on discord (for its tests) is not a
// reason to publish discord first. Where the edges leave a choice, PUBLISH_ORDER decides, so the list stays stable.
// `node scripts/publish-order.mjs` prints `name@version` lines in publish order. Unit-tested in publish-order.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The documented publish order. scripts/publish-order.test.ts asserts the manifests produce exactly this list. */
export const PUBLISH_ORDER = [
  '@chatwarden/core',
  '@chatwarden/matcher',
  '@chatwarden/store-sqlite',
  '@chatwarden/profanity',
  '@chatwarden/http',
  '@chatwarden/discord',
];

const rankOf = (name) => {
  const i = PUBLISH_ORDER.indexOf(name);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};
const byRankThenName = (a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Package names in publish order (dependencies first). Private packages are left out; a cycle throws.
 * @param {Array<{ name: string, private?: boolean, dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }>} manifests
 * @returns {string[]}
 */
export function publishOrder(manifests) {
  const nodes = manifests.filter((p) => p.private !== true);
  const names = new Set(nodes.map((p) => p.name));
  /** @type {Map<string, Set<string>>} package -> the packages of this set it needs first */
  const needs = new Map(
    nodes.map((p) => [
      p.name,
      new Set(
        [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {})].filter(
          (d) => d.startsWith('@chatwarden/') && names.has(d) && d !== p.name,
        ),
      ),
    ]),
  );
  const out = [];
  while (needs.size > 0) {
    const ready = [...needs].filter(([, deps]) => [...deps].every((d) => !needs.has(d))).map(([n]) => n);
    if (ready.length === 0) throw new Error(`publish order: dependency cycle among ${[...needs.keys()].sort().join(', ')}`);
    const next = ready.sort(byRankThenName)[0];
    out.push(next);
    needs.delete(next);
  }
  return out;
}

/** `name@version` for each published package, in publish order. */
export function publishSpecs(manifests) {
  const version = new Map(manifests.map((p) => [p.name, p.version]));
  return publishOrder(manifests).map((n) => `${n}@${version.get(n)}`);
}

function main() {
  const base = join(fileURLToPath(new URL('..', import.meta.url)), 'packages');
  const manifests = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(readFileSync(join(base, d.name, 'package.json'), 'utf8')));
  for (const spec of publishSpecs(manifests)) console.log(spec);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
