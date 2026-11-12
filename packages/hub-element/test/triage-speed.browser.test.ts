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
import axe from 'axe-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Triage speed in a real browser (Chromium, through Playwright): the hub element on a bare page over a real Express app that mounts the
// kit's real staff routes. 40 seeded reports (a habitual false reporter, one person with 12 reports, ordinary cases) are cleared by
// keyboard: 2 to dismiss, U to take back, J and K to move, 1 for the suggested step; then bulk dismiss with its confirm and Undo, and the
// reporter-accuracy display. It also takes the screenshots (1440 and 390 wide, light and dark).
//
// It needs a Chromium install (`npx playwright install chromium`). Without one the tests skip, unless CW_REQUIRE_BROWSER=1.
// Run on its own: `CW_REQUIRE_BROWSER=1 npx vitest run --project hub-element packages/hub-element/test/triage-speed.browser.test.ts`.
// Screenshots go to CW_SHOTS_DIR, or the OS temp directory: a run never writes into the repository on its own.

const SHOTS = process.env.CW_SHOTS_DIR ?? join(tmpdir(), 'cw-triage-speed-shots');
const page = (element: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moderation</title><style>body { margin: 0 }</style></head><body><script type="module" src="/hub-element.js"></script>${element}</body></html>`;

/** What a moderator sees of the seeded queue: counts the tests check against the server. */
interface Seeded {
  world: HubWorld;
  habitual: { reporter: string; handle: string; targets: string[] };
  crowd: { person: string; handle: string; ids: string[] };
  ordinary: string[];
}

/**
 * 40 open reports: 4 from a habitual false reporter ("Rook": 6 of 6 earlier reports were dismissed, filed oldest so the ranking has
 * something to move), 12 about one person ("Vexa") from 12 reporters, and 24 ordinary cases. The kit's clock is set a few hours before the
 * browser's, so ages read sensibly; earlier history is filed on earlier days (a reporter may file 10 a day).
 */
async function seed(): Promise<Seeded> {
  const world = await hubWorld({ role: 'owner', gameName: 'Dragon Duel', actor: 'ann@example.test' });
  const now = Date.now();
  // History first: Rook filed six reports on six earlier days and every one was dismissed.
  const habitualRef = { reporter: '', handle: 'Rook' };
  for (let d = 6; d >= 1; d -= 1) {
    world.clock.t = now - d * DAY;
    const f = await world.fileRich({ target: `Hist${d}`, reporter: 'Rook', room: `hist-${d}` });
    habitualRef.reporter = f.reporter;
    await world.direct.decide(f.id, { verdict: 'no_action', actions: [] }); // throws if the kit refuses
  }
  world.clock.t = now - 5 * HOUR;
  const targets: string[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const f = await world.fileRich({ target: `Rookvictim${i}`, reporter: 'Rook', room: `rook-${i}` });
    targets.push(f.id);
  }
  const ordinary: string[] = [];
  for (let i = 1; i <= 24; i += 1) {
    world.clock.t += 2 * 60_000;
    const f = await world.fileRich({ target: `Case${String(i).padStart(2, '0')}`, reporter: `Rep${String(i).padStart(2, '0')}`, room: `ord-${i}`, category: i % 3 === 0 ? 'spam' : 'harassment' });
    ordinary.push(f.id);
  }
  const ids: string[] = [];
  let person = '';
  for (let i = 1; i <= 12; i += 1) {
    world.clock.t += 2 * 60_000;
    const f = await world.fileRich({ target: 'Vexa', reporter: `Crowd${String(i).padStart(2, '0')}`, room: `vexa-${i}`, category: 'harassment' });
    ids.push(f.id);
    person = f.person;
  }
  world.clock.t = now - 60_000;
  return { world, habitual: { reporter: habitualRef.reporter, handle: 'Rook', targets }, crowd: { person, handle: 'Vexa', ids }, ordinary };
}

let browser: Browser | null = null;
let dir = '';
const servers: Server[] = [];

/** A bare page with the element, over the real routes of `world`. */
async function serve(world: HubWorld, script: Buffer): Promise<string> {
  const app = express();
  app.use('/admin', toExpress(world.routes));
  app.get('/hub-element.js', (_req, res) => res.type('text/javascript').send(script));
  app.get('/', (_req, res) => res.type('html').send(page('<chatwarden-hub base-url="/admin" router="memory"></chatwarden-hub>')));
  app.get('/detailed', (_req, res) => res.type('html').send(page('<chatwarden-hub base-url="/admin" mode="detailed" router="memory"></chatwarden-hub>')));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

let script: Buffer;
beforeAll(async () => {
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-triage-speed-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  script = readFileSync(join(dir, 'hub-element.js'));
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
    console.warn(`triage-speed browser test skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
  }
  mkdirSync(SHOTS, { recursive: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

const needsBrowser = (ctx: { skip: () => void }): void => {
  if (browser === null) ctx.skip();
};

interface Watched {
  page: Page;
  problems: string[];
  decides: Array<{ id: string; body: Record<string, unknown> }>;
  /** Every POST /reports/dismiss-open the page sent (the dry-run counts included). */
  bulks: Array<Record<string, unknown>>;
}

async function open(origin: string, path: string, options: { width?: number; height?: number; colorScheme?: 'light' | 'dark' } = {}): Promise<Watched> {
  const context = await (browser as Browser).newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const p = await context.newPage();
  const problems: string[] = [];
  const decides: Watched['decides'] = [];
  const bulks: Watched['bulks'] = [];
  p.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  p.on('request', (r) => {
    const m = /\/admin\/reports\/([^/]+)\/decide$/.exec(r.url());
    if (m !== null && r.method() === 'POST') decides.push({ id: m[1] as string, body: r.postDataJSON() as Record<string, unknown> });
    if (r.method() === 'POST' && /\/admin\/reports\/dismiss-open$/.test(r.url())) bulks.push(r.postDataJSON() as Record<string, unknown>);
  });
  await p.goto(`${origin}${path}`);
  await p.locator('chatwarden-hub .cw-body').first().waitFor({ timeout: 15_000 });
  return { page: p, problems, decides, bulks };
}

/** A case accepts an act key only a moment after it appeared (300 ms): wait it out, as a person reading the card would. */
const settle = (p: Page): Promise<void> => p.waitForTimeout(450);
const hub = (p: Page) => p.locator('chatwarden-hub');
const toasts = (p: Page) => hub(p).getByRole('region', { name: 'Notifications' });
const heading = (p: Page) => hub(p).locator('.cw-screen-title').first();

describe('the keyboard clears the queue', () => {
  it('2 several times, U, J and K, 1: every dismissal is sent with no reason typed, and Undo takes one back', async (ctx) => {
    needsBrowser(ctx);
    const seeded = await seed();
    const origin = await serve(seeded.world, script);
    const { page: p, problems, decides } = await open(origin, '/');
    expect(seeded.world.cw.reports.list({ status: 'open', limit: 200 }).items).toHaveLength(40);

    // N takes the next case (the habitual reporter's four are listed last, so an ordinary one comes first).
    await p.keyboard.press('n');
    await hub(p).getByRole('region', { name: /^Case against/ }).waitFor();
    const first = (await heading(p).textContent()) ?? '';
    expect(first).toMatch(/^Case\d\d$/);
    const names: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await settle(p);
      const who = ((await heading(p).textContent()) ?? '').trim();
      names.push(who);
      await p.keyboard.press('2');
      await toasts(p).getByText(`Dismissing ${who} in 5 s.`).waitFor({ timeout: 10_000 });
      // The case moved on at once.
      await p.waitForFunction((was) => (document.querySelector('chatwarden-hub')?.shadowRoot?.querySelector('.cw-screen-title')?.textContent ?? '').trim() !== was, who);
    }
    expect(new Set(names).size).toBe(5);
    // Five held decisions: the newest in full with Undo, the other four on one line.
    await toasts(p).getByText('4 earlier decisions waiting.').first().waitFor();
    await p.waitForTimeout(700); // the toasts fade in
    await p.screenshot({ path: join(SHOTS, 'flow-1440-light-toast-stack.png') });

    // U takes the newest back and shows its case.
    await p.keyboard.press('u');
    await toasts(p).getByText(`Undid the decision on ${names[4]}.`).waitFor();
    await p.waitForFunction((who) => (document.querySelector('chatwarden-hub')?.shadowRoot?.querySelector('.cw-screen-title')?.textContent ?? '').trim() === who, names[4]);
    // J and K: with Quick keys on (Simple) the key opens the case it moves to; they are keys, not the mouse.
    await settle(p);
    const before = ((await heading(p).textContent()) ?? '').trim();
    await p.keyboard.press('j');
    await p.waitForFunction((was) => (document.querySelector('chatwarden-hub')?.shadowRoot?.querySelector('.cw-screen-title')?.textContent ?? '').trim() !== was, before, { timeout: 5_000 });
    // 1 applies the suggested step to the case that is open, then goes on.
    await settle(p);
    const stepped = ((await heading(p).textContent()) ?? '').trim();
    await p.keyboard.press('1');
    await toasts(p).getByText(new RegExp(`Sending the decision on ${stepped}|Dismissing ${stepped}|${stepped}`)).first().waitFor({ timeout: 10_000 });
    // Let every hold pass: the page hides, or 5 s go by.
    await p.waitForTimeout(6_000);
    expect(problems).toEqual([]);

    // The server: 4 dismissals (5 pressed, 1 taken back) with no reason in the request, and one decision from 1 that was not a dismissal.
    const dismissals = decides.filter((d) => d.body.verdict === 'no_action');
    expect(dismissals).toHaveLength(4);
    for (const d of dismissals) expect(d.body).toEqual({ verdict: 'no_action', actions: [] });
    expect(dismissals.map((d) => d.id)).not.toContain(undefined);
    const stepsTaken = decides.filter((d) => d.body.verdict !== 'no_action');
    expect(stepsTaken).toHaveLength(1);
    const open1 = seeded.world.cw.reports.list({ status: 'open', limit: 200 }).items;
    expect(open1).toHaveLength(40 - 5);
    // The stored reason is the kit's standard one, and nobody was marked.
    for (const d of dismissals) {
      const r = seeded.world.cw.reports.get(d.id);
      expect(r?.status).toBe('dismissed');
      expect(r?.badFaith).toBe(false);
    }
    await p.context().close();
  }, 120_000);
});

const link = (p: Page, name: RegExp | string) => hub(p).locator('.cw-queue .cw-case-link').filter({ hasText: name }).first();

describe('bulk dismiss and the reporter figure', () => {
  it('the habitual reporter is listed last and none is hidden; the case says why; bulk dismiss confirms, Undo cancels, then it sends', async (ctx) => {
    needsBrowser(ctx);
    const seeded = await seed();
    const origin = await serve(seeded.world, script);
    const { page: p, problems, bulks } = await open(origin, '/detailed');
    await hub(p).locator('.cw-queue .cw-case-link').first().waitFor();
    /** The sweeps that were really sent (a dry run is only the count in the confirm window). */
    const real = (): number => bulks.filter((b) => b.dryRun !== true).length;

    // The queue: all 40 reports are there (29 people), and the four of Rook's rows are listed after every ordinary one.
    const rows = await hub(p).locator('.cw-queue .cw-case-link').evaluateAll((els) => els.map((e) => ({ text: (e.textContent ?? '').trim(), low: e.closest('[data-ranked]')?.getAttribute('data-ranked') ?? null })));
    expect(rows).toHaveLength(29);
    const lowIdx = rows.map((r, i) => (r.low === 'low' ? i : -1)).filter((i) => i >= 0);
    expect(lowIdx).toHaveLength(4);
    expect(lowIdx).toEqual([25, 26, 27, 28]);
    expect(rows.slice(25).every((r) => /Rookvictim/.test(r.text))).toBe(true);

    // A case of Rook's: the line about their record, and that nothing is hidden.
    await link(p, 'Rookvictim1').click();
    await hub(p).getByText(/Rook: most of their recent reports were dismissed \(6 of 6 in the last 30 days\)/).first().waitFor();
    await hub(p).getByText(/Their reports are listed lower in the queue\. None is hidden\./).first().waitFor();
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(SHOTS, 'reporter-1440-light-detailed.png') });

    // Bulk dismiss: the disclosure is closed until it is opened.
    const more = hub(p).locator('details', { has: p.getByText('Close more reports at once') }).first();
    expect(await more.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    await more.locator('summary').click();
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(SHOTS, 'bulk-1440-light-disclosure.png') });
    await more.getByRole('button', { name: /Dismiss all open reports from Rook/ }).click();
    const win = hub(p).getByRole('dialog');
    await win.getByText('Dismiss 4 reports from Rook?').waitFor();
    await win.getByRole('button', { name: 'Dismiss 4 reports' }).waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(SHOTS, 'bulk-1440-light-confirm.png') });
    // Cancel does nothing.
    await win.getByRole('button', { name: 'Cancel' }).click();
    await win.waitFor({ state: 'detached' });
    expect(real()).toBe(0);

    // Confirm, then Undo within the five seconds: nothing is sent.
    await more.getByRole('button', { name: /Dismiss all open reports from Rook/ }).click();
    await win.getByRole('button', { name: 'Dismiss 4 reports' }).click();
    await toasts(p).getByText('Dismissing 4 reports in 5 s.').waitFor();
    await toasts(p).getByRole('button', { name: 'Undo' }).click();
    await p.waitForTimeout(6_000);
    expect(real()).toBe(0);
    expect(seeded.world.cw.reports.list({ status: 'open', limit: 200 }).items).toHaveLength(40);

    const decideRowsBefore = seeded.world.cw.audit.list({ limit: 200, action: 'report.decide' }).items.length;
    // Confirm again and let it go: one request, four reports closed as plain dismissals (never bad faith), one summary audit row and a decide row each.
    await more.getByRole('button', { name: /Dismiss all open reports from Rook/ }).click();
    await win.getByRole('button', { name: 'Dismiss 4 reports' }).click();
    await toasts(p).getByText('Dismissing 4 reports in 5 s.').waitFor();
    await toasts(p).getByText('Dismissed 4 reports.').waitFor({ timeout: 15_000 });
    expect(real()).toBe(1);
    expect(bulks.filter((b) => b.dryRun !== true)[0]).toMatchObject({ scope: 'reporter', ref: seeded.habitual.reporter });
    expect(seeded.world.cw.reports.list({ status: 'open', limit: 200 }).items).toHaveLength(36);
    for (const id of seeded.habitual.targets) {
      const r = seeded.world.cw.reports.get(id);
      expect(r?.status).toBe('dismissed');
      expect(r?.badFaith).toBe(false);
    }
    const rowsOf = (action: 'report.decide' | 'report.dismiss_reporter' | 'report.dismiss_case'): number => seeded.world.cw.audit.list({ limit: 200, action }).items.length;
    expect(rowsOf('report.dismiss_reporter')).toBe(1);
    expect(rowsOf('report.decide')).toBe(decideRowsBefore + 4);
    // Person scope: Vexa's twelve reports are one case.
    await link(p, 'Vexa').click();
    await hub(p).getByText('1 report from 12 people').first().waitFor().catch(() => undefined);
    const more2 = hub(p).locator('details', { has: p.getByText('Close more reports at once') }).first();
    await more2.locator('summary').click();
    await more2.getByRole('button', { name: /Dismiss all 12 open reports about Vexa/ }).click();
    await win.getByText('Dismiss 12 reports about Vexa?').waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(SHOTS, 'bulk-1440-light-confirm-person.png') });
    await win.getByRole('button', { name: 'Dismiss 12 reports' }).click();
    await toasts(p).getByText('Dismissed 12 reports.').waitFor({ timeout: 15_000 });
    expect(rowsOf('report.dismiss_case')).toBe(1);
    expect(rowsOf('report.decide')).toBe(decideRowsBefore + 4 + 12);
    expect(seeded.world.cw.reports.list({ status: 'open', limit: 200 }).items).toHaveLength(24);
    expect(problems).toEqual([]);
    await p.context().close();
  }, 120_000);
});

/** axe-core in the page, on what is drawn right now (colour contrast included: this is a real browser), serious and critical only. */
async function axeIssues(p: Page): Promise<string[]> {
  await p.addScriptTag({ content: axe.source });
  const found = await p.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: unknown[]; html: string }> }> }> } }).axe;
    const result = await run.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.html.slice(0, 110)).join(' | ')}`);
  });
  return found;
}

/** Nothing sideways: the page, the hub's own box, and every window (a fixed window that is wider than the screen would show here). */
async function sideways(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const root = document.querySelector('chatwarden-hub')?.shadowRoot;
    const out: string[] = [];
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > w) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${w})`);
    for (const el of Array.from(root?.querySelectorAll('.cw-hub, .cw-dialog, .cw-toasts, .cw-toast, [role="dialog"]') ?? [])) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right > w + 0.5 || r.left < -0.5) out.push(`${(el as HTMLElement).className} is outside the screen (${Math.round(r.left)}..${Math.round(r.right)} of ${w})`);
    }
    return out;
  });
}

const COMBOS: Array<{ width: number; height: number; scheme: 'light' | 'dark' }> = [
  { width: 1440, height: 900, scheme: 'light' },
  { width: 1440, height: 900, scheme: 'dark' },
  { width: 390, height: 844, scheme: 'light' },
  { width: 390, height: 844, scheme: 'dark' },
];

describe('screenshots and the real-browser checks, at 1440 and 390, light and dark', () => {
  for (const combo of COMBOS) {
    const tag = `${combo.width}-${combo.scheme}`;
    it(`${tag}: the toast stack, the reporter line, the bulk disclosure and its confirm, the shortcut sheet`, async (ctx) => {
      needsBrowser(ctx);
      const seeded = await seed();
      const origin = await serve(seeded.world, script);
      const issues: string[] = [];
      const check = async (state: string, p: Page): Promise<void> => {
        for (const i of await axeIssues(p)) issues.push(`${tag} ${state}: axe ${i}`);
        for (const i of await sideways(p)) issues.push(`${tag} ${state}: ${i}`);
      };

      // Simple: three quick dismissals stack up, then U takes all three back (nothing is sent).
      const simple = await open(origin, '/', { width: combo.width, height: combo.height, colorScheme: combo.scheme });
      // A control for the screenshots: the hub really is drawn in the scheme this run asks for.
      const background = await simple.page.evaluate(() => getComputedStyle(document.querySelector('chatwarden-hub')?.shadowRoot?.querySelector('.cw-hub') as HTMLElement).backgroundColor);
      expect(background).toBe(combo.scheme === 'dark' ? 'rgb(14, 19, 28)' : 'rgb(244, 245, 248)');
      await simple.page.keyboard.press('n');
      await hub(simple.page).getByRole('region', { name: /^Case against/ }).waitFor();
      for (let i = 0; i < 3; i += 1) {
        await settle(simple.page);
        await simple.page.keyboard.press('2');
        await simple.page.waitForTimeout(150);
      }
      await toasts(simple.page).getByText('2 earlier decisions waiting.').first().waitFor();
      await simple.page.waitForTimeout(700);
      await simple.page.screenshot({ path: join(SHOTS, `${tag}-simple-toast-stack.png`) });
      await check('simple, three decisions waiting', simple.page);
      for (let i = 0; i < 3; i += 1) {
        await simple.page.keyboard.press('u');
        await simple.page.waitForTimeout(250);
      }
      await toasts(simple.page).getByText(/^Undid the decision on/).first().waitFor();
      await simple.page.keyboard.press('?');
      await hub(simple.page).getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
      await simple.page.waitForTimeout(400);
      await simple.page.screenshot({ path: join(SHOTS, `${tag}-simple-shortcut-sheet.png`) });
      await check('simple, shortcut sheet', simple.page);
      await simple.page.keyboard.press('Escape');
      expect(simple.decides).toEqual([]);
      expect(simple.problems).toEqual([]);
      await simple.page.context().close();

      // Detailed: a case of the habitual reporter, the bar with its extra button, the disclosure open, the confirm window.
      const detailed = await open(origin, '/detailed', { width: combo.width, height: combo.height, colorScheme: combo.scheme });
      const p = detailed.page;
      await hub(p).locator('.cw-queue .cw-case-link').first().waitFor();
      await link(p, 'Rookvictim1').click();
      await hub(p).getByText(/Rook: most of their recent reports were dismissed/).first().waitFor();
      await p.waitForTimeout(500);
      await p.screenshot({ path: join(SHOTS, `${tag}-detailed-reporter-line.png`) });
      await check('detailed, reporter line', p);
      const bar = hub(p).getByRole('region', { name: 'Decision' });
      // On a phone the bar is one line, "Decision" with a Decide... button, until it is opened.
      if (combo.width < 600) await bar.getByRole('button', { name: /^Decide/ }).click();
      await bar.scrollIntoViewIfNeeded();
      await bar.getByRole('button', { name: 'Nothing wrong here' }).scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(SHOTS, `${tag}-detailed-decision-bar.png`) });
      await check('detailed, decision bar', p);
      const more = hub(p).locator('details', { has: p.getByText('Close more reports at once') }).first();
      await more.locator('summary').click();
      await more.getByRole('button', { name: /Dismiss all open reports from Rook/ }).scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(SHOTS, `${tag}-detailed-bulk-disclosure.png`) });
      await check('detailed, bulk disclosure', p);
      await more.getByRole('button', { name: /Dismiss all open reports from Rook/ }).click();
      const win = hub(p).getByRole('dialog');
      await win.getByRole('button', { name: 'Dismiss 4 reports' }).waitFor();
      await p.waitForTimeout(400);
      await p.screenshot({ path: join(SHOTS, `${tag}-detailed-bulk-confirm.png`) });
      await check('detailed, bulk confirm', p);
      await win.getByRole('button', { name: 'Cancel' }).click();
      await p.keyboard.press('?');
      await hub(p).getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
      await p.waitForTimeout(400);
      await p.screenshot({ path: join(SHOTS, `${tag}-detailed-shortcut-sheet.png`) });
      await check('detailed, shortcut sheet', p);
      expect(detailed.bulks.filter((b) => b.dryRun !== true)).toEqual([]);
      expect(detailed.decides).toEqual([]);
      expect(detailed.problems).toEqual([]);
      await p.context().close();
      expect(issues).toEqual([]);
    }, 120_000);
  }
});
