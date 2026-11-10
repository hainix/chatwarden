// Copies the root LICENSE into every package, so each tarball carries it. `node scripts/sync-license.mjs` writes the
// copies; `--check` only reports packages whose copy is missing or differs (exit 1). scripts/license.test.ts keeps
// the committed copies honest.
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package directories (those under packages/ that hold a package.json), as repo-relative posix paths. */
function packageDirs(root) {
  const base = join(root, 'packages');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'package.json')))
    .map((d) => `packages/${d.name}`)
    .sort();
}

/** Copies `<root>/LICENSE` to `<root>/packages/<dir>/LICENSE` for every package. Returns the directories written. */
export function syncLicense(root) {
  const dirs = packageDirs(root);
  for (const dir of dirs) copyFileSync(join(root, 'LICENSE'), join(root, dir, 'LICENSE'));
  return dirs;
}

/** One message per package whose LICENSE is missing or not byte-identical to the root LICENSE. */
export function licenseProblems(root) {
  const rootLicense = readFileSync(join(root, 'LICENSE'));
  const problems = [];
  for (const dir of packageDirs(root)) {
    const file = join(root, dir, 'LICENSE');
    if (!existsSync(file)) problems.push(`${dir}: LICENSE is missing (run node scripts/sync-license.mjs)`);
    else if (Buffer.compare(readFileSync(file), rootLicense) !== 0) {
      problems.push(`${dir}: LICENSE differs from the root LICENSE (run node scripts/sync-license.mjs)`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (process.argv.includes('--check')) {
    const problems = licenseProblems(root);
    for (const p of problems) console.error(p);
    process.exit(problems.length === 0 ? 0 : 1);
  } else {
    for (const dir of syncLicense(root)) console.log(`${dir}/LICENSE`);
  }
}
