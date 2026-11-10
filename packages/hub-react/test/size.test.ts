// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The package entry, bundled the way an adopter's bundler would see it: React, React DOM and the kit stay outside (they are
// peers), everything else of ours is in. Minified and gzipped, it must stay under 60 KB.

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const BUDGET = 60 * 1024;

async function bundle() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/*', '@chatwarden/*'],
    metafile: true,
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return { text: out.text, bytes: out.contents.byteLength, gzip: gzipSync(out.contents, { level: 9 }).byteLength, inputs: Object.keys(result.metafile.inputs) };
}

describe('bundle size', () => {
  it('is under 60 KB gzipped with React and the kit external', async () => {
    const { bytes, gzip } = await bundle();
    console.log(`hub-react bundle: ${bytes} bytes minified, ${gzip} bytes gzipped (budget ${BUDGET})`);
    expect(gzip).toBeLessThan(BUDGET);
    expect(bytes).toBeGreaterThan(5_000);
  });

  it('bundles none of React, React DOM or the kit', async () => {
    const { inputs } = await bundle();
    expect(inputs.filter((i) => /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(i))).toEqual([]);
    expect(inputs.filter((i) => /@chatwarden|packages[\\/](core|http|store-memory|matcher)[\\/]/.test(i))).toEqual([]);
  });

  it('imports React only through the names the peers provide', async () => {
    const { text } = await bundle();
    const imports = [...text.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['react', 'react/jsx-runtime']));
  });

  it('contains no Node builtin and no eval', async () => {
    const { text } = await bundle();
    expect(text).not.toMatch(/from\s*"node:/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });

  it('the stylesheet is small too', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(fileURLToPath(new URL('../src/styles.css', import.meta.url)));
    const gzip = gzipSync(css, { level: 9 }).byteLength;
    console.log(`hub-react styles.css: ${css.byteLength} bytes, ${gzip} bytes gzipped`);
    expect(gzip).toBeLessThan(6 * 1024);
  });
});
