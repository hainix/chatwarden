#!/usr/bin/env node
// The local D1 smoke (opt-in): runs the service's SQL on D1's own engine through wrangler's local mode, with no Cloudflare account. It needs workerd
// (installed with the workspace) and takes about a minute. See ../README.md, "The local D1 smoke".
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const run = spawnSync(process.execPath, [vitest, 'run', 'services/corpus/test/d1-local.test.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CORPUS_D1_LOCAL: '1' },
});
process.exitCode = run.status ?? 1;
