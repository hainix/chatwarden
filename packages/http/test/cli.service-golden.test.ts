import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentProblems } from '../src/cli/plan.js';
import { serviceFiles } from '../src/cli/templates/service.js';
import type { GameChoice, ProfileChoice, Store } from '../src/cli/types.js';
import { VERSION } from '../src/version.js';

// S5: the files `init --service` writes, for each preset, equal the committed goldens under examples/service/cases (UPDATE_GOLDEN=1 rewrites on purpose), and the Dockerfile and compose file
// pass the static rules of a recipe: no secret in the image, a non-root user, the loopback binding, the three variables read from the environment.

const CASES_DIR = fileURLToPath(new URL('../../../examples/service/cases', import.meta.url));
const CASES = [
  { name: 'relaxed', profile: 'relaxed', store: 'sqlite' },
  { name: 'standard', profile: 'standard', store: 'sqlite' },
  { name: 'strict', profile: 'strict', store: 'sqlite' },
  { name: 'standard-memory', profile: 'standard', store: 'memory' },
  { name: 'creator', profile: 'standard', store: 'sqlite', game: 'creator' },
] as const;
const update = process.env.UPDATE_GOLDEN === '1';
const DIR = 'chatwarden-service';

const render = (c: { profile: ProfileChoice; store: Store; game?: GameChoice }) =>
  serviceFiles({ store: c.store, profile: c.profile, dir: DIR, ...(c.game === undefined ? {} : { game: c.game }) }, { chatwarden: VERSION }).map((f) => ({ path: f.path.slice(`${DIR}/`.length), content: f.content }));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)).map((p) => `${e.name}/${p}`) : [e.name])).sort();

describe('golden', () => {
  it.each(CASES.map((c) => c.name))('the files for %s equal examples/service/cases/%s byte for byte', (name) => {
    const c = CASES.find((x) => x.name === name)!;
    const files = render(c);
    const dir = join(CASES_DIR, name);
    if (update) {
      rmSync(dir, { recursive: true, force: true });
      for (const file of files) {
        const target = join(dir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
    }
    expect(walk(dir)).toEqual(files.map((f) => f.path).sort());
    for (const file of files) {
      const onDisk = readFileSync(join(dir, file.path), 'utf8');
      expect(onDisk === file.content, `${name}/${file.path} differs (UPDATE_GOLDEN=1 rewrites on purpose)`).toBe(true);
      expect(onDisk.includes('\r')).toBe(false);
    }
  });

  it('every folder under cases/ is a case', () => {
    expect(readdirSync(CASES_DIR).sort()).toEqual(CASES.map((c) => c.name).sort());
  });
});

describe('the files are the same for every preset except profile.json', () => {
  it('only the preset in profile.json changes with --profile', () => {
    const [relaxed, standard, strict] = [CASES[0], CASES[1], CASES[2]].map((c) => render(c));
    for (const other of [relaxed, strict]) {
      for (const file of standard!) {
        if (file.path === 'profile.json') expect(other!.find((f) => f.path === file.path)?.content).not.toBe(file.content);
        else expect(other!.find((f) => f.path === file.path)?.content, file.path).toBe(file.content);
      }
    }
  });
});

describe('the creator case', () => {
  it('creator differs from standard only in profile.json, and there it adds the team note after the preset', () => {
    const standard = render(CASES[1]);
    const creator = render(CASES[4]);
    expect(creator.map((f) => f.path)).toEqual(standard.map((f) => f.path));
    for (const file of standard) {
      const other = creator.find((f) => f.path === file.path)!;
      if (file.path === 'profile.json') expect(other.content).not.toBe(file.content);
      else expect(other.content, file.path).toBe(file.content);
    }
    expect(JSON.parse(creator.find((f) => f.path === 'profile.json')!.content)).toEqual({
      preset: 'standard',
      teamNotes: [{ text: 'Protect the creator and their guests from targeted abuse' }],
      contexts: {},
      names: { reserved: [] },
    });
    expect(Object.keys(JSON.parse(creator.find((f) => f.path === 'profile.json')!.content) as object)).toEqual(['preset', 'teamNotes', 'contexts', 'names']);
  });

  it('every other case writes the profile.json it always did (no team notes)', () => {
    for (const c of CASES.filter((x) => x.name !== 'creator')) expect(JSON.parse(render(c).find((f) => f.path === 'profile.json')!.content), c.name).toEqual({ preset: c.profile, contexts: {}, names: { reserved: [] } });
  });
});

describe('the Dockerfile', () => {
  const docker = render(CASES[1]).find((f) => f.path === 'Dockerfile')!.content;
  const lines = docker.split('\n').filter((l) => !l.startsWith('#') && l.trim() !== '');

  it('parses: every instruction is a Dockerfile instruction, and the first is FROM node:22-slim', () => {
    const known = new Set(['FROM', 'ARG', 'ENV', 'RUN', 'WORKDIR', 'COPY', 'USER', 'VOLUME', 'EXPOSE', 'HEALTHCHECK', 'CMD', 'LABEL']);
    let continued = false;
    for (const line of lines) {
      if (!continued) expect(known.has(line.split(/\s+/)[0] as string), line).toBe(true);
      continued = line.endsWith('\\');
    }
    expect(lines[0]).toBe('FROM node:22-slim');
  });

  it('ARG CHATWARDEN_VERSION is the CLI\'s own version, exact, and the six packages are installed at it', () => {
    expect(docker).toMatch(new RegExp(`^ARG CHATWARDEN_VERSION=${VERSION.replaceAll('.', '\\.')}$`, 'm'));
    for (const pkg of ['core', 'http', 'store-sqlite', 'matcher', 'profanity', 'hub-element']) expect(docker).toContain(`@chatwarden/${pkg}@\${CHATWARDEN_VERSION}`);
    expect(docker).toMatch(/npm install --omit=dev --no-audit --no-fund/);
  });

  it('runs as the non-root node user, keeps data in a volume, exposes 8787, has a health check on /readyz and starts serve', () => {
    expect(docker).toMatch(/^USER node$/m);
    expect(docker).toMatch(/^VOLUME \/data$/m);
    expect(docker).toMatch(/^EXPOSE 8787$/m);
    expect(docker).toMatch(/^HEALTHCHECK /m);
    expect(docker).toMatch(/\/readyz/);
    expect(docker).toMatch(/^CMD \["node", "node_modules\/\.bin\/chatwarden", "serve"\]$/m);
    expect(docker).toMatch(/CHATWARDEN_HOST=0\.0\.0\.0/);
    expect(docker).toMatch(/CHATWARDEN_DB=\/data\/chatwarden\.db/);
  });

  it('holds no secret: no ENV or ARG for the secret, the keys or the admin token, and no key-like run', () => {
    for (const name of ['CHATWARDEN_SECRET', 'CHATWARDEN_SERVICE_KEYS', 'CHATWARDEN_ADMIN_TOKEN']) expect(docker, name).not.toMatch(new RegExp(`^(ENV|ARG) .*${name}`, 'm'));
    expect(contentProblems(docker)).toEqual([]);
  });

  it('the .dockerignore keeps the folder\'s own files, env files and databases out of the build', () => {
    const ignore = render(CASES[1]).find((f) => f.path === '.dockerignore')!.content;
    for (const entry of ['.env', '.env.*', '*.db', 'node_modules', 'Dockerfile', 'compose.yaml']) expect(ignore.split('\n')).toContain(entry);
  });
});

describe('compose.yaml', () => {
  const compose = render(CASES[1]).find((f) => f.path === 'compose.yaml')!.content;

  it('binds 8787 to 127.0.0.1 and says to put a TLS proxy or a private network in front before exposing it', () => {
    expect(compose).toMatch(/"127\.0\.0\.1:8787:8787"/);
    expect(compose).not.toMatch(/"8787:8787"|0\.0\.0\.0:8787/);
    expect(compose).toMatch(/TLS proxy|private network/);
  });

  it('reads the three variables from the environment and writes none', () => {
    expect(compose).toMatch(/CHATWARDEN_SECRET: \$\{CHATWARDEN_SECRET:\?/);
    expect(compose).toMatch(/CHATWARDEN_SERVICE_KEYS: \$\{CHATWARDEN_SERVICE_KEYS:\?/);
    expect(compose).toMatch(/CHATWARDEN_ADMIN_TOKEN: \$\{CHATWARDEN_ADMIN_TOKEN:-\}/);
    expect(compose).not.toMatch(/(SECRET|KEYS|TOKEN): [^$\s]/);
  });

  it('keeps the data on a named volume', () => {
    expect(compose).toMatch(/chatwarden-data:\/data/);
  });
});
