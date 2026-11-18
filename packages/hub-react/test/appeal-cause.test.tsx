import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';

// "What caused this" (appeals landing, 6.1): one closed disclosure in the Detailed card, after what the player was shown. It says in a sentence where the
// sanction came from and links to the place to look. The term of an automatic restriction stays hidden until "Show". It is read only.

const SENIOR: WorldOptions = { role: 'senior', actor: 'bea@example.test' };
type Cause = Record<string, unknown>;

async function open(o: { cause?: Cause | ((w: AppealsHub) => Cause); world?: WorldOptions; mode?: 'simple' | 'detailed'; statement?: string } = {}) {
  const w = await appealsHub(o.world ?? SENIOR);
  const a = await w.appeal({ target: 'Mallory', ...(o.statement === undefined ? {} : { statement: o.statement }) });
  const real = await w.client.appeal(a.appealId);
  if (o.cause !== undefined) {
    const cause = typeof o.cause === 'function' ? o.cause(w) : o.cause;
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === `/appeals/${a.appealId}` ? { status: 200, body: { appeal: { ...real.appeal, cause } } } : undefined);
  }
  const r = renderHub(w, { path: `/appeals/${a.appealId}`, ...(o.mode === undefined ? {} : { mode: o.mode }) });
  await screen.findByRole('region', { name: 'What the player said' });
  return { w, a, real, ...r };
}
const disclosure = (): HTMLDetailsElement => screen.getByText('What caused this').closest('details') as HTMLDetailsElement;
const termId = (w: AppealsHub, word = 'zorbak'): string => (w as unknown as { live: { rows: { terms: Array<{ id: string; term: string }> } } }).live.rows.terms.find((r) => r.term === word)!.id;
const reads = (w: AppealsHub, from: number): string[] => w.sent.slice(from).map((r) => `${r.method} ${r.path}`);

describe('the disclosure', () => {
  it('Detailed shows the closed disclosure after the lines shown; Simple shows none', async () => {
    const detailed = await open();
    const d = disclosure();
    expect(d.tagName).toBe('DETAILS');
    expect(d.open).toBe(false);
    expect(d.classList.contains('cw-appeal-cause')).toBe(true);
    const shown = screen.getByRole('region', { name: 'What they were shown' });
    expect(shown.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    detailed.unmount();
    await open({ mode: 'simple' });
    expect(screen.queryByText('What caused this')).toBeNull();
    expect(document.querySelector('.cw-appeal-cause')).toBeNull();
  });
});

describe('a term cause', () => {
  const termCause = (id: string | null, strikes = 3): Cause => ({ source: 'term', termId: id, strikes });

  it('the term is masked until Show; Hide masks it again; the toggle\'s aria-pressed is right; the strikes count and the slur-list link show', async () => {
    const { user } = await open({ cause: (w) => termCause(termId(w)) });
    await user.click(screen.getByText('What caused this'));
    const body = disclosure();
    expect(within(body).getByText('An automatic restriction from the slur list, after 3 blocked messages.')).toBeInTheDocument();
    expect(within(body).queryByText('zorbak')).toBeNull();
    expect(body.innerHTML.toLowerCase()).not.toContain('zorbak');
    const toggle = await within(body).findByRole('button', { name: 'Show the word' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(within(body).getByText('zorbak')).toBeInTheDocument();
    const hide = within(body).getByRole('button', { name: 'Hide the word' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await user.click(hide);
    expect(within(body).queryByText('zorbak')).toBeNull();
    expect(within(body).getByRole('button', { name: 'Show the word' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(body).getByRole('link', { name: 'Open in the slur list' })).toHaveAttribute('href', '#/terms');
  });

  it('one blocked message reads in the singular', async () => {
    const { user } = await open({ cause: termCause(null, 1) });
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText('An automatic restriction from the slur list, after 1 blocked message.')).toBeInTheDocument();
  });

  it('a null term id (an older row) shows the placeholder and no way to show it', async () => {
    const { user } = await open({ cause: termCause(null) });
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText('A word on the list')).toBeInTheDocument();
    expect(within(disclosure()).queryByRole('button', { name: /the word/ })).toBeNull();
  });

  it('a term no longer listed shows the placeholder and no way to show it', async () => {
    const { user } = await open({ cause: termCause('syn:gone-for-good') });
    await user.click(screen.getByText('What caused this'));
    await within(disclosure()).findByText('A word on the list');
    expect(within(disclosure()).queryByRole('button', { name: /the word/ })).toBeNull();
  });

  it('without terms.read it shows the placeholder, no show button, and never reads the list', async () => {
    const { user, w } = await open({ cause: (x) => termCause(termId(x)), world: { ...SENIOR, permissions: { 'terms.read': 'owner' } } });
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText('A word on the list')).toBeInTheDocument();
    expect(within(disclosure()).queryByRole('button', { name: /the word/ })).toBeNull();
    expect(w.sent.filter((r) => r.path === '/terms')).toEqual([]);
    expect(within(disclosure()).getByRole('link', { name: 'Open in the slur list' })).toBeInTheDocument();
  });

  it('"Show blocked words" for the page shows the term too, and the term toggle has nothing left to do', async () => {
    const { user } = await open({ cause: (w) => termCause(termId(w)), statement: 'you zorbak, a joke' });
    await user.click(screen.getByText('What caused this'));
    await within(disclosure()).findByRole('button', { name: 'Show the word' });
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(within(disclosure()).getByText('zorbak')).toBeInTheDocument();
    expect(within(disclosure()).queryByRole('button', { name: /the word/ })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(within(disclosure()).queryByText('zorbak')).toBeNull();
  });
});

describe('the other causes', () => {
  it('a filter cause names the filter and links to the filter settings', async () => {
    const { user } = await open({ cause: { source: 'filter', reportId: 'r1', filterKey: 'link.unlisted', decidedBy: 'human' } });
    await user.click(screen.getByText('What caused this'));
    const body = disclosure();
    expect(within(body).getByText('A chat filter filed the report (Link on no list).')).toBeInTheDocument();
    expect(within(body).getByRole('link', { name: 'Open the filter settings' })).toHaveAttribute('href', '#/settings/advanced');
    expect(within(body).getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', '#/reports/r1');
  });

  it('a filter cause with a phrase rule that is gone reads "Phrase"; the raw key is never shown', async () => {
    const { user } = await open({ cause: { source: 'filter', reportId: 'r1', filterKey: 'phrase.ads', decidedBy: 'human' } });
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText('A chat filter filed the report (Phrase).')).toBeInTheDocument();
    expect(disclosure().textContent).not.toContain('phrase.ads');
  });

  it('a human report decision shows its sentence and the report link', async () => {
    const { user } = await open({ cause: { source: 'report', reportId: 'r9', decidedBy: 'human' } });
    await user.click(screen.getByText('What caused this'));
    const body = disclosure();
    expect(within(body).getByText('A human decision on a report.')).toBeInTheDocument();
    expect(within(body).getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', '#/reports/r9');
  });

  it('an AI decision shows its sentence and the report link, where the AI read is shown', async () => {
    const { user } = await open({ cause: { source: 'report', reportId: 'r9', decidedBy: 'ai' } });
    await user.click(screen.getByText('What caused this'));
    const body = disclosure();
    expect(within(body).getByText('An AI decision on a report.')).toBeInTheDocument();
    expect(within(body).getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', '#/reports/r9');
  });

  it('the report link needs reports.read: without it the sentence stays and there is no link', async () => {
    const { user } = await open({ cause: { source: 'report', reportId: 'r9', decidedBy: 'human' }, world: { ...SENIOR, permissions: { 'reports.read': 'owner' } } });
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText('A human decision on a report.')).toBeInTheDocument();
    expect(within(disclosure()).queryByRole('link')).toBeNull();
  });

  it.each([
    ['coop', 'A co-op sanction with no report.'],
    ['api', 'An API sanction with no report.'],
  ] as const)('an "other" cause via %s says so and has no link', async (via, sentence) => {
    const { user } = await open({ cause: { source: 'other', via } });
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText(sentence)).toBeInTheDocument();
    expect(within(disclosure()).queryByRole('link')).toBeNull();
  });

  it('the real default (a human report decision) reads as a human decision with the real report link', async () => {
    const { user, a } = await open();
    await user.click(screen.getByText('What caused this'));
    expect(within(disclosure()).getByText('A human decision on a report.')).toBeInTheDocument();
    expect(within(disclosure()).getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', `#/reports/${a.reportId}`);
  });

  it('an older server that sends no cause shows no disclosure at all', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    const real = await w.client.appeal(a.appealId);
    const { cause: _drop, ...rest } = real.appeal as unknown as Record<string, unknown>;
    void _drop;
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === `/appeals/${a.appealId}` ? { status: 200, body: { appeal: rest } } : undefined);
    renderHub(w, { path: `/appeals/${a.appealId}` });
    await screen.findByRole('region', { name: 'What the player said' });
    expect(screen.queryByText('What caused this')).toBeNull();
  });
});

describe('what opening it reads', () => {
  it('nothing new from the server, except the terms list for a term cause with terms.read', async () => {
    for (const [cause, expected] of [
      [{ source: 'report', reportId: 'r9', decidedBy: 'human' }, []],
      [{ source: 'filter', reportId: 'r9', filterKey: 'link.unlisted', decidedBy: 'human' }, []],
      [{ source: 'other', via: 'api' }, []],
      [{ source: 'term', termId: 'syn:whatever', strikes: 3 }, ['GET /terms']],
    ] as const) {
      const { w, user, unmount } = await open({ cause: cause as unknown as Cause });
      await new Promise((r) => setTimeout(r, 20));
      const before = w.sent.length;
      await user.click(screen.getByText('What caused this'));
      expect(disclosure().open).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(reads(w, before), JSON.stringify(cause)).toEqual(expected);
      unmount();
    }
  });

  it('a term cause with no term id reads nothing either', async () => {
    const { w, user } = await open({ cause: { source: 'term', termId: null, strikes: 3 } });
    const before = w.sent.length;
    await user.click(screen.getByText('What caused this'));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads(w, before)).toEqual([]);
  });

  it('is read only: no write of any kind is sent by opening it and using its toggle', async () => {
    const { w, user } = await open({ cause: (x) => ({ source: 'term', termId: termId(x), strikes: 3 }) });
    await user.click(screen.getByText('What caused this'));
    await user.click(await within(disclosure()).findByRole('button', { name: 'Show the word' }));
    expect(w.sent.filter((r) => r.method !== 'GET')).toEqual([]);
  });
});
