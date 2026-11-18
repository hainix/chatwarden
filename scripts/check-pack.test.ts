import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { BROWSER_SAFE, BUNDLED, bareImports, binProblems, checkFileList, checkManifest, corpusDataProblems, exportTargets, nodeImports, undeclaredImports, nodeImportProblems } from './check-pack.mjs';

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
  describe('stale build output (a dist file whose source was removed)', () => {
    // tsc -b never deletes what an earlier build wrote: a component removed from src/ leaves its compiled files in the git-ignored
    // dist/, and npm pack would ship them. hub-react nearly shipped dist/src/DecisionPanel.js this way.
    const stale = (stem: string): string[] => [`dist/src/${stem}.js`, `dist/src/${stem}.js.map`, `dist/src/${stem}.d.ts`, `dist/src/${stem}.d.ts.map`];
    it('names the stale DecisionPanel build of a React package, once, with the file it found', () => {
      const problems = check([...goodFiles(), 'src/Hub.tsx', ...stale('Hub'), ...stale('DecisionPanel')]);
      expect(problems).toEqual(['missing src/DecisionPanel.ts (next to dist/src/DecisionPanel.js): stale build output? Delete dist and rebuild']);
    });
    it.each(['.js', '.js.map', '.d.ts', '.d.ts.map'])('catches a lone %s with no source and no sibling', (ext) => {
      const problems = check([...goodFiles(), `dist/src/Old${ext}`]);
      expect(problems.join('\n')).toContain('missing src/Old.ts (next to dist/src/Old');
    });
    it('catches a stale file in a subfolder', () => {
      const problems = check([...goodFiles(), 'src/pieces/Live.tsx', ...stale('pieces/Live'), ...stale('pieces/Gone')]);
      expect(problems.filter((p) => p.includes('missing src/pieces/Gone.ts'))).toHaveLength(1);
      expect(problems.join('\n')).not.toContain('Live');
    });
    it('is satisfied by a .ts or a .tsx source, and by nothing else', () => {
      expect(check([...goodFiles(), 'src/A.ts', ...stale('A'), 'src/B.tsx', ...stale('B')])).toEqual([]);
      expect(check([...goodFiles(), 'src/C.js', ...stale('C')]).join('\n')).toContain('missing src/C.ts');
    });
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
  it('skips the init CLI templates: they hold the text of the files init writes, whose import lines are not imports of this package', () => {
    const text = ["export const x = `import { a } from '@chatwarden/player-react';", "import b from '${spec(ctx, from)}';`;"].join(String.fromCharCode(10));
    const http = { name: '@chatwarden/http', peerDependencies: { '@chatwarden/core': '^0.1.0' } };
    expect(undeclaredImports({ pkg: http, files: [file('dist/src/cli/templates/chat.js', text), file('dist/src/cli/templates/sub/x.js', text)] })).toEqual([]);
  });
  it('but looks at every other file of the CLI, and at a folder that only starts like the templates folder', () => {
    const http = { name: '@chatwarden/http', peerDependencies: { '@chatwarden/core': '^0.1.0' } };
    const out: string[] = undeclaredImports({
      pkg: http,
      files: ['dist/src/cli/index.js', 'dist/src/cli/templates-extra/x.js', 'dist/src/templates/x.js'].map((path) => file(path, "import ws from 'ws';")),
    });
    expect(out).toHaveLength(3);
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
  it('names core, hub-element, hub-react, player-react and store-memory as the browser-safe packages', () => {
    expect([...BROWSER_SAFE].sort()).toEqual(['@chatwarden/core', '@chatwarden/hub-element', '@chatwarden/hub-react', '@chatwarden/player-react', '@chatwarden/store-memory']);
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

describe('the hub-react manifest in the repo', () => {
  const hub = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/hub-react/package.json', import.meta.url)), 'utf8')) as Pkg;
  it('lists the headless entry among the files a tarball must hold (types and ESM, from dist)', () => {
    const targets = exportTargets(hub) as string[];
    expect(targets).toContain('dist/src/headless/index.js');
    expect(targets).toContain('dist/src/headless/index.d.ts');
  });
  it('is browser-safe, which covers the headless entry too: no Node builtin in dist', () => {
    expect([...BROWSER_SAFE]).toContain('@chatwarden/hub-react');
  });
});

describe('a bundled package (hub-element ships dist/*.js, built by esbuild, and only types under dist/src)', () => {
  const elementPkg = (): Pkg => ({
    name: '@chatwarden/hub-element',
    license: 'Apache-2.0',
    sideEffects: ['./dist/hub-element.js'],
    keywords: ['chatwarden', 'moderation', 'chat'],
    homepage: 'https://github.com/hainix/chatwarden/tree/main/packages/hub-element#readme',
    bugs: { url: 'https://github.com/hainix/chatwarden/issues' },
    repository: { type: 'git', url: 'git+https://github.com/hainix/chatwarden.git', directory: 'packages/hub-element' },
    scripts: { prepack: 'tsc -b && node build/build.mjs' },
    files: ['dist/src', 'src', 'dist/hub-element.js', 'dist/index.js', 'dist/THIRD_PARTY_NOTICES.txt', 'README.md', 'LICENSE'],
    main: './dist/index.js',
    types: './dist/src/index.d.ts',
    exports: {
      '.': { types: './dist/src/index.d.ts', default: './dist/index.js' },
      './standalone': { types: './dist/src/standalone.d.ts', default: './dist/hub-element.js' },
    },
  });
  const elementFiles = (): string[] => [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/hub-element.js',
    'dist/index.js',
    'dist/THIRD_PARTY_NOTICES.txt',
    'dist/src/index.d.ts',
    'dist/src/index.d.ts.map',
    'dist/src/standalone.d.ts',
    'dist/src/standalone.d.ts.map',
    'src/index.ts',
    'src/standalone.ts',
  ];

  it('a stale declaration file in dist/src (its source removed) fails too: dist/src is only declarations here', () => {
    const files = [...elementFiles(), 'dist/src/gone.d.ts', 'dist/src/gone.d.ts.map'];
    expect(checkFileList({ pkg: elementPkg(), files }).join('\n')).toContain('missing src/gone.ts (next to dist/src/gone.d.ts)');
  });
  it('is named as bundled, with its two scripts', () => {
    expect(BUNDLED['hub-element'].scripts).toEqual(['dist/hub-element.js', 'dist/index.js']);
  });
  it('a good tarball passes, with no dist/src/**/*.js and no .js.map', () => {
    expect(checkFileList({ pkg: elementPkg(), files: elementFiles() })).toEqual([]);
    expect(checkManifest(elementPkg(), 'hub-element')).toEqual([]);
  });
  it('requires both scripts to be there', () => {
    const files = elementFiles().filter((f) => f !== 'dist/hub-element.js');
    expect(checkFileList({ pkg: elementPkg(), files }).join('\n')).toMatch(/missing dist\/hub-element\.js/);
    const files2 = elementFiles().filter((f) => f !== 'dist/index.js');
    expect(checkFileList({ pkg: elementPkg(), files: files2 }).join('\n')).toMatch(/missing dist\/index\.js/);
  });
  it('is named as bundled with a third-party notices file', () => {
    expect(BUNDLED['hub-element'].notices).toBe('dist/THIRD_PARTY_NOTICES.txt');
  });
  it('requires the third-party notices file (it carries the licences of the code inside the bundles)', () => {
    const files = elementFiles().filter((f) => f !== 'dist/THIRD_PARTY_NOTICES.txt');
    expect(checkFileList({ pkg: elementPkg(), files }).join('\n')).toMatch(/missing dist\/THIRD_PARTY_NOTICES\.txt/);
  });
  it('requires files to list the notices file', () => {
    const pkg = elementPkg();
    pkg.files = ['dist/src', 'src', 'dist/hub-element.js', 'dist/index.js', 'README.md', 'LICENSE'];
    expect(checkManifest(pkg, 'hub-element').join('\n')).toMatch(/files must be/);
  });
  it('refuses compiled JavaScript under dist/src (a second, unbundled copy that imports React)', () => {
    const files = [...elementFiles(), 'dist/src/element.js'];
    expect(checkFileList({ pkg: elementPkg(), files }).join('\n')).toMatch(/dist\/src\/element\.js would ship/);
  });
  it('still wants the declarations, their maps and the sources', () => {
    expect(checkFileList({ pkg: elementPkg(), files: elementFiles().filter((f) => f !== 'dist/src/index.d.ts.map') }).join('\n')).toMatch(/missing dist\/src\/index\.d\.ts\.map/);
    expect(checkFileList({ pkg: elementPkg(), files: elementFiles().filter((f) => f !== 'src/standalone.ts') }).join('\n')).toMatch(/missing src\/standalone\.ts/);
    expect(checkFileList({ pkg: elementPkg(), files: elementFiles().filter((f) => !f.endsWith('.d.ts')) }).join('\n')).toMatch(/no dist\/src\/\*\*\/\*\.d\.ts/);
  });
  it('every export target must be in the tarball', () => {
    expect(checkFileList({ pkg: elementPkg(), files: elementFiles().filter((f) => f !== 'dist/src/standalone.d.ts') }).join('\n')).toMatch(/export target is not in the tarball: dist\/src\/standalone\.d\.ts/);
  });
  it('sideEffects must list the registering script exactly (false would let a bundler drop the bare import)', () => {
    const pkg = elementPkg();
    pkg.sideEffects = false;
    expect(checkManifest(pkg, 'hub-element').join(' ')).toMatch(/sideEffects/);
    pkg.sideEffects = ['./dist/index.js'];
    expect(checkManifest(pkg, 'hub-element').join('\n')).toMatch(/sideEffects/);
    pkg.sideEffects = ['./dist/hub-element.js', './dist/index.js'];
    expect(checkManifest(pkg, 'hub-element').join('\n')).toMatch(/sideEffects/);
  });
  it('the exception is for hub-element only: any other package still needs false or CSS', () => {
    const other = goodPkg();
    other.sideEffects = ['./dist/hub-element.js'];
    expect(checkManifest(other).join('\n')).toMatch(/sideEffects/);
  });
  it('the files list is exact: the scripts come after src', () => {
    const pkg = elementPkg();
    pkg.files = ['dist/src', 'src', 'README.md', 'LICENSE'];
    expect(checkManifest(pkg, 'hub-element').join('\n')).toMatch(/files must be/);
  });
  it('a bundle that imports something is flagged: it must be self-contained', () => {
    const pkg = { ...elementPkg(), dependencies: {}, peerDependencies: { '@chatwarden/hub-react': '^0.1.1' } };
    const ok = undeclaredImports({ pkg, files: [{ path: 'dist/hub-element.js', source: "const a = 1;\nexport { a };\n" }] });
    expect(ok).toEqual([]);
    const out: string[] = undeclaredImports({ pkg, files: [{ path: 'dist/hub-element.js', source: 'import { useState } from "react";\n' }] });
    expect(out.join('\n')).toMatch(/dist\/hub-element\.js imports "react"/);
  });
  it('a bundle that imports a Node builtin is flagged (it is browser-safe)', () => {
    const out: string[] = nodeImportProblems({ pkg: { name: '@chatwarden/hub-element' }, files: [{ path: 'dist/index.js', source: 'import fs from "node:fs";\n' }] });
    expect(out.join('\n')).toMatch(/dist\/index\.js imports the Node builtin "node:fs"/);
  });
});

describe('exportTargets and the bin', () => {
  it('exportTargets includes bin (an object, or a string)', () => {
    expect((exportTargets({ bin: { chatwarden: './dist/src/cli/bin.js' } }) as string[]).sort()).toEqual(['dist/src/cli/bin.js']);
    expect(exportTargets({ bin: './dist/src/cli/bin.js' })).toEqual(['dist/src/cli/bin.js']);
    expect((exportTargets({ main: './a.js', bin: { x: './b.js', y: './c.js' } }) as string[]).sort()).toEqual(['a.js', 'b.js', 'c.js']);
  });
  it('a bin target that is not in the tarball is an export-target problem too', () => {
    const pkg = { ...goodPkg(), bin: { demo: './dist/src/cli.js' } };
    expect(check(goodFiles(), pkg).join('\n')).toContain('export target is not in the tarball: dist/src/cli.js');
  });
  it('the real http manifest names its bin target and ./cli among the files a tarball must hold', () => {
    const http = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/http/package.json', import.meta.url)), 'utf8')) as Pkg;
    const targets = exportTargets(http) as string[];
    expect(targets).toEqual(expect.arrayContaining(['dist/src/cli/bin.js', 'dist/src/cli/index.js', 'dist/src/cli/index.d.ts', 'dist/src/fetch.js']));
  });
});

describe('binProblems', () => {
  const pkg = (bin: unknown = { demo: './dist/src/cli/bin.js' }): Pkg => ({ ...goodPkg(), bin });
  const SHEBANG = '#!/usr/bin/env node\nimport "./index.js";\n';
  const input = (over: { bin?: unknown; files?: string[]; sources?: Record<string, string> } = {}) => ({
    pkg: pkg(over.bin),
    files: over.files ?? [...goodFiles(), 'dist/src/cli/bin.js'],
    sources: over.sources ?? { 'dist/src/cli/bin.js': SHEBANG },
  });
  it('a bin target that is in the tarball and starts with the shebang passes', () => {
    expect(binProblems(input())).toEqual([]);
  });
  it('a package with no bin has nothing to check', () => {
    expect(binProblems({ pkg: goodPkg(), files: goodFiles(), sources: {} })).toEqual([]);
  });
  it('a string bin is checked too', () => {
    expect(binProblems(input({ bin: './dist/src/cli/bin.js' }))).toEqual([]);
    expect(binProblems(input({ bin: './dist/src/cli/bin.js', sources: { 'dist/src/cli/bin.js': 'console.log(1)\n' } })).join('\n')).toContain('#!/usr/bin/env node');
  });
  it('a missing bin target fails and names it', () => {
    const problems = binProblems(input({ files: goodFiles(), sources: {} }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"demo"');
    expect(problems[0]).toContain('dist/src/cli/bin.js');
    expect(problems[0]).toMatch(/not in the tarball/);
  });
  it.each([
    ['no shebang', 'import "./index.js";\n'],
    ['a different interpreter', '#!/usr/bin/env bash\necho 1\n'],
    ['a shebang on the second line', '\n#!/usr/bin/env node\n'],
    ['an empty file', ''],
    ['a byte order mark before the shebang', '\uFEFF#!/usr/bin/env node\n'],
  ])('fails when the file has %s, and names the bin and the expected line', (_label, text) => {
    const problems = binProblems(input({ sources: { 'dist/src/cli/bin.js': text } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"demo"');
    expect(problems[0]).toContain('#!/usr/bin/env node');
  });
  it('accepts a CRLF after the shebang (the line itself is what counts)', () => {
    expect(binProblems(input({ sources: { 'dist/src/cli/bin.js': '#!/usr/bin/env node\r\nx\n' } }))).toEqual([]);
  });
  it.each(['test/bin.js', 'dist/test/bin.js', 'src/test/cli.js', 'dist/src/cli/foo.test.js'])('a bin under a test path (%s) fails with a named problem', (path) => {
    const problems = binProblems({ pkg: pkg({ demo: `./${path}` }), files: [...goodFiles(), path], sources: { [path]: SHEBANG } });
    expect(problems.join('\n')).toMatch(/test/);
    expect(problems.join('\n')).toContain(path);
  });
  it('does not mistake a "test" substring for a test directory', () => {
    const path = 'dist/src/cli/latest.js';
    expect(binProblems({ pkg: pkg({ demo: `./${path}` }), files: [...goodFiles(), path], sources: { [path]: SHEBANG } })).toEqual([]);
  });
  it('reports every bin, each with its own name', () => {
    const problems = binProblems({
      pkg: pkg({ one: './dist/src/a.js', two: './dist/src/b.js' }),
      files: [...goodFiles(), 'dist/src/a.js', 'dist/src/b.js'],
      sources: { 'dist/src/a.js': SHEBANG, 'dist/src/b.js': 'x\n' },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"two"');
  });
});

describe('corpusDataProblems: no packed tarball holds a zip, a sig, a key or corpus JSON (design 16)', () => {
  const clean = (): string[] => goodFiles();
  const PRIVATE_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

  it('a normal package has none', () => {
    expect(corpusDataProblems({ files: clean(), sources: {} })).toEqual([]);
    expect(corpusDataProblems({ files: [...clean(), 'dist/src/corpus/index.js', 'src/corpus/index.ts', 'dist/src/corpus/index.d.ts'], sources: {} })).toEqual([]);
  });

  it.each([
    'releases/terms-2026.12.0.zip',
    'dist/data/terms.zip',
    'terms.ZIP',
    'index.json.sig',
    'releases/terms-2026.12.0.zip.sig',
    'a.7z',
    'a.tar',
    'a.tar.gz',
    'a.tgz',
    'keys/installation.pem',
    'keys/signing.key',
    '.dev.vars',
    'deploy/.dev.vars',
  ])('a file named %s fails and is named', (path) => {
    const problems = corpusDataProblems({ files: [...clean(), path], sources: {} });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(path);
  });

  it('a JSON file whose schema starts chatwarden-corpus- fails, wherever it sits, and a JSON file that is not corpus data passes', () => {
    for (const schema of ['chatwarden-corpus-manifest/1', 'chatwarden-corpus-terms/1', 'chatwarden-corpus-index/1', 'chatwarden-corpus-submission/1']) {
      const problems = corpusDataProblems({ files: [...clean(), 'dist/data/x.json'], sources: { 'dist/data/x.json': JSON.stringify({ schema, rows: [] }) } });
      expect(problems, schema).toHaveLength(1);
      expect(problems[0]).toContain('dist/data/x.json');
    }
    const fine = { 'dist/data/a.json': '{"schema":"something-else/1"}', 'dist/data/b.json': '[1,2]', 'dist/data/c.json': 'not json', 'dist/data/d.json': '{"name":"x"}' };
    expect(corpusDataProblems({ files: [...clean(), ...Object.keys(fine)], sources: fine })).toEqual([]);
  });

  it('a private key header in any shipped JSON fails (a key pasted into a data file)', () => {
    const problems = corpusDataProblems({ files: [...clean(), 'dist/x.json'], sources: { 'dist/x.json': JSON.stringify({ key: `${PRIVATE_HEADER}\nAAAA` }) } });
    expect(problems.join('\n')).toContain('dist/x.json');
  });

  it('every kind of PEM private key header fails in a shipped JSON (the same pattern as the repo guard)', () => {
    for (const kind of ['', 'ENCRYPTED ', 'RSA ', 'EC ', 'OPENSSH ']) {
      const header = ['-----BEGIN', `${kind}PRIVATE KEY-----`].join(' ');
      const problems = corpusDataProblems({ files: [...clean(), 'dist/y.json'], sources: { 'dist/y.json': JSON.stringify({ key: header }) } });
      expect(problems.join(', '), kind).toContain('dist/y.json');
    }
  });

  it('every problem is reported, one for each file', () => {
    const problems = corpusDataProblems({ files: [...clean(), 'a.zip', 'b.sig', 'c.pem'], sources: {} });
    expect(problems).toHaveLength(3);
  });

  it('names the file and the kind, never the content', () => {
    const problems = corpusDataProblems({ files: [...clean(), 'x.json'], sources: { 'x.json': JSON.stringify({ schema: 'chatwarden-corpus-terms/1', terms: [{ term: 'zorbak' }] }) } });
    expect(problems.join('\n')).not.toContain('zorbak');
  });
});

describe('the matcher tarball and the corpus subpaths (0.1.11)', () => {
  const matcher = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/matcher/package.json', import.meta.url)), 'utf8')) as Pkg;
  const shipped = (): string[] => [
    ...goodFiles().filter((f) => !f.startsWith('dist/src/extra') && f !== 'package.json'),
    'package.json',
    ...exportTargets(matcher),
    'src/corpus/index.ts',
    'src/corpus/node/index.ts',
    'dist/src/corpus/index.js',
    'dist/src/corpus/index.js.map',
    'dist/src/corpus/index.d.ts',
    'dist/src/corpus/index.d.ts.map',
    'dist/src/corpus/node/index.js',
    'dist/src/corpus/node/index.js.map',
    'dist/src/corpus/node/index.d.ts',
    'dist/src/corpus/node/index.d.ts.map',
  ];

  it('check-pack: @chatwarden/matcher/corpus and /corpus/node resolve from the packed tarball under ESM and under CommonJS with moduleResolution node, and the root entry does not load them', () => {
    const targets = exportTargets(matcher);
    // ESM and CommonJS (require of an ES module on Node 22.13): the export map names the code and the types of both subpaths.
    const exportsMap = matcher.exports as Record<string, Record<string, string>>;
    expect(exportsMap['./corpus']).toEqual({ types: './dist/src/corpus/index.d.ts', default: './dist/src/corpus/index.js' });
    expect(exportsMap['./corpus/node']).toEqual({ types: './dist/src/corpus/node/index.d.ts', default: './dist/src/corpus/node/index.js' });
    // moduleResolution node reads typesVersions, not exports.
    const tv = (matcher.typesVersions as Record<string, Record<string, string[]>>)['*'] as Record<string, string[]>;
    expect(tv.corpus).toEqual(['dist/src/corpus/index.d.ts']);
    expect(tv['corpus/node']).toEqual(['dist/src/corpus/node/index.d.ts']);
    for (const t of ['dist/src/corpus/index.js', 'dist/src/corpus/index.d.ts', 'dist/src/corpus/node/index.js', 'dist/src/corpus/node/index.d.ts']) expect(targets).toContain(t);
    // Every one of those files is in the list a good tarball has, so the check passes; take one away and it names it.
    expect(checkFileList({ pkg: matcher, files: shipped() }).filter((p: string) => /export target/.test(p))).toEqual([]);
    const without = shipped().filter((f) => f !== 'dist/src/corpus/node/index.js');
    expect(checkFileList({ pkg: matcher, files: without }).join('\n')).toContain('export target is not in the tarball: dist/src/corpus/node/index.js');
    // The root entry is its own file and names neither subpath: nothing a root import loads reaches the corpus folder.
    const root = readFileSync(fileURLToPath(new URL('../packages/matcher/src/index.ts', import.meta.url)), 'utf8');
    expect(root).not.toMatch(/corpus/);
    expect(exportsMap['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/src/index.js' });
  });

  it('a tarball with a release zip, a signature or a key in it is refused by corpusDataProblems even when the matcher files are fine', () => {
    expect(corpusDataProblems({ files: shipped(), sources: {} })).toEqual([]);
    expect(corpusDataProblems({ files: [...shipped(), 'dist/src/corpus/seed.zip'], sources: {} })).toHaveLength(1);
    expect(corpusDataProblems({ files: [...shipped(), 'dist/src/corpus/seed.zip.sig'], sources: {} }).length).toBeGreaterThan(0);
  });
});

describe('the http manifest in the repo and the K5 subpaths', () => {
  const http = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/http/package.json', import.meta.url)), 'utf8')) as Pkg;
  const SUBPATHS = ['discord', 'coop', 'eos'] as const;
  it('lists the Discord, Coop and EOS entries among the files a tarball must hold, and the root still does not name them', () => {
    const targets = exportTargets(http) as string[];
    for (const name of SUBPATHS) {
      expect(targets, name).toContain(`dist/src/${name}/index.js`);
      expect(targets, name).toContain(`dist/src/${name}/index.d.ts`);
    }
    expect(http.exports?.['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/src/index.js' });
  });
  it('maps each entry for CommonJS with moduleResolution node too (typesVersions), which is what the CommonJS smoke project resolves through', () => {
    for (const name of SUBPATHS) expect((http as unknown as { typesVersions: { '*': Record<string, string[]> } }).typesVersions['*'][name], name).toEqual([`dist/src/${name}/index.d.ts`]);
  });
  it('a tarball that lacks one of the entries is refused', () => {
    const targets = exportTargets(http) as string[];
    const sources = targets.filter((t) => t.endsWith('.js')).map((t) => t.replace(/^dist\//, '').replace(/\.js$/, '.ts'));
    const files = ['package.json', 'README.md', 'LICENSE', ...targets, ...targets.map((t) => `${t}.map`), ...sources];
    expect(checkFileList({ pkg: http, files }).filter((p) => /discord|coop|eos/.test(p))).toEqual([]);
    for (const name of SUBPATHS) {
      const without = files.filter((f) => f !== `dist/src/${name}/index.js`);
      expect(checkFileList({ pkg: http, files: without }).join('\n'), name).toContain(`dist/src/${name}/index.js`);
    }
  });
});

describe('the core manifest in the repo and the notice-copy subpath (0.2.0)', () => {
  const core = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/core/package.json', import.meta.url)), 'utf8')) as Pkg;
  it('lists the subpath among the files a tarball must hold (types and ESM, from dist), and the root still has its own entry', () => {
    const targets = exportTargets(core) as string[];
    expect(targets).toContain('dist/src/noticeCopy.js');
    expect(targets).toContain('dist/src/noticeCopy.d.ts');
    expect((core.exports as Record<string, unknown>)['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/src/index.js' });
    expect((core.exports as Record<string, unknown>)['./notice-copy']).toEqual({ types: './dist/src/noticeCopy.d.ts', default: './dist/src/noticeCopy.js' });
  });
  it('maps it for moduleResolution node too (typesVersions)', () => {
    expect((core as unknown as { typesVersions: { '*': Record<string, string[]> } }).typesVersions['*']['notice-copy']).toEqual(['dist/src/noticeCopy.d.ts']);
  });
  it('the manifest still passes the publish checks (files, side effects, prepack)', () => {
    expect(checkManifest(core, 'core')).toEqual([]);
  });
  it('a tarball that lacks the subpath is refused, and one that has it is not', () => {
    const targets = exportTargets(core) as string[];
    const sources = targets.filter((t) => t.endsWith('.js')).map((t) => t.replace(/^dist\//, '').replace(/\.js$/, '.ts'));
    const files = ['package.json', 'README.md', 'LICENSE', ...targets, ...targets.map((t) => `${t}.map`), ...sources];
    expect(checkFileList({ pkg: core, files })).toEqual([]);
    for (const missing of ['dist/src/noticeCopy.js', 'dist/src/noticeCopy.d.ts']) {
      expect(checkFileList({ pkg: core, files: files.filter((f) => f !== missing) }).join('\n'), missing).toContain(`export target is not in the tarball: ${missing}`);
    }
  });
  it('core stays browser-safe, so the subpath may import no Node builtin', () => {
    expect([...BROWSER_SAFE]).toContain('@chatwarden/core');
    const source = readFileSync(fileURLToPath(new URL('../packages/core/src/noticeCopy.ts', import.meta.url)), 'utf8');
    expect(nodeImportProblems({ pkg: core, files: [{ path: 'dist/src/noticeCopy.js', source }] })).toEqual([]);
    expect(nodeImportProblems({ pkg: core, files: [{ path: 'dist/src/noticeCopy.js', source: `${source}\nimport fs from 'node:fs';\n` }] })).not.toEqual([]);
  });
});

describe('the notice-locales subpath of core (0.2.1)', () => {
  const core = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/core/package.json', import.meta.url)), 'utf8')) as Pkg;
  const FILES = ['noticeLocales', 'noticeLocales.es', 'noticeLocales.pt', 'appealWords', 'deliveryCopy', 'noticeCopy'];
  it('is exported with types and ESM from dist, beside the root and notice-copy entries, and mapped for moduleResolution node', () => {
    expect((core.exports as Record<string, unknown>)['./notice-locales']).toEqual({ types: './dist/src/noticeLocales.d.ts', default: './dist/src/noticeLocales.js' });
    expect((core.exports as Record<string, unknown>)['./notice-copy']).toEqual({ types: './dist/src/noticeCopy.d.ts', default: './dist/src/noticeCopy.js' });
    expect((core as unknown as { typesVersions: { '*': Record<string, string[]> } }).typesVersions['*']['notice-locales']).toEqual(['dist/src/noticeLocales.d.ts']);
    const targets = exportTargets(core) as string[];
    expect(targets).toContain('dist/src/noticeLocales.js');
    expect(targets).toContain('dist/src/noticeLocales.d.ts');
  });
  it('a tarball that lacks the subpath is refused, and the manifest still passes the publish checks', () => {
    expect(checkManifest(core, 'core')).toEqual([]);
    const targets = exportTargets(core) as string[];
    const sources = targets.filter((t) => t.endsWith('.js')).map((t) => t.replace(/^dist\//, '').replace(/\.js$/, '.ts'));
    const files = ['package.json', 'README.md', 'LICENSE', ...targets, ...targets.map((t) => `${t}.map`), ...sources];
    expect(checkFileList({ pkg: core, files })).toEqual([]);
    for (const missing of ['dist/src/noticeLocales.js', 'dist/src/noticeLocales.d.ts']) {
      expect(checkFileList({ pkg: core, files: files.filter((f) => f !== missing) }).join('\n'), missing).toContain(`export target is not in the tarball: ${missing}`);
    }
  });
  it('core stays browser-safe: none of the words and delivery files imports a Node builtin', () => {
    for (const name of FILES) {
      const source = readFileSync(fileURLToPath(new URL(`../packages/core/src/${name}.ts`, import.meta.url)), 'utf8');
      expect(nodeImportProblems({ pkg: core, files: [{ path: `dist/src/${name}.js`, source }] }), name).toEqual([]);
      expect(source, name).not.toMatch(/from 'node:/);
    }
  });
});
