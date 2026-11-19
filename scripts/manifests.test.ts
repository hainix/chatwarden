import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Manifest = {
  name: string;
  version: string;
  description?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(root, ...parts), 'utf8')) as T;

const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const published = dirs.map((d) => ({ dir: d, pkg: readJson<Manifest>('packages', d, 'package.json') }));
const names = published.map((p) => p.pkg.name);
// The fixed group moves together; read the version from core instead of hardcoding it, so a release does not break this test.
const VERSION = readJson<Manifest>('packages', 'core', 'package.json').version as string;
// 0.2.0 resets every floor. The release changes the kit contract (the store contract, `Session`, the chat wire, the profile sections), and a minor
// bump in 0.x is outside every `^0.1.x` range, so every @chatwarden/* peer, required or optional, is `^0.2.0`. The floor is raised by hand
// (RELEASING.md, "When a peer floor must rise"); after this release it stays where it is through a compatible release.
const PEER_FLOOR = '^0.2.0';
// 0.2.1 raised six floors by hand and 0.2.2 raises five more, each by hand and before `npm run version` (RELEASING.md, "When a peer floor must rise"; the release stays a patch because every
// range is set before the version run, so changesets never sees one out of range). Each exception names the API that forced it. What 0.2.1 raised and 0.2.2 does not need to move stays at ^0.2.1
// (discord, player-react: they use nothing new in core 0.2.2); the memory store, matcher, profanity and the optional peers of http stay at the 0.2.0 floor.
const FLOOR_021 = '^0.2.1';
const FLOOR_022 = '^0.2.2';
// 0.2.3 raises one: http reads `notices.deliverAutomatic` in `chatwarden serve` (`CHATWARDEN_DELIVER_AUTOMATIC`). A core 0.2.2 ignores that option, so the variable would silently do nothing.
const FLOOR_023 = '^0.2.3';
const RAISED: Record<string, Record<string, string>> = {
  // http: 0.2.1 `cw.appeals.caseByLink`, `fileByLink` and `landingOrigins`, `appealUrl` on a notice and a door refusal, `resolveLandingOptions` (the appeal landing routes and the delivery webhook);
  // 0.2.2 `recommendFor`, `GAME_KINDS`, `isGameKind`, `cw.policy.setup`, `dismissSetup` and `applyRecommendation` (the /setup routes and `chatwarden init --game`) and the whole-form layer
  // (`guidelines: { tiers }`, `teamNotes`, `aiContext`), `evidenceKind` on a decision, `PolicyState.promptExcluded`.
  // 0.2.3 `notices.deliverAutomatic` (`NoticeDeliveryOptions`), which `chatwarden serve` passes from `CHATWARDEN_DELIVER_AUTOMATIC`: an older core would ignore it and still deliver every automatic timeout.
  '@chatwarden/http': { '@chatwarden/core': FLOOR_023 },
  // discord: the `sanction.overturned` event type, which it posts to the feed (0.2.1). 0.2.2 adds nothing it uses.
  '@chatwarden/discord': { '@chatwarden/core': FLOOR_021 },
  // hub-react: 0.2.1 `AppealDetail.cause` and `reasonCode`, the new admin fields. 0.2.2: `PolicyState.promptExcluded`, `TeamNote`, `GameKind`, the whole-form layer (the principles editor),
  // the evidence kind on a report, a decision and a reason, from core; from http the /setup routes and the `evidenceKind` of a decision.
  '@chatwarden/hub-react': { '@chatwarden/core': FLOOR_022, '@chatwarden/http': FLOOR_022 },
  // player-react: `@chatwarden/core/notice-locales`, the words of the AppealPage (0.2.1). 0.2.2 reads the evidence kind from the server and uses nothing from core that 0.2.1 lacks at run time.
  '@chatwarden/player-react': { '@chatwarden/core': FLOOR_021 },
  // hub-element: bundles the new hub, so its optional types-only peer on hub-react rises with it.
  '@chatwarden/hub-element': { '@chatwarden/hub-react': FLOOR_022 },
  // store-sqlite: imports `registrySubjectColumns` from core at run time (the identity age-out `purgeIdleSubjects`), and its migration 28 holds the evidence column the 0.2.2 core writes. A core
  // that lacks the export would fail at import.
  '@chatwarden/store-sqlite': { '@chatwarden/core': FLOOR_022 },
};
const ownScope = (n: string): boolean => n.startsWith('@chatwarden/');
const UI_PACKAGES = new Set(['@chatwarden/hub-react', '@chatwarden/player-react', '@chatwarden/hub-element']);
// hub-element bundles React, hub-react and the little of core it needs into its own script, so it peers on none of them (hub-react is an
// optional peer for the types only).
const BUNDLED = new Set(['@chatwarden/hub-element']);
/** The range every @chatwarden peer must declare. */
const peerRangeOf = (pkg: string, peer: string): string => RAISED[pkg]?.[peer] ?? PEER_FLOOR;

describe('published package set', () => {
  it('is the ten expected packages, none private', () => {
    expect(names.sort()).toEqual(
      [
        '@chatwarden/core',
        '@chatwarden/discord',
        '@chatwarden/http',
        '@chatwarden/hub-element',
        '@chatwarden/hub-react',
        '@chatwarden/matcher',
        '@chatwarden/player-react',
        '@chatwarden/profanity',
        '@chatwarden/store-memory',
        '@chatwarden/store-sqlite',
      ].sort(),
    );
    for (const { pkg } of published) expect(pkg.private).toBe(false);
  });
});

describe('versions', () => {
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))('%s is at the shared version', (_n, pkg) => {
    expect(pkg.version).toBe(VERSION);
  });
  it.each(published.map((p) => [p.pkg.name, p.dir, p.pkg.version] as const))('%s exports a VERSION constant equal to its manifest version', (_n, dir, version) => {
    // http keeps the constant in src/version.ts (the CLI imports it without loading the package root); index.ts re-exports it.
    const file = existsSync(join(root, 'packages', dir, 'src', 'version.ts')) ? 'version.ts' : 'index.ts';
    const src = readFileSync(join(root, 'packages', dir, 'src', file), 'utf8').replaceAll('\r\n', '\n');
    expect(/^export const VERSION = '([^']*)';$/m.exec(src)?.[1]).toBe(version);
  });
  it('are identical across the fixed group', () => {
    expect(new Set(published.map((p) => p.pkg.version)).size).toBe(1);
  });
});

describe('descriptions', () => {
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))('%s has a real description, not a placeholder', (_n, pkg) => {
    const d = pkg.description ?? '';
    expect(d.length, 'long enough to say something').toBeGreaterThanOrEqual(40);
    expect(d.length, 'short enough for a search result').toBeLessThanOrEqual(200);
    expect(d).not.toMatch(/^Chatwarden [\w-]+ package\.?$/);
    expect(d.trim().endsWith('.')).toBe(true);
  });
  it('are all different', () => {
    expect(new Set(published.map((p) => p.pkg.description)).size).toBe(published.length);
  });
});

describe('core is a peer, never a dependency', () => {
  const dependents = published.filter((p) => p.pkg.name !== '@chatwarden/core' && !BUNDLED.has(p.pkg.name));
  it('core itself has no @chatwarden peers or dependencies', () => {
    const core = published.find((p) => p.pkg.name === '@chatwarden/core')!.pkg;
    for (const field of [core.dependencies, core.peerDependencies])
      expect(Object.keys(field ?? {}).filter(ownScope)).toEqual([]);
  });
  it('core dev-depends on nothing but store-memory (its tests run on the in-memory store)', () => {
    const core = published.find((p) => p.pkg.name === '@chatwarden/core')!.pkg;
    expect(Object.keys(core.devDependencies ?? {}).filter(ownScope)).toEqual(['@chatwarden/store-memory']);
  });
  it.each(dependents.map((p) => [p.pkg.name, p.pkg] as const))(
    '%s peers on core at its floor (^0.2.0, ^0.2.1, ^0.2.2 or ^0.2.3 where a release needs new core API) and dev-depends on core at the group version',
    (_n, pkg) => {
      expect(pkg.peerDependencies?.['@chatwarden/core']).toBe(peerRangeOf(pkg.name, '@chatwarden/core'));
      expect(pkg.devDependencies?.['@chatwarden/core']).toBe(VERSION);
      expect(pkg.peerDependenciesMeta?.['@chatwarden/core']).toBeUndefined();
    },
  );
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))(
    '%s lists no @chatwarden/* under dependencies',
    (_n, pkg) => {
      expect(Object.keys(pkg.dependencies ?? {}).filter(ownScope)).toEqual([]);
    },
  );
});

describe('every @chatwarden peer is linked locally at the exact version', () => {
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))('%s', (_n, pkg) => {
    for (const peer of Object.keys(pkg.peerDependencies ?? {}).filter(ownScope)) {
      expect(pkg.peerDependencies![peer]).toBe(peerRangeOf(pkg.name, peer));
      // http peers (optionally) on hub-element but does not dev-depend on it: hub-element's tests dev-depend on http, and the workspace links the package at the
      // root anyway, so a dev dependency would only close a cycle (publish order and a clean install). The serve tests find the linked copy.
      if (pkg.name === '@chatwarden/http' && peer === '@chatwarden/hub-element') {
        expect(pkg.devDependencies?.[peer]).toBeUndefined();
        expect(pkg.peerDependenciesMeta?.[peer]?.optional).toBe(true);
      } else expect(pkg.devDependencies?.[peer]).toBe(VERSION);
    }
    for (const dev of Object.keys(pkg.devDependencies ?? {}).filter(ownScope)) {
      expect(names).toContain(dev);
      expect(pkg.devDependencies![dev]).toBe(VERSION);
    }
  });
});

describe('store-memory', () => {
  const mem = (): Manifest => published.find((p) => p.pkg.name === '@chatwarden/store-memory')!.pkg;
  it('peers on core only: no other @chatwarden peer, and no runtime dependency at all', () => {
    expect(Object.keys(mem().peerDependencies ?? {})).toEqual(['@chatwarden/core']);
    expect(mem().dependencies).toBeUndefined();
  });
  it('is the browser-safe store: its manifest mentions no node: builtin as a dependency', () => {
    const all = Object.keys({ ...mem().dependencies, ...mem().peerDependencies });
    expect(all.filter((n) => n.startsWith('node:'))).toEqual([]);
  });
});

describe('peer floors', () => {
  const byName = (n: string): Manifest => published.find((p) => p.pkg.name === n)!.pkg;
  it('every @chatwarden/* peer of every package is ^0.2.0, optional ones included, except the seven raised in RAISED (two to ^0.2.1, four to ^0.2.2, one to ^0.2.3)', () => {
    const seen: string[] = [];
    for (const { pkg } of published) {
      for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => ownScope(n))) {
        expect(range, `${pkg.name} peer ${peer}`).toBe(peerRangeOf(pkg.name, peer));
        seen.push(`${pkg.name} -> ${peer}`);
      }
    }
    // the set, so a peer added or dropped is a decision somebody wrote down
    expect(seen.sort()).toEqual(
      [
        '@chatwarden/discord -> @chatwarden/core',
        '@chatwarden/http -> @chatwarden/core',
        '@chatwarden/http -> @chatwarden/hub-element',
        '@chatwarden/http -> @chatwarden/matcher',
        '@chatwarden/http -> @chatwarden/profanity',
        '@chatwarden/http -> @chatwarden/store-sqlite',
        '@chatwarden/hub-element -> @chatwarden/hub-react',
        '@chatwarden/hub-react -> @chatwarden/core',
        '@chatwarden/hub-react -> @chatwarden/http',
        '@chatwarden/matcher -> @chatwarden/core',
        '@chatwarden/player-react -> @chatwarden/core',
        '@chatwarden/profanity -> @chatwarden/core',
        '@chatwarden/profanity -> @chatwarden/matcher',
        '@chatwarden/store-memory -> @chatwarden/core',
        '@chatwarden/store-sqlite -> @chatwarden/core',
        '@chatwarden/store-sqlite -> @chatwarden/matcher',
      ].sort(),
    );
  });
  it('the raised floors are exactly these seven (two ^0.2.1, four ^0.2.2, one ^0.2.3), and every other peer is ^0.2.0 (a release raises only what uses new API)', () => {
    const raised: string[] = [];
    for (const { pkg } of published) {
      for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => ownScope(n))) {
        if (range !== PEER_FLOOR) raised.push(`${pkg.name} -> ${peer} ${range}`);
      }
    }
    expect(raised.sort()).toEqual(
      [
        '@chatwarden/discord -> @chatwarden/core ^0.2.1',
        '@chatwarden/http -> @chatwarden/core ^0.2.3',
        '@chatwarden/hub-element -> @chatwarden/hub-react ^0.2.2',
        '@chatwarden/hub-react -> @chatwarden/core ^0.2.2',
        '@chatwarden/hub-react -> @chatwarden/http ^0.2.2',
        '@chatwarden/player-react -> @chatwarden/core ^0.2.1',
        '@chatwarden/store-sqlite -> @chatwarden/core ^0.2.2',
      ].sort(),
    );
    // the memory store, matcher and profanity use nothing new in core at run time, and http's optional peers stay where they were
    for (const name of ['@chatwarden/store-memory', '@chatwarden/matcher', '@chatwarden/profanity']) {
      for (const range of Object.values(byName(name).peerDependencies ?? {})) expect(range, name).toBe(PEER_FLOOR);
    }
    for (const peer of ['@chatwarden/hub-element', '@chatwarden/matcher', '@chatwarden/profanity', '@chatwarden/store-sqlite']) {
      expect(byName('@chatwarden/http').peerDependencies?.[peer], peer).toBe(PEER_FLOOR);
    }
  });
  it('the four optional peers of http stay optional (a consumer without them installs), and the required ones stay required', () => {
    const http = byName('@chatwarden/http');
    for (const peer of ['@chatwarden/hub-element', '@chatwarden/matcher', '@chatwarden/profanity', '@chatwarden/store-sqlite']) {
      expect(http.peerDependenciesMeta?.[peer]?.optional, peer).toBe(true);
    }
    expect(http.peerDependenciesMeta?.['@chatwarden/core']?.optional).not.toBe(true);
  });
  it('no two packages dev-depend on each other, except core and store-memory (the in-memory store core tests on): http does not dev-depend on hub-element', () => {
    const dev = (n: string): string[] => Object.keys(byName(n).devDependencies ?? {}).filter(ownScope);
    const mutual: string[] = [];
    for (const a of names) for (const b of dev(a)) if (a < b && dev(b).includes(a)) mutual.push(`${a} <-> ${b}`);
    expect(mutual).toEqual(['@chatwarden/core <-> @chatwarden/store-memory']);
    expect(dev('@chatwarden/http')).not.toContain('@chatwarden/hub-element');
  });
  it('every @chatwarden floor is a caret range the group version satisfies, so each can be installed', () => {
    const [maj, min, pat] = VERSION.split('.').map(Number) as [number, number, number];
    for (const { pkg } of published) {
      for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => ownScope(n))) {
        const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
        expect(m, `${pkg.name} peer ${peer} is a caret range`).not.toBeNull();
        const [a, b, c] = m!.slice(1).map(Number) as [number, number, number];
        expect(a === maj && (b < min || (b === min && c <= pat)), `${pkg.name} peer ${peer} ${range} is satisfied by ${VERSION}`).toBe(true);
      }
    }
  });
});

describe('matcher peers', () => {
  const byName = (n: string): Manifest => published.find((p) => p.pkg.name === n)!.pkg;
  it('profanity peers on matcher and dev-depends on it', () => {
    const p = byName('@chatwarden/profanity');
    expect(p.peerDependencies?.['@chatwarden/matcher']).toBe(PEER_FLOOR);
    expect(p.devDependencies?.['@chatwarden/matcher']).toBe(VERSION);
    expect(p.dependencies?.obscenity).toBeDefined();
  });
  it('store-sqlite peers on matcher (its type import) and dev-depends on it', () => {
    const p = byName('@chatwarden/store-sqlite');
    expect(p.peerDependencies?.['@chatwarden/matcher']).toBe(PEER_FLOOR);
    expect(p.devDependencies?.['@chatwarden/matcher']).toBe(VERSION);
    // Required, not optional: the store's .d.ts references matcher types, so a consumer without matcher fails typecheck.
    expect(p.peerDependenciesMeta?.['@chatwarden/matcher']?.optional).not.toBe(true);
  });
  it('matcher no longer depends on obscenity at run time: it is a devDependency (the parity and version-pin tests only)', () => {
    const m = byName('@chatwarden/matcher');
    // The packed matcher must not pull obscenity (and its English word list, issue #8) into a consumer's install.
    expect(m.dependencies?.obscenity).toBeUndefined();
    expect(m.peerDependencies?.obscenity).toBeUndefined();
    expect(m.optionalDependencies?.obscenity).toBeUndefined();
    expect(m.devDependencies?.obscenity).toBe('^0.4.6');
  });
  it('profanity still needs obscenity at run time (its own filter)', () => {
    expect(byName('@chatwarden/profanity').dependencies?.obscenity).toBeDefined();
  });
});

describe('the bin and the new subpaths (init, the fetch adapter, the test kit)', () => {
  type Shipping = Manifest & { bin?: string | Record<string, string>; exports?: Record<string, { types: string; default: string }>; typesVersions?: { '*': Record<string, string[]> }; keywords?: string[] };
  const shipping = (dir: string): Shipping => readJson<Shipping>('packages', dir, 'package.json');
  /** The source file a built `dist/src/x.js` or `x.d.ts` comes from: `src/x.ts` (or `.tsx`). */
  const sourceOf = (dir: string, built: string): string | undefined => {
    const stem = built.replace(/^\.\//, '').replace(/^dist\/src\//, '').replace(/\.d\.ts$|\.js$/, '');
    return ['.ts', '.tsx'].map((ext) => join(root, 'packages', dir, 'src', `${stem}${ext}`)).find((f) => existsSync(f));
  };
  it('exactly one published package declares a bin and it is chatwarden, pointing at the compiled CLI entry', () => {
    const withBin = published.filter((p) => (p.pkg as Shipping).bin !== undefined);
    expect(withBin.map((p) => p.pkg.name)).toEqual(['@chatwarden/http']);
    expect(shipping('http').bin).toEqual({ chatwarden: './dist/src/cli/bin.js' });
    expect(sourceOf('http', './dist/src/cli/bin.js'), 'the bin has a source').toBeDefined();
  });
  it('http lists the CLI in its keywords', () => {
    expect(shipping('http').keywords).toEqual(expect.arrayContaining(['cli', 'init']));
  });
  it.each([
    ['http', './fetch', 'fetch', 'dist/src/fetch'],
    ['http', './cli', 'cli', 'dist/src/cli/index'],
    ['store-memory', './testing', 'testing', 'dist/src/testing/index'],
  ])('%s: the %s subpath is in exports and typesVersions, with types and code, and points at files a build produces', (dir, subpath, versionsKey, stem) => {
    const pkg = shipping(dir);
    expect(pkg.exports?.[subpath]).toEqual({ types: `./${stem}.d.ts`, default: `./${stem}.js` });
    expect(pkg.typesVersions?.['*'][versionsKey]).toEqual([`${stem}.d.ts`]);
    expect(sourceOf(dir, `${stem}.js`), `${dir} ${subpath} has a source`).toBeDefined();
  });
  it('the bin and the new subpaths are not under a test path and do not point outside dist/src', () => {
    for (const target of ['dist/src/cli/bin.js', 'dist/src/cli/index.js', 'dist/src/fetch.js', 'dist/src/testing/index.js']) {
      expect(target).not.toMatch(/(^|\/)test\//);
      expect(target.startsWith('dist/src/')).toBe(true);
    }
  });
  it('a bin does not add a dependency: http still has no dependencies entry', () => {
    expect(shipping('http').dependencies).toBeUndefined();
  });
});

describe('http optional peers', () => {
  const http = published.find((p) => p.pkg.name === '@chatwarden/http')!.pkg;
  it('express ^5 and @types/express ^5 are optional peers', () => {
    expect(http.peerDependencies?.express).toBe('^5.0.0');
    expect(http.peerDependencies?.['@types/express']).toBe('^5.0.0');
    expect(http.peerDependenciesMeta?.express?.optional).toBe(true);
    expect(http.peerDependenciesMeta?.['@types/express']?.optional).toBe(true);
  });
  it('express stays installed for the tests as a dev dependency', () => {
    expect(http.devDependencies?.express).toBeDefined();
    expect(http.devDependencies?.['@types/express']).toBeDefined();
  });
  it('express is not a regular dependency', () => {
    expect(http.dependencies?.express).toBeUndefined();
  });
});

describe('hub-react', () => {
  const hub = (): Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> } =>
    published.find((p) => p.pkg.name === '@chatwarden/hub-react')!.pkg as Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> };
  it('peers on react, react-dom, core and http; bundles none of them', () => {
    expect(Object.keys(hub().peerDependencies ?? {}).sort()).toEqual(['@chatwarden/core', '@chatwarden/http', 'react', 'react-dom']);
    expect(hub().peerDependencies?.react).toBe('^18.3.0 || ^19.0.0');
    expect(hub().peerDependencies?.['react-dom']).toBe('^18.3.0 || ^19.0.0');
    expect(hub().peerDependencies?.['@chatwarden/http']).toBe('^0.2.2');
    expect(hub().dependencies).toBeUndefined();
  });
  it('ships the stylesheet as ./styles.css and the optional font as ./font.css, and lists only those under sideEffects', () => {
    expect(hub().exports?.['./styles.css']).toBe('./src/styles.css');
    expect(hub().exports?.['./font.css']).toBe('./font.css');
    expect(hub().sideEffects).toEqual(['./src/styles.css', './font.css']);
  });
  it('marks react and react-dom as optional peers, so the headless entry installs without React (and the kit peers stay required)', () => {
    const meta = hub().peerDependenciesMeta ?? {};
    expect(meta.react).toEqual({ optional: true });
    expect(meta['react-dom']).toEqual({ optional: true });
    expect(meta['@chatwarden/core']?.optional).not.toBe(true);
    expect(meta['@chatwarden/http']?.optional).not.toBe(true);
    // Still declared, with their ranges: the React hub needs them.
    expect(hub().peerDependencies?.react).toBe('^18.3.0 || ^19.0.0');
    expect(hub().peerDependencies?.['react-dom']).toBe('^18.3.0 || ^19.0.0');
  });
  it('exports the headless controller as ./headless, from dist, with types, and nothing else from it', () => {
    expect(hub().exports?.['./headless']).toEqual({ types: './dist/src/headless/index.d.ts', default: './dist/src/headless/index.js' });
    // A subpath that is ESM and types only: no `require` condition, no CSS, no side effects.
    expect(Object.keys(hub().exports?.['./headless'] as object)).toEqual(['types', 'default']);
    // ...and older module resolution (node10) finds the types through typesVersions.
    expect((hub() as { typesVersions?: unknown }).typesVersions).toEqual({
      '*': { headless: ['dist/src/headless/index.d.ts'], 'locales/es': ['dist/src/locales/es.d.ts'], 'locales/pt': ['dist/src/locales/pt.d.ts'] },
    });
  });
  it('has the lazy ./locales/es and ./locales/pt subpaths (ESM and types only, with typesVersions), and the main entry does not point at them', () => {
    for (const name of ['@chatwarden/hub-react', '@chatwarden/player-react']) {
      const pkg = published.find((p) => p.pkg.name === name)!.pkg as Manifest & { exports?: Record<string, unknown>; typesVersions?: { '*': Record<string, string[]> } };
      for (const l of ['es', 'pt']) {
        expect(pkg.exports?.[`./locales/${l}`], `${name} ${l}`).toEqual({ types: `./dist/src/locales/${l}.d.ts`, default: `./dist/src/locales/${l}.js` });
        expect(pkg.typesVersions?.['*'][`locales/${l}`], `${name} ${l} typesVersions`).toEqual([`dist/src/locales/${l}.d.ts`]);
      }
      expect(JSON.stringify(pkg.exports?.['.']), name).not.toContain('locales');
    }
  });
  it('dev-depends on the kit the tests run on and on the test tools, not as peers', () => {
    for (const d of ['@chatwarden/matcher', '@chatwarden/store-memory', 'react', 'react-dom', 'axe-core', 'jsdom', '@testing-library/react', '@testing-library/user-event']) {
      expect(hub().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('player-react', () => {
  const player = (): Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> } =>
    published.find((p) => p.pkg.name === '@chatwarden/player-react')!.pkg as Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> };
  it('peers on react, react-dom and core only, at the hub ranges; bundles none of them', () => {
    expect(Object.keys(player().peerDependencies ?? {}).sort()).toEqual(['@chatwarden/core', 'react', 'react-dom']);
    expect(player().peerDependencies?.react).toBe('^18.3.0 || ^19.0.0');
    expect(player().peerDependencies?.['react-dom']).toBe('^18.3.0 || ^19.0.0');
    expect(player().peerDependencies?.['@chatwarden/core']).toBe('^0.2.1');
    expect(player().dependencies).toBeUndefined();
  });
  it('ships the stylesheets as ./styles.css and ./chat.css and lists only those two under sideEffects', () => {
    expect(player().exports?.['./styles.css']).toBe('./src/styles.css');
    expect(player().exports?.['./chat.css']).toBe('./src/chat.css');
    expect(player().sideEffects).toEqual(['./src/styles.css', './src/chat.css']);
  });
  it('has the lazy ./chat subpath, with types for both resolution modes, and the main entry does not point at it', () => {
    const pkg = player() as Manifest & { exports?: Record<string, { types?: string; default?: string } | string>; typesVersions?: { '*': Record<string, string[]> } };
    const chat = pkg.exports?.['./chat'] as { types?: string; default?: string } | undefined;
    expect(chat?.default).toMatch(/chat\/index\.js$/);
    expect(chat?.types).toMatch(/chat\/index\.d\.ts$/);
    expect(pkg.typesVersions?.['*'].chat?.[0]).toBe(chat?.types?.replace(/^\.\//, ''));
    expect(JSON.stringify(pkg.exports?.['.'])).not.toContain('chat');
  });
  it('has the lazy ./appeal subpath (the appeal page), with types for both resolution modes, and the main entry does not point at it', () => {
    const pkg = player() as Manifest & { exports?: Record<string, { types?: string; default?: string } | string>; typesVersions?: { '*': Record<string, string[]> } };
    const appeal = pkg.exports?.['./appeal'] as { types?: string; default?: string } | undefined;
    expect(appeal?.default).toBe('./dist/src/appeal/index.js');
    expect(appeal?.types).toBe('./dist/src/appeal/index.d.ts');
    expect(pkg.typesVersions?.['*'].appeal?.[0]).toBe(appeal?.types?.replace(/^\.\//, ''));
    expect(JSON.stringify(pkg.exports?.['.'])).not.toContain('appeal');
  });
  it('dev-depends on the kit the tests run on, on hub-react for the transport type check, and on the test tools, not as peers', () => {
    for (const d of ['@chatwarden/http', '@chatwarden/store-memory', '@chatwarden/hub-react', 'react', 'react-dom', 'axe-core', 'jsdom', '@testing-library/react', '@testing-library/user-event']) {
      expect(player().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('hub-element', () => {
  const element = (): Manifest & { sideEffects?: unknown; exports?: Record<string, unknown>; files?: string[] } =>
    published.find((p) => p.pkg.name === '@chatwarden/hub-element')!.pkg as Manifest & { sideEffects?: unknown; exports?: Record<string, unknown>; files?: string[] };
  it('bundles React, react-dom, hub-react and the part of core it needs: no react peer, no dependency, hub-react only as an optional peer for the types', () => {
    expect(Object.keys(element().peerDependencies ?? {})).toEqual(['@chatwarden/hub-react']);
    expect(element().peerDependencies?.['@chatwarden/hub-react']).toBe('^0.2.2');
    expect(element().peerDependenciesMeta?.['@chatwarden/hub-react']).toEqual({ optional: true });
    expect(element().dependencies).toBeUndefined();
  });
  it('ships the module as . and the self-registering script as ./standalone, each with types, and lists the script under sideEffects', () => {
    expect(element().exports?.['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/index.js' });
    expect(element().exports?.['./standalone']).toEqual({ types: './dist/src/standalone.d.ts', default: './dist/hub-element.js' });
    expect(element().sideEffects).toEqual(['./dist/hub-element.js']);
  });
  it('builds its scripts in prepack, after tsc, and ships both', () => {
    expect((element() as { scripts?: Record<string, string> }).scripts?.prepack).toBe('tsc -b && node build/build.mjs');
    expect(element().files).toContain('dist/hub-element.js');
    expect(element().files).toContain('dist/index.js');
    expect(element().files).toContain('dist/THIRD_PARTY_NOTICES.txt');
  });
  it('dev-depends on what it bundles and on the tools that build and test it, not as peers', () => {
    for (const d of ['@chatwarden/core', '@chatwarden/http', '@chatwarden/hub-react', '@chatwarden/matcher', '@chatwarden/store-memory', 'react', 'react-dom', 'esbuild', 'jsdom', 'playwright', '@testing-library/dom', '@testing-library/user-event']) {
      expect(element().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('tiny-chat example', () => {
  const tiny = readJson<Manifest>('examples', 'tiny-chat', 'package.json');
  it('is private and named as the changeset config expects', () => {
    expect(tiny.private).toBe(true);
    expect(tiny.name).toBe('@chatwarden/example-tiny-chat');
  });
  it('depends on every published server package as a regular dependency at the group version (the React packages are for a front end)', () => {
    for (const n of names.filter((n) => !UI_PACKAGES.has(n))) expect(tiny.dependencies?.[n]).toBe(VERSION);
  });
  it('serves the hub from @chatwarden/hub-element, the one script tag that needs no React build, and so does not depend on hub-react', () => {
    expect(tiny.dependencies?.['@chatwarden/hub-element']).toBe(VERSION);
    expect(tiny.dependencies?.['@chatwarden/hub-react']).toBeUndefined();
  });
  it('builds its chat page with the player UI: player-react at the group version, react and react-dom, and esbuild to bundle them (for that page, not the hub)', () => {
    expect(tiny.dependencies?.['@chatwarden/player-react']).toBe(VERSION);
    expect(tiny.dependencies?.react).toBeDefined();
    expect(tiny.dependencies?.['react-dom']).toBeDefined();
    expect(tiny.dependencies?.esbuild).toBeDefined();
  });
  it('stays private and ignored by changesets, so its React dependency never reaches a tarball', () => {
    const config = readJson<{ ignore: string[] }>('.changeset', 'config.json');
    expect(tiny.private).toBe(true);
    expect(config.ignore).toContain('@chatwarden/example-tiny-chat');
  });
});

describe('ai-anthropic example', () => {
  const ai = readJson<Manifest>('examples', 'ai-anthropic', 'package.json');
  it('is private, named as the changeset config expects, and not a published package', () => {
    expect(ai.private).toBe(true);
    expect(ai.name).toBe('@chatwarden/example-ai-anthropic');
    expect(names).not.toContain(ai.name);
  });
  it('takes the provider SDK as its own pinned dependency and core only as a dev dependency', () => {
    expect(ai.dependencies?.['@anthropic-ai/sdk']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ai.dependencies?.['@chatwarden/core']).toBeUndefined();
    expect(ai.devDependencies?.['@chatwarden/core']).toBe(VERSION);
  });
});

describe('recipes example', () => {
  const recipes = readJson<Manifest>('examples', 'recipes', 'package.json');
  it('is private, named as the changeset config expects, and not a published package (the release must add no package)', () => {
    expect(recipes.private).toBe(true);
    expect(recipes.name).toBe('@chatwarden/example-recipes');
    expect(names).not.toContain(recipes.name);
    expect(recipes.version).toBe('0.0.0');
  });
  it('depends on the ten published packages at the group version and on the frameworks it runs the goldens against', () => {
    for (const n of names) expect(recipes.dependencies?.[n], n).toBe(VERSION);
    for (const dep of ['fastify', 'socket.io', 'socket.io-client', 'react', 'react-dom', '@types/react', '@types/react-dom', 'express']) {
      expect(recipes.devDependencies?.[dep], dep).toBeDefined();
    }
  });
});

describe('changesets config', () => {
  const config = readJson<{ fixed: string[][]; ignore: string[]; linked: string[][] }>('.changeset', 'config.json');
  it('versions every @chatwarden package together', () => {
    expect(config.fixed).toEqual([['@chatwarden/*']]);
  });
  it('ignores the example and the landing site (private, never versioned or published)', () => {
    expect(config.ignore).toEqual(['@chatwarden/example-ai-anthropic', '@chatwarden/example-tiny-chat', '@chatwarden/example-recipes', '@chatwarden/corpus-service', '@chatwarden/site']);
  });
  it('has no linked groups', () => {
    expect(config.linked).toEqual([]);
  });
  it('ignores only private packages', () => {
    const tiny = readJson<Manifest>('examples', 'tiny-chat', 'package.json');
    const ai = readJson<Manifest>('examples', 'ai-anthropic', 'package.json');
    const recipes = readJson<Manifest>('examples', 'recipes', 'package.json');
    const site = readJson<Manifest>('site', 'package.json');
    const service = readJson<Manifest>('services', 'corpus', 'package.json');
    expect(config.ignore).toEqual([ai.name, tiny.name, recipes.name, service.name, site.name]);
    expect(service.private).toBe(true);
    expect(recipes.private).toBe(true);
    expect(ai.private).toBe(true);
    expect(tiny.private).toBe(true);
    expect(site.private).toBe(true);
    expect(site.name).toBe('@chatwarden/site');
  });
  it('keeps the corpus service private, out of the published set, and on the group version of the matcher it builds on (so npm links the workspace)', () => {
    const service = readJson<Manifest>('services', 'corpus', 'package.json');
    expect(names).not.toContain(service.name);
    expect(service.private).toBe(true);
    expect(service.dependencies?.['@chatwarden/matcher']).toBe(VERSION);
  });
  it('keeps the landing site out of the published package set', () => {
    expect(names).not.toContain('@chatwarden/site');
  });
});
