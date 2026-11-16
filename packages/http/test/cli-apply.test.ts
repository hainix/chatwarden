import { describe, expect, it } from 'vitest';
import { applyPlan, exitCodeOf } from '../src/cli/apply.js';
import type { ApplyOptions, Result } from '../src/cli/apply.js';
import { buildPlan } from '../src/cli/plan.js';
import type { FileSpec, Plan } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import type { PathKind, World, WorldOptions } from './cli-world.js';
import { PROJECT, VERSIONS, answersOf, stubTemplates } from './cli-stubs.js';

const OPTS: ApplyOptions = { onConflict: 'skip', dryRun: false };

function planOf(files: FileSpec[]): Plan {
  return buildPlan(answersOf(), VERSIONS, files, PROJECT);
}
const standard = (): Plan => buildPlan(answersOf(), VERSIONS, stubTemplates, PROJECT);
const actions = (result: Result): Record<string, string> => Object.fromEntries(result.files.map((f) => [f.path, f.action]));

/** mulberry32: a small seeded generator, so the property test is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each(['posix', 'win32'] as const)('applyPlan (%s)', (kind: PathKind) => {
  const mk = (extra: WorldOptions = {}): World => createWorld({ kind, files: { 'package.json': '{}' }, ...extra });

  it('creates parent folders and files with \\n endings', async () => {
    const world = mk();
    const plan = planOf([{ path: 'a/b/c/kit.ts', content: 'one\r\ntwo\r\n' }, { path: 'top.ts', content: 'x\n' }]);
    // Hand the apply a CRLF plan directly too: it does not trust its input.
    const raw: Plan = { ...plan, files: [{ path: 'a/b/c/kit.ts', content: 'one\r\ntwo\r\n' }, { path: 'top.ts', content: 'x\r\n' }] };
    const result = await applyPlan(world.env, raw, OPTS);
    expect(result.error).toBeUndefined();
    expect(actions(result)).toEqual({ 'a/b/c/kit.ts': 'created', 'top.ts': 'created' });
    expect(world.read('a/b/c/kit.ts')).toBe('one\ntwo\n');
    expect(world.read('top.ts')).toBe('x\n');
    expect(world.files()).toEqual(['a/b/c/kit.ts', 'package.json', 'top.ts']);
    expect(exitCodeOf(result)).toBe(0);
  });

  it('writes a file through a temporary name in the same folder, then renames it', async () => {
    const world = mk();
    await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'x\n' }]), OPTS);
    const writes = world.writes().filter((o) => o.op === 'writeFile' || o.op === 'rename');
    expect(writes.map((o) => o.op)).toEqual(['writeFile', 'rename']);
    expect(world.path.dirname(writes[0]!.path)).toBe(world.path.dirname(world.abs('src/kit.ts')));
    expect(writes[0]!.path).not.toBe(world.abs('src/kit.ts'));
    expect(writes[1]!.to).toBe(world.abs('src/kit.ts'));
    expect(world.files().filter((f) => f.includes('tmp'))).toEqual([]);
  });

  it('a byte-identical file is unchanged and is not rewritten (the recorder sees no write)', async () => {
    const world = mk();
    const plan = standard();
    await applyPlan(world.env, plan, OPTS);
    world.ops.length = 0;
    const second = await applyPlan(world.env, plan, OPTS);
    expect(world.writes()).toEqual([]);
    expect(world.ops.filter((o) => o.op === 'writeFile')).toEqual([]);
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(second.files).toHaveLength(plan.files.length);
    expect(exitCodeOf(second)).toBe(0);
  });

  it('a differing file is skipped by default, overwritten with overwrite, written beside as name.chatwarden-new.ext with new, and a second conflict on that name is skipped', async () => {
    const plan = planOf([{ path: 'src/kit.ts', content: 'incoming\n' }]);
    const base = { 'package.json': '{}', 'src/kit.ts': 'mine\n' };

    const skipWorld = mk({ files: base });
    const skipped = await applyPlan(skipWorld.env, plan, { onConflict: 'skip', dryRun: false });
    expect(skipped.files).toEqual([{ path: 'src/kit.ts', action: 'skipped', reason: 'differs' }]);
    expect(skipWorld.read('src/kit.ts')).toBe('mine\n');
    expect(skipWorld.writes()).toEqual([]);
    expect(exitCodeOf(skipped)).toBe(2);

    const overwriteWorld = mk({ files: base });
    const overwritten = await applyPlan(overwriteWorld.env, plan, { onConflict: 'overwrite', dryRun: false });
    expect(overwritten.files).toEqual([{ path: 'src/kit.ts', action: 'overwritten', reason: 'differs' }]);
    expect(overwriteWorld.read('src/kit.ts')).toBe('incoming\n');
    expect(exitCodeOf(overwritten)).toBe(0);

    const newWorld = mk({ files: base });
    const beside = await applyPlan(newWorld.env, plan, { onConflict: 'new', dryRun: false });
    expect(beside.files).toEqual([{ path: 'src/kit.ts', action: 'created-new', reason: 'differs', writtenTo: 'src/kit.chatwarden-new.ts' }]);
    expect(newWorld.read('src/kit.ts')).toBe('mine\n');
    expect(newWorld.read('src/kit.chatwarden-new.ts')).toBe('incoming\n');
    expect(exitCodeOf(beside)).toBe(0);

    // Run it again: the name beside is taken, so the second conflict is skipped and nothing is touched.
    newWorld.ops.length = 0;
    const again = await applyPlan(newWorld.env, plan, { onConflict: 'new', dryRun: false });
    expect(again.files).toEqual([{ path: 'src/kit.ts', action: 'skipped', reason: 'differs' }]);
    expect(newWorld.writes()).toEqual([]);
    expect(newWorld.read('src/kit.chatwarden-new.ts')).toBe('incoming\n');
    expect(exitCodeOf(again)).toBe(2);
  });

  it('names the file beside for dotfiles, several dots and no extension', async () => {
    const plan = planOf([
      { path: 'x/.env.example', content: 'new\n' },
      { path: 'x/route.test.ts', content: 'new\n' },
      { path: 'x/Dockerfile', content: 'new\n' },
      { path: 'x/[...path].ts', content: 'new\n' },
    ]);
    const world = mk({ files: { 'package.json': '{}', 'x/.env.example': 'old', 'x/route.test.ts': 'old', 'x/Dockerfile': 'old', 'x/[...path].ts': 'old' } });
    const result = await applyPlan(world.env, plan, { onConflict: 'new', dryRun: false });
    const written = Object.fromEntries(result.files.map((f) => [f.path, f.writtenTo]));
    expect(written).toEqual({
      'x/.env.example': 'x/.env.chatwarden-new.example',
      'x/Dockerfile': 'x/Dockerfile.chatwarden-new',
      'x/[...path].ts': 'x/[...path].chatwarden-new.ts',
      'x/route.test.ts': 'x/route.test.chatwarden-new.ts',
    });
  });

  it('a mix of created, unchanged, skipped and overwritten in one run, in plan order, each decided on its own', async () => {
    const plan = planOf([
      { path: 'a.ts', content: 'a\n' },
      { path: 'b.ts', content: 'b\n' },
      { path: 'c.ts', content: 'c-new\n' },
      { path: 'd.ts', content: 'd\n' },
    ]);
    const world = mk({ files: { 'package.json': '{}', 'b.ts': 'b\n', 'c.ts': 'c-mine\n' } });
    const result = await applyPlan(world.env, plan, OPTS);
    expect(result.files.map((f) => [f.path, f.action])).toEqual([['a.ts', 'created'], ['b.ts', 'unchanged'], ['c.ts', 'skipped'], ['d.ts', 'created']]);
    expect(world.read('c.ts')).toBe('c-mine\n');
    expect(exitCodeOf(result)).toBe(2);
  });

  it('an interrupted write (rename throws) leaves no temp file and no partial target and is exit 3 naming the path', async () => {
    const world = mk({ failOn: (op) => (op.op === 'rename' ? Object.assign(new Error(`EIO: ${world0Root(kind)}`), { code: 'EIO' }) : undefined) });
    const before = world.files();
    const result = await applyPlan(world.env, planOf([{ path: 'src/chatwarden/kit.ts', content: 'x\n' }, { path: 'src/chatwarden/two.ts', content: 'y\n' }]), OPTS);
    expect(exitCodeOf(result)).toBe(3);
    expect(result.error?.kind).toBe('io');
    expect(result.error?.path).toBe('src/chatwarden/kit.ts');
    expect(result.error?.message).toContain('src/chatwarden/kit.ts');
    expect(result.error?.message).not.toContain(world.root);
    expect(result.error?.message).toContain('EIO');
    expect(world.files()).toEqual(before); // no target, no temp file
    expect(world.ops.some((o) => o.op === 'rm')).toBe(true); // the temp name was removed
    // It stopped at the first failure: the second file was not attempted.
    expect(world.ops.filter((o) => o.op === 'rename')).toHaveLength(1);
  });

  it('an interrupted overwrite leaves the old file exactly as it was', async () => {
    const world = mk({ files: { 'package.json': '{}', 'src/kit.ts': 'mine\n' }, failOn: (op) => (op.op === 'rename' ? Object.assign(new Error('EIO'), { code: 'EIO' }) : undefined) });
    const result = await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'incoming\n' }]), { onConflict: 'overwrite', dryRun: false });
    expect(exitCodeOf(result)).toBe(3);
    expect(world.read('src/kit.ts')).toBe('mine\n');
    expect(world.files().filter((f) => f !== 'package.json' && f !== 'src/kit.ts')).toEqual([]);
  });

  it('a permission error is exit 3', async () => {
    for (const failing of ['writeFile', 'mkdir', 'rename'] as const) {
      const world = mk({ failOn: (op) => (op.op === failing ? Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) : undefined) });
      const result = await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'x\n' }]), OPTS);
      expect(exitCodeOf(result), failing).toBe(3);
      expect(result.error?.message).toContain('EACCES');
      expect(result.error?.message).toContain('src/kit.ts');
      expect(result.error?.message).not.toContain(world.root);
      expect(world.files()).toEqual(['package.json']);
    }
  });

  it('an error with no code, or that is not an Error, is still exit 3 with a sentence', async () => {
    for (const thrown of ['plain string', 42, undefined, { weird: true }]) {
      const world = mk();
      world.env.fs.writeFile = () => Promise.reject(thrown);
      const result = await applyPlan(world.env, planOf([{ path: 'k.ts', content: 'x\n' }]), OPTS);
      expect(exitCodeOf(result)).toBe(3);
      expect(result.error?.message).toContain('k.ts');
    }
  });

  it('a folder where a file should go is exit 3, not a crash, and nothing is changed', async () => {
    const world = mk({ dirs: ['src/kit.ts'] });
    const result = await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'x\n' }]), { onConflict: 'overwrite', dryRun: false });
    expect(exitCodeOf(result)).toBe(3);
    expect(result.error?.message).toContain('src/kit.ts');
    expect(world.writes()).toEqual([]);
  });

  it('an earlier file stays written when a later one fails, and the result says which were done', async () => {
    const world = mk({ failOn: (op) => (op.op === 'writeFile' && op.path.includes('b-two') ? Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) : undefined) });
    const result = await applyPlan(world.env, planOf([{ path: 'a-one.ts', content: '1\n' }, { path: 'b-two.ts', content: '2\n' }, { path: 'c-three.ts', content: '3\n' }]), OPTS);
    expect(result.files.map((f) => f.path)).toEqual(['a-one.ts']);
    expect(result.error?.path).toBe('b-two.ts');
    expect(world.read('a-one.ts')).toBe('1\n');
    expect(world.has('c-three.ts')).toBe(false);
    expect(world.files().filter((f) => f.includes('tmp'))).toEqual([]);
    expect(exitCodeOf(result)).toBe(3);
  });

  it('dryRun records zero writes and returns the same list', async () => {
    const files: Record<string, string> = { 'package.json': '{}', 'src/chatwarden/kit.ts': 'mine\n', 'src/chatwarden/auth.ts': standard().files.find((f) => f.path.endsWith('auth.ts'))!.content };
    for (const onConflict of ['skip', 'overwrite', 'new'] as const) {
      const dry = mk({ files });
      const wet = mk({ files });
      const plan = standard();
      const dryResult = await applyPlan(dry.env, plan, { onConflict, dryRun: true });
      const wetResult = await applyPlan(wet.env, plan, { onConflict, dryRun: false });
      expect(dry.writes(), onConflict).toEqual([]);
      expect(dryResult.dryRun).toBe(true);
      expect(wetResult.dryRun).toBe(false);
      expect(dryResult.files).toEqual(wetResult.files);
      expect(dry.files()).toEqual(['package.json', 'src/chatwarden/auth.ts', 'src/chatwarden/kit.ts']);
      expect(exitCodeOf(dryResult)).toBe(exitCodeOf(wetResult));
    }
  });

  it('an unsafe path anywhere in the plan refuses the whole plan before anything is written (exit 1)', async () => {
    for (const bad of ['../outside.ts', '/abs.ts', 'C:\\abs.ts', 'src/CON', 'src/a.', 'x//y.ts']) {
      const world = mk();
      const plan: Plan = { ...planOf([{ path: 'good.ts', content: 'x\n' }]), files: [{ path: 'good.ts', content: 'x\n' }, { path: bad, content: 'y\n' }] };
      const result = await applyPlan(world.env, plan, OPTS);
      expect(result.error?.kind, bad).toBe('unsafe');
      expect(exitCodeOf(result), bad).toBe(1);
      expect(world.writes(), bad).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.error?.message).not.toContain(world.root);
    }
  });

  it('a symlinked folder that leaves the project refuses the plan and writes nothing, even to the good folder', async () => {
    const outside = kind === 'win32' ? 'D:\\elsewhere' : '/elsewhere';
    const world = mk({ absDirs: [outside], links: { 'src/evil': outside } });
    const plan = planOf([{ path: 'src/ok.ts', content: 'x\n' }, { path: 'src/evil/kit.ts', content: 'y\n' }]);
    const result = await applyPlan(world.env, plan, OPTS);
    expect(exitCodeOf(result)).toBe(1);
    expect(world.writes()).toEqual([]);
    expect(world.files()).toEqual(['package.json']);
  });

  it('a symlink planted at the temp name never makes init write through it (a cloned repo cannot redirect a write)', async () => {
    const world = mk({ files: { 'package.json': '{}', 'victim.txt': 'precious\n' }, links: { 'src/.kit.ts.chatwarden-tmp': 'victim.txt' } });
    const result = await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'export const a = 1;\n' }]), OPTS);
    expect(world.read('victim.txt')).toBe('precious\n');
    // The planted link was removed (not followed) and the file was written the normal way.
    expect(result.error).toBeUndefined();
    expect(world.read('src/kit.ts')).toBe('export const a = 1;\n');
    expect(world.writes().filter((o) => o.op === 'writeFile').every((o) => o.flag === 'wx')).toBe(true);
  });

  it('a temp file left by an interrupted run is replaced, not an error', async () => {
    const world = mk({ files: { 'package.json': '{}', 'src/.kit.ts.chatwarden-tmp': 'half' } });
    const result = await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'ok\n' }]), OPTS);
    expect(result.error).toBeUndefined();
    expect(world.read('src/kit.ts')).toBe('ok\n');
    expect(world.has('src/.kit.ts.chatwarden-tmp')).toBe(false);
  });

  it('a file whose only difference is CRLF line endings is unchanged and is not rewritten (a Windows autocrlf checkout)', async () => {
    const world = mk({ files: { 'package.json': '{}', 'a.ts': 'one\r\ntwo\r\n' } });
    const result = await applyPlan(world.env, planOf([{ path: 'a.ts', content: 'one\ntwo\n' }]), OPTS);
    expect(actions(result)).toEqual({ 'a.ts': 'unchanged' });
    expect(exitCodeOf(result)).toBe(0);
    expect(world.read('a.ts')).toBe('one\r\ntwo\r\n');
    expect(world.writes()).toEqual([]);
  });

  it('a real difference next to CRLF endings is still a conflict', async () => {
    const world = mk({ files: { 'package.json': '{}', 'a.ts': 'one\r\nTWO\r\n' } });
    const result = await applyPlan(world.env, planOf([{ path: 'a.ts', content: 'one\ntwo\n' }]), OPTS);
    expect(actions(result)).toEqual({ 'a.ts': 'skipped' });
    expect(exitCodeOf(result)).toBe(2);
  });

  it('two plan entries with the same path are refused as unsafe', async () => {
    const world = mk();
    const plan: Plan = { ...planOf([]), files: [{ path: 'a.ts', content: '1\n' }, { path: 'a.ts', content: '2\n' }] };
    const result = await applyPlan(world.env, plan, OPTS);
    expect(exitCodeOf(result)).toBe(1);
    expect(world.writes()).toEqual([]);
  });

  it('calls the asker once per conflict, with both texts, and not for created or unchanged files', async () => {
    const plan = planOf([{ path: 'a.ts', content: 'a-new\n' }, { path: 'b.ts', content: 'b\n' }, { path: 'c.ts', content: 'c\n' }]);
    const world = mk({ files: { 'package.json': '{}', 'a.ts': 'a-mine\n', 'b.ts': 'b\n' } });
    const asked: Array<{ path: string; existing: string; incoming: string }> = [];
    const result = await applyPlan(world.env, plan, {
      onConflict: 'overwrite',
      dryRun: false,
      ask: async (info) => {
        asked.push(info);
        return 'skip';
      },
    });
    expect(asked).toEqual([{ path: 'a.ts', existing: 'a-mine\n', incoming: 'a-new\n' }]);
    expect(actions(result)).toEqual({ 'a.ts': 'skipped', 'b.ts': 'unchanged', 'c.ts': 'created' });
    expect(world.read('a.ts')).toBe('a-mine\n');
  });

  it('the asker decides each conflict on its own: skip, overwrite, new', async () => {
    const plan = planOf([{ path: 'a.ts', content: 'A\n' }, { path: 'b.ts', content: 'B\n' }, { path: 'c.ts', content: 'C\n' }]);
    const world = mk({ files: { 'package.json': '{}', 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' } });
    const answers = { 'a.ts': 'skip', 'b.ts': 'overwrite', 'c.ts': 'new' } as const;
    const result = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false, ask: async (info) => answers[info.path as keyof typeof answers] });
    expect(actions(result)).toEqual({ 'a.ts': 'skipped', 'b.ts': 'overwritten', 'c.ts': 'created-new' });
    expect(world.read('a.ts')).toBe('a\n');
    expect(world.read('b.ts')).toBe('B\n');
    expect(world.read('c.ts')).toBe('c\n');
    expect(world.read('c.chatwarden-new.ts')).toBe('C\n');
  });

  it('a dry run never asks', async () => {
    const world = mk({ files: { 'package.json': '{}', 'a.ts': 'a\n' } });
    let calls = 0;
    const result = await applyPlan(world.env, planOf([{ path: 'a.ts', content: 'A\n' }]), { onConflict: 'overwrite', dryRun: true, ask: async () => { calls += 1; return 'overwrite'; } });
    expect(calls).toBe(0);
    expect(result.files[0]?.action).toBe('overwritten');
    expect(world.writes()).toEqual([]);
  });

  it('an asker that throws or answers nonsense falls back to skip, never to overwrite', async () => {
    const plan = planOf([{ path: 'a.ts', content: 'A\n' }, { path: 'b.ts', content: 'B\n' }]);
    const world = mk({ files: { 'package.json': '{}', 'a.ts': 'a\n', 'b.ts': 'b\n' } });
    let n = 0;
    const result = await applyPlan(world.env, plan, {
      onConflict: 'overwrite',
      dryRun: false,
      ask: async () => {
        n += 1;
        if (n === 1) throw new Error('terminal closed');
        return 'maybe' as never;
      },
    });
    expect(actions(result)).toEqual({ 'a.ts': 'skipped', 'b.ts': 'skipped' });
    expect(world.read('a.ts')).toBe('a\n');
    expect(world.read('b.ts')).toBe('b\n');
  });

  it('exitCodeOf: 0 for done, 2 for a skip, 1 for an unsafe path and 3 for a failed write, which wins over a skip', () => {
    const file = (action: Result['files'][number]['action']) => ({ path: 'a', action });
    expect(exitCodeOf({ dryRun: false, files: [] })).toBe(0);
    expect(exitCodeOf({ dryRun: false, files: [file('created'), file('unchanged'), file('overwritten'), file('created-new')] })).toBe(0);
    expect(exitCodeOf({ dryRun: false, files: [file('created'), file('skipped')] })).toBe(2);
    expect(exitCodeOf({ dryRun: false, files: [file('skipped')], error: { kind: 'io', message: 'x' } })).toBe(3);
    expect(exitCodeOf({ dryRun: false, files: [], error: { kind: 'unsafe', message: 'x' } })).toBe(1);
  });

  it('never reads a file it was not asked to write, and never lists folders', async () => {
    const world = mk({ files: { 'package.json': '{}', 'secret.env': 'SECRET=zorbak', 'src/other.ts': 'o\n' } });
    await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'x\n' }]), OPTS);
    const read = world.ops.filter((o) => o.op === 'readFile');
    expect(read.every((o) => o.path === world.abs('src/kit.ts'))).toBe(true);
    expect(world.ops.filter((o) => o.op === 'readdir')).toEqual([]);
    expect(world.read('secret.env')).toBe('SECRET=zorbak');
  });
});

function world0Root(kind: PathKind): string {
  return kind === 'win32' ? 'C:\\proj' : '/proj';
}

describe('never overwrites', () => {
  it('for 200 random existing contents and every onConflict except overwrite, the existing bytes are untouched', async () => {
    const random = seeded(20261112);
    const alphabet = ['a', 'b', 'zorbak', 'vlemmo', '\n', '\n', ' ', '\t', '{', '}', '\u00e9', '\u2603', ';', '// TODO(auth)\n', "import x from './kit.js';\n"];
    for (let i = 0; i < 200; i += 1) {
      let existing = '';
      const pieces = Math.floor(random() * 30);
      for (let p = 0; p < pieces; p += 1) existing += alphabet[Math.floor(random() * alphabet.length)]!;
      const content = `${existing}${random() < 0.5 ? 'x' : ''}tail ${i}\n`;
      for (const onConflict of ['skip', 'new'] as const) {
        const world = createWorld({ files: { 'package.json': '{}', 'src/kit.ts': existing } });
        const result = await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content }]), { onConflict, dryRun: false });
        expect(world.read('src/kit.ts'), `case ${i} ${onConflict}`).toBe(existing);
        expect(result.error).toBeUndefined();
        expect(world.ops.some((o) => o.op === 'rename' && o.to === world.abs('src/kit.ts')), `case ${i} ${onConflict}`).toBe(false);
      }
      // An asker that says skip, new or throws never overwrites either.
      for (const answer of ['skip', 'new', 'boom'] as const) {
        const world = createWorld({ files: { 'package.json': '{}', 'src/kit.ts': existing } });
        await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content }]), {
          onConflict: 'overwrite',
          dryRun: false,
          ask: async () => {
            if (answer === 'boom') throw new Error('closed');
            return answer;
          },
        });
        expect(world.read('src/kit.ts'), `case ${i} ask ${answer}`).toBe(existing);
      }
      // And a dry run never overwrites, whatever the mode.
      const dryWorld = createWorld({ files: { 'package.json': '{}', 'src/kit.ts': existing } });
      await applyPlan(dryWorld.env, planOf([{ path: 'src/kit.ts', content }]), { onConflict: 'overwrite', dryRun: true });
      expect(dryWorld.read('src/kit.ts')).toBe(existing);
    }
  });

  it('control: with overwrite the same setup does replace the bytes (so the property above can fail)', async () => {
    const world = createWorld({ files: { 'package.json': '{}', 'src/kit.ts': 'mine\n' } });
    await applyPlan(world.env, planOf([{ path: 'src/kit.ts', content: 'incoming\n' }]), { onConflict: 'overwrite', dryRun: false });
    expect(world.read('src/kit.ts')).toBe('incoming\n');
  });
});
