import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CASES, CASES_DIR, HAND_WRITTEN, renderCase } from './cases.js';

/** Every file under `dir`, as posix paths relative to it. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

const update = process.env.UPDATE_GOLDEN === '1';

describe('golden', () => {
  it.each(CASES.map((c) => c.name))("each case's CLI output equals examples/recipes/cases/%s byte for byte (UPDATE_GOLDEN=1 rewrites)", (name) => {
    const recipe = CASES.find((c) => c.name === name)!;
    const files = renderCase(recipe);
    const dir = join(CASES_DIR, name);
    if (update) {
      rmSync(dir, { recursive: true, force: true });
      for (const file of files) {
        const target = join(dir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
    }
    expect(walk(dir), 'the files on disk are exactly the files the CLI writes').toEqual(files.map((f) => f.path).sort());
    for (const file of files) {
      const onDisk = readFileSync(join(dir, file.path), 'utf8');
      expect(onDisk === file.content, `${name}/${file.path} differs from the template output (run with UPDATE_GOLDEN=1 to rewrite on purpose)`).toBe(true);
      expect(onDisk.includes('\r'), `${name}/${file.path} has a carriage return`).toBe(false);
    }
  });

  it('every folder under cases/ is a case or a hand-written recipe', () => {
    const folders = readdirSync(CASES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(folders).toEqual([...CASES.map((c) => c.name), ...HAND_WRITTEN.filter((n) => readdirSync(CASES_DIR).includes(n))].sort());
  });

  it('case names are unique and the case folder names have no spaces', () => {
    const names = CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it('the JS case passes a syntax check', () => {
    const js = CASES.filter((c) => c.check === 'js');
    expect(js.length).toBeGreaterThan(0);
    for (const recipe of js) {
      const files = renderCase(recipe).filter((f) => /\.(m?js)$/.test(f.path));
      expect(files.length).toBeGreaterThan(3);
      for (const file of files) {
        // `node --check` parses the file as the package's module type (this workspace is "type": "module"), so an ESM file passes and a type annotation fails.
        expect(() => execFileSync(process.execPath, ['--check', join(CASES_DIR, recipe.name, file.path)], { stdio: 'pipe' }), file.path).not.toThrow();
      }
    }
  });

  it('the syntax check fails a file with a type annotation (control)', () => {
    const dir = join(CASES_DIR, '..', 'node_modules', '.cache-control');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'bad.mjs');
    writeFileSync(file, 'export const a: number = 1;\n');
    try {
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
