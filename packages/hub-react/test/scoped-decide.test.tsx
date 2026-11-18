import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// C11 task 0: a scoped moderator acts from a case. The rule list comes from GET /policy/rules (they cannot read the whole policy), the decision bar is trimmed to their limits, and the Person page offers no
// Sanction form (it sends no report id, which a scoped caller's sanction needs). End to end: the hub client over the real routes.

const A = 'creator:alice';
const B = 'creator:bob';

/** The Undo window passes at once (the page hides: a held decision is sent on the spot). */
async function sendNow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
}

async function openCase(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  const bar = await screen.findByRole('region', { name: 'Decision' });
  await within(bar).findByRole('radio', { name: 'Fair' });
  return { ...r, bar };
}

const optionNames = (select: HTMLElement): string[] => within(select).getAllByRole('option').map((o) => o.textContent ?? '');

describe('the decision bar of a scoped moderator', () => {
  it('draws the action row (the rules are there): no "cannot read the rules" line, an Add an action button, and nothing the limits refuse', async () => {
    const w = await hubWorld({ role: 'moderator', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    const { user, bar } = await openCase(w, f.id);
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    expect(within(bar).queryByText(/cannot read the rules|rules could not be read/i)).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Add an action' }) ?? within(bar).queryByRole('button', { name: 'Change' })).not.toBeNull();
    await user.click(within(bar).getByRole('button', { name: 'Change' }));
    const add = within(bar).queryByRole('button', { name: 'Add an action' });
    if (add !== null) await user.click(add);
    const group = within(bar).getAllByRole('group', { name: /^Action 1/ })[0]!;
    const names = optionNames(within(group).getByLabelText('What happens'));
    expect(names).toContain('Warning');
    expect(names.some((n) => /^Chat restriction/.test(n))).toBe(true);
    expect(names.join('|')).not.toMatch(/Area|Ban/);
  });

  it('a scoped moderator decides a chat restriction of one hour: the report is closed and the sanction is in the history with its report', async () => {
    const w = await hubWorld({ role: 'moderator', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    const { user, bar } = await openCase(w, f.id);
    await user.click(within(bar).getByRole('button', { name: 'Change' }));
    const remove = within(bar).queryByRole('button', { name: 'Remove action 1' });
    if (remove !== null) await user.click(remove);
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    await user.click(within(bar).getByRole('button', { name: 'Add an action' }));
    const group = within(bar).getByRole('group', { name: 'Action 1' });
    const what = within(group).getByLabelText('What happens');
    await user.selectOptions(what, within(what).getByRole('option', { name: /^Chat restriction, 24 hours/ }));
    await user.type(within(bar).getByRole('textbox', { name: 'Reason' }), 'Clear from the chat.');
    await user.click(within(bar).getByRole('button', { name: 'Decide' }));
    await sendNow();
    await within(bar).findByText('Decided. The report is closed.', { selector: 'strong' });
    const history = await w.client.personHistory(f.person);
    expect(history.sanctions).toHaveLength(1);
    expect(history.sanctions[0]).toMatchObject({ kind: 'chat', revokedAt: null });
    expect(w.cw.reports.get(f.id)?.status).not.toBe('open');
  });

  it('end to end through the client: within the limits succeeds, beyond them (a ban, a permanent restriction, 8 days) is refused invalid_sanction and the report stays open', async () => {
    const w = await hubWorld({ role: 'moderator', scope: [A] });
    const ok = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    const done = await w.client.decide(ok.id, { verdict: 'upheld', actions: [{ subject: ok.person, kind: 'chat', durationMs: HOUR, rule: 1 }], reason: 'within' });
    expect(done).toBeDefined();
    expect(w.cw.reports.get(ok.id)?.status).not.toBe('open');
    for (const action of [
      { kind: 'ban' as const, durationMs: HOUR },
      { kind: 'chat' as const, durationMs: null },
      { kind: 'chat' as const, durationMs: 8 * DAY },
    ]) {
      const r = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
      await expect(w.client.decide(r.id, { verdict: 'upheld', actions: [{ subject: r.person, rule: 1, ...action }], reason: 'beyond' })).rejects.toMatchObject({ code: 'invalid_sanction' });
      expect(w.cw.reports.get(r.id)?.status).toBe('open');
    }
  });

  it('a case in another scope is not reachable: the client gets 404 and the bar is not drawn with a decision', async () => {
    const w = await hubWorld({ role: 'moderator', scope: [A] });
    const other = await w.fileRich({ target: 'Mallory', tags: { scope: B } });
    await expect(w.client.decide(other.id, { verdict: 'upheld', actions: [{ subject: other.person, kind: 'warning', durationMs: null, rule: 1 }], reason: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('the client reads the rules for a scoped caller from the rules route and never calls GET /policy', async () => {
    const w = await hubWorld({ role: 'moderator', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    const { bar } = await openCase(w, f.id);
    expect(bar).toBeInTheDocument();
    const paths = w.sent.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /policy/rules');
    expect(paths).not.toContain('GET /policy');
  });

  it('control: an unscoped moderator reads GET /policy (not the rules route) and sees the same bar', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.fileRich({ target: 'Mallory' });
    await openCase(w, f.id);
    const paths = w.sent.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /policy');
    expect(paths).not.toContain('GET /policy/rules');
  });

  it('control: an unscoped senior still offers a ban in the same menu', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({ target: 'Mallory' });
    const { user, bar } = await openCase(w, f.id);
    await user.click(within(bar).getByRole('button', { name: 'Change' }));
    const add = within(bar).queryByRole('button', { name: 'Add an action' });
    if (add !== null) await user.click(add);
    const group = within(bar).getAllByRole('group', { name: /^Action 1/ })[0]!;
    expect(optionNames(within(group).getByLabelText('What happens')).join('|')).toMatch(/Ban/);
  });
});

describe('the Person page of a scoped moderator', () => {
  it('has no Sanction and no Note button (they act from a case, which carries the report id), and still shows the history', async () => {
    const w = await hubWorld({ role: 'moderator', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    renderHub(w, { path: `/people/${f.person}` });
    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Sanction' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Add a )?note$/i })).toBeNull();
  });

  it('control: an unscoped moderator has both buttons', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.file({ target: 'Mallory' });
    renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.getByRole('button', { name: 'Sanction' })).toBeInTheDocument();
  });
});
