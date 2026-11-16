import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { CASES_DIR } from './cases.js';

// The goldens live in the repo, so the repo's own eslint covers them: the templates must write code a linter has no complaint about, which is a
// fair floor for an adopter's lint too.

const root = join(CASES_DIR, '..', '..', '..');

describe('lint', () => {
  it('the goldens are clean under the repo eslint (no error, no warning)', async () => {
    const eslint = new ESLint({ cwd: root });
    const results = await eslint.lintFiles(['examples/recipes/cases']);
    expect(results.length).toBeGreaterThan(10);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId ?? 'parse'}: ${m.message}`));
    expect(problems).toEqual([]);
  }, 120_000);

  it('the same linter does report a problem in a recipe-shaped file (control)', async () => {
    const dir = mkdtempSync(join(root, 'examples', 'recipes', '.lint-control-'));
    try {
      const file = join(dir, 'bad.ts');
      writeFileSync(file, 'let unusedZorbak = 1;\n');
      const results = await new ESLint({ cwd: root }).lintFiles([file]);
      expect(results.flatMap((r) => r.messages).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      expect(tmpdir().length).toBeGreaterThan(0);
    }
  }, 60_000);
});
