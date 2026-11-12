// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

// The chat box in a real browser, at the widths that matter: hostile text (markup, javascript: strings, right-to-left overrides,
// zero-width spam, a 10 000 character word) must render as inert text and wrap inside a 360 px box without scrolling the page
// sideways, at a 320 px phone, a 360 px phone and a desktop. Skips when no Chromium is installed (`npx playwright install
// chromium`), unless CW_REQUIRE_BROWSER=1.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8') + readFileSync(fileURLToPath(new URL('../src/chat.css', import.meta.url)), 'utf8');

const HARNESS = `
import { createRoot } from 'react-dom/client';
import { ChatBox } from './src/chat/ChatBox';
window.__mount = (config) => {
  const hello = { type: 'hello', v: 1, epoch: 'e', room: 'lobby', you: { name: 'snerp' }, maxLength: 200, summary: 'Trash talk is part of the game.', restriction: null, lines: config.lines, muted: config.muted || [] };
  const transport = {
    open(room, events) {
      events.status('connecting');
      setTimeout(() => { events.status('open'); events.frame(hello); }, 0);
      return { send: async () => ({ ok: false, refused: { reason: 'blocked', rule: 1 } }), mute: async () => true, report: async () => ({ ok: true, reportId: '', remaining: 3 }), close() {} };
    },
  };
  createRoot(document.getElementById('app')).render(<ChatBox transport={transport} room="lobby" locale="en" timeZone="UTC" {...(config.props || {})} />);
};
`;

let script = '';
let browser: Browser | null = null;
try {
  const out = await build({
    stdin: { contents: HARNESS, resolveDir: pkg, loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  script = (out.outputFiles[0] as { text: string }).text;
  browser = await chromium.launch();
} catch (error) {
  if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
  console.warn(`chat layout skipped: ${String(error).split('\n')[0]}. Run "npx playwright install chromium".`);
}
afterAll(async () => {
  await browser?.close();
});
const itb = browser === null ? it.skip : it;

const line = (id: number, name: string, text: string, extra: Record<string, unknown> = {}) => ({ id: String(id), at: 1_800_000_000_000 + id * 1000, name, text, ...extra });
const BIG_WORD = 'w'.repeat(10_000);
const HOSTILE = [
  line(1, 'tarvo', '<img src=x onerror=alert(1)><script>window.__pwned = 1</script>'),
  line(2, 'tarvo', 'javascript:alert(1) [click](javascript:alert(2))'),
  line(3, 'vlemmo', '‮evil right to left‬ and ⁧more⁩'),
  line(4, 'quissel', `zero${'​'.repeat(400)}width`),
  line(5, 'fenrisk', BIG_WORD),
  line(6, 'N'.repeat(64), 'a very long name'),
  line(7, 'snerp', BIG_WORD.slice(0, 900), { mine: true }),
  line(8, 'drakkuun', 'an ordinary line that is long enough to wrap over more than one row at a narrow width, as chat lines do'),
];

async function open(width: number, scheme: 'light' | 'dark', config: Record<string, unknown>): Promise<Page> {
  const context = await (browser as Browser).newContext({ colorScheme: scheme, viewport: { width, height: 700 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;padding:0}${css}</style></head><body><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((c) => (window as unknown as { __mount: (x: unknown) => void }).__mount(c), config);
  await page.waitForSelector('[role="log"] li');
  return page;
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const box = document.querySelector('.cw-chat') as HTMLElement;
    const log = document.querySelector('[role="log"]') as HTMLElement;
    const logRect = log.getBoundingClientRect();
    const wide = [...log.querySelectorAll('li, li *')].filter((el) => el.getBoundingClientRect().right > logRect.right + 1).map((el) => (el as HTMLElement).className || el.tagName);
    const form = document.querySelector('form') as HTMLElement;
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send') as HTMLElement;
    return {
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      boxOverflow: box.scrollWidth - box.clientWidth,
      logOverflowX: log.scrollWidth - log.clientWidth,
      wide,
      sendRight: send.getBoundingClientRect().right,
      formRight: form.getBoundingClientRect().right,
      viewport: doc.clientWidth,
      injected: document.querySelectorAll('img, script[src], a').length,
      pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0,
      lines: log.querySelectorAll('li').length,
    };
  });

describe.each([320, 360, 1280])('the box at %i px', (width) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    itb('hostile text renders as inert text and wraps inside the box', async () => {
      const page = await open(width, scheme, { lines: HOSTILE });
      const m = await measure(page);
      expect(m.lines).toBe(HOSTILE.length);
      expect(m.pageOverflow).toBeLessThanOrEqual(0);
      expect(m.boxOverflow).toBeLessThanOrEqual(0);
      expect(m.logOverflowX).toBeLessThanOrEqual(0);
      expect(m.wide).toEqual([]);
      expect(m.sendRight).toBeLessThanOrEqual(m.viewport);
      expect(m.injected).toBe(0);
      expect(m.pwned).toBe(0);
      await page.context().close();
    });
  });
});

describe('the box in a browser', () => {
  itb('the input is one row and Send sits beside it at 360 px', async () => {
    const page = await open(360, 'light', { lines: HOSTILE.slice(7) });
    const r = await page.evaluate(() => {
      const t = document.querySelector('textarea') as HTMLElement;
      const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send') as HTMLElement;
      const a = t.getBoundingClientRect();
      const b = send.getBoundingClientRect();
      return { textareaHeight: a.height, sendHeight: b.height, sameRow: Math.abs(a.top - b.top) < a.height, sendLeftOfEdge: b.right <= window.innerWidth };
    });
    expect(r.sameRow).toBe(true);
    expect(r.sendLeftOfEdge).toBe(true);
    expect(r.textareaHeight).toBeLessThan(80);
    expect(r.sendHeight).toBeGreaterThanOrEqual(36);
    await page.context().close();
  });

  itb('a long run of lines scrolls inside the log and the page does not grow', async () => {
    const many = Array.from({ length: 80 }, (_v, i) => line(i + 1, i % 3 === 0 ? 'tarvo' : 'vlemmo', `message number ${i + 1} with a few words`));
    const page = await open(360, 'dark', { lines: many });
    const r = await page.evaluate(() => {
      const log = document.querySelector('[role="log"]') as HTMLElement;
      return { scrolls: log.scrollHeight > log.clientHeight, bodyHeight: document.body.scrollHeight, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 2, viewport: window.innerHeight };
    });
    expect(r.scrolls).toBe(true);
    expect(r.atBottom).toBe(true);
    expect(r.bodyHeight).toBeLessThanOrEqual(r.viewport + 1);
    await page.context().close();
  });

  itb('the controls are at least 2.25 rem tall', async () => {
    const page = await open(360, 'light', { lines: HOSTILE.slice(7) });
    const heights = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(36);
    await page.context().close();
  });

  itb('the height can be set from the game: --cw-chat-height', async () => {
    const page = await open(360, 'light', { lines: HOSTILE.slice(7), props: { className: 'tall' } });
    await page.addStyleTag({ content: '.tall { --cw-chat-height: 31rem; }' });
    const h = await page.evaluate(() => (document.querySelector('[role="log"]') as HTMLElement).getBoundingClientRect().height);
    expect(h).toBeGreaterThan(400);
    await page.context().close();
  });
});
