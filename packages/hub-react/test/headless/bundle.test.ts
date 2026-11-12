// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

// `@chatwarden/hub-react/headless` bundled the way an adopter's bundler would see it, in a world where React is NOT installed: any
// attempt to resolve it fails the build. So this passes only if nothing the entry reaches imports React, React DOM or the JSX runtime.

const headless = fileURLToPath(new URL('../../src/headless/index.ts', import.meta.url));
const full = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
/** Gzipped, minified, the kit's core external (a peer). Measured at 21.8 KB when it was written; the English catalog is most of it. */
const BUDGET = 28 * 1024;
/** The same, for everything: the first fetch plus the chunks loaded on demand (the AI's ranking, 0.7 KB when this was set: the first-fetch budget plus that, rounded up). A bundler that does not split puts them in one file, so this is the ceiling for such an adopter. */
const TOTAL_BUDGET = 29 * 1024;

/** React, React DOM, the JSX runtime and the scheduler do not exist: resolving any of them is an error. */
const noReact: Plugin = {
  name: 'react-is-not-installed',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|scheduler)(\/.*)?$/ }, (args) => ({ errors: [{ text: `React was pulled in: ${args.path} (from ${args.importer})` }] }));
  },
};

async function bundle(entry: string) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    // Our own peers stay outside, as for any adopter. React is not listed: it is not installed.
    external: ['@chatwarden/*'],
    plugins: [noReact],
    // Split, as an adopter's bundler splits at a dynamic `import()`: the AI's ranking (`loadAiRank`, and the queue's own load of it when it holds a
    // read) is a chunk loaded when asked for, not part of what the entry carries. The figures are the entry and every chunk it imports statically.
    splitting: true,
    outdir: fileURLToPath(new URL('../../.size-out-headless', import.meta.url)),
    entryNames: 'entry',
    chunkNames: 'chunk-[name]-[hash]',
    metafile: true,
    logLevel: 'silent',
  });
  const meta = Object.entries(result.metafile.outputs);
  const nameOf = (key: string): string => key.split(/[\\/]/).pop() ?? key;
  const eagerNames = new Set<string>();
  const visit = (key: string): void => {
    if (eagerNames.has(nameOf(key))) return;
    eagerNames.add(nameOf(key));
    for (const imp of meta.find(([k]) => k === key)?.[1].imports ?? []) if (imp.kind === 'import-statement' && !imp.external) visit(imp.path);
  };
  const entryKey = meta.find(([, o]) => o.entryPoint !== undefined)?.[0];
  if (entryKey === undefined) throw new Error('esbuild produced no output');
  visit(entryKey);
  const eager = result.outputFiles.filter((o) => eagerNames.has(nameOf(o.path)));
  const joined = Buffer.concat(eager.map((o) => Buffer.from(o.contents)));
  const eagerInputs = [...new Set(meta.filter(([k]) => eagerNames.has(nameOf(k))).flatMap(([, o]) => Object.keys(o.inputs)))].map((p) => p.replaceAll('\\', '/'));
  return {
    /** Every file's text, the chunks loaded on demand too. */
    texts: result.outputFiles.map((o) => o.text),
    /** Everything the build writes, the chunks loaded on demand too, gzipped together: what an adopter whose bundler does not split pays. */
    totalGzip: gzipSync(Buffer.concat(result.outputFiles.map((o) => Buffer.from(o.contents))), { level: 9 }).byteLength,
    /** What a first load fetches: the entry and the chunks it imports statically. */
    bytes: joined.byteLength,
    gzip: gzipSync(joined, { level: 9 }).byteLength,
    inputs: Object.keys(result.metafile.inputs).map((p) => p.replaceAll('\\', '/')),
    eagerInputs,
  };
}

describe('@chatwarden/hub-react/headless bundles without React', () => {
  it('builds with React, React DOM and the scheduler unresolvable', async () => {
    await expect(bundle(headless)).resolves.toBeDefined();
  });

  it('the guard catches React when it is there (control: the React entry does not build)', async () => {
    await expect(bundle(full)).rejects.toThrow(/React was pulled in: react/);
  });

  it('holds no React file, no .tsx and no stylesheet', async () => {
    const { inputs } = await bundle(headless);
    expect(inputs.filter((i) => /node_modules\/(react|react-dom|scheduler)\//.test(i))).toEqual([]);
    expect(inputs.filter((i) => /\.tsx$/.test(i))).toEqual([]);
    expect(inputs.filter((i) => /\.css$/.test(i))).toEqual([]);
    expect(inputs.some((i) => i.endsWith('src/headless/controller.ts'))).toBe(true);
  });

  it('imports only the kit core (for the ladder table), and no Node builtin and no eval', async () => {
    const { texts } = await bundle(headless);
    const text = texts.join('\n');
    // A `./chunk-...` import is the bundle's own.
    const imports = [...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1] as string).filter((i) => !i.startsWith('./'));
    expect(new Set(imports)).toEqual(new Set(['@chatwarden/core']));
    expect(text).not.toMatch(/from\s*"node:/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });

  it('carries none of the AI in what it fetches first: the ranking is a chunk of its own, loaded when the queue holds a read or loadAiRank is called', async () => {
    const { eagerInputs, inputs } = await bundle(headless);
    expect(eagerInputs.filter((i) => /src\/ai\//.test(i))).toEqual([]);
    expect(inputs.some((i) => i.endsWith('src/ai/rank.ts'))).toBe(true);
  });

  it('is small: under 28 KB gzipped, core external', async () => {
    const { bytes, gzip } = await bundle(headless);
    console.log(`hub-react/headless bundle: ${bytes} bytes minified, ${gzip} bytes gzipped (budget ${BUDGET})`);
    expect(gzip).toBeLessThan(BUDGET);
    expect(bytes).toBeGreaterThan(5_000);
  });

  it('is bounded as a whole too: the first fetch and the chunks loaded on demand together stay under the total ceiling', async () => {
    const { gzip, totalGzip } = await bundle(headless);
    console.log(`hub-react/headless total (all chunks): ${totalGzip} bytes gzipped, first fetch ${gzip} (total ceiling ${TOTAL_BUDGET})`);
    expect(totalGzip).toBeGreaterThanOrEqual(gzip);
    expect(totalGzip).toBeLessThan(TOTAL_BUDGET);
  });
});
