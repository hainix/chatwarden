import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createT, en } from '../src/i18n.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// A reporter's recent record on the case they are part of: a line when most of their recent reports were dismissed, and the case listed
// lower in the queue (a hint, never a filter). Staff only, never a list of reporters by rate. On the real routes: the kit builds the
// figure from decided reports.

const LINE = (name: string, unfounded: number, decided: number): string => `${name}: most of their recent reports were dismissed (${unfounded} of ${decided} in the last 30 days).`;
const RANKED = 'Their reports are listed lower in the queue. None is hidden.';
const SR = "Listed lower: most of the reporter's recent reports were dismissed.";

/** Gives `reporter` a record: `dismissed` reports closed as no action and `upheld` ones that led to a warning, all decided. */
async function record(w: HubWorld, reporter: string, { dismissed, upheld = 0 }: { dismissed: number; upheld?: number }): Promise<void> {
  let n = 0;
  for (let i = 0; i < dismissed; i += 1) {
    const f = await w.file({ target: `Filler${reporter}${n++}`, reporter });
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
  }
  for (let i = 0; i < upheld; i += 1) {
    const f = await w.file({ target: `Filler${reporter}${n++}`, reporter });
    await w.client.decide(f.id, { verdict: 'upheld', reason: 'Clear.', actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: 1 }] });
  }
}

async function caseOf(options: WorldOptions, rita: { dismissed: number; upheld?: number }, mode: 'simple' | 'detailed', props: Parameters<typeof renderHub>[1] = {}, readsHistory = true) {
  cleanup();
  const w = await hubWorld({ actor: 'ann@example.test', ...options });
  await record(w, 'Rita', rita);
  const f = await w.file({ target: 'Mallory', reporter: 'Rita' });
  const r = renderHub(w, { path: `/reports/${f.id}`, mode, ...props });
  await screen.findByRole('region', { name: mode === 'simple' ? /^Case against Mallory/ : 'Decision' });
  if (readsHistory) await waitFor(() => expect(w.sent.some((x) => x.path.startsWith('/people/') && x.path.endsWith('/history'))).toBe(true));
  return { w, f, ...r };
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('the reporter line on the Simple card', () => {
  it('a reporter below the minimum sample shows no line, however few of their reports held up', async () => {
    await caseOf({}, { dismissed: 4 }, 'simple');
    await settle();
    expect(screen.queryByText(/most of their recent reports were dismissed/)).toBeNull();
    expect(screen.queryByText(/past reports were mostly not upheld/)).toBeNull();
  });

  it('noticeable shows the line with the right counts and days, and no ranking sentence', async () => {
    await caseOf({}, { dismissed: 3, upheld: 2 }, 'simple');
    expect(await screen.findByText(LINE('Rita', 3, 5))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(RANKED.replace('.', '\\.')))).toBeNull();
  });

  it('habitual adds the ranking sentence', async () => {
    await caseOf({}, { dismissed: 5 }, 'simple');
    const note = await screen.findByText(new RegExp(`^${LINE('Rita', 5, 5).replace(/[()]/g, '\\$&')}`));
    expect(note).toHaveTextContent(`${LINE('Rita', 5, 5)} ${RANKED}`);
  });

  it('most of their reports holding up shows nothing', async () => {
    await caseOf({}, { dismissed: 1, upheld: 4 }, 'simple');
    await settle();
    expect(screen.queryByText(/most of their recent reports were dismissed/)).toBeNull();
  });

  it('uses the warning tone, because it means something', async () => {
    await caseOf({}, { dismissed: 5 }, 'simple');
    const note = await screen.findByText(new RegExp('most of their recent reports were dismissed'));
    expect(note.closest('[data-tone="warn"], .cw-notice--warn, .cw-notice')).not.toBeNull();
  });

  it('an older kit (no accuracy in the record) falls back to the all-time rule and its line', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    await record(w, 'Rita', { dismissed: 4 });
    const f = await w.file({ target: 'Mallory', reporter: 'Rita' });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && /^\/people\/[^/]+\/history$/.test(req.path)) {
        const res = await w.direct.personHistory(req.path.split('/')[2] as string);
        const { accuracy: _drop, ...asReporter } = res.asReporter as typeof res.asReporter & { accuracy?: unknown };
        void _drop;
        return { status: 200, headers: {}, body: { ...res, asReporter } };
      }
      return undefined;
    };
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    expect(await screen.findByText("Rita's past reports were mostly not upheld (0 of 4).")).toBeInTheDocument();
    expect(screen.queryByText(/in the last 30 days/)).toBeNull();
  });

  it('a role without history.read sees no line', async () => {
    await caseOf({ permissions: { 'history.read': 'senior' } }, { dismissed: 5 }, 'simple', {}, false);
    await settle();
    expect(screen.queryByText(/most of their recent reports were dismissed/)).toBeNull();
  });

  it('counts and words follow the catalogue the viewer has (a translation of the line, with the same figures)', async () => {
    const de = createT({ ...en, 'hub.reporter.rate.line': '{name}: {unfounded} von {decided} Meldungen in {days} Tagen abgewiesen.', 'hub.reporter.rate.ranked': 'Weiter unten.' }, 'de');
    await caseOf({}, { dismissed: 4, upheld: 1 }, 'simple', { t: de, locale: 'de' });
    expect(await screen.findByText(/^Rita: 4 von 5 Meldungen in 30 Tagen abgewiesen\. Weiter unten\.$/)).toBeInTheDocument();
  });
});

describe('the reporter rows in Detailed', () => {
  it('show the same figure under the meter, in the same words', async () => {
    await caseOf({}, { dismissed: 5 }, 'detailed');
    const reporters = await screen.findByRole('list', { name: 'Reporters of this case' });
    expect(await within(reporters).findByText(new RegExp('Rita: most of their recent reports were dismissed \\(5 of 5 in the last 30 days\\)\\.'))).toHaveTextContent(`${LINE('Rita', 5, 5)} ${RANKED}`);
  });

  it('show nothing for a reporter whose reports mostly held up, and nothing below the minimum sample', async () => {
    await caseOf({}, { dismissed: 2 }, 'detailed');
    const reporters = await screen.findByRole('list', { name: 'Reporters of this case' });
    await within(reporters).findByRole('meter');
    expect(within(reporters).queryByText(/most of their recent reports were dismissed/)).toBeNull();
  });

  it('the figure appears only for a reporter of an open report in this case; another reporter, however habitual, never shows', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    await record(w, 'Rita', { dismissed: 5 });
    await record(w, 'Zed', { dismissed: 5 });
    await record(w, 'Sam', { dismissed: 0, upheld: 5 });
    const f = await w.file({ target: 'Mallory', reporter: 'Rita' });
    await w.file({ target: 'Mallory', reporter: 'Sam' });
    await w.file({ target: 'Elsewhere', reporter: 'Zed' });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    const reporters = await screen.findByRole('list', { name: 'Reporters of this case' });
    await within(reporters).findByText(/Rita: most of their recent reports were dismissed/);
    await waitFor(() => expect(within(reporters).getAllByRole('meter')).toHaveLength(2));
    expect(within(reporters).queryByText(/Sam: most of/)).toBeNull();
    expect(screen.queryByText(/Zed/)).toBeNull();
  });
});

describe('the queue', () => {
  it('a row ranked low has data-ranked and the screen-reader text, and no visible badge', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    await record(w, 'Rita', { dismissed: 5 });
    await w.file({ target: 'Alpha', reporter: 'Rita' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo', reporter: 'Sam' });
    renderHub(w, { mode: 'detailed' });
    const queue = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(queue).getAllByRole('link')).toHaveLength(2));
    const rows = [...queue.querySelectorAll<HTMLElement>('li.cw-case')];
    expect(rows.map((r) => r.querySelector('.cw-case-name')?.textContent)).toEqual(['Bravo', 'Alpha']);
    expect(rows[0]!.getAttribute('data-ranked')).toBeNull();
    expect(rows[1]!.getAttribute('data-ranked')).toBe('low');
    const hidden = [...rows[1]!.querySelectorAll('.cw-sr')].map((n) => n.textContent?.trim());
    expect(hidden).toContain(SR);
    expect(rows[0]!.textContent).not.toContain('Listed lower');
    // Not a badge, a tag or a mark in the visible text.
    expect(rows[1]!.querySelector('.cw-tag, .cw-badge, [data-tone]')).toBeNull();
    expect(rows[1]!.textContent?.replace(SR, '')).not.toMatch(/lower|dismissed/i);
  });

  it('no row is ranked when the server sent no figure (a role without history.read)', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test', permissions: { 'history.read': 'senior' } });
    await record(w, 'Rita', { dismissed: 5 });
    await w.file({ target: 'Alpha', reporter: 'Rita' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo', reporter: 'Sam' });
    renderHub(w, { mode: 'detailed' });
    const queue = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(queue).getAllByRole('link')).toHaveLength(2));
    expect(queue.querySelector('[data-ranked]')).toBeNull();
    expect(queue.textContent).not.toContain('Listed lower');
  });

  it('the Overview and the queue show no list of reporters and no rate: only the case line and the ranked row', async () => {
    cleanup();
    const w = await hubWorld({ role: 'owner', actor: 'own@example.test' });
    await record(w, 'Rita', { dismissed: 5 });
    await w.file({ target: 'Alpha', reporter: 'Rita' });
    renderHub(w, { path: '/' });
    await screen.findByRole('region', { name: 'Open cases' });
    await settle();
    expect(document.body.textContent).not.toMatch(/most of their recent reports/);
    expect(document.body.textContent).not.toMatch(/\d of \d in the last/);
  });
});

describe.each(['light', 'dark'] as const)('axe on the reporter line, %s theme', (theme) => {
  it.each(['simple', 'detailed'] as const)('%s', async (mode) => {
    const s = await caseOf({}, { dismissed: 5 }, mode, { theme });
    await screen.findByText(/most of their recent reports were dismissed/);
    const result = await axe.run(s.container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => `${v.impact}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`)).toEqual([]);
  });
});

describe('player-react never sees it', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it('player-react renders and imports nothing named accuracy, a false rate, habitual or unfounded', () => {
    const root = join(process.cwd(), 'packages', 'player-react', 'src');
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/reporterAccuracy|falseRate|habitual|unfounded|ReporterAccuracy|\.accuracy\b/);
    }
  });
});
