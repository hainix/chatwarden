import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { routerTransport } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine, WorldOptions } from './world.js';

// Masking names in the hub (names, design 5.5). A handle the server flags (the matcher flags it while `names.maskInHub` is on) is the hidden label
// everywhere a name is drawn, with a Show control where a moderator is reading a case, one place at a time or all of them with the case's own
// "Show blocked words". Synthetic names only: "zorbak" is a slur in the test term list.

const BAD = 'zorbakKid';
const HIDDEN = 'Blocked words, hidden';
const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const worldOf = (o: WorldOptions = {}): Promise<HubWorld> => hubWorld(o);
/** Everything the page holds that a reader or a screen reader could get: text, and every attribute. */
const leaks = (el: Element): boolean => /zorbak/i.test(el.innerHTML);
const lines = (): HTMLElement[] => within(screen.getByRole('list', { name: 'Chat lines' })).getAllByRole('listitem');
const speakerOf = (li: HTMLElement): string => (li.querySelector('.cw-line-who') as HTMLElement).textContent ?? '';

async function openCase(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...options });
  await screen.findByRole('list', { name: 'Chat lines' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}

describe('masked in the queue rows', () => {
  it('a flagged name is the hidden label in Detailed, with the tag still there; nothing of it is in the pane', async () => {
    const w = await worldOf();
    await w.file({ target: BAD, reporter: 'Rep-One' });
    await w.file({ target: 'Mallory', reporter: 'Rep-Two' });
    renderHub(w, { path: '/reports' });
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).getAllByRole('listitem')).toHaveLength(2));
    const rows = within(pane).getAllByRole('listitem');
    const flagged = rows.find((r) => within(r).queryByText(HIDDEN) !== null);
    expect(flagged).toBeDefined();
    expect(within(rows.find((r) => r !== flagged) as HTMLElement).getByText('Mallory')).toBeInTheDocument();
    expect(leaks(pane)).toBe(false);
  });

  it('and in Simple', async () => {
    const w = await worldOf();
    await w.file({ target: BAD });
    renderHub(w, { path: '/', mode: 'simple' });
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).getAllByRole('listitem')).toHaveLength(1));
    expect(within(pane).getByText(HIDDEN)).toBeInTheDocument();
    expect(leaks(pane)).toBe(false);
  });

  it('the row link names the person by the hidden label too (aria-labels carry no name)', async () => {
    const w = await worldOf();
    await w.file({ target: BAD });
    const { container } = renderHub(w, { path: '/reports' });
    await screen.findByRole('list', { name: 'Cases' });
    expect(leaks(container)).toBe(false);
  });
});

describe('masked in the case: the heading, the transcript speaker, the people list, every label', () => {
  it('nothing of the name is on the page, in text or in any attribute', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: BAD, lines: TALK });
    const { container } = await openCase(w, f.id);
    expect(leaks(container)).toBe(false);
    expect(within(screen.getByRole('region', { name: 'People' })).getAllByText(HIDDEN).length).toBeGreaterThan(0);
    // The reporter and the bystander are named as ever.
    expect(lines().map(speakerOf).filter((s) => /Reporter/.test(s))).toHaveLength(1);
    expect(lines().filter((li) => speakerOf(li).includes(HIDDEN))).toHaveLength(2);
  });

  it('the same in Simple: the card heading and the whole chat', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: BAD, lines: TALK });
    const { container } = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    await screen.findByRole('button', { name: /^No action needed/ });
    expect(leaks(container)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Show the whole chat|Show the chat/ }));
    expect(leaks(container)).toBe(false);
  });

  it('an unflagged name is drawn exactly as before, with no Show control for it', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: 'Mallory', lines: TALK });
    await openCase(w, f.id);
    expect(lines().map(speakerOf).some((s) => s.includes('Mallory'))).toBe(true);
    expect(screen.queryByRole('button', { name: /hidden name/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Show blocked words' })).toBeNull();
  });
});

describe('Show reveals one place; "show all" reveals every flagged name in the case', () => {
  it('Show on one line reveals that line\'s speaker only, and Hide puts it back', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: BAD, lines: TALK });
    const { user } = await openCase(w, f.id);
    const theirs = lines().filter((li) => speakerOf(li).includes(HIDDEN));
    expect(theirs).toHaveLength(2);
    await user.click(within(theirs[0] as HTMLElement).getByRole('button', { name: /^Show the hidden name/ }));
    expect(speakerOf(lines()[1] as HTMLElement)).toContain(BAD);
    expect(speakerOf(lines()[3] as HTMLElement)).toContain(HIDDEN);
    expect(speakerOf(lines()[3] as HTMLElement)).not.toContain(BAD);
    // The people list and the heading are other places: still hidden.
    expect(within(screen.getByRole('region', { name: 'People' })).queryByText(BAD)).toBeNull();
    await user.click(within(lines()[1] as HTMLElement).getByRole('button', { name: /^Hide the name/ }));
    expect(speakerOf(lines()[1] as HTMLElement)).toContain(HIDDEN);
    expect(leaks(screen.getByRole('list', { name: 'Chat lines' }))).toBe(false);
  });

  it('"Show blocked words" is there for a flagged name alone, and shows every name in the case at once', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: BAD, lines: TALK });
    const { user } = await openCase(w, f.id);
    const all = screen.getByRole('checkbox', { name: 'Show blocked words' });
    await user.click(all);
    expect(lines().filter((li) => speakerOf(li).includes(BAD))).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'People' })).getAllByText(BAD).length).toBeGreaterThan(0);
    // The two Show buttons are no longer needed: the switch is the one control.
    expect(screen.queryByRole('button', { name: /^Show the hidden name/ })).toBeNull();
    await user.click(all);
    expect(leaks(screen.getByRole('list', { name: 'Chat lines' }))).toBe(false);
  });

  it('revealing does not persist across cases, nor when the same case is opened again', async () => {
    const w = await worldOf();
    const a = await w.fileRich({ target: BAD, lines: TALK });
    const b = await w.fileRich({ target: 'zorbakTwo', lines: TALK });
    const { user, router } = await openCase(w, a.id);
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    await waitFor(() => expect(lines().filter((li) => speakerOf(li).includes(BAD))).toHaveLength(2));
    router.navigate(`/reports/${b.id}`);
    await waitFor(() => expect(leaks(screen.getByRole('list', { name: 'Chat lines' }))).toBe(false));
    expect(screen.getByRole('checkbox', { name: 'Show blocked words' })).not.toBeChecked();
    router.navigate(`/reports/${a.id}`);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Show blocked words' })).not.toBeChecked());
    expect(leaks(screen.getByRole('list', { name: 'Chat lines' }))).toBe(false);
  });
});

describe('masked in the Person page, toasts and the command bar', () => {
  it('the Person page title and the form titles', async () => {
    const w = await worldOf();
    const f = await w.file({ target: BAD });
    const { container, user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    const title = (): Element => container.querySelector('.cw-personhead h2') as Element;
    expect(title()).toHaveTextContent(HIDDEN);
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: `Sanction ${HIDDEN}` });
    expect(leaks(container)).toBe(false);
    // Show reveals the title, in this place.
    await user.click(screen.getByRole('button', { name: /^Show the hidden name/ }));
    expect(title()).toHaveTextContent(BAD);
  });

  it('a toast that names the person', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: BAD, lines: TALK });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    const button = await screen.findByRole('button', { name: /^No action needed/ });
    w.clock.t += 400;
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(button);
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await waitFor(() => expect(within(toasts).getByText(/Dismissing .* in 5 s\./)).toBeInTheDocument());
    expect(within(toasts).getByText(`Dismissing ${HIDDEN} in 5 s.`)).toBeInTheDocument();
    expect(leaks(toasts)).toBe(false);
  });

  it('the command bar lists a flagged person as the hidden label; typing the name still finds them', async () => {
    const w = await worldOf();
    await w.file({ target: BAD });
    const { user } = renderHub(w, { path: '/' });
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('combobox');
    await user.type(box, 'zorbak');
    const options = within(dialog).getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => within(o).queryByText(HIDDEN) !== null)).toBe(true);
    // A term in the list is a term (the list names its own words); no person or report option carries the name.
    for (const o of options.filter((x) => x.getAttribute('data-kind') !== 'term')) expect(leaks(o)).toBe(false);
  });

  it('SimpleNav names no one', async () => {
    const w = await worldOf();
    await w.file({ target: BAD });
    const { container } = renderHub(w, { path: '/', mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(leaks(container.querySelector('nav.cw-snav') as Element)).toBe(false);
  });
});

describe('names as before', () => {
  it('an older server that sends no handleFlagged shows names as before', async () => {
    const w = await worldOf();
    const f = await w.fileRich({ target: BAD, lines: TALK });
    // The kit's answers with every flag taken out, as a 0.1.8 server sends them.
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).filter(([k]) => !/HandleFlagged$|^handleFlagged$/.test(k)).map(([k, x]) => [k, strip(x)]));
      return v;
    };
    const real = routerTransport(w.handle);
    w.intercept.fn = async (req) => {
      const res = await real(req);
      return { status: res.status, headers: res.headers, body: strip(res.body) } as never;
    };
    await openCase(w, f.id);
    expect(lines().filter((li) => speakerOf(li).includes(BAD))).toHaveLength(2);
    expect(screen.queryByText(HIDDEN)).toBeNull();
    expect(screen.queryByRole('button', { name: /hidden name/i })).toBeNull();
  });

  it('with names.maskInHub off the server flags nothing and the hub shows names as before', async () => {
    const w = await worldOf({ overrides: { names: { maskInHub: false } } });
    const f = await w.fileRich({ target: BAD, lines: TALK });
    await openCase(w, f.id);
    expect(lines().filter((li) => speakerOf(li).includes(BAD))).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /hidden name/i })).toBeNull();
  });
});
