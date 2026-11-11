import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { BUNDLED } from './check-pack.mjs';

// A bundled package (hub-element) ships scripts that only its own build writes: `tsc -b` emits declarations and no JavaScript.
// check:pack runs `npm pack --ignore-scripts`, so prepack does not rescue it. These checks pin that the root build produces the bundle
// (so check:pack passes on a clean checkout) and that CI and the release workflow run the element's browser smoke.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const rootPkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

describe('the root build produces every bundled package\'s scripts', () => {
  it('runs tsc -b first, then each bundled package\'s bundle build', () => {
    const build = rootPkg.scripts.build as string;
    expect(build.startsWith('tsc -b')).toBe(true);
    for (const dir of Object.keys(BUNDLED as Record<string, unknown>)) {
      const step = build.indexOf(`packages/${dir}/build/build.mjs`);
      expect(step, `the root build must run packages/${dir}/build/build.mjs`).toBeGreaterThan(build.indexOf('tsc -b'));
    }
  });

  it('check:pack builds first, so a clean checkout has the bundle', () => {
    expect(rootPkg.scripts['check:pack']).toMatch(/^npm run build && /);
  });

  it('the bundle build the root runs writes the scripts the BUNDLED table requires', () => {
    for (const [dir, b] of Object.entries(BUNDLED as Record<string, { scripts: string[] }>)) {
      const source = read('packages', dir, 'build', 'build.mjs');
      for (const script of b.scripts) expect(source, script).toContain(`'${script.replace(/^dist\//, '')}'`);
    }
  });
});

describe('the element\'s browser smoke runs in CI and in the release checks', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const release = read('.github', 'workflows', 'release.yml');

  it('ci.yml has a job that installs Chromium (cached by Playwright version) and runs the smoke with CW_REQUIRE_BROWSER=1', () => {
    const at = ci.indexOf('npm run smoke:browser --workspace @chatwarden/hub-element');
    expect(at, 'the smoke command').toBeGreaterThan(-1);
    const job = ci.slice(ci.lastIndexOf('\n  ', ci.lastIndexOf('runs-on', at)) - 200, at + 200);
    expect(job).toContain('CW_REQUIRE_BROWSER');
    // apt is best-effort (an apt mirror outage on 2026-11-11 failed every browser job); the image has Chromium's libraries.
    expect(ci.slice(0, at)).toContain('run: npx playwright install chromium\n');
    expect(ci.slice(0, at)).toContain('npx playwright install-deps chromium || echo "::warning::');
    expect(ci).not.toContain('install --with-deps');
    expect(ci.slice(0, at)).toContain('actions/cache@v4');
    expect(ci).toMatch(/CW_REQUIRE_BROWSER: '?1'?/);
  });

  it('it is a job of its own, not a step of the package matrix', () => {
    expect(ci).toMatch(/\n {2}element-browser:\n {4}name: /);
  });

  it('release.yml runs it after the tests, before check:pack', () => {
    const smoke = release.indexOf('npm run smoke:browser --workspace @chatwarden/hub-element');
    expect(smoke).toBeGreaterThan(release.indexOf('npm test'));
    expect(smoke).toBeLessThan(release.indexOf('npm run check:pack'));
    expect(release).toContain('run: npx playwright install chromium\n');
    expect(release).toContain('npx playwright install-deps chromium || echo "::warning::');
    expect(release).not.toContain('install --with-deps');
    expect(release).toMatch(/CW_REQUIRE_BROWSER: '?1'?/);
  });

  it('the package script is the one the workflows run', () => {
    const pkg = JSON.parse(read('packages', 'hub-element', 'package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['smoke:browser']).toContain('browser.smoke.test.ts');
  });

  // `npm run --workspace` runs the script from packages/hub-element, where the root vitest.config.ts (which names the
  // `hub-element` project) is not found: CI failed with "No projects matched the filter". The script must run from the root.
  it('the package script runs vitest from the repository root, where the projects are defined', () => {
    const pkg = JSON.parse(read('packages', 'hub-element', 'package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['smoke:browser']).toMatch(/^cd \.\.\/\.\. && vitest run --project hub-element /);
  });
});
