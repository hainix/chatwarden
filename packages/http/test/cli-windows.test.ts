import { describe, expect, it } from 'vitest';
import { resolveAnswers } from '../src/cli/answers.js';
import { parseCli } from '../src/cli/args.js';
import { applyPlan, exitCodeOf } from '../src/cli/apply.js';
import { detect } from '../src/cli/detect.js';
import { buildPlan } from '../src/cli/plan.js';
import { renderHuman, renderJson } from '../src/cli/report.js';
import type { FileSpec } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import { VERSIONS } from './cli-stubs.js';

// Review Focus 5: a path printed with backslashes, a specifier with one, CRLF in a generated file.

function templates(answers: { dir: string }): FileSpec[] {
  return [
    { path: `${answers.dir}/kit.ts`, content: "import { loadMatcher } from './terms.js';\nimport * as hooks from './auth.js';\nexport const BASE = '/chatwarden';\n" },
    { path: `${answers.dir}/terms.ts`, content: "export const WORDS = ['zorbak'];\n" },
    { path: `${answers.dir}/auth.ts`, content: '// TODO(auth)\nexport const authorize = () => null;\n', markers: ['TODO(auth)'] },
    { path: 'app/chatwarden/[...path]/route.ts', content: "export { GET } from '../../../src/chatwarden/handler.js';\n" },
  ];
}

describe('Windows: the whole plan and apply run with path.win32 and a C:\\proj root', () => {
  it('backslash --dir src\\chatwarden is normalised, specifiers stay posix, output is posix-printed', async () => {
    const world = createWorld({ kind: 'win32', files: { 'package.json': '{"dependencies":{"express":"5"}}', 'tsconfig.json': '{}', 'src/index.ts': '' } });
    expect(world.root).toBe('C:\\proj');

    const parsed = parseCli(['init', '--dir', 'src\\chatwarden', '--yes']);
    if ('error' in parsed) throw new Error(parsed.error);
    const detected = await detect(world.env);
    if ('error' in detected) throw new Error(detected.error);
    const answers = resolveAnswers(parsed, detected);
    if ('error' in answers) throw new Error(answers.error);
    expect(answers.dir).toBe('src/chatwarden');

    const plan = buildPlan(answers, VERSIONS, templates(answers), detected);
    expect(plan.files.map((f) => f.path)).toEqual(['app/chatwarden/[...path]/route.ts', 'src/chatwarden/auth.ts', 'src/chatwarden/kit.ts', 'src/chatwarden/terms.ts']);

    const result = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false });
    expect(exitCodeOf(result)).toBe(0);
    expect(result.files.map((f) => f.action)).toEqual(['created', 'created', 'created', 'created']);

    // On disk, the files are at Windows paths under the root.
    for (const op of world.ops.filter((o) => o.op === 'rename')) expect(op.to!.startsWith('C:\\proj\\')).toBe(true);
    expect(world.has('src/chatwarden/kit.ts')).toBe(true);
    expect(world.files()).toContain('app/chatwarden/[...path]/route.ts');

    // Specifiers in the text are posix, and the text has no CR and no backslash.
    for (const file of world.files().filter((f) => f !== 'package.json' && f !== 'tsconfig.json' && f !== 'src/index.ts')) {
      const text = world.read(file)!;
      expect(text.includes('\r'), file).toBe(false);
      expect(text.includes('\\'), file).toBe(false);
    }
    expect(world.read('src/chatwarden/kit.ts')).toContain("from './terms.js'");

    // Everything printed is posix and has no drive letter.
    const human = renderHuman(plan, result);
    const json = renderJson(plan, result, VERSIONS.chatwarden);
    for (const text of [human, json]) {
      expect(text).not.toContain('C:');
      expect(text).not.toContain('\\\\');
      expect(text).toContain('src/chatwarden/kit.ts');
    }
    expect(human).not.toContain('\\');
    expect(human).toContain('app/chatwarden/[...path]/route.ts');
  });

  it('the same answers write the same files and the same report under posix and win32', async () => {
    const outputs: Array<{ files: Array<[string, string | undefined]>; human: string; json: string }> = [];
    for (const kind of ['posix', 'win32'] as const) {
      const world = createWorld({ kind, files: { 'package.json': '{"dependencies":{"express":"5"}}', 'tsconfig.json': '{}' } });
      const parsed = parseCli(['init', '--dir', 'chatwarden', '--yes']);
      if ('error' in parsed) throw new Error(parsed.error);
      const detected = await detect(world.env);
      if ('error' in detected) throw new Error(detected.error);
      const answers = resolveAnswers(parsed, detected);
      if ('error' in answers) throw new Error(answers.error);
      const plan = buildPlan(answers, VERSIONS, templates(answers), detected);
      const result = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false });
      outputs.push({ files: world.files().map((f) => [f, world.read(f)]), human: renderHuman(plan, result), json: renderJson(plan, result, '1.0.0') });
    }
    expect(outputs[1]).toEqual(outputs[0]);
  });

  it('a second run on win32 is all unchanged, and an edit is a conflict that is skipped', async () => {
    const world = createWorld({ kind: 'win32', files: { 'package.json': '{}' } });
    const parsed = parseCli(['init', '--yes']);
    if ('error' in parsed) throw new Error(parsed.error);
    const detected = await detect(world.env);
    if ('error' in detected) throw new Error(detected.error);
    const answers = resolveAnswers(parsed, detected);
    if ('error' in answers) throw new Error(answers.error);
    const plan = buildPlan(answers, VERSIONS, templates(answers), detected);
    await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false });
    world.ops.length = 0;
    const again = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false });
    expect(again.files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(world.writes()).toEqual([]);
    world.put('chatwarden/auth.ts', '// edited\r\n');
    const edited = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false });
    expect(edited.files.find((f) => f.path === 'chatwarden/auth.ts')?.action).toBe('skipped');
    expect(exitCodeOf(edited)).toBe(2);
    expect(world.read('chatwarden/auth.ts')).toBe('// edited\r\n');
  });

  it('a CRLF template is written with LF; a Windows reserved name is refused; a --dir with a drive letter never gets to the plan', async () => {
    const world = createWorld({ kind: 'win32', files: { 'package.json': '{}' } });
    const plan = buildPlan(
      { framework: 'express', store: 'sqlite', chat: 'none', chatTransport: 'sse', hub: 'element', discord: false, profile: 'standard', base: '/chatwarden', dir: 'chatwarden', lang: 'ts' },
      VERSIONS,
      [{ path: 'chatwarden/a.ts', content: 'a\r\nb\r\n' }, { path: 'chatwarden/con.ts', content: 'x\n' }],
      { manager: 'npm', react: false },
    );
    const refused = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false });
    expect(exitCodeOf(refused)).toBe(1);
    expect(world.writes()).toEqual([]);

    const ok = await applyPlan(world.env, { ...plan, files: [plan.files[0]!] }, { onConflict: 'skip', dryRun: false });
    expect(exitCodeOf(ok)).toBe(0);
    expect(world.read('chatwarden/a.ts')).toBe('a\nb\n');

    const parsed = parseCli(['init', '--dir', 'C:\\Windows\\x']);
    if ('error' in parsed) throw new Error(parsed.error);
    const detected = await detect(world.env);
    if ('error' in detected) throw new Error(detected.error);
    expect('error' in resolveAnswers(parsed, detected)).toBe(true);
  });
});
