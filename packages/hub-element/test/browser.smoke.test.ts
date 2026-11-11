// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { toExpress } from '@chatwarden/http/express';
import express from 'express';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A real browser (Chromium, through Playwright) loads a bare page that holds only the script tag and the element, served by a real
// Express app that mounts the kit's real staff routes at /admin, the way an adopter would. It checks: no console errors, the hub
// renders, a case can be decided (and `cw-decided` fires), page CSS does not leak in, the page's --cw-* values do pass in, the keys
// behave, a strict CSP with no style-src still styles the hub, and it takes the screenshots.
//
// It needs a Chromium install (`npx playwright install chromium`). Without one the tests skip, unless CW_REQUIRE_BROWSER=1 (CI that
// means to run it). Run on its own: `npm run smoke:browser --workspace @chatwarden/hub-element`.

const SHOTS = process.env.CW_SHOTS_DIR ?? join(process.cwd(), '.superpowers', 'sdd', '2026-11-10-k4-hub-and-player-ui', 'screenshots', '7e');
// The page: a script tag and the element (the margin rule is the only thing besides; the strict-CSP page leaves even that out).
const page = (extra = '', element = '<chatwarden-hub base-url="/admin"></chatwarden-hub>', margin = true) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moderation</title>${margin ? '<style>body { margin: 0 }</style>' : ''}${extra}</head><body><script type="module" src="/hub-element.js"></script>${element}</body></html>`;

let browser: Browser | null = null;
let server: Server;
let origin = '';
let dir = '';
let world: HubWorld;
let reports: Array<{ id: string }> = [];

beforeAll(async () => {
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-hub-element-smoke-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  const script = readFileSync(join(dir, 'hub-element.js'));

  world = await hubWorld({ role: 'owner', gameName: 'Dragon Duel' });
  // Real reports, filed a little before the browser's own clock (the element reads the real time).
  world.clock.t = Date.now() - 90 * 60_000;
  reports = [
    await world.fileRich({ target: 'Mallory', reporter: 'Rae', room: 'one', category: 'harassment' }),
    await world.fileRich({ target: 'Zed', reporter: 'Kit', room: 'two', category: 'hate' }),
    await world.fileRich({ target: 'Pix', reporter: 'Sam', room: 'three', category: 'spam' }),
  ];

  const app = express();
  // The kit goes before any body parser, as its docs say.
  app.use('/admin', toExpress(world.routes));
  app.get('/hub-element.js', (_req, res) => res.type('text/javascript').send(script));
  app.get('/', (_req, res) => res.type('html').send(page()));
  app.get('/detailed', (_req, res) => res.type('html').send(page('', '<chatwarden-hub base-url="/admin" mode="detailed"></chatwarden-hub>')));
  app.get('/hostile', (_req, res) =>
    res.type('html').send(page('<style>button, a, div, h1, h2 { color: red !important; background: lime !important; font: 40px serif !important; }</style>', '<button id="page-button">page button</button><chatwarden-hub base-url="/admin"></chatwarden-hub>')),
  );
  // No style-src and a default-src of 'none': an inline <style> or style attribute would be blocked. Constructable stylesheets are not.
  app.get('/strict', (_req, res) => res.type('html').set('content-security-policy', "default-src 'none'; script-src 'self'; connect-src 'self'").send(page('', undefined, false)));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
    console.warn(`browser smoke skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

interface Watched {
  page: Page;
  problems: string[];
}

/** A page in a fresh context, with console errors, page errors and failed requests collected. */
async function open(path: string, options: { width?: number; height?: number; colorScheme?: 'light' | 'dark' } = {}): Promise<Watched> {
  const context = await (browser as Browser).newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const p = await context.newPage();
  const problems: string[] = [];
  p.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await p.goto(`${origin}${path}`);
  await p.locator('chatwarden-hub .cw-body').waitFor({ timeout: 15_000 });
  return { page: p, problems };
}

const needsBrowser = (ctx: { skip: () => void }): void => {
  if (browser === null) ctx.skip();
};

describe('a bare page with a script tag and the element', () => {
  it('draws the hub with no console errors, and none of it is in the page itself', async (ctx) => {
    needsBrowser(ctx);
    const { page: p, problems } = await open('/');
    expect(await p.locator('chatwarden-hub').count()).toBe(1);
    // Playwright pierces open shadow roots; the page's own DOM has no hub nodes.
    expect(await p.evaluate(() => document.querySelector('.cw-hub'))).toBeNull();
    expect(await p.evaluate(() => document.querySelector('chatwarden-hub')?.shadowRoot?.querySelector('.cw-hub') !== null)).toBe(true);
    await p.getByRole('heading', { name: 'Cases', exact: true }).waitFor();
    await p.getByText('3 people are waiting for a decision.').waitFor();
    // Only the page's own <style> is in <head>: the hub adds none.
    expect(await p.evaluate(() => document.head.querySelectorAll('style').length)).toBe(1);
    expect(problems).toEqual([]);
    await p.context().close();
  });

  it('decides a case: the Undo window passes, the server records it, cw-decided fires with the report and the verdict', async (ctx) => {
    needsBrowser(ctx);
    const { page: p, problems } = await open('/');
    await p.evaluate(() => {
      (window as unknown as { decided: unknown[] }).decided = [];
      document.addEventListener('cw-decided', (e) => (window as unknown as { decided: unknown[] }).decided.push((e as CustomEvent).detail));
    });
    // Simple: the home shows the queue; "Take next case" opens the oldest case as one card with the suggestion a click away.
    await p.getByRole('button', { name: /^Take next case/ }).first().click();
    const card = p.getByRole('region', { name: 'Decision' });
    await card.waitFor();
    const sent = p.waitForResponse((r) => r.request().method() === 'POST' && /\/admin\/reports\/[^/]+\/decide$/.test(r.url()), { timeout: 15_000 });
    // The first button of the card is its suggested action (a warning or a restriction, by the category).
    await card.getByRole('button').first().click();
    await p.getByRole('button', { name: /^Undo/ }).first().waitFor();
    const res = await sent;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({ verdict: expect.any(String) });
    const id = /\/reports\/([^/]+)\/decide/.exec(res.url())?.[1] as string;
    await p.waitForFunction(() => (window as unknown as { decided: unknown[] }).decided.length > 0);
    const decided = await p.evaluate(() => (window as unknown as { decided: unknown[] }).decided);
    expect(decided).toEqual([{ reportId: id, verdict: res.request().postDataJSON().verdict }]);
    // The real routes applied it: the report is closed on the server.
    expect(world.cw.reports.get(id)?.status).not.toBe('open');
    expect(problems).toEqual([]);
    await p.context().close();
  }, 60_000);

  it('page CSS does not leak in: a hostile stylesheet changes the page button and not the hub', async (ctx) => {
    needsBrowser(ctx);
    const { page: p } = await open('/hostile');
    const colours = await p.evaluate(() => {
      const outside = document.getElementById('page-button') as HTMLElement;
      const root = document.querySelector('chatwarden-hub')?.shadowRoot as ShadowRoot;
      const inner = root.querySelector('button.cw-btn, button') as HTMLElement;
      const heading = root.querySelector('h1, h2') as HTMLElement;
      return {
        outside: getComputedStyle(outside).color,
        outsideBackground: getComputedStyle(outside).backgroundColor,
        inside: getComputedStyle(inner).color,
        insideBackground: getComputedStyle(inner).backgroundColor,
        headingColor: getComputedStyle(heading).color,
        headingSize: getComputedStyle(heading).fontSize,
        hubFont: getComputedStyle(root.querySelector('.cw-hub') as HTMLElement).fontSize,
      };
    });
    // The control: the rule does reach the page's own button.
    expect(colours.outside).toBe('rgb(255, 0, 0)');
    expect(colours.outsideBackground).toBe('rgb(0, 255, 0)');
    // ...and does not reach anything in the hub.
    expect(colours.inside).not.toBe('rgb(255, 0, 0)');
    expect(colours.insideBackground).not.toBe('rgb(0, 255, 0)');
    expect(colours.headingColor).not.toBe('rgb(255, 0, 0)');
    expect(colours.headingSize).not.toBe('40px');
    expect(colours.hubFont).not.toBe('40px');
    await p.context().close();
  });

  it('values for --cw-* set on the element or on an ancestor pass in, and the hub\'s own defaults fill the rest', async (ctx) => {
    needsBrowser(ctx);
    const { page: p } = await open('/');
    // One value on an ancestor (body), the others on the element itself.
    await p.addStyleTag({ content: 'body { --cw-ink: rgb(9, 8, 7); } chatwarden-hub { --cw-accent: rgb(1, 2, 3); --cw-hub-height: 500px; --cw-radius-s: 2px; }' });
    // The hub's colours transition for a moment; let them settle.
    await p.waitForTimeout(500);
    const seen = await p.evaluate(() => {
      const root = (document.querySelector('chatwarden-hub') as HTMLElement).shadowRoot as ShadowRoot;
      const hub = root.querySelector('.cw-hub') as HTMLElement;
      const primary = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Take next case')) as HTMLElement;
      return {
        // From the ancestor: the hub's text colour.
        colour: getComputedStyle(hub).color,
        // From the element: the height, the primary button's fill, and a corner radius.
        height: getComputedStyle(hub).height,
        fill: getComputedStyle(primary).backgroundColor,
        radius: getComputedStyle(primary).borderTopLeftRadius,
        host: getComputedStyle(document.querySelector('chatwarden-hub') as HTMLElement).display,
      };
    });
    expect(seen).toEqual({ colour: 'rgb(9, 8, 7)', height: '500px', fill: 'rgb(1, 2, 3)', radius: '2px', host: 'block' });
    // A token the page did not set keeps the hub's own default (light-dark() is resolved where it is used).
    const surface = await p.evaluate(() => getComputedStyle((document.querySelector('chatwarden-hub') as HTMLElement).shadowRoot?.querySelector('.cw-hub') as HTMLElement).backgroundColor);
    expect(surface).toBe('rgb(244, 245, 248)');
    await p.context().close();
  });

  it('follows the visitor\'s dark scheme, and the theme attribute overrides it', async (ctx) => {
    needsBrowser(ctx);
    const { page: p } = await open('/', { colorScheme: 'dark' });
    const background = () => p.evaluate(() => getComputedStyle((document.querySelector('chatwarden-hub') as HTMLElement).shadowRoot?.querySelector('.cw-hub') as HTMLElement).backgroundColor);
    expect(await background()).toBe('rgb(14, 19, 28)');
    await p.evaluate(() => document.querySelector('chatwarden-hub')?.setAttribute('theme', 'light'));
    await p.waitForFunction(() => document.querySelector('chatwarden-hub')?.shadowRoot?.querySelector('.cw-hub')?.getAttribute('data-cw-theme') === 'light');
    expect(await background()).toBe('rgb(244, 245, 248)');
    await p.context().close();
  });

  it('the command bar and the shortcut sheet open inside the shadow root, cover the window, and take Tab and Escape', async (ctx) => {
    needsBrowser(ctx);
    const { page: p, problems } = await open('/detailed');
    await p.locator('chatwarden-hub .cw-skip').focus();
    await p.keyboard.press('Control+k');
    const dialog = p.getByRole('dialog', { name: 'Command bar' });
    await dialog.waitFor();
    expect(await p.evaluate(() => document.body.querySelector('[role="dialog"]'))).toBeNull();
    // The scrim is fixed over the whole window: the hub's stylesheet reaches it.
    const scrim = await p.locator('chatwarden-hub .cw-scrim').boundingBox();
    expect(scrim).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
    expect(await p.evaluate(() => document.querySelector('chatwarden-hub')?.shadowRoot?.activeElement?.tagName)).toBe('INPUT');
    await p.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(await p.evaluate(() => document.querySelector('chatwarden-hub')?.shadowRoot?.activeElement?.className)).toBe('cw-skip');
    await p.keyboard.press('?');
    const sheet = p.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await sheet.waitFor();
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press('Tab');
      expect(await sheet.evaluate((el) => el.contains((el.getRootNode() as ShadowRoot).activeElement))).toBe(true);
    }
    await p.keyboard.press('Escape');
    expect(problems).toEqual([]);
    await p.context().close();
  });

  it('J and K move between cases when focus is inside the hub, and nothing happens while the page has focus', async (ctx) => {
    needsBrowser(ctx);
    const { page: p } = await open('/detailed');
    await p.locator('chatwarden-hub .cw-queue .cw-case-link').first().waitFor();
    const active = () => p.evaluate(() => document.querySelector('chatwarden-hub')?.shadowRoot?.activeElement?.getAttribute('href') ?? null);
    const links = await p.locator('chatwarden-hub .cw-queue .cw-case-link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    // (One of the three cases was decided by the test above.)
    expect(links.length).toBeGreaterThanOrEqual(2);
    await p.locator('chatwarden-hub .cw-queue .cw-case-link').first().focus();
    await p.keyboard.press('j');
    expect(await active()).toBe(links[1]);
    await p.keyboard.press('k');
    expect(await active()).toBe(links[0]);
    await p.keyboard.press('j');
    expect(await active()).toBe(links[1]);
    // Focus goes to the page: the same keys do nothing to the hub.
    await p.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    await p.keyboard.press('j');
    await p.keyboard.press('?');
    expect(await active()).toBeNull();
    expect(await p.getByRole('dialog').count()).toBe(0);
    await p.context().close();
  });

  it('under a strict CSP with no style-src, the hub is still styled (constructable stylesheets need no unsafe-inline)', async (ctx) => {
    needsBrowser(ctx);
    const { page: p, problems } = await open('/strict');
    const look = await p.evaluate(() => {
      const hub = (document.querySelector('chatwarden-hub') as HTMLElement).shadowRoot?.querySelector('.cw-hub') as HTMLElement;
      const shadow = hub.getRootNode() as ShadowRoot;
      return { display: getComputedStyle(hub).display, background: getComputedStyle(hub).backgroundColor, adopted: shadow.adoptedStyleSheets.length, styleElements: shadow.querySelectorAll('style').length };
    });
    expect(look).toEqual({ display: 'flex', background: 'rgb(244, 245, 248)', adopted: 1, styleElements: 0 });
    expect(problems.filter((m) => /content security policy|refused to apply/i.test(m))).toEqual([]);
    await p.context().close();
  });

  it('takes screenshots at 1440 and 360, light and dark', async (ctx) => {
    needsBrowser(ctx);
    mkdirSync(SHOTS, { recursive: true });
    for (const width of [1440, 360] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const [name, path] of [['simple', '/'], ['detailed', '/detailed']] as const) {
          const { page: p, problems } = await open(path, { width, height: width === 1440 ? 900 : 740, colorScheme: scheme });
          await p.locator('chatwarden-hub .cw-case-name, chatwarden-hub .cw-screen-title').first().waitFor();
          await p.waitForTimeout(300);
          await p.screenshot({ path: join(SHOTS, `hub-element-${name}-${width}-${scheme}.png`) });
          expect(problems).toEqual([]);
          await p.context().close();
        }
      }
    }
  }, 120_000);
});

describe('the smoke fixtures', () => {
  it('seeded three real reports for the pages to show', () => {
    expect(reports).toHaveLength(3);
  });
});
