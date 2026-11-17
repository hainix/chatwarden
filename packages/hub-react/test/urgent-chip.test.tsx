import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseline, normalized } from './baseline.js';
import { renderHub } from './render.js';
import { MINUTE, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The urgent chip (design 5.2 and 16): one button in the queue pane's header, present only while something urgent is open; it
// opens the oldest free urgent case; a new urgent report is announced once, politely.

const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const chips = (): HTMLElement[] => screen.queryAllByRole('button', { name: /urgent, oldest|urgent$/i }).filter((b) => b.classList.contains('cw-urgent-chip'));

async function ready() {
  await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane()).queryByText('Loading the queue')).not.toBeInTheDocument());
}

async function urgent(w: HubWorld, target: string, mins = 1) {
  const f = await w.file({ target, reason: 'threat' });
  w.clock.t += mins * MINUTE;
  return f;
}

describe('the urgent chip: when it exists', () => {
  it('is absent with nothing urgent open', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    renderHub(w);
    await ready();
    expect(chips()).toHaveLength(0);
    expect(document.querySelector('.cw-urgent-chip')).toBeNull();
  });

  it('is absent in the loading state, even when the server has urgent reports', async () => {
    const w = await hubWorld();
    await urgent(w, 'Threatener');
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/reports') await held;
      return undefined;
    };
    renderHub(w);
    await screen.findAllByText('Loading the queue');
    expect(document.querySelector('.cw-urgent-chip')).toBeNull();
    answer();
    await ready();
    expect(document.querySelector('.cw-urgent-chip')).not.toBeNull();
  });

  it('is one element, a button with a name that says the count and the oldest wait, not one per case', async () => {
    const w = await hubWorld();
    await urgent(w, 'Threatener', 3);
    await urgent(w, 'Other', 11);
    await w.file({ target: 'Alpha' });
    renderHub(w);
    await ready();
    const found = document.querySelectorAll('.cw-urgent-chip');
    expect(found).toHaveLength(1);
    const chip = found[0] as HTMLElement;
    expect(chip.tagName).toBe('BUTTON');
    expect(screen.getByRole('button', { name: '2 urgent, oldest 14m' })).toBe(chip);
  });

  it('says "1 urgent" with one, and the count is of open urgent reports', async () => {
    const w = await hubWorld();
    await urgent(w, 'Threatener', 2);
    renderHub(w);
    await ready();
    expect(screen.getByRole('button', { name: '1 urgent, oldest 2m' })).toBeInTheDocument();
  });
});

describe('the urgent chip: what it opens', () => {
  it('opens the oldest free urgent case', async () => {
    const w = await hubWorld();
    const first = await urgent(w, 'Oldest', 5);
    await urgent(w, 'Newer', 1);
    const { user, router } = renderHub(w);
    await ready();
    await user.click(screen.getByRole('button', { name: /urgent, oldest/ }));
    expect(router.path).toBe(`/reports/${first.id}`);
  });

  it('skips a case another moderator holds and opens the oldest free one', async () => {
    const w = await hubWorld();
    const held = await urgent(w, 'Held', 5);
    const free = await urgent(w, 'Free', 1);
    await w.clientFor('bea@example.test').claimCase(held.person);
    const { user, router } = renderHub(w);
    await ready();
    await user.click(screen.getByRole('button', { name: /urgent, oldest/ }));
    expect(router.path).toBe(`/reports/${free.id}`);
  });

  it('with every urgent case held, opens the oldest and the label says who holds it', async () => {
    const w = await hubWorld();
    const a = await urgent(w, 'HeldA', 6);
    const b = await urgent(w, 'HeldB', 2);
    await w.clientFor('bea@example.test').claimCase(a.person);
    await w.clientFor('cho@example.test').claimCase(b.person);
    const { user, router } = renderHub(w);
    await ready();
    const chip = screen.getByRole('button', { name: '2 urgent, oldest 8m, held by bea' });
    await user.click(chip);
    expect(router.path).toBe(`/reports/${a.id}`);
  });

  it('a case you hold yourself counts as free', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const mine = await urgent(w, 'Mine', 5);
    await urgent(w, 'Other', 1);
    await w.client.claimCase(mine.person);
    const { user, router } = renderHub(w);
    await ready();
    expect(screen.queryByRole('button', { name: /held by/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /urgent, oldest/ }));
    expect(router.path).toBe(`/reports/${mine.id}`);
  });
});

describe('the urgent chip in Simple mode', () => {
  it('shows above the list of cases, and the menu is otherwise unchanged', async () => {
    const w = await hubWorld();
    await urgent(w, 'Threatener');
    renderHub(w, { mode: 'simple' });
    await ready();
    const chip = document.querySelector('.cw-urgent-chip');
    expect(chip).not.toBeNull();
    const list = within(pane()).getByRole('list', { name: 'Cases' });
    expect(chip?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const nav = screen.getByRole('navigation', { name: 'Moderator hub sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Cases', 'Words', 'Blocked']);
  });
});

describe('the row word', () => {
  it('is the text "Urgent", on the urgent row only, and not a colour', async () => {
    const w = await hubWorld();
    await urgent(w, 'Threatener');
    await w.file({ target: 'Alpha' });
    renderHub(w);
    await ready();
    const rows = within(within(pane()).getByRole('list', { name: 'Cases' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Urgent')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText('Urgent')).toBeNull();
    // The urgent person is first although they reported last, and the mark is a Tag (a word in the row), not a data colour.
    expect(rows[0]?.textContent).toContain('Threatener');
    expect(rows[0]?.querySelector('.cw-tag')?.textContent).toBe('Urgent');
  });

  it('a queue with no urgent report is what it was: byte for byte (the baseline file of 0.1.7)', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha', reporter: 'Rep-A' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo', reporter: 'Rep-B' });
    renderHub(w, { path: '/reports' });
    const region = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(region).getAllByRole('listitem').length).toBe(2));
    await expect(normalized(region)).toMatchFileSnapshot(baseline('queue-pane-detailed'));
  });

  it('a decided urgent report leaves no word and no chip', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await urgent(w, 'Threatener');
    await w.direct.decide(f.id, { verdict: 'no_action', actions: [] });
    await w.file({ target: 'Alpha' });
    renderHub(w);
    await ready();
    expect(document.querySelector('.cw-urgent-chip')).toBeNull();
    expect(within(pane()).queryByText('Urgent')).toBeNull();
  });
});
