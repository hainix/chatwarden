import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { CASES, RECIPES_DIR } from './cases.js';

const run = promisify(execFile);
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const MAX = 16 * 1024 * 1024;
const NEWLINE = String.fromCharCode(10);
const SLASH = String.fromCharCode(92);

/** `tsc -p <config> --noEmit` in the workspace: the output lines (empty when it compiles). */
async function compile(config: string, cwd = RECIPES_DIR): Promise<string[]> {
  try {
    const { stdout } = await run(process.execPath, [tsc, '-p', config, '--noEmit', '--pretty', 'false'], { cwd, maxBuffer: MAX });
    return stdout.split(NEWLINE).filter((line) => line.trim() !== '');
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? String(err);
    return out.split(NEWLINE).filter((line) => line.trim() !== '');
  }
}

async function listed(config: string): Promise<string> {
  try {
    const { stdout } = await run(process.execPath, [tsc, '-p', config, '--noEmit', '--listFilesOnly'], { cwd: RECIPES_DIR, maxBuffer: MAX });
    return stdout.replaceAll(SLASH, '/');
  } catch {
    return ''; // a config with nothing to compile lists nothing
  }
}

const results: Record<string, string[]> = {};

describe('typecheck', () => {
  beforeAll(async () => {
    // tsc fails a config with nothing to compile (TS18003), so the bundler config runs only when a case uses it.
    [results.nodenext, results.bundler] = await Promise.all([compile('tsconfig.json'), CASES.some((c) => c.check === 'bundler') ? compile('tsconfig.bundler.json') : []]);
  }, 600_000);

  it('every case compiles with tsc --noEmit under its config', () => {
    expect(results.nodenext, results.nodenext?.join(NEWLINE)).toEqual([]);
    expect(results.bundler, results.bundler?.join(NEWLINE)).toEqual([]);
  });

  it.each(CASES.filter((c) => c.check !== 'js').map((c) => c.name))('%s is covered by the config it names (a config that missed it would pass with nothing to compile)', async (name) => {
    const recipe = CASES.find((c) => c.name === name)!;
    const files = await listed(recipe.check === 'bundler' ? 'tsconfig.bundler.json' : 'tsconfig.json');
    expect(files).toContain(`/cases/${name}/chatwarden/kit.ts`);
    const other = await listed(recipe.check === 'bundler' ? 'tsconfig.json' : 'tsconfig.bundler.json');
    expect(other).not.toContain(`/cases/${name}/`);
  }, 120_000);

  it('the checker fails a project with a type error (control)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-recipes-control-'));
    try {
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['bad.ts'] }));
      writeFileSync(join(dir, 'bad.ts'), "export const a: number = 'zorbak';" + NEWLINE);
      const lines = await compile('tsconfig.json', dir);
      expect(lines.join(NEWLINE)).toContain('TS2322');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
