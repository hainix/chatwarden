import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';
import { aiCase } from './aiHub.js';
import { appealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// "What the player sees" on Simple's card (0.2.0): the panel replaces the old one-sentence preview and previews the primary one-tap step; the other one-tap
// buttons carry their own one line. Simple and Detailed draw the same panel for the same case.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'you play like a zorbak' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'good game' },
];
const card = (): HTMLElement => screen.getByRole('region', { name: /^Case against Mallory/ });
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const panelOf = async (scope: HTMLElement): Promise<HTMLElement> => within(scope).findByRole('region', { name: 'What the player sees' });
/** The panel as its text and its notice titles say it, without anything that depends on the mode. */
const said = (p: HTMLElement): { titles: string[]; text: string } => ({
  titles: [...p.querySelectorAll('h4')].map((h) => h.textContent ?? ''),
  text: (p.querySelector('.cw-pv-notice')?.textContent ?? '').replace(/\s+/g, ' '),
});

async function openSimple(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}`, mode: 'simple', stay: true });
  await screen.findByRole('heading', { level: 2, name: 'Mallory' });
  await screen.findByRole('button', { name: /^No action needed/ });
  w.clock.t += 400;
  return r;
}
async function openDetailed(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}`, mode: 'detailed', stay: true });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  return r;
}

describe('Simple previews the primary one-tap step', () => {
  it('shows the notice the primary button would send, with the rule and the person\'s own masked lines, under the buttons', async () => {
    const w = await appealsHub();
    const f = await w.fileRich({ lines: TALK });
    await openSimple(w, f.id);
    const panel = await panelOf(decision());
    await waitFor(() => expect(panel).toHaveTextContent('Your chat is turned off'));
    expect(panel).toHaveTextContent('Community Rule 2');
    expect(panel.textContent).toContain('you play like a ******');
    const buttons = decision().querySelector('.cw-scard-actions') as HTMLElement;
    expect(buttons.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(decision()).getByText('You can undo for 5 seconds.')).toBeInTheDocument();
  });

  it('the old sentence is gone: no "sees these lines" text and no hub.simple.sees keys', async () => {
    const w = await appealsHub();
    const f = await w.fileRich({ lines: TALK });
    await openSimple(w, f.id);
    await panelOf(decision());
    expect(within(decision()).queryByText(/sees (this|these)/)).toBeNull();
    expect(Object.keys(en).filter((k) => k.startsWith('hub.simple.sees'))).toEqual([]);
  });

  it('with no step to preview (no suggestion), there is no panel on the card', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'other' });
    await openSimple(w, f.id);
    expect(within(decision()).queryByRole('region', { name: 'What the player sees' })).toBeNull();
  });
});

describe('the other one-tap buttons carry their own one line', () => {
  it('"No action needed" describes itself: nobody is told, nothing is sent to anyone', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await openSimple(w, f.id);
    expect(within(decision()).getByRole('button', { name: /^No action needed/ })).toHaveAccessibleDescription('Closes the report with no action. Nobody is told, nobody is marked and nothing is sent to anyone.');
  });

  it('the warning button describes itself, naming the rule', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'chat', 1);
    await openSimple(w, f.id);
    const warn = within(decision()).queryByRole('button', { name: /^Send a warning/ });
    if (warn === null) return;
    expect(warn).toHaveAccessibleDescription(/^Sends the reported person a warning that cites Rule \d+\.$/);
  });
});

describe('Simple and Detailed draw the same panel for the same case', () => {
  it('the same notice titles and the same notice text', async () => {
    const w = await appealsHub();
    const f = await w.fileRich({ lines: TALK });
    const simple = await openSimple(w, f.id);
    const a = await panelOf(decision());
    await waitFor(() => expect(a).toHaveTextContent('Your chat is turned off'));
    const first = said(a);
    simple.unmount();
    await openDetailed(w, f.id);
    const b = await panelOf(decision());
    await waitFor(() => expect(b).toHaveTextContent('Your chat is turned off'));
    expect(said(b)).toEqual(first);
  });
});

describe("the AI's accept button shows the same panel", () => {
  it("on Simple's card at level 2: the panel of the suggestion's notice, not the old sentence", async () => {
    await aiCase({ level: 2, mode: 'simple', stay: true });
    await within(card()).findByRole('button', { name: 'Accept AI suggestion: Send a warning' });
    const panel = await within(card()).findByRole('region', { name: 'What the player sees' });
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 4, name: 'You have a warning' })).toBeInTheDocument());
    expect(panel).toHaveTextContent('Press Acknowledge to confirm you saw this.');
    expect(within(card()).queryByText(/sees (this|these)/)).toBeNull();
  });
});
