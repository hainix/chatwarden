// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toExpress } from '@chatwarden/http/express';
import express from 'express';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWN_WORD } from './communityWorld.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A real browser (Chromium, through Playwright) opens the hub with the shared term list wired (the real routes, a fake loader and a fake
// share object behind them) and checks the three places the community list touches: the Terms screen (unchanged), the Share disclosure
// in the term editor, and Settings > Community list. At 1280 and 360 px, light and dark: no console error, nothing scrolls sideways, and
// the screenshots are taken (to CW_SHOTS_DIR, else the OS temp directory) for a person to look at.
//
// It needs a Chromium install (`npx playwright install chromium`). Without one the tests skip, unless CW_REQUIRE_BROWSER=1.

const SHOTS = process.env.CW_SHOTS_DIR ?? join(tmpdir(), 'cw-hub-element-shots');
const page = (element: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moderation</title><style>body { margin: 0 }</style></head><body><script type="module" src="/hub-element.js"></script>${element}</body></html>`;

let browser: Browser | null = null;
let server: Server;
let origin = '';
let dir = '';
let world: HubWorld;
let plain: HubWorld;
let plainServer: Server;
let plainOrigin = '';

const listen = (app: express.Express): Promise<Server> =>
  new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
const originOf = (s: Server): string => {
  const address = s.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
};

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-hub-element-community-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  const script = readFileSync(join(dir, 'hub-element.js'));

  // A server that wired the shared list (nothing applied yet, a version waiting), with one term of its own to share.
  world = await hubWorld({ role: 'owner', gameName: 'Dragon Duel', community: { seed: false } });
  await world.direct.addTerm({ term: OWN_WORD, language: 'en' });
  // A server that did not: the same hub, no community routes.
  plain = await hubWorld({ role: 'owner', gameName: 'Dragon Duel' });

  const serve = (w: HubWorld): express.Express => {
    const app = express();
    app.use('/admin', toExpress(w.routes));
    app.get('/hub-element.js', (_req, res) => res.type('text/javascript').send(script));
    app.get('/detailed', (_req, res) => res.type('html').send(page('<chatwarden-hub base-url="/admin" mode="detailed"></chatwarden-hub>')));
    return app;
  };
  server = await listen(serve(world));
  origin = originOf(server);
  plainServer = await listen(serve(plain));
  plainOrigin = originOf(plainServer);

  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
    console.warn(`Community browser check skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
  }
}, 180_000);

afterAll(async () => {
  await browser?.close();
  for (const s of [server, plainServer]) await new Promise<void>((resolve) => (s === undefined ? resolve() : s.close(() => resolve())));
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

interface Watched {
  page: Page;
  problems: string[];
}

async function open(base: string, hash: string, o: { width: number; scheme: 'light' | 'dark' }): Promise<Watched> {
  const context = await (browser as Browser).newContext({ viewport: { width: o.width, height: o.width < 600 ? 780 : 900 }, colorScheme: o.scheme });
  const p = await context.newPage();
  const problems: string[] = [];
  p.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await p.goto(`${base}/detailed${hash}`);
  await p.locator('chatwarden-hub .cw-body').first().waitFor({ timeout: 15_000 });
  return { page: p, problems };
}

/** The page never scrolls sideways: its width is the window's. */
const sideways = (p: Page): Promise<{ page: number; window: number }> => p.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));

const needsBrowser = (ctx: { skip: () => void }): void => {
  if (browser === null) ctx.skip();
};

const SIZES = [
  { name: '1280', width: 1280 },
  { name: '360', width: 360 },
] as const;

describe.each(SIZES)('the community list in a real browser, $name px', ({ name, width }) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    it('the Terms screen and the editor with the Share disclosure: closed, open, and after a send', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open(origin, '#/terms', { width, scheme });
      await p.getByRole('heading', { name: 'Terms', level: 2 }).waitFor({ timeout: 15_000 });
      await p.getByRole('region', { name: /^English/ }).waitFor();
      await p.screenshot({ path: join(SHOTS, `k7-terms-${name}-${scheme}.png`) });
      // Show words, then edit the term of our own.
      await p.getByRole('checkbox', { name: 'Show words' }).check();
      await p.getByRole('button', { name: `Edit ${OWN_WORD}` }).click();
      const toggle = p.getByRole('button', { name: 'Share with the community list' });
      await toggle.waitFor({ timeout: 15_000 });
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      await p.screenshot({ path: join(SHOTS, `k7-share-closed-${name}-${scheme}.png`) });
      await toggle.click();
      await p.getByRole('group', { name: 'What will be sent' }).waitFor();
      await p.screenshot({ path: join(SHOTS, `k7-share-open-${name}-${scheme}.png`), fullPage: true });
      let wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways with the disclosure open').toBeLessThanOrEqual(wide.window);
      await p.getByRole('button', { name: 'Send' }).click();
      await p.getByText(/^Sent\. Status:/).waitFor();
      await p.screenshot({ path: join(SHOTS, `k7-share-sent-${name}-${scheme}.png`), fullPage: true });
      wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);

    it('Settings > Community list: the status, the question before an apply, a failed check, and a word that is not there', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open(origin, '#/settings/community', { width, scheme });
      await p.getByRole('heading', { name: 'Community list', level: 2 }).waitFor({ timeout: 15_000 });
      await p.getByText('No community list is in use yet.').waitFor();
      await p.screenshot({ path: join(SHOTS, `k7-community-${name}-${scheme}.png`), fullPage: true });
      await p.getByRole('button', { name: /^Apply version/ }).click();
      await p.getByText('Apply this version now? It cannot be undone from here.').waitFor();
      await p.screenshot({ path: join(SHOTS, `k7-community-apply-${name}-${scheme}.png`), fullPage: true });
      await p.getByRole('button', { name: 'Cancel' }).click();
      world.community!.rig.onRefresh = () => {
        world.community!.rig.current = { ...world.community!.rig.current, state: 'failed', lastError: { code: 'bad_signature', stage: 'verify', at: 1 } };
      };
      await p.getByRole('button', { name: 'Check now' }).click();
      await p.getByText('The last check had a problem: the signature did not verify.').waitFor();
      await p.getByLabel('Word to find').fill('nothingatall');
      const before = problems.length;
      await p.getByRole('button', { name: 'Find' }).click();
      await p.getByText('That word is not in your list.').waitFor();
      // A word that is not there is a 404 by design, and a browser logs a 404 as an error: that one line, and nothing else, is expected.
      expect(problems.slice(before)).toEqual(['console.error: Failed to load resource: the server responded with a status of 404 (Not Found)']);
      problems.length = before;
      await p.screenshot({ path: join(SHOTS, `k7-community-problem-${name}-${scheme}.png`), fullPage: true });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      // The failed check is expected to be shown, not logged: the page itself must have said nothing.
      expect(problems).toEqual([]);
      world.community!.rig.onRefresh = () => undefined;
      world.community!.rig.current = { ...world.community!.rig.current, state: 'ready', lastError: null };
      await p.context().close();
    }, 60_000);

    it('on a server without the community list there is no section, no link, no disclosure and no failed request', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open(plainOrigin, '#/settings', { width, scheme });
      await p.getByRole('heading', { name: 'Steps and ladder', level: 2 }).first().waitFor({ timeout: 15_000 });
      expect(await p.getByRole('link', { name: 'Community list' }).count()).toBe(0);
      await p.goto(`${plainOrigin}/detailed#/terms`);
      await p.getByRole('region', { name: /^English/ }).waitFor({ timeout: 15_000 });
      await p.getByRole('checkbox', { name: 'Show words' }).check();
      await p.getByRole('button', { name: /^Edit zorbak$/ }).click();
      await p.getByRole('form', { name: 'Edit a term' }).waitFor();
      await p.waitForTimeout(400);
      expect(await p.getByRole('button', { name: 'Share with the community list' }).count()).toBe(0);
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);
  });
});
