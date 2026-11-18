import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A text test of .github/workflows/ci.yml: the Windows leg of the init CLI must stay a small, targeted run.

const root = fileURLToPath(new URL('..', import.meta.url));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
/** The text of one job: from its `  name:` line to the next job (two-space indent) or the end. */
function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = /\n {2}[a-z][\w-]*:\n/.exec(rest.slice(rest.indexOf('\n') + 1));
  return next === null ? rest : rest.slice(0, rest.indexOf('\n') + 1 + next.index);
}

describe('.github/workflows/ci.yml', () => {
  it('has a cli-windows job on windows-latest running only the targeted CLI and testing tests', () => {
    const text = job('cli-windows');
    expect(text).toContain('runs-on: windows-latest');
    expect(text).toContain("node-version: '22.13'");
    expect(text).toContain('- run: npm ci');
    const runs = [...text.matchAll(/^\s+- run: (.*)$/gm)].map((m) => m[1]);
    expect(runs).toEqual(['npm ci', 'npx vitest run packages/http/test/cli- packages/store-memory/test/testing-']);
  });
  it('the Windows job never runs the whole suite, the build or the site', () => {
    const text = job('cli-windows');
    expect(text).not.toMatch(/npm test|npm run (test|build|check:pack|smoke)|vitest run\s*$/m);
    expect(text).not.toContain('smoke.mjs');
  });
  it('the Windows job has a timeout and read-only permissions inherited from the file', () => {
    expect(job('cli-windows')).toMatch(/timeout-minutes: \d+/);
    expect(ci).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(job('cli-windows')).not.toContain('permissions:');
  });
  it('the Windows job filters by substring: no glob character in the vitest command', () => {
    const run = [...job('cli-windows').matchAll(/^\s+- run: (npx vitest.*)$/gm)].map((m) => m[1] as string);
    expect(run).toHaveLength(1);
    expect(run[0]).not.toMatch(/[*?{}[\]]/);
    expect(run[0]).not.toContain('.test.ts');
  });
  it('has a service-csharp job: .NET 8, the C# sample built, the built service started with the bin, the sample run against it, then the conformance script; no secret in the file', () => {
    const text = job('service-csharp');
    expect(text).toContain('runs-on: ubuntu-latest');
    expect(text).toMatch(/timeout-minutes: \d+/);
    expect(text).toContain('actions/setup-dotnet@v4');
    expect(text).toMatch(/dotnet-version: '?8\.0\.x'?/);
    expect(text).toContain('npm ci');
    expect(text).toContain('npm run build');
    expect(text).toContain('dotnet build examples/service-csharp');
    expect(text).toContain('node packages/http/dist/src/cli/bin.js serve');
    expect(text).toMatch(/dotnet run --project examples\/service-csharp/);
    expect(text).toContain('node examples/service/conformance.mjs');
    // the keys are made on the runner, never written in the file
    expect(text).toContain('openssl rand -base64 32');
    expect(text).not.toMatch(/CHATWARDEN_(SECRET|SERVICE_KEYS): \S/);
    expect(text).not.toContain('secrets.');
    expect(text).not.toContain('permissions:');
  });
  it('the service-csharp job waits for /readyz before it runs anything and stops the service at the end', () => {
    const text = job('service-csharp');
    expect(text.indexOf('/readyz')).toBeGreaterThan(text.indexOf('serve'));
    expect(text.indexOf('dotnet run')).toBeGreaterThan(text.indexOf('/readyz'));
    expect(text).toMatch(/kill|trap/);
  });
  it('the existing jobs are still there: check, site, element-browser and smoke', () => {
    for (const name of ['check', 'site', 'element-browser', 'smoke', 'service-csharp']) expect(ci).toContain(`\n  ${name}:\n`);
  });
  it('the Windows job uses substring filters, not globs (PowerShell passes * literally and vitest filters by substring), that match test files that exist', () => {
    expect(readdirSync(join(root, 'packages/http/test')).filter((f) => /^cli-.*\.test\.ts$/.test(f)).length).toBeGreaterThan(10);
    expect(readdirSync(join(root, 'packages/store-memory/test')).filter((f) => /^testing-.*\.test\.ts$/.test(f)).length).toBeGreaterThan(3);
  });
});
