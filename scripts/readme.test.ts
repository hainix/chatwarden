import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSnippets } from './snippetCompile.js';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { badWords } from './no-corpus-data.mjs';
import { ATTRIBUTION } from '../services/corpus/src/build/texts.js';
import { LIMITS } from '../services/corpus/src/counters.js';
import { EVAL_USAGE } from '../services/corpus/src/tools/evalset.js';
import { KEYGEN_USAGE } from '../services/corpus/src/tools/keygen.js';
import { PUBLISH_USAGE } from '../services/corpus/src/tools/publish.js';
import { RELEASE_USAGE } from '../services/corpus/src/tools/release.js';
import { SEED_USAGE } from '../services/corpus/src/tools/seed.js';
import { SIGN_USAGE } from '../services/corpus/src/tools/sign.js';
import { VERIFY_USAGE } from '../services/corpus/src/tools/verifyLive.js';
import { ZENODO_USAGE } from '../services/corpus/src/tools/zenodo.js';

// The READMEs are the product an adopter (or a coding agent) copies from. These checks hold for EVERY published package:
// each has the sections an adopter needs, installs what it needs, and every ```ts block compiles against the real sources.
// What one package's README must say about that package (the http routes, the discord setup) lives beside that package.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

interface Manifest {
  name: string;
  private?: boolean;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'packages', d.name, 'package.json')))
  .map((d) => d.name)
  .sort();
const manifests = new Map(dirs.map((d) => [d, JSON.parse(read('packages', d, 'package.json')) as Manifest]));
const published = dirs.filter((d) => manifests.get(d)?.private !== true);
const readme = (dir: string): string => read('packages', dir, 'README.md');

/** The text of a `## Heading` section, up to the next `## ` heading. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}
/** Prose with its line breaks folded away, so a sentence can be asserted however the README wraps it. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const cells = (row: string): string[] => row.split('|').slice(1, -1).map((c) => c.trim());
const rows = (text: string): string[][] => text.split('\n').filter((l) => l.startsWith('|') && !/^\|[ |-]+\|$/.test(l)).map(cells);

const MARKETING = /\b(blazing|seamless|powerful|robust|world-class|cutting-edge|revolutionary)\b/i;
const NEW_FOUR = ['core', 'store-sqlite', 'store-memory', 'matcher', 'profanity'];
const REPO = 'https://github.com/hainix/chatwarden';

describe('every published package has a README', () => {
  it('covers the ten packages', () => {
    expect(published).toEqual(['core', 'discord', 'http', 'hub-element', 'hub-react', 'matcher', 'player-react', 'profanity', 'store-memory', 'store-sqlite']);
  });

  it.each(published)('%s: is titled with its package name, with a status line and no marketing words', (dir) => {
    const doc = readme(dir);
    expect(doc.startsWith(`# @chatwarden/${dir}\n`)).toBe(true);
    expect(doc).toMatch(/^Status: pre-release, as-is, no support promise\.$/m);
    expect(doc).not.toMatch(MARKETING);
  });

  it.each(published)('%s: the Install block installs the package and every required peer', (dir) => {
    const doc = readme(dir);
    const install = section(doc, 'Install');
    const commands = [...install.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] as string).join('\n');
    expect(commands, 'an npm install command').toMatch(/^npm install /m);
    const m = manifests.get(dir) as Manifest;
    expect(commands).toContain(m.name);
    for (const peer of Object.keys(m.peerDependencies ?? {})) {
      if (m.peerDependenciesMeta?.[peer]?.optional === true) continue;
      expect(commands, `peer ${peer}`).toContain(peer);
    }
    expect(install).toMatch(/Node 22\.13 or newer/);
  });

  it.each(published)('%s: never names Node 22.12 as the floor (engines and CI say 22.13)', (dir) => {
    expect(readme(dir)).not.toMatch(/22\.12/);
  });

  it.each(published)('%s: has at least one ```ts snippet that is a whole program', (dir) => {
    expect(readme(dir)).toMatch(/```ts\nimport /);
  });
});

describe('the new package READMEs', () => {
  it.each(NEW_FOUR)('%s: has install, quick start, options, security notes and links, in that order', (dir) => {
    const doc = readme(dir);
    const order = ['## Install', '## Quick start', '## Options', '## Security notes', '## Links'].map((h) => doc.indexOf(`\n${h}\n`));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it.each(NEW_FOUR)('%s: every link is absolute, so it works on the npm page', (dir) => {
    const doc = readme(dir);
    const targets = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
    expect(targets.length).toBeGreaterThan(2);
    for (const t of targets) expect(t, t).toMatch(/^https:\/\//);
    const links = section(doc, 'Links');
    expect(links).toContain(`${REPO}/blob/main/LICENSE`);
    expect(links).toContain(`${REPO}/tree/main/packages/http`);
    expect(links).toContain(`${REPO}/issues`);
  });

  it('core: says what is hashed, what is never logged, and the staff-only rule for subject ids', () => {
    const notes = flat(section(readme('core'), 'Security notes'));
    expect(notes).toMatch(/HMAC-SHA256/);
    expect(notes).toMatch(/client key/);
    expect(notes).toMatch(/IP address/);
    expect(notes).toMatch(/account id[^.]*(not|never)\s+hashed/i);
    expect(notes).toMatch(/never log/i);
    expect(notes).toMatch(/error class/);
    expect(notes).toMatch(/subject id/i);
    expect(notes).toMatch(/staff/);
    expect(notes).toMatch(/never (send|show)[^.]*player/i);
    expect(notes).toMatch(/secret/);
  });

  it('core: the options table lists every ChatwardenOptions field', () => {
    const src = read('packages/core/src/chatwarden.ts');
    const body = /export interface ChatwardenOptions \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    expect(fields.length).toBeGreaterThan(12);
    const table = rows(section(readme('core'), 'Options')).map((r) => r[0]);
    for (const f of fields) expect(table, f).toContain(`\`${f}\``);
  });

  it('core: shows the typing-indicator lookup and says it reveals nothing about other people', () => {
    const doc = flat(section(readme('core'), 'Typing indicators'));
    expect(doc).toContain('cw.chat.restricted(who, { roomId, seatId })');
    expect(doc).toMatch(/same decision as `accept`/);
    expect(doc).toMatch(/both `roomId` and `seatId`/);
    expect(doc).toMatch(/never a key or account the client sent/);
    expect(doc).toMatch(/after `cw\.rooms\.seat`/);
    expect(doc).toMatch(/`gate` option is not consulted/);
    expect(doc).toMatch(/reveals nothing about anyone else/);
    expect(doc).toMatch(/\{ restricted: true, until: null, kind: null \}/);
  });

  it('store-sqlite: documents path and db, the kit_ tables, hashing and what retention does not purge', () => {
    const raw = readme('store-sqlite');
    const doc = flat(raw);
    expect(doc).toMatch(/\{ path: /);
    expect(doc).toMatch(/\{ db: /);
    expect(doc).toContain('kit_');
    expect(doc).toContain('node:sqlite');
    const notes = flat(section(raw, 'Security notes'));
    expect(notes).toMatch(/hash/i);
    expect(notes).toMatch(/subject id/i);
    expect(notes).toMatch(/staff/);
    expect(notes).toMatch(/never log/i);
    expect(notes).toMatch(/not purged|not removed by `purge/);
  });

  it('store-memory: says plainly it is memory only, lost on restart, and what it is for', () => {
    const raw = readme('store-memory');
    const doc = flat(raw);
    expect(doc).toContain('MemoryStore');
    expect(doc).toContain('createMemoryStore');
    expect(doc).toMatch(/lost (when|on)[^.]*(restart|exit|stops)/i);
    expect(doc).toMatch(/tests?, demos? and single-process prototypes/i);
    expect(doc).toMatch(/not (for|a) production|do not use[^.]*production/i);
    expect(doc).toMatch(/@chatwarden\/store-sqlite/);
    expect(doc).toMatch(/no `node:` (import|module)|imports? no `node:`/i);
    const notes = flat(section(raw, 'Security notes'));
    expect(notes).toMatch(/never log/i);
    expect(notes).toMatch(/subject id/i);
    expect(notes).toMatch(/staff/);
    expect(notes).toMatch(/retention|purge/i);
    expect(notes).toMatch(/no timer|does not run|nothing purges|only[^.]*when core calls/i);
    expect(notes).toMatch(/same store contract|contract suite/i);
  });

  it('matcher: explains /fixtures, the deprecated /test-fixtures, and where the community corpus lives', () => {
    const raw = readme('matcher');
    const doc = flat(raw);
    expect(doc).toContain('@chatwarden/matcher/fixtures');
    expect(doc).toContain('@chatwarden/matcher/test-fixtures');
    expect(doc).toMatch(/deprecated/i);
    expect(doc).toMatch(/invented/);
    expect(doc).toMatch(/hosted separately/);
    expect(doc).toMatch(/not in this repository/);
    expect(doc).toMatch(/no real (slur|term)|never[^.]*real slur/i);
    const notes = flat(section(raw, 'Security notes'));
    expect(notes).toMatch(/never log/i);
    expect(notes).toMatch(/term id/);
  });

  it('matcher: documents positiveCorpus, the refusal codes, the Sync APIs, the audit names and how to read term history', () => {
    const doc = flat(readme('matcher'));
    expect(doc).toContain('positiveCorpus');
    for (const code of ['duplicate', 'unblocks_known', 'invalid', 'not_found', 'not_loaded', 'build_failed']) {
      expect(doc, code).toContain(`\`${code}\``);
    }
    expect(doc).toContain('loadSync()');
    expect(doc).toContain('changeSync(');
    for (const name of ['term.add', 'term.update', 'term.toggle', 'exception.add', 'exception.update', 'exception.toggle']) {
      expect(doc, name).toContain(`\`${name}\``);
    }
    expect(doc).toContain("cw.audit.list({ action: 'term.add'");
    expect(doc).toMatch(/after_json\.active/);
    // The Sync boot and the refusal code are shown as real code, which the compile check further down covers.
    const code = [...readme('matcher').matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string).filter((c) => c.startsWith('import '));
    expect(code.some((c) => c.includes('loadSync()') && c.includes('changeSync(') && c.includes('.code'))).toBe(true);
  });

  it('matcher: its examples use only the invented fixture terms', () => {
    const synthetic = new Set(
      [...read('packages/matcher/src/fixtures/syntheticPack.ts').matchAll(/term: '([a-z]+)'/g)].map((m) => m[1] as string),
    );
    expect(synthetic.has('zorbak')).toBe(true);
    const quoted = [...readme('matcher').matchAll(/(?:match|spans|matchName|check)\('([^']*)'/g)].map((m) => m[1] as string);
    expect(quoted.length).toBeGreaterThan(0);
    // Every checked line either contains an invented term or is plainly innocent.
    const innocent = new Set(['hello', 'everyone', 'good', 'game', 'you', 'are', 'a', 'the', 'nice', 'one']);
    for (const line of quoted) {
      const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
      expect(words.some((w) => synthetic.has(w)) || words.every((w) => innocent.has(w)), line).toBe(true);
    }
  });

  it('profanity: shows the config, ordinary swearing only, and that slurs are the matcher job', () => {
    const raw = readme('profanity');
    const doc = flat(raw);
    expect(doc).toContain('createProfanityFilter');
    expect(doc).toContain('ProfanityConfigError');
    expect(doc).toMatch(/ordinary swearing/i);
    expect(doc).toMatch(/not slur protection|slurs[^.]*matcher/i);
    for (const option of ['mode', 'style', 'add', 'remove', 'only', 'languages']) {
      expect(rows(section(raw, 'Options')).some((r) => r[0] === `\`${option}\``), option).toBe(true);
    }
    expect(flat(section(raw, 'Security notes'))).toMatch(/never log/i);
  });
});

describe('the root README', () => {
  const doc = read('README.md');

  it('has an install matrix: what you want to do, and what to install for it', () => {
    const table = rows(section(doc, 'Install'));
    expect(table[0]).toEqual(['I want to', 'Install']);
    const installs = table.slice(1).map((r) => r[1] as string);
    for (const dir of published) expect(installs.join('\n'), dir).toContain(`@chatwarden/${dir}`);
    expect(installs.length).toBeGreaterThanOrEqual(4);
    expect(section(doc, 'Install')).toMatch(/peer dependenc/i);
  });

  it('says core is a peer of every package except hub-element (which bundles what it needs), and that hub-react is its optional peer for types', () => {
    const install = flat(section(doc, 'Install'));
    expect(install).toMatch(/`@chatwarden\/core` is a peer dependency of every other package except `@chatwarden\/hub-element`/);
    expect(install).toMatch(/`@chatwarden\/hub-element` bundles React and what it needs of the kit/);
    expect(install).toMatch(/`@chatwarden\/hub-react` is an optional peer, for TypeScript types only/);
  });

  it('installs @types/express next to express for the HTTP routes, and says why', () => {
    const http = rows(section(doc, 'Install')).find((r) => (r[0] ?? '').startsWith('Give moderators and players HTTP routes'));
    expect(http?.[1]).toContain('npm install @chatwarden/http express @types/express');
    expect(flat(section(doc, 'Install'))).toMatch(/Express 5 ships no types/);
  });

  it('has a CommonJS note: require() of ESM on Node 22.13 or newer, and typesVersions for subpaths', () => {
    const cjs = section(doc, 'CommonJS');
    expect(cjs).toMatch(/Node 22\.13 or newer/);
    expect(doc).not.toMatch(/22\.12/);
    expect(cjs).toContain('require(');
    expect(cjs).toContain('typesVersions');
    expect(cjs).toContain('moduleResolution: node');
    expect(cjs).toMatch(/no top-level `await`/);
  });

  it('states Node support: 22.13 and 24, tested in CI', () => {
    const node = section(doc, 'Node support');
    expect(node).toMatch(/22\.13/);
    expect(node).toMatch(/\b24\b/);
    expect(node).toMatch(/CI/);
  });

  it('links RELEASING.md and the Moxgate adoption example', () => {
    expect(doc).toContain('](RELEASING.md)');
    expect(doc).toContain('](docs/adoption/moxgate.md)');
    expect(existsSync(join(root, 'RELEASING.md'))).toBe(true);
    // docs/adoption/moxgate.md arrives with main; this branch may predate it, so only the link is checked here.
  });

  it('uses no marketing words', () => {
    expect(doc).not.toMatch(MARKETING);
  });
});

describe('the http README Install section', () => {
  const install = section(readme('http'), 'Install');
  it('installs @types/express with express (TypeScript), and says Express 5 ships no types', () => {
    expect(install).toMatch(/^npm install express @types\/express/m);
    expect(flat(install)).toMatch(/Express 5 ships no types/);
  });
});

describe('RELEASING.md', () => {
  const doc = read('RELEASING.md');
  it('gives the owner setup and the per-release steps, in plain words', () => {
    for (const heading of ['## One-time setup (the owner)', '## Each release', '## Running a dry run', '## Before the first publish: vendoring tarballs']) {
      expect(doc, heading).toContain(heading);
    }
    for (const needle of ['@chatwarden', 'NPM_TOKEN', 'v*', 'trusted publishing', 'npx changeset', 'npm run version', 'scripts/sync-version.mjs', 'tiny-chat', 'git tag v', 'dry_run=true', 'node scripts/smoke.mjs', '.smoke/tarballs', 'overrides', 'file:']) {
      expect(doc, needle).toContain(needle);
    }
  });
  it('puts making the repository public first in the one-time setup, with the reason', () => {
    const setup = section(doc, 'One-time setup (the owner)');
    const first = /^1\. (.*(?:\n(?! {0,3}\d+\. ).*)*)/m.exec(setup)?.[1] ?? '';
    expect(first).toContain('make hainix/chatwarden public');
    expect(flat(first)).toMatch(/provenance/);
    expect(flat(first)).toMatch(/tag ruleset/i);
    expect(flat(first)).toMatch(/free plan/i);
  });
  it('recommends a granular token scoped to @chatwarden that bypasses 2FA, and points at trusted publishing and the current npm docs', () => {
    const setup = flat(section(doc, 'One-time setup (the owner)'));
    expect(setup).toMatch(/granular access token/i);
    expect(setup).toMatch(/scoped to the `@chatwarden` org/);
    expect(setup).toMatch(/publish/i);
    expect(setup).toMatch(/bypass 2FA/i);
    expect(setup).toMatch(/trusted publishing \(OIDC\)/);
    expect(setup).toMatch(/check npm's current docs/i);
    expect(setup).not.toMatch(/classic/i);
  });
  it('counts ten packages and names all of them, in publish order, wherever it lists them', () => {
    const text = flat(doc);
    expect(text).toMatch(/Ten packages are published/);
    expect(text).not.toMatch(/\bseven\b/i);
    expect(text).toMatch(/all ten/);
    for (const name of ['core', 'store-memory', 'matcher', 'store-sqlite', 'profanity', 'http', 'discord', 'hub-react', 'player-react', 'hub-element']) {
      expect(text, name).toContain(`\`${name}\``);
    }
    expect(text).toContain('(`core`, `store-memory`, `matcher`, `store-sqlite`, `profanity`, `http`, `discord`, `hub-react`, `player-react`, `hub-element`)');
  });
  it('says the three new packages are published once with the token, then get a Trusted Publisher', () => {
    const text = flat(section(doc, 'New packages: the first publish'));
    for (const name of ['hub-react', 'player-react', 'hub-element']) expect(text, name).toContain(`\`${name}\``);
    expect(text).toMatch(/only lets you add a Trusted Publisher to a package that exists/);
    expect(text).toMatch(/first version goes out with the token/);
    expect(text).toMatch(/add the Trusted Publisher/);
  });
  // The workflow uses NPM_TOKEN whenever the secret exists, so OIDC is never exercised while it is set. The order is: remove the
  // GitHub secret (keep the npm token, unrevoked, as the fallback), release once through OIDC, then revoke the token and disallow
  // tokens. The old "keep the secret until OIDC has published" could never complete.
  it('removes the GitHub secret to exercise OIDC, keeps the npm token until a release has published through it, then locks tokens out', () => {
    const text = flat(section(doc, 'One-time setup (the owner)'));
    expect(text).toMatch(/while the secret is set, trusted publishing is never used/i);
    expect(text).toMatch(/delete the `NPM_TOKEN` secret on GitHub but do not revoke the token on npm yet/i);
    expect(text).toMatch(/disallow tokens/i);
    expect(text).not.toMatch(/Keep the `NPM_TOKEN` secret until a release has actually published through OIDC/);
    expect(text).not.toMatch(/Then delete the `NPM_TOKEN` secret/);
  });
  it('explains when a peer floor must rise, and that this overrides onlyUpdatePeerDependentsWhenOutOfRange', () => {
    const text = flat(doc);
    expect(text).toContain('### When a peer floor must rise');
    const note = text.slice(text.indexOf('### When a peer floor must rise'));
    expect(note).toMatch(/deliberately overrides `onlyUpdatePeerDependentsWhenOutOfRange`/);
    for (const api of ['cw.policy', 'ResolvedProfile', 'reportedReason', 'addDetail', 'releaseWhenDone', 'detailUntil']) expect(note.slice(0, 1600), api).toContain(api);
    expect(note).toContain('scripts/manifests.test.ts');
  });
  it('tells the releaser that every peer range is ^0.2.0, that the next 0.x minor falls outside them, and to set the ranges by hand before npm run version', () => {
    const text = flat(doc);
    expect(text).toMatch(/Every `@chatwarden\/\*` peer range is `\^0\.2\.0` since 0\.2\.0/);
    expect(text).toMatch(/The next 0\.x minor \(0\.3\.0\) falls outside every `\^0\.2\.x` peer range/);
    expect(text).toMatch(/set every peer range to `\^0\.3\.0` by hand first/);
    expect(text).toMatch(/For a 0\.x minor, set every range to the new minor before `npm run version`/);
  });
  it('says 0.2.1 raised six floors by hand (so it stayed a patch), that the table lives in scripts/manifests.test.ts, and that every other peer stays ^0.2.0', () => {
    const text = flat(doc);
    expect(text).toMatch(/0\.2\.1 was that case again/);
    expect(text).toMatch(/six peer ranges/);
    expect(text).toContain('the table of floors is in `scripts/manifests.test.ts`');
    expect(text).toMatch(/the stores, `matcher`, `profanity` and the optional peers of `http` stay at `\^0\.2\.0`/);
    expect(text).toMatch(/set (them|the ranges) by hand before `npm run version`/);
    expect(text).not.toContain('every `@chatwarden/*` peer is `^0.2.0`)');
  });
  it('says http does not dev-depend on hub-element and that an optional peer is never imported statically', () => {
    const text = flat(doc);
    expect(text).toContain('`http` does not dev-depend on `hub-element`');
    expect(text).toContain('scripts/http-optional-peers.test.ts');
  });
  it('documents the provenance input of the workflow', () => {
    expect(flat(doc)).toMatch(/provenance=false/);
  });
  it('has a Docker note for vendoring: copy vendor/ before npm install, list core and matcher as direct file: deps under legacy-peer-deps', () => {
    const vendoring = section(doc, 'Before the first publish: vendoring tarballs');
    expect(vendoring).toContain('Docker');
    const docker = flat(vendoring.slice(vendoring.indexOf('Docker')));
    expect(docker).toContain('COPY vendor');
    expect(docker).toMatch(/before the first `npm install`/);
    expect(docker).toContain('legacy-peer-deps=true');
    expect(docker).toMatch(/peers are NOT auto-installed/);
    expect(docker).toContain('@chatwarden/core');
    expect(docker).toContain('@chatwarden/matcher');
  });
  it('the Docker example Dockerfile copies vendor/ before the install that reads it', () => {
    const block = /```dockerfile\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    const lines = block.split('\n');
    const copyVendor = lines.findIndex((l) => /^COPY vendor/.test(l));
    const firstInstall = lines.findIndex((l) => /npm (install|ci)/.test(l));
    expect(copyVendor).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThan(copyVendor);
  });
  it('the vendoring example is valid JSON that overrides core and matcher to the direct dependency', () => {
    const json = /```json\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    const parsed = JSON.parse(json) as { dependencies: Record<string, string>; overrides: Record<string, string> };
    expect(parsed.overrides['@chatwarden/core']).toBe('$@chatwarden/core');
    for (const v of Object.values(parsed.dependencies)) expect(v).toMatch(/^file:vendor\/chatwarden-[a-z-]+-\d+\.\d+\.\d+\.tgz$/);
  });
});

describe('every ```ts block in the READMEs compiles against the package sources', () => {
  const docs: Array<[string, string]> = [
    ...published.map((d): [string, string] => [d, readme(d)]),
    ['root', read('README.md')],
    ['tiny-chat', read('examples/tiny-chat/README.md')],
  ];
  const snippets = docs.flatMap(([name, text]) =>
    [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m, i) => ({ doc: name, file: `${name}-${i}.ts`, code: m[1] as string })),
  );

  // Names the snippets use but leave to the reader (their own login, their own term pack, ...).
  const STUBS = `
declare const yourTermPack: import('@chatwarden/matcher').TermPack;
declare function lookupStaffFromSession(cookie: string | undefined): Promise<{ email: string; role: 'moderator' | 'senior' | 'owner' } | null>;
declare function yourModeratorLogin(req: import('@chatwarden/http').KitRequest): { actor: string; role: 'moderator' | 'senior' | 'owner' } | null;
declare const secret: string;
declare const platform: import('@chatwarden/core').Platform;
declare const matcher: import('@chatwarden/core').Matcher;
declare const cw: import('@chatwarden/core').Chatwarden;
declare const authorize: import('@chatwarden/http').Authenticate;
declare const bot: import('@chatwarden/http/discord').DiscordBot;
`;
  /** A block that is a fragment (a bare option object, an override line) is not compiled on its own. */
  const standalone = (code: string): boolean => code.startsWith('import ');

  function compile(extra: Array<{ file: string; code: string }> = []): Map<string, string[]> {
    return compileSnippets([...snippets.filter((x) => standalone(x.code)), ...extra], STUBS);
  }

  it('finds the snippets it is meant to check, in every package README', () => {
    expect(snippets.length).toBeGreaterThanOrEqual(10);
    for (const dir of published) {
      expect(snippets.filter((s) => s.doc === dir && standalone(s.code)).length, dir).toBeGreaterThanOrEqual(1);
    }
    expect(snippets.some((s) => s.doc === 'root' && standalone(s.code))).toBe(true);
  });

  it('the readme code blocks for discordBot, registerCommands and the feed wiring are among them (so they compile with the rest)', () => {
    const fromHttp = snippets.filter((s) => s.doc === 'http' && standalone(s.code)).map((s) => s.code);
    expect(fromHttp.some((c) => c.includes('discordBot(cw, {') && c.includes('components: bot.components') && c.includes("from '@chatwarden/http/discord'"))).toBe(true);
    expect(fromHttp.some((c) => c.includes('await registerCommands({') && c.includes('commands: bot.commands()'))).toBe(true);
  });

  it('the readme code blocks for coop() and its signal option are among them (so they compile with the rest)', () => {
    const fromHttp = snippets.filter((s) => s.doc === 'http').map((s) => s.code);
    expect(fromHttp.some((c) => standalone(c) && c.includes('coop(cw, {') && c.includes('toExpress(adapter.routes)') && c.includes("from '@chatwarden/http/coop'"))).toBe(true);
    expect(fromHttp.some((c) => c.includes('signal: {') && c.includes('COOP_SIGNAL_SECRET'))).toBe(true);
  });

  it('the readme code block for eos() is among them (so it compiles with the rest)', () => {
    const fromHttp = snippets.filter((s) => s.doc === 'http').map((s) => s.code);
    expect(fromHttp.some((c) => standalone(c) && c.includes('eos(cw, {') && c.includes("from '@chatwarden/http/eos'") && c.includes('productUserIdsOf') && c.includes('seatOf'))).toBe(true);
  });

  it('all compile in one program, and a deliberate error is caught (control)', { timeout: 120_000 }, () => {
    const diagnostics = compile([{ file: 'control.ts', code: "const n: number = 'not a number';" }]);
    const control = diagnostics.get('control.ts');
    expect(control?.length, 'the control must fail to compile').toBe(1);
    expect(control?.[0]).toContain("Type 'string' is not assignable to type 'number'");
    diagnostics.delete('control.ts');
    expect(Object.fromEntries(diagnostics)).toEqual({});
  });
});

// AI levels 1 and 2 (0.1.7): where an adopter reads about them, and the one place that tells Moxgate how to turn them on.
describe('the AI sections', () => {
  it('core: the AI section says what it is, that it is off until an adapter is given, what it can never do, what it costs, and how to try it', () => {
    const doc = flat(section(readme('core'), 'The AI (levels 1 and 2)'));
    for (const needle of ['`ai`', '`ModerationAI`', '`createFakeModerationAI`', '0.1.7', '`AI_MAX_PREFILL_MS`', '`dailyBudgetMicros`', '`profile.ai.dailyCalls`', "`blockedLines: 'mask'`", 'examples/ai-anthropic', 'docs/adoption/moxgate.md', '`AIError`']) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).toMatch(/never writes a sanction, a strike, a mute or a notice/);
    expect(doc).toMatch(/Flags, mutes and report counts are never sent/);
    expect(doc).toMatch(/off until you give it an adapter/i);
    expect(doc).toMatch(/does not wait for the provider/i);
    expect(doc).toMatch(/loads the AI code only when/i);
  });

  it('core: the options table has the ai row, and the section links the adapter and the demo', () => {
    const table = rows(section(readme('core'), 'Options')).map((r) => r[0]);
    expect(table).toContain('`ai`');
    expect(flat(section(readme('core'), 'The AI (levels 1 and 2)'))).toContain('CW_DEMO_AI=1');
  });

  it('http: the AI routes are listed with their permissions and the four AI error codes', () => {
    const text = readme('http');
    const heading = '### The AI routes';
    const start = text.indexOf(`\n${heading}\n`);
    expect(start, 'the AI routes section').toBeGreaterThanOrEqual(0);
    const doc = flat(text.slice(start, text.indexOf('\n### ', start + 1)));
    for (const needle of ['`GET /ai/status`', '`POST /reports/:id/ai/read`', '`POST /reports/:id/ai/dont-teach`', '`policy.read`', '`reports.decide`', '`reasons.write`', '`ai_off`', '`ai_final`', '`ai_budget`', '`ai_unavailable`', '`ai.rerun`']) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).toMatch(/no route changes a setting/i);
  });

  it('hub-react: the AI section names the demo and the words loader', () => {
    const doc = flat(readme('hub-react'));
    expect(doc).toContain('### The AI (levels 1 and 2)');
    expect(doc).toContain('CW_DEMO_AI=1');
    expect(doc).toContain('loadAiWords()');
  });

  it('tiny-chat: documents CW_DEMO_AI, what it wires and that it is a demo', () => {
    const doc = flat(read('examples/tiny-chat/README.md'));
    expect(doc).toContain('## AI reads (demo, optional)');
    for (const needle of ['CW_DEMO_AI=1', '`createFakeModerationAI`', 'no key', 'no network', '`startServer({ demoAi })`']) expect(doc, needle).toContain(needle);
    expect(doc).toMatch(/It is a demo, not a moderator/);
  });

  it('moxgate: "Turning on AI reads" has the steps, the key, the limits, what is sent, and how to roll back', () => {
    const doc = flat(read('docs/adoption/moxgate.md'));
    expect(doc).toContain('## 9. Turning on AI reads (0.1.7)');
    for (const needle of ['examples/ai-anthropic', '@anthropic-ai/sdk', '`ANTHROPIC_API_KEY`', '`dailyBudgetMicros`', '`profile.ai.dailyCalls`', "`blockedLines: 'mask'`", 'Settings > AI', 'Migration 20', 'Rolling back']) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).toMatch(/Never sent: subject ids/);
    expect(doc).toMatch(/A line the word filter blocked is sent as typed/);
  });

  it('the status and the follow-ups name the work: K3c done, and every parked AI item', () => {
    expect(flat(read('docs/status.md'))).toMatch(/K3c: AI levels 1-2\*\* \(read and recommend\), \*\*done\*\*/);
    const parked = flat(read('docs/plans/follow-ups.md'));
    for (const item of ['Batch backfill', 'Blind sampling', '`byTag` scope', 'Signals as AI context', '"Do not automate"', 'Site wording']) expect(parked, item).toContain(item);
  });

  it('store-memory: the AI methods are opt-in through withMemoryAi, said plainly, with a snippet that compiles (it starts with an import)', () => {
    const doc = flat(readme('store-memory'));
    expect(doc).toContain('## The AI methods (opt-in)');
    for (const needle of ['`withMemoryAi(store)`', '`createMemoryStore()`', '`chatwarden.ai_store_unsupported`', 'SQLite store has them']) expect(doc, needle).toContain(needle);
    expect(doc).toMatch(/leaves the AI inert/i);
    expect(doc).toMatch(/does not carry them/i);
    expect(readme('store-memory')).toMatch(/```ts\nimport [^\n]*\n[^`]*import \{[^}]*withMemoryAi[^}]*\} from '@chatwarden\/store-memory';/);
  });

  it('store-memory: the test kit says first that it is not for production, names its entry, its plain errors, and its example starts with an import', () => {
    const raw = readme('store-memory');
    const section = raw.slice(raw.indexOf('## The test kit'));
    expect(section.length).toBeGreaterThan(500);
    const doc = flat(section);
    expect(doc.indexOf('Not for production')).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf('Not for production')).toBeLessThan(80);
    for (const needle of ['@chatwarden/store-memory/testing', 'ScriptMismatch', 'createTestKit', 'kit.play', 'checkLines', 'no `node:` import', 'invented']) expect(doc, needle).toContain(needle);
    expect(section).toMatch(/```ts\nimport \{[^}]*createTestKit[^}]*\} from '@chatwarden\/store-memory\/testing';/);
  });

  it('store-memory: the signal methods are opt-in through withMemorySignals, said plainly, with a snippet that compiles (it starts with an import)', () => {
    const doc = flat(readme('store-memory'));
    expect(doc).toContain('## The signal methods (opt-in)');
    for (const needle of ['`withMemorySignals(store)`', '`createMemoryStore()`', '`chatwarden.signals_store_unsupported`', 'SQLite store has them', 'refused when it is created']) expect(doc, needle).toContain(needle);
    expect(doc).toMatch(/does not carry them/i);
    expect(readme('store-memory')).toMatch(/```ts\nimport [^\n]*\n[^`]*import \{[^}]*withMemorySignals[^}]*\} from '@chatwarden\/store-memory';/);
  });

  it('core: a store without the AI methods leaves the AI inert and says so once; it does not throw', () => {
    const doc = flat(section(readme('core'), 'The AI (levels 1 and 2)'));
    expect(doc).toContain('`chatwarden.ai_store_unsupported`');
    expect(doc).toContain('`withMemoryAi(store)`');
    expect(doc).not.toMatch(/makes `createChatwarden` throw/);
  });

  it('follow-ups: the memory store move is recorded as resolved', () => {
    expect(flat(read('docs/plans/follow-ups.md'))).toMatch(/\*\*Done: the memory store's AI methods are opt-in\.\*\*/);
  });
});

describe('the chat box docs', () => {
  const httpDoc = readme('http');
  const playerDoc = readme('player-react');
  /** The names an entry file exports, by kind. */
  const names = (src: string, kind: 'value' | 'type'): string[] =>
    [...src.matchAll(/^export (type )?\{([^}]*)\}/gm)]
      .filter((m) => (kind === 'type') === (m[1] !== undefined))
      .flatMap((m) => (m[2] as string).split(',').map((n) => n.trim().replace(/^type /, '')))
      .filter((n) => n !== '');
  /** The field names of an exported interface. */
  const fields = (src: string, iface: string): string[] => {
    const start = src.indexOf(`export interface ${iface}`);
    expect(start, iface).toBeGreaterThanOrEqual(0);
    const body = src.slice(src.indexOf('{', start), src.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
  };

  it('every documented option name exists: the broadcaster, the routes and the box props are all written down', () => {
    const broadcaster = fields(read('packages/http/src/chat/broadcaster.ts'), 'RoomBroadcasterOptions');
    const routes = fields(read('packages/http/src/chat/routes.ts'), 'ChatRoutesOptions');
    const props = fields(read('packages/player-react/src/chat/ChatBox.tsx'), 'ChatBoxProps');
    expect(broadcaster.length).toBeGreaterThan(8);
    expect(routes.length).toBeGreaterThan(5);
    expect(props.length).toBeGreaterThan(10);
    for (const f of broadcaster) expect(httpDoc, `RoomBroadcasterOptions.${f}`).toContain(`\`${f}\``);
    for (const f of routes) expect(httpDoc, `ChatRoutesOptions.${f}`).toContain(`\`${f}\``);
    // Each prop is in the first cell of a row of the props table (`container` and `returnFocusTo` share one row).
    const propRows = flat(section(playerDoc, 'The chat box'));
    for (const f of props) expect(propRows, `ChatBoxProps.${f}`).toContain(`\`${f}`);
  });

  it('the READMEs list the chat names, every one the entries export, and none is called experimental', () => {
    const httpEntry = read('packages/http/src/chat/index.ts');
    const httpNames = [...names(httpEntry, 'value'), ...names(httpEntry, 'type')].filter((n) => !['KitStream', 'NamesRateLimit'].includes(n));
    const httpChat = flat(section(httpDoc, 'Chat'));
    const httpList = httpChat.slice(httpChat.indexOf('**Names:**'));
    expect(httpNames.length).toBeGreaterThan(15);
    for (const n of httpNames) expect(httpList, n).toContain(`\`${n}\``);
    const playerEntry = read('packages/player-react/src/chat/index.ts');
    const playerNames = [...names(playerEntry, 'value'), ...names(playerEntry, 'type')];
    const playerList = flat(section(playerDoc, 'The chat box'));
    expect(playerNames.length).toBeGreaterThan(15);
    for (const n of playerNames) expect(playerList, n).toContain(`\`${n}\``);
    expect(playerList).not.toMatch(/@experimental/);
    expect(httpChat).not.toMatch(/@experimental/);
  });

  it('the root README adds chat to the install table and the package rows, with a short chat block that compiles', () => {
    const rootDoc = read('README.md');
    expect(rootDoc).toMatch(/\| Add chat to a game that has none[^|]*\|[^|]*@chatwarden\/http[^|]*@chatwarden\/player-react/);
    expect(rootDoc).toMatch(/room broadcaster with chat routes/);
    expect(rootDoc).toMatch(/moderated `<ChatBox>` at its own lazy subpath/);
    const block = [...rootDoc.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string).find((c) => c.includes('createRoomBroadcaster'));
    expect(block, 'the quick-start chat block').toBeDefined();
    expect(block?.startsWith('import ')).toBe(true);
  });

  it('the project docs say it exists: status, follow-ups and CLAUDE.md', () => {
    expect(read('docs/status.md')).toMatch(/## Chat box/);
    expect(read('docs/plans/follow-ups.md')).toMatch(/Chat box on the site/);
    expect(read('docs/plans/follow-ups.md')).not.toMatch(/A `<ChatBox>` in player-react and a room broadcaster in http, so the page can promise chat/);
    const claude = read('CLAUDE.md');
    expect(claude).toContain('@chatwarden/http/chat');
    expect(claude).toContain('@chatwarden/player-react/chat');
  });

  it('the control: an option name the README does not have is not found', () => {
    expect(httpDoc).not.toContain('`definitelyNotAnOption`');
  });
});

describe('the flood control and signals docs (0.1.8)', () => {
  const core = flat(readme('core'));

  it('core: slow mode and flood control says what a refusal is, the order, the per-process limit and how to try it', () => {
    const doc = flat(section(readme('core'), 'Slow mode and flood control'));
    for (const needle of ['`overrides.pace`', '`cw.rooms.setPace`', 'cw.rooms.pace', "'slow_mode'", "'flood'", "'duplicate'", '`retryAfterMs`', 'A new refusal reason', '`assertNever`', 'Per process', '`PACE_KEYS_MAX`', '`flood_triggered`', '`CW_DEMO_PACE=1`', '`limits.chatRate`']) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).toMatch(/Route a room's chat to one process/);
    expect(doc).toMatch(/no rule, no notice/);
  });

  it('core: signals says a signal never acts, events not lines, the cap, the retention, migration 21 one-way with a back-up, and withMemorySignals', () => {
    const doc = flat(section(readme('core'), 'Signals'));
    for (const needle of ['never acts on its own', 'Events, not lines', '`cw.signals.record(input)`', 'distinct source', 'calendar bucket', '`retention.signalsMs`', 'migration 21', 'one-way', 'back up the database', '`withMemorySignals(store)`', '`chatwarden.signals_store_unsupported`', 'limits.signalsMs', 'Four feeds']) {
      expect(doc, needle).toContain(needle);
    }
    for (const feed of ['`record`', '`queue`', '`ladder`', '`ai`']) expect(doc, feed).toContain(feed);
  });

  it('core: the 0.1.8 list names the new API, and the table rows and retention default are there', () => {
    const doc = flat(section(readme('core'), 'What 0.1.8 added'));
    for (const needle of ['`PaceSettings`', '`PACE_SUGGESTIONS`', '`cw.rooms.setPace`', '`cw.signals`', '`PolicyLimits`', '`withMemorySignals`', '`secondsLeft`', '`signalBoost`']) expect(doc, needle).toContain(needle);
    expect(core).toContain('| `cw.signals` |');
    expect(core).toContain('signals 90 (`signalsMs`, never less than 14)');
  });

  it('http: the changed bodies are described (boosted, signals on the history and the suggestion, signalBoost, limits)', () => {
    const doc = flat(readme('http'));
    for (const needle of ['`boosted: true`', '`signals: { raised, ids }`', 'only for a caller whose role holds `history.read`', 'when the record feed (`feeds.record`) is on', '`limits`', '{ chatRate: { count, windowMs }, signalsMs }', 'older than 0.1.8 sends none']) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('player-react: one wait convention, said plainly (a bare duration, the sentence has the "in")', () => {
    const doc = flat(section(readme('player-react'), 'Pace words and `secondsLeft`'));
    for (const needle of ['bare duration', 'in {left}', '`secondsLeft(ms, locale)`', '`player.pace.ready`', '`.soon`', '`RestrictedChatLine`']) expect(doc, needle).toContain(needle);
    expect(doc).not.toMatch(/carry their own "in"/);
  });

  it('hub-react: the Advanced screen and the queue seam are documented', () => {
    const doc = flat(readme('hub-react'));
    for (const needle of ['#/settings/advanced', '`RankSignals.conduct`', '`QueueGroup.boosted`', '`conductSignal`']) expect(doc, needle).toContain(needle);
  });

  it('tiny-chat: the slow mode demo switch is documented', () => {
    const doc = flat(read('examples/tiny-chat/README.md'));
    for (const needle of ['## Slow mode (demo, optional)', '`CW_DEMO_PACE=1`', '`startServer({ demoPace })`']) expect(doc, needle).toContain(needle);
  });

  it('the control: a feature the docs do not have is not found', () => {
    expect(core).not.toContain('`definitelyNotAFeed`');
  });

  it('store-sqlite: migration 21 is described like 19 and 20, one-way with a back-up note, with the flood rows and the retention', () => {
    const doc = flat(readme('store-sqlite'));
    for (const needle of ['Migration 21 adds one table, `kit_signals`', '`kit_ai_reads.signals_json`', '`retention.signalsMs`', '`flood_triggered` rows by itself, with no signals declared', 'a 0.1.7 store refuses a database at version 21', 'back up the file before upgrading', 'signal rows']) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('core and every CHANGELOG say the AI prompt version 3 changes the hash and re-reads open reports against the daily caps', () => {
    const ai = flat(section(readme('core'), 'The AI (levels 1 and 2)'));
    for (const needle of ['prompt version is 4 for everyone (3 in 0.1.8)', 'changes the input hash', 'marked stale and read again, once per open report', 'daily call and money caps']) expect(ai, needle).toContain(needle);
    for (const dir of published) {
      const log = flat(read('packages', dir, 'CHANGELOG.md'));
      const at = log.indexOf('## 0.1.8');
      const text = log.slice(at, log.indexOf('## 0.1.7', at));
      expect(text, dir).toContain('Upgrade notes, the AI after upgrading');
      expect(text, dir).toContain('count against your daily call and money caps');
      expect(text, dir).toContain('`AiReadRow`');
    }
  });
});

describe('the appeals and names docs (0.1.9)', () => {
  const coreDoc = readme('core');
  const core = flat(coreDoc);
  const httpDoc = flat(readme('http'));
  const playerDoc = readme('player-react');
  const hubDoc = readme('hub-react');

  it('core: appeals says how to turn them on, what can be appealed, the statement rules, the order of refusals and who may decide', () => {
    const doc = flat(section(coreDoc, 'Appeals'));
    for (const needle of [
      '`overrides.appeals`', '`perPlayerPerWeek`', '`allowSelfReview`', '`appealUrl`', '`APPEAL_STATEMENT_MAX`', 'refused when over and never cut', '`normalizeStatement`',
      '`retention.appealStatementsMs`', '`retention.appealsMs`', '`cw.appeals.file(who, { noticeId, statement })`', '`not_found` (one answer', '`already_appealed`',
      '`same_decider`', '`already_decided`', '`gone`', '`moot`', 'keeps the original start time', 'One login per person', 'shares one login', 'no human decider',
      '`cw.appeals.stats({ days })`', '**A reduction is not a false positive**', '`lightened`', '`APPEAL_STATS_MIN_SANCTIONS`', '`APPEAL_RATE_ELEVATED`', '`APPEAL_RATE_HIGH`',
      'corrective example', '(version 4)', '`appeal.created`', '`appeal.decided`', 'never the statement', 'migration 22', 'one-way', 'back up the database', '`withMemoryAppeals(store)`',
      '`closeOrphanAppeals`', '`clearStatement`', '`purgeNotices(before, unseen?)`',
    ]) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('core: names says the check is stateless, what keeps evidence, that a game must act on rename.required and call renamed, and that masking in the hub is on by default', () => {
    const doc = flat(section(coreDoc, 'Names'));
    for (const needle of [
      '`overrides.names`', '`maskInHub` (default `true`)', '`name_profane`', '`assertNever`', '`cw.names.flagged(text)`', '`names.keepBlocked`', '5 an hour per person', '200 an hour',
      '`retention.blockedNamesMs`', '`cw.blocked.names({ days })`', '`requireRename`', '`rename_required`', 'names no name', '`rename.required`',
      'A game must act on `rename.required` and call `renamed`', '`cw.people.accountIds(event.target)`', '`cw.names.pendingRename(who)`', '`cw.names.renamed(who)`',
      'never learns the new name', 'default-on display change', 'set `overrides.names.maskInHub: false`', '`handleFlagged`', '`withdrawNotice(id, at)`', 'cannot release a rename', '`renamesEnabled()` is `false`',
      '`withMemoryNames(store)`',
    ]) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('core: the 0.1.9 list, the table rows, the retention defaults and the upgrade notes are there', () => {
    const list = flat(section(coreDoc, 'What 0.1.9 added'));
    for (const needle of ['`cw.appeals`', '`AppealSettings`', '`NameSettings`', '`cw.names.requireRename`', '`cw.people.accountIds`', '`rename.required`', '`withMemoryAppeals`', '`withMemoryNames`', '`AppealDialog`', '`nameReasonText`', '`appealsRateLimit`', '`includeAccounts`']) {
      expect(list, needle).toContain(needle);
    }
    for (const row of ['| `cw.appeals` |', '| `cw.names` |', '| `cw.people` |']) expect(core, row).toContain(row);
    expect(core).toContain('appeal statements 90 (`appealStatementsMs`, may be 0), appeals 365 (`appealsMs`, never less than 90), kept blocked names 30 (`blockedNamesMs`, may be 0)');
    const up = flat(section(coreDoc, 'Upgrading to 0.1.9'));
    for (const needle of ['one-way', 'Back it up first', '`NoticeKind` gains `rename_required`, `appeal_upheld`, `appeal_reduced` and `appeal_revoked`', '`NameReason` gains `name_profane`', '`AUDIT_ACTIONS` gains `appeal.view`, `appeal.decide` and `name.rename_required`', '`KIT_EVENT_TYPES` gains', '`PurgeResult` gains `appeals`, `appealStatements`, `blockedNames` and `appealsClosed`', 'A reduction on appeal is not a false positive', 'The prompt version is now 4', 'once per open report', '`purgeNotices` has an optional second argument']) {
      expect(up, needle).toContain(needle);
    }
  });

  it('core: the AI section says prompt version 4 changes the hash and re-reads open reports against the daily caps, appeals on or off', () => {
    const ai = flat(section(coreDoc, 'The AI (levels 1 and 2)'));
    for (const needle of ['prompt version is 4 for everyone', 'changes the input hash', 'marked stale and read again, once per open report', 'daily call and money caps', 'appeal cautions and corrective examples']) expect(ai, needle).toContain(needle);
    expect(ai).not.toContain('prompt version is 3 for everyone');
  });

  it('core: the security notes name the two new kinds of player text', () => {
    expect(section(coreDoc, 'Security notes')).toMatch(/Two more kinds of player text, both opt-in/);
  });

  it('http: the appeal and name routes, the new bodies, the limiter and the webhook option are described', () => {
    for (const needle of [
      '| `GET /appeals?status&cursor&limit` |', '| `GET /appeals/:id` |', '| `POST /appeals/:id/decide` |', '| `POST /people/:ref/rename` |', '| `GET /appeals` |', '| `POST /appeals { noticeId, statement }` |',
      '**No statement is in a list.**', '`granted` counts revoked appeals only', '`appealsRateLimit`', '10 an hour per identity', '`features` (new in 0.1.9) is `{ appeals, renames, keepBlocked, rooms, workflow, insights }`', '`source=name`', '`handleFlagged: true`', '`targetHandleFlagged`', 'It is a display flag, not a redaction', '`includeAccounts: true`',
      '`appeal.created`, `appeal.decided` and `rename.required`', '`permissions: { \'appeals.decide\': \'moderator\' }`', 'give each moderator their own login', 'peer range on core is `^0.2.1`',
      '`name_profane`', 'Also `POST /people/:ref/rename`.',
    ]) {
      expect(httpDoc, needle).toContain(needle);
    }
  });

  it('http: every route the appeal and name tables name exists in the route sources', () => {
    const sources = read('packages/http/src/admin/appeals.ts') + read('packages/http/src/admin/names.ts') + read('packages/http/src/player.ts');
    for (const route of ["'GET /appeals'", "'GET /appeals/stats'", "'GET /appeals/:id'", "'POST /appeals/:id/decide'", "'POST /people/:ref/rename'", "'POST /appeals'"]) expect(sources, route).toContain(route);
  });

  it('player-react: the appeals section says what the prop does, the new words to translate (counted from the catalog), and the older version', () => {
    const doc = flat(section(playerDoc, 'Install') + playerDoc.slice(playerDoc.indexOf('### Appeals'), playerDoc.indexOf('### Transports')));
    for (const needle of ['`appeals`', '`AppealDialog`', '`appealUrl` is not used then', 'older than 0.1.9', '`nameReasonText(t, reason)`', '`@chatwarden/core` is a peer too (`^0.2.1`)', '`AppealRefusal`, `PlayerAppeal` and `NameReason`']) {
      expect(doc, needle).toContain(needle);
    }
    const catalog = read('packages/player-react/src/i18n.ts');
    const count = (prefix: string): number => [...catalog.matchAll(new RegExp(`^ {2}'${prefix.replaceAll('.', '\\.')}[a-zA-Z_.]*'`, 'gm'))].length;
    expect(count('player.appeal.')).toBe(18);
    expect(count('player.name.')).toBe(3);
    expect(doc).toContain('29 keys to `en`: 18 `player.appeal.*`, 3 `player.name.*`');
    // The notice words moved to core (`@chatwarden/core/notice-copy`); `en` spreads them.
    const words = read('packages/core/src/noticeCopy.ts');
    expect(catalog).toContain('...NOTICE_WORDS');
    for (const kind of ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked']) {
      expect(words, `title ${kind}`).toContain(`'player.notice.title.${kind}'`);
      expect(words, `body ${kind}`).toContain(`'player.notice.body.${kind}'`);
    }
  });

  it('hub-react: the Advanced panels read in the order the screen mounts them, the lighter picker offers no custom length, and Simple\'s Person page has the rename choice', () => {
    const row = flat(hubDoc.slice(hubDoc.indexOf('| `#/settings/advanced` |'), hubDoc.indexOf('\n', hubDoc.indexOf('| `#/settings/advanced` |'))));
    const at = (name: string): number => row.indexOf(`**${name}**`);
    expect(at('Slow mode and flooding')).toBeGreaterThan(0);
    expect(at('Signals')).toBeGreaterThan(at('Slow mode and flooding'));
    expect(at('Appeals')).toBeGreaterThan(at('Signals'));
    expect(at('Names')).toBeGreaterThan(at('Appeals'));
    const advanced = read('packages/hub-react/src/screens/AdvancedSettings.tsx');
    const mounted = ['LazyPaceSettings', 'LazySignalSettings', 'LazyAppealSettings', 'LazyNameSettings'].map((n) => advanced.indexOf(`<${n} `));
    expect([...mounted].sort((a, b) => a - b)).toEqual(mounted);
    const doc = flat(hubDoc);
    for (const needle of ['a custom length is never offered', 'shows on the Person page in Simple too', '`^0.2.1` for both', 'Translators: words new in 0.1.9', '`displayName(t, { handle, flagged, revealed })`']) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('discord: the two appeal posts, what they never carry, severeOnly and the peer floor', () => {
    const doc = flat(readme('discord'));
    for (const needle of ['Appeal filed against a 24-hour chat restriction, Rule 2.', 'Appeal decided: lighter.', 'never carries the statement', '`rename.required`', 'only appeals under a severe rule post', '`^0.2.1`', 'no appeal statement']) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('store-memory and store-sqlite: the opt-in wrappers, and migration 22 one-way with a back-up note', () => {
    const memory = flat(readme('store-memory'));
    for (const needle of ['`withMemoryAppeals(store)`', '`withMemoryNames(store)`', '`withdrawNotice`', 'refused when it is created']) expect(memory, needle).toContain(needle);
    const sqlite = flat(readme('store-sqlite'));
    for (const needle of ['Migration 22 adds two tables: `kit_appeals`', '`kit_blocked_names`', '`kit_sanctions.report_id`', '`corrective` column on `kit_ai_outcomes`', 'rebuilds `kit_notices`', 'a 0.1.8 or older store refuses a database at version 22', 'back up the file before upgrading', '`retention.appealStatementsMs`']) {
      expect(sqlite, needle).toContain(needle);
    }
  });

  it('tiny-chat: the appeals demo switch is documented and the server honours the name it documents', () => {
    const doc = flat(read('examples/tiny-chat/README.md'));
    for (const needle of ['## Appeals and renames (demo, optional)', '`CW_DEMO_APPEALS=1`', '`startServer({ demoAppeals })`', 'same_decider']) expect(doc, needle).toContain(needle);
    expect(read('examples/tiny-chat/server.ts')).toContain("process.env.CW_DEMO_APPEALS === '1'");
  });

  it('the project docs say it exists: status and the parked list', () => {
    const status = read('docs/status.md');
    expect(status).toMatch(/K7b: appeals and offensive names/);
    expect(flat(status)).toContain('names the word list flags are hidden in the hub until shown, on by default');
    expect(flat(status)).toContain('a reduction on appeal is not a false positive');
    expect(status).not.toMatch(/- offensive names\n/);
    const follow = flat(read('docs/plans/follow-ups.md'));
    for (const needle of ['## Appeals and names (0.1.9), parked', 'Appeals by reporters', 'A free-text reply to the player', 'Claims on appeals', 'Auto-expiry of an old open appeal', 'Gates for AI levels 3 and 4', 'Casebook marks are per report']) {
      expect(follow, needle).toContain(needle);
    }
  });

  it('every CHANGELOG says in its first line that 0.1.9 adds notice kinds and a one-way migration, and carries the upgrade notes', () => {
    for (const dir of published) {
      const log = flat(read('packages', dir, 'CHANGELOG.md'));
      const at = log.indexOf('## 0.1.9');
      expect(at, dir).toBeGreaterThanOrEqual(0);
      const text = log.slice(at, log.indexOf('## 0.1.8', at));
      expect(text.slice(0, 400), `${dir} first line`).toContain('Adds notice kinds and a one-way migration');
      for (const needle of [
        '`rename_required`, `appeal_upheld`, `appeal_reduced` and `appeal_revoked` join `NoticeKind`', '`assertNever`', 'SQLite migration 22 is one-way', 'Take a backup',
        'cannot be opened by 0.1.8 or older', '**A reduction on appeal is not a false positive**', '`names.maskInHub` (default `true`)', 'the one default-on display change',
        '`overrides.names.maskInHub: false`', '`appeals.read` (default `moderator`', '`appeals.decide` (default `senior`', 'An older player-react shows the generic title',
        '28 keys', 'from 11 KB to 14 KB', 'from 82 KB to 88 KB', 'The AI prompt version is now 4 for everyone', 'count against your daily call and money caps',
        '`PurgeResult` gains `appeals`, `appealStatements`, `blockedNames` and `appealsClosed`', '`withdrawNotice(id, at)` is new and optional', 'a custom store without it has renames off',
        '`closeOrphanAppeals`', '`clearStatement`', '`purgeNotices(before, unseen?)`', 'No new package is published',
      ]) {
        expect(text, `${dir}: ${needle}`).toContain(needle);
      }
      // Every raised floor is named with the API that forced it.
      for (const pkg of ['store-memory', 'store-sqlite', 'http', 'discord', 'hub-react', 'player-react']) expect(text, `${dir} names ${pkg}`).toContain(`\`@chatwarden/${pkg}\``);
      for (const api of ['`AppealRow` and `BlockedNameRow`', '`cw.appeals`', '`APPEAL_STATEMENT_MAX`', '`AppealRefusal`, `PlayerAppeal` and `NameReason`', 'the two appeal events']) expect(text, `${dir}: ${api}`).toContain(api);
    }
  });

  it('the 0.1.8 CHANGELOG text is unchanged by 0.1.9 (the control: it does not mention migration 22)', () => {
    const log = flat(read('packages', 'core', 'CHANGELOG.md'));
    const at = log.indexOf('## 0.1.8');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(log.slice(at, log.indexOf('## 0.1.7', at))).not.toContain('migration 22');
  });

  it('the control: a feature the docs do not have is not found', () => {
    expect(core).not.toContain('`definitelyNotAnAppealSetting`');
  });
});

// K4b (0.1.10): fast adoption. Where an adopter reads about init, toFetch and the test kit, and what the project docs say about it.
describe('the adoption docs (0.1.10)', () => {
  const rootDoc = read('README.md');

  it('the root README has the init row first in the "I want to" table, with both commands', () => {
    const table = rootDoc.slice(rootDoc.indexOf('| I want to | Install |'));
    const first = table.split('\n')[2] as string;
    expect(first).toContain('Set it up fast');
    expect(first).toContain('npx chatwarden init');
    expect(first).toContain('npx -p @chatwarden/http chatwarden init');
    expect(first).toContain('npm install @chatwarden/http @chatwarden/core');
  });

  it('the root README keeps the hand-wired quick start and says init writes it, in one sentence before it', () => {
    const quick = section(rootDoc, 'Quick start');
    expect(quick.indexOf('npx chatwarden init')).toBeGreaterThan(0);
    expect(quick.indexOf('npx chatwarden init')).toBeLessThan(quick.indexOf('```ts'));
    expect(quick).toContain('written by hand');
    expect(quick).toContain('createChatwarden');
  });

  it('the root README has "Test your policy", with the same example the store-memory README runs, and does not call it experimental', () => {
    const mine = section(rootDoc, 'Test your policy');
    const kit = readme('store-memory');
    const theirs = /```ts\n([\s\S]*?)```/.exec(kit.slice(kit.indexOf('## The test kit')))?.[1];
    const block = /```ts\n([\s\S]*?)```/.exec(mine)?.[1];
    expect(block, 'the root block').toBeDefined();
    expect(block).toBe(theirs);
    expect(block?.startsWith("import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';")).toBe(true);
    expect(flat(mine)).not.toContain('@experimental');
    expect(flat(mine)).toContain('invented');
  });

  it('the root README lists no speed claim for setup', () => {
    expect(rootDoc).not.toMatch(/\b(in|within|under) (about )?(\d+|five|ten|fifteen) minutes\b/i);
  });

  it('core: two lines point at the test kit and at init', () => {
    const core = flat(section(readme('core'), 'Testing your own rules'));
    expect(core).toContain('@chatwarden/store-memory/testing');
    expect(core).toContain('npx chatwarden init');
  });

  it('store-memory: the README names every export of the testing entry, and does not call them experimental', () => {
    const entry = read('packages/store-memory/src/testing/index.ts');
    const names = [...entry.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) => (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean));
    expect(names.length).toBeGreaterThan(15);
    const kit = flat(readme('store-memory').slice(readme('store-memory').indexOf('## The test kit')));
    for (const name of names) expect(kit, name).toContain(name);
    expect(kit).not.toContain('@experimental');
  });

  it('the project docs say it exists: status, follow-ups, CLAUDE.md, RELEASING.md and tiny-chat', () => {
    const status = read('docs/status.md');
    expect(status).toMatch(/## K4b: fast adoption \(0\.1\.10/);
    expect(flat(status.slice(status.indexOf('## K4b')))).toContain('npx chatwarden init');
    const followUps = flat(read('docs/plans/follow-ups.md'));
    expect(followUps).toContain('How to time it');
    expect(followUps).toContain('service mode');
    const claude = read('CLAUDE.md');
    expect(claude).toContain('`chatwarden` bin');
    expect(claude).toContain('@chatwarden/http/fetch');
    expect(claude).toContain('@chatwarden/store-memory/testing');
    const releasing = flat(read('RELEASING.md'));
    expect(releasing).toContain('`bin` in its manifest');
    expect(releasing).toContain('a new package');
    expect(read('examples/tiny-chat/README.md')).toContain('`chatwarden init` writes the same wiring for your own project');
  });

  it('the http README links the recipes, and every recipe page it links exists', () => {
    const http = readme('http');
    for (const match of http.matchAll(/\]\((\.\.\/\.\.\/docs\/[^)#]+)\)/g)) expect(existsSync(join(root, 'packages', 'http', match[1] as string)), match[1]).toBe(true);
    expect(http).toContain('docs/recipes');
  });
});

describe('the shared term list docs (K7, 0.1.11)', () => {
  const matcherDoc = readme('matcher');
  const httpDoc = readme('http');
  const hubDoc = readme('hub-react');
  const rootDoc = read('README.md');
  const design = read('docs/design/2026-11-12-k7-term-corpus.md');
  /** The names an entry file exports. */
  const exported = (src: string): string[] =>
    [...src.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap((m) => (m[1] as string).split(',').map((n) => n.trim().replace(/^type /, '')).filter((n) => n !== ''));
  /** The field names of an exported interface or the top-level keys of an exported object type. */
  const fieldsOf = (src: string, decl: string): string[] => {
    const start = src.indexOf(decl);
    expect(start, decl).toBeGreaterThanOrEqual(0);
    const body = src.slice(src.indexOf('{', start), src.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
  };

  it('matcher: says the package ships no terms and nothing is on by default, and that "not released yet" is gone', () => {
    const doc = flat(section(matcherDoc, 'The community term corpus'));
    expect(doc).toMatch(/ships no terms at all/);
    expect(doc).toMatch(/nothing here is on by default/);
    expect(doc).not.toMatch(/not released yet/i);
    expect(doc).toContain('`@chatwarden/matcher/corpus/node`');
    expect(doc).toContain('`no_trusted_keys`');
    expect(doc).toMatch(/pin or follow/i);
    expect(doc).toMatch(/offline first/i);
    expect(doc).toContain('`seed');
    expect(doc).toContain('Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.');
  });

  it('matcher: says what syncPack may and may not touch, the corpus: prefix, and what a status outside the selection does', () => {
    const doc = flat(section(matcherDoc, 'The community term corpus'));
    expect(doc).toContain('`LiveTerms.syncPack(pack, { actor, dryRun? })`');
    expect(doc).toMatch(/never deletes a row/);
    expect(doc).toMatch(/`updatedBy`[^.]*does not start with `corpus:`/);
    expect(doc).toMatch(/refuse an actor that starts with `corpus:`/);
    expect(doc).toMatch(/A row whose status is outside the selected statuses is excluded: it is not carried in as an inactive row/);
    expect(doc).toMatch(/Narrowing a selection later does not switch off rows you already have/);
  });

  it('matcher: says what the restart sync needs (terms), what minKit needs (kit), and that the share and report calls never throw and have a deadline', () => {
    const doc = flat(section(matcherDoc, 'The community term corpus'));
    expect(doc).toMatch(/needs the loader to hold `terms`/);
    expect(doc).toMatch(/`minKit`[^.]*`kit`/);
    expect(doc).toMatch(/15 second deadline/);
    expect(doc).toMatch(/never throws/);
    expect(doc).toContain('share.report(');
  });

  it('every documented option name exists, and every option of the loader and the share client is documented', () => {
    const doc = flat(section(matcherDoc, 'The community term corpus'));
    const loader = read('packages/matcher/src/corpus/loader.ts');
    const loaderOptions = [...loader.slice(loader.indexOf('export type CorpusLoaderOptions'), loader.indexOf('} & ({ pin')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    expect(loaderOptions.length).toBeGreaterThanOrEqual(14);
    for (const o of loaderOptions) expect(doc, `CorpusLoaderOptions.${o}`).toContain(`\`${o}\``);
    for (const o of ['follow', 'pin']) expect(doc, o).toContain(`\`${o}`);
    const shareOptions = fieldsOf(read('packages/matcher/src/corpus/share.ts'), 'export interface CommunityShareOptions');
    expect(shareOptions.length).toBeGreaterThanOrEqual(8);
    for (const o of shareOptions) expect(doc, `CommunityShareOptions.${o}`).toContain(`\`${o}\``);
    const select = fieldsOf(read('packages/matcher/src/corpus/select.ts'), 'export interface PackSelection');
    for (const o of select) expect(doc, `PackSelection.${o}`).toContain(`\`${o}\``);
    // The control: a name the code does not have is not documented.
    expect(doc).not.toContain('`definitelyNotAnOption`');
  });

  it('the READMEs list the names of the corpus subpaths, every one the entries export, and LiveTerms.syncPack', () => {
    const doc = flat(section(matcherDoc, 'The community term corpus'));
    const names = [...exported(read('packages/matcher/src/corpus/index.ts')), ...exported(read('packages/matcher/src/corpus/node/index.ts'))];
    expect(names.length).toBeGreaterThan(60);
    for (const n of names) expect(doc, n).toContain(`\`${n}\``);
    for (const n of ['LiveTerms.syncPack', 'SyncResult', 'SyncSummary']) expect(doc, n).toContain(`\`${n}\``);
    expect(doc).not.toMatch(/@experimental/);
  });

  it('no README holds a term: every word in a term, phrase or line of a code block is invented or ordinary', () => {
    const blocks = [matcherDoc, httpDoc, hubDoc, rootDoc].flatMap((doc) => [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string));
    expect(blocks.length).toBeGreaterThan(20);
    const strings = blocks.flatMap((b) => [...b.matchAll(/\b(term|phrase|word|text|line)s?: '([^']*)'/g)].map((m) => [m[1] as string, m[2] as string] as const));
    expect(strings.length).toBeGreaterThanOrEqual(2);
    for (const [key, value] of strings) {
      expect(badWords(value, key === 'term'), `${key}: ${value}`).toEqual([]);
    }
    // The control: the scanner is not blind.
    expect(badWords('blorpix', true)).toEqual(['blorpix']);
  });

  it('http: lists the community routes with their permissions, the report route, the share memory and the new error codes', () => {
    const doc = flat(httpDoc);
    for (const route of ['GET /community', 'POST /community/refresh', 'POST /community/apply', 'GET /terms/:id', 'POST /terms/lookup', 'POST /terms/:id/share', 'GET /terms/:id/share', 'POST /terms/:id/report']) {
      expect(doc, route).toContain(`\`${route}\``);
    }
    expect(doc).toContain('`exposeCommunityRows`');
    expect(doc).toContain('`term.share`');
    expect(doc).toContain('`term.report`');
    expect(doc).toContain('`community.apply`');
    expect(doc).toMatch(/core adds four names/);
    expect(doc).not.toMatch(/same\s+audit name as a share|only three names/);
    expect(doc).toMatch(/share status is kept in memory[^.]*1000[^.]*lost on restart/i);
    expect(doc).toMatch(/two staff[^.]*same term at once[^.]*`duplicate`/i);
    expect(doc).toMatch(/15 seconds/);
    expect(doc).toContain('`not_reportable`');
    expect(doc).toContain('`features.community`');
    expect(doc).toMatch(/audit row[^.]*even when the share fails/i);
  });

  it('hub-react: has the Community list section, the two disclosures, and says the browser never contacts the service', () => {
    const doc = flat(hubDoc);
    expect(doc).toContain('Community list');
    expect(doc).toContain('Share with the community list');
    expect(doc).toContain('Report a problem with this community term');
    expect(doc).toMatch(/browser never (contacts|talks to) the (community )?service/i);
    expect(doc).toContain('`reporting`');
    expect(doc).toContain('`sharing`');
    expect(doc).toMatch(/no new always-visible control/i);
  });

  it('the root README has the "Use the shared community term list" row, and says nothing is on by default', () => {
    expect(rootDoc).toMatch(/\| Use the shared community term list[^|]*\|[^|]*@chatwarden\/matcher\/corpus\/node/);
    expect(flat(rootDoc)).toMatch(/ships no terms/);
  });

  it('the project docs say it exists: status, follow-ups (the items of design 20) and CLAUDE.md', () => {
    const status = read('docs/status.md');
    expect(status).toMatch(/## K7: the shared term corpus/);
    expect(flat(status.slice(status.indexOf('## K7')))).toMatch(/Part A[^.]*kit[^.]*0\.1\.11/);
    const followUps = flat(read('docs/plans/follow-ups.md'));
    for (const item of ['A hub review UI for the corpus', 'chatwarden terms install', 'AI-assisted review of proposed terms', 'browser build of the loader', 'moderator-calibration screen', 'Phrases, regex terms']) {
      expect(followUps, item).toContain(item);
    }
    const claude = read('CLAUDE.md');
    expect(claude).toContain('2026-11-12-k7-term-corpus.md');
    expect(claude).toContain('@chatwarden/matcher/corpus');
  });

  it('the design note holds the shapes the service must write: positive.json, the limits, the sequence rule, the report wire and the interface choices', () => {
    const doc = flat(design);
    expect(doc).toContain('chatwarden-corpus-positive/1');
    expect(doc).toMatch(/at most 50 lines of at most 200 characters/);
    expect(doc).toMatch(/at most 2 000 lines of at most 500 characters/);
    expect(doc).toMatch(/phrase of at most 100 characters/);
    expect(doc).toMatch(/`expected\.sequence` is an upper bound[^.]*not above the index/i);
    expect(doc).toMatch(/A row whose status is outside the selected statuses is excluded/);
    expect(doc).toMatch(/`updatedBy` starts with `corpus:`/);
    expect(doc).toContain('POST /v1/reports');
    expect(doc).toContain('chatwarden-corpus-report/1');
    expect(doc).toContain('signedMessage(\'report\'');
    expect(doc).toMatch(/signed over `signedMessage\('submission', UTF8\(id\)\)`/);
    expect(doc).toMatch(/nonce[^.]*\[A-Za-z0-9_-\]\{1,32\}/);
    expect(doc).toMatch(/no `gate` key/);
    expect(doc).toMatch(/12 lines/);
    expect(doc).toMatch(/`long-room`/);
    expect(doc).toMatch(/200 OK[^.]*`\{ "status": null \}`|`\{ status: null \}`/);
  });
});

// --- the corpus service's pages (services/corpus, docs/community-list.md) -------------------------------------------------------------------
// The README is the owner's step-by-step. A command in it that cannot work is worse than no command, so every fenced command block is parsed:
// the quotes balance, the program is one we know, a wrangler subcommand and its flags are ones wrangler documents, a tool is a real file and its
// flags are the ones its own usage text lists, and a test path exists. (The service's own words are checked by scripts/no-corpus-data.test.ts.)

describe('the corpus service README: its command blocks parse, and every command in them is real', () => {
  const doc = read('services/corpus/README.md');
  const usage: Record<string, string> = { keygen: KEYGEN_USAGE, sign: SIGN_USAGE, release: RELEASE_USAGE, publish: PUBLISH_USAGE, zenodo: ZENODO_USAGE, 'verify-live': VERIFY_USAGE, seed: SEED_USAGE, eval: EVAL_USAGE };
  // Flags per wrangler subcommand, from Cloudflare's wrangler documentation (read 2026-11).
  const wrangler: Record<string, string[]> = {
    login: [],
    'd1 create': [],
    'd1 execute': ['--remote', '--local', '--file', '--command', '--persist-to', '--yes', '--json'],
    'd1 export': ['--remote', '--local', '--output', '--table', '--no-schema', '--no-data'],
    'r2 bucket create': [],
    'r2 bucket domain add': ['--domain', '--zone-id', '--min-tls', '--force'],
    'secret put': [],
    deploy: ['--config'],
  };

  /** Shell-style words, or null for an unbalanced quote. */
  function words(line: string): string[] | null {
    const out: string[] = [];
    let cur = '';
    let quote: string | null = null;
    let any = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i] as string;
      if (quote !== null) {
        if (c === quote) quote = null;
        else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[(i += 1)];
        else cur += c;
      } else if (c === '"' || c === "'") {
        quote = c;
        any = true;
      } else if (/\s/.test(c)) {
        if (cur !== '' || any) out.push(cur);
        cur = '';
        any = false;
      } else cur += c;
    }
    if (quote !== null) return null;
    if (cur !== '' || any) out.push(cur);
    return out;
  }
  const blocks = [...doc.matchAll(/```(sh|bash)\n([\s\S]*?)```/g)].map((m) => (m[2] as string).split('\n').filter((l) => l.trim() !== ''));
  const commands = blocks.flat();
  const flagsOf = (text: string): Set<string> => new Set(text.match(/--[a-z][a-z-]*/g) ?? []);

  it('has command blocks (the deploy, the keys, the seed, the release, the smoke)', () => {
    expect(commands.length).toBeGreaterThan(25);
    expect(blocks.length).toBeGreaterThan(8);
  });

  it.each(commands)('parses: %s', (line) => {
    const w = words(line);
    expect(w, 'unbalanced quote').not.toBeNull();
    const [program, ...rest] = w as string[];
    const flags = rest.filter((t) => t.startsWith('--'));
    if (program === 'npx' && rest[0] === 'wrangler') {
      const sub = Object.keys(wrangler)
        .filter((k) => rest.slice(1, 1 + k.split(' ').length).join(' ') === k)
        .sort((a, b) => b.length - a.length)[0];
      expect(sub, 'a wrangler subcommand that is documented').toBeDefined();
      for (const f of flags) expect(wrangler[sub as string], f).toContain(f);
    } else if (program === 'node') {
      const m = /^services\/corpus\/tools\/([a-z-]+)\.mjs$/.exec(rest[0] ?? '');
      expect(m, 'node runs one of the service tools').not.toBeNull();
      const name = (m as RegExpExecArray)[1] as string;
      expect(existsSync(join(root, 'services/corpus/tools', `${name}.mjs`))).toBe(true);
      const allowed = flagsOf(usage[name] ?? '');
      expect(allowed.size, `usage for ${name}`).toBeGreaterThan(0);
      for (const f of flags) expect(allowed, `${name} ${f}`).toContain(f);
    } else if (program === 'npx' && rest[0] === 'tsc') {
      expect(rest.slice(1)).toEqual(['-b', 'services/corpus']);
    } else if (program === 'npm') {
      expect(rest.slice(0, 2)).toEqual(['run', 'smoke:d1']);
      expect((JSON.parse(read('services/corpus/package.json')) as { scripts: Record<string, string> }).scripts['smoke:d1']).toBeDefined();
    } else if (program === 'npx' && rest[0] === 'vitest') {
      for (const p of rest.slice(2)) expect(existsSync(join(root, p)), p).toBe(true);
    } else {
      throw new Error('a command this lint does not know');
    }
  });

  it('every tool launcher runs a module that exists, and every tool is in the README', () => {
    const dir = join(root, 'services/corpus/tools');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs') && !['run.mjs', 'smoke-d1.mjs'].includes(f))) {
      const m = /await run\('([A-Za-z]+)'\)/.exec(read('services/corpus/tools', file));
      expect(m, file).not.toBeNull();
      expect(existsSync(join(root, 'services/corpus/src/tools', `${(m as RegExpExecArray)[1]}.ts`)), file).toBe(true);
      expect(doc, file).toContain(`tools/${file}`);
    }
  });

  it('names the secrets and variables the Worker needs, and no value for any of them', () => {
    const config = read('services/corpus/wrangler.jsonc');
    for (const name of ['COUNTER_SECRET', 'TURNSTILE_SECRET']) {
      expect(config).toContain(name);
      expect(doc).toContain(`wrangler secret put ${name}`);
    }
    for (const name of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'REPORTS_ORIGIN', 'REPORTS_HOSTNAME']) expect(doc).toContain(name);
    expect(doc).not.toMatch(/(COUNTER_SECRET|TURNSTILE_SECRET)\s*[=:]\s*\S/);
    expect(doc).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('says that the local smoke is opt-in and why, and that nothing is deployed', () => {
    const text = flat(doc);
    expect(text).toMatch(/does not run with the other tests/);
    expect(text).toMatch(/no\s+Cloudflare account/);
    expect(text).toMatch(/Nothing has been deployed/);
  });

  it('is titled with its package name, has a status line and no marketing words', () => {
    expect(doc.startsWith('# @chatwarden/corpus-service\n')).toBe(true);
    expect(doc).toMatch(/^Status: pre-release, as-is, no support promise\.$/m);
    expect(doc).not.toMatch(MARKETING);
  });
});

describe('the corpus service other pages say what the code does', () => {
  it('PRIVACY.md: the retention numbers are the code, it is marked as a draft and not legal advice, and it says no address is kept', () => {
    const text = flat(read('services/corpus/PRIVACY.md'));
    expect(text).toMatch(/maintainers' draft/);
    expect(text).toMatch(/Not legal advice/);
    expect(text).toContain(`${LIMITS.installationDays} days after the decision`);
    expect(text).toContain(`${LIMITS.noteDays} days after the decision`);
    expect(text).toMatch(/\*\*Two days\*\*|\*\*two days\*\*/);
    expect(LIMITS.counterDays).toBe(2);
    expect(text).toMatch(/An IP address/);
    expect(text).toMatch(/Cloudflare's own logs/);
  });

  it('SOURCES.md: no source is approved yet, and every source needs the four things before it is loaded', () => {
    const text = flat(read('services/corpus/SOURCES.md'));
    expect(text).toMatch(/Nothing is loaded yet/);
    for (const item of ['Name and where it comes from', 'Licence', 'The internal-use check', 'Not redistributed']) expect(text, item).toContain(item);
    expect(text).toMatch(/not redistributed|never redistributed/i);
  });

  it('docs/community-list.md: the rules, the consent, the licence sentence and the removal limits', () => {
    const text = flat(read('docs/community-list.md'));
    expect(text).toContain(ATTRIBUTION);
    for (const item of ['The rules', 'Licence and consent', 'A published release cannot be recalled', 'Words only', 'CC BY 4.0']) expect(text, item).toContain(item);
    expect(text).toMatch(/opt-in/);
    expect(text).not.toMatch(MARKETING);
  });
});

describe('the AI gate dashboard and do-not-automate docs (0.1.13)', () => {
  const core = flat(section(readme('core'), 'AI levels 3 and 4: the seams and the gate dashboard'));
  const http = flat(readme('http'));
  const hub = flat(section(readme('hub-react'), 'AI levels 3 and 4, release 1 (0.1.13)'));
  const sqlite = flat(readme('store-sqlite'));

  it('core: says nothing acts, what the seam is, the gate view, the mark, the migration (one-way, back up first), the unions and the names', () => {
    for (const needle of [
      '**Nothing in this release lets the AI act.**', '`source: \'ai\'`', '`applySanction`', '`writeSanction`', '`validateSanctionInput`', '`service`', '`cw.ai.gates()`', '`AiGatesView`',
      '`actingAvailable` is false', 'lower 95% bound', '`cw.people.automation`', '`AUTOMATION_CODES`', 'no free text', 'follows a merge', '`automationAllowed(person, lookup?)`',
      'migration 24 (SQLite)', '`kit_ai_noauto`', '**one-way**', '**back up the file before upgrading**', '`aiGateRows`', '`setNoAutomation`', '`loadNoAutomation`', '`withMemoryAi(store)`',
      '`AUDIT_ACTIONS` gains `person.automation`', '**Names:**',
    ]) {
      expect(core, needle).toContain(needle);
    }
    expect(readme('core')).toContain('| `cw.people` |');
  });

  it('http: the two routes, the three permissions and the history key are in the tables', () => {
    for (const needle of [
      '| `GET /ai/gates` | `policy.read` |', '| `PUT /people/:id/automation` | `automation.write` |', '| `ai.review` | moderator |', '| `ai.pause` | senior |', '| `automation.write` | senior |',
      'Audited `person.automation`', '`automation` (`{ code, at }`)', 'never who',
    ]) {
      expect(http, needle).toContain(needle);
    }
    expect(http).toContain('`GET /ai/status`, `GET /ai/gates`');
  });

  it('hub-react: says it is read-only, what the table shows and the Person page mark, and the floors', () => {
    for (const needle of [
      '**nothing in this release lets the AI act.**', '"Where the AI may act"', '"Acting is not available in this version"', '"Never acted on by the AI"', 'computes no gate', '`automation.write`', '`aiGates()`', '`setAutomation(person, input)`', '`^0.1.13`',
    ]) {
      expect(hub, needle).toContain(needle);
    }
  });

  it('store-sqlite: migration 24 is described like 20 and 22, one-way with a back-up note, with the columns, the index and the table', () => {
    for (const needle of ['Migration 24 adds five columns', '`kit_ai_outcomes`', '`ai_rule`', '`decided_by`', '`kit_ai_noauto`', '`human`, `holdback`, `review` or `service`', 'a 0.1.12 or older store refuses a database at version 24', 'back up the file before upgrading']) {
      expect(sqlite, needle).toContain(needle);
    }
  });
});

// Rooms, many players and languages (0.2.0): what each README says about the room contexts, phrase-only rooms, block, staff scope, reserved names and the entity reports.
describe('the rooms sections (0.2.0)', () => {
  const core = flat(readme('core'));
  const http = flat(readme('http'));
  const player = flat(readme('player-react'));
  const hub = flat(readme('hub-react'));
  const matcher = flat(readme('matcher'));
  const sqlite = flat(readme('store-sqlite'));
  const has = (doc: string, needles: string[]): void => {
    for (const needle of needles) expect(doc, needle).toContain(needle);
  };

  it('the readme checks pass for the changed packages: core says contexts, phrases, block, scope, reserved names, entity reports, the refusal reasons and the tag grammar', () => {
    has(core, ['## Room contexts', '### Phrase-only rooms', '### Staff scope', '### Block', '### Reserved names and entity reports']);
    // contexts and the tag grammar
    has(core, ['`CONTEXT_SECTIONS`', '`ROOM_TAG_KEYS`', '`checkRoomTags`', '`chatwarden.context_unknown`', '`account_too_new`']);
    // phrases
    has(core, ['`cw.chat.acceptPhrase(room, seat, id)`', '`phrases_only`', '`phrase_unknown`', '`cw.phrases.names()`', '`cw.phrases.book(roomId)`', '`checkPhraseBooks(input, screens?)`', '`PhraseBookError`', '`MAX_PHRASES_PER_BOOK`', 'ships no phrase text']);
    // reserved names and entity reports
    has(core, ['`names.reserved`', '`names.reservedAllow`', '`names.reservedRule`', '`name_reserved`', '`NameKind`', '`ReportInput.entity`', '`entity_invalid`', '`impersonation`', '`rename.required`']);
    expect(core).toMatch(/refused `phrases_only`/);
    expect(core).toMatch(/an entity rename.* no notice/i);
  });

  it('the readme checks pass for the changed packages: http says scope on authorize, scopedLimits, wire version 2, the kind on names, the phrases and mute routes and the entity on a case', () => {
    has(http, ['`scope?: string[]`', 'scopedLimits: { kinds, maxDurationMs }', 'Wire version 2', '`POST /rooms/:room/phrases`', '`POST /rooms/:room/mute`', '`GET /policy/contexts`']);
    has(http, ['`POST /names/check { name, kind? }`', '`name_reserved`', '`POST /people/:ref/rename` | `{ reason, rule, takeOver?, entity? }`', '`entities`', '`entityLabelFlagged`', '`phrases_only`', '`phrase_unknown`']);
    expect(http).toMatch(/`kind` is `player` \(the default\) or `entity`/);
  });

  it('the readme checks pass for the service mode: http says the /v1 table, the keys and their rotation, the process and its variables, the client, the description and the honest limits; core says shared pacing', () => {
    has(http, ['## Service mode', '`serviceRoutes(cw, { keys })`', '`@chatwarden/http/service`', '`SERVICE_OPENAPI`', '`createServiceClient`', '`chatwarden serve`', '`chatwarden init --service`', '`GET /v1`', '`POST /v1/rooms/{room}/seats/{seat}/lines`', '`POST /v1/blocks/between`']);
    has(http, ['`CHATWARDEN_SECRET`', '`CHATWARDEN_SERVICE_KEYS`', '`CHATWARDEN_ADMIN_TOKEN`', '`CHATWARDEN_AUTH_MODULE`', '`CHATWARDEN_PROCESSES`', '`Idempotency-Key`', '`idempotent-replay`', '`synthetic_terms`', '`pacing_per_process`', '`plain_http`']);
    has(http, ['### Rotating a service key', '### What it does not do']);
    expect(http).toMatch(/A service key is a database password/);
    expect(http).toMatch(/Seats are the game's to keep/);
    expect(http).toMatch(/one process per room set/i);
    has(core, ['## Shared pacing', '`createChatwarden({ sharedPacing: true })`', '`paceLoad`', '`paceUpdate`', '`paceDropRoom`', '`paceSweep`', '`PaceStateRow`', '`PurgeResult.pace`']);
    expect(core).toMatch(/setPace` overrides stay per process/);
  });

  it('the readme checks pass for the changed packages: player-react says Block, the phrase picker, the phrase catalogue keys and the name words', () => {
    has(player, ['phrase picker', '`phrase.<id>`', '`player.chat.phrases`', '`player.chat.refused.phrases_only`', '`player.chat.refused.phrase_unknown`', '`ChatTransport.sendPhrase(id)`', '`player.name.reserved`', '`player.report.refused.entity_invalid`']);
    has(player, ['Block']);
    expect(player).toMatch(/in place of the phrase's text/);
  });

  it('the readme checks pass for the changed packages: hub-react says the context chip, the contexts list, the entity row, the reserved names and Match', () => {
    has(hub, ['## Rooms, names for entities and terms without spaces (0.2.0)', '**Room contexts**', 'context chip', '`EntityRow`', '`entityLabelFlagged`', '"Protected names"', '"Match"', '"Anywhere in the text"', '`matchMode`']);
    expect(hub).toMatch(/a scoped moderator is offered neither/i);
  });

  it('the readme checks pass for the changed packages: matcher says skeleton, matchReserved and what a reserved name does and does not compare', () => {
    has(matcher, ['### Reserved names', '`skeleton(text)`', '`matchReserved(name, entries, allow)`']);
    expect(matcher).toMatch(/whole words/i);
    expect(matcher).toMatch(/never the chat/i);
  });

  it('the core README says how many words NOTICE_WORDS holds, and the number is the real one (39: 36 notice words and the three restricted-chat words)', async () => {
    const { NOTICE_WORDS } = await import('@chatwarden/core/notice-copy');
    const count = Object.keys(NOTICE_WORDS).length;
    expect(count).toBe(39);
    expect(flat(readme('core'))).toContain(`\`NOTICE_WORDS\` (${count} keys: 36 notice words and the three restricted-chat words)`);
  });

  it('the READMEs say the Spanish and Portuguese catalogues are machine drafts that a person has not read', () => {
    for (const dir of ['player-react', 'hub-react', 'hub-element']) {
      const text = flat(readme(dir));
      expect(text, dir).toMatch(/Spanish and Portuguese are machine-drafted/);
      expect(text, dir).toMatch(/not been reviewed by a person/);
      expect(text, dir).toMatch(/who speaks the language/);
    }
  });

  // Migration 26 is shared by every theme of 0.2.0, so its README list is judged against the SQL itself: every table and every column the migration adds is named in the
  // store-sqlite README's Migration 26 section, and the core README, which also describes the migration, does not name a table the SQL does not create.
  describe('migration 26 in the READMEs, against the migration itself', () => {
    const migrations = read('packages', 'store-sqlite', 'src', 'migrations.ts');
    const at = migrations.indexOf('version: 26,');
    const sql = migrations.slice(at, migrations.indexOf('`,', migrations.indexOf('sql: `', at)));
    const tables = [...sql.matchAll(/CREATE TABLE (kit_[a-z_]+)/g)].map((m) => m[1] as string);
    const columns = [...sql.matchAll(/ALTER TABLE (kit_[a-z_]+) ADD COLUMN ([a-z_]+)/g)].map((m) => `${m[1]}.${m[2]}`);
    const sqliteDoc = read('packages', 'store-sqlite', 'README.md').replace(/\r\n/g, '\n');
    const start = sqliteDoc.indexOf('### Migration 26');
    const section26 = flat(start === -1 ? '' : sqliteDoc.slice(start, sqliteDoc.indexOf('\n#', start + 5) === -1 ? undefined : sqliteDoc.indexOf('\n#', start + 5)));
    const core = flat(readme('core'));

    it('control: the scan finds the tables and columns of the migration', () => {
      expect(tables).toEqual(expect.arrayContaining(['kit_filter_hits', 'kit_legal_holds', 'kit_erasures', 'kit_report_comments', 'kit_chat_days', 'kit_pace']));
      expect(columns).toEqual(expect.arrayContaining(['kit_reports.origin', 'kit_reports.urgent', 'kit_reports.scope', 'kit_terms.match_mode', 'kit_mutes.block']));
    });

    it('store-sqlite has a "Migration 26" section that says it is one-way and to back up first', () => {
      expect(start).toBeGreaterThan(-1);
      expect(section26).toMatch(/one-way/);
      expect(section26).toMatch(/back up/i);
    });

    it.each(tables)('the store-sqlite section names the table %s', (table) => {
      expect(section26).toContain(`\`${table}\``);
    });

    it.each(columns)('the store-sqlite section names the column %s', (column) => {
      expect(section26).toContain(`\`${column}\``);
    });

    it('the section names every index the migration creates', () => {
      for (const index of new Set([...sql.matchAll(/CREATE (?:UNIQUE )?INDEX (kit_[a-z_]+)/g)].map((m) => m[1] as string))) expect(section26, index).toContain(`\`${index}\``);
    });

    it('the section names the erasure epoch row, and the core README points at it and names no table or index the migrations do not create', () => {
      expect(section26).toContain('erasure_epoch');
      expect(core).toMatch(/migration 26/i);
      for (const name of new Set([...core.matchAll(/`(kit_[a-z_]+)`/g)].map((m) => m[1] as string))) {
        const known = new RegExp(`CREATE (?:UNIQUE )?(?:TABLE|INDEX)(?: IF NOT EXISTS)? ${name}\\b`).test(migrations);
        expect(known, `${name} is a table or index the migrations create`).toBe(true);
      }
    });

    it('the core README lists the same new tables as the migration for migration 26 (filters, holds, erasures, comments, chat days, pace)', () => {
      const line = core.slice(core.search(/SQLite migration 26/i));
      for (const table of ['kit_filter_hits', 'kit_legal_holds', 'kit_erasures', 'kit_report_comments', 'kit_chat_days', 'kit_pace']) expect(line.slice(0, 1800), table).toContain(`\`${table}\``);
    });
  });

  it('the readme checks pass for the changed packages: store-sqlite names the rooms and languages columns of migration 26', () => {
    has(sqlite, ['Migration 26', '`kit_reports.scope`', '`kit_reports.entity_json`', '`kit_terms.match_mode`', '`kit_mutes.block`']);
  });
});

describe('the appeals landing docs (0.2.1)', () => {
  const core = flat(readme('core'));
  const sqliteReadme = readme('store-sqlite');
  const memory = flat(readme('store-memory'));
  const hub = flat(readme('hub-react'));
  const player = flat(readme('player-react'));
  const discord = flat(readme('discord'));
  const serviceMode = flat(read('docs', 'recipes', 'service-mode.md'));
  const has = (doc: string, needles: string[]): void => {
    for (const needle of needles) expect(doc, needle).toContain(needle);
  };
  const part = (doc: string, heading: string): string => {
    const start = doc.indexOf(`\n${heading}\n`);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const level = heading.match(/^#+/)?.[0].length ?? 2;
    const next = doc.slice(start + 1).search(new RegExp(`\\n#{1,${level}} `));
    return flat(next === -1 ? doc.slice(start) : doc.slice(start, start + 1 + next));
  };

  it('core: has the section, and names the link, the page, the delivery hook, the fixed reasons and the feedback calls', () => {
    const text = part(readme('core'), '## Appeal links, delivery and feedback (0.2.1)');
    has(text, [
      '`cw.appeals.link(noticeId, { ttlMs? })`',
      '`cw.appeals.openLink(token)`',
      '`cw.appeals.caseByLink(token)`',
      '`cw.appeals.fileByLink(token, { statement })`',
      '`cw.appeals.landingOrigins()`',
      '`AppealCase`',
      '`AppealCaseResult`',
      '`appeals.landingUrl`',
      '`appeals.landingOrigins`',
      '`appeals.linkTtlMs`',
      '`appeals.contact`',
      '`appeals.emailsOutcome`',
      '`appeals.words`',
      '`notices.deliver`',
      '`notices.localeOf`',
      '`NoticeDelivery`',
      '`AppealReasonCode`',
      '`APPEAL_REASONS`',
      '`reasonCode`',
      '`sanction.overturned`',
      '`AppealCause`',
      '`cw.terms.reviewFlags({ days?, min? })`',
      '`cw.filters.overturned({ days? })`',
      '`ReporterAccuracy.overturned`',
      '`@chatwarden/core/notice-locales`',
      '`PlayerNotice.appealUrl`',
      '`DoorRefusal.appealUrl`',
      '`resolveLandingOptions`',
      '`kit_overturns`',
      'migration 27',
    ]);
  });

  it('core: says once that landingOrigins is an option of createChatwarden, not a profile key (R3 minor 3)', () => {
    const text = part(readme('core'), '## Appeal links, delivery and feedback (0.2.1)').replace(/\s+/g, ' ');
    expect(text).not.toMatch(/`appeals\.landingOrigins` is the origin list above/);
    expect(text).toMatch(/the `landingOrigins` option of `createChatwarden`'s `appeals`.{0,80}not a profile key/);
  });

  it('core: has the table of the nine fixed reasons by outcome, with every code', async () => {
    const { APPEAL_REASONS } = await import('@chatwarden/core');
    const text = part(readme('core'), '## Appeal links, delivery and feedback (0.2.1)');
    for (const [outcome, codes] of Object.entries(APPEAL_REASONS)) {
      for (const code of codes) expect(text, `${outcome} ${code}`).toContain(`\`${code}\``);
    }
    expect(text).toMatch(/`context_considered`.*the default/);
  });

  it('core: says what the link is (a capability for one sanction, not a login), keep query strings out of logs, and that appeals must be on', () => {
    const text = part(readme('core'), '## Appeal links, delivery and feedback (0.2.1)');
    expect(text).toMatch(/capability for one sanction/);
    expect(text).toMatch(/not a login/);
    expect(text).toMatch(/keep query strings out of (your )?access logs/i);
    expect(text).toMatch(/appeals must be enabled in the profile/i);
    expect(text).toMatch(/never sends email and never stores an email address/);
  });

  it('core: says a granted appeal on an automatic restriction no longer counts toward the next, and that the forgiveness is per process until a restart', () => {
    const text = part(readme('core'), '## Appeal links, delivery and feedback (0.2.1)');
    expect(text).toMatch(/no longer counts toward the next/);
    expect(text).toMatch(/per process/i);
    expect(text).toMatch(/until (it|that process|the other process) restarts/);
    expect(text).toMatch(/never changes a term by itself/);
  });

  it('core: says the Spanish and Portuguese appeal and delivery words are machine drafts that a person has not read', () => {
    const text = part(readme('core'), '## Appeal links, delivery and feedback (0.2.1)');
    expect(text).toMatch(/Spanish and Portuguese are machine-drafted/);
    expect(text).toMatch(/not been reviewed by a person/);
  });

  it('core: the privacy section names kit_overturns, what export shows and that erase removes the rows', () => {
    const text = part(readme('core'), '## Privacy requests and legal hold');
    has(text, ['`kit_overturns`']);
    expect(text).toMatch(/overturn/i);
  });

  it('http: has the section for the page and the delivery, and names the routes, headers, limits, options and variables', () => {
    const text = part(readme('http'), '### The appeal page and its delivery (0.2.1)');
    has(text, [
      '`GET /appeal`',
      '`GET /appeal/case`',
      '`POST /appeal/case`',
      '`OPTIONS /appeal/case`',
      '`appealLandingRoutes`',
      '`APPEAL_PAGE_CSP`',
      '`landingReadRateLimit`',
      '`appealsRateLimit`',
      '`trustProxy`',
      '`CHATWARDEN_TRUST_PROXY`',
      '`chatwarden.landing_shared_address`',
      '`CHATWARDEN_PUBLIC_URL`',
      '`CHATWARDEN_LANDING_ORIGINS`',
      '`CHATWARDEN_DELIVERY_URL`',
      '`CHATWARDEN_DELIVERY_SECRET`',
      '`createDeliveryWebhook`',
      '`x-chatwarden-delivery`',
      '`x-chatwarden-signature`',
      '`sha256=`',
      '`POST /v1/appeals/link`',
      '`POST /v1/appeals`',
      '`POST /v1/appeals/mine`',
      '`appealUrl`',
      '`reasonCode`',
      '`invalid_reason`',
      '`reviewFlags`',
      '`overturned`',
      '`cache-control: no-store`',
      '`landingOrigins`',
    ]);
    expect(text).toMatch(/keep query strings out of (your )?access logs/i);
    expect(text).toMatch(/60 reads and 10 writes an hour/);
    expect(text).toMatch(/303/);
    expect(text).toMatch(/appeals must be enabled in the profile/i);
  });

  it('http: says the limits are always per token, and per address only when a real client address is known, with the proxy setting', () => {
    const text = part(readme('http'), '### The appeal page and its delivery (0.2.1)');
    expect(text).toMatch(/always per token/);
    expect(text).toMatch(/only when a real client address is known/);
    expect(text).toMatch(/never by one shared bucket/);
    expect(text).toMatch(/right-most|from the right/);
  });

  it('http: says the receiver must deduplicate on x-chatwarden-delivery, use its own endpoint, and that the scheme is sha256= with no timestamp', () => {
    const text = part(readme('http'), '### The appeal page and its delivery (0.2.1)');
    expect(text).toMatch(/deduplicate on `x-chatwarden-delivery`/);
    expect(text).toMatch(/its own endpoint|separate endpoint/);
    expect(text).toMatch(/no timestamp/);
    expect(text).toMatch(/`v1=`/);
    expect(text).toMatch(/1, 3 and 6 minutes/);
  });

  it('http: the service routes and the process variables are in the service mode section too', () => {
    const text = part(readme('http'), '## Service mode');
    has(text, ['`POST /v1/appeals/link`', '`POST /v1/appeals`', '`POST /v1/appeals/mine`', '`CHATWARDEN_TRUST_PROXY`', '`CHATWARDEN_DELIVERY_URL`', '`CHATWARDEN_PUBLIC_URL`', '`appealUrl`']);
  });

  it('http: every name and route the section names exists in the sources', () => {
    const src = (...p: string[]): string => read('packages', 'http', 'src', ...p);
    expect(src('index.ts')).toContain('appealLandingRoutes');
    expect(src('index.ts')).toContain('createDeliveryWebhook');
    expect(src('index.ts')).toContain('APPEAL_PAGE_CSP');
    expect(src('player.ts')).toContain('landingReadRateLimit');
    expect(src('player.ts')).toContain('trustProxy');
    for (const route of ['GET /appeal', 'GET /appeal/case', 'POST /appeal/case', 'OPTIONS /appeal/case']) expect(src('appealLanding.ts'), route).toContain(`'${route}'`);
    expect(src('service', 'serve.ts')).toContain('CHATWARDEN_TRUST_PROXY');
    expect(src('appealLanding.ts')).toContain('chatwarden.landing_shared_address');
  });

  it('service mode recipe: the three routes, appealUrl, the delivery webhook and its variables, the proxy setting, and no longer says the service has no appeals', () => {
    has(serviceMode, ['`POST /v1/appeals/link`', '`POST /v1/appeals`', '`POST /v1/appeals/mine`', '`appealUrl`', '`CHATWARDEN_PUBLIC_URL`', '`CHATWARDEN_LANDING_ORIGINS`', '`CHATWARDEN_DELIVERY_URL`', '`CHATWARDEN_DELIVERY_SECRET`', '`CHATWARDEN_TRUST_PROXY`', '`appeals.enabled`', '`/appeal`']);
    expect(serviceMode).not.toMatch(/the service has no player routes/);
    expect(serviceMode).not.toMatch(/Appeals and the chat box transport are not on the service/);
    expect(serviceMode).toMatch(/appeal-emails/);
    expect(serviceMode).toMatch(/keep query strings out of (your )?access logs/i);
  });

  it('discord: the overturned post, what it never carries, and that severeOnly does not hold it back', () => {
    has(discord, ['`sanction.overturned`', 'Overturned on appeal: an automatic restriction from the slur list.', 'Overturned on appeal: a decision that came from the links filter.', 'Overturned on appeal: a decision made by the AI.', 'Overturned on appeal: a moderator decision.']);
    expect(discord).toMatch(/shared (thread|"Unattributed reports" thread)/);
    expect(discord).toMatch(/never (carries|names|holds) the term/);
    expect(discord).toMatch(/`severeOnly` does not hold it back/);
  });

  it('store-memory: names the optional methods the appeals wrapper gained in 0.2.1', () => {
    has(memory, ['`recordOverturn`', '`loadAppealByGroup`', '`latestAutoChatStart`', '`overturnedTermCounts`', '`overturnedFilterCounts`', '`purgeOverturns`']);
    expect(memory).toMatch(/optional/);
  });

  it('hub-react: the reason radio, the cause disclosure, the term flag, the filter count and the three settings', () => {
    has(hub, ['What caused this', 'Overturned on appeal', 'We email the person when it is decided', 'how long an appeal link works', 'the support contact shown on the appeal page', '`reviewFlags`', '`overturned`', '`reasonCode`']);
    expect(hub).toMatch(/radio group of the three fixed reasons/);
    expect(hub).toMatch(/Overturned on appeal \(90 days\)/);
  });

  it('player-react: the Appeal page section says the words are machine drafts for Spanish and Portuguese', () => {
    const text = part(readme('player-react'), '## Appeal page');
    expect(text).toMatch(/Spanish and Portuguese are machine-drafted/);
    expect(text).toMatch(/not been reviewed by a person/);
    has(player, ['`AppealPage`', '`readAppealToken(location.search)`']);
  });

  // Migration 27 is shared by every task of 0.2.1, so its README list is judged against the SQL itself, like migration 26.
  describe('migration 27 in the READMEs, against the migration itself', () => {
    const migrations = read('packages', 'store-sqlite', 'src', 'migrations.ts');
    const at = migrations.indexOf('version: 27,');
    const sql = migrations.slice(at, migrations.indexOf('`,', migrations.indexOf('sql: `', at)));
    const tables = [...sql.matchAll(/CREATE TABLE (kit_[a-z_]+)/g)].map((m) => m[1] as string);
    const columns = [...sql.matchAll(/ALTER TABLE (kit_[a-z_]+) ADD COLUMN ([a-z_]+)/g)].map((m) => `${m[1]}.${m[2]}`);
    const created = [...new Set([...sql.matchAll(/CREATE (?:UNIQUE )?INDEX (kit_[a-z_]+)/g)].map((m) => m[1] as string))];
    const dropped = [...new Set([...sql.matchAll(/DROP INDEX (kit_[a-z_]+)/g)].map((m) => m[1] as string))];
    const start = sqliteReadme.indexOf('### Migration 27');
    const section27 = flat(start === -1 ? '' : sqliteReadme.slice(start, sqliteReadme.indexOf('\n#', start + 5) === -1 ? undefined : sqliteReadme.indexOf('\n#', start + 5)));

    it('control: the scan finds the table, the columns, the indexes and the dropped index of the migration', () => {
      expect(tables).toEqual(['kit_overturns']);
      expect(columns).toEqual(expect.arrayContaining(['kit_sanctions.term_id', 'kit_sanctions.overturned_at', 'kit_strikes.overturned', 'kit_reports.overturned_at', 'kit_appeals.reason_code']));
      expect(created.length).toBeGreaterThanOrEqual(5);
      expect(dropped).toEqual(['kit_reports_by_reporter_outcome_reason']);
    });

    it('store-sqlite has a "Migration 27" section that says it is one-way, to back up first, and that it is the one migration of the release', () => {
      expect(start).toBeGreaterThan(-1);
      expect(section27).toMatch(/one-way/);
      expect(section27).toMatch(/back up/i);
      expect(section27).toMatch(/the one migration of the whole 0\.2\.1 release/);
      expect(section27).toMatch(/nothing adds a 28/);
    });

    it.each(tables)('the section names the table %s', (table) => {
      expect(section27).toContain(`\`${table}\``);
    });
    it.each(columns)('the section names the column %s', (column) => {
      expect(section27).toContain(`\`${column}\``);
    });
    it.each(created)('the section names the index %s it creates', (index) => {
      expect(section27).toContain(`\`${index}\``);
    });
    it.each(dropped)('the section names the index %s it drops, and says what replaces it', (index) => {
      expect(section27).toContain(`\`${index}\``);
      expect(section27).toContain('`kit_reports_by_reporter_outcome_overturned`');
    });
    it('the section says the migration-19 reporter index stays (a read names it)', () => {
      expect(section27).toContain('`kit_reports_by_reporter_outcome`');
    });
    it('the core README names no table or index the migrations do not create', () => {
      for (const name of new Set([...core.matchAll(/`(kit_[a-z_]+)`/g)].map((m) => m[1] as string))) {
        expect(new RegExp(`CREATE (?:UNIQUE )?(?:TABLE|INDEX)(?: IF NOT EXISTS)? ${name}\\b`).test(migrations), `${name} is a table or index the migrations create`).toBe(true);
      }
    });
  });
});

describe('docs/status.md and the follow-ups after the 0.2.1 build', () => {
  const status = flat(read('docs', 'status.md'));
  const head = status.slice(0, status.indexOf('## 0.2.0: published'));
  const followUps = flat(read('docs', 'plans', 'follow-ups.md'));

  it('status.md has a 0.2.1 section above 0.2.0 that says built, not yet published, additive, migration 27 and the floors', () => {
    expect(status).toMatch(/## 0\.2\.1: built on branch `appeals-landing`, not yet published/);
    expect(status.indexOf('## 0.2.1')).toBeLessThan(status.indexOf('## 0.2.0: published'));
    for (const needle of ['additive', 'migration 27 (one-way', '`^0.2.1`', '`^0.2.0`', 'patch', 'docs/recipes/appeal-emails.md']) expect(head, needle).toContain(needle);
  });

  it('status.md lists what is verified and what is still the owner\'s: a real-browser pass at desktop and 360 px in light and dark, a native read of the new words, the Moxgate wiring after publish, the production flip', () => {
    for (const needle of ['Verified', 'Still the owner\'s', 'real-browser pass', '360 px', 'light and dark', 'native', 'Spanish and Portuguese', 'Moxgate', 'production']) expect(head, needle).toContain(needle);
    expect(head).not.toMatch(/(published|released) to npm/i);
  });

  it('follow-ups.md parks what 0.2.1 left: a hub editor for appeals.words, multi-process strike forgiveness, a delivery outbox and AI triage of appeals', () => {
    const at = followUps.indexOf('## Appeal links, delivery and feedback (0.2.1), parked');
    expect(at).toBeGreaterThan(-1);
    const part0201 = followUps.slice(at);
    for (const needle of ['`appeals.words`', 'strike forgiveness', 'delivery outbox', 'AI triage of appeals']) expect(part0201, needle).toContain(needle);
  });
});
