// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

// `@chatwarden/hub-react/headless` promises no React. Its type declarations must not need the DOM either: a Node-only or worker project
// (lib ES2023, no @types/node, skipLibCheck off) has to compile an import of the controller with zero errors. This reads the BUILT
// declarations (dist/src), so it needs `tsc -b` first (CI builds before it tests); without a build it is skipped by name.

const root = process.cwd();
const built = join(root, 'packages', 'hub-react', 'dist', 'src', 'headless', 'index.d.ts');
const cache = join(root, 'node_modules', '.cache');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Compile `source` as a consumer would, with no ambient lib beyond ES2023, no @types, and library files checked. */
function compile(source: string): string[] {
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'cw-headless-types-'));
  dirs.push(dir);
  const file = join(dir, 'consumer.ts');
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts'],
    types: [],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file === undefined ? '' : d.file.fileName.replaceAll('\\', '/').replace(/^.*\/(packages|node_modules)\//, '$1/')}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('the headless entry type-checks without the DOM lib', () => {
  it.skipIf(!existsSync(built))('importing createHubController compiles with lib ES2023, types [] and skipLibCheck false: zero errors', () => {
    const errors = compile(
      [
        `import { createHubController, fetchTransport, createHubClient } from ${JSON.stringify(built.replace(/\.d\.ts$/, '.js'))};`,
        'export const c = createHubController;',
        'export const t = fetchTransport({ baseUrl: "/admin", credentials: "include" });',
        'export const k = createHubClient(t);',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });

  it.skipIf(!existsSync(built))('the options accept a plain fetch-shaped function and a credentials literal, no DOM types needed', () => {
    const errors = compile(
      [
        `import { fetchTransport } from ${JSON.stringify(built.replace(/\.d\.ts$/, '.js'))};`,
        'const fetchLike = async (_url: string, _init: { method?: string; headers?: Record<string, string>; body?: string; signal?: { aborted: boolean }; credentials?: "omit" | "same-origin" | "include"; keepalive?: boolean }) => ({',
        '  status: 200,',
        '  headers: { forEach: (_cb: (value: string, key: string) => void): void => undefined },',
        '  text: async () => "",',
        '});',
        'export const t = fetchTransport({ baseUrl: "/admin", credentials: "same-origin", fetch: fetchLike });',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });

  it('control: the same compile settings do report a missing DOM type (so zero errors above means something)', () => {
    const errors = compile('export declare const s: AbortSignal;\nexport declare const c: RequestCredentials;\n');
    expect(errors.join('\n')).toMatch(/Cannot find name 'AbortSignal'/);
    expect(errors.join('\n')).toMatch(/Cannot find name 'RequestCredentials'/);
  });
});
