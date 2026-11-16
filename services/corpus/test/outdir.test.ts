import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTermsRelease } from '../src/build/release.js';
import { defaultOutDir, guardOutDir } from '../src/tools/outdir.js';
import { nodeIo, type ToolIo } from '../src/tools/io.js';
import { main as evalset } from '../src/tools/evalset.js';
import { main as publish } from '../src/tools/publish.js';
import { main as release } from '../src/tools/release.js';
import { main as sign } from '../src/tools/sign.js';
import { generateSigningKey } from '../src/tools/keys.js';
import { makeBuildWorld } from './build-world.js';
import { MemoryStore, PASS } from './publish-world.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';

// Where the tools write the real list (design 16: it never touches git): outside every git tree by default, and a path inside one is refused unless
// it is in a folder .gitignore covers (`release-out/` or `.corpus-data/` at the top of the repository).

const ioWith = (repoRoots: string[], home = resolve('/home/owner')): Pick<ToolIo, 'exists' | 'home'> => ({
  exists: (p) => repoRoots.some((r) => resolve(p) === resolve(r, '.git')),
  home,
});
const REPO = resolve('/work/chatwarden');

describe('guardOutDir', () => {
  it('lets a folder outside every git tree through', () => {
    expect(() => guardOutDir(resolve('/home/owner/out'), ioWith([REPO]))).not.toThrow();
    expect(() => guardOutDir(resolve('/work/other/out'), ioWith([REPO]))).not.toThrow();
  });

  it.each(['out', 'services/corpus/out', 'docs', '.', 'release-output', 'release-out-2', '.corpus-data-x', 'x/release-out'])('refuses %s inside the repository', (rel) => {
    expect(() => guardOutDir(join(REPO, rel), ioWith([REPO]))).toThrow(expect.objectContaining({ code: 'in_git_tree' }));
  });

  it.each(['release-out', 'release-out/sub', '.corpus-data', '.corpus-data/2026-12'])('allows %s at the top of the repository (it is git-ignored)', (rel) => {
    expect(() => guardOutDir(join(REPO, rel), ioWith([REPO]))).not.toThrow();
  });

  it('is not fooled by .. segments', () => {
    expect(() => guardOutDir(join(REPO, 'release-out', '..', 'src'), ioWith([REPO]))).toThrow(expect.objectContaining({ code: 'in_git_tree' }));
    expect(() => guardOutDir(join(REPO, 'x', '..', 'release-out'), ioWith([REPO]))).not.toThrow();
  });

  it('a relative path is read against the working directory', () => {
    const cwd = process.cwd();
    const roots = [cwd];
    expect(() => guardOutDir('somewhere', ioWith(roots))).toThrow(expect.objectContaining({ code: 'in_git_tree' }));
    expect(() => guardOutDir('release-out', ioWith(roots))).not.toThrow();
  });

  it('the default is a folder in the home directory, never in a repository', () => {
    const d = defaultOutDir(ioWith([REPO]));
    expect(d).toBe(join(resolve('/home/owner'), 'chatwarden-release-out'));
    expect(() => guardOutDir(d, ioWith([REPO]))).not.toThrow();
  });
});

let tw: ToolWorld;
let gitDir: string;
beforeEach(() => {
  tw = makeToolWorld();
  gitDir = join(tw.dir, 'repo');
  mkdirSync(join(gitDir, '.git'), { recursive: true });
});
afterEach(() => tw.cleanup());

describe('the tools write only where the guard allows', () => {
  it('release: --out inside a git tree is refused and nothing is written; the default goes to the home folder', async () => {
    const w = await makeBuildWorld();
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    const dump = join(tw.dir, 'd1.sql');
    const parts = [readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')];
    for (const table of ['terms', 'term_lines', 'innocent_words', 'negative_lines', 'releases']) {
      const cols = (w.db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      const quoted = cols.map((c) => `quote("${c}")`).join(" || ',' || ");
      for (const r of w.db.raw.prepare(`SELECT ${quoted} AS v FROM ${table}`).all() as { v: string }[]) parts.push(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${r.v});`);
    }
    writeFileSync(dump, parts.join('\n'));
    const io = { ...tw.io, clock: w.clock };
    expect(await release(['--dump', dump, '--out', join(gitDir, 'out')], io)).toBe(1);
    expect(tw.err.join('\n')).toContain('in_git_tree');
    expect(readdirSync(gitDir)).toEqual(['.git']);
    expect(await release(['--dump', dump, '--out', join(gitDir, 'release-out')], io)).toBe(0);
    expect(readdirSync(join(gitDir, 'release-out')).length).toBeGreaterThan(0);
    tw.out.length = 0;
    expect(await release(['--dump', dump], io)).toBe(0);
    expect(readdirSync(join(tw.dir, 'home', 'chatwarden-release-out')).sort()).toEqual(['terms-2026.12.0.release.json', 'terms-2026.12.0.zip']);
  });

  it('eval build: --out inside a git tree is refused before anything is read or written', async () => {
    expect(await evalset(['build', '--cases', join(tw.dir, 'nothing'), '--dump', join(tw.dir, 'nothing.sql'), '--out', join(gitDir, 'sub')], tw.io)).toBe(1);
    expect(tw.err.join('\n')).toContain('in_git_tree');
    expect(readdirSync(gitDir)).toEqual(['.git']);
  });

  it('publish --dry-run: --out inside a git tree is refused; the default is the home folder', async () => {
    const k = generateSigningKey('k1', PASS);
    const keyPath = join(tw.dir, 'k1.pem');
    writeFileSync(keyPath, k.pem);
    const bw = await makeBuildWorld();
    await bw.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    const built = await buildTermsRelease(bw.db, { clock: tw.clock, version: '2026.12.0', sequence: 1, previous: null });
    const zip = join(tw.dir, 'terms-2026.12.0.zip');
    writeFileSync(zip, built.zip);
    const rel = join(tw.dir, 'terms-2026.12.0.release.json');
    writeFileSync(rel, JSON.stringify({ summary: built.summary, held: built.held, stamped: built.stamped }));
    const withSecrets = makeToolWorld({ secrets: [PASS, PASS, PASS, PASS] });
    try {
      const io = { ...withSecrets.io, clock: tw.clock, home: join(tw.dir, 'home') };
      expect(await sign(['--kind', 'zip', '--file', zip, '--key-id', 'k1', '--key', keyPath], io)).toBe(0);
      const base = ['--release', rel, '--key-id', 'k1', '--key', keyPath, '--dry-run'];
      const store = new MemoryStore();
      expect(await publish([...base, '--out', join(gitDir, 'o')], io, { store })).toBe(1);
      expect(withSecrets.err.join('\n')).toContain('in_git_tree');
      expect(readdirSync(gitDir)).toEqual(['.git']);
      expect(await publish(base, io, { store })).toBe(0);
      expect(readdirSync(join(tw.dir, 'home', 'chatwarden-release-out')).sort()).toEqual(['index.json', 'index.json.sig']);
    } finally {
      withSecrets.cleanup();
    }
  });

  it('nodeIo knows the home directory', () => {
    expect(typeof nodeIo().home).toBe('string');
    expect(nodeIo().home.length).toBeGreaterThan(0);
  });
});
