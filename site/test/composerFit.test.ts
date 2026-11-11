// @vitest-environment node
// The demo's chat composer (the text input, the 0/200 counter and Send) fits the game pane at every width, with and without the tour's
// gold ring on it. Owner feedback 2026-11-11: "the ui here on the site is cropped off": at desktop widths the pane is about 340px wide
// and the row was about 370px, so the pane's overflow: hidden cut Send to "Se".
//
// It loads the BUILT page (run `npm run build --workspace site` first) in Chromium and measures real pixels. It skips when there is no
// Chromium (`npx playwright install chromium`), unless CW_REQUIRE_BROWSER=1.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDist } from './helpers/serveDist';

let browser: Browser | null = null;
let server: Awaited<ReturnType<typeof serveDist>> | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
    console.warn(`composer fit skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
    return;
  }
  server = await serveDist();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Loads the page at a width, wakes the lazy demo (it loads when scrolled to) and waits for the composer. */
async function open(width: number, height = 900): Promise<Page> {
  const context = await (browser as Browser).newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto((server as NonNullable<typeof server>).url, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.locator('.composer-row').waitFor({ timeout: 15_000 });
  return page;
}

interface Fit {
  /** Send's right edge minus the pane's right edge (must be <= 0), and its left edge minus the pane's left (>= 0). */
  sendPastPane: number;
  sendBeforePane: number;
  /** Does the word "Send" fit inside its button? */
  sendTextFits: boolean;
  sendWidth: number;
  /** The input's width (it shrinks, but stays usable). */
  inputWidth: number;
  countShown: boolean;
  /** Anything in the composer whose box is outside the composer's. */
  outside: string[];
  composerScroll: number;
  paneScroll: number;
  pageScroll: number;
  paneWidth: number;
}

const measure = (page: Page): Promise<Fit> =>
  page.evaluate(() => {
    const composer = document.querySelector('.composer') as HTMLElement;
    const pane = composer.closest('.pane') as HTMLElement;
    const send = composer.querySelector('.send') as HTMLElement;
    const sendText = send.querySelector('span') as HTMLElement;
    const input = composer.querySelector('input[type="text"]') as HTMLElement;
    const count = composer.querySelector('.count') as HTMLElement;
    const c = composer.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    const s = send.getBoundingClientRect();
    const t = sendText.getBoundingClientRect();
    const outside = [...composer.querySelectorAll<HTMLElement>('*')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > c.right + 0.5 || r.left < c.left - 0.5);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    return {
      sendPastPane: Math.round((s.right - p.right) * 10) / 10,
      sendBeforePane: Math.round((s.left - p.left) * 10) / 10,
      sendTextFits: t.right <= s.right + 0.5 && sendText.scrollWidth <= sendText.clientWidth + 1,
      sendWidth: Math.round(s.width),
      inputWidth: Math.round(input.getBoundingClientRect().width),
      countShown: getComputedStyle(count).display !== 'none',
      outside,
      composerScroll: composer.scrollWidth - composer.clientWidth,
      paneScroll: pane.scrollWidth - pane.clientWidth,
      pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      paneWidth: Math.round(p.width),
    };
  });

/** `pageScroll`: the page itself never scrolls sideways, from 320px up (the hero headline used to be 16px too wide at 320). */
const expectFits = (fit: Fit, label: string, pageScroll = true): void => {
  expect(fit.sendPastPane, `${label}: Send's right edge is inside the pane`).toBeLessThanOrEqual(0);
  expect(fit.sendBeforePane, `${label}: Send's left edge is inside the pane`).toBeGreaterThanOrEqual(0);
  expect(fit.sendTextFits, `${label}: the word Send is not cut off`).toBe(true);
  expect(fit.sendWidth, `${label}: Send keeps its width`).toBeGreaterThanOrEqual(90);
  expect(fit.inputWidth, `${label}: the input is still a usable width`).toBeGreaterThanOrEqual(100);
  expect(fit.outside, `${label}: nothing in the composer overflows it`).toEqual([]);
  expect(fit.composerScroll, `${label}: the composer does not scroll sideways`).toBeLessThanOrEqual(0);
  expect(fit.paneScroll, `${label}: the pane is not cropping anything`).toBeLessThanOrEqual(0);
  if (pageScroll) expect(fit.pageScroll, `${label}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
};

const DESKTOP = [1152, 1280, 1366, 1440, 1920] as const;
const PHONES_AND_TABLETS = [320, 360, 390, 414, 768, 1024] as const;

describe('the demo composer fits the game pane (built page, real Chromium)', () => {
  for (const width of DESKTOP) {
    for (const ring of [false, true]) {
      it(`${width}px, ${ring ? 'with' : 'without'} the tour ring on the composer: the input shrinks, the counter shows, Send is whole`, async (ctx) => {
        if (browser === null) return ctx.skip();
        const page = await open(width);
        if (ring) await page.evaluate(() => document.querySelector('.composer')?.setAttribute('data-tour-target', 'true'));
        const fit = await measure(page);
        expectFits(fit, `${width}px`);
        expect(fit.countShown, 'the counter is shown on a desktop').toBe(true);
        await page.context().close();
      });
    }
  }

  for (const width of PHONES_AND_TABLETS) {
    for (const ring of [false, true]) {
      it(`${width}px, ${ring ? 'with' : 'without'} the tour ring: Send is whole${width <= 480 ? ' and the counter is hidden' : ''}`, async (ctx) => {
        if (browser === null) return ctx.skip();
        const page = await open(width);
        if (ring) await page.evaluate(() => document.querySelector('.composer')?.setAttribute('data-tour-target', 'true'));
        const fit = await measure(page);
        expectFits(fit, `${width}px`);
        if (width <= 480) expect(fit.countShown, 'the counter is hidden on a phone').toBe(false);
        await page.context().close();
      });
    }
  }

  it('the page does not scroll sideways from 320px up, and the hero headline stays inside the gutter (it wraps instead of growing)', async (ctx) => {
    if (browser === null) return ctx.skip();
    for (const width of [320, 330, 340, 360, 375, 390, 414, 480]) {
      const page = await open(width);
      const h1 = await page.evaluate(() => {
        const el = document.querySelector('h1') as HTMLElement;
        const r = el.getBoundingClientRect();
        const lines = [...el.querySelectorAll<HTMLElement>('.h1-line')].map((l) => Math.round(l.scrollWidth - l.clientWidth));
        return {
          right: Math.round(r.right * 10) / 10,
          left: Math.round(r.left * 10) / 10,
          viewport: document.documentElement.clientWidth,
          overflow: Math.round(el.scrollWidth - el.clientWidth),
          lines,
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(h1.page, `${width}px: no horizontal page scroll`).toBeLessThanOrEqual(0);
      expect(h1.right, `${width}px: the headline's right edge is inside the screen`).toBeLessThanOrEqual(h1.viewport);
      expect(h1.left, `${width}px: and its left edge`).toBeGreaterThanOrEqual(0);
      expect(h1.overflow, `${width}px: the headline holds its own words`).toBeLessThanOrEqual(0);
      expect(h1.lines.every((n) => n <= 0), `${width}px: each sentence holds its own words (${h1.lines.join(', ')})`).toBe(true);
      await page.context().close();
    }
  });

  it('the hero copy (headline, lead, install command) stays inside the gutter at 320px: the install command wraps its Copy button instead of widening the column', async (ctx) => {
    if (browser === null) return ctx.skip();
    const page = await open(320);
    const edges = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const pick = (sel: string): { right: number; left: number } => {
        const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
        return { right: Math.round(r.right * 10) / 10, left: Math.round(r.left * 10) / 10 };
      };
      return { vw, h1: pick('h1'), lead: pick('.hero-copy .lead'), actions: pick('.hero-actions'), cmd: pick('.cmd'), copy: pick('.cmd .copy'), note: pick('.hero-note') };
    });
    for (const [name, e] of Object.entries(edges)) {
      if (name === 'vw') continue;
      const edge = e as { right: number; left: number };
      expect(edge.right, `${name}'s right edge is inside the 16px gutter`).toBeLessThanOrEqual(edges.vw - 16 + 0.5);
      expect(edge.left, `${name}'s left edge`).toBeGreaterThanOrEqual(16 - 0.5);
    }
    await page.context().close();
  });

  it('the headline keeps its look on a desktop: the hero size, the display face and its weight', async (ctx) => {
    if (browser === null) return ctx.skip();
    const page = await open(1440);
    const look = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('h1') as HTMLElement);
      return { size: parseFloat(style.fontSize), family: style.fontFamily, weight: style.fontWeight };
    });
    expect(look.size).toBeCloseTo(73.6, 0); // 4.6rem: the top of the clamp
    expect(look.family).toMatch(/Bungee/);
    expect(look.weight).toBe('400');
    await page.context().close();
  });

  it('still fits with a full 200-character line typed (the counter is at its widest) and with the line near its limit', async (ctx) => {
    if (browser === null) return ctx.skip();
    for (const width of [1152, 1440, 360]) {
      const page = await open(width);
      await page.locator('#demo-input').fill('x'.repeat(200));
      expect(await page.locator('.count').textContent()).toBe('200/200');
      expectFits(await measure(page), `${width}px with 200 characters`);
      await page.context().close();
    }
  });

  it('the input is the part that gives: it is wider on a wider pane and never wider than the row', async (ctx) => {
    if (browser === null) return ctx.skip();
    const narrow = await open(1152);
    const wide = await open(1920);
    const a = await measure(narrow);
    const b = await measure(wide);
    expect(b.paneWidth).toBeGreaterThanOrEqual(a.paneWidth);
    expect(b.inputWidth).toBeGreaterThanOrEqual(a.inputWidth);
    await narrow.context().close();
    await wide.context().close();
  });

  it('Send is reachable with a click at the widest desktop and the narrowest (the cropped part is not the click target)', async (ctx) => {
    if (browser === null) return ctx.skip();
    for (const width of [1152, 1920]) {
      const page = await open(width);
      await page.locator('#demo-input').fill('gg everyone');
      const box = await page.locator('.send').boundingBox();
      const pane = await page.locator('.composer').evaluate((el) => (el.closest('.pane') as HTMLElement).getBoundingClientRect().right);
      expect(box).not.toBeNull();
      // The point a user clicks (the right edge of the button) is inside the pane, so it hits Send and not the page behind.
      const hit = await page.evaluate(
        ({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.send') !== null,
        { x: (box as { x: number; width: number }).x + (box as { width: number }).width - 4, y: (box as { y: number; height: number }).y + (box as { height: number }).height / 2 },
      );
      expect((box as { x: number; width: number }).x + (box as { width: number }).width).toBeLessThanOrEqual(pane);
      expect(hit).toBe(true);
      await page.context().close();
    }
  });
});
