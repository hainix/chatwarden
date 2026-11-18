// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The appeal page's own entry, `@chatwarden/player-react/appeal`, bundled the way size.test.ts bundles the main one: React and the kit stay outside, everything else of
// ours is in, minified and gzipped. The main entry does not reach it (its own budget test is untouched), and a page that never shows the appeal page never loads it.

const entry = fileURLToPath(new URL('../src/appeal/index.ts', import.meta.url));
const main = fileURLToPath(new URL('../src/index.ts', import.meta.url));
// Measured 4,198 bytes gzipped (10,748 minified) at 0.2.1; the budget is that plus about 10 percent, which is also what it takes to draw every state, in en, es and pt through the
// kit's own words (the words themselves stay in core's `notice-locales`, which is a peer import, not part of this size).
const JS_BUDGET = 4.5 * 1024;

async function bundle(file: string) {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/*', '@chatwarden/*'],
    splitting: true,
    outdir: fileURLToPath(new URL('../.size-out-appeal', import.meta.url)),
    entryNames: 'entry',
    chunkNames: 'chunk-[name]-[hash]',
    metafile: true,
    logLevel: 'silent',
  });
  const out = result.outputFiles.find((o) => o.path.endsWith('entry.js'));
  if (out === undefined) throw new Error('esbuild produced no output');
  return { text: out.text, bytes: out.contents.byteLength, gzip: gzipSync(out.contents, { level: 9 }).byteLength, inputs: Object.keys(result.metafile.inputs).map((i) => i.replaceAll('\\', '/')) };
}

describe('the appeal entry', () => {
  it(`is under its budget gzipped with React and the kit external`, async () => {
    const { bytes, gzip } = await bundle(entry);
    console.log(`player-react appeal entry: ${bytes} bytes minified, ${gzip} bytes gzipped (budget ${JS_BUDGET})`);
    expect(gzip).toBeLessThan(JS_BUDGET);
    expect(bytes).toBeGreaterThan(2_000);
  });

  it('bundles none of React, React DOM or the kit, and imports only React and the two core subpaths it needs (no React DOM: it draws no dialog)', async () => {
    const { inputs, text } = await bundle(entry);
    expect(inputs.filter((i) => /node_modules\/(react|react-dom|scheduler)\//.test(i))).toEqual([]);
    expect(inputs.filter((i) => /@chatwarden|packages\/(core|http|store-memory|matcher|hub-react)\//.test(i))).toEqual([]);
    const imports = new Set([...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const i of imports) expect(['react', 'react/jsx-runtime', '@chatwarden/core/notice-copy', '@chatwarden/core/notice-locales'], String(i)).toContain(i);
    expect(imports).toContain('@chatwarden/core/notice-locales');
  });

  it('contains no Node builtin, no eval, and no storage or cookie access', async () => {
    const { text } = await bundle(entry);
    expect(text).not.toMatch(/from\s*"node:/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
    expect(text).not.toMatch(/document\.cookie|localStorage|sessionStorage/);
  });
});

describe('the main entry stays as it was', () => {
  it('does not import the appeal entry, and none of its files is in the main bundle', async () => {
    const source = readFileSync(main, 'utf8');
    expect(source).not.toMatch(/appeal\/(index|AppealPage|appealClient)|\.\/appeal\//);
    const { inputs, text } = await bundle(main);
    expect(inputs.filter((i) => /src\/appeal\//.test(i))).toEqual([]);
    expect(text).not.toContain('notice-locales');
  });
});
