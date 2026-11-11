import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_SEVERE_RULES } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// Reporting in the case views, on the real routes and the real kit: what the reporter said it was ("Reported as ..." or "No reason given"),
// the reason filter in the queue, the Simple card that asks "Which rule does this break?" for a report with no clear rule, and how often a
// reporter's reasons matched the decisions.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const isSuggest = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/suggest$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
const owner = (o: Parameters<typeof hubWorld>[0] = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });

describe('Detailed: what the reporter said it was', () => {
  async function openDetailed(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
    const r = renderHub(w, { path: `/reports/${id}`, ...options });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    return r;
  }

  it('says "Reported as" with the reason, in the header and in the list of reports', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reason: 'harassment' });
    await openDetailed(w, f.id);
    // Once, as the chip beside the name (where the category used to be), not again in the facts row.
    expect(screen.getByText('Reported as Insults or harassment', { selector: '.cw-casecats *' })).toBeInTheDocument();
    expect(screen.getAllByText('Reported as Insults or harassment')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'About this report' })).queryByText(/Reported as/)).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Insults or harassment report against Mallory' })).toBeInTheDocument();
  });

  it('a report that gave no reason says so, in the header, the heading and the chip', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reason: null });
    const { container } = await openDetailed(w, f.id);
    expect(within(container.querySelector('.cw-casehead') as HTMLElement).getAllByText('No reason given')).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'About this report' })).queryByText(/No reason given|Reported as/)).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'No-reason report against Mallory' })).toBeInTheDocument();
    expect(screen.getByText('No reason given', { selector: '.cw-casecats *' })).toBeInTheDocument();
  });

  it('the old six categories read as their reasons (an old adopter keeps working)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ category: 'disruption' });
    await openDetailed(w, f.id);
    expect(screen.getByText('Reported as Throwing or griefing', { selector: '.cw-casecats *' })).toBeInTheDocument();
  });

  it('a relabelled reason shows its new name at once; a removed reason shows its id, not nothing', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reason: 'cheating' });
    expect(w.cw.policy.save({ reporting: { reasons: [{ id: 'cheating', label: 'Using hacks' }, { id: 'other', label: 'Something else' }] } }, { version: 0, actor: 'owen@example.test', reason: 'edit' }).ok).toBe(true);
    const a = await openDetailed(w, f.id);
    expect(screen.getByText('Reported as Using hacks', { selector: '.cw-casecats *' })).toBeInTheDocument();
    a.unmount();
    expect(w.cw.policy.save({ reporting: { reasons: [{ id: 'other', label: 'Something else' }] } }, { version: 1, actor: 'owen@example.test', reason: 'edit again' }).ok).toBe(true);
    await openDetailed(w, f.id);
    expect(screen.getByText('Reported as cheating', { selector: '.cw-casecats *' })).toBeInTheDocument();
  });

  it('the reports tab names the reason of each report in the case', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ target: 'Mallory', reporter: 'Saffron', reason: 'hate', room: 'one' });
    await w.fileRich({ target: 'Mallory', reporter: 'Rae', reason: null, room: 'two' });
    const { user } = await openDetailed(w, a.id);
    await user.click(await screen.findByRole('tab', { name: /^Reports/ }));
    const list = screen.getByRole('list', { name: 'Reports in this case' });
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('.cw-tag')?.textContent)).toEqual(['No reason given', 'Reported as Hate']);
  });

  it('never shows a staff-only fact of the reason: the rule mapping stays out of the page', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reason: 'harassment' });
    const { container } = await openDetailed(w, f.id);
    expect(container.textContent).not.toMatch(/"rules"|enabled|asksNote/);
  });
});

describe('the queue: the reason filter', () => {
  async function ready() {
    await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Open cases' })).queryByText('Loading the queue')).not.toBeInTheDocument());
  }
  const names = (): string[] =>
    within(within(screen.getByRole('region', { name: 'Open cases' })).getByRole('list', { name: 'Cases' }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.cw-case-name')?.textContent ?? '');
  async function world() {
    const w = await hubWorld();
    await w.file({ target: 'Alpha', reporter: 'R1', reason: 'harassment' });
    await w.file({ target: 'Bravo', reporter: 'R2', reason: 'cheating' });
    await w.file({ target: 'Charlie', reporter: 'R3', reason: null });
    await w.file({ target: 'Delta', reporter: 'R4', reason: 'cheating' });
    await w.file({ target: 'Delta', reporter: 'R5', reason: null });
    return w;
  }

  it('each row names the reasons in it, "No reason given" included', async () => {
    const w = await world();
    renderHub(w);
    await ready();
    const row = (name: string): HTMLElement => within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem').find((li) => li.querySelector('.cw-case-name')?.textContent === name) as HTMLElement;
    expect(within(row('Alpha')).getByText('Insults or harassment')).toBeInTheDocument();
    expect(within(row('Charlie')).getByText('No reason given')).toBeInTheDocument();
    expect(within(row('Delta')).getByText('Cheating')).toBeInTheDocument();
    expect(within(row('Delta')).getByText('No reason given')).toBeInTheDocument();
  });

  it('Detailed offers a Reported-as filter: all, the reasons in the queue, and "No reason given"', async () => {
    const w = await world();
    renderHub(w);
    await ready();
    const select = screen.getByRole('combobox', { name: 'Reported as' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All reasons', 'Insults or harassment', 'Cheating', 'No reason given']);
    expect(select).toHaveValue('all');
  });

  it.each([
    ['cheating', ['Delta', 'Bravo']],
    ['harassment', ['Alpha']],
    ['none', ['Delta', 'Charlie']],
    ['all', ['Delta', 'Charlie', 'Bravo', 'Alpha']],
  ])('choosing %s keeps the people with a report that said so', async (value, expected) => {
    const w = await world();
    renderHub(w);
    await ready();
    fireEvent.change(screen.getByRole('combobox', { name: 'Reported as' }), { target: { value } });
    expect(names().sort()).toEqual([...expected].sort());
  });

  it('combines with the claim filter, and a filter with nothing in it says so', async () => {
    const w = await world();
    const { user } = renderHub(w);
    await ready();
    fireEvent.change(screen.getByRole('combobox', { name: 'Reported as' }), { target: { value: 'none' } });
    await user.click(screen.getByRole('button', { name: 'Mine' }));
    expect(screen.queryByRole('list', { name: 'Cases' })).toBeNull();
  });

  it('is not in Simple mode', async () => {
    const w = await world();
    renderHub(w, { mode: 'simple' });
    await ready();
    expect(screen.queryByRole('combobox', { name: 'Reported as' })).toBeNull();
  });

  it('the server filter finds the same reports: an id, the old disruption id, and none', async () => {
    const w = await world();
    await w.file({ target: 'Echo', reporter: 'R6', category: 'disruption' });
    const ids = async (reason: string | null) => (await w.client.listReports({ reason })).items.map((r) => r.targetHandle).sort();
    expect(await ids('cheating')).toEqual(['Bravo', 'Delta']);
    expect(await ids(null)).toEqual(['Charlie', 'Delta']);
    expect(await ids('disruption')).toEqual(['Echo']);
    expect(await ids('griefing')).toEqual(['Echo']);
    expect(await ids('hate')).toEqual([]);
    expect((await w.client.listReports({ status: 'open' })).items).toHaveLength(6);
    const sent = w.sent.filter((r) => r.path === '/reports').map((r) => r.query?.reason);
    expect(sent.slice(0, 2)).toEqual(['cheating', 'none']);
  });
});

describe('Simple: what the card says it was reported for', () => {
  async function openSimple(w: HubWorld, id: string, name = 'Mallory') {
    const r = renderHub(w, { path: `/reports/${id}`, mode: 'simple' });
    await screen.findByRole('heading', { level: 2, name });
    await screen.findByRole('button', { name: /^No action needed/ });
    return r;
  }

  it('one report: "Reported as the reason by the reporter, when"', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron', reason: 'harassment' });
    await openSimple(w, f.id);
    expect(screen.getByText('Reported as Insults or harassment by Saffron, now.')).toBeInTheDocument();
  });

  it('a report with no reason says so before the reporter', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron', reason: null });
    await openSimple(w, f.id);
    expect(screen.getByText('No reason given. Reported by Saffron, now.')).toBeInTheDocument();
  });

  it('several reports count them and list the reasons, once each, "no reason given" included', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, reporter: 'Saffron', reason: 'hate', room: 'one' });
    await w.fileRich({ lines: TALK, reporter: 'Rae', reason: null, room: 'two' });
    await w.fileRich({ lines: TALK, reporter: 'Kit', reason: 'hate', room: 'three' });
    await openSimple(w, a.id);
    expect(screen.getByText('3 reports: Hate, no reason given.')).toBeInTheDocument();
  });
});

describe('Simple: the rule behind a reason', () => {
  const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
  async function openSimple(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
    const r = renderHub(w, { path: `/reports/${id}`, mode: 'simple', ...options });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    await screen.findByRole('button', { name: /^No action needed/ });
    return r;
  }
  const picker = () => within(decision()).getByRole('combobox', { name: 'Which rule does this break?' });
  const buttons = () => within(decision()).getAllByRole('button').map((b) => b.textContent?.replace(/\s*[0-9]$/, '').trim());
  /** The first button of the card once it offers a step (it is "No action needed" until then). */
  const step = async (): Promise<HTMLElement> => {
    await waitFor(() => expect(buttons()[0]).not.toBe('No action needed'));
    return decision().querySelector('.cw-scard-actions button') as HTMLElement;
  };

  describe('a report with no reason', () => {
    it('asks which rule, with nothing chosen and no step to send yet', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      await openSimple(w, f.id);
      expect(picker()).toHaveValue('');
      expect(within(picker()).getAllByRole('option')[0]).toHaveTextContent('Choose a rule');
      expect(within(picker()).getAllByRole('option').length).toBeGreaterThan(5);
      expect(buttons()).toEqual(['No action needed', 'Something else…']);
      expect(within(decision()).getByText('No rule is clear from what was reported. Pick one to see what the ladder suggests.')).toBeInTheDocument();
      expect(decides(w)).toHaveLength(0);
    });

    it('picking a rule shows the suggestion and the one-click button, through the same decision path', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(picker(), '2');
      await within(decision()).findByRole('button', { name: /^Restrict chat, 24 hours/ });
      expect(w.sent.filter(isSuggest)).toHaveLength(1);
      expect(w.sent.filter(isSuggest)[0]?.body).toMatchObject({ rule: 2, person: f.person });
      await user.click(within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ }));
      await pageHides();
      expect(decides(w)).toHaveLength(1);
      expect(decides(w)[0]?.body).toEqual({
        verdict: 'upheld',
        reason: w.cw.rules.get(2)?.title,
        actions: [{ subject: f.person, kind: 'chat', durationMs: 24 * 3_600_000, rule: 2, lineIds: [f.lineIds[1], f.lineIds[3]] }],
      });
      expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
    });

    it('a rule the ladder reads in the harsher column suggests the harsher step', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      const severe = DEFAULT_SEVERE_RULES[0] as number;
      await user.selectOptions(picker(), String(severe));
      await waitFor(() => expect(w.sent.filter(isSuggest)).toHaveLength(1));
      expect(w.sent.filter(isSuggest)[0]?.body).toMatchObject({ rule: severe });
    });

    it('changing the pick asks again; the last pick is the one sent; choosing "Choose a rule" takes the step away', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(picker(), '2');
      await within(decision()).findByRole('button', { name: /^Restrict chat, 24 hours/ });
      await user.selectOptions(picker(), '5');
      await waitFor(() => expect(w.sent.filter(isSuggest)).toHaveLength(2));
      await user.click(await step());
      await pageHides();
      expect((decides(w)[0]?.body as { actions: Array<{ rule: number }> }).actions[0]?.rule).toBe(5);
    });

    it('un-picking takes the step away again', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(picker(), '2');
      await within(decision()).findByRole('button', { name: /^Restrict chat, 24 hours/ });
      await user.selectOptions(picker(), '');
      expect(buttons()).toEqual(['No action needed', 'Something else…']);
    });

    it('"No action needed" works without a rule, as before', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.click(within(decision()).getByRole('button', { name: /^No action needed/ }));
      await pageHides();
      expect(decides(w)[0]?.body).toMatchObject({ verdict: 'no_action', actions: [] });
    });

    it('a failed suggestion says so and keeps the pick', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      w.intercept.fn = (req) => (isSuggest(req) ? { status: 500, body: { error: 'server_error', message: 'x' } } : undefined);
      await user.selectOptions(picker(), '2');
      expect(await within(decision()).findByRole('alert')).toHaveTextContent(/could not|went wrong|problem/i);
      expect(picker()).toHaveValue('2');
      expect(within(decision()).queryByRole('button', { name: /^Restrict chat/ })).toBeNull();
    });

    it('a late answer to an earlier pick does not replace the later one', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      const held: Array<() => void> = [];
      w.intercept.fn = async (req) => {
        if (isSuggest(req) && (req.body as { rule: number }).rule === 2) await new Promise<void>((r) => held.push(r));
        return undefined;
      };
      await user.selectOptions(picker(), '2');
      await user.selectOptions(picker(), '5');
      await step();
      held.forEach((r) => r());
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(picker()).toHaveValue('5');
      // The late answer is dropped: it is not kept, and it does not make the card ask for rule 5 again.
      expect(w.sent.filter(isSuggest)).toHaveLength(2);
      await user.click(await step());
      await pageHides();
      expect((decides(w)[0]?.body as { actions: Array<{ rule: number }> }).actions[0]?.rule).toBe(5);
    });
  });

  describe('a reason that maps to exactly one rule', () => {
    it('preselects the rule and says what it was reported as, so it can be changed', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      await openSimple(w, f.id);
      const rule = within(decision()).getByRole('combobox', { name: 'The rule it breaks' });
      expect(rule).toHaveValue('2');
      expect(within(decision()).getByText('Reported as Insults or harassment, which usually means rule 2. Change it if it is wrong.')).toBeInTheDocument();
      expect(within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ })).toBeInTheDocument();
    });

    it('sends the preselected rule with one click, as before (no extra read)', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      const { user } = await openSimple(w, f.id);
      await user.click(within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ }));
      await pageHides();
      expect((decides(w)[0]?.body as { actions: Array<{ rule: number }> }).actions[0]?.rule).toBe(2);
      expect(w.sent.filter(isSuggest)).toHaveLength(0);
    });

    it('changing the rule asks the ladder again and sends the new rule', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(within(decision()).getByRole('combobox', { name: 'The rule it breaks' }), '4');
      await waitFor(() => expect(w.sent.filter(isSuggest)).toHaveLength(1));
      expect(w.sent.filter(isSuggest)[0]?.body).toMatchObject({ rule: 4 });
      await user.click(await step());
      await pageHides();
      const body = decides(w)[0]?.body as { actions: Array<{ rule: number }>; reason: string };
      expect(body.actions[0]?.rule).toBe(4);
      expect(body.reason).toBe(w.cw.rules.get(4)?.title);
    });

    it('going back to the preselected rule needs no new read', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      const { user } = await openSimple(w, f.id);
      const rule = () => within(decision()).getByRole('combobox', { name: 'The rule it breaks' });
      await user.selectOptions(rule(), '4');
      await waitFor(() => expect(w.sent.filter(isSuggest)).toHaveLength(1));
      await user.selectOptions(rule(), '2');
      expect(w.sent.filter(isSuggest)).toHaveLength(1);
      expect(rule()).toHaveValue('2');
    });

    it('a reason edited to map to another rule preselects that one', async () => {
      const w = await hubWorld();
      expect(w.cw.policy.save({ reporting: { reasons: [{ id: 'harassment', label: 'Insults', rules: [3] }, { id: 'other', label: 'Something else' }] } }, { version: 0, actor: 'owen@example.test', reason: 'map' }).ok).toBe(true);
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      await openSimple(w, f.id);
      expect(within(decision()).getByRole('combobox', { name: 'The rule it breaks' })).toHaveValue('3');
      expect(within(decision()).getByText('Reported as Insults, which usually means rule 3. Change it if it is wrong.')).toBeInTheDocument();
    });
  });

  describe('the rest of the card follows the pick', () => {
    const barRule = (): HTMLElement => screen.getByLabelText('Community Rule');

    it('"Something else…" opens with the rule just picked, and the step the ladder suggests for it', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(picker(), '3');
      await step();
      await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
      expect(barRule()).toHaveValue('3');
    });

    it('with a reason that maps to one rule changed to another, the bar opens on the changed rule', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(within(decision()).getByRole('combobox', { name: 'The rule it breaks' }), '4');
      await step();
      await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
      expect(barRule()).toHaveValue('4');
    });

    it('with nothing picked the bar opens as it always did, with no rule chosen for the moderator', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
      const group = screen.queryByRole('group', { name: 'Action 1' });
      if (group !== null) expect(within(group).getByLabelText('Community Rule')).not.toHaveValue('3');
    });

    it('a bar the moderator has already started is not overwritten by the pick', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(picker(), '3');
      await step();
      await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
      await user.selectOptions(barRule(), '5');
      await user.click(screen.getByRole('button', { name: /^Back to the suggestion/ }));
      await user.selectOptions(picker(), '2');
      await step();
      await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
      expect(barRule()).toHaveValue('5');
    });

    it('the keys work with the rule field focused: 1 sends the step, 2 sends no action (a digit cannot type into this field)', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      await user.selectOptions(picker(), '2');
      await step();
      expect(picker()).toHaveFocus();
      await user.keyboard('1');
      await pageHides();
      expect(decides(w)).toHaveLength(1);
      expect((decides(w)[0]?.body as { actions: Array<{ rule: number }> }).actions[0]?.rule).toBe(2);
    });

    it('a failed suggestion offers Try again, which asks again for the same rule and shows the step', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: null });
      const { user } = await openSimple(w, f.id);
      let failing = true;
      w.intercept.fn = (req) => (isSuggest(req) && failing ? { status: 500, body: { error: 'server_error', message: 'x' } } : undefined);
      await user.selectOptions(picker(), '2');
      expect(await within(decision()).findByRole('alert')).toHaveTextContent('We could not get a suggestion for that rule.');
      failing = false;
      await user.click(within(decision()).getByRole('button', { name: 'Try again' }));
      await step();
      expect(w.sent.filter(isSuggest)).toHaveLength(2);
      expect(within(decision()).queryByRole('alert')).toBeNull();
      expect(picker()).toHaveValue('2');
    });
  });

  describe('a reason with no single rule', () => {
    it('"Something else" maps to none, so it asks', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'other' });
      await openSimple(w, f.id);
      expect(picker()).toHaveValue('');
      expect(screen.getByText('Reported as Something else by Reporter', { exact: false })).toBeInTheDocument();
    });

    it('a reason that maps to two rules asks, with those two rules first', async () => {
      const w = await hubWorld();
      expect(w.cw.policy.save({ reporting: { reasons: [{ id: 'hate', label: 'Hate', rules: [1, 3] }, { id: 'other', label: 'Something else' }] } }, { version: 0, actor: 'owen@example.test', reason: 'map' }).ok).toBe(true);
      const f = await w.fileRich({ lines: TALK, reason: 'hate' });
      await openSimple(w, f.id);
      expect(picker()).toHaveValue('');
      const usual = within(picker()).getByRole('group', { name: 'Usually this reason' });
      expect(within(usual).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['1', '3']);
      expect(within(picker()).getByRole('group', { name: 'Other rules' })).toBeInTheDocument();
    });

    it('a reason mapped only to a retired rule asks', async () => {
      const w = await hubWorld({ retire: [2] });
      const f = await w.fileRich({ lines: TALK, reason: 'harassment' });
      await openSimple(w, f.id);
      expect(picker()).toHaveValue('');
      expect(within(picker()).queryByRole('option', { name: /^Rule 2:/ })).toBeNull();
    });

    it('a reason that was removed from the settings asks', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK, reason: 'cheating' });
      expect(w.cw.policy.save({ reporting: { reasons: [{ id: 'other', label: 'Something else' }] } }, { version: 0, actor: 'owen@example.test', reason: 'short' }).ok).toBe(true);
      await openSimple(w, f.id);
      expect(picker()).toHaveValue('');
    });
  });

  describe('roles', () => {
    it('a role that cannot read the settings sees the card as before: no picker, no guess', async () => {
      const w = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
      const f = await w.fileRich({ lines: TALK, reason: null });
      renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
      await screen.findByRole('heading', { level: 2, name: 'Mallory' });
      await screen.findByRole('button', { name: /^No action needed/ });
      expect(within(decision()).queryByRole('combobox')).toBeNull();
    });

    it('a role that cannot apply steps gets no picker either', async () => {
      const w = await hubWorld({ role: 'moderator', permissions: { 'sanctions.apply': 'owner' } });
      const f = await w.fileRich({ lines: TALK, reason: null });
      renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
      await screen.findByRole('heading', { level: 2, name: 'Mallory' });
      await screen.findByRole('button', { name: /^No action needed/ });
      expect(within(decision()).queryByRole('combobox')).toBeNull();
    });
  });

  it('the rule picker lists the rules in force by number and title, and never a retired one', async () => {
    const w = await hubWorld({ retire: [6] });
    const f = await w.fileRich({ lines: TALK, reason: null });
    await openSimple(w, f.id);
    const options = within(picker()).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain(`Rule 1: ${w.cw.rules.get(1)?.title}`);
    expect(options.some((o) => o?.startsWith('Rule 6:'))).toBe(false);
  });
});

describe('a reporter\'s reasons: how often they matched', () => {
  /** `n` reports from one reporter, each decided; the first `matched` cite the rule the reason maps to (rule 2 for harassment). */
  async function decided(w: HubWorld, reporter: string, n: number, matched: number) {
    let last: Awaited<ReturnType<HubWorld['file']>> | undefined;
    for (let i = 0; i < n; i += 1) {
      const f = await w.file({ target: `Target${i}`, reporter, reason: 'harassment' });
      const subject = w.cw.rooms.subjectAt(f.room, 'p2');
      if (subject === null) throw new Error('no subject');
      const res = await w.cw.decide({
        reportId: f.id,
        verdict: 'upheld',
        actor: 'ann@example.test',
        reason: 'checked',
        actions: [{ subject, kind: 'warning', durationMs: null, rule: i < matched ? 2 : 5, lineIds: [] }],
      });
      expect(res.ok).toBe(true);
      last = f;
    }
    return last as NonNullable<typeof last>;
  }
  async function openReporter(w: HubWorld, reporterRef: string) {
    renderHub(w, { path: `/people/${reporterRef}` });
    await screen.findAllByRole('heading', { level: 2 });
  }

  it('says it in plain words on the reporter\'s page: "Their reasons matched the decision 3 of 4 times."', async () => {
    const w = await owner();
    const last = await decided(w, 'Rae', 4, 3);
    await openReporter(w, last.reporter);
    expect(await screen.findByText('Their reasons matched the decision 3 of 4 times.')).toBeInTheDocument();
  });

  it('says it beside the case, in the reporters of the case', async () => {
    const w = await owner();
    await decided(w, 'Rae', 4, 3);
    const open = await w.fileRich({ target: 'Mallory', reporter: 'Rae', reason: 'harassment' });
    renderHub(w, { path: `/reports/${open.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    const list = await screen.findByRole('list', { name: 'Reporters of this case' });
    expect(await within(list).findByText('Their reasons matched the decision 3 of 4 times.')).toBeInTheDocument();
  });

  it.each([
    [3, 3, 'Their reasons matched the decision 3 of 3 times.'],
    [3, 0, 'Their reasons matched the decision 0 of 3 times.'],
    [5, 1, 'Their reasons matched the decision 1 of 5 times.'],
  ])('%i decided and %i matched reads "%s"', async (n, matched, text) => {
    const w = await owner();
    const last = await decided(w, 'Rae', n, matched);
    await openReporter(w, last.reporter);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('with fewer than three decided reports it says nothing at all', async () => {
    const w = await owner();
    const last = await decided(w, 'Rae', 2, 2);
    await openReporter(w, last.reporter);
    await screen.findAllByText(/reports/i);
    expect(screen.queryByText(/Their reasons matched/)).toBeNull();
  });

  it('a reporter who gave no reasons has nothing to match, so it says nothing', async () => {
    const w = await owner();
    let last: Awaited<ReturnType<typeof w.file>> | undefined;
    for (let i = 0; i < 4; i += 1) {
      const f = await w.file({ target: `T${i}`, reporter: 'Rae', reason: null });
      const subject = w.cw.rooms.subjectAt(f.room, 'p2');
      await w.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'ann@example.test', reason: 'checked', actions: [{ subject: subject as string, kind: 'warning', durationMs: null, rule: 2, lineIds: [] }] });
      last = f;
    }
    await openReporter(w, (last as NonNullable<typeof last>).reporter);
    await screen.findAllByText(/reports/i);
    expect(screen.queryByText(/Their reasons matched/)).toBeNull();
  });
});
