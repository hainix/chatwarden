import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCare, setCare } from '../src/care.js';
import { aiWorld } from './aiHub.js';
import { appealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The careful view (design 7): a personal, browser-only setting. While on, a case's chat, the reporter's note, the AI's summary and lines and an appeal's statement are NOT in the DOM
// at all (not blurred: a screen reader would read it), one button says how much is behind it, and opening applies to the whole case for the visit. Off by default everywhere.

beforeEach(() => {
  resetCare();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => resetCare());

const LINES: RichLine[] = [
  { who: 'reporter', text: 'SENTINEL_R hello there' },
  { who: 'target', text: 'SENTINEL_T you are trash' },
  { who: 'bystander', text: 'SENTINEL_B what is going on' },
  { who: 'target', text: 'SENTINEL_T2 uninstall the game' },
];
const NOTE = 'SENTINEL_NOTE keeps following me';

/** Every element of the page whose own text holds the sentinel: "not in the DOM at all" means none, in any element, attribute-free. */
function holders(container: HTMLElement, sentinel: string): number {
  const found = Array.from(container.querySelectorAll('*')).filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').includes(sentinel)));
  return found.length;
}

async function aiCaseWorld() {
  const { w, f } = await aiWorld({ lines: LINES });
  // The note the world files is the same every time; the report carries it for the page to hide.
  return { w, f };
}
async function open(w: HubWorld, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('tablist');
  return r;
}

describe('hidden', () => {
  it('the transcript, the reporter note and the AI summary and lines are not in the DOM; the buttons say what is behind them; opening shows all of them', async () => {
    const { w, f } = await aiCaseWorld();
    setCare({ hideExcerpts: true });
    const read = (await w.direct.getReport(f.id)).ai;
    expect(read?.summary).toBeTruthy();
    const { container, user } = await open(w, f.id);
    await screen.findByRole('button', { name: 'Show the chat (4 lines)' });
    for (const s of ['SENTINEL_R', 'SENTINEL_T', 'SENTINEL_B', 'SENTINEL_T2']) expect(holders(container, s), s).toBe(0);
    expect(holders(container, 'Keeps following me')).toBe(0);
    expect(holders(container, read?.summary as string), 'AI summary').toBe(0);
    expect(screen.getByRole('button', { name: "Show the reporter's note" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Show the AI's read" })).toBeInTheDocument();
    expect(container.textContent).not.toContain('SENTINEL');
    await user.click(screen.getByRole('button', { name: 'Show the chat (4 lines)' }));
    for (const s of ['SENTINEL_R', 'SENTINEL_T', 'SENTINEL_B', 'SENTINEL_T2']) expect(holders(container, s), s).toBeGreaterThan(0);
    expect(holders(container, 'Keeps following me')).toBeGreaterThan(0);
    await waitFor(() => expect(holders(container, read?.summary as string), 'AI summary').toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /^Show the (chat|AI|reporter)/ })).toBeNull();
  });

  it('a button that is any one of them opens all of them (it is the case that is opened)', async () => {
    const { w, f } = await aiCaseWorld();
    setCare({ hideExcerpts: true });
    const { container, user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: "Show the reporter's note" }));
    expect(holders(container, 'Keeps following me')).toBeGreaterThan(0);
    expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0);
  });

  it('the button counts lines in the singular too', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'target', text: 'only line' }], cite: 0 });
    setCare({ hideExcerpts: true });
    await open(w, f.id);
    expect(await screen.findByRole('button', { name: 'Show the chat (1 line)' })).toBeInTheDocument();
  });

  it('the blocked-word masking still applies inside what was opened', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({
      lines: [
        { who: 'reporter', text: 'hello there' },
        { who: 'target', text: 'you zorbak player' },
      ],
    });
    setCare({ hideExcerpts: true });
    const { container, user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: /^Show the chat/ }));
    expect(holders(container, 'hello there')).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('zorbak');
    expect(within(container).getAllByText('Blocked words, hidden').length).toBeGreaterThan(0);
  });

  it('keeps the focus where the button was: on the opened content, not the page', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: LINES, note: NOTE });
    setCare({ hideExcerpts: true });
    const { user } = await open(w, f.id);
    const button = await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(button);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.closest('.cw-transcript, .cw-revealed')).not.toBeNull();
  });

  it('is in the Simple card too: the chat lines, hidden behind one button', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: LINES, note: NOTE });
    setCare({ hideExcerpts: true });
    const { container, user } = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
    await user.click(screen.getByRole('button', { name: /^Show the chat/ }));
    expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0);
  });

  it('an appeal statement is not in the DOM until it is opened', async () => {
    const w = await appealsHub({ role: 'senior' });
    const a = await w.appeal({ target: 'Mallory', statement: 'SENTINEL_STATEMENT it was a joke' });
    setCare({ hideExcerpts: true });
    const { container, user } = renderHub(w, { path: `/appeals/${a.appealId}` });
    await screen.findByRole('button', { name: 'Show the appeal statement' });
    expect(holders(container, 'SENTINEL_STATEMENT')).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Show the appeal statement' }));
    expect(holders(container, 'SENTINEL_STATEMENT')).toBeGreaterThan(0);
  });
});

describe('opening is for this case, this visit', () => {
  it('a second case is hidden again, and so is the first when you come back to it', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ target: 'Alpha', lines: LINES, note: NOTE });
    const b = await w.fileRich({ target: 'Bravo', lines: LINES, note: NOTE });
    setCare({ hideExcerpts: true });
    const { container, user, router } = await open(w, a.id);
    await user.click(await screen.findByRole('button', { name: /^Show the chat/ }));
    expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0);
    router.navigate(`/reports/${b.id}`);
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
    router.navigate(`/reports/${a.id}`);
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
  });

  it('does not survive a reload: a new hub starts hidden', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: LINES, note: NOTE });
    setCare({ hideExcerpts: true });
    const first = await open(w, f.id);
    await first.user.click(await screen.findByRole('button', { name: /^Show the chat/ }));
    first.unmount();
    const { container } = await open(w, f.id);
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
  });
});

describe('off by default', () => {
  it('in Detailed and in Simple, and for an urgent case: everything is on the page and there is no button', async () => {
    const w = await hubWorld();
    const calm = await w.fileRich({ target: 'Calm', lines: LINES, note: NOTE, reason: 'spam' });
    const hot = await w.fileRich({ target: 'Hot', lines: LINES, note: NOTE, reason: 'threat' });
    for (const [id, mode] of [[calm.id, 'detailed'], [calm.id, 'simple'], [hot.id, 'detailed'], [hot.id, 'simple']] as const) {
      const { container, unmount } = renderHub(w, { path: `/reports/${id}`, mode });
      await waitFor(() => expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0));
      expect(screen.queryByRole('button', { name: /^Show the (chat|reporter|AI)/ })).toBeNull();
      unmount();
    }
  });

  it('turned on, it also hides an urgent case (there is no exception to the person\'s own choice)', async () => {
    const w = await hubWorld();
    const hot = await w.fileRich({ target: 'Hot', lines: LINES, note: NOTE, reason: 'threat' });
    setCare({ hideExcerpts: true });
    const { container } = await open(w, hot.id);
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
  });

  it('with it off the case is drawn exactly as before: no wrapper, no extra element', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: LINES, note: NOTE });
    const { container } = await open(w, f.id);
    await waitFor(() => expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0));
    expect(container.querySelector('.cw-revealed, .cw-hidden-excerpt')).toBeNull();
  });
});

describe('turning it on', () => {
  it('in Advanced, Your own view: applies at once to the case that opens next, and turning it off shows the text again', async () => {
    const w = await hubWorld({ role: 'owner' });
    const f = await w.fileRich({ lines: LINES, note: NOTE });
    const settings = renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Your own view' });
    await settings.user.click(within(region).getByRole('checkbox', { name: 'Hide excerpts until I open them' }));
    settings.unmount();
    const { container } = await open(w, f.id);
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
  });

  it('from the command bar, on the open case, at once; the entry then offers to stop', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: LINES, note: NOTE });
    const { container, user } = await open(w, f.id);
    await waitFor(() => expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0));
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search people, reports, terms or screens' });
    await user.type(input, 'Hide excerpts');
    await user.click(await screen.findByRole('option', { name: /Hide excerpts until I open them/ }));
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(holders(container, 'SENTINEL_T')).toBe(0);
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Search people, reports, terms or screens' }), 'Stop hiding');
    await user.click(await screen.findByRole('option', { name: /Stop hiding excerpts/ }));
    await waitFor(() => expect(holders(container, 'SENTINEL_T')).toBeGreaterThan(0));
  });
});
