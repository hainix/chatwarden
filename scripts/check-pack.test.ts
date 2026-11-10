import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { BROWSER_SAFE, bareImports, checkFileList, checkManifest, exportTargets, nodeImports, undeclaredImports, nodeImportProblems } from './check-pack.mjs';

type Pkg = Record<string, unknown>;

const goodPkg = (): Pkg => ({
  name: '@chatwarden/demo',
  license: 'Apache-2.0',
  sideEffects: false,
  keywords: ['chatwarden', 'moderation', 'chat', 'demo'],
  homepage: 'https://github.com/hainix/chatwarden/tree/main/packages/demo#readme',
  bugs: { url: 'https://github.com/hainix/chatwarden/issues' },
  repository: { type: 'git', url: 'git+https://github.com/hainix/chatwarden.git', directory: 'packages/demo' },
  scripts: { prepack: 'tsc -b' },
  files: ['dist/src', 'src', 'README.md', 'LICENSE'],
  main: './dist/src/index.js',
  types: './dist/src/index.d.ts',
  exports: {
    '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
    './extra': { types: './dist/src/extra.d.ts', default: './dist/src/extra.js' },
  },
  typesVersions: { '*': { extra: ['dist/src/extra.d.ts'] } },
});

const goodFiles = (): string[] => [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/src/index.js',
  'dist/src/index.js.map',
  'dist/src/index.d.ts',
  'dist/src/index.d.ts.map',
  'dist/src/extra.js',
  'dist/src/extra.js.map',
  'dist/src/extra.d.ts',
  'dist/src/extra.d.ts.map',
  'src/index.ts',
  'src/extra.ts',
];

const check = (files: string[], pkg: Pkg = goodPkg()): string[] => checkFileList({ pkg, files });

describe('exportTargets', () => {
  it('collects main, types, nested exports and typesVersions targets without the leading ./', () => {
    expect(exportTargets(goodPkg()).sort()).toEqual(
      ['dist/src/extra.d.ts', 'dist/src/extra.js', 'dist/src/index.d.ts', 'dist/src/index.js'].sort(),
    );
  });
  it('handles string-valued exports and conditions nested more than one deep', () => {
    const t = exportTargets({ exports: { '.': { import: { types: './a.d.ts', default: './a.js' } }, './b': './b.js' } });
    expect(t.sort()).toEqual(['a.d.ts', 'a.js', 'b.js']);
  });
  it('ignores a package with no entry points', () => {
    expect(exportTargets({})).toEqual([]);
  });
});

describe('checkFileList', () => {
  it('accepts a good file list', () => {
    expect(check(goodFiles())).toEqual([]);
  });
  it('requires README.md in the tarball of every published package', () => {
    const files = goodFiles().filter((f) => f !== 'README.md');
    expect(check(files)).toContain('missing README.md');
  });
  it('accepts a file list that has README.md', () => {
    expect(checkFileList({ pkg: goodPkg(), files: goodFiles() })).toEqual([]);
  });
  it.each(['package.json', 'LICENSE'])('requires %s', (name) => {
    expect(check(goodFiles().filter((f) => f !== name)).join('\n')).toContain(name);
  });
  it.each([
    ['a test directory', 'test/matcher.test.ts'],
    ['a nested test directory', 'src/test/helper.ts'],
    ['a test file under dist/src', 'dist/src/matcher.test.js'],
    ['a test file under src', 'src/matcher.test.ts'],
    ['a spec file', 'src/matcher.spec.ts'],
    ['a tsbuildinfo', 'dist/tsconfig.tsbuildinfo'],
    ['a root tsbuildinfo', 'tsconfig.tsbuildinfo'],
    ['the compiled tests', 'dist/test/fixtures/index.js'],
  ])('rejects %s', (_label, path) => {
    const problems = check([...goodFiles(), path]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(path);
  });
  it('does not mistake a "test" substring in a name for a test directory', () => {
    const extra = ['src/latest.ts', 'dist/src/latest.js', 'dist/src/latest.js.map', 'dist/src/latest.d.ts', 'dist/src/latest.d.ts.map'];
    expect(check([...goodFiles(), ...extra])).toEqual([]);
  });
  it('accepts a .tsx source next to its compiled files (a React package)', () => {
    const extra = ['src/Hub.tsx', 'dist/src/Hub.js', 'dist/src/Hub.js.map', 'dist/src/Hub.d.ts', 'dist/src/Hub.d.ts.map'];
    expect(check([...goodFiles(), ...extra])).toEqual([]);
  });
  it('still reports a compiled file with no source at all', () => {
    const extra = ['dist/src/Hub.js', 'dist/src/Hub.js.map', 'dist/src/Hub.d.ts', 'dist/src/Hub.d.ts.map'];
    expect(check([...goodFiles(), ...extra]).join('\n')).toContain('src/Hub.ts');
  });
  it('requires a CSS export target to be in the tarball', () => {
    const pkg = goodPkg();
    (pkg.exports as Record<string, unknown>)['./styles.css'] = './src/styles.css';
    expect(check(goodFiles(), pkg).join('\n')).toContain('src/styles.css');
    expect(check([...goodFiles(), 'src/styles.css'], pkg)).toEqual([]);
  });
  it('allows src/fixtures (shipped synthetic fixtures)', () => {
    const files = [
      ...goodFiles(),
      'src/fixtures/index.ts',
      'dist/src/fixtures/index.js',
      'dist/src/fixtures/index.js.map',
      'dist/src/fixtures/index.d.ts',
      'dist/src/fixtures/index.d.ts.map',
    ];
    expect(check(files)).toEqual([]);
  });
  it.each(['dist/src/index.js', 'dist/src/index.d.ts'])('reports an export target missing from the list: %s', (target) => {
    const problems = check(goodFiles().filter((f) => f !== target));
    expect(problems.join('\n')).toContain(target);
  });
  it('reports a typesVersions target missing from the list', () => {
    const pkg = goodPkg();
    pkg.typesVersions = { '*': { extra: ['dist/src/nope.d.ts'] } };
    expect(check(goodFiles(), pkg).join('\n')).toContain('dist/src/nope.d.ts');
  });
  it('reports a missing declaration map or source map', () => {
    expect(check(goodFiles().filter((f) => f !== 'dist/src/index.js.map')).join('\n')).toContain('dist/src/index.js.map');
    expect(check(goodFiles().filter((f) => f !== 'dist/src/index.d.ts.map')).join('\n')).toContain('dist/src/index.d.ts.map');
  });
  it('reports a compiled file whose source is not shipped (source maps would not resolve)', () => {
    expect(check(goodFiles().filter((f) => f !== 'src/extra.ts')).join('\n')).toContain('src/extra.ts');
  });
  it('reports an empty dist (nothing was built)', () => {
    const problems = check(['package.json', 'README.md', 'LICENSE', 'src/index.ts']);
    expect(problems.join('\n')).toMatch(/dist\/src/);
  });
  it('reports every problem, not just the first', () => {
    const problems = check(['package.json', 'test/x.test.ts']);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('checkManifest', () => {
  const run = (pkg: Pkg, dir = 'demo'): string[] => checkManifest(pkg, dir);

  it('accepts a good manifest', () => {
    expect(run(goodPkg())).toEqual([]);
  });
  it('requires sideEffects false, or a list of stylesheets only (a package that ships a CSS file)', () => {
    const pkg = goodPkg();
    pkg.sideEffects = true;
    expect(run(pkg).join('\n')).toMatch(/sideEffects/);
    delete pkg.sideEffects;
    expect(run(pkg).join('\n')).toMatch(/sideEffects/);
    pkg.sideEffects = ['./src/styles.css'];
    expect(run(pkg)).toEqual([]);
    pkg.sideEffects = ['./src/styles.css', './src/other.css'];
    expect(run(pkg)).toEqual([]);
    pkg.sideEffects = ['./src/polyfill.js'];
    expect(run(pkg).join('\n')).toMatch(/sideEffects/);
    pkg.sideEffects = ['./src/styles.css', './dist/src/index.js'];
    expect(run(pkg).join('\n')).toMatch(/sideEffects/);
    pkg.sideEffects = [];
    expect(run(pkg).join('\n')).toMatch(/sideEffects/);
  });
  it('requires a prepack script that builds', () => {
    const pkg = goodPkg();
    pkg.scripts = {};
    expect(run(pkg).join('\n')).toMatch(/prepack/);
    pkg.scripts = { prepack: 'echo hi' };
    expect(run(pkg).join('\n')).toMatch(/prepack/);
  });
  it('requires the exact files list', () => {
    const pkg = goodPkg();
    pkg.files = ['dist/src'];
    expect(run(pkg).join('\n')).toMatch(/files/);
  });
  it('lets hub-react, and only hub-react, ship its font files after src', () => {
    const hub = goodPkg();
    hub.name = '@chatwarden/hub-react';
    hub.homepage = 'https://github.com/hainix/chatwarden/tree/main/packages/hub-react#readme';
    hub.repository = { type: 'git', url: 'git+https://github.com/hainix/chatwarden.git', directory: 'packages/hub-react' };
    hub.files = ['dist/src', 'src', 'font.css', 'fonts', 'README.md', 'LICENSE'];
    expect(run(hub, 'hub-react')).toEqual([]);
    hub.files = ['dist/src', 'src', 'README.md', 'LICENSE'];
    expect(run(hub, 'hub-react').join('\n')).toMatch(/files must be/);
    const other = goodPkg();
    other.files = ['dist/src', 'src', 'font.css', 'fonts', 'README.md', 'LICENSE'];
    expect(run(other).join('\n')).toMatch(/files must be/);
  });
  it('requires sideEffects: false', () => {
    const pkg = goodPkg();
    delete pkg.sideEffects;
    expect(run(pkg).join('\n')).toMatch(/sideEffects/);
  });
  it('requires the homepage, bugs and repository.directory for the directory', () => {
    const a = goodPkg();
    a.homepage = 'https://example.com';
    expect(run(a).join('\n')).toMatch(/homepage/);
    const b = goodPkg();
    delete b.bugs;
    expect(run(b).join('\n')).toMatch(/bugs/);
    const c = goodPkg();
    c.repository = { type: 'git', url: 'git+https://github.com/hainix/chatwarden.git' };
    expect(run(c).join('\n')).toMatch(/repository/);
  });
  it.each(['chatwarden', 'moderation', 'chat'])('requires the keyword %s', (kw) => {
    const pkg = goodPkg();
    pkg.keywords = (pkg.keywords as string[]).filter((k) => k !== kw);
    expect(run(pkg).join('\n')).toContain(kw);
  });
  it('requires a license of Apache-2.0', () => {
    const pkg = goodPkg();
    pkg.license = 'MIT';
    expect(run(pkg).join('\n')).toMatch(/license/);
  });
});

describe('bareImports', () => {
  it('finds static imports, re-exports, side-effect imports, dynamic imports and require calls', () => {
    const src = [
      "import { a } from 'alpha';",
      "import b from 'beta/sub/path.js';",
      "import * as c from '@scope/gamma';",
      "import '@scope/delta/side';",
      "export { e } from 'epsilon';",
      "export * from 'zeta';",
      "const f = await import('eta');",
      "const g = require('theta');",
      "import type { T } from 'iota';",
    ].join('\n');
    expect(bareImports(src).sort()).toEqual(['@scope/delta', '@scope/gamma', 'alpha', 'beta', 'epsilon', 'eta', 'iota', 'theta', 'zeta']);
  });
  it('reads multi-line import lists and double-quoted specifiers', () => {
    expect(bareImports('import {\n  a,\n  b,\n} from "multi";\n')).toEqual(['multi']);
  });
  it('ignores relative and absolute paths, node: builtins and bare builtins', () => {
    const src = "import a from './a.js';\nimport b from '../b.js';\nimport c from '/abs.js';\nimport d from 'node:sqlite';\nimport e from 'fs';\nimport f from 'node:fs/promises';\nimport g from 'crypto';\nimport h from 'fs/promises';\n";
    expect(bareImports(src)).toEqual([]);
  });
  it('ignores specifiers inside comments', () => {
    const src = "// import x from 'commented';\n/* import y from 'blocked'; */\n/**\n * import z from 'doc';\n */\nimport real from 'real';\n";
    expect(bareImports(src)).toEqual(['real']);
  });
  it('does not mistake a word that merely contains import for one', () => {
    expect(bareImports("const reimport = 'from x';\nconst important = require_not('y');\n")).toEqual([]);
  });
  it('lists a package once however often it is imported', () => {
    expect(bareImports("import a from 'dup';\nimport b from 'dup/sub';\n")).toEqual(['dup']);
  });
});

describe('undeclaredImports', () => {
  const pkg = {
    name: '@chatwarden/demo',
    dependencies: { dep: '^1.0.0' },
    peerDependencies: { '@chatwarden/core': '^0.1.0', peer: '^2.0.0' },
    devDependencies: { devonly: '^1.0.0', vitest: '^5.0.0' },
  };
  const file = (path: string, source: string): { path: string; source: string } => ({ path, source });

  it('is empty when every bare import is a builtin, a self-reference, a dependency or a peer', () => {
    const files = [
      file('dist/src/index.js', "import { x } from 'dep';\nimport { y } from '@chatwarden/core';\nimport z from 'peer/sub';\nimport db from 'node:sqlite';\nimport { w } from '@chatwarden/demo/extra';\nimport q from './q.js';\n"),
    ];
    expect(undeclaredImports({ pkg, files })).toEqual([]);
  });
  it('flags an import that is only a devDependency (it is not installed for consumers)', () => {
    const out: string[] = undeclaredImports({ pkg, files: [file('dist/src/a.js', "import { t } from 'devonly';\n")] });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('devonly');
    expect(out[0]).toContain('dist/src/a.js');
  });
  it('flags a phantom import that is declared nowhere', () => {
    const out: string[] = undeclaredImports({ pkg, files: [file('dist/src/a.js', "import ws from 'ws';\nimport { m } from '@chatwarden/matcher';\n")] });
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toContain('ws');
    expect(out.join('\n')).toContain('@chatwarden/matcher');
  });
  it('flags a dynamic import and a require too', () => {
    const out: string[] = undeclaredImports({ pkg, files: [file('dist/src/a.js', "const a = await import('lazy');\nconst b = require('cjsdep');\n")] });
    expect(out.join('\n')).toContain('lazy');
    expect(out.join('\n')).toContain('cjsdep');
  });
  it('reports a package once per file, and each file separately', () => {
    const out: string[] = undeclaredImports({
      pkg,
      files: [file('dist/src/a.js', "import 'ws';\nimport 'ws/lib';\n"), file('dist/src/b.js', "import 'ws';\n")],
    });
    expect(out).toHaveLength(2);
  });
  it('only looks at dist/src/**/*.js, not declarations, maps or other folders', () => {
    const files = [
      file('dist/src/a.d.ts', "import ws from 'ws';\n"),
      file('dist/src/a.js.map', '{"sources":["import x from \'ws\'"]}'),
      file('src/a.ts', "import ws from 'ws';\n"),
      file('README.md', "import ws from 'ws'"),
    ];
    expect(undeclaredImports({ pkg, files })).toEqual([]);
  });
  it('treats a package with no dependency fields at all as declaring nothing', () => {
    const out: string[] = undeclaredImports({ pkg: { name: '@chatwarden/bare' }, files: [file('dist/src/a.js', "import x from 'x';\nimport fs from 'node:fs';\n")] });
    expect(out).toHaveLength(1);
  });
});

describe('nodeImports', () => {
  it('finds node: specifiers and bare builtins in every import form', () => {
    const src = [
      "import fs from 'node:fs';",
      "import { createHash } from 'crypto';",
      "export * from 'node:path';",
      "import 'node:os';",
      "const m = await import('node:sqlite');",
      "const c = require('buffer');",
      "import { x } from 'node:fs/promises';",
    ].join('\n');
    expect(nodeImports(src).sort()).toEqual(['buffer', 'crypto', 'fs', 'fs', 'os', 'path', 'sqlite'].sort());
  });
  it('ignores packages, relative paths and comments', () => {
    const src = "// import fs from 'node:fs'\n/* import 'node:os' */\nimport a from './a.js';\nimport b from '@chatwarden/core';\nimport c from 'ws';\n";
    expect(nodeImports(src)).toEqual([]);
  });
  it('does not take process.getBuiltinModule("node:crypto") for an import (it is a guarded runtime lookup)', () => {
    expect(nodeImports("const c = process.getBuiltinModule('node:crypto');")).toEqual([]);
  });
});

describe('nodeImportProblems (browser-safe packages)', () => {
  const file = (path: string, source: string) => ({ path, source });
  it('names core, hub-react, player-react and store-memory as the browser-safe packages', () => {
    expect([...BROWSER_SAFE].sort()).toEqual(['@chatwarden/core', '@chatwarden/hub-react', '@chatwarden/player-react', '@chatwarden/store-memory']);
  });
  it('flags a node import in a browser-safe package, per file and module', () => {
    const out: string[] = nodeImportProblems({
      pkg: { name: '@chatwarden/store-memory' },
      files: [file('dist/src/a.js', "import { randomBytes } from 'node:crypto';\n"), file('dist/src/b.js', "import 'node:fs';\n")],
    });
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toContain('node:crypto');
    expect(out.join('\n')).toContain('dist/src/b.js');
  });
  it('lets a browser-safe package with no node import pass', () => {
    expect(nodeImportProblems({ pkg: { name: '@chatwarden/core' }, files: [file('dist/src/a.js', "import { x } from './x.js';\n")] })).toEqual([]);
  });
  it('does not apply to other packages (store-sqlite is Node by design)', () => {
    expect(nodeImportProblems({ pkg: { name: '@chatwarden/store-sqlite' }, files: [file('dist/src/a.js', "import { DatabaseSync } from 'node:sqlite';\n")] })).toEqual([]);
  });
  it('only looks at dist/src/**/*.js', () => {
    expect(
      nodeImportProblems({
        pkg: { name: '@chatwarden/core' },
        files: [file('dist/src/a.d.ts', "import fs from 'node:fs';\n"), file('src/a.ts', "import fs from 'node:fs';\n")],
      }),
    ).toEqual([]);
  });
});
