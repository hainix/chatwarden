import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// `@chatwarden/matcher/corpus` and `@chatwarden/matcher/corpus/node` are subpaths of an existing package (design 5, ruling 5), so they must
// resolve the way an adopter's tooling resolves them: native ESM, native CommonJS, and TypeScript with the old `moduleResolution: node`
// (which ignores `exports` and needs `typesVersions`), with `node16` and with a bundler. Needs the packages built (`npm run build`).
// The vitest alias does not apply here: these run Node and the TypeScript resolver themselves, from the repo root, through node_modules.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATCHER = `${ROOT}packages/matcher/`;
const built = (file: string): void => {
  if (!existsSync(`${MATCHER}${file}`)) throw new Error(`packages/matcher/${file} is not built: run \`npm run build\` first`);
};

const pkg = JSON.parse(readFileSync(`${MATCHER}package.json`, 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
  typesVersions: Record<string, Record<string, string[]>>;
  sideEffects: boolean;
  files: string[];
};

const CORPUS_NAMES = ['CorpusError', 'CORPUS_KEYS', 'createCorpusLoader', 'parseTermsRelease', 'readZip', 'releaseToPack', 'signedMessage', 'verifySignature'];
const NODE_NAMES = ['fileCache', 'installationKey', 'startCorpus'];

describe('package.json', () => {
  it('declares both subpaths with types and a default, typesVersions for both, no side effects, and ships dist and src', () => {
    expect(pkg.exports['./corpus']).toEqual({ types: './dist/src/corpus/index.d.ts', default: './dist/src/corpus/index.js' });
    expect(pkg.exports['./corpus/node']).toEqual({ types: './dist/src/corpus/node/index.d.ts', default: './dist/src/corpus/node/index.js' });
    expect(pkg.typesVersions['*']!['corpus']).toEqual(['dist/src/corpus/index.d.ts']);
    expect(pkg.typesVersions['*']!['corpus/node']).toEqual(['dist/src/corpus/node/index.d.ts']);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.files).toEqual(expect.arrayContaining(['dist/src', 'src']));
    // The root entry is unchanged: it names neither subpath.
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './corpus', './corpus/node', './fixtures', './test-fixtures']);
  });
});

describe('native resolution, from the repo root through node_modules', () => {
  const node = (args: string[]): string => execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const names = (out: string): string[] => JSON.parse(out) as string[];

  it('ESM: both subpaths import, with the names the design lists; the root has none of them', () => {
    built('dist/src/corpus/index.js');
    built('dist/src/corpus/node/index.js');
    const code = (spec: string): string => `import(${JSON.stringify(spec)}).then((m) => console.log(JSON.stringify(Object.keys(m).sort())))`;
    expect(names(node(['--input-type=module', '-e', code('@chatwarden/matcher/corpus')]))).toEqual(expect.arrayContaining(CORPUS_NAMES));
    expect(names(node(['--input-type=module', '-e', code('@chatwarden/matcher/corpus/node')]))).toEqual(expect.arrayContaining(NODE_NAMES));
    const root = names(node(['--input-type=module', '-e', code('@chatwarden/matcher')]));
    for (const name of [...CORPUS_NAMES, ...NODE_NAMES]) expect(root, name).not.toContain(name);
    // The node half is not part of the isomorphic one.
    expect(names(node(['--input-type=module', '-e', code('@chatwarden/matcher/corpus')]))).not.toEqual(expect.arrayContaining(['fileCache']));
  });

  it('CommonJS: both subpaths resolve and load (require of an ES module, Node 22.12 and later)', () => {
    built('dist/src/corpus/index.js');
    built('dist/src/corpus/node/index.js');
    const code = (spec: string): string => `console.log(JSON.stringify(Object.keys(require(${JSON.stringify(spec)})).sort()))`;
    expect(names(node(['-e', code('@chatwarden/matcher/corpus')]))).toEqual(expect.arrayContaining(CORPUS_NAMES));
    expect(names(node(['-e', code('@chatwarden/matcher/corpus/node')]))).toEqual(expect.arrayContaining(NODE_NAMES));
    const resolved = node(['-e', `console.log(require.resolve('@chatwarden/matcher/corpus/node'))`]).trim().replaceAll(String.fromCharCode(92), '/');
    expect(resolved.endsWith('packages/matcher/dist/src/corpus/node/index.js')).toBe(true);
  });

  it('an unlisted path under corpus is not reachable (exports is a closed list)', () => {
    for (const spec of ['@chatwarden/matcher/corpus/node/fileCache', '@chatwarden/matcher/corpus/loader', '@chatwarden/matcher/src/corpus/index.js', '@chatwarden/matcher/dist/src/corpus/index.js']) {
      expect(() => node(['--input-type=module', '-e', `import(${JSON.stringify(spec)}).then(() => console.log('LOADED'))`]), spec).toThrow();
    }
  });
});

describe('TypeScript resolution of the declaration files', () => {
  const from = `${ROOT}scripts/x.ts`;
  const resolve = (spec: string, options: ts.CompilerOptions, mode?: ts.ResolutionMode): string | undefined => {
    const out = ts.resolveModuleName(spec, from, options, ts.sys, undefined, undefined, mode);
    return out.resolvedModule?.resolvedFileName.replaceAll(String.fromCharCode(92), '/');
  };

  const kinds: [string, ts.CompilerOptions, ts.ResolutionMode?][] = [
    ['node (the old resolver, which ignores exports: typesVersions)', { moduleResolution: ts.ModuleResolutionKind.Node10 }],
    ['node16 from an ES module', { moduleResolution: ts.ModuleResolutionKind.Node16, module: ts.ModuleKind.Node16 }, ts.ModuleKind.ESNext],
    ['node16 from a CommonJS file', { moduleResolution: ts.ModuleResolutionKind.Node16, module: ts.ModuleKind.Node16 }, ts.ModuleKind.CommonJS],
    ['bundler', { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext }],
  ];

  it.each(kinds)('%s: both subpaths find their declarations', (_label, options, mode) => {
    built('dist/src/corpus/index.d.ts');
    built('dist/src/corpus/node/index.d.ts');
    expect(resolve('@chatwarden/matcher/corpus', options, mode)?.endsWith('packages/matcher/dist/src/corpus/index.d.ts')).toBe(true);
    expect(resolve('@chatwarden/matcher/corpus/node', options, mode)?.endsWith('packages/matcher/dist/src/corpus/node/index.d.ts')).toBe(true);
    // and the existing subpaths still do
    expect(resolve('@chatwarden/matcher/fixtures', options, mode)?.endsWith('packages/matcher/dist/src/fixtures/index.d.ts')).toBe(true);
    expect(resolve('@chatwarden/matcher', options, mode)?.endsWith('packages/matcher/dist/src/index.d.ts')).toBe(true);
  });

  it('the old resolver does not mistake corpus/node for the folder `corpus` plus a file, and an unknown subpath does not resolve', () => {
    const options = { moduleResolution: ts.ModuleResolutionKind.Node10 };
    expect(resolve('@chatwarden/matcher/corpus/nothing', options)).toBeUndefined();
    expect(resolve('@chatwarden/matcher/corpus/node', options)).not.toBe(resolve('@chatwarden/matcher/corpus', options));
  });
});
