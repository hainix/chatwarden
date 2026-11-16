import { describe, expect, it } from 'vitest';
import { checkProject, renderCheck, renderCheckJson } from '../src/cli/check.js';
import { buildPlan } from '../src/cli/plan.js';
import { renderAll } from '../src/cli/templates/index.js';
import type { Answers } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import type { World, WorldOptions } from './cli-world.js';
import { PROJECT, VERSIONS, answersOf } from './cli-stubs.js';

const SECRET_VALUE = 'drakkuun-secret-value-0123456789-abcdef-0123456789';
const TOKEN_VALUE = 'glarn-token-value-0123456789-abcdef';

function project(over: Partial<Answers> = {}, extra: WorldOptions = {}): { world: World; answers: Answers; files: string[] } {
  const answers = answersOf({ chat: 'box', hub: 'element', ...over });
  const plan = buildPlan(answers, VERSIONS, renderAll, PROJECT);
  const world = createWorld({ files: { 'package.json': '{}', ...extra.files }, ...extra });
  for (const file of plan.files) world.put(file.path, file.content);
  return { world, answers, files: plan.files.map((f) => f.path) };
}
const READY = { CHATWARDEN_SECRET: SECRET_VALUE, CHATWARDEN_ADMIN_TOKEN: TOKEN_VALUE };

describe('checkProject', () => {
  it('a fresh golden reports every marker with file and line; after the markers are removed it passes', async () => {
    const { world, answers } = project({}, { env: READY });
    const fresh = await checkProject(world.env, answers);
    expect(fresh.ok).toBe(false);
    expect(fresh.markers.map((m) => m.marker).sort()).toEqual(['TODO(auth)', 'TODO(identity)', 'TODO(identity)', 'TODO(terms)']);
    expect(new Set(fresh.markers.map((m) => m.file))).toEqual(new Set(['src/chatwarden/auth.ts', 'src/chatwarden/terms.ts']));
    for (const marker of fresh.markers) {
      const text = world.read(marker.file)!.split('\n')[marker.line - 1]!;
      expect(text, `${marker.file}:${marker.line}`).toContain(marker.marker);
    }
    expect(fresh.missingEnv).toEqual([]);

    for (const name of ['auth.ts', 'terms.ts']) world.put(`src/chatwarden/${name}`, world.read(`src/chatwarden/${name}`)!.replaceAll('TODO(', 'DONE('));
    const done = await checkProject(world.env, answers);
    expect(done).toMatchObject({ ok: true, markers: [], missingEnv: [] });
  });

  it('a missing CHATWARDEN_SECRET or CHATWARDEN_ADMIN_TOKEN name is reported, a value is never printed', async () => {
    const { world, answers } = project();
    for (const [env, missing] of [
      [{}, ['CHATWARDEN_SECRET', 'CHATWARDEN_ADMIN_TOKEN']],
      [{ CHATWARDEN_SECRET: SECRET_VALUE }, ['CHATWARDEN_ADMIN_TOKEN']],
      [{ CHATWARDEN_ADMIN_TOKEN: TOKEN_VALUE }, ['CHATWARDEN_SECRET']],
      [{ CHATWARDEN_SECRET: '', CHATWARDEN_ADMIN_TOKEN: TOKEN_VALUE }, ['CHATWARDEN_SECRET']],
    ] as const) {
      world.env.env = { ...env };
      const result = await checkProject(world.env, answers);
      expect(result.missingEnv).toEqual(missing);
      expect(result.ok).toBe(false);
      const printed = renderCheck(result) + renderCheckJson(result, '1.2.3');
      for (const value of [SECRET_VALUE, TOKEN_VALUE]) expect(printed).not.toContain(value);
      for (const name of missing) expect(printed).toContain(name);
    }
  });

  it('a name that is optional (the database file, a Discord role) is not required', async () => {
    const { world, answers } = project({ discord: true });
    world.env.env = { ...READY, DISCORD_WEBHOOK_URL: 'https://discord.example.test/hook' };
    const result = await checkProject(world.env, answers);
    expect(result.missingEnv).toEqual([]);
    world.env.env = { ...READY };
    expect((await checkProject(world.env, answers)).missingEnv).toEqual(['DISCORD_WEBHOOK_URL']);
  });

  it('it reads only files under --dir (and .env.example, which is there), never anything else', async () => {
    const { world, answers } = project({}, { env: READY, files: { '.env': `CHATWARDEN_SECRET=${SECRET_VALUE}\n`, 'src/other.ts': '// TODO(auth) not init\n', 'package.json': '{}' } });
    const result = await checkProject(world.env, answers);
    expect(result.markers.every((m) => m.file.startsWith('src/chatwarden/'))).toBe(true);
    const reads = world.ops.filter((o) => o.op === 'readFile').map((o) => o.path.replaceAll('\\', '/'));
    expect(reads.length).toBeGreaterThan(3);
    for (const read of reads) expect(read.startsWith(`${world.root.replaceAll('\\', '/')}/src/chatwarden/`), read).toBe(true);
    expect(world.writes()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('a folder with no files of init is a problem, not a pass: run init first', async () => {
    const world = createWorld({ files: { 'package.json': '{}' }, env: READY });
    const result = await checkProject(world.env, answersOf());
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/run chatwarden init first/);
    expect(result.files).toEqual([]);
  });

  it('the folder is checked with the same path rules as init: a symlink that leaves the project is refused and nothing is read', async () => {
    const world = createWorld({ files: { 'package.json': '{}' }, absDirs: ['/elsewhere'], links: { 'src/chatwarden': '/elsewhere' }, env: READY });
    const result = await checkProject(world.env, answersOf());
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/symbolic link/);
    expect(world.ops.filter((o) => o.op === 'readFile')).toEqual([]);
  });

  it('a symbolic link or a folder inside the folder is not followed', async () => {
    const { world, answers } = project({}, { env: READY, files: { 'secret-outside.ts': '// TODO(auth) outside\n' }, links: { 'src/chatwarden/link.ts': 'secret-outside.ts' } });
    const result = await checkProject(world.env, answers);
    expect(result.markers.map((m) => m.file)).not.toContain('src/chatwarden/link.ts');
    expect(result.markers.map((m) => m.file)).not.toContain('secret-outside.ts');
  });

  it('works under win32 paths and prints posix paths', async () => {
    const answers = answersOf({ chat: 'box', hub: 'element' });
    const plan = buildPlan(answers, VERSIONS, renderAll, PROJECT);
    const world = createWorld({ kind: 'win32', files: { 'package.json': '{}' }, env: READY });
    for (const file of plan.files) world.put(file.path, file.content);
    const result = await checkProject(world.env, answers);
    expect(result.markers.length).toBe(4);
    for (const marker of result.markers) expect(marker.file).toBe(marker.file.replaceAll('\\', '/'));
  });
});

describe('the report', () => {
  it('the human text lists each marker with its file and line, the missing names and one next step', async () => {
    const { world, answers } = project();
    const text = renderCheck(await checkProject(world.env, answers));
    expect(text).toMatch(/src\/chatwarden\/auth\.ts:\d+ TODO\(auth\)/);
    expect(text).toMatch(/src\/chatwarden\/terms\.ts:\d+ TODO\(terms\)/);
    expect(text).toContain('CHATWARDEN_SECRET');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    const clean = renderCheck({ ok: true, files: ['a'], markers: [], missingEnv: [], problems: [] });
    expect(clean).toMatch(/Nothing left/);
  });

  it('the json is version 1 with ok, markers and missingEnv, and no value, path or content', async () => {
    const { world, answers } = project({}, { env: { CHATWARDEN_SECRET: SECRET_VALUE } });
    const doc = JSON.parse(renderCheckJson(await checkProject(world.env, answers), '9.9.9')) as Record<string, unknown>;
    expect(doc).toMatchObject({ version: 1, chatwarden: '9.9.9', ok: false, check: { missingEnv: ['CHATWARDEN_ADMIN_TOKEN'] } });
    expect(JSON.stringify(doc)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(doc)).not.toContain(world.root);
  });
});
