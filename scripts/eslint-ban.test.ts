import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// The browser-safe packages (core, matcher, store-memory, hub-react, player-react and hub-element) may import no Node builtin from src: not statically, not through a
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
  'packages/hub-element/src/x.ts',
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

// The AI never writes a sanction, a strike, a mute or a notice (design: the ceilings hold in code). The way that is kept by construction: nothing
// under packages/core/src/ai imports the modules that write them. The same folder is still browser-safe (the override must keep that ban).
const AI_SRC = ['packages/core/src/ai/x.ts', 'packages/core/src/ai/sub/x.ts'];
const WRITERS = ['decide', 'sanctions', 'strikes', 'mutes', 'notices'];
const imp = (from: string): string => `import { x } from '${from}';\nexport const a = x;\n`;

describe.each(AI_SRC)('%s: the AI folder may not import what writes a sanction', (file) => {
  const up = file.endsWith('sub/x.ts') ? '../../' : '../';

  it.each(WRITERS)('the lint rule rejects an import of %s from the ai folder, with or without the extension', async (w) => {
    expect(await messages(imp(`${up}${w}.js`), file)).toHaveLength(1);
    expect(await messages(imp(`${up}${w}`), file)).toHaveLength(1);
  });

  it.each([
    ["import type { X } from '../decide.js';\nexport type A = X;\n", 'a type-only import of decide'],
    ["export { x } from '../sanctions.js';\n", 'a re-export from sanctions'],
    ["export * from '../notices.js';\n", 'a star re-export from notices'],
    ["export const a = await import('../strikes.js');\n", 'a dynamic import of strikes'],
    ["export const a = await import('../mutes.js');\n", 'a dynamic import of mutes'],
    ["export const a = await import('../../decide.js');\n", 'a dynamic import of decide by a deeper path'],
    ["import { x } from '../../decide.js';\nexport const a = x;\n", 'a deeper relative path to decide'],
  ])('refuses %s (%s)', async (code) => {
    expect((await messages(code, file)).length).toBeGreaterThan(0);
  });

  it('says why', async () => {
    expect((await messages(imp(`${up}decide.js`), file)).join('\n')).toMatch(/AI never writes/);
  });

  it.each([
    ["import type { Store } from '../types.js';\nexport type A = Store;\n", 'the shared types'],
    ["import { sha256Hex } from '../crypto.js';\nexport const a = sha256Hex;\n", 'the crypto helper'],
    ["import { x } from './worker.js';\nexport const a = x;\n", 'a sibling in the AI folder'],
    ["import { x } from '../audit.js';\nexport const a = x;\n", 'the audit trail (the AI writes its own audit rows)'],
    ["import { x } from '../decideHelpers.js';\nexport const a = x;\n", 'a name that starts like decide'],
    ["import { x } from '../noticesView.js';\nexport const a = x;\n", 'a name that starts like notices'],
    ["import { x } from '../dismissMany.js';\nexport const a = x;\n", 'a module that is not in the list'],
    ["export const a = await import('./lazy.js');\n", 'a dynamic relative import'],
  ])('allows %s (%s)', async (code) => {
    expect(await messages(code, file)).toEqual([]);
  });

  it('still refuses a Node builtin (the override keeps the browser-safe ban)', async () => {
    expect((await messages("import { createHash } from 'node:crypto';\nexport const a = createHash;\n", file)).length).toBeGreaterThan(0);
    expect((await messages("import { x } from 'fs';\nexport const a = x;\n", file)).length).toBeGreaterThan(0);
    expect((await messages("export const a = await import('node:fs');\n", file)).length).toBeGreaterThan(0);
    expect((await messages("export const a = await import('fs/promises');\n", file)).length).toBeGreaterThan(0);
  });
});

describe('outside the AI folder the same imports are fine', () => {
  it.each(['packages/core/src/x.ts', 'packages/core/src/chatwarden.ts', 'packages/core/test/ai/x.ts', 'packages/http/src/x.ts', 'packages/hub-react/src/x.ts'])(
    '%s may import decide, sanctions, strikes, mutes and notices',
    async (file) => {
      for (const w of WRITERS) expect(await messages(imp(`../${w}.js`), file)).toEqual([]);
    },
  );

  it('a sibling folder that merely starts like ai is not the AI folder', async () => {
    expect(await messages(imp('../decide.js'), 'packages/core/src/aiding/x.ts')).toEqual([]);
  });
});

describe('the rule names exactly the five modules', () => {
  it('refuses the five and no sixth: every other module of core/src can be imported from the AI folder', async () => {
    const names = readdirSync(`${root}packages/core/src`)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
    const refused: string[] = [];
    for (const n of names) if ((await messages(imp(`../${n}.js`), 'packages/core/src/ai/x.ts')).length > 0) refused.push(n);
    expect(refused.sort()).toEqual([...WRITERS].sort());
  });
});
