import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { checkFileList, checkManifest, exportTargets } from './check-pack.mjs';

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

const check = (files: string[], pkg: Pkg = goodPkg(), hasReadme = true): string[] =>
  checkFileList({ pkg, files, hasReadme });

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
  it('does not require README.md when the package has none', () => {
    const files = goodFiles().filter((f) => f !== 'README.md');
    expect(check(files, goodPkg(), false)).toEqual([]);
  });
  it('requires README.md when the package has one', () => {
    const files = goodFiles().filter((f) => f !== 'README.md');
    expect(check(files, goodPkg(), true).join('\n')).toMatch(/README\.md/);
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
