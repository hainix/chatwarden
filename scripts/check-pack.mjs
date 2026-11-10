// Packs every published package with `npm pack --dry-run --json` and asserts what would ship.
// Run `npm run build` first (the root `check:pack` script does). The assertion logic is exported and unit-tested in
// scripts/check-pack.test.ts; the real run is at the bottom.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/hainix/chatwarden';
const REQUIRED_KEYWORDS = ['chatwarden', 'moderation', 'chat'];
const REQUIRED_FILES = ['dist/src', 'src', 'README.md', 'LICENSE'];

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
 * @param {{ pkg: Record<string, unknown>, files: string[], hasReadme: boolean }} input
 */
export function checkFileList({ pkg, files, hasReadme }) {
  const problems = [];
  const have = new Set(files);

  for (const name of ['package.json', 'LICENSE']) if (!have.has(name)) problems.push(`missing ${name}`);
  if (hasReadme && !have.has('README.md')) problems.push('missing README.md');

  for (const f of files) {
    for (const [re, what] of FORBIDDEN) if (re.test(f)) problems.push(`${what} would ship: ${f}`);
  }

  const dist = files.filter((f) => f.startsWith('dist/src/'));
  if (!dist.some((f) => f.endsWith('.js'))) problems.push('no dist/src/**/*.js (was the package built?)');
  if (!dist.some((f) => f.endsWith('.d.ts'))) problems.push('no dist/src/**/*.d.ts (was the package built?)');
  if (!files.some((f) => f.startsWith('src/') && f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    problems.push('no src/**/*.ts (source maps would not resolve)');
  }

  for (const f of dist) {
    const m = /^dist\/src\/(.*)\.js$/.exec(f);
    if (m) {
      const stem = m[1];
      for (const sibling of [`dist/src/${stem}.js.map`, `dist/src/${stem}.d.ts`, `dist/src/${stem}.d.ts.map`, `src/${stem}.ts`]) {
        if (!have.has(sibling)) problems.push(`missing ${sibling} (next to ${f})`);
      }
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
  if (pkg.sideEffects !== false) problems.push('sideEffects must be false');
  const prepack = pkg.scripts?.prepack;
  if (typeof prepack !== 'string' || !/\btsc -b\b/.test(prepack)) problems.push('scripts.prepack must run "tsc -b"');
  if (JSON.stringify(pkg.files) !== JSON.stringify(REQUIRED_FILES)) {
    problems.push(`files must be ${JSON.stringify(REQUIRED_FILES)}, got ${JSON.stringify(pkg.files)}`);
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
    const problems = [
      ...checkManifest(pkg, dir),
      ...checkFileList({ pkg, files, hasReadme: existsSync(join(base, dir, 'README.md')) }),
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
