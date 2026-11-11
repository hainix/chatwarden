// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

// The one-step report dialog in a real browser, at the widths that matter: a 320px phone, a 360px phone and a desktop. It measures what
// jsdom cannot: nothing is wider than the dialog, nothing scrolls the page sideways, the select is the width of the dialog's content,
// and the parts stack (the label above the select, the hint under it, the note under that). It skips when no Chromium is installed
// (`npx playwright install chromium`), unless CW_REQUIRE_BROWSER=1.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

// A page-side harness: the real component, bundled with React, mounted by the test with a payload.
const HARNESS = `
import { createRoot } from 'react-dom/client';
import { ReportDialog } from './src/ReportDialog';
window.__mount = (config) => {
  const { reporting, line, targetName, theme, ...rest } = config;
  const onSubmit = () => Promise.resolve({ ok: true, reportId: 'r1', remaining: 4 });
  createRoot(document.getElementById('app')).render(
    <ReportDialog onSubmit={onSubmit} onClose={() => undefined} reporting={reporting} line={line} targetName={targetName} theme={theme} locale="en" timeZone="UTC" {...rest} />,
  );
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
  console.warn(`report layout skipped: ${String(error).split('\n')[0]}. Run "npx playwright install chromium".`);
}
afterAll(async () => {
  await browser?.close();
});
const itb = browser === null ? it.skip : it;

const reason = (id: string, label: string, group: string, extra: Record<string, unknown> = {}) => ({ id, label, hint: '', group, asksNote: false, ...extra });
const LONG = 'Averyveryveryverylongunbrokenreasonlabelthatnoscreencouldeverfitononeline'.repeat(2);
const REPORTING = {
  flow: 'one_tap',
  thanks: 'Thanks. A moderator will have a look at it as soon as one is free.',
  reasons: [
    reason('harassment', 'Harassment', 'Chat', { hint: `Targeting or bullying someone. ${LONG}` }),
    reason('long', LONG, 'Chat'),
    reason('cheating', 'Cheating', 'Gameplay'),
    reason('other', 'Something else', '', { asksNote: true }),
  ],
};
const LINE = `you play like a snerp ${LONG}`;

async function open(width: number, scheme: 'light' | 'dark', config: Record<string, unknown>): Promise<Page> {
  const context = await (browser as Browser).newContext({ colorScheme: scheme, viewport: { width, height: 700 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0}${css}</style></head><body><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((c) => (window as unknown as { __mount: (x: unknown) => void }).__mount(c), config);
  await page.waitForSelector('[role="dialog"]');
  return page;
}

/** What overflows: the page sideways, the dialog's own content, and any element whose right edge passes the dialog's. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const box = dialog.getBoundingClientRect();
    const wide = [...dialog.querySelectorAll<HTMLElement>('*:not(option):not(optgroup)')]
      .filter((el) => el.getBoundingClientRect().right > box.right + 0.5 || el.getBoundingClientRect().left < box.left - 0.5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: dialog.scrollWidth - dialog.clientWidth,
      wide,
    };
  });

const rect = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
  }, selector);

const WIDTHS = [320, 360, 1280] as const;
const SCHEMES = ['light', 'dark'] as const;

describe('the one-step report dialog, measured in Chromium', () => {
  for (const width of WIDTHS) {
    for (const scheme of SCHEMES) {
      itb(`${width}px ${scheme}: empty, with a long reason and hint, the note, and sent: nothing overflows sideways`, async () => {
        const p = await open(width, scheme, { reporting: REPORTING, line: LINE, targetName: 'Cara' });
        expect(await overflow(p)).toEqual({ page: 0, dialog: 0, wide: [] });

        await p.selectOption('select', 'harassment');
        expect(await overflow(p)).toEqual({ page: 0, dialog: 0, wide: [] });
        await p.selectOption('select', 'long');
        expect(await overflow(p)).toEqual({ page: 0, dialog: 0, wide: [] });

        await p.getByRole('button', { name: 'Add a note' }).click();
        await p.locator('textarea').fill('word '.repeat(80));
        expect(await overflow(p)).toEqual({ page: 0, dialog: 0, wide: [] });

        await p.getByRole('button', { name: 'Report' }).click();
        await p.waitForSelector('.cw-result');
        expect(await overflow(p)).toEqual({ page: 0, dialog: 0, wide: [] });
        await p.context().close();
      });

      itb(`${width}px ${scheme}: reason_required with its error`, async () => {
        const p = await open(width, scheme, { reporting: { ...REPORTING, flow: 'reason_required' }, line: LINE });
        await p.getByRole('button', { name: 'Report' }).click();
        await p.waitForSelector('.cw-field-error');
        expect(await overflow(p)).toEqual({ page: 0, dialog: 0, wide: [] });
        expect(await p.evaluate(() => document.activeElement?.tagName)).toBe('SELECT');
        await p.context().close();
      });
    }
  }

  itb('at 320px everything stacks and the select is as wide as the dialog content', async () => {
    const p = await open(320, 'light', { reporting: REPORTING, line: 'a short line' });
    await p.selectOption('select', 'harassment');
    const label = await rect(p, 'label[for]');
    const select = await rect(p, 'select');
    const hint = await rect(p, '.cw-field > .cw-hint');
    const door = await rect(p, '.cw-linkbtn');
    const actions = await rect(p, '.cw-actions');
    const form = await rect(p, 'form');
    // Label, select, its hint, the note door, then the buttons: one under the other.
    expect(label.bottom).toBeLessThanOrEqual(select.top + 0.5);
    expect(select.bottom).toBeLessThanOrEqual(hint.top + 0.5);
    expect(hint.bottom).toBeLessThanOrEqual(door.top + 0.5);
    expect(door.bottom).toBeLessThanOrEqual(actions.top + 0.5);
    // Full width: the select fills the form.
    expect(Math.abs(select.width - form.width)).toBeLessThan(1);
    expect(select.left).toBeCloseTo(form.left, 0);
    await p.context().close();
  });

  itb('the select is at least the control height, so a thumb can hit it', async () => {
    const p = await open(320, 'light', { reporting: REPORTING });
    expect((await rect(p, 'select')).width).toBeGreaterThan(200);
    const h = await p.evaluate(() => (document.querySelector('select') as HTMLElement).getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(40);
    await p.context().close();
  });

  itb('the dialog takes a custom token: --cw-radius-s reaches the select (the 7j read pattern)', async () => {
    const p = await open(1280, 'light', { reporting: REPORTING, className: 'themed' });
    await p.addStyleTag({ content: '.themed { --cw-radius-s: 17px; --cw-border-strong: rgb(1, 2, 3); }' });
    const seen = await p.evaluate(() => {
      const s = getComputedStyle(document.querySelector('select') as HTMLElement);
      return { radius: s.borderTopLeftRadius, border: s.borderTopColor };
    });
    expect(seen).toEqual({ radius: '17px', border: 'rgb(1, 2, 3)' });
    await p.context().close();
  });
});
