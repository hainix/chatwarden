// @vitest-environment node
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppealCase } from '@chatwarden/core';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import { renderAppealPage } from '../src/appealPage.js';

// The appeal page in a real browser at the widths that matter: a 320 px and a 360 px phone and a desktop, light and dark. It measures what the stylesheet text cannot:
// nothing scrolls the page sideways (even with a long unbroken line and a long rule label), the form and the button fit the screen, the page is dark in dark mode and light in
// light mode. It skips when no Chromium is installed (`npx playwright install chromium`), unless CW_REQUIRE_BROWSER=1.

const NOW = 1_800_000_000_000;
const LONG = 'Averyveryveryverylongunbrokenwordthatnoscreencouldeverfitononeline'.repeat(3);
const CASE: AppealCase = {
  notice: { kind: 'chat', rule: 2, ruleLabel: LONG, until: NOW + 6 * 3_600_000, refCode: 'M-ABCDE', createdAt: NOW, excerpt: [{ text: `you ${LONG}`, day: '2027-01-14' }] } as unknown as AppealCase['notice'],
  canAppeal: true,
  appeal: null,
  standing: null,
  expiresAt: NOW + 30 * 24 * 3_600_000,
  emailsOutcome: false,
  contact: `help ${LONG}`,
  statementMax: 1000,
};
const HTML = renderAppealPage({ state: 'case', locale: 'en', words: noticeWordsFor('en').words, token: 'abc.def', case: CASE, now: NOW });

let browser: Browser | null = null;
try {
  browser = await chromium.launch();
} catch (error) {
  if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
  console.warn(`appeal page layout skipped: ${String(error).split('\n')[0]}. Run "npx playwright install chromium".`);
}
afterAll(async () => {
  await browser?.close();
});
const itb = browser === null ? it.skip : it;

async function open(width: number, scheme: 'light' | 'dark'): Promise<Page> {
  const context = await (browser as Browser).newContext({ colorScheme: scheme, viewport: { width, height: 700 } });
  const page = await context.newPage();
  await page.setContent(HTML);
  return page;
}

describe('the appeal page in a browser', () => {
  for (const width of [320, 360, 1280]) {
    itb(`at ${width}px nothing scrolls sideways and the form and button fit`, async () => {
      const page = await open(width, 'light');
      // Scripts are strings here: this package's compiler has no DOM types, and the page is the thing measured.
      const m = (await page.evaluate(`(() => {
        const box = (sel) => document.querySelector(sel).getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          textarea: box('textarea'),
          button: box('button'),
          main: box('main'),
        };
      })()`)) as { scrollWidth: number; innerWidth: number; textarea: { left: number; right: number }; button: { right: number }; main: { width: number } };
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
      expect(m.textarea.right).toBeLessThanOrEqual(m.innerWidth);
      expect(m.textarea.left).toBeGreaterThanOrEqual(0);
      expect(m.button.right).toBeLessThanOrEqual(m.innerWidth);
      expect(m.main.width).toBeLessThanOrEqual(640 + 1);
      await page.context().close();
    });
  }

  itb('is light in light mode and dark in dark mode, with readable text either way', async () => {
    const colours = async (scheme: 'light' | 'dark') => {
      const page = await open(360, scheme);
      const c = (await page.evaluate('({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color })')) as { bg: string; fg: string };
      await page.context().close();
      return c;
    };
    const parse = (rgb: string) => (rgb.match(/\d+/g) ?? []).map(Number);
    const light = await colours('light');
    const dark = await colours('dark');
    const lum = ([r, g, b]: number[]) => 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0);
    expect(lum(parse(light.bg))).toBeGreaterThan(200);
    expect(lum(parse(dark.bg))).toBeLessThan(60);
    expect(lum(parse(light.fg))).toBeLessThan(80);
    expect(lum(parse(dark.fg))).toBeGreaterThan(180);
  });

  itb('the touch targets are at least 44 px tall', async () => {
    const page = await open(360, 'light');
    const h = (await page.evaluate("document.querySelector('button').getBoundingClientRect().height")) as number;
    expect(h).toBeGreaterThanOrEqual(44);
    await page.context().close();
  });
});
