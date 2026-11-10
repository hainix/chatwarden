// Builds the site once for every test file that scans or loads dist/, so parallel files never race on the output folder.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const siteDir = join(__dirname, '..');
const VITE_BIN = join(siteDir, '..', 'node_modules', 'vite', 'bin', 'vite.js');

export default function setup(): void {
  execFileSync(process.execPath, [VITE_BIN, 'build', '--logLevel', 'error'], {
    cwd: siteDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
}
