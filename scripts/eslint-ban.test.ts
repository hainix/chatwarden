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
  'packages/matcher/src/corpus/x.ts',
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

// The shared term list's server half is the one folder under a browser-safe package's src that may import node: (a disk cache, the installation key,
// a starter). Both halves are pinned: the exemption works there, and only there. The isomorphic folder beside it (the verifier and the
// loader, which a page may bundle) keeps the ban, and so do look-alike folder names, nested ones, and the same folder of any other package.
describe('the matcher corpus/node exemption', () => {
  const NODE_IMPORTS: [string, string][] = [
    ["import { readFile } from 'node:fs/promises';\nexport const a = readFile;\n", 'a static node: import'],
    ["import { join } from 'node:path';\nexport const a = join;\n", 'a static node:path import'],
    ["import { randomBytes } from 'crypto';\nexport const a = randomBytes;\n", 'a bare builtin import'],
    ["export const a = await import('node:fs/promises');\n", 'a dynamic node: import'],
    ["export * from 'node:os';\n", 'a node: re-export'],
  ];
  it.each(NODE_IMPORTS)('allows %s (%s) in packages/matcher/src/corpus/node, at any depth', async (code) => {
    for (const file of ['packages/matcher/src/corpus/node/x.ts', 'packages/matcher/src/corpus/node/fileCache.ts', 'packages/matcher/src/corpus/node/deeper/x.ts']) {
      expect(await messages(code, file), file).toEqual([]);
    }
  });
  it.each(NODE_IMPORTS)('refuses %s (%s) everywhere else in the matcher src', async (code) => {
    for (const file of [
      'packages/matcher/src/x.ts',
      'packages/matcher/src/corpus/x.ts',
      'packages/matcher/src/corpus/loader.ts',
      'packages/matcher/src/corpus/sub/x.ts',
      'packages/matcher/src/fixtures/x.ts',
      'packages/matcher/src/vendored/x.ts',
    ]) {
      expect((await messages(code, file)).length, file).toBeGreaterThan(0);
    }
  });
  it.each(NODE_IMPORTS)("refuses %s (%s) in look-alike folders and in another package's corpus/node", async (code) => {
    for (const file of [
      'packages/matcher/src/corpus/nodes/x.ts',
      'packages/matcher/src/corpus/node_x/x.ts',
      'packages/matcher/src/corpus/xnode/x.ts',
      'packages/matcher/src/corpus/Node/x.ts',
      'packages/matcher/src/node/x.ts',
      'packages/matcher/src/fixtures/node/x.ts',
      'packages/matcher/src/corpus/sub/node/x.ts',
      'packages/matcher/src/corpus/node.ts',
      'packages/core/src/corpus/node/x.ts',
      'packages/store-memory/src/corpus/node/x.ts',
      'packages/hub-react/src/corpus/node/x.ts',
    ]) {
      expect((await messages(code, file)).length, file).toBeGreaterThan(0);
    }
  });
  it('the exemption turns off the import ban only: the rest of the lint config still applies there', async () => {
    const [result] = await eslint.lintText('export const a: any = 1;\n', { filePath: `${root}packages/matcher/src/corpus/node/x.ts` });
    expect((result?.messages ?? []).some((m) => m.ruleId === '@typescript-eslint/no-explicit-any')).toBe(true);
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
    ["import { x } from '../decideHelpers.js';\nexport const a = x;\n", 'a name that starts like decide (not on the allowlist)'],
    ["import { x } from '../dismissMany.js';\nexport const a = x;\n", 'a module that is not on the allowlist'],
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

// The ban is an ALLOWLIST (review R1a I2): a name on a denylist is one more module a later change can forget, and the barrel (`index`) and the
// kit (`chatwarden`) re-export every writer. The AI folder may import its own files and these read-only modules of core/src, and nothing else.
const AI_ALLOWED = ['types', 'profile', 'ladder', 'rules', 'reporting', 'documents', 'crypto', 'log', 'events', 'audit'];

describe('the AI folder imports only an allowlist', () => {
  it('every module of core/src is refused from the AI folder except the allowlist: no sixth writer can slip in unnoticed', async () => {
    const names = readdirSync(`${root}packages/core/src`)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
    const allowed: string[] = [];
    for (const n of names) if ((await messages(imp(`../${n}.js`), 'packages/core/src/ai/x.ts')).length === 0) allowed.push(n);
    expect(allowed.sort()).toEqual([...AI_ALLOWED].sort());
  });

  it.each([
    ["import { applySanction } from '../index.js';\nexport const a = applySanction;\n", 'the barrel'],
    ["import { applySanction } from '../index';\nexport const a = applySanction;\n", 'the barrel without an extension'],
    ["import * as k from '../chatwarden.js';\nexport const a = k;\n", 'the kit as a namespace'],
    ["import type { Chatwarden } from '../chatwarden.js';\nexport type A = Chatwarden;\n", 'a type-only import of the kit'],
    ["import { x } from '../appeals.js';\nexport const a = x;\n", 'appeals'],
    ["import { x } from '../appealService.js';\nexport const a = x;\n", 'the appeals service'],
    ["import { x } from '../aiActor/service.js';\nexport const a = x;\n", 'the actor folder'],
    ["import { x } from '../../aiActor/service.js';\nexport const a = x;\n", 'the actor folder by a deeper path'],
    ["import { x } from './sub/deeper.js';\nexport const a = x;\n", 'a nested path under the AI folder'],
    ["import { x } from '@chatwarden/core';\nexport const a = x;\n", 'the package by name'],
    ["import { x } from 'some-package';\nexport const a = x;\n", 'a bare package'],
    ["export * from '../index.js';\n", 'a star re-export of the barrel'],
    ["export { applySanction } from '../index.js';\n", 'a named re-export of the barrel'],
    ["export const a = await import('../index.js');\n", 'a dynamic import of the barrel'],
    ["export const a = await import('../chatwarden.js');\n", 'a dynamic import of the kit'],
    ["export type A = import('../index.js').Chatwarden;\n", 'an import type of the barrel'],
    ["import x = require('../index.js');\nexport const a = x;\n", 'an import = require of the barrel'],
    ["export const a = require('../index.js');\n", 'a require call'],
    ["const p = '../index.js';\nexport const a = await import(p);\n", 'a computed dynamic import'],
    ["export const a = await import('../chat' + 'warden.js');\n", 'a concatenated dynamic import'],
  ])('refuses %s (%s)', async (code) => {
    for (const file of AI_SRC) expect((await messages(code, file)).length, file).toBeGreaterThan(0);
  });

  it.each(AI_ALLOWED)('allows %s, as a value and as a type, with or without the extension', async (m) => {
    expect(await messages(imp(`../${m}.js`), 'packages/core/src/ai/x.ts')).toEqual([]);
    expect(await messages(imp(`../${m}`), 'packages/core/src/ai/x.ts')).toEqual([]);
    expect(await messages(`import type { X } from '../${m}.js';\nexport type A = X;\n`, 'packages/core/src/ai/x.ts')).toEqual([]);
  });

  it('allows a sibling of the AI folder, with or without the extension', async () => {
    expect(await messages(imp('./worker.js'), 'packages/core/src/ai/x.ts')).toEqual([]);
    expect(await messages(imp('./worker'), 'packages/core/src/ai/x.ts')).toEqual([]);
    expect(await messages("export const a = await import('./lazy.js');\n", 'packages/core/src/ai/x.ts')).toEqual([]);
  });

  it('says why', async () => {
    expect((await messages(imp('../index.js'), 'packages/core/src/ai/x.ts')).join('\n')).toMatch(/AI never writes/);
  });

  it('the same imports are fine outside the AI folder (the actor, the kit and the barrel are core)', async () => {
    for (const file of ['packages/core/src/aiActor/x.ts', 'packages/core/src/chatwarden.ts', 'packages/core/src/x.ts', 'packages/core/test/ai/x.ts', 'packages/core/src/aiding/x.ts']) {
      expect(await messages(imp('../index.js'), file), file).toEqual([]);
      expect(await messages(imp('../chatwarden.js'), file), file).toEqual([]);
    }
  });
});

// The import ban alone does not stop `this.store.insertSanctionGroup(...)` on the Store type the AI module is handed. A second selector forbids
// member access to the store's writers from packages/core/src/ai (design 6.1): a static call, `this.store.x`, `store['x']`, an optional call,
// a destructuring and a method passed as a callback all name the writer, and each is caught.
const STORE_WRITERS = [
  'insertSanctionGroup',
  'revokeSanctionGroup',
  'closeReport',
  'insertDecision',
  'insertNotice',
  'withdrawNotice',
  'withdrawNoticeGroup',
  'insertStrike',
  'upsertMute',
  'deleteMute',
  'pruneMutes',
  'closeGap',
  'decideAppeal',
  'savePolicyLayer',
  'claimCase',
  'releaseClaim',
  'ackNotice',
  'insertAppeal',
  'closeAppealsForGroup',
  'closeOrphanAppeals',
  'insertReport',
  'addReportDetail',
  'purgeReports',
  'purgeSanctions',
  'purgeNotices',
  'purgeMutes',
  'purgeStrikes',
];

const SEAM_SRC = ['packages/core/src/ai/x.ts', 'packages/core/src/ai/sub/x.ts'];
const seamMessages = async (code: string, file: string): Promise<string[]> => (await messages(code, file)).filter((m) => /store's writers/.test(m));

describe.each(SEAM_SRC)('%s', (file) => {
  const shapes = (w: string): Array<[string, string]> => [
    [`export function f(store: { ${w}(x: unknown): void }): void {\n  store.${w}({});\n}\n`, 'a static call'],
    [`export class C {\n  store!: { ${w}(x: unknown): void };\n  run(): void {\n    this.store.${w}({});\n  }\n}\n`, 'this.store.x'],
    [`export function f(store: Record<string, (x: unknown) => void>): void {\n  store['${w}']({});\n}\n`, "store['x']"],
    [`export function f(store: Record<string, (x: unknown) => void>): void {\n  store[\`${w}\`]({});\n}\n`, 'store[`x`]'],
    [`export function f(store: { ${w}?(x: unknown): void }): void {\n  store.${w}?.({});\n}\n`, 'an optional call'],
    [`export function f(store: { ${w}(x: unknown): void }): void {\n  store?.${w}({});\n}\n`, 'an optional chain'],
    [`export function f(store: { ${w}(x: unknown): void }): void {\n  const { ${w} } = store;\n  ${w}({});\n}\n`, 'a destructuring'],
    [`export function f(store: { ${w}(x: unknown): void }): void {\n  const { ${w}: go } = store;\n  go({});\n}\n`, 'a renaming destructuring'],
    [`export function f(store: Record<string, (x: unknown) => void>): void {\n  const { '${w}': go } = store;\n  go({});\n}\n`, 'a string-key destructuring'],
    [`export function f(store: { ${w}(x: unknown): void }, xs: unknown[]): void {\n  xs.forEach(store.${w});\n}\n`, 'a callback'],
  ];

  it.each(STORE_WRITERS)('ESLint: ai/ cannot call %s (every shape of the access)', async (w) => {
    for (const [code, shape] of shapes(w)) expect((await seamMessages(code, file)).length, `${w}: ${shape}`).toBeGreaterThan(0);
  });

  it('ESLint: ai/ cannot call insertSanctionGroup, revokeSanctionGroup, closeReport, insertDecision, or the notice, strike and mute writers', async () => {
    for (const w of STORE_WRITERS) {
      for (const [code, shape] of shapes(w)) expect((await seamMessages(code, file)).length, `${w}: ${shape}`).toBeGreaterThan(0);
    }
  });

  // A writer reached without naming it (review R1a I2): a variable key on the store, Reflect, Object.* over the store, a spread of it.
  it.each([
    ['export function f(store: Record<string, (x: unknown) => void>, k: string): void {\n  store[k]({});\n}\n', 'store[k]'],
    ['export class C {\n  store!: Record<string, (x: unknown) => void>;\n  run(k: string): void {\n    this.store[k]({});\n  }\n}\n', 'this.store[k]'],
    ['export function f(store: Record<string, (x: unknown) => void>, k: string): void {\n  store?.[k]?.({});\n}\n', 'store?.[k]'],
    ['export function f(store: Record<string, (x: unknown) => void>, k: string): void {\n  store["insert" + k]({});\n}\n', 'store["insert" + k]'],
    ["export function f(store: object): unknown {\n  return Reflect.get(store, 'insertSanctionGroup');\n}\n", 'Reflect.get'],
    ['export function f(store: object, k: string): unknown {\n  return Reflect.apply(Reflect.get(store, k) as () => void, store, []);\n}\n', 'Reflect.apply'],
    ['export function f(store: object): unknown {\n  return Object.values(store);\n}\n', 'Object.values(store)'],
    ['export function f(store: object): unknown {\n  return Object.entries(store);\n}\n', 'Object.entries(store)'],
    ['export function f(store: object): unknown {\n  return Object.getOwnPropertyDescriptors(store);\n}\n', 'Object.getOwnPropertyDescriptors(store)'],
    ['export class C {\n  store!: object;\n  run(): unknown {\n    return Object.assign({}, this.store);\n  }\n}\n', 'Object.assign({}, this.store)'],
    ['export function f(store: object): unknown {\n  return { ...store };\n}\n', 'a spread of the store'],
    ['export class C {\n  store!: object;\n  run(): unknown {\n    return { ...this.store };\n  }\n}\n', 'a spread of this.store'],
  ])('ESLint: ai/ cannot reach a writer without naming it: %s (%s)', async (code, shape) => {
    expect((await seamMessages(code, file)).length, shape).toBeGreaterThan(0);
  });

  // Review R1 final I1: the bypasses the name-based selectors missed (a cast, an alias under another name, a concatenated key through an alias).
  const R = 'Record<string, (...a: unknown[]) => unknown>';
  it.each([
    [`export class C {
  store!: object;
  run(k: string): unknown {
    return (this.store as unknown as ${R})[k]?.();
  }
}
`, 'a cast of this.store with a variable key'],
    [`export class C {
  store!: object;
  run(): unknown {
    return (this.store as unknown as ${R}).insertDecision?.();
  }
}
`, 'a cast of this.store, then a named writer'],
    [`export function f(store: object): unknown {
  return (store as ${R})['insertDecision'];
}
`, 'a cast of store, a literal key'],
    [`export function f(store: object): unknown {
  return (<${R}>store).insertDecision;
}
`, 'an angle-bracket assertion'],
    [`export function f(store: object): unknown {
  return (store satisfies object) && 1;
}
`, 'satisfies on the store'],
    [`export function f(store?: ${R}): unknown {
  return store![\`x\`];
}
`, 'a non-null assertion on the store'],
    [`export class C {
  store!: object;
  run(k: string): unknown {
    const s = this.store as unknown as ${R};
    return s[k]?.();
  }
}
`, 'an alias made by a cast'],
    [`export class C {
  store!: ${R};
  run(k: string): unknown {
    const s = this.store;
    return s[k]?.();
  }
}
`, 'an alias under another name, a variable key'],
    [`export class C {
  store!: ${R};
  run(): unknown {
    const s = this.store;
    return s['insert' + 'Decision']?.();
  }
}
`, 'an alias, a concatenated key'],
    [`export function f(store: ${R}): unknown {
  const s = store;
  return s.insertSanctionGroup?.();
}
`, 'an alias, then a named writer'],
    [`export function f(store: ${R}): unknown {
  let s: ${R} | undefined;
  s = store;
  return s;
}
`, 'an alias by assignment'],
    [`export class C {
  store!: ${R};
  run(): unknown {
    const { store: s } = this;
    return s;
  }
}
`, 'an alias by destructuring a renamed store'],
    [`export function f(o: unknown, k: string): unknown {
  return (o as ${R})[k];
}
`, 'a variable key on any cast value'],
    [`export function f(o: unknown, k: string): unknown {
  return (o as ${R})['a' + k];
}
`, 'a concatenated key on any cast value'],
  ])('ESLint: ai/ cannot get past the store-named rules by a cast or an alias: %s (%s)', async (code, shape) => {
    expect((await seamMessages(code, file)).length, shape).toBeGreaterThan(0);
  });

  it('the new rules leave ordinary code alone: a store passed on, a same-name alias or destructuring, a literal key on a cast, a cast of something else', async () => {
    const ok = [
      "export class C {\n  store!: { loadReport(id: string): unknown };\n  run(): unknown {\n    const store = this.store;\n    return store.loadReport('r');\n  }\n}\n",
      "export class C {\n  store!: { loadReport(id: string): unknown };\n  run(): unknown {\n    const { store } = this;\n    return store.loadReport('r');\n  }\n}\n",
      "export function f(o: unknown): unknown {\n  return (o as { a: number })['a'];\n}\n",
      "export function f(o: unknown): number {\n  return (o as { a: number }).a;\n}\n",
      "export function g(store: object): void {\n  h(store);\n}\nfunction h(_s: object): void {}\n",
      "export function f(xs: Record<string, number>, k: string): number {\n  const rows = xs;\n  return rows[k] ?? 0;\n}\n",
    ];
    for (const code of ok) expect(await seamMessages(code, file), code).toEqual([]);
  });

  it('a variable key on something that is not the store is fine (a control: ordinary lookups stay)', async () => {
    const ok = [
      'export function f(rows: Record<string, number>, k: string): number {\n  return rows[k] ?? 0;\n}\n',
      'export function f(xs: number[], i: number): number {\n  return xs[i] ?? 0;\n}\n',
      'export function f(o: object): unknown {\n  return Object.entries(o);\n}\n',
      'export function f(a: object): unknown {\n  return { ...a };\n}\n',
      'export function f(store: { rows: Record<string, number> }, k: string): number {\n  return store.rows[k] ?? 0;\n}\n',
    ];
    for (const code of ok) expect(await seamMessages(code, file), code).toEqual([]);
  });

  it('says why, and names the seam', async () => {
    const [code] = shapes('insertSanctionGroup')[0] as [string, string];
    expect((await seamMessages(code, file)).join('\n')).toMatch(/store's writers.*aiActor/s);
  });

  it('allows the store reads the AI module uses, and a different name that merely starts like a writer', async () => {
    const reads = [
      'export function f(store: { loadReport(id: string): unknown }): unknown {\n  return store.loadReport("r1");\n}\n',
      'export function f(store: { loadAiRead(id: string): unknown }): unknown {\n  return store.loadAiRead("r1");\n}\n',
      'export function f(store: { closeReportLater(id: string): void }): void {\n  store.closeReportLater("r1");\n}\n',
      'export function f(store: { insertAiOutcome(r: unknown): void }): void {\n  store.insertAiOutcome({});\n}\n',
      'export function f(o: { closeReportCount: number }): number {\n  return o.closeReportCount;\n}\n',
    ];
    for (const code of reads) expect(await messages(code, file), code).toEqual([]);
  });

  it('a writer name used as an object key or a method definition is not a member access', async () => {
    const code = 'export const impl = { closeReport(): void {}, insertDecision: (): void => {} };\nexport class C {\n  insertNotice(): void {}\n}\n';
    expect(await seamMessages(code, file)).toEqual([]);
  });
});

describe('ESLint: the same call outside ai/ is allowed', () => {
  it('a variable key, Reflect and a spread of the store are fine outside ai/', async () => {
    const code = 'export function f(store: Record<string, (x: unknown) => void>, k: string): unknown {\n  store[k]({});\n  return [Reflect.get(store, k), Object.values(store), { ...store }];\n}\n';
    for (const file of ['packages/core/src/x.ts', 'packages/core/src/aiActor/x.ts', 'packages/http/src/x.ts']) expect(await messages(code, file), file).toEqual([]);
  });

  it.each(['packages/core/src/x.ts', 'packages/core/src/aiActor/x.ts', 'packages/core/src/decide.ts', 'packages/http/src/x.ts', 'packages/core/test/ai/x.ts', 'packages/core/src/aiding/x.ts'])(
    '%s may call every store writer',
    async (file) => {
      for (const w of STORE_WRITERS) {
        const code = `export function f(store: { ${w}(x: unknown): void }): void {\n  store.${w}({});\n  const { ${w}: go } = store;\n  go({});\n}\n`;
        expect(await messages(code, file), `${file} ${w}`).toEqual([]);
      }
    },
  );
});

describe('ESLint: the existing import ban still fires for type-only imports, re-exports and dynamic imports', () => {
  it.each([
    ["import type { X } from '../decide.js';\nexport type A = X;\n", 'a type-only import'],
    ["export { x } from '../sanctions.js';\n", 'a re-export'],
    ["export * from '../notices.js';\n", 'a star re-export'],
    ["export const a = await import('../strikes.js');\n", 'a dynamic import'],
    ["export const a = await import('../mutes.js');\n", 'a dynamic import of mutes'],
  ])('refuses %s (%s) in the ai folder, with the seam rule beside it', async (code) => {
    expect((await messages(code, 'packages/core/src/ai/x.ts')).join('\n')).toMatch(/AI never writes/);
  });
});
