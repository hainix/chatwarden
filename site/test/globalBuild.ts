// Builds the site once for every test file that scans or loads dist/, so parallel files never race on the output folder.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const siteDir = join(__dirname, '..');
const VITE_BIN = join(siteDir, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const TSC_BIN = join(siteDir, '..', 'node_modules', 'typescript', 'bin', 'tsc');

export default function setup(): void {
  // The demo imports the kit packages through their package exports, which point at their built dist. `tsc -b` is a no-op
  // when it is up to date, and builds it when a fresh checkout runs the tests without the npm `pretest` hook.
  execFileSync(process.execPath, [TSC_BIN, '-b', '..'], { cwd: siteDir, stdio: 'inherit' });
  execFileSync(process.execPath, [VITE_BIN, 'build', '--logLevel', 'error'], {
    cwd: siteDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
}
