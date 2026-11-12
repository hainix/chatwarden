import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';
// @ts-expect-error build.mjs is plain JavaScript (esbuild's API); it exports buildWeb
import { buildWeb } from './web/build.mjs';

// The chat page in a real browser (Playwright). It skips when no Chromium is installed (`npx playwright install chromium`), unless
// CW_REQUIRE_BROWSER=1.

let server: TinyChat | null = null;
let browser: Browser | null = null;
let axeSource = '';
try {
  await (buildWeb as () => Promise<void>)();
  server = await startServer({ port: 0, secret: 'chat-browser-secret-not-for-production', discordWebhookUrl: '' });
  browser = await chromium.launch();
  axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
} catch (error) {
  if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
  console.warn(`tiny-chat browser test skipped: ${String(error).split('\n')[0]}. Run "npx playwright install chromium".`);
}
beforeAll(() => undefined);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
const itb = browser === null ? it.skip : it;
const origin = (): string => `http://127.0.0.1:${(server as TinyChat).port}`;

describe('the chat page in a browser', () => {
  itb('type a line, see it; type a blocked line, see the refusal and the draft kept', async () => {
    const page = await (await (browser as Browser).newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${origin()}/?as=browser-one`);
    const input = page.getByRole('textbox', { name: 'Message' });
    await input.waitFor();
    await input.fill('hello from the browser');
    await input.press('Enter');
    await page.getByRole('log').getByText('hello from the browser').waitFor();
    expect(await input.inputValue()).toBe('');
    await input.fill('you zorbak');
    await input.press('Enter');
    await page.getByText(/It breaks a community rule\. Community Rule 1\./).waitFor();
    expect(await input.inputValue()).toBe('you zorbak');
    expect(await page.getByRole('log').getByText('zorbak').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  itb('a line from another tab reaches this one', async () => {
    const context = await (browser as Browser).newContext();
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto(`${origin()}/?as=tab-a`);
    await b.goto(`${origin()}/?as=tab-b`);
    const ia = a.getByRole('textbox', { name: 'Message' });
    await ia.waitFor();
    await b.getByRole('textbox', { name: 'Message' }).waitFor();
    await ia.fill('over to you');
    await ia.press('Enter');
    await b.getByRole('log').getByText('over to you').waitFor();
    await context.close();
  });

  itb('at 360 px the page has no horizontal scroll', async () => {
    const page = await (await (browser as Browser).newContext({ viewport: { width: 360, height: 700 } })).newPage();
    await page.goto(`${origin()}/?as=narrow`);
    await page.getByRole('textbox', { name: 'Message' }).waitFor();
    const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    expect(m.over).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  itb.each(['light', 'dark'] as const)('axe finds no violation, %s', async (scheme) => {
    const page = await (await (browser as Browser).newContext({ colorScheme: scheme })).newPage();
    await page.goto(`${origin()}/?as=axe-${scheme}`);
    await page.getByRole('textbox', { name: 'Message' }).waitFor();
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (c: Element, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: unknown[] }> }> } }).axe;
      const result = await axe.run(document.body, { resultTypes: ['violations'] });
      return result.violations.map((v) => `${v.impact}: ${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    await page.context().close();
  });
});
