// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The chat entry is a lazy subpath (`@chatwarden/player-react/chat`); the main entry does not reach it. Three numbers are held:
// what a page that already shows the player components pays for the chat (the two bundled together, minus the main entry alone),
// what the chat entry weighs on its own (it includes the shared modules it imports), and the stylesheet. React, React DOM and the
// kit stay outside, as for the main entry. The numbers were set after measuring (design 13.5 records them).

const pkg = fileURLToPath(new URL('..', import.meta.url));
const MARGINAL_BUDGET = 8 * 1024;
const ENTRY_BUDGET = 20 * 1024;
const CSS_BUDGET = 3 * 1024;

async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: pkg, loader: 'ts', sourcefile: 'entry.ts' },
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

const index = "export * from './src/index';";
const chat = "export * from './src/chat/index';";

describe('chat bundle size', () => {
  it('marginal JS under budget (index + chat minus index, gzip)', async () => {
    const both = await bundle(`${index}\n${chat}`);
    const main = await bundle(index);
    const marginal = both.gzip - main.gzip;
    console.log(`chat marginal: ${marginal} bytes gzipped (budget ${MARGINAL_BUDGET}); main ${main.gzip}, both ${both.gzip}`);
    expect(marginal).toBeLessThan(MARGINAL_BUDGET);
    expect(marginal).toBeGreaterThan(1500);
  });

  it('the chat entry alone under budget', async () => {
    const entry = await bundle(chat);
    console.log(`chat entry: ${entry.bytes} bytes minified, ${entry.gzip} gzipped (budget ${ENTRY_BUDGET})`);
    expect(entry.gzip).toBeLessThan(ENTRY_BUDGET);
  });

  it('chat.css under budget', async () => {
    const css = await readFile(fileURLToPath(new URL('../src/chat.css', import.meta.url)));
    const gzip = gzipSync(css, { level: 9 }).byteLength;
    console.log(`chat.css: ${css.byteLength} bytes, ${gzip} gzipped (budget ${CSS_BUDGET})`);
    expect(gzip).toBeLessThan(CSS_BUDGET);
  });

  it('the main entry reaches no chat module, so its own size.test.ts is untouched', async () => {
    const main = await bundle(index);
    expect(main.inputs.filter((i) => /[\\/]src[\\/]chat[\\/]/.test(i))).toEqual([]);
  });

  it('the chat entry bundles none of React, React DOM or the kit', async () => {
    const entry = await bundle(chat);
    expect(entry.inputs.filter((i) => /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(i))).toEqual([]);
    expect(entry.inputs.filter((i) => /@chatwarden|packages[\\/](core|http|store-memory|matcher|hub-react)[\\/]/.test(i))).toEqual([]);
  });

  it('imports only what the peers provide, and contains no Node builtin and no eval', async () => {
    const { text } = await bundle(chat);
    const imports = [...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['react', 'react/jsx-runtime', 'react-dom']));
    expect(text).not.toMatch(/from\s*"node:/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });
});
