// Builds the two scripts the package ships, with esbuild:
//   dist/hub-element.js  the self-registering one: one script tag and <chatwarden-hub> works
//   dist/index.js        the same code without the registration, for a bundler user who calls defineChatwardenHub() themselves
// Both are one self-contained ES module: React, react-dom, hub-react and the little of core it needs are inside, and the hub's CSS
// is inlined as a string. Nothing is imported at run time. `node build/build.mjs` writes them; `bundle()` returns them for the tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { esbuildPlugin } from './plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const packages = join(pkg, '..');

const options = {
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  jsx: 'automatic',
  legalComments: 'none',
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
  return out.contents;
}

/** Both scripts, in memory. */
export async function bundle() {
  const [standalone, module] = await Promise.all([one('standalone.ts'), one('index.ts')]);
  return { standalone, module };
}

async function main() {
  const { standalone, module } = await bundle();
  // `--out <dir>` builds somewhere else (the tests do, to try the scripts as shipped without touching dist).
  const at = process.argv.indexOf('--out');
  const dist = at > 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]) : join(pkg, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'hub-element.js'), standalone);
  writeFileSync(join(dist, 'index.js'), module);
  console.log(`hub-element.js ${standalone.byteLength} bytes, index.js ${module.byteLength} bytes, written to ${dist}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
