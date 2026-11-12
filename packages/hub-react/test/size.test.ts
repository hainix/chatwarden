// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The package entry, bundled the way an adopter's bundler would see it: React, React DOM and the kit stay outside (they are
// peers), everything else of ours is in. Minified and gzipped, what a first load fetches must stay under 75 KB. The budget was 60 KB, a guess made before the screens existed; it is a staff-only tool on the
// adopter's admin route, raised at Task 6 (to 72 KB) so guidance copy is never cut to fit, and again to 84 KB: raised at 7d for the Steps and ladder settings screen (owner-approved feature, 2026-11-10), and to 96 KB at 7i: raised at 7i for the Reporting settings section (owner-approved, 2026-11-10).
// Lowered to 75 KB at 0.1.3 (hardening): Terms, Blocked, Rule gaps, Audit, Guide, the Steps and ladder and Reporting settings and All
// actions are now loaded when first opened (React.lazy). What the budget guards is the entry plus every chunk it imports statically
// (code the entry shares with the lazy screens is fetched up front, so it counts), gzipped as one stream: 93,041 bytes before, 72,829
// after (-22%; 75 KB is the new size plus about 5%). The lazy-only chunks are another 29,610 bytes gzipped (summed per file), fetched
// one screen at a time. The entry file on its own is 49,057 (it is also held, to 52 KB, so shared code cannot be moved out of it to
// pass). The bundle is built with splitting on, as an adopter's bundler splits at a dynamic import().

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const BUDGET = 75 * 1024;
const ENTRY_BUDGET = 52 * 1024;

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
    // Split, as an adopter's bundler splits at a dynamic `import()`: the settings and admin screens are their own chunks, loaded when
    // first opened. The entry is the file `src/index.ts` produced; the rest are the chunks it loads on demand.
    splitting: true,
    outdir: fileURLToPath(new URL('../.size-out', import.meta.url)),
    entryNames: 'entry',
    chunkNames: 'chunk-[name]-[hash]',
    metafile: true,
    logLevel: 'silent',
  });
  const outputs = result.outputFiles.map((o) => ({
    name: o.path.split(/[\\/]/).pop() ?? '',
    text: o.text,
    bytes: o.contents.byteLength,
    gzip: gzipSync(o.contents, { level: 9 }).byteLength,
  }));
  const out = outputs.find((o) => o.name === 'entry.js');
  const meta = Object.entries(result.metafile.outputs);
  const entryMeta = meta.find(([, o]) => o.entryPoint?.endsWith('src/index.ts') === true)?.[1];
  if (out === undefined || entryMeta === undefined) throw new Error('esbuild produced no entry');
  // What a browser must fetch before the entry runs: the entry and every chunk reached by a static `import ... from`, followed all the
  // way down. A dynamic `import()` (a screen loaded on demand) is not part of it. Rollup and webpack fold the shared code into fewer
  // files, but the bytes are the same.
  const outputOf = (key: string) => meta.find(([k]) => k === key)?.[1];
  const eagerNames = new Set<string>();
  const visit = (key: string): void => {
    const name = key.split('/').pop() ?? key;
    if (eagerNames.has(name)) return;
    eagerNames.add(name);
    for (const imp of outputOf(key)?.imports ?? []) if (imp.kind === 'import-statement' && !imp.external) visit(imp.path);
  };
  visit(meta.find(([, o]) => o === entryMeta)?.[0] ?? '');
  const eager = outputs.filter((o) => eagerNames.has(o.name));
  const eagerBytes = eager.reduce((n, o) => n + o.bytes, 0);
  // One stream, gzipped as it would be if it were one file: the honest first-load figure.
  const eagerGzip = gzipSync(Buffer.concat(eager.map((o) => Buffer.from(o.text))), { level: 9 }).byteLength;
  const lazyGzip = outputs.filter((o) => !eagerNames.has(o.name)).reduce((n, o) => n + o.gzip, 0);
  return {
    text: out.text,
    bytes: out.bytes,
    gzip: out.gzip,
    /** The entry, the chunks it imports statically (all of them eager), and the chunks loaded on demand. */
    eager: { files: eager.length, bytes: eagerBytes, gzip: eagerGzip },
    lazyGzip,
    lazyFiles: outputs.length - eager.length,
    /** The entry and every chunk. */
    all: outputs,
    /** The source files the entry itself carries. */
    entryInputs: Object.keys(entryMeta.inputs),
    /** The source file each on-demand chunk starts from (each dynamic `import()`). */
    chunkRoots: meta.flatMap(([, o]) => (o.entryPoint !== undefined && !o.entryPoint.endsWith('src/index.ts') ? [o.entryPoint] : [])),
    inputs: Object.keys(result.metafile.inputs),
  };
}

describe('bundle size', () => {
  it('the code a first load fetches (the entry and the chunks it imports statically) is under budget, gzipped', async () => {
    const { eager, gzip, bytes, lazyGzip, lazyFiles } = await bundle();
    console.log(
      `hub-react eager: ${eager.files} files, ${eager.bytes} bytes minified, ${eager.gzip} bytes gzipped (budget ${BUDGET}); entry file alone ${bytes} / ${gzip} gzipped; ${lazyFiles} lazy chunks ${lazyGzip} gzipped`,
    );
    expect(eager.gzip).toBeLessThan(BUDGET);
    expect(gzip).toBeLessThan(ENTRY_BUDGET);
    expect(bytes).toBeGreaterThan(5_000);
  });

  it('the screens loaded on demand are worth having: they are a real share of what the hub holds', async () => {
    const { eager, lazyGzip } = await bundle();
    // If this fell to nothing, the split would be doing no work (or the closure above would be measuring the wrong files).
    expect(lazyGzip).toBeGreaterThan(15 * 1024);
    expect(eager.gzip).toBeGreaterThan(30 * 1024);
  });

  it('bundles none of React, React DOM or the kit', async () => {
    const { inputs } = await bundle();
    expect(inputs.filter((i) => /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(i))).toEqual([]);
    expect(inputs.filter((i) => /@chatwarden|packages[\\/](core|http|store-memory|matcher)[\\/]/.test(i))).toEqual([]);
  });

  it('imports only what the peers provide: React, and the kit core for the ladder table', async () => {
    const { all } = await bundle();
    const peers = new Set(['react', 'react/jsx-runtime', '@chatwarden/core']);
    // `import ... from "x"` only: a catalog phrase that happens to end in "from" is not an import. A `./chunk-...` import is the bundle's own.
    const importsOf = (text: string): string[] => [...text.matchAll(/\bimport\b[^;"]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1] as string).filter((i) => !i.startsWith('./'));
    // The entry uses all three; no chunk (a screen loaded on demand, or code they share) reaches for anything outside them.
    expect(new Set(importsOf(all.find((o) => o.name === 'entry.js')?.text ?? ''))).toEqual(peers);
    for (const out of all) for (const i of importsOf(out.text)) expect(peers, `${out.name} imports ${i}`).toContain(i);
  });

  it('contains no Node builtin and no eval', async () => {
    const { all } = await bundle();
    for (const out of all) {
      expect(out.text, out.name).not.toMatch(/from\s*"node:/);
      expect(out.text, out.name).not.toMatch(/\beval\(|new Function\(/);
    }
  });

  it('keeps the sweep disclosure, the shortcut sheet and the command bar out of the entry: each is a chunk of its own', async () => {
    const { entryInputs, chunkRoots } = await bundle();
    for (const file of ['case/BulkDismiss.tsx', 'shell/ShortcutSheet.tsx', 'shell/CommandBar.tsx']) {
      expect(entryInputs.filter((i) => i.endsWith(`src/${file}`)), `${file} is in the entry`).toEqual([]);
      expect(chunkRoots.filter((i) => i.endsWith(`src/${file}`)), `${file} has no chunk`).toHaveLength(1);
    }
  });

  it('keeps the settings and admin screens out of the entry: each is a chunk of its own', async () => {
    const { entryInputs, chunkRoots } = await bundle();
    const lazy = ['Terms', 'Blocked', 'Gaps', 'Audit', 'Guide', 'Actions', 'LadderSettings', 'ReportingSettings'];
    for (const name of lazy) {
      expect(entryInputs.filter((i) => i.endsWith(`src/screens/${name}.tsx`)), `${name} is in the entry`).toEqual([]);
      expect(chunkRoots.filter((i) => i.endsWith(`src/screens/${name}.tsx`)), `${name} has no chunk`).toHaveLength(1);
    }
    // And the screens every moderator opens first stay in it.
    for (const name of ['Overview', 'Reports', 'Report', 'Person', 'SimpleHome', 'Settings']) {
      expect(entryInputs.filter((i) => i.endsWith(`src/screens/${name}.tsx`)), `${name} is not in the entry`).toHaveLength(1);
    }
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
