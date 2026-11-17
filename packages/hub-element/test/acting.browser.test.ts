// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiActionRow } from '@chatwarden/core';
import { toExpress } from '@chatwarden/http/express';
import { MemoryStore, withMemoryAi, withMemoryAppeals } from '@chatwarden/store-memory';
import express from 'express';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A real browser (Chromium, through Playwright) opens Settings > AI for AI levels 3 and 4, release 2: the Act option, the owner's dialog, the status line with Pause, and
// Advanced > "Would have acted". At 1280 and 360 px, light and dark: no console error, nothing scrolls sideways (the list scrolls inside its own box), and the screenshots
// are taken (to CW_SHOTS_DIR, else the OS temp directory) for a person to look at. It needs a Chromium install (`npx playwright install chromium`); without one the tests
// skip, unless CW_REQUIRE_BROWSER=1.

const SHOTS = process.env.CW_SHOTS_DIR ?? join(tmpdir(), 'cw-hub-element-shots');
const page = (element: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moderation</title><style>body { margin: 0 }</style></head><body><script type="module" src="/hub-element.js"></script>${element}</body></html>`;

let browser: Browser | null = null;
let server: Server;
let origin = '';
let dir = '';
let world: HubWorld;

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-hub-element-acting-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  const script = readFileSync(join(dir, 'hub-element.js'));

  const store = withMemoryAppeals(withMemoryAi(new MemoryStore()));
  world = await hubWorld({
    role: 'owner',
    gameName: 'Dragon Duel',
    store,
    overrides: { appeals: { enabled: true, perPlayerPerWeek: 20 } },
    ai: { level: 2, options: { maxLevel: 3, act: {} } },
  });
  // The owner takes the shadow step (the real transition), and three reports each have a "would have applied" row.
  const started = world.cw.ai.acting.startShadow('owen@example.test', { confirm: 'ACT', reason: 'Trying shadow' });
  if (!started.ok) throw new Error(`startShadow refused: ${started.error}`);
  const insert = (store as unknown as { insertAiAction(row: AiActionRow): boolean }).insertAiAction.bind(store);
  const now = world.clock.t;
  for (let i = 0; i < 3; i++) {
    const f = await world.file({ target: `Mallory${i}`, reporter: `Rae${i}`, room: `room-${i}` });
    insert({
      id: `browser-act-${i}`,
      reportId: f.id,
      readId: `browser-read-${i}`,
      confirmReadId: `browser-confirm-${i}`,
      rule: '2',
      severity: 'hostile',
      state: 'shadow',
      refusedCode: null,
      notBefore: now,
      createdAt: now + 60_000 * (i + 1),
      groupId: null,
      kind: i === 0 ? 'warning' : 'chat',
      durationMs: i === 0 ? null : 86_400_000,
      actedAt: now + 60_000 * (i + 1),
      reviewDueAt: null,
      reviewedAt: null,
      reviewedBy: null,
      undoCode: null,
      undoNote: null,
      adapter: 'fake',
      promptVersion: 5,
    });
  }

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
    console.warn(`Acting browser check skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
  }
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

async function open(hash: string, o: { width: number; scheme: 'light' | 'dark' }): Promise<{ page: Page; problems: string[] }> {
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
] as const)('acting in Settings > AI in a real browser, $name px', ({ name, width }) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    it('the status line says shadow, Pause is one click away, and Advanced lists what it would have done', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open('#/settings/ai', { width, scheme });
      await p.getByRole('heading', { name: 'AI', exact: true, level: 2 }).waitFor({ timeout: 15_000 });
      await p.getByText(/^Shadow since .*: would have acted 3 times\.$/).waitFor({ timeout: 15_000 });
      expect(await p.getByRole('button', { name: 'Pause acting' }).count()).toBe(1);
      await p.getByRole('button', { name: 'Advanced' }).click();
      const table = p.getByRole('table', { name: 'Would have acted' });
      await table.waitFor({ timeout: 15_000 });
      expect(await table.getByRole('row').count()).toBe(1 + 3);
      expect(await table.getByRole('button').count()).toBe(0);
      expect(await p.locator('a[download]').count()).toBe(0);
      await p.screenshot({ path: join(SHOTS, `acting-shadow-${name}-${scheme}.png`), fullPage: true });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);
  });
});

describe.each([
  { name: '1280', width: 1280 },
  { name: '360', width: 360 },
] as const)('the Act dialog in a real browser, $name px', ({ name, width }) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    it('opens for the owner, keeps its button off until ACT and a reason, and fits the screen', async (ctx) => {
      needsBrowser(ctx);
      // Acting is switched off for this check (and back to shadow after), so the option opens the dialog. The dialog is read, never submitted.
      const off = world.cw.ai.acting.off('owen@example.test', { reason: 'For the check' });
      expect(off.ok).toBe(true);
      try {
        const { page: p, problems } = await open('#/settings/ai', { width, scheme });
        await p.getByRole('heading', { name: 'AI', exact: true, level: 2 }).waitFor({ timeout: 15_000 });
        await p.getByRole('radio', { name: /^Act/ }).click({ timeout: 15_000 });
        const dialog = p.getByRole('dialog', { name: 'Switch on acting' });
        await dialog.waitFor({ timeout: 15_000 });
        expect(await dialog.getByRole('listitem').count()).toBe(5);
        const start = dialog.getByRole('button', { name: 'Start shadow mode' });
        expect(await start.isDisabled()).toBe(true);
        await dialog.getByRole('textbox', { name: /Type ACT to confirm/ }).fill('ACT');
        await dialog.getByRole('textbox', { name: /Why are you turning this on/ }).fill('A reason');
        expect(await start.isDisabled()).toBe(false);
        await p.screenshot({ path: join(SHOTS, `acting-dialog-${name}-${scheme}.png`), fullPage: true });
        // the dialog fits the screen: its box is inside the window
        const box = await dialog.boundingBox();
        expect(box === null || box.x >= -1).toBe(true);
        expect(box === null || box.x + box.width <= width + 1).toBe(true);
        const wide = await sideways(p);
        expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
        expect(problems).toEqual([]);
        await p.context().close();
      } finally {
        const back = world.cw.ai.acting.startShadow('owen@example.test', { confirm: 'ACT', reason: 'Back to shadow' });
        expect(back.ok, 'shadow is restored for the next check').toBe(true);
      }
    }, 60_000);
  });
});
