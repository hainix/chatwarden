import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
const NEW_FOUR = ['core', 'store-sqlite', 'matcher', 'profanity'];
const REPO = 'https://github.com/hainix/chatwarden';

describe('every published package has a README', () => {
  it('covers the six packages', () => {
    expect(published).toEqual(['core', 'discord', 'http', 'matcher', 'profanity', 'store-sqlite']);
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

describe('the four new package READMEs', () => {
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

  it('installs @types/express next to express for the HTTP routes, and says why', () => {
    const http = rows(section(doc, 'Install')).find((r) => (r[1] ?? '').includes('@chatwarden/http'));
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
    for (const v of Object.values(parsed.dependencies)) expect(v).toMatch(/^file:vendor\/chatwarden-[a-z-]+-0\.1\.0\.tgz$/);
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
`;
  /** A block that is a fragment (a bare option object, an override line) is not compiled on its own. */
  const standalone = (code: string): boolean => code.startsWith('import ');

  function compile(extra: Array<{ file: string; code: string }> = []): Map<string, string[]> {
    const dir = join(root, 'scripts', '__snippets__').replaceAll('\\', '/');
    const cfg = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
    // The workspace packages resolve to their TypeScript source (the same map vitest.config.ts uses), so this check needs no
    // prior `tsc -b` and never reads a stale `dist`. Exact keys, so a subpath such as `/express` is not taken by the bare name.
    const src = (rel: string): string[] => [`packages/${rel}`];
    const options: ts.CompilerOptions = {
      ...parsed.options,
      pathsBasePath: root,
      paths: {
        '@chatwarden/core': src('core/src/index.ts'),
        '@chatwarden/store-sqlite': src('store-sqlite/src/index.ts'),
        '@chatwarden/matcher': src('matcher/src/index.ts'),
        '@chatwarden/matcher/fixtures': src('matcher/src/fixtures/index.ts'),
        '@chatwarden/matcher/test-fixtures': src('matcher/src/fixtures/testFixtures.ts'),
        '@chatwarden/profanity': src('profanity/src/index.ts'),
        '@chatwarden/discord': src('discord/src/index.ts'),
        '@chatwarden/http': src('http/src/index.ts'),
        '@chatwarden/http/express': src('http/src/express.ts'),
      },
      noEmit: true,
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
    };
    const virtual = new Map<string, string>();
    const stubs = `${dir}/stubs.d.ts`;
    virtual.set(stubs, STUBS);
    const names: string[] = [stubs];
    for (const s of [...snippets.filter((x) => standalone(x.code)), ...extra]) {
      const path = `${dir}/${s.file}`;
      virtual.set(path, `${s.code}\nexport {};\n`);
      names.push(path);
    }
    const host = ts.createCompilerHost(options);
    const realFile = host.fileExists.bind(host);
    const realRead = host.readFile.bind(host);
    const realSource = host.getSourceFile.bind(host);
    const norm = (f: string): string => f.replaceAll('\\', '/');
    host.fileExists = (f) => virtual.has(norm(f)) || realFile(f);
    host.readFile = (f) => virtual.get(norm(f)) ?? realRead(f);
    host.getSourceFile = (f, lang, onError, shouldCreate) => {
      const text = virtual.get(norm(f));
      return text === undefined ? realSource(f, lang, onError, shouldCreate) : ts.createSourceFile(f, text, lang, true);
    };
    const program = ts.createProgram({ rootNames: names, options, host });
    const byFile = new Map<string, string[]>();
    for (const d of ts.getPreEmitDiagnostics(program)) {
      const file = d.file === undefined ? undefined : norm(d.file.fileName);
      if (file === undefined || !file.includes('/__snippets__/')) continue;
      const name = file.split('/').at(-1) as string;
      byFile.set(name, [...(byFile.get(name) ?? []), ts.flattenDiagnosticMessageText(d.messageText, '\n')]);
    }
    return byFile;
  }

  it('finds the snippets it is meant to check, in every package README', () => {
    expect(snippets.length).toBeGreaterThanOrEqual(10);
    for (const dir of published) {
      expect(snippets.filter((s) => s.doc === dir && standalone(s.code)).length, dir).toBeGreaterThanOrEqual(1);
    }
    expect(snippets.some((s) => s.doc === 'root' && standalone(s.code))).toBe(true);
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
