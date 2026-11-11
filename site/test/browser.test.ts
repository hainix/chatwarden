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

/** Records every CSP violation (browser event), every console error/warning and every request that leaves the page's origin. */
async function watch(ctx: BrowserContext): Promise<{ page: Page; violations: string[]; consoleProblems: string[]; failed: string[]; foreign: string[] }> {
  const page = await ctx.newPage();
  const violations: string[] = [];
  const consoleProblems: string[] = [];
  const failed: string[] = [];
  const foreign: string[] = [];
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
  page.on('request', (r) => {
    if (!r.url().startsWith(server.url) && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  return { page, violations, consoleProblems, failed, foreign };
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

const RUDE = "uninstall the game, you're hopeless";
const demoOf = (page: Page) => page.getByRole('group', { name: /chatwarden interactive demo/i });

/** Loads the page, wakes the lazy demo and waits for the chat and the hub. */
async function openDemo(page: Page) {
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await scrollThrough(page);
  await page.getByText(RUDE).waitFor({ timeout: 15_000 });
  // (on one pane at a time the hub's pane is hidden, so it is found with includeHidden)
  await demoOf(page).getByRole('navigation', { name: /moderator hub sections/i, includeHidden: true }).waitFor({ state: 'attached', timeout: 15_000 });
}

/** One tap: Report on Bo's rude line, Report, Close. */
async function reportBo(page: Page) {
  await demoOf(page).getByRole('button', { name: /report bo's line: uninstall/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Report', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Report sent' }).waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
}

/** The case against Bo open in the hub, with a rule picked (a one-tap report names none) and the ladder's suggestion showing. */
async function openCaseInHub(page: Page) {
  const demo = demoOf(page);
  const onePane = (page.viewportSize()?.width ?? 1440) < 1152;
  if (onePane) await demo.getByRole('button', { name: /^moderator/i }).click();
  await demo.getByRole('button', { name: /^\d+ new cases?$/ }).click({ timeout: 15_000 });
  await demo.getByRole('link', { name: /^Bo/ }).click();
  await demo.getByRole('combobox', { name: /which rule does this break/i }).selectOption('2');
  await demo.getByRole('button', { name: /^Restrict chat, 24 hours/ }).waitFor();
}

describe('the built page under the _headers CSP', () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    it(`loads and runs the demo, the hub and the player dialogs with zero CSP violations and no console errors (${name})`, async () => {
      const ctx = await browser.newContext({ viewport });
      const { page, violations, consoleProblems, failed, foreign } = await watch(ctx);
      const res = await page.goto(server.url, { waitUntil: 'networkidle' });
      // Control: the policy really is applied to the page we are testing.
      const csp = res?.headers()['content-security-policy'] ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("style-src 'self'");
      await scrollThrough(page);
      // The lazy demo chunk loaded and rendered under the policy.
      await page.getByText(RUDE).waitFor({ timeout: 15_000 });
      await demoOf(page).getByRole('navigation', { name: /moderator hub sections/i, includeHidden: true }).waitFor({ state: 'attached' });
      // The hub's stylesheet and the player stylesheet really are applied (not just loaded): a rule of each is in force.
      const sheets = await page.evaluate(() => {
        const selectors = new Set<string>();
        for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) if (rule instanceof CSSStyleRule) selectors.add(rule.selectorText);
        const hub = document.querySelector('.cw-hub') as HTMLElement;
        return {
          hubRules: [...selectors].filter((s) => s.includes('.cw-hub')).length,
          playerRules: [...selectors].filter((s) => s.includes('.cw-player')).length,
          hubDisplay: getComputedStyle(hub).display,
          hubPosition: getComputedStyle(hub).position,
        };
      });
      expect(sheets.hubRules).toBeGreaterThan(100);
      expect(sheets.playerRules).toBeGreaterThan(20);
      expect(sheets.hubDisplay).toBe('flex'); // .cw-hub { display: flex }
      expect(sheets.hubPosition).toBe('relative'); // .cw-hub { position: relative }
      // Use it: type a line, send it (exercises state, inline-style-free rendering and the live region).
      await page.getByLabel(/chat message/i).fill('hello there');
      await page.keyboard.press('Enter');
      await page.getByText('hello there').first().waitFor();
      // Report with one tap: player-react's dialog opens under the policy, and its stylesheet makes it a fixed overlay.
      await demoOf(page).getByRole('button', { name: /report bo's line: uninstall/i }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.cw-scrim') as HTMLElement).position)).toBe('fixed');
      await dialog.getByRole('button', { name: 'Report', exact: true }).click();
      await dialog.getByRole('heading', { name: 'Report sent' }).waitFor();
      await dialog.getByRole('button', { name: 'Close' }).click();
      // The hub shows the case; the decision is applied; the player's notice opens.
      await openCaseInHub(page);
      await demoOf(page).getByRole('button', { name: /^Send a warning/ }).click();
      await page.getByRole('button', { name: /see what bo sees/i }).waitFor({ timeout: 15_000 });
      await page.getByRole('button', { name: /see what bo sees/i }).click();
      await page.getByRole('dialog').getByRole('button', { name: /acknowledge/i }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      // The theme toggle works (the bootstrap script is external, so it must not be blocked).
      await page.getByRole('button', { name: /light|dark/i }).first().click();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeTruthy();
      expect(violations).toEqual([]);
      expect(consoleProblems.filter((m) => /content security policy|refused to/i.test(m))).toEqual([]);
      expect(consoleProblems).toEqual([]);
      expect(failed).toEqual([]);
      // Nothing left the page: not the hub, not the player components, and not the CDN address that the sample code shows as text.
      expect(foreign).toEqual([]);
      await ctx.close();
    }, 90_000);
  }

  it('the built demo refuses the invented word: the matcher in the bundle works without obscenity’s word list', async () => {
    // Vitest runs the real, unstripped obscenity. Only the built bundle has its word list cut out, so this is the test that
    // proves the cut matcher still blocks: the visitor's word, and Bo's opening line.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, violations, consoleProblems } = await watch(ctx);
    await openDemo(page);
    // 1. "try a blocked word" -> Send: the REFUSED stamp and the rule, in the chat
    // (the hero above has a decorative REFUSED! mock of its own, so every query is inside the demo)
    const demo = demoOf(page);
    await demo.getByRole('button', { name: /try a blocked word/i }).click();
    await demo.getByRole('button', { name: /^send$/i }).click();
    await demo.getByText('Refused!').waitFor();
    await demo.getByText('Blocked by Community Rule 1. Only you see this.').waitFor();
    expect(await demo.locator('.msg-refused').count()).toBe(1);
    // 2. Bo's opening line was refused too: staff see it, in the evidence of a report, hidden until shown, never as the word
    await reportBo(page);
    await demo.getByRole('button', { name: /^\d+ new cases?$/ }).click({ timeout: 15_000 });
    await demo.getByRole('link', { name: /^Bo/ }).click();
    await demo.getByRole('button', { name: /show the whole chat/i }).click();
    const hidden = demo.locator('.cw-sline', { hasText: 'Blocked words, hidden' });
    await hidden.first().waitFor();
    expect(await hidden.count()).toBe(2); // Bo's opening line and the visitor's
    expect(await demo.locator('.cw-sline').count()).toBeGreaterThanOrEqual(5);
    // a delivered line is NOT marked blocked (the matcher does not over-block)
    expect(await demo.locator('.cw-sline', { hasText: "ez, you're trash lol" }).count()).toBe(1);
    expect(await demo.locator('.cw-sline', { hasText: "ez, you're trash lol" }).filter({ hasText: 'Blocked words, hidden' }).count()).toBe(0);
    // "Show" reveals the word to staff only
    await hidden.first().getByRole('button', { name: /^show/i }).click();
    await demo.getByText(/zorbak/i).first().waitFor();
    expect(violations).toEqual([]);
    expect(consoleProblems).toEqual([]); // no pageerror either: nothing in the cut matcher threw
    await ctx.close();
  }, 60_000);

  it('the hub’s keys never fire while typing in the chat box, in a real browser', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const { page } = await watch(ctx);
    await openDemo(page);
    await reportBo(page);
    const demo = demoOf(page);
    await demo.getByRole('button', { name: /^\d+ new cases?$/ }).waitFor({ timeout: 15_000 });
    await page.getByLabel(/chat message/i).click();
    await page.keyboard.type('njk n?');
    expect(await page.getByLabel(/chat message/i).inputValue()).toBe('njk n?');
    expect(await demo.getByRole('region', { name: /case against/i }).count()).toBe(0);
    expect(await page.getByRole('dialog').count()).toBe(0); // "?" did not open the hub's shortcuts window either
    await ctx.close();
  });

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

  it('control: an inline style IS blocked by this policy, so the hub and player CSS above really came from files', async () => {
    const ctx = await browser.newContext();
    const { page, violations } = await watch(ctx);
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = 'body { outline: 5px solid red }';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(200);
    expect(violations.some((v) => v.startsWith('style-src'))).toBe(true);
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

describe('the first load does not fetch the demo (the hub and the player load lazily)', () => {
  it('at the top of the page on a phone, no demo, hub or player file is requested', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const assets: string[] = [];
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/assets/')) assets.push(p);
    });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    expect(assets.some((p) => /\/Demo-/.test(p))).toBe(false);
    await ctx.close();
  });
  it('scrolling the demo into view fetches it', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const assets: string[] = [];
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/assets/')) assets.push(p);
    });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.getByText(RUDE).waitFor({ timeout: 15_000 });
    expect(assets.some((p) => /\/Demo-.*\.js$/.test(p))).toBe(true);
    expect(assets.some((p) => /\/Demo-.*\.css$/.test(p))).toBe(true);
    await ctx.close();
  });
});

describe('accessibility (axe) on the built page, with the real hub inside the demo', () => {
  const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
  const serious = async (page: Page) => {
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    // Control: axe really ran (it has checked a meaningful number of rules).
    expect(results.passes.length).toBeGreaterThan(20);
    return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  };

  for (const scheme of ['dark', 'light'] as const) {
    for (const [name, viewport] of [
      ['phone 360', { width: 360, height: 740 }],
      ['tablet 768', { width: 768, height: 1024 }],
      ['desktop 1440', { width: 1440, height: 900 }],
    ] as const) {
      it(`has no serious or critical violations (${scheme}, ${name}): the start`, async () => {
        const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await openDemo(page);
        expect(await serious(page)).toEqual([]);
        await ctx.close();
      }, 60_000);

      it(`has no serious or critical violations (${scheme}, ${name}): a case open in the hub and the player's notice open`, async () => {
        const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await openDemo(page);
        // the report dialog
        await demoOf(page).getByRole('button', { name: /report bo's line: uninstall/i }).click();
        await page.getByRole('dialog').waitFor();
        expect(await serious(page)).toEqual([]);
        await page.getByRole('dialog').getByRole('button', { name: 'Report', exact: true }).click();
        await page.getByRole('heading', { name: 'Report sent' }).waitFor();
        expect(await serious(page)).toEqual([]);
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
        // the case in the hub, with the suggestion
        await openCaseInHub(page);
        expect(await serious(page)).toEqual([]);
        // the decision's Undo, then the notice and its dialog
        await demoOf(page).getByRole('button', { name: /^Send a warning/ }).click();
        expect(await serious(page)).toEqual([]);
        await page.getByRole('button', { name: /see what bo sees/i }).waitFor({ timeout: 15_000 });
        expect(await serious(page)).toEqual([]);
        await page.getByRole('button', { name: /see what bo sees/i }).click();
        await page.getByRole('dialog').waitFor();
        expect(await serious(page)).toEqual([]);
        await ctx.close();
      }, 90_000);
    }
  }

  for (const scheme of ['dark', 'light'] as const) {
    for (const [name, viewport] of [
      ['phone 360', { width: 360, height: 740 }],
      ['desktop 1440', { width: 1440, height: 900 }],
    ] as const) {
      it(`has no serious or critical violations (${scheme}, ${name}): Steps and ladder, and the Detailed workbench`, async () => {
        const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await openDemo(page);
        const demo = demoOf(page);
        if (viewport.width < 1152) await demo.getByRole('button', { name: /^moderator/i }).click();
        await demo.getByRole('button', { name: 'More', exact: true }).click();
        await demo.getByRole('link', { name: 'Steps and ladder' }).click();
        await demo.getByRole('heading', { name: /steps and ladder/i }).waitFor();
        await demo.getByText('6 hours').first().waitFor();
        expect(await serious(page)).toEqual([]);
        await demo.getByRole('button', { name: 'Detailed', exact: true }).click();
        await page.waitForTimeout(300);
        expect(await serious(page)).toEqual([]);
        await ctx.close();
      }, 60_000);
    }
  }
});

describe('layout on the built page', () => {
  // The README snippets stay verbatim, so the layout gives the code room instead of cutting long lines.
  for (const width of [1024, 1200, 1280, 1440, 1920]) {
    it(`the "Add it in 3 steps" code blocks (and the hub step's) do not clip a line at ${width}px`, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(server.url, { waitUntil: 'networkidle' });
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('#add-it pre')]
          .map((pre, i) => ({ i, scroll: pre.scrollWidth, client: pre.clientWidth }))
          .filter((m) => m.scroll > m.client + 1),
      );
      expect(clipped).toEqual([]);
      expect(await page.evaluate(() => document.querySelectorAll('#add-it pre').length)).toBe(5);
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
    it(`has no horizontal page scroll at ${width}px with the hub showing a case, a dialog open, and the Steps and ladder screen`, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await openDemo(page);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await demoOf(page).getByRole('button', { name: /report bo's line: uninstall/i }).click();
      await page.getByRole('dialog').waitFor();
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.getByRole('dialog').getByRole('button', { name: 'Report', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
      await openCaseInHub(page);
      expect(await overflow()).toBeLessThanOrEqual(0);
      const demo = demoOf(page);
      await demo.getByRole('button', { name: 'More', exact: true }).click();
      await demo.getByRole('link', { name: 'Steps and ladder' }).click();
      await demo.getByRole('heading', { name: /steps and ladder/i }).waitFor();
      expect(await overflow()).toBeLessThanOrEqual(0);
      await ctx.close();
    }, 60_000);
  }
  it('at 1440 the hub case card is not crammed: the case column is at least 300px and nothing in the hub overflows its pane', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await openDemo(page);
    await reportBo(page);
    await openCaseInHub(page);
    const m = await page.evaluate(() => {
      const pane = (document.querySelector('[data-pane="mod"]') as HTMLElement).getBoundingClientRect();
      const card = (document.querySelector('.cw-scard') as HTMLElement).getBoundingClientRect();
      const hub = document.querySelector('.cw-hub') as HTMLElement;
      const wide = [...hub.querySelectorAll<HTMLElement>('*')].filter((e) => e.getBoundingClientRect().right > pane.right + 1 && getComputedStyle(e).position !== 'fixed' && e.closest('.cw-toasts') === null);
      return { paneW: pane.width, cardW: card.width, wide: wide.slice(0, 3).map((e) => e.className) };
    });
    expect(m.paneW).toBeGreaterThan(600);
    expect(m.cardW).toBeGreaterThanOrEqual(300);
    expect(m.wide).toEqual([]);
    await ctx.close();
  });
  it('the hub’s toasts sit inside its pane (not at the corner of the window) from 820px', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await openDemo(page);
    await reportBo(page);
    await openCaseInHub(page);
    await demoOf(page).getByRole('button', { name: /^Send a warning/ }).click();
    await demoOf(page).locator('.cw-toast').first().waitFor();
    const where = await page.evaluate(() => {
      const t = (document.querySelector('.cw-toast') as HTMLElement).getBoundingClientRect();
      const pane = (document.querySelector('[data-pane="mod"]') as HTMLElement).getBoundingClientRect();
      return { insideX: t.left >= pane.left - 1 && t.right <= pane.right + 1, insideY: t.top >= pane.top - 1 && t.bottom <= pane.bottom + 1 };
    });
    expect(where).toEqual({ insideX: true, insideY: true });
    await ctx.close();
  });
  it('on a phone the tour moves to the moderator pane, keeps its card on screen, and the hub is usable', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true });
    const page = await ctx.newPage();
    await openDemo(page);
    await reportBo(page);
    const demo = demoOf(page);
    await demo.getByRole('button', { name: /^\d+ new cases?$/ }).waitFor({ timeout: 15_000 });
    const m = await page.evaluate(() => {
      const mod = document.querySelector('[data-pane="mod"]') as HTMLElement;
      const card = document.querySelector('.tour') as HTMLElement;
      const r = card.getBoundingClientRect();
      return { modHidden: mod.hidden, left: r.left, right: r.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(m.modHidden).toBe(false);
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    expect(m.overflow).toBeLessThanOrEqual(0);
    await openCaseInHub(page);
    expect(await demo.getByRole('button', { name: /^Send a warning/ }).isVisible()).toBe(true);
    await ctx.close();
  });
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
    await page.getByText(RUDE).waitFor({ timeout: 15_000 }); // demo CSS is loaded too
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
