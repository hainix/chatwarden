// Keeps each package's exported `VERSION` constant (packages/<dir>/src/index.ts) equal to the version in its package.json.
// `changeset version` bumps package.json only, so the root `version` script runs this right after it:
//   "version": "changeset version && node scripts/sync-version.mjs && npm install --package-lock-only"
// `node scripts/sync-version.mjs` writes the constants; `--check` only reports the stale ones (exit 1).
// scripts/manifests.test.ts also fails CI when a constant and its manifest disagree. Unit-tested in sync-version.test.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_LINE = /^export const VERSION = '[^']*';/m;
// A semver version, with optional pre-release and build parts: nothing that could break out of a string literal.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Package directories (those under packages/ that hold a package.json), as repo-relative posix paths. */
function packageDirs(root) {
  const base = join(root, 'packages');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'package.json')))
    .map((d) => `packages/${d.name}`)
    .sort();
}

/** `source` with its `export const VERSION = '...';` line set to `version`. Throws when there is no such line or the version is not semver. */
export function setVersion(source, version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`setVersion: not a semver version: ${JSON.stringify(version)}`);
  if (!VERSION_LINE.test(source)) throw new Error("setVersion: no `export const VERSION = '...';` line");
  return source.replace(VERSION_LINE, `export const VERSION = '${version}';`);
}

/** Reads a package: its manifest version, the index path and the index source. Throws, naming the package, when it cannot. */
function readPackage(root, dir) {
  const { version } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const file = join(root, dir, 'src', 'index.ts');
  if (!existsSync(file)) throw new Error(`${dir}: src/index.ts is missing`);
  return { version, file, source: readFileSync(file, 'utf8') };
}

/** Rewrites the VERSION constant of every package from its package.json. Returns the directories it changed. */
export function syncVersions(root) {
  const changed = [];
  for (const dir of packageDirs(root)) {
    const { version, file, source } = readPackage(root, dir);
    let next;
    try {
      next = setVersion(source, version);
    } catch (err) {
      throw new Error(`${dir}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (next !== source) {
      writeFileSync(file, next);
      changed.push(dir);
    }
  }
  return changed;
}

/** One message per package whose VERSION constant is missing or differs from its manifest. Writes nothing. */
export function versionProblems(root) {
  const problems = [];
  for (const dir of packageDirs(root)) {
    let pkg;
    try {
      pkg = readPackage(root, dir);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const found = /^export const VERSION = '([^']*)';/m.exec(pkg.source)?.[1];
    if (found !== pkg.version) {
      problems.push(`${dir}: VERSION is ${JSON.stringify(found ?? null)} but package.json says ${pkg.version} (run node scripts/sync-version.mjs)`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    if (process.argv.includes('--check')) {
      const problems = versionProblems(root);
      for (const p of problems) console.error(p);
      process.exit(problems.length === 0 ? 0 : 1);
    } else {
      const changed = syncVersions(root);
      for (const dir of changed) console.log(`${dir}/src/index.ts`);
      if (changed.length === 0) console.log('VERSION constants already match the manifests');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
