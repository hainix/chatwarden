import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { DAY, HOUR, MINUTE, hubWorld } from './world.js';
import type { HubWorld } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The person page: the middle pane of the workbench for one person. Their timeline (reports about them and every sanction, with
// its state), what is in force now (each with a Revoke), and how the reports they filed have gone. All against the real routes.

const inForce = (): HTMLElement => screen.getByRole('region', { name: 'In force now' });
const timeline = (): HTMLElement => screen.getByRole('region', { name: 'Timeline' });
const reporterPanel = (): HTMLElement => screen.getByRole('region', { name: 'As a reporter' });
const items = (el: HTMLElement): HTMLElement[] => within(el).queryAllByRole('listitem');
const audits = (w: HubWorld, action: string): Array<{ target?: { type: string; ref?: string } }> =>
  w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action) as never;
const histories = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'GET' && /^\/people\/[^/]+\/history$/.test(r.path));

async function open(w: HubWorld, ref: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/people/${ref}`, ...options });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}

const SERVER_500 = { status: 500, body: { error: 'internal', message: 'x' } };

describe('the page', () => {
  it('is titled by the handle on their latest report, with the short tag beside it', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Velmora' });
    await open(w, f.person);
    expect(screen.getByRole('heading', { level: 2, name: 'Velmora' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText(personTag(f.person), { selector: '.cw-pid' })).toBeInTheDocument();
  });

  it('a person nobody has reported is titled "Person" and the tag, once, and the page is calm and empty', async () => {
    const w = await hubWorld();
    await open(w, 's_unknown_person_000000');
    expect(screen.getByRole('heading', { level: 2, name: 'Person s_unknow' })).toBeInTheDocument();
    expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument();
    expect(within(timeline()).getByText('Nothing in the last 90 days.')).toBeInTheDocument();
    expect(within(reporterPanel()).getByText('No reports yet')).toBeInTheDocument();
  });

  it('opens in the middle of the workbench: the queue stays at the left and there is no pane on the right', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Tarvo' });
    await open(w, f.person);
    expect(screen.getByRole('region', { name: 'Open cases' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'About this case' })).toBeNull();
    expect(document.querySelector('.cw-body')).toHaveAttribute('data-case', 'false');
  });

  it('opening it writes history.view once for this person, and nothing else audited (no report, rules or blocked-line read)', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Snorlo' });
    await w.sanction(f.person, 'chat', 1);
    await open(w, f.person);
    const mine = audits(w, 'history.view').filter((r) => r.target?.ref === f.person);
    expect(mine).toHaveLength(1);
    expect(audits(w, 'history.view')).toHaveLength(1);
    // The queue at the left lists reports (a `report.view` with no target); no one report, the rules or the blocked lines are read.
    expect(audits(w, 'report.view').filter((r) => r.target?.ref !== undefined)).toHaveLength(0);
    for (const other of ['policy.view', 'blocked.view']) expect(audits(w, other), other).toHaveLength(0);
    expect(histories(w)).toHaveLength(1);
  });

  it('is not available to a role that cannot read histories, and reads nothing', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    const f = await w.file();
    renderHub(w, { path: `/people/${f.person}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(histories(w)).toHaveLength(0);
  });

  it('a failed read says so with Try again, and Try again reads once more', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Glarn' });
    w.intercept.fn = (req) => (/\/history$/.test(req.path) ? SERVER_500 : undefined);
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the history.');
    expect(alert).toHaveTextContent('The server had a problem');
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Glarn' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never shows more of any ref than the 8-character tag: not in text, not in any attribute', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({ target: 'Fenrisk', reporter: 'Rae' });
    await w.sanction(f.person, 'ban', 2, 7 * DAY);
    await w.cw.sanctions.apply({ kind: 'chat', subject: f.person, includeIp: true, durationMs: HOUR, reason: 'r', actor: 'system', source: 'auto_filter', automated: true, rule: 1 });
    await open(w, f.person);
    await within(inForce()).findAllByRole('listitem');
    const html = document.body.innerHTML;
    for (const ref of [f.person, f.reporter]) expect(html, ref).not.toContain(ref.slice(0, 9));
    expect(html).not.toMatch(/\b[ak]:[\w-]{6,}/);
    // The same page for the reporter (who has no sanctions): still only the tag.
    expect(personTag(f.person)).toHaveLength(8);
  });
});

describe('a very long handle', () => {
  const LONG = 'Zephyr'.repeat(10);

  it('renders whole in the person title and in the Recent actions row (the stylesheet breaks it; jsdom cannot measure)', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: LONG });
    await w.sanction(f.person, 'warning', 1);
    expect(LONG).toHaveLength(60);
    await open(w, f.person);
    expect(screen.getByRole('heading', { level: 2, name: LONG })).toBeInTheDocument();
  });
});

describe('the timeline', () => {
  it('lists reports and sanctions together, newest first, each with its card, what, rule, who, ref code and time', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Mallory', category: 'harassment' });
    await w.sanction(f.person, 'warning', 1);
    w.clock.t += 5 * MINUTE;
    const g = await w.file({ target: 'Mallory', category: 'spam' });
    const chat = await w.sanction(g.person, 'chat', 2, DAY);
    await open(w, f.person);
    const rows = items(timeline());
    expect(rows).toHaveLength(4);
    // Newest first: the chat restriction, the second report, the warning, the first report.
    expect(rows[0]).toHaveTextContent('Chat restriction, 24 hours');
    expect(rows[0]).toHaveTextContent('Rule 2');
    expect(rows[0]).toHaveTextContent('by ann@example.test');
    expect(rows[0]).toHaveTextContent(`Ref ${chat.refCode}`);
    expect(rows[0]!.querySelector('.cw-card--restriction')).not.toBeNull();
    expect(rows[1]).toHaveTextContent('Report');
    // A report is not a sanction: no referee card, and no empty box in its place.
    expect(rows[1]!.querySelector('.cw-card, .cw-rec-mark')).toBeNull();
    expect(within(rows[1]!).queryByText('Open')).toBeNull();
    expect(rows[1]).toHaveTextContent('Spam');
    expect(within(rows[1]!).getByRole('link', { name: /View/ })).toHaveAttribute('href', `#/reports/${g.id}`);
    expect(rows[2]).toHaveTextContent('Warning');
    expect(rows[2]!.querySelector('.cw-card--warning')).not.toBeNull();
    expect(rows[3]).toHaveTextContent('Harassment');
    expect(within(rows[3]!).getByRole('link', { name: /View/ })).toHaveAttribute('href', `#/reports/${f.id}`);
  });

  it('opens a report from the timeline', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Mallory' });
    const { user, router } = await open(w, f.person);
    await user.click(within(timeline()).getByRole('link', { name: /View/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${f.id}`));
  });

  it('a role that cannot read reports sees the report line without a link', async () => {
    const w = await hubWorld({ permissions: { 'reports.read': 'owner' } });
    const f = await w.file({ target: 'Mallory' });
    await open(w, f.person);
    expect(items(timeline())).toHaveLength(1);
    expect(within(timeline()).queryByRole('link')).toBeNull();
  });

  describe('states', () => {
    it('active: Active, and how long is left', async () => {
      const w = await hubWorld();
      const f = await w.file();
      await w.sanction(f.person, 'chat', 1, 7 * DAY);
      await open(w, f.person);
      const row = items(timeline()).find((li) => li.textContent?.includes('Chat restriction'))!;
      expect(row).toHaveAttribute('data-state', 'active');
      expect(within(row).getByText('Active')).toBeInTheDocument();
      expect(row).toHaveTextContent('7d left');
    });

    it('expired: Ended, with when, and nothing left to revoke', async () => {
      const w = await hubWorld();
      const f = await w.file();
      await w.sanction(f.person, 'chat', 1, HOUR);
      w.clock.t += 3 * HOUR;
      await open(w, f.person);
      const row = items(timeline()).find((li) => li.textContent?.includes('Chat restriction'))!;
      expect(row).toHaveAttribute('data-state', 'ended');
      expect(within(row).getByText('Ended')).toBeInTheDocument();
      expect(row).toHaveTextContent('ended 2 hours ago');
      expect(row).not.toHaveTextContent('left');
      expect(within(row).queryByRole('button', { name: /^Revoke/ })).toBeNull();
      expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument();
    });

    it('revoked: struck out, Revoked, by whom, when, and the reason; and it is not in force', async () => {
      const w = await hubWorld({ role: 'senior' });
      const f = await w.file();
      const s = await w.sanction(f.person, 'ban', 2, 7 * DAY);
      await w.clientFor('bea@example.test').revokeSanction(s.groupId, 'appeal upheld');
      await open(w, f.person);
      const row = items(timeline()).find((li) => li.textContent?.includes('Ban'))!;
      expect(row).toHaveAttribute('data-state', 'revoked');
      expect(within(row).getByText('Revoked')).toBeInTheDocument();
      expect(row).toHaveTextContent('Revoked by bea@example.test');
      expect(row).toHaveTextContent('appeal upheld');
      expect(row).not.toHaveTextContent('left');
      expect(within(inForce()).queryByRole('listitem')).toBeNull();
    });

    it('permanent: Ban, permanent, with no time left', async () => {
      const w = await hubWorld({ role: 'senior' });
      const f = await w.file();
      await w.cw.sanctions.apply({ kind: 'ban', subject: f.person, includeIp: false, durationMs: null, reason: 'cheating', actor: 'ann@example.test', source: 'moderator', automated: false, rule: 2 });
      w.clock.t += 200 * DAY;
      await open(w, f.person);
      const row = items(timeline()).find((li) => li.textContent?.includes('Ban'))!;
      expect(row).toHaveTextContent('Ban, permanent');
      expect(row).toHaveAttribute('data-state', 'active');
      expect(row.querySelector('.cw-card--ban')).not.toBeNull();
      expect(row).not.toHaveTextContent('left');
      // A permanent one that is still in force is shown whatever its age.
      expect(items(inForce())).toHaveLength(1);
    });

    it('pending: "Not enforced yet" is shown (a sanction written while enforcement is off)', async () => {
      const w = await hubWorld();
      const f = await w.file();
      await w.sanction(f.person, 'chat', 1, DAY);
      w.intercept.fn = async (req) => {
        if (!/\/history$/.test(req.path)) return undefined;
        const res = await w.direct.personHistory(f.person);
        return { status: 200, body: { ...res, sanctions: res.sanctions.map((s) => ({ ...s, pending: true })) } };
      };
      await open(w, f.person);
      expect(within(items(timeline()).find((li) => li.textContent?.includes('Chat restriction'))!).getByText('Not enforced yet')).toBeInTheDocument();
    });

    it('a warning and a note have no length and no time left', async () => {
      const w = await hubWorld();
      const f = await w.file();
      await w.sanction(f.person, 'warning', 1);
      await w.sanction(f.person, 'note', 'uncovered');
      await open(w, f.person);
      const rows = items(timeline());
      expect(rows[0]).toHaveTextContent('Note');
      expect(rows[0]!.querySelector('.cw-card--note')).not.toBeNull();
      expect(rows[1]).toHaveTextContent('Warning');
      for (const row of rows.slice(0, 2)) expect(row).not.toHaveTextContent('left');
    });
  });

  it('shows the reason a moderator wrote, on the person page (staff only)', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    await open(w, f.person);
    expect(within(timeline()).getByText('private moderator reason')).toBeInTheDocument();
  });

  it('labels where it came from: an automatic one says automatic, and the AI slot says AI', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.cw.sanctions.apply({ kind: 'chat', subject: f.person, includeIp: false, durationMs: HOUR, reason: 'auto', actor: 'system', source: 'auto_filter', automated: true, rule: 1 });
    w.clock.t += 1000;
    await w.cw.sanctions.apply({ kind: 'warning', subject: f.person, includeIp: false, durationMs: null, reason: 'ai read', actor: 'ai-reader', source: 'ai', automated: false, rule: 1 });
    w.clock.t += 1000;
    await w.sanction(f.person, 'note', 3);
    await open(w, f.person);
    const rows = items(timeline());
    // Newest first: the moderator's note (no source label), the AI warning, the automatic restriction.
    expect(within(rows[0]!).queryByText('AI')).toBeNull();
    expect(within(rows[0]!).queryByText('Automatic filter')).toBeNull();
    expect(within(rows[1]!).getByText('AI')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Automatic filter')).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('automatic');
    expect(rows[2]).not.toHaveTextContent('by system');
  });

  it('shows the last 90 days only, as the kit sends it, and says so', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    w.clock.t += 120 * DAY;
    await w.sanction(f.person, 'chat', 2);
    await open(w, f.person);
    expect(within(timeline()).getByText(/Sanctions from the last 90 days/)).toBeInTheDocument();
    expect(items(timeline()).filter((li) => li.textContent?.includes('Warning'))).toHaveLength(0);
    expect(items(timeline()).filter((li) => li.textContent?.includes('Chat restriction'))).toHaveLength(1);
  });

  it('reads one history per open, whatever the page does (no polling, no second read)', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    await open(w, f.person);
    await new Promise((r) => setTimeout(r, 50));
    expect(histories(w)).toHaveLength(1);
  });
});

describe('what is in force now', () => {
  it('lists only what stands (active and not revoked), newest first, each with a Revoke button', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'chat', 1, HOUR);
    w.clock.t += 2 * HOUR;
    const warning = await w.sanction(f.person, 'warning', 1);
    const ban = await w.sanction(f.person, 'ban', 2, 7 * DAY);
    const gone = await w.sanction(f.person, 'area', 3, DAY);
    await w.client.revokeSanction(gone.groupId, 'oops');
    await open(w, f.person);
    const rows = items(inForce());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ban, 7 days');
    expect(rows[1]).toHaveTextContent('Warning');
    expect(within(rows[0]!).getByRole('button', { name: `Revoke Ban, 7 days (${ban.refCode})` })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: `Revoke Warning (${warning.refCode})` })).toBeInTheDocument();
  });

  it('the timeline rows have no Revoke button of their own', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    await open(w, f.person);
    expect(within(timeline()).queryByRole('button', { name: /^Revoke/ })).toBeNull();
  });

  it('a role that may not revoke sees what is in force and no Revoke button (the server table, not the role name)', async () => {
    const w = await hubWorld({ permissions: { 'sanctions.revoke': 'owner' } });
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    await open(w, f.person);
    expect(items(inForce())).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Revoke/ })).toBeNull();
  });

  it('an override can give a moderator more: sanctions.revoke at moderator and apply raised to owner', async () => {
    const w = await hubWorld({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    await open(w, f.person);
    expect(screen.getByRole('button', { name: /^Revoke/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sanction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
  });
});

describe('revoke', () => {
  const revokeButton = (): HTMLElement => within(inForce()).getByRole('button', { name: /^Revoke/ });
  const reasonBox = (): HTMLElement => screen.getByLabelText('Why are you revoking this?');
  const confirm = (): HTMLElement => screen.getByRole('button', { name: 'Confirm revoke' });
  const revokes = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/sanctions\/[^/]+\/revoke$/.test(r.path));

  async function oneBan(role: 'moderator' | 'senior' = 'moderator') {
    const w = await hubWorld({ role });
    const f = await w.file({ target: 'Mallory' });
    const ban = await w.sanction(f.person, 'ban', 2, 7 * DAY);
    const r = await open(w, f.person);
    return { w, f, ban, ...r };
  }

  it('asks for a reason first (no 5-second undo, no browser confirm), and sends nothing until it is given', async () => {
    const { w, user } = await oneBan();
    await user.click(revokeButton());
    expect(reasonBox()).toHaveFocus();
    expect(revokes(w)).toHaveLength(0);
    await user.click(confirm());
    expect(screen.getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    expect(reasonBox()).toHaveAttribute('aria-invalid', 'true');
    expect(revokes(w)).toHaveLength(0);
    // Spaces are no reason.
    await user.type(reasonBox(), '   ');
    await user.click(confirm());
    expect(revokes(w)).toHaveLength(0);
  });

  it('happy path: sends the reason, reloads the history once, and the ban moves out of what is in force into a revoked line', async () => {
    const { w, ban, user } = await oneBan();
    await user.click(revokeButton());
    await user.type(reasonBox(), 'Appeal upheld: it was a misread');
    expect(histories(w)).toHaveLength(1);
    await user.click(confirm());
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
    const sent = revokes(w);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/sanctions/${ban.groupId}/revoke`);
    expect(sent[0]?.body).toEqual({ reason: 'Appeal upheld: it was a misread' });
    // One more read of the history after the revoke, and no more (no polling).
    expect(histories(w)).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(histories(w)).toHaveLength(2);
    const row = items(timeline()).find((li) => li.textContent?.includes('Ban'))!;
    expect(row).toHaveAttribute('data-state', 'revoked');
    expect(row).toHaveTextContent('Appeal upheld: it was a misread');
    expect(await screen.findByText('Revoked Ban, 7 days.')).toBeInTheDocument();
    // The server really revoked it, with the reason and the actor.
    const stored = w.cw.sanctions.forPerson((await w.direct.listSanctions()).items[0]!.person)[0];
    expect(stored).toMatchObject({ revokedBy: 'ann@example.test', revokeReason: 'Appeal upheld: it was a misread' });
    expect(audits(w, 'sanction.revoke')).toHaveLength(1);
  });

  it('after a revoke, keyboard focus goes to the page title (the row that had it is gone)', async () => {
    const { user } = await oneBan();
    await user.click(revokeButton());
    await user.type(reasonBox(), 'done');
    await user.click(confirm());
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Mallory' })).toHaveFocus());
  });

  it('Cancel closes the form without sending, and the reason is not kept for the next time', async () => {
    const { w, user } = await oneBan();
    await user.click(revokeButton());
    await user.type(reasonBox(), 'half a thought');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Why are you revoking this?')).toBeNull();
    expect(revokes(w)).toHaveLength(0);
    expect(revokeButton()).toHaveFocus();
    await user.click(revokeButton());
    expect(reasonBox()).toHaveValue('');
  });

  it('only one revoke form is open at a time', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    await w.sanction(f.person, 'warning', 2);
    const { user } = await open(w, f.person);
    const buttons = within(inForce()).getAllByRole('button', { name: /^Revoke/ });
    await user.click(buttons[0]!);
    await user.click(within(inForce()).getAllByRole('button', { name: /^Revoke/ })[1]!);
    expect(screen.getAllByLabelText('Why are you revoking this?')).toHaveLength(1);
  });

  it('a double click on Confirm sends one revoke', async () => {
    const { w, user } = await oneBan();
    await user.click(revokeButton());
    await user.type(reasonBox(), 'once');
    await user.dblClick(confirm());
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
    expect(revokes(w)).toHaveLength(1);
  });

  it('two clicks inside the in-flight window: one POST, one more history read (2 in all, no third), one more history.view, one toast', async () => {
    const { w, user } = await oneBan();
    // The server takes a moment, so the second click really lands while the first revoke is still on its way.
    w.intercept.fn = async (req) => {
      if (/\/revoke$/.test(req.path)) await new Promise((r) => setTimeout(r, 80));
      return undefined;
    };
    await user.click(revokeButton());
    await user.type(reasonBox(), 'once only');
    const button = confirm();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 100));
    expect(revokes(w)).toHaveLength(1);
    expect(histories(w)).toHaveLength(2);
    expect(audits(w, 'history.view')).toHaveLength(2);
    expect(screen.getAllByText('Revoked Ban, 7 days.')).toHaveLength(1);
  });

  it('404 counts as already revoked: someone else got there first, so the page reloads and shows it as revoked, as a success', async () => {
    const { w, ban, user } = await oneBan();
    await w.clientFor('bea@example.test').revokeSanction(ban.groupId, 'revoked by bea');
    // The page still shows it in force: it was read before bea acted.
    await user.click(revokeButton());
    await user.type(reasonBox(), 'me too');
    await user.click(confirm());
    expect(await screen.findByText('It was already revoked.')).toBeInTheDocument();
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    const row = items(timeline()).find((li) => li.textContent?.includes('Ban'))!;
    expect(row).toHaveTextContent('Revoked by bea@example.test');
    expect(row).toHaveTextContent('revoked by bea');
    expect(histories(w)).toHaveLength(2);
  });

  it('a 403 shows a plain message, keeps the form and the reason, and does not reload', async () => {
    const { w, user } = await oneBan();
    w.intercept.fn = (req) => (/\/revoke$/.test(req.path) ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    await user.click(revokeButton());
    await user.type(reasonBox(), 'because');
    await user.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role cannot do this.');
    expect(reasonBox()).toHaveValue('because');
    expect(histories(w)).toHaveLength(1);
    expect(within(inForce()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('a network failure keeps the reason and Confirm sends it again, once', async () => {
    const { w, user } = await oneBan();
    let down = true;
    w.intercept.fn = (req) => {
      if (down && /\/revoke$/.test(req.path)) throw new Error('offline');
      return undefined;
    };
    await user.click(revokeButton());
    await user.type(reasonBox(), 'keep me');
    await user.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(reasonBox()).toHaveValue('keep me');
    down = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
    expect(revokes(w).filter((r) => !!r.body)).toHaveLength(2);
  });

  it('a server problem (500) says so and keeps the form', async () => {
    const { w, user } = await oneBan();
    w.intercept.fn = (req) => (/\/revoke$/.test(req.path) ? SERVER_500 : undefined);
    await user.click(revokeButton());
    await user.type(reasonBox(), 'x');
    await user.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem');
    expect(reasonBox()).toHaveValue('x');
  });

  it('a reason over 500 characters is refused before sending', async () => {
    const { w, user } = await oneBan();
    await user.click(revokeButton());
    await user.click(reasonBox());
    await user.paste('x'.repeat(501));
    await user.click(confirm());
    expect(screen.getByText('The reason is over 500 characters. Shorten it.')).toBeInTheDocument();
    expect(revokes(w)).toHaveLength(0);
  });

  it('a revoke is never held up by another moderator handling the person', async () => {
    const { w, f, user } = await oneBan();
    await w.clientFor('bea@example.test').claimCase(f.person);
    await user.click(revokeButton());
    await user.type(reasonBox(), 'fine');
    await user.click(confirm());
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
  });
});

describe('as a reporter', () => {
  it('shows how many reports they filed and how many held up, with the bar', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ reporter: 'Rae', target: 'T1', room: 'a1' });
    const b = await w.fileRich({ reporter: 'Rae', target: 'T2', room: 'a2' });
    await w.fileRich({ reporter: 'Rae', target: 'T3', room: 'a3' });
    await w.client.decide(a.id, { verdict: 'upheld', reason: 'ok', actions: [] });
    await w.client.decide(b.id, { verdict: 'no_action', reason: 'nothing', actions: [] });
    await open(w, a.reporter);
    const panel = reporterPanel();
    expect(within(panel).getByText('3 reports, 1 upheld')).toBeInTheDocument();
    expect(within(panel).getByRole('meter', { name: '1 of 2 decided reports upheld' })).toBeInTheDocument();
    expect(within(panel).queryByText(/suspended/)).toBeNull();
  });

  it('marks bad-faith reports and a reporting suspension that is still running', async () => {
    const w = await hubWorld();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await w.fileRich({ reporter: 'Rae', target: `T${i}`, room: `s${i}` })).id);
    for (const id of ids.slice(0, 3)) await w.client.decide(id, { verdict: 'bad_faith', reason: 'lied', evidence: 'made up', actions: [] });
    const rae = (await w.client.getReport(ids[0]!)).report.reporterPerson;
    await open(w, rae);
    const panel = reporterPanel();
    expect(within(panel).getByText('3 for bad faith.')).toBeInTheDocument();
    expect(within(panel).getByText(/^Reporting is suspended until /)).toBeInTheDocument();
  });

  it('a suspension that has run out is not shown', async () => {
    const w = await hubWorld();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await w.fileRich({ reporter: 'Rae', target: `T${i}`, room: `s${i}` })).id);
    for (const id of ids.slice(0, 3)) await w.client.decide(id, { verdict: 'bad_faith', reason: 'lied', evidence: 'made up', actions: [] });
    const rae = (await w.client.getReport(ids[0]!)).report.reporterPerson;
    w.clock.t += 40 * DAY;
    await open(w, rae);
    expect(within(reporterPanel()).queryByText(/suspended/)).toBeNull();
  });

  it('takes the record from the same history read: no second read for it', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reporter: 'Rae' });
    await open(w, f.reporter);
    await within(reporterPanel()).findByText('1 report, 0 upheld');
    expect(histories(w)).toHaveLength(1);
  });
});
