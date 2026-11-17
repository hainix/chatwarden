// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiOutcomeInsert } from '@chatwarden/core';
import { toExpress } from '@chatwarden/http/express';
import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import express from 'express';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A real browser (Chromium, through Playwright) opens the hub's two parts of AI levels 3 and 4, release 1: Settings > AI > Advanced > "Where the AI may act" (the
// read-only gate table) and the Person page's "Do not automate" mark with its "..." item. At 1280 and 360 px, light and dark: no console error, nothing scrolls
// sideways (the table scrolls inside its own box), the gate table is in the page, and the screenshots are taken (to CW_SHOTS_DIR, else the OS temp directory) for a
// person to look at. It needs a Chromium install (`npx playwright install chromium`); without one the tests skip, unless CW_REQUIRE_BROWSER=1.

const SHOTS = process.env.CW_SHOTS_DIR ?? join(tmpdir(), 'cw-hub-element-shots');
const page = (element: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moderation</title><style>body { margin: 0 }</style></head><body><script type="module" src="/hub-element.js"></script>${element}</body></html>`;

let browser: Browser | null = null;
let server: Server;
let origin = '';
let dir = '';
let world: HubWorld;
let marked = '';
let unmarked = '';

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-hub-element-gates-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  const script = readFileSync(join(dir, 'hub-element.js'));

  const store = withMemoryAi(new MemoryStore());
  world = await hubWorld({ role: 'owner', gameName: 'Dragon Duel', store, overrides: { aiAutoAct: ['hostile', 'severe'] }, ai: { level: 2 } });
  const insert = (store as unknown as { insertAiOutcome(r: AiOutcomeInsert): boolean }).insertAiOutcome.bind(store);
  const now = world.clock.t;
  for (let i = 0; i < 120; i++) {
    insert({
      reportId: `browser-g-${i}`,
      readId: null,
      decidedAt: now - 86_400_000 - Math.floor((i / 120) * 58 * 86_400_000),
      level: 2,
      verdict: 'upheld',
      rule: '2',
      severity: 'hostile',
      aiVerdict: 'upheld',
      agreement: 'agree',
      detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
      badFaith: false,
      example: null,
      aiRule: '2',
      aiSeverity: 'hostile',
      aiConfidence: 'high',
      decidedBy: i % 2 === 0 ? 'mod_a' : 'mod_b',
      source: 'human',
    });
  }
  const a = await world.file({ target: 'Mallory', reporter: 'Rae', room: 'one' });
  const b = await world.file({ target: 'Zed', reporter: 'Kit', room: 'two' });
  marked = a.person;
  unmarked = b.person;
  world.cw.people.automation.set(marked, { allowed: false, code: 'vulnerable', actor: 'sen_bea' });

  const app = express();
  app.use('/admin', toExpress(world.routes));
  app.get('/hub-element.js', (_req, res) => res.type('text/javascript').send(script));
  app.get('/detailed', (_req, res) => res.type('html').send(page('<chatwarden-hub base-url="/admin" mode="detailed"></chatwarden-hub>')));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
    console.warn(`Gate table browser check skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
  }
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

interface Watched {
  page: Page;
  problems: string[];
}

async function open(hash: string, o: { width: number; scheme: 'light' | 'dark' }): Promise<Watched> {
  const context = await (browser as Browser).newContext({ viewport: { width: o.width, height: o.width < 600 ? 780 : 900 }, colorScheme: o.scheme });
  const p = await context.newPage();
  const problems: string[] = [];
  p.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await p.goto(`${origin}/detailed${hash}`);
  await p.locator('chatwarden-hub .cw-body').first().waitFor({ timeout: 15_000 });
  return { page: p, problems };
}

const sideways = (p: Page): Promise<{ page: number; window: number }> => p.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
const needsBrowser = (ctx: { skip: () => void }): void => {
  if (browser === null) ctx.skip();
};

describe.each([
  { name: '1280', width: 1280 },
  { name: '360', width: 360 },
] as const)('the gate table and the Person mark in a real browser, $name px', ({ name, width }) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    it('Settings > AI > Advanced shows the gate table, read-only, and nothing scrolls sideways', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open('#/settings/ai', { width, scheme });
      await p.getByRole('heading', { name: 'AI', exact: true, level: 2 }).waitFor({ timeout: 15_000 });
      await p.getByRole('button', { name: 'Advanced' }).click();
      const table = p.getByRole('table', { name: 'Gates for each rule and conduct level' });
      await table.waitFor({ timeout: 15_000 });
      await p.getByText(/In this version the AI applies nothing to a player/).first().waitFor();
      expect(await table.locator('input, select, textarea').count()).toBe(0);
      // the seeded cell: volume and breadth are met; without appeals nothing opens
      const row = table.getByRole('row', { name: /^Rule 2, Hostile/ });
      expect(await row.innerText()).toContain('120 of 100 decisions');
      await p.getByRole('button', { name: /^Never acted on by the AI/ }).click();
      await p.screenshot({ path: join(SHOTS, `gates-table-${name}-${scheme}.png`), fullPage: true });
      const wide = await sideways(p);
      const culprits = wide.page > wide.window ? await p.evaluate(() => { const out: string[] = []; const walk = (root: Document | ShadowRoot | Element): void => { for (const e of Array.from(root.querySelectorAll('*'))) { const r = e.getBoundingClientRect(); if (r.right > window.innerWidth + 1) out.push(`${e.tagName}.${(e as HTMLElement).className} ${Math.round(r.width)}`); if ((e as HTMLElement).shadowRoot) walk((e as HTMLElement).shadowRoot as ShadowRoot); } }; walk(document); return out.slice(0, 12); }) : [];
      expect(wide.page, `the page scrolls sideways: ${culprits.join(' | ')}`).toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);

    // Review R1 final M6: `.cw-scroll { position: relative }` (the 360 px fix for the gate table) is global to every `Scroll` user, so other table screens are checked too.
    for (const hash of ['#/settings/ladder', '#/audit', '#/guide']) {
      it(`another table screen (${hash}) still lays out with no sideways scroll and its table scrolls inside its own box`, async (ctx) => {
        needsBrowser(ctx);
        const { page: p, problems } = await open(hash, { width, scheme });
        await p.locator('chatwarden-hub .cw-scroll').first().waitFor({ timeout: 15_000 });
        const boxes = await p.evaluate(() => Array.from(document.querySelectorAll('chatwarden-hub'))[0]?.shadowRoot?.querySelectorAll('.cw-scroll').length ?? document.querySelectorAll('.cw-scroll').length);
        expect(boxes).toBeGreaterThan(0);
        const wide = await sideways(p);
        expect(wide.page, `${hash} scrolls sideways`).toBeLessThanOrEqual(wide.window);
        expect(problems).toEqual([]);
        await p.context().close();
      }, 60_000);
    }

    it('the Person page: the quiet line for a marked person, and the "..." item', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open(`#/people/${marked}`, { width, scheme });
      await p.getByText(/Do not automate: the AI never acts on this person/).waitFor({ timeout: 15_000 });
      await p.getByRole('button', { name: 'More' }).click();
      await p.getByRole('group', { name: 'Do not automate' }).waitFor();
      await p.getByRole('button', { name: 'Allow the AI again' }).waitFor();
      await p.screenshot({ path: join(SHOTS, `gates-person-marked-${name}-${scheme}.png`), fullPage: true });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);

    it('an unmarked person has no line, and the picker marks them', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open(`#/people/${unmarked}`, { width, scheme });
      await p.getByRole('button', { name: 'More' }).click();
      const group = p.getByRole('group', { name: 'Do not automate' });
      await group.waitFor({ timeout: 15_000 });
      expect(await p.getByText(/Do not automate: the AI never acts on this person/).count()).toBe(0);
      await group.getByLabel('Reason').selectOption('under_review');
      await p.screenshot({ path: join(SHOTS, `gates-person-picker-${name}-${scheme}.png`), fullPage: true });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);
  });
});
