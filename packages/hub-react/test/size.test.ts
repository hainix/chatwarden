// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The package entry, bundled the way an adopter's bundler would see it: React, React DOM and the kit stay outside (they are
// peers), everything else of ours is in. Minified and gzipped, it must stay under 96 KB. The budget was 60 KB, a guess made before the screens existed; it is a staff-only tool on the
// adopter's admin route, raised at Task 6 (to 72 KB) so guidance copy is never cut to fit, and again to 84 KB: raised at 7d for the Steps and ladder settings screen (owner-approved feature, 2026-11-10), and to 96 KB at 7i: raised at 7i for the Reporting settings section (owner-approved, 2026-11-10); lazy-loading the settings and admin screens is a tracked follow-up.

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const BUDGET = 96 * 1024;

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
  it('is under 96 KB gzipped with React and the kit external', async () => {
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

  it('imports only what the peers provide: React, and the kit core for the ladder table', async () => {
    const { text } = await bundle();
    // `import ... from "x"` only: a catalog phrase that happens to end in "from" is not an import.
    const imports = [...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['react', 'react/jsx-runtime', '@chatwarden/core']));
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
    // Design v2 (the shell, the windows, the toasts, the team view): 10 KB gzipped, up from 7. The case pane (transcript, decision
    // bar, context pane, phone sheet) takes it to 12. The last five screens (Terms, Blocked, Rule gaps, Audit and the Guide: their
    // tables, forms, the dry-run list and the guide's document typography) take it to 14 (76 KB raw, see static.test.ts).
    // And 15 KB at 7d: raised at 7d for the Steps and ladder settings screen (owner-approved feature, 2026-11-10).
    // And 18 KB at 7j: every one of the 960 token reads now carries its private default, `var(--cw-x, var(--cwd-x))`, which is what lets a
    // page theme the hub from any element above it (owner-approved, 2026-11-10): +20 KB raw, about +1 KB gzipped. The fallbacks are not
    // folded away at build time: that is the transform this task removed from the element.
    expect(gzip).toBeLessThan(18 * 1024);
  });
});
