import { describe, expect, it } from 'vitest';
import { applyPlan, exitCodeOf } from '../src/cli/apply.js';
import type { Result } from '../src/cli/apply.js';
import { buildPlan } from '../src/cli/plan.js';
import type { Answers } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import type { PathKind, World } from './cli-world.js';
import { PROJECT, VERSIONS, answersOf, stubTemplates } from './cli-stubs.js';

async function init(world: World, answers: Answers, onConflict: 'skip' | 'overwrite' | 'new' = 'skip'): Promise<Result> {
  return applyPlan(world.env, buildPlan(answers, VERSIONS, stubTemplates, PROJECT), { onConflict, dryRun: false });
}
const tally = (result: Result): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of result.files) out[f.action] = (out[f.action] ?? 0) + 1;
  return out;
};

describe.each(['posix', 'win32'] as const)('idempotent init (%s)', (kind: PathKind) => {
  const fresh = (): World => createWorld({ kind, files: { 'package.json': '{"name":"zorbak"}' } });

  it('init twice with the same answers: all unchanged, exit 0', async () => {
    const world = fresh();
    const answers = answersOf();
    const first = await init(world, answers);
    expect(tally(first)).toEqual({ created: 4 });
    expect(exitCodeOf(first)).toBe(0);
    const snapshot = world.files().map((f) => [f, world.read(f)]);
    world.ops.length = 0;

    const second = await init(world, answers);
    expect(tally(second)).toEqual({ unchanged: 4 });
    expect(exitCodeOf(second)).toBe(0);
    expect(world.writes()).toEqual([]);
    expect(world.files().map((f) => [f, world.read(f)])).toEqual(snapshot);

    const third = await init(world, answers);
    expect(tally(third)).toEqual({ unchanged: 4 });
  });

  it('edit one file, run again: that file skipped, exit 2, no other file touched', async () => {
    const world = fresh();
    const answers = answersOf();
    await init(world, answers);
    const edited = `${world.read('src/chatwarden/auth.ts')}// my own change\n`;
    world.put('src/chatwarden/auth.ts', edited);
    const others = world.files().filter((f) => f !== 'src/chatwarden/auth.ts').map((f) => [f, world.read(f)]);
    world.ops.length = 0;

    const again = await init(world, answers);
    expect(again.files.find((f) => f.path === 'src/chatwarden/auth.ts')).toEqual({ path: 'src/chatwarden/auth.ts', action: 'skipped', reason: 'differs' });
    expect(tally(again)).toEqual({ unchanged: 3, skipped: 1 });
    expect(exitCodeOf(again)).toBe(2);
    expect(world.writes()).toEqual([]);
    expect(world.read('src/chatwarden/auth.ts')).toBe(edited);
    expect(world.files().filter((f) => f !== 'src/chatwarden/auth.ts').map((f) => [f, world.read(f)])).toEqual(others);
  });

  it('the same edit with --on-conflict new leaves the file and writes the new version beside it, and only that', async () => {
    const world = fresh();
    const answers = answersOf();
    await init(world, answers);
    const original = world.read('src/chatwarden/auth.ts')!;
    world.put('src/chatwarden/auth.ts', `${original}// mine\n`);
    world.ops.length = 0;
    const again = await init(world, answers, 'new');
    expect(world.read('src/chatwarden/auth.ts')).toBe(`${original}// mine\n`);
    expect(world.read('src/chatwarden/auth.chatwarden-new.ts')).toBe(original);
    expect(tally(again)).toEqual({ unchanged: 3, 'created-new': 1 });
    expect(world.writes().filter((o) => o.op === 'rename')).toHaveLength(1);
  });

  it('adding an answer (chat box) creates the new files and reports changed ones as conflicts', async () => {
    const world = fresh();
    await init(world, answersOf({ chat: 'none' }));
    world.ops.length = 0;
    const withBox = await init(world, answersOf({ chat: 'box' }));
    expect(withBox.files.find((f) => f.path === 'src/chatwarden/ChatPanel.tsx')?.action).toBe('created');
    // kit.ts carries the chat answer, so the old one differs now: a conflict, not an overwrite.
    expect(withBox.files.find((f) => f.path === 'src/chatwarden/kit.ts')).toEqual({ path: 'src/chatwarden/kit.ts', action: 'skipped', reason: 'differs' });
    expect(world.read('src/chatwarden/kit.ts')).toContain("CHAT = 'none'");
    expect(exitCodeOf(withBox)).toBe(2);
    expect(world.writes().filter((o) => o.op === 'rename').map((o) => world.path.basename(o.to ?? ''))).toEqual(['ChatPanel.tsx']);
    // The changed files are named, so the person can see them with --on-conflict new.
    const skipped = withBox.files.filter((f) => f.action === 'skipped').map((f) => f.path);
    expect(skipped).toEqual(['src/chatwarden/kit.ts']);
  });

  it('a file the adopter deleted comes back; a file they added beside ours is never touched', async () => {
    const world = fresh();
    const answers = answersOf();
    await init(world, answers);
    world.put('src/chatwarden/mine.ts', 'export const mine = 1;\n');
    world.put('notes.md', 'zorbak\n');
    const result = await applyPlan(world.env, buildPlan(answers, VERSIONS, stubTemplates, PROJECT), { onConflict: 'overwrite', dryRun: false });
    expect(tally(result)).toEqual({ unchanged: 4 });
    expect(world.read('src/chatwarden/mine.ts')).toBe('export const mine = 1;\n');
    expect(world.read('notes.md')).toBe('zorbak\n');
  });

  it('the files written are the same on every run (no timestamp, no random value)', async () => {
    const a = fresh();
    const b = fresh();
    await init(a, answersOf());
    await init(b, answersOf());
    expect(a.files().map((f) => [f, a.read(f)])).toEqual(b.files().map((f) => [f, b.read(f)]));
  });
});
