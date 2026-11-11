import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const caseList = (): HTMLElement => within(pane()).getByRole('list', { name: 'Cases' });
const rows = (): HTMLElement[] => within(caseList()).getAllByRole('listitem');
const rowOf = (name: string): HTMLElement => {
  const row = rows().find((li) => within(li).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

async function ready() {
  await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane()).queryByText('Loading the queue')).not.toBeInTheDocument());
}

async function people(w: HubWorld, names: string[], each = 1) {
  const out: Array<{ id: string; person: string; name: string }> = [];
  for (const name of names) {
    for (let r = 0; r < each; r += 1) {
      const filed = await w.file({ target: name, reporter: `Rep-${name}-${r}` });
      out.push({ id: filed.id, person: filed.person, name });
      w.clock.t += 1000;
    }
  }
  return out;
}

describe('the queue pane: the rows', () => {
  it('is a region named Open cases beside the screen, with a skeleton while it loads and a summary after', async () => {
    const w = await hubWorld();
    await people(w, ['Alpha', 'Bravo'], 2);
    // The queue read is held open until the skeleton has been looked at, so the test does not race the in-memory server.
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/reports') await held;
      return undefined;
    };
    renderHub(w);
    const region = await screen.findByRole('region', { name: 'Open cases' });
    expect(within(region).getByText('Loading the queue')).toBeInTheDocument();
    expect(region.querySelectorAll('.cw-case--skeleton').length).toBeGreaterThan(0);
    answer();
    await ready();
    expect(within(region).getByText('2 people and 4 reports')).toBeInTheDocument();
    expect(region.querySelectorAll('.cw-case--skeleton')).toHaveLength(0);
  });

  it('lists one row per person, longest wait first, with the tag, categories, report count and wait', async () => {
    const w = await hubWorld();
    const [a, , c] = await people(w, ['Alpha', 'Bravo', 'Charlie']);
    await w.file({ target: 'Alpha', reporter: 'Another', category: 'spam' });
    w.clock.t += 3 * HOUR;
    renderHub(w);
    await ready();
    expect(rows().map((li) => li.textContent)).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo'),
      expect.stringContaining('Charlie'),
    ]);
    const alpha = within(rowOf('Alpha'));
    expect(alpha.getByText(personTag(a!.person))).toBeInTheDocument();
    expect(alpha.getByText('Insults or harassment')).toBeInTheDocument();
    expect(alpha.getByText('Spam or ads')).toBeInTheDocument();
    expect(alpha.getByText('2 reports from 2 people')).toBeInTheDocument();
    expect(alpha.getByText('Waiting 3h')).toBeInTheDocument();
    expect(within(rowOf('Charlie')).getByText('1 report from 1 person')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(c!.person);
  });

  it('a row is a link to the person\'s newest open report', async () => {
    const w = await hubWorld();
    const [a, b] = await people(w, ['Alpha'], 2);
    const { user, router } = renderHub(w);
    await ready();
    const link = within(rowOf('Alpha')).getByRole('link');
    expect(link).toHaveAttribute('href', `#/reports/${b!.id}`);
    expect(a!.id).not.toBe(b!.id);
    await user.click(link);
    expect(router.path).toBe(`/reports/${b!.id}`);
  });

  it('marks the open case as current and highlights its row', async () => {
    const w = await hubWorld();
    const [a] = await people(w, ['Alpha', 'Bravo']);
    renderHub(w, { path: `/reports/${a!.id}` });
    await ready();
    const link = within(rowOf('Alpha')).getByRole('link');
    expect(link).toHaveAttribute('aria-current', 'true');
    expect(rowOf('Alpha')).toHaveAttribute('data-selected', 'true');
    expect(within(rowOf('Bravo')).getByRole('link')).not.toHaveAttribute('aria-current');
  });

  it('shows the all-clear when nothing is open, and keeps the Take next button', async () => {
    const w = await hubWorld();
    renderHub(w);
    await ready();
    expect(within(pane()).getByText('All clear')).toBeInTheDocument();
    expect(within(pane()).getByText('No open cases. Nothing is waiting on you.')).toBeInTheDocument();
    expect(within(pane()).getByRole('button', { name: /Take next case/ })).toBeInTheDocument();
  });

  it('says so when the queue was longer than what was read', async () => {
    const w = await hubWorld();
    let pages = 0;
    w.intercept.fn = (req) => {
      if (req.method !== 'GET' || req.path !== '/reports') return undefined;
      pages += 1;
      const items = Array.from({ length: 200 }, (_, i) => ({
        id: `r${pages}-${i}`,
        createdAt: 1_800_000_000_000 - pages * 1000 - i,
        roomId: 'x',
        tags: {},
        category: 'spam',
        status: 'open',
        badFaith: false,
        targetPerson: `person${i % 40}`,
        reporterPerson: `rep${i}`,
        actionedAt: null,
        actionedBy: null,
        targetHandle: null,
      }));
      return { status: 200, body: { items, next: `cursor-${pages}` } };
    };
    renderHub(w);
    await ready();
    expect(pages).toBe(5);
    expect(within(pane()).getByText(/Counted from the newest 1,000 reports/)).toBeInTheDocument();
  });
});

describe('the queue pane: the wait is red only once it is overdue', () => {
  it.each([
    ['30 minutes', 30 * 60_000, 'ok'],
    ['23 hours', 23 * HOUR, 'ok'],
    ['25 hours', 25 * HOUR, 'overdue'],
    ['3 days', 3 * DAY, 'overdue'],
  ])('a case that has waited %s is %s', async (_label, wait, state) => {
    const w = await hubWorld();
    const [a] = await people(w, ['Alpha']);
    w.clock.t = w.cw.reports.get(a!.id)!.createdAt + wait;
    renderHub(w);
    await ready();
    expect(rowOf('Alpha')).toHaveAttribute('data-wait', state);
    const sr = within(rowOf('Alpha')).queryByText('Overdue');
    if (state === 'overdue') expect(sr).toBeInTheDocument();
    else expect(sr).not.toBeInTheDocument();
  });

  it('says overdue in words as well as colour', async () => {
    const w = await hubWorld();
    const [a] = await people(w, ['Alpha']);
    w.clock.t = w.cw.reports.get(a!.id)!.createdAt + 2 * DAY;
    renderHub(w);
    await ready();
    expect(rowOf('Alpha')).toHaveTextContent('Waiting 2d');
    expect(rowOf('Alpha')).toHaveTextContent('Overdue');
  });
});

describe('the queue pane: who has each case', () => {
  it('shows you in blue (data-claim you), a teammate by name, and nobody as Unclaimed', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a, b] = await people(w, ['Alpha', 'Bravo', 'Charlie']);
    await w.client.claimCase(a!.person);
    await w.clientFor('maya@example.test').claimCase(b!.person);
    renderHub(w);
    await ready();
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'you');
    expect(within(rowOf('Alpha')).getByText('You')).toBeInTheDocument();
    expect(within(rowOf('Alpha')).getByText('Handled by you')).toBeInTheDocument();
    expect(rowOf('Bravo')).toHaveAttribute('data-claim', 'other');
    expect(within(rowOf('Bravo')).getByText('maya')).toBeInTheDocument();
    expect(within(rowOf('Bravo')).getByText('Handled by maya')).toBeInTheDocument();
    expect(rowOf('Charlie')).toHaveAttribute('data-claim', 'none');
    expect(within(rowOf('Charlie')).getByText('Unclaimed')).toBeInTheDocument();
  });

  it('a claim that has lapsed shows as Unclaimed', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.clientFor('maya@example.test').claimCase(a!.person);
    w.clock.t += 11 * 60_000;
    renderHub(w);
    await ready();
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none');
  });

  it('shows who is viewing a case, by name, apart from who is handling it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a, b] = await people(w, ['Alpha', 'Bravo']);
    await w.clientFor('ana@example.test').viewing(a!.person);
    await w.clientFor('rin@example.test').viewing(b!.person);
    await w.clientFor('lee@example.test').viewing(b!.person);
    await w.clientFor('kai@example.test').viewing(b!.person);
    renderHub(w);
    await ready();
    const alpha = within(rowOf('Alpha'));
    expect(alpha.getByText('ana is viewing')).toBeInTheDocument();
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none');
    const bravo = rowOf('Bravo');
    expect(within(bravo).getByText('3 people are viewing: kai, lee, and rin')).toBeInTheDocument();
    expect(bravo.querySelector('.cw-case-viewing span[aria-hidden="true"]')).toHaveTextContent('kai and 2 more');
  });

  it('shows no one viewing when only you have it open', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.client.viewing(a!.person);
    renderHub(w);
    await ready();
    expect(rowOf('Alpha').querySelector('.cw-case-viewing')).toBeNull();
  });

  it('only your own claimed row has a Release button, and it names the person', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a, b] = await people(w, ['Alpha', 'Bravo', 'Charlie']);
    await w.client.claimCase(a!.person);
    await w.clientFor('maya@example.test').claimCase(b!.person);
    renderHub(w);
    await ready();
    expect(within(pane()).getAllByRole('button', { name: /^Release/ })).toHaveLength(1);
    expect(within(rowOf('Alpha')).getByRole('button', { name: 'Release the case against Alpha' })).toBeInTheDocument();
  });

  it('Release lets go of the claim, says so with an Undo, and Undo takes it back', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.client.claimCase(a!.person);
    const { user } = renderHub(w);
    await ready();
    await user.click(within(rowOf('Alpha')).getByRole('button', { name: 'Release the case against Alpha' }));
    expect(await screen.findByText('You released the case against Alpha.')).toBeInTheDocument();
    await waitFor(() => expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none'));
    expect(w.cw.cases.holder(a!.person)).toBeNull();
    expect(within(rowOf('Alpha')).queryByRole('button', { name: /^Release/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('You are handling the case against Alpha again.')).toBeInTheDocument();
    await waitFor(() => expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'you'));
    expect(w.cw.cases.holder(a!.person)?.by).toBe('ann@example.test');
  });

  it('Undo after a teammate took the case says who has it, and does not claim it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.client.claimCase(a!.person);
    const { user } = renderHub(w);
    await ready();
    await user.click(within(rowOf('Alpha')).getByRole('button', { name: /^Release/ }));
    await screen.findByText('You released the case against Alpha.');
    await w.clientFor('maya@example.test').claimCase(a!.person);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('maya is handling this case. Deciding it is refused until they release it.')).toBeInTheDocument();
    expect(w.cw.cases.holder(a!.person)?.by).toBe('maya@example.test');
  });
});

describe('the queue pane: filters', () => {
  async function mixed() {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a, b] = await people(w, ['Alpha', 'Bravo']);
    await w.file({ target: 'Charlie', reporter: 'RC', category: 'hate' });
    await w.file({ target: 'Delta', reporter: 'RD', category: 'spam' });
    await w.client.claimCase(a!.person);
    await w.clientFor('maya@example.test').claimCase(b!.person);
    return w;
  }
  const names = (): string[] => rows().map((li) => (li.querySelector('.cw-case-name') as HTMLElement).textContent ?? '');

  it('All, Unclaimed and Mine, as pressed buttons', async () => {
    const w = await mixed();
    const { user } = renderHub(w);
    await ready();
    const group = within(pane()).getByRole('group', { name: 'Show' });
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(names().sort()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    await user.click(within(group).getByRole('button', { name: 'Unclaimed' }));
    expect(within(group).getByRole('button', { name: 'Unclaimed' })).toHaveAttribute('aria-pressed', 'true');
    expect(names().sort()).toEqual(['Charlie', 'Delta']);
    await user.click(within(group).getByRole('button', { name: 'Mine' }));
    expect(names()).toEqual(['Alpha']);
    await user.click(within(group).getByRole('button', { name: 'All' }));
    expect(names()).toHaveLength(4);
  });

  it('filters by category from a select that lists every category', async () => {
    const w = await mixed();
    const { user } = renderHub(w);
    await ready();
    const select = within(pane()).getByRole('combobox', { name: 'Category' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All categories', 'Harassment', 'Hate', 'Cheating', 'Spam', 'Disruption', 'Other']);
    await user.selectOptions(select, 'Spam');
    expect(names()).toEqual(['Delta']);
    await user.selectOptions(select, 'Hate');
    expect(names()).toEqual(['Charlie']);
  });

  it('the two filters combine, and a filter with no match says so and clears', async () => {
    const w = await mixed();
    const { user } = renderHub(w);
    await ready();
    await user.selectOptions(within(pane()).getByRole('combobox', { name: 'Category' }), 'Spam');
    await user.click(within(pane()).getByRole('button', { name: 'Mine' }));
    expect(within(pane()).getByText('No cases match these filters.')).toBeInTheDocument();
    await user.click(within(pane()).getByRole('button', { name: 'Show all cases' }));
    expect(names()).toHaveLength(4);
    expect(within(pane()).getByRole('combobox', { name: 'Category' })).toHaveValue('all');
  });
});

describe('take next', () => {
  it('claims the oldest unclaimed case and opens it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a, b] = await people(w, ['Alpha', 'Bravo']);
    await w.clientFor('maya@example.test').claimCase(a!.person);
    const { user, router } = renderHub(w);
    await ready();
    await user.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${b!.id}`));
    // No toast for it: the case opens, and its banner says "You're handling this".
    expect(await screen.findByRole('group', { name: 'Who is handling this case' })).toBeInTheDocument();
    expect(screen.queryByText(/^You took the/)).toBeNull();
    expect(w.cw.cases.holder(b!.person)?.by).toBe('ann@example.test');
    expect(rowOf('Bravo')).toHaveAttribute('data-claim', 'you');
    expect(w.sent.filter((r) => r.path === '/cases/next')).toHaveLength(1);
  });

  it('says so when no unclaimed case is left, and does not move', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.clientFor('maya@example.test').claimCase(a!.person);
    const { user, router } = renderHub(w);
    await ready();
    await user.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    expect(await screen.findByText('No unclaimed cases right now.')).toBeInTheDocument();
    expect(router.path).toBe('/');
  });

  it('asks for the category the filter is on', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await people(w, ['Alpha']);
    const spam = await w.file({ target: 'Spammer', reporter: 'RS', category: 'spam' });
    const { user, router } = renderHub(w);
    await ready();
    await user.selectOptions(within(pane()).getByRole('combobox', { name: 'Category' }), 'Spam');
    await user.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${spam.id}`));
    expect(w.sent.find((r) => r.path === '/cases/next')?.body).toEqual({ category: 'spam' });
  });

  it('a filter that would hide what you took is cleared', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await people(w, ['Alpha']);
    const { user } = renderHub(w);
    await ready();
    const group = within(pane()).getByRole('group', { name: 'Show' });
    await user.click(within(group).getByRole('button', { name: 'Unclaimed' }));
    await user.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    await waitFor(() => expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true'));
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'you');
  });

  it('a double click sends one request', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await people(w, ['Alpha', 'Bravo']);
    const { user } = renderHub(w);
    await ready();
    const button = within(pane()).getByRole('button', { name: /Take next case/ });
    await user.dblClick(button);
    await waitFor(() => expect(w.sent.filter((r) => r.path === '/cases/next').length).toBeGreaterThanOrEqual(1));
    expect(w.sent.filter((r) => r.path === '/cases/next')).toHaveLength(1);
  });

  it('shows a failure as a toast and keeps the queue', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await people(w, ['Alpha']);
    const { user } = renderHub(w);
    await ready();
    w.intercept.fn = (req) => (req.path === '/cases/next' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem');
    expect(rows()).toHaveLength(1);
  });

  it('is not offered to a role that cannot decide', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.decide': 'senior' } });
    await people(w, ['Alpha']);
    renderHub(w);
    await ready();
    expect(within(pane()).queryByRole('button', { name: /Take next case/ })).not.toBeInTheDocument();
  });

  it('wears the N shortcut on the button', async () => {
    const w = await hubWorld();
    renderHub(w);
    await ready();
    const button = within(pane()).getByRole('button', { name: /Take next case/ });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'N');
    expect(within(button).getByText('N')).toBeInTheDocument();
  });
});

describe('opening a case claims it', () => {
  it('claims an unclaimed case when its report page opens, then shows it as yours', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha', 'Bravo']);
    const { user } = renderHub(w);
    await ready();
    await user.click(within(rowOf('Alpha')).getByRole('link'));
    await waitFor(() => expect(w.cw.cases.holder(a!.person)?.by).toBe('ann@example.test'));
    await waitFor(() => expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'you'));
    expect(rowOf('Bravo')).toHaveAttribute('data-claim', 'none');
    expect(w.sent.filter((r) => r.path === `/cases/${a!.person}/claim`)).toHaveLength(1);
    expect(w.sent.some((r) => r.path === `/cases/${a!.person}/viewing`)).toBe(true);
  });

  it('opens a case someone else holds to read, says who has it, and does not take it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.clientFor('maya@example.test').claimCase(a!.person);
    renderHub(w, { path: `/reports/${a!.id}` });
    await ready();
    expect(await screen.findByText('maya is handling this case. Deciding it is refused until they release it.')).toBeInTheDocument();
    expect(w.cw.cases.holder(a!.person)?.by).toBe('maya@example.test');
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'other');
    // The report page itself still loads: a claim never blocks a read.
    expect(await screen.findByRole('heading', { level: 2, name: /Insults or harassment report against Alpha/ })).toBeInTheDocument();
  });

  it('a report that is not in the open queue (already decided) is opened without claiming anything', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.client.decide(a!.id, { verdict: 'no_action', reason: 'fine', actions: [] });
    renderHub(w, { path: `/reports/${a!.id}` });
    await ready();
    await screen.findByRole('heading', { level: 2, name: /report against Alpha/i });
    expect(w.sent.some((r) => r.path.startsWith('/cases/') && r.path.endsWith('/claim'))).toBe(false);
    // A decided case shows what was decided in the decision bar, not a claim banner.
    expect(await within(screen.getByRole('region', { name: 'Decision' })).findByText('Dismissed')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Who is handling this case' })).toBeNull();
  });

  it('the case pane says you are handling it, with Release, and who else is viewing', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    await w.clientFor('ana@example.test').viewing(a!.person);
    const { user } = renderHub(w, { path: `/reports/${a!.id}` });
    await ready();
    const banner = await screen.findByRole('group', { name: 'Who is handling this case' });
    expect(await within(banner).findByText("You're handling this.")).toBeInTheDocument();
    expect(within(banner).getByText('Released after 10 minutes idle.')).toBeInTheDocument();
    expect(await within(screen.getByRole('main')).findByText('ana is viewing')).toBeInTheDocument();
    const aside = screen.getByRole('complementary', { name: 'About this case' });
    expect(within(aside).getByRole('link', { name: 'Open the history of Alpha' })).toHaveAttribute('href', `#/people/${a!.person}`);
    await user.click(within(banner).getByRole('button', { name: 'Release' }));
    expect(await screen.findByText('Nobody is handling this.')).toBeInTheDocument();
    expect(w.cw.cases.holder(a!.person)).toBeNull();
  });

  it('after Release the open case does not claim itself again', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const [a] = await people(w, ['Alpha']);
    const { user } = renderHub(w, { path: `/reports/${a!.id}` });
    await ready();
    const banner = await screen.findByRole('group', { name: 'Who is handling this case' });
    await within(banner).findByText("You're handling this.");
    await user.click(within(banner).getByRole('button', { name: 'Release' }));
    await within(banner).findByText('Nobody is handling this.');
    const claims = (): number => w.sent.filter((r) => r.path === `/cases/${a!.person}/claim`).length;
    const before = claims();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(claims()).toBe(before);
  });
});
