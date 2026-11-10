import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// The browser-safe packages (core, matcher, store-memory, hub-react and player-react) may import no Node builtin from src: not statically, not through a
// dynamic import(), not through a bare name. This lints snippets as if they sat in those folders with the repo's real
// eslint config, so a weakened ban fails here.

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function messages(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${file}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax').map((m) => `${m.ruleId}: ${m.message}`);
}

const BROWSER_SAFE_SRC = [
  'packages/core/src/x.ts',
  'packages/store-memory/src/x.ts',
  'packages/matcher/src/x.ts',
  'packages/hub-react/src/x.ts',
  'packages/hub-react/src/x.tsx',
  'packages/player-react/src/x.ts',
  'packages/player-react/src/x.tsx',
];

describe.each(BROWSER_SAFE_SRC)('%s', (file) => {
  it.each([
    ["import { createHash } from 'node:crypto';\nexport const a = createHash;\n", 'a static node: import'],
    ["import { createHash } from 'crypto';\nexport const a = createHash;\n", 'a static bare builtin import'],
    ["import { x } from 'node:fs/promises';\nexport const a = x;\n", 'a static node: subpath import'],
    ["export * from 'node:path';\n", 'a node: re-export'],
    ["export const a = await import('node:crypto');\n", 'a dynamic node: import'],
    ["export const a = await import('node:fs/promises');\n", 'a dynamic node: subpath import'],
    ["export const a = await import('crypto');\n", 'a dynamic bare builtin import'],
    ["export const a = await import('fs/promises');\n", 'a dynamic bare builtin subpath import'],
  ])('refuses %s (%s)', async (code) => {
    expect((await messages(code, file)).length).toBeGreaterThan(0);
  });

  it.each([
    ["import { x } from './x.js';\nexport const a = x;\n", 'a relative import'],
    ["import type { Store } from '@chatwarden/core';\nexport type A = Store;\n", 'a type import of core'],
    ["export const a = await import('./lazy.js');\n", 'a dynamic relative import'],
    ["export const a = (globalThis as { process?: { getBuiltinModule?: (n: string) => unknown } }).process?.getBuiltinModule?.('node:crypto');\n", 'the guarded process.getBuiltinModule lookup'],
    ["export const a = await import('pathfinder');\n", 'a package whose name starts like a builtin'],
  ])('allows %s (%s)', async (code) => {
    expect(await messages(code, file)).toEqual([]);
  });
});

describe('outside the browser-safe packages', () => {
  it('allows a node: import in store-sqlite src and in a test', async () => {
    expect(await messages("import { DatabaseSync } from 'node:sqlite';\nexport const a = DatabaseSync;\n", 'packages/store-sqlite/src/x.ts')).toEqual([]);
    expect(await messages("import { createHash } from 'node:crypto';\nexport const a = createHash;\n", 'packages/core/test/x.ts')).toEqual([]);
    expect(await messages("export const a = await import('node:crypto');\n", 'packages/store-memory/test/x.ts')).toEqual([]);
  });
});
