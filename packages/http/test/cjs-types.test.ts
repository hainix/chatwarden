import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// A CommonJS app (`module: commonjs`, `moduleResolution: node`) does not read package.json `exports`, so a subpath such
// as `@chatwarden/http/express` finds its types only through `typesVersions`. These checks resolve the import exactly
// as `tsc` does, with the built `.d.ts` files stood in for by an overlay so they need no prior `tsc -b`.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const norm = (f: string): string => f.replaceAll('\\', '/');

interface Pkg {
  name: string;
  exports: Record<string, { types: string; default: string }>;
  typesVersions?: Record<string, Record<string, string[]>>;
}
const manifest = (dir: string): Pkg => JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as Pkg;

const OPTIONS: ts.CompilerOptions = { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, target: ts.ScriptTarget.ES2022 };

/** Resolve `specifier` from a file in the repo. `declared` are the `.d.ts` paths (relative to the repo) that count as built. */
function resolve(specifier: string, declared: string[], patch?: (packagePath: string, text: string) => string): string | undefined {
  const built = new Set(declared.map((p) => norm(join(root, p))));
  // The workspace link `node_modules/@chatwarden/<name>` is the package directory itself.
  const real = (f: string): string => norm(f).replace(/\/node_modules\/@chatwarden\/(\w+)\//, '/packages/$1/');
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => built.has(real(f)) || ts.sys.fileExists(f),
    readFile: (f) => {
      const text = ts.sys.readFile(f);
      return text !== undefined && patch !== undefined && /\/(packages|@chatwarden)\/http\/package\.json$/.test(norm(f)) ? patch(f, text) : text;
    },
    directoryExists: (d) => [...built].some((f) => f.startsWith(`${real(d)}/`)) || ts.sys.directoryExists(d),
    realpath: (p) => real(ts.sys.realpath?.(p) ?? p),
    getCurrentDirectory: () => root,
  };
  const found = ts.resolveModuleName(specifier, join(root, 'app.ts'), OPTIONS, host).resolvedModule;
  return found === undefined ? undefined : norm(found.resolvedFileName);
}

const BUILT = [
  'packages/http/dist/src/index.d.ts',
  'packages/http/dist/src/express.d.ts',
  'packages/http/dist/src/admin-entry.d.ts',
  'packages/http/dist/src/chat/index.d.ts',
];

describe('@chatwarden/http under module commonjs / moduleResolution node', () => {
  it('resolves the "./express" subpath types', () => {
    expect(resolve('@chatwarden/http/express', BUILT)).toMatch(/\/packages\/http\/dist\/src\/express\.d\.ts$/);
  });

  it('resolves the "./admin" subpath types', () => {
    expect(resolve('@chatwarden/http/admin', BUILT)).toMatch(/\/packages\/http\/dist\/src\/admin-entry\.d\.ts$/);
  });

  it('resolves the "./chat" subpath types', () => {
    expect(resolve('@chatwarden/http/chat', BUILT)).toMatch(/\/packages\/http\/dist\/src\/chat\/index\.d\.ts$/);
  });

  it('still resolves the package root types', () => {
    expect(resolve('@chatwarden/http', BUILT)).toMatch(/\/packages\/http\/dist\/src\/index\.d\.ts$/);
  });

  it('control: without typesVersions the subpath does not resolve (so the check above means something)', () => {
    const stripped = (_path: string, text: string): string => {
      const json = JSON.parse(text) as Record<string, unknown>;
      delete json.typesVersions;
      return JSON.stringify(json);
    };
    expect(resolve('@chatwarden/http/express', BUILT, stripped)).toBeUndefined();
    expect(resolve('@chatwarden/http/admin', BUILT, stripped)).toBeUndefined();
    expect(resolve('@chatwarden/http/chat', BUILT, stripped)).toBeUndefined();
    expect(resolve('@chatwarden/http', BUILT, stripped)).toMatch(/index\.d\.ts$/);
  });

  it('control: a subpath that does not exist stays unresolved', () => {
    expect(resolve('@chatwarden/http/nope', BUILT)).toBeUndefined();
  });
});

describe('typesVersions mirrors the exports map', () => {
  it.each([['http'], ['matcher']])('%s: every subpath in "exports" has a typesVersions entry with the same file', (dir) => {
    const pkg = manifest(dir);
    const subpaths = Object.entries(pkg.exports).filter(([key]) => key !== '.');
    expect(subpaths.length).toBeGreaterThan(0);
    const mapped = pkg.typesVersions?.['*'] ?? {};
    expect(Object.keys(mapped).sort()).toEqual(subpaths.map(([key]) => key.slice(2)).sort());
    for (const [key, entry] of subpaths) {
      expect(mapped[key.slice(2)], key).toEqual([entry.types.replace(/^\.\//, '')]);
    }
  });
});
