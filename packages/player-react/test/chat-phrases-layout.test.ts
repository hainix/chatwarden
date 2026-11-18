// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

// M5: the phrase picker in a real browser, at 320, 360 and 1280 px, light and dark: the buttons wrap inside the box, a long phrase breaks instead of pushing the page sideways, the list scrolls inside its own height
// and the page does not grow, and the controls are touch-sized. Skips when no Chromium is installed (`npx playwright install chromium`), unless CW_REQUIRE_BROWSER=1.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8') + readFileSync(fileURLToPath(new URL('../src/chat.css', import.meta.url)), 'utf8');

const HARNESS = `
import { createRoot } from 'react-dom/client';
import { ChatBox } from './src/chat/ChatBox';
window.__mount = (config) => {
  const hello = { type: 'hello', v: 2, mode: { kind: 'normal', until: null }, epoch: 'e', room: 'kids', you: { name: 'snerp' }, maxLength: 200, summary: '', restriction: null, lines: [], muted: [], phrases: { book: config.book } };
  const transport = {
    open(room, events) {
      events.status('connecting');
      setTimeout(() => { events.status('open'); events.frame(hello); }, 0);
      return { send: async () => ({ ok: true, line: { id: '1', at: 1, name: 'snerp', text: 'x', mine: true } }), sendPhrase: async () => ({ ok: false, refused: { reason: 'phrase_unknown' } }), mute: async () => true, report: async () => ({ ok: true, reportId: '', remaining: 3 }), close() {} };
    },
  };
  createRoot(document.getElementById('app')).render(<ChatBox transport={transport} room="kids" locale="en" timeZone="UTC" />);
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
  console.warn(`phrase picker layout skipped: ${String(error).split('\n')[0]}. Run "npx playwright install chromium".`);
}
afterAll(async () => {
  await browser?.close();
});
const itb = browser === null ? it.skip : it;

const BOOK = [
  { id: 'gg', text: 'Good game!' },
  { id: 'help', text: 'Can you help me?', group: 'Ask' },
  { id: 'where', text: 'Where is everyone going right now?', group: 'Ask' },
  { id: 'wide', text: 'w'.repeat(100), group: 'Ask' },
  { id: 'markup', text: '<img src=x onerror=alert(1)> and <b>bold</b>' },
  ...Array.from({ length: 12 }, (_v, i) => ({ id: `p${i}`, text: `Phrase number ${i} for the list`, group: i % 2 === 0 ? 'Cheer' : 'Chat' })),
];

async function open(width: number, scheme: 'light' | 'dark'): Promise<Page> {
  const context = await (browser as Browser).newContext({ colorScheme: scheme, viewport: { width, height: 700 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;padding:0}${css}</style></head><body><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((c) => (window as unknown as { __mount: (x: unknown) => void }).__mount(c), { book: BOOK });
  await page.waitForSelector('.cw-chat-phrase');
  return page;
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const box = document.querySelector('.cw-chat') as HTMLElement;
    const list = document.querySelector('.cw-chat-phrasebook') as HTMLElement;
    const listRect = list.getBoundingClientRect();
    const phrases = [...document.querySelectorAll('.cw-chat-phrase')] as HTMLElement[];
    return {
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      boxOverflow: box.scrollWidth - box.clientWidth,
      listOverflowX: list.scrollWidth - list.clientWidth,
      listScrolls: list.scrollHeight > list.clientHeight,
      listHeight: listRect.height,
      outside: phrases.filter((p) => p.getBoundingClientRect().right > listRect.right + 1).length,
      shortest: Math.min(...phrases.map((p) => p.getBoundingClientRect().height)),
      count: phrases.length,
      filter: document.querySelector('input[type="search"]') !== null,
      textarea: document.querySelector('textarea') !== null,
      injected: document.querySelectorAll('img, script[src], b').length,
      bodyHeight: document.body.scrollHeight,
      viewport: window.innerHeight,
    };
  });

describe.each([320, 360, 1280])('the phrase picker at %i px', (width) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    itb('wraps inside the box, scrolls inside its own height, has a filter and no text input, and renders markup as text', async () => {
      const page = await open(width, scheme);
      const m = await measure(page);
      expect(m.count).toBe(BOOK.length);
      expect(m.filter).toBe(true);
      expect(m.textarea).toBe(false);
      expect(m.pageOverflow).toBeLessThanOrEqual(0);
      expect(m.boxOverflow).toBeLessThanOrEqual(0);
      expect(m.listOverflowX).toBeLessThanOrEqual(0);
      expect(m.outside).toBe(0);
      expect(m.listHeight).toBeLessThanOrEqual(150);
      expect(m.shortest).toBeGreaterThanOrEqual(36);
      expect(m.injected).toBe(0);
      expect(m.bodyHeight).toBeLessThanOrEqual(m.viewport + 1);
      await page.context().close();
    });
  });
});

describe('the picker in a browser', () => {
  itb('the list scrolls (it holds more than its height) and keyboard focus is one tab stop', async () => {
    const page = await open(360, 'light');
    const m = await measure(page);
    expect(m.listScrolls).toBe(true);
    const stops = await page.evaluate(() => [...document.querySelectorAll('.cw-chat-phrase')].filter((b) => b.getAttribute('tabindex') === '0').length);
    expect(stops).toBe(1);
    await page.context().close();
  });
});
