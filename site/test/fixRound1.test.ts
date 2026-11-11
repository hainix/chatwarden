// @vitest-environment node
// Review fix round 1: CSS, headers, README and CI details that keep the page honest and the deploy safe.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const site = join(__dirname, '..');
const repo = join(site, '..');
const css = readFileSync(join(site, 'src', 'styles.css'), 'utf8');
const headers = readFileSync(join(site, 'public', '_headers'), 'utf8');
const readme = readFileSync(join(site, 'README.md'), 'utf8');
const ci = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
const siteJob = ci.slice(ci.indexOf('  site:'), ci.indexOf('  smoke:'));

describe('_headers', () => {
  it('has no interest-cohort (deprecated)', () => {
    expect(headers).not.toMatch(/interest-cohort/i);
    expect(headers).toMatch(/Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\)/);
  });
  it('has no Strict-Transport-Security rule: Pages preview URLs would inherit it (HSTS is a dashboard setting)', () => {
    expect(headers).not.toMatch(/^\s*Strict-Transport-Security:/im);
  });
});

describe('site/README.md', () => {
  it('tells the owner to enable HSTS in the Cloudflare dashboard, and why it is not in _headers', () => {
    expect(readme).toMatch(/HSTS/);
    expect(readme).toMatch(/dashboard/i);
    expect(readme).toMatch(/preview/i);
    expect(readme).toMatch(/_headers/);
  });
});

describe('overhang margin', () => {
  it('uses a clamp() that shrinks with the viewport instead of a fixed 72px', () => {
    const m = css.match(/\.steps\s*\{\s*margin-right:\s*([^;]+);/);
    expect(m?.[1]).toMatch(/^clamp\(/);
    expect(m?.[1]).toContain('72px'); // the cap is still 72px
    expect(m?.[1]).toMatch(/100vw/);
  });
});

describe('hero glow', () => {
  it('the hover glow only shows when motion is allowed (and a fine, hovering pointer)', () => {
    const m = css.match(/@media\s*([^{]*)\{\s*\.hero:hover::before/);
    expect(m?.[1]).toMatch(/hover:\s*hover/);
    expect(m?.[1]).toMatch(/pointer:\s*fine/);
    expect(m?.[1]).toMatch(/prefers-reduced-motion:\s*no-preference/);
  });
});

describe('CI site job', () => {
  it('caches the Playwright browsers keyed on the Playwright version', () => {
    expect(siteJob).toMatch(/uses:\s*actions\/cache@v4/);
    expect(siteJob).toMatch(/path:\s*~\/\.cache\/ms-playwright/);
    expect(siteJob).toMatch(/key:\s*[^\n]*playwright[^\n]*\$\{\{\s*steps\.[\w-]+\.outputs\.version\s*\}\}/);
    expect(siteJob).toMatch(/playwright\/package\.json/);
  });
  // The system packages come from apt, whose mirrors were unreachable from the runners on 2026-11-11 and failed every browser job.
  // The runner image already carries Chromium's libraries, so apt is best-effort; a truly missing library still fails the tests.
  it('installs the browser on a miss, and the system packages best-effort (an apt outage must not fail CI)', () => {
    expect(siteJob).toMatch(/run: npx playwright install chromium\r?\n/);
    expect(siteJob).not.toMatch(/install --with-deps/);
    expect(siteJob).toMatch(/run: npx playwright install-deps chromium \|\| echo "::warning::/);
    expect(siteJob).toMatch(/cache-hit/);
  });
  it('fails if the committed PNGs drift from a fresh render, after the build', () => {
    const buildAt = siteJob.indexOf('npm run build --workspace site');
    const guardAt = siteJob.indexOf('git diff --exit-code -- site/public/*.png');
    expect(buildAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(buildAt);
  });
  it('still runs the site tests and the build', () => {
    expect(siteJob).toMatch(/npm run test --workspace site/);
    expect(siteJob).toMatch(/node-version:\s*24/);
  });
});
