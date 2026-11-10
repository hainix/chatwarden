// @vitest-environment node
// Loads the BUILT page in a real browser under the real `_headers` Content-Security-Policy, and runs axe on it.
// Needs Chromium: `npx playwright install chromium` (CI does this).
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDist } from './helpers/serveDist';

let browser: Browser;
let server: Awaited<ReturnType<typeof serveDist>>;

beforeAll(async () => {
  server = await serveDist();
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Records every CSP violation (browser event) and every console error/warning on the page. */
async function watch(ctx: BrowserContext): Promise<{ page: Page; violations: string[]; consoleProblems: string[]; failed: string[] }> {
  const page = await ctx.newPage();
  const violations: string[] = [];
  const consoleProblems: string[] = [];
  const failed: string[] = [];
  await page.exposeFunction('__cspViolation', (m: string) => violations.push(m));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { __cspViolation: (m: string) => void }).__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI} ${e.sourceFile ?? ''}`);
    });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleProblems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  return { page, violations, consoleProblems, failed };
}

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
}

describe('the built page under the _headers CSP', () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    it(`loads and runs the demo with zero CSP violations and no console errors (${name})`, async () => {
      const ctx = await browser.newContext({ viewport });
      const { page, violations, consoleProblems, failed } = await watch(ctx);
      const res = await page.goto(server.url, { waitUntil: 'networkidle' });
      // Control: the policy really is applied to the page we are testing.
      const csp = res?.headers()['content-security-policy'] ?? '';
      expect(csp).toContain("default-src 'self'");
      await scrollThrough(page);
      // The lazy demo chunk loaded and rendered under the policy.
      await page.getByText("uninstall the game, you're hopeless").waitFor({ timeout: 15_000 });
      // Use it: type a line, send it (exercises state, inline-style-free rendering and the live region).
      await page.getByLabel(/chat message/i).fill('hello there');
      await page.keyboard.press('Enter');
      await page.getByText('hello there').first().waitFor();
      // The theme toggle works (the bootstrap script is external, so it must not be blocked).
      await page.getByRole('button', { name: /light|dark/i }).first().click();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeTruthy();
      expect(violations).toEqual([]);
      expect(consoleProblems.filter((m) => /content security policy|refused to/i.test(m))).toEqual([]);
      expect(consoleProblems).toEqual([]);
      expect(failed).toEqual([]);
      await ctx.close();
    }, 60_000);
  }

  it('control: a page with an inline script IS blocked by this policy (the test can see violations)', async () => {
    const ctx = await browser.newContext();
    const { page, violations } = await watch(ctx);
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__x = 1';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(200);
    expect(violations.some((v) => v.startsWith('script-src'))).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
    await ctx.close();
  });

  it('the theme bootstrap applies a stored light choice before first paint', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('cw-theme', 'light'));
    const page = await ctx.newPage();
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await ctx.close();
  });

  it('serves hashed assets with an immutable cache header', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const seen: Array<{ url: string; cc: string }> = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname.startsWith('/assets/')) seen.push({ url: r.url(), cc: r.headers()['cache-control'] ?? '' });
    });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) expect(s.cc, s.url).toContain('immutable');
    await ctx.close();
  });
});

describe('accessibility (axe) on the built page', () => {
  for (const scheme of ['dark', 'light'] as const) {
    for (const [name, viewport] of [
      ['phone', { width: 390, height: 844 }],
      ['desktop', { width: 1440, height: 900 }],
    ] as const) {
      it(`has no serious or critical violations (${scheme}, ${name})`, async () => {
        const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await page.goto(server.url, { waitUntil: 'networkidle' });
        await scrollThrough(page);
        await page.getByText("uninstall the game, you're hopeless").waitFor({ timeout: 15_000 });
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
        const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
        // Control: axe really ran (it has checked a meaningful number of rules).
        expect(results.passes.length).toBeGreaterThan(20);
        await ctx.close();
      }, 60_000);
    }
  }
});

describe('layout on the built page', () => {
  // The README snippets stay verbatim, so the layout gives the code room instead of cutting long lines.
  for (const width of [1024, 1200, 1280, 1440, 1920]) {
    it(`the "Add it in 3 steps" code blocks do not clip a line at ${width}px`, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(server.url, { waitUntil: 'networkidle' });
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('#add-it pre')]
          .map((pre, i) => ({ i, scroll: pre.scrollWidth, client: pre.clientWidth }))
          .filter((m) => m.scroll > m.client + 1),
      );
      expect(clipped).toEqual([]);
      await ctx.close();
    });
  }
  for (const width of [360, 390, 768, 1024, 1440]) {
    it(`has no horizontal page scroll at ${width}px`, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await scrollThrough(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await ctx.close();
    });
  }
  it('the hero headline breaks after "chat." on a phone and on a desktop', async () => {
    for (const width of [360, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(server.url, { waitUntil: 'networkidle' });
      // Each sentence is its own block, so the second starts below the first (never mid-line after "chat.").
      const boxes = await page.evaluate(() =>
        [...document.querySelectorAll('#hero-title .h1-line')].map((e) => {
          const r = e.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        }),
      );
      expect(boxes).toHaveLength(2);
      expect((boxes[1] as { top: number }).top).toBeGreaterThanOrEqual((boxes[0] as { bottom: number }).bottom - 1);
      await ctx.close();
    }
  });
  it('the install pill never breaks a package name across lines on a phone', async () => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(server.url, { waitUntil: 'networkidle' });
    const split = await page.evaluate(() =>
      [...document.querySelectorAll('.cmd .nw')].filter((e) => e.getClientRects().length > 1).map((e) => e.textContent),
    );
    expect(split).toEqual([]);
    await ctx.close();
  });
  it('the open-source badges read as pills (readable text on a visible surface)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await scrollThrough(page);
    await page.getByText("uninstall the game, you're hopeless").waitFor({ timeout: 15_000 }); // demo CSS is loaded too
    const badge = await page.evaluate(() => {
      const el = document.querySelector('.open-badge') as HTMLElement;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, h: el.getBoundingClientRect().height };
    });
    expect(badge.bg).not.toBe('rgb(255, 61, 143)'); // the demo's magenta count chip
    expect(badge.h).toBeGreaterThan(30);
    await ctx.close();
  });
});
