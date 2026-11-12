// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRead } from '@chatwarden/core';
import type { AIRead, AIReadInput } from '@chatwarden/core';
import { toExpress } from '@chatwarden/http/express';
import express from 'express';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A real browser (Chromium, through Playwright) opens the hub with the AI on (level 2, the scripted fake behind the real routes) and checks
// the parts the AI added: the strip on a case, the pre-filled decision bar and its Accept button, the chip in the queue, and Settings > AI.
// At 1280 and 360 px, light and dark: no console error, nothing scrolls sideways, and the screenshots are taken (to CW_SHOTS_DIR, else the
// OS temp directory) for a person to look at.
//
// It needs a Chromium install (`npx playwright install chromium`). Without one the tests skip, unless CW_REQUIRE_BROWSER=1.

const SHOTS = process.env.CW_SHOTS_DIR ?? join(tmpdir(), 'cw-hub-element-shots');
const page = (element: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moderation</title><style>body { margin: 0 }</style></head><body><script type="module" src="/hub-element.js"></script>${element}</body></html>`;

/** The first call reads a rude line under rule 2 (a warning), the second hostile (a 24 hour restriction), the third severe (over the ceiling). */
const READS: Array<Partial<AIRead>> = [
  { severity: 'rude', rule: 2, summary: 'The reported player insulted the other player twice in chat.' },
  { severity: 'hostile', rule: 2, summary: 'Sustained abuse aimed at one player across several lines, with a threat to follow them to other rooms.' },
  { severity: 'severe', rule: 1, summary: 'A slur aimed at the other player.' },
];

let browser: Browser | null = null;
let server: Server;
let origin = '';
let dir = '';
let world: HubWorld;
let reports: Array<{ id: string }> = [];

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-hub-element-ai-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  const script = readFileSync(join(dir, 'hub-element.js'));

  world = await hubWorld({
    role: 'owner',
    gameName: 'Dragon Duel',
    ai: {
      level: 2,
      script: (input: AIReadInput, ctx) => {
        const over = READS[ctx.call - 1] ?? {};
        const base = fakeRead(input);
        const severity = over.severity ?? base.severity;
        const rule = over.rule ?? 2;
        return { output: { ...base, ...over, severity, rule, recommendation: base.recommendation === null ? null : { ...base.recommendation, severity, rule } } };
      },
    },
  });
  world.clock.t = Date.now() - 90 * 60_000;
  const lines = [
    { who: 'reporter' as const, text: 'gg, that was close' },
    { who: 'target' as const, text: 'you are completely useless, uninstall the game' },
    { who: 'bystander' as const, text: 'relax, it is only a game' },
    { who: 'target' as const, text: 'stay out of my rooms or I will follow you everywhere' },
  ];
  reports = [];
  for (const [target, reporter, room] of [
    ['Mallory', 'Rae', 'one'],
    ['Zed', 'Kit', 'two'],
    ['Pix', 'Sam', 'three'],
  ] as const) {
    reports.push(await world.fileRich({ target, reporter, room, lines, note: 'They keep following me from room to room.' }));
    await world.aiIdle();
    world.clock.t += 7 * 60_000;
  }

  const app = express();
  app.use('/admin', toExpress(world.routes));
  app.get('/hub-element.js', (_req, res) => res.type('text/javascript').send(script));
  app.get('/detailed', (_req, res) => res.type('html').send(page('<chatwarden-hub base-url="/admin" mode="detailed"></chatwarden-hub>')));
  app.get('/simple', (_req, res) => res.type('html').send(page('<chatwarden-hub base-url="/admin" mode="simple"></chatwarden-hub>')));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
    console.warn(`AI browser check skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
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

async function open(path: string, hash: string, o: { width: number; scheme: 'light' | 'dark'; height?: number }): Promise<Watched> {
  const context = await (browser as Browser).newContext({ viewport: { width: o.width, height: o.height ?? (o.width < 600 ? 780 : 900) }, colorScheme: o.scheme });
  const p = await context.newPage();
  const problems: string[] = [];
  p.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await p.goto(`${origin}${path}${hash}`);
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

describe.each(SIZES)('the AI in a real browser, $name px', ({ name, width }) => {
  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    it('the strip on a case and the pre-filled decision bar', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open('/detailed', `#/reports/${(reports[0] as { id: string }).id}`, { width, scheme });
      const strip = p.getByRole('region', { name: 'AI read' });
      await strip.waitFor({ timeout: 15_000 });
      await p.screenshot({ path: join(SHOTS, `chunk-e-card-${name}-${scheme}.png`) });
      // The details menu open, for a look at its panel.
      await strip.getByRole('button', { name: 'AI details' }).click();
      await p.screenshot({ path: join(SHOTS, `chunk-e-card-menu-${name}-${scheme}.png`) });
      await p.keyboard.press('Escape');
      // The decision bar: on a phone it is a sheet that opens with Decide.
      const dock = p.getByRole('region', { name: 'Decision' });
      const toggle = dock.getByRole('button', { name: 'Decide…' });
      if (await toggle.isVisible()) await toggle.click();
      const bar = dock.getByRole('group', { name: 'AI suggestion' });
      await bar.waitFor({ timeout: 15_000 });
      await expect(bar.getByText('Suggested by AI').count()).resolves.toBe(1);
      const accept = bar.getByRole('button', { name: /^Accept AI suggestion: / });
      await expect(accept.count()).resolves.toBe(1);
      // The case has been on screen long enough (the act guard's 300 ms) for the button to be live, not drawn as cooling down.
      await p.waitForTimeout(600);
      expect(await accept.getAttribute('aria-disabled'), await bar.innerText()).toBe('false');
      await p.screenshot({ path: join(SHOTS, `chunk-e-prefill-${name}-${scheme}.png`) });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);

    it('the chip in the queue', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open('/detailed', '#/reports', { width, scheme });
      await p.locator('chatwarden-hub .cw-qrow .cw-aichip').first().waitFor({ timeout: 15_000 });
      const chips = await p.locator('chatwarden-hub .cw-qrow .cw-aichip').allTextContents();
      expect(chips.map((c) => c.replace(/^AI read:\s*/, '')).sort()).toEqual(['Hostile', 'Rude', 'Severe']);
      await p.screenshot({ path: join(SHOTS, `chunk-e-queue-${name}-${scheme}.png`) });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);

    it('Settings > AI, with Advanced open', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open('/detailed', '#/settings/ai', { width, scheme });
      await p.getByRole('heading', { name: 'AI', exact: true, level: 2 }).waitFor({ timeout: 15_000 });
      await p.getByText('Working', { exact: true }).waitFor();
      await p.getByRole('button', { name: 'Advanced' }).click();
      await p.getByText('Granted appeals will appear here once appeals exist.').waitFor();
      await p.screenshot({ path: join(SHOTS, `chunk-e-settings-${name}-${scheme}.png`), fullPage: true });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);

    it('the Simple mode card with Accept AI suggestion', async (ctx) => {
      needsBrowser(ctx);
      const { page: p, problems } = await open('/simple', `#/reports/${(reports[1] as { id: string }).id}`, { width, scheme });
      const accept = p.getByRole('button', { name: /^Accept AI suggestion: / });
      await accept.waitFor({ timeout: 15_000 });
      await p.screenshot({ path: join(SHOTS, `chunk-e-simple-${name}-${scheme}.png`) });
      const wide = await sideways(p);
      expect(wide.page, 'the page scrolls sideways').toBeLessThanOrEqual(wide.window);
      expect(problems).toEqual([]);
      await p.context().close();
    }, 60_000);
  });
});
