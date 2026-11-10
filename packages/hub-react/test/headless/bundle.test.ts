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
    metafile: true,
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return { text: out.text, bytes: out.contents.byteLength, gzip: gzipSync(out.contents, { level: 9 }).byteLength, inputs: Object.keys(result.metafile.inputs).map((p) => p.replaceAll('\\', '/')) };
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
    const { text } = await bundle(headless);
    const imports = [...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['@chatwarden/core']));
    expect(text).not.toMatch(/from\s*"node:/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });

  it('is small: under 28 KB gzipped, core external', async () => {
    const { bytes, gzip } = await bundle(headless);
    console.log(`hub-react/headless bundle: ${bytes} bytes minified, ${gzip} bytes gzipped (budget ${BUDGET})`);
    expect(gzip).toBeLessThan(BUDGET);
    expect(bytes).toBeGreaterThan(5_000);
  });
});
