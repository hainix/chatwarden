// Builds the two scripts the package ships, with esbuild:
//   dist/hub-element.js  the self-registering one: one script tag and <chatwarden-hub> works
//   dist/index.js        the same code without the registration, for a bundler user who calls defineChatwardenHub() themselves
//   dist/THIRD_PARTY_NOTICES.txt  the licence of every third-party package inside them, listed from esbuild's metafile
// Both are one self-contained ES module: React, react-dom, hub-react and the little of core it needs are inside, and the hub's CSS
// is inlined as a string. Nothing is imported at run time. `node build/build.mjs` writes them; `bundle()` returns them for the tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NOTICES_FILE, renderNotices, thirdPartyPackages } from './notices.mjs';
import { esbuildPlugin } from './plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const packages = join(pkg, '..');
const repo = join(packages, '..');

const options = {
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  jsx: 'automatic',
  // 'eof' keeps the licence banners of the bundled third-party code (React's MIT notice) at the end of each script.
  legalComments: 'eof',
  metafile: true,
  absWorkingDir: repo,
  logLevel: 'silent',
  // The workspace packages come from their TypeScript source, so the build needs no earlier `tsc -b`.
  alias: {
    '@chatwarden/hub-react': join(packages, 'hub-react', 'src', 'index.ts'),
    '@chatwarden/core': join(packages, 'core', 'src', 'index.ts'),
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [esbuildPlugin()],
};

async function one(entry) {
  const result = await build({ ...options, entryPoints: [join(pkg, 'src', entry)] });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error(`esbuild produced nothing for ${entry}`);
  return { contents: out.contents, metafile: result.metafile };
}

/** Both scripts and the third-party notices, in memory. `metafiles` are esbuild's, one per script. */
export async function bundle() {
  const [standalone, module] = await Promise.all([one('standalone.ts'), one('index.ts')]);
  const metafiles = [standalone.metafile, module.metafile];
  const notices = renderNotices(thirdPartyPackages(metafiles, repo));
  return { standalone: standalone.contents, module: module.contents, notices, metafiles };
}

async function main() {
  const { standalone, module, notices } = await bundle();
  // `--out <dir>` builds somewhere else (the tests do, to try the scripts as shipped without touching dist).
  const at = process.argv.indexOf('--out');
  const dist = at > 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]) : join(pkg, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'hub-element.js'), standalone);
  writeFileSync(join(dist, 'index.js'), module);
  writeFileSync(join(dist, NOTICES_FILE), notices);
  console.log(`hub-element.js ${standalone.byteLength} bytes, index.js ${module.byteLength} bytes, written to ${dist}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
