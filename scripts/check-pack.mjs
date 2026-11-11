// Packs every published package with `npm pack --dry-run --json` and asserts what would ship.
// Run `npm run build` first (the root `check:pack` script does). The assertion logic is exported and unit-tested in
// scripts/check-pack.test.ts; the real run is at the bottom.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/hainix/chatwarden';
const REQUIRED_KEYWORDS = ['chatwarden', 'moderation', 'chat'];
/**
 * Packages whose code is a bundle (built by esbuild in `prepack`), not tsc output: `dist/src` holds their types only, and the scripts
 * are the files an adopter loads. `sideEffects` lists the one script that registers itself (a bundler must not drop its bare import).
 */
export const BUNDLED = { 'hub-element': { scripts: ['dist/hub-element.js', 'dist/index.js'], sideEffects: ['./dist/hub-element.js'] } };
/** The directory name of a package: `@chatwarden/hub-element` is `hub-element`. */
const dirOf = (pkg) => String(pkg.name ?? '').replace(/^@chatwarden\//, '');
/** Static assets a package ships beside its source, listed after `src` (hub-react: the optional self-hosted font and its licence; a bundled package: its scripts). */
const STATIC_ASSETS = { 'hub-react': ['font.css', 'fonts'], ...Object.fromEntries(Object.entries(BUNDLED).map(([dir, b]) => [dir, b.scripts])) };
/** The `files` a package must declare. */
const requiredFilesFor = (dir) => ['dist/src', 'src', ...(STATIC_ASSETS[dir] ?? []), 'README.md', 'LICENSE'];

/** Every file path an `exports`, `main`, `types` or `typesVersions` entry points at, without the leading `./`. */
export function exportTargets(pkg) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string') out.add(v.replace(/^\.\//, ''));
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  add(pkg.main);
  add(pkg.types);
  add(pkg.exports);
  add(pkg.typesVersions);
  return [...out];
}

const FORBIDDEN = [
  [/(^|\/)test\//, 'test directory'],
  [/\.(test|spec)\.[^/]*$/, 'test file'],
  [/\.tsbuildinfo$/, 'tsbuildinfo'],
];

/**
 * Problems with the list of files a tarball would hold (empty array = good).
 * README.md is required for every published package.
 * @param {{ pkg: Record<string, unknown>, files: string[] }} input
 */
export function checkFileList({ pkg, files }) {
  const problems = [];
  const have = new Set(files);

  for (const name of ['package.json', 'LICENSE', 'README.md']) if (!have.has(name)) problems.push(`missing ${name}`);

  for (const f of files) {
    for (const [re, what] of FORBIDDEN) if (re.test(f)) problems.push(`${what} would ship: ${f}`);
  }

  const dist = files.filter((f) => f.startsWith('dist/src/'));
  const bundled = BUNDLED[dirOf(pkg)];
  if (bundled === undefined && !dist.some((f) => f.endsWith('.js'))) problems.push('no dist/src/**/*.js (was the package built?)');
  if (!dist.some((f) => f.endsWith('.d.ts'))) problems.push('no dist/src/**/*.d.ts (was the package built?)');
  if (!files.some((f) => f.startsWith('src/') && /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))) {
    problems.push('no src/**/*.ts (source maps would not resolve)');
  }

  if (bundled !== undefined) {
    // The code is the bundle; dist/src is the types. Compiled JavaScript there would be a second, unbundled copy that imports React.
    for (const script of bundled.scripts) if (!have.has(script)) problems.push(`missing ${script} (was the package built?)`);
    for (const f of dist) {
      if (f.endsWith('.js')) problems.push(`${f} would ship, but ${dirOf(pkg)} ships its code as a bundle (dist/*.js), not as dist/src/**/*.js`);
      const m = /^dist\/src\/(.*)\.d\.ts$/.exec(f);
      if (m && !have.has(`dist/src/${m[1]}.d.ts.map`)) problems.push(`missing dist/src/${m[1]}.d.ts.map (next to ${f})`);
      if (m && !have.has(`src/${m[1]}.ts`) && !have.has(`src/${m[1]}.tsx`)) problems.push(`missing src/${m[1]}.ts (next to ${f})`);
    }
  }

  for (const f of bundled === undefined ? dist : []) {
    const m = /^dist\/src\/(.*)\.js$/.exec(f);
    if (m) {
      const stem = m[1];
      for (const sibling of [`dist/src/${stem}.js.map`, `dist/src/${stem}.d.ts`, `dist/src/${stem}.d.ts.map`]) {
        if (!have.has(sibling)) problems.push(`missing ${sibling} (next to ${f})`);
      }
      // The source is a .ts file, or a .tsx file in a React package.
      if (!have.has(`src/${stem}.ts`) && !have.has(`src/${stem}.tsx`)) problems.push(`missing src/${stem}.ts (next to ${f})`);
    }
  }

  for (const target of exportTargets(pkg)) {
    if (!have.has(target)) problems.push(`export target is not in the tarball: ${target}`);
  }
  return problems;
}

/**
 * Problems with the publish-relevant parts of a package.json (empty array = good).
 * @param {Record<string, any>} pkg
 * @param {string} dir the package's directory name under packages/
 */
export function checkManifest(pkg, dir) {
  const problems = [];
  if (pkg.license !== 'Apache-2.0') problems.push(`license must be Apache-2.0, got ${JSON.stringify(pkg.license)}`);
  // false, or a list of stylesheets only: importing a CSS file is a side effect a bundler must keep, nothing else may be one.
  // (A bundled package that registers itself on import lists that one script, exactly.)
  const sideEffectsOk =
    BUNDLED[dir] !== undefined
      ? JSON.stringify(pkg.sideEffects) === JSON.stringify(BUNDLED[dir].sideEffects)
      : pkg.sideEffects === false ||
    (Array.isArray(pkg.sideEffects) && pkg.sideEffects.length > 0 && pkg.sideEffects.every((f) => typeof f === 'string' && /\.css$/.test(f)));
  if (!sideEffectsOk) {
    problems.push(
      BUNDLED[dir] === undefined
        ? 'sideEffects must be false, or a list of .css files only'
        : `sideEffects must be exactly ${JSON.stringify(BUNDLED[dir].sideEffects)} (the script that registers itself), got ${JSON.stringify(pkg.sideEffects)}`,
    );
  }
  const prepack = pkg.scripts?.prepack;
  if (typeof prepack !== 'string' || !/\btsc -b\b/.test(prepack)) problems.push('scripts.prepack must run "tsc -b"');
  if (JSON.stringify(pkg.files) !== JSON.stringify(requiredFilesFor(dir))) {
    problems.push(`files must be ${JSON.stringify(requiredFilesFor(dir))}, got ${JSON.stringify(pkg.files)}`);
  }
  const homepage = `${REPO}/tree/main/packages/${dir}#readme`;
  if (pkg.homepage !== homepage) problems.push(`homepage must be ${homepage}, got ${JSON.stringify(pkg.homepage)}`);
  if (pkg.bugs?.url !== `${REPO}/issues`) problems.push(`bugs.url must be ${REPO}/issues`);
  if (pkg.repository?.directory !== `packages/${dir}`) problems.push(`repository.directory must be packages/${dir}`);
  for (const kw of REQUIRED_KEYWORDS) {
    if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes(kw)) problems.push(`keywords must include "${kw}"`);
  }
  return problems;
}

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]));

/** The package name of a bare specifier: `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** Every module specifier a JavaScript source imports: static imports and re-exports, side-effect imports, `import()` and `require()`. Comments are ignored. */
function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const specs = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^'";]*?\sfrom\s*(['"])([^'"\n]+)\1/g, // import x from 'y', export * from 'y'
    /(?:^|[\s;}])import\s*(['"])([^'"\n]+)\1/g, // import 'y'
    /(?:^|[^\w$.])(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, // import('y'), require('y')
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) specs.push(m[2]);
  return specs;
}

/**
 * The npm packages a JavaScript source imports: static imports and re-exports, side-effect imports, `import()` and
 * `require()`. Relative and absolute paths and Node builtins (`node:x` or bare `fs`) are left out. Comments are ignored.
 * @param {string} source
 * @returns {string[]} package names, each once
 */
export function bareImports(source) {
  const found = new Set();
  for (const spec of importSpecifiers(source)) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (spec.startsWith('node:')) continue;
    const name = packageOf(spec);
    if (BUILTINS.has(name)) continue;
    found.add(name);
  }
  return [...found];
}

/** The packages that must run in a browser: their compiled code may import no Node builtin, not even `node:crypto`. */
export const BROWSER_SAFE = new Set(['@chatwarden/core', '@chatwarden/hub-element', '@chatwarden/hub-react', '@chatwarden/player-react', '@chatwarden/store-memory']);

/**
 * The Node builtins a JavaScript source imports (`node:fs`, `crypto`, `node:fs/promises` -> `fs`), one entry per import, in
 * every import form `bareImports` reads. A runtime lookup such as `process.getBuiltinModule('node:crypto')` is not an import.
 * @param {string} source
 * @returns {string[]}
 */
export function nodeImports(source) {
  const found = [];
  for (const spec of importSpecifiers(source)) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    const name = spec.replace(/^node:/, '').split('/')[0];
    if (spec.startsWith('node:') || BUILTINS.has(name)) found.push(name);
  }
  return found;
}

/** A JavaScript file a package ships: tsc output under `dist/src`, or a bundled package's script in `dist`. */
const isShippedJs = (path) => /^dist\/src\/.*\.js$/.test(path) || /^dist\/[^/]+\.js$/.test(path);

/**
 * One message per (file, module) where a browser-safe package's shipped `.js` file (`dist/src/**`, or a bundle in `dist`) imports a Node builtin.
 * Packages outside {@link BROWSER_SAFE} are not checked.
 * @param {{ pkg: Record<string, any>, files: Array<{ path: string, source: string }> }} input
 */
export function nodeImportProblems({ pkg, files }) {
  if (!BROWSER_SAFE.has(pkg.name)) return [];
  const problems = [];
  for (const { path, source } of files) {
    if (!isShippedJs(path)) continue;
    for (const name of new Set(nodeImports(source))) {
      problems.push(`${path} imports the Node builtin "node:${name}", but ${pkg.name} must run in a browser`);
    }
  }
  return problems;
}

/**
 * One message per (file, package) where a shipped `.js` file (`dist/src/**`, or a bundle in `dist`) imports a package that an installer would not
 * have: it must be a Node builtin, the package itself, or in dependencies or peerDependencies. devDependencies do not count.
 * @param {{ pkg: Record<string, any>, files: Array<{ path: string, source: string }> }} input
 */
export function undeclaredImports({ pkg, files }) {
  const declared = new Set([pkg.name, ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const problems = [];
  for (const { path, source } of files) {
    if (!isShippedJs(path)) continue;
    for (const name of bareImports(source)) {
      if (!declared.has(name)) {
        problems.push(`${path} imports "${name}", which is not in dependencies or peerDependencies (a consumer would not have it)`);
      }
    }
  }
  return problems;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const base = join(root, 'packages');
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();

  let failed = false;
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(base, dir, 'package.json'), 'utf8'));
    if (pkg.private === true) continue;
    // --ignore-scripts: the build ran before this script, and a prepack's output would corrupt the JSON on stdout.
    const raw = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts', '--workspace', pkg.name],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
    );
    const files = JSON.parse(raw)[0].files.map((f) => f.path.replaceAll('\\', '/'));
    const sources = files
      .filter((f) => isShippedJs(f))
      .map((f) => ({ path: f, source: readFileSync(join(base, dir, f), 'utf8') }));
    const problems = [
      ...checkManifest(pkg, dir),
      ...checkFileList({ pkg, files }),
      ...undeclaredImports({ pkg, files: sources }),
      ...nodeImportProblems({ pkg, files: sources }),
    ];
    if (problems.length === 0) console.log(`ok   ${pkg.name} (${files.length} files)`);
    else {
      failed = true;
      console.error(`FAIL ${pkg.name}`);
      for (const p of problems) console.error(`  - ${p}`);
    }
  }
  if (dirs.length === 0) {
    console.error('no packages found');
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
