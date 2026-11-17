import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// A second look (design 6): "Ask a senior to look" and "Escalate to the owner" in the case's menu, each with an optional note; "Asked for
// a look by <name>, <time>" on the case with "Looked at"; one word on the queue row and one option in the filters; one line on Overview.
// All of it behind `desk.workflow`; with it off the pages are what they were.

const ON: WorldOptions = { overrides: { desk: { workflow: true, insights: true } } };
const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'More actions on this case' });
const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const rows = (): HTMLElement[] => within(pane()).getAllByRole('listitem');

async function openCase(w: HubWorld, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('tablist');
  return r;
}

describe('with workflow off none of it renders', () => {
  it('the case menu offers only Mark as urgent, the tabs are the three it had, the row, the filters and Overview carry nothing', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    expect(within(screen.getByRole('group', { name: 'More actions on this case' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark as urgent']);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Evidence', 'Reports (1)', 'History']);
    expect(within(pane()).queryByText('Asked for a look')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Asked for a look' })).toBeNull();
    expect(screen.queryByText(/waiting for a senior look/)).toBeNull();
    expect(screen.queryByText(/Asked for a look by/)).toBeNull();
  });

  it('the server answers 404 to an ask, and the hub never sends one', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    await expect(w.direct.escalate(f.id, { to: 'owner' })).rejects.toMatchObject({ status: 404 });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    expect(w.sent.filter((r) => r.path.endsWith('/escalate'))).toEqual([]);
  });
});

describe('the menu items', () => {
  it('a moderator is offered both, in words', async () => {
    const w = await hubWorld({ ...ON });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    const labels = within(screen.getByRole('group', { name: 'More actions on this case' })).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Mark as urgent', 'Ask a senior to look', 'Escalate to the owner']);
  });

  it('a senior is offered both too; the owner asks no one and has neither', async () => {
    const senior = await hubWorld({ ...ON, role: 'senior' });
    const f = await senior.file({ target: 'Mallory', reason: 'spam' });
    const a = await openCase(senior, f.id);
    await a.user.click(menuButton());
    expect(screen.getByRole('button', { name: 'Ask a senior to look' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Escalate to the owner' })).toBeInTheDocument();
    a.unmount();
    const owner = await hubWorld({ ...ON, role: 'owner' });
    const g = await owner.file({ target: 'Mallory', reason: 'spam' });
    const b = await openCase(owner, g.id);
    await b.user.click(menuButton());
    expect(screen.queryByRole('button', { name: 'Ask a senior to look' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Escalate to the owner' })).toBeNull();
  });

  it('only with the permission: raised to the owner, a moderator has neither', async () => {
    const w = await hubWorld({ ...ON, permissions: { 'reports.escalate': 'owner' } });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    expect(screen.queryByRole('button', { name: 'Ask a senior to look' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark as urgent' })).toBeInTheDocument();
  });

  it('a decided case offers neither', async () => {
    const w = await hubWorld({ ...ON, role: 'senior' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.direct.decide(f.id, { verdict: 'no_action', actions: [] });
    const { container } = await openCase(w, f.id);
    expect(container.querySelector('.cw-case-menu')).toBeNull();
  });
});

describe('asking for a look', () => {
  it('opens a small form with an optional note; sending goes to the right target with the note, and the case shows who asked', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Ask a senior to look' }));
    const form = screen.getByRole('group', { name: 'Ask a senior to look' });
    await user.type(within(form).getByRole('textbox', { name: 'Note (optional)' }), 'Not sure this is spam');
    await user.click(within(form).getByRole('button', { name: 'Send' }));
    await screen.findByText(/Asked for a look by ann/);
    const sent = w.sent.filter((r) => r.method === 'POST' && r.path === `/reports/${f.id}/escalate`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ to: 'senior', note: 'Not sure this is spam' });
    // The menu closed and has its button back.
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('the owner target sends to the owner, and a note is not required', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Escalate to the owner' }));
    await user.click(within(screen.getByRole('group', { name: 'Escalate to the owner' })).getByRole('button', { name: 'Send' }));
    await screen.findByText(/Asked for a look by ann/);
    expect(w.sent.find((r) => r.path === `/reports/${f.id}/escalate`)?.body).toEqual({ to: 'owner' });
  });

  it('Cancel changes nothing; a note over 500 characters is refused before it is sent', async () => {
    const w = await hubWorld({ ...ON });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Ask a senior to look' }));
    const form = screen.getByRole('group', { name: 'Ask a senior to look' });
    const note = within(form).getByRole('textbox', { name: 'Note (optional)' });
    await user.click(note);
    await user.paste('n'.repeat(501));
    expect(within(form).getByText('Keep the note to 500 characters or fewer.')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Send' }));
    expect(w.sent.filter((r) => r.path.endsWith('/escalate'))).toEqual([]);
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(w.sent.filter((r) => r.path.endsWith('/escalate'))).toEqual([]);
    expect(screen.queryByText(/Asked for a look by/)).toBeNull();
  });

  it('a refusal says why in words and keeps the form', async () => {
    const w = await hubWorld({ ...ON });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Ask a senior to look' }));
    w.intercept.fn = (req) => (req.path.endsWith('/escalate') ? { status: 409, body: { error: 'already_decided', message: 'x' } } : undefined);
    await user.click(within(screen.getByRole('group', { name: 'Ask a senior to look' })).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Ask a senior to look' })).toBeInTheDocument();
  });

  it('asking does not take the case, change its claim or block a decision', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.clientFor('bea@example.test').claimCase(f.person);
    await w.direct.escalate(f.id, { to: 'senior' });
    const claim = (await w.direct.getReport(f.id)).claim;
    expect(claim?.by).toBe('bea@example.test');
    // Bea's own decision still goes through.
    await expect(w.clientFor('bea@example.test').decide(f.id, { verdict: 'no_action', actions: [] })).resolves.toMatchObject({ ok: true });
  });
});

describe('"Looked at"', () => {
  async function asked(role: 'moderator' | 'senior' | 'owner', by = 'ann@example.test') {
    const w = await hubWorld({ ...ON, role, actor: `${role}@example.test` });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.clientFor(by, 'moderator').escalate(f.id, { to: 'senior' });
    return { w, f };
  }

  it('clears the line for the asker', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.direct.escalate(f.id, { to: 'senior' });
    const { user } = await openCase(w, f.id);
    await screen.findByText(/Asked for a look by ann/);
    await user.click(screen.getByRole('button', { name: 'Looked at' }));
    await waitFor(() => expect(screen.queryByText(/Asked for a look by/)).toBeNull());
    expect((await w.direct.getReport(f.id)).report.escalation).toBeNull();
  });

  it('clears it for a senior, and is absent for an unrelated moderator (who still sees the line)', async () => {
    const senior = await asked('senior');
    const a = await openCase(senior.w, senior.f.id);
    await screen.findByText(/Asked for a look by ann/);
    expect(screen.getByRole('button', { name: 'Looked at' })).toBeInTheDocument();
    a.unmount();
    const other = await asked('moderator', 'bea@example.test');
    await openCase(other.w, other.f.id);
    await screen.findByText(/Asked for a look by bea/);
    expect(screen.queryByRole('button', { name: 'Looked at' })).toBeNull();
  });

  it('an ask of the owner is cleared by the owner and not by a senior', async () => {
    const w = await hubWorld({ ...ON, role: 'senior', actor: 'sam@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.clientFor('ann@example.test').escalate(f.id, { to: 'owner' });
    const a = await openCase(w, f.id);
    await screen.findByText(/Asked for a look by ann/);
    expect(screen.queryByRole('button', { name: 'Looked at' })).toBeNull();
    a.unmount();
    const owner = await hubWorld({ ...ON, role: 'owner', actor: 'owen@example.test' });
    const g = await owner.file({ target: 'Mallory', reason: 'spam' });
    await owner.clientFor('ann@example.test').escalate(g.id, { to: 'owner' });
    await openCase(owner, g.id);
    expect(await screen.findByRole('button', { name: 'Looked at' })).toBeInTheDocument();
  });

  it('deciding the case clears the line', async () => {
    const w = await hubWorld({ ...ON, role: 'senior', actor: 'sam@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.clientFor('ann@example.test').escalate(f.id, { to: 'senior' });
    await w.direct.decide(f.id, { verdict: 'no_action', actions: [] });
    await openCase(w, f.id);
    expect(screen.queryByText(/Asked for a look by/)).toBeNull();
    expect((await w.direct.getReport(f.id)).report.escalation).toBeNull();
  });
});

describe('the queue', () => {
  async function two(role: 'moderator' | 'senior' | 'owner') {
    const w = await hubWorld({ ...ON, role, actor: `${role}@example.test` });
    const a = await w.file({ target: 'Alpha', reason: 'spam' });
    w.clock.t += 1000;
    const b = await w.file({ target: 'Bravo', reason: 'spam' });
    w.clock.t += 1000;
    await w.file({ target: 'Charlie', reason: 'spam' });
    await w.clientFor('ann@example.test').escalate(a.id, { to: 'senior' });
    await w.clientFor('ann@example.test').escalate(b.id, { to: 'owner' });
    return w;
  }
  const names = (): string[] => rows().map((r) => r.querySelector('.cw-case-name')?.textContent ?? '');
  async function ready() {
    await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(rows()).toHaveLength(3));
  }

  it('shows the row word on the asked rows only, and the order is not changed by it', async () => {
    const w = await two('senior');
    renderHub(w);
    await ready();
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const words = rows().map((r) => within(r).queryByText('Asked for a look') !== null);
    expect(words).toEqual([true, true, false]);
  });

  it('the Filters option lists only cases addressed to the caller\'s role or lower: a senior sees the ask of a senior, the owner sees both, a moderator none', async () => {
    const expected = { senior: ['Alpha'], owner: ['Alpha', 'Bravo'], moderator: [] } as const;
    for (const role of ['senior', 'owner', 'moderator'] as const) {
      const w = await two(role);
      const { user, unmount } = renderHub(w);
      await ready();
      await user.click(screen.getByRole('checkbox', { name: 'Asked for a look' }));
      if (expected[role].length === 0) await screen.findByText('No cases match these filters.');
      else await waitFor(() => expect(names()).toEqual(expected[role]));
      await user.click(screen.getByRole('checkbox', { name: 'Asked for a look' }));
      await waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']));
      unmount();
    }
  });

  it('is not offered in Simple mode, where the filters are not', async () => {
    const w = await two('senior');
    renderHub(w, { mode: 'simple' });
    await ready();
    expect(screen.queryByRole('checkbox', { name: 'Asked for a look' })).toBeNull();
  });
});

describe('Overview', () => {
  async function overview(role: 'moderator' | 'senior' | 'owner', options: WorldOptions = ON, asks = 1) {
    const w = await hubWorld({ ...options, role, actor: `${role}@example.test` });
    for (let i = 0; i < asks; i += 1) {
      const f = await w.file({ target: `Target${i}`, reason: 'spam' });
      w.clock.t += 1000;
      await w.clientFor('ann@example.test').escalate(f.id, { to: 'senior' }).catch(() => undefined);
    }
    renderHub(w);
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane()).queryByText('Loading the queue')).toBeNull());
    return w;
  }

  it('the line shows when workflow is on, the caller may act and the number is above zero', async () => {
    await overview('senior', ON, 2);
    expect(await screen.findByText('2 cases are waiting for a senior look')).toBeInTheDocument();
  });

  it('says one case in the singular', async () => {
    await overview('senior', ON, 1);
    expect(await screen.findByText('1 case is waiting for a senior look')).toBeInTheDocument();
  });

  it('is absent at zero, for a moderator (who cannot act on it), and with workflow off', async () => {
    await overview('senior', ON, 0);
    expect(screen.queryByText(/waiting for a senior look/)).toBeNull();
    cleanupAll();
    await overview('moderator', ON, 2);
    expect(screen.queryByText(/waiting for a senior look/)).toBeNull();
    cleanupAll();
    await overview('senior', { overrides: { desk: { insights: true } } }, 2);
    expect(screen.queryByText(/waiting for a senior look/)).toBeNull();
  });

  it('the Insights link shows only when Insights is on and the caller may read it', async () => {
    await overview('moderator', ON, 0);
    expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument();
    cleanupAll();
    await overview('moderator', { overrides: { desk: { workflow: true } } }, 0);
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull();
    cleanupAll();
    await overview('moderator', { ...ON, permissions: { 'insights.read': 'owner' } }, 0);
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull();
  });
});

const cleanupAll = (): void => cleanup();
