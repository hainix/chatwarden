// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The package entry, bundled the way an adopter's bundler would see it: React and the kit stay outside (they are peers),
// everything else of ours is in. Minified and gzipped, the JS must stay under 15 KB and the stylesheet under 6 KB.
//
// Why so small: these components run inside a game, on the player's device, next to the game's own code, and a player waits for
// them (a notice appears before the next match). The hub is a staff tool on an admin page and has a 72 KB budget; the player
// side is five small components over four routes, with no markdown renderer, no router and no table code, so 15 KB is already
// generous. If the real size nears the budget, trim before raising it.

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const JS_BUDGET = 15 * 1024;
const CSS_BUDGET = 6 * 1024;

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
  it('is under 15 KB gzipped with React and the kit external', async () => {
    const { bytes, gzip } = await bundle();
    console.log(`player-react bundle: ${bytes} bytes minified, ${gzip} bytes gzipped (budget ${JS_BUDGET})`);
    expect(gzip).toBeLessThan(JS_BUDGET);
    expect(bytes).toBeGreaterThan(3_000);
  });

  it('bundles none of React, React DOM or the kit', async () => {
    const { inputs } = await bundle();
    expect(inputs.filter((i) => /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(i))).toEqual([]);
    expect(inputs.filter((i) => /@chatwarden|packages[\\/](core|http|store-memory|matcher|hub-react)[\\/]/.test(i))).toEqual([]);
  });

  it('imports only what the peers provide: React and React DOM (for the optional portal); the kit is types only', async () => {
    const { text } = await bundle();
    // `import ... from "x"` only: a catalog phrase that happens to end in "from" is not an import.
    const imports = [...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['react', 'react/jsx-runtime', 'react-dom']));
  });

  it('contains no Node builtin and no eval', async () => {
    const { text } = await bundle();
    expect(text).not.toMatch(/from\s*"node:/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });

  it('the stylesheet is small too: under 6 KB gzipped', async () => {
    const css = await readFile(fileURLToPath(new URL('../src/styles.css', import.meta.url)));
    const gzip = gzipSync(css, { level: 9 }).byteLength;
    console.log(`player-react styles.css: ${css.byteLength} bytes, ${gzip} bytes gzipped (budget ${CSS_BUDGET})`);
    expect(gzip).toBeLessThan(CSS_BUDGET);
  });
});
