import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The Person page's "Do not automate" (AI levels 3 and 4, design 6.4 and 9.3): a senior marks a person so the AI never acts on them, from a `...` item with a
// code picker; the mark shows as a quiet line on the page for everyone who can read the page. The hub only sends the choice: the server checks the role and the
// code, and the mark is read back from the server after each change. Nothing here makes the AI act.

afterEach(() => cleanup());

const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && /^\/people\/[^/]+\/automation$/.test(r.path));
const world = (o: WorldOptions = {}) => hubWorld({ role: 'senior', actor: 'sen_ann', ...o });

async function openPerson(w: HubWorld, person: string) {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const more = () => screen.findByRole('button', { name: 'More' });

describe('the "..." item', () => {
  it('exists for a senior and not for a moderator', async () => {
    const w = await world();
    const f = await w.file();
    await openPerson(w, f.person);
    expect(await more()).toBeInTheDocument();
    cleanup();
    const m = await world({ role: 'moderator' });
    const g = await m.file();
    await openPerson(m, g.person);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByText('Do not automate')).toBeNull();
  });

  it('follows the permission: lowered to moderator a moderator has it, raised to owner a senior has not', async () => {
    const low = await world({ role: 'moderator', permissions: { 'automation.write': 'moderator' } });
    const a = await low.file();
    await openPerson(low, a.person);
    expect(await more()).toBeInTheDocument();
    cleanup();
    const high = await world({ permissions: { 'automation.write': 'owner' } });
    const b = await high.file();
    await openPerson(high, b.person);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('is behind a disclosure: closed it shows nothing else, open it shows a group with a reason picker', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    const button = await more();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Do not automate' })).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Do not automate' });
    const picker = within(group).getByLabelText('Reason') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['A vulnerable person', 'Under review', 'A member of staff', 'A sensitive case', 'Another reason']);
    expect(within(group).getByText(/never acts on this person/)).toBeInTheDocument();
    expect(puts(w)).toEqual([]);
  });

  it('choosing a code calls the route with that code, and the mark shows as a quiet line afterwards', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    await user.click(await more());
    const group = screen.getByRole('group', { name: 'Do not automate' });
    await user.selectOptions(within(group).getByLabelText('Reason'), 'sensitive_case');
    await user.click(within(group).getByRole('button', { name: 'Do not automate this person' }));
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect(puts(w)[0]).toMatchObject({ method: 'PUT', path: `/people/${f.person}/automation`, body: { allowed: false, code: 'sensitive_case' } });
    // the line comes from the server's answer on the next read, not from what the hub sent
    expect(await screen.findByText(/Do not automate: the AI never acts on this person\. Reason: a sensitive case\./)).toBeInTheDocument();
    expect(w.cw.people.automation.get(f.person)).toMatchObject({ allowed: false, code: 'sensitive_case' });
    expect(w.cw.audit.list({ limit: 20 }).items.some((a) => a.action === 'person.automation' && a.actor === 'sen_ann')).toBe(true);
  });

  it('every code is offered and sent as it is', async () => {
    for (const [code, label] of [
      ['vulnerable', 'A vulnerable person'],
      ['under_review', 'Under review'],
      ['staff', 'A member of staff'],
      ['sensitive_case', 'A sensitive case'],
      ['other', 'Another reason'],
    ] as const) {
      const w = await world();
      const f = await w.file();
      const { user } = await openPerson(w, f.person);
      await user.click(await more());
      await user.selectOptions(screen.getByLabelText('Reason'), code);
      await user.click(screen.getByRole('button', { name: 'Do not automate this person' }));
      await waitFor(() => expect(puts(w)).toHaveLength(1));
      expect(puts(w)[0]?.body).toEqual({ allowed: false, code });
      expect(await screen.findByText(new RegExp(`Reason: ${label.toLowerCase()}\\.`))).toBeInTheDocument();
      cleanup();
    }
  });
});

describe('a marked person', () => {
  it('shows the quiet line to a moderator, who has no way to change it', async () => {
    const w = await world({ role: 'moderator' });
    const f = await w.file();
    w.cw.people.automation.set(f.person, { allowed: false, code: 'vulnerable', actor: 'sen_bea' });
    await openPerson(w, f.person);
    expect(await screen.findByText(/Do not automate: the AI never acts on this person\. Reason: a vulnerable person\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow the AI again' })).toBeNull();
    // the line names no one: not who set it
    expect(document.body.textContent).not.toContain('sen_bea');
  });

  it('a senior can allow the AI again: the route is called with allowed true and the line goes', async () => {
    const w = await world();
    const f = await w.file();
    w.cw.people.automation.set(f.person, { allowed: false, code: 'staff', actor: 'sen_bea' });
    const { user } = await openPerson(w, f.person);
    await screen.findByText(/Reason: a member of staff\./);
    await user.click(await more());
    const group = screen.getByRole('group', { name: 'Do not automate' });
    expect(within(group).queryByLabelText('Reason')).toBeNull();
    await user.click(within(group).getByRole('button', { name: 'Allow the AI again' }));
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect(puts(w)[0]?.body).toEqual({ allowed: true });
    await waitFor(() => expect(screen.queryByText(/Do not automate: the AI never acts/)).toBeNull());
    expect(w.cw.people.automation.get(f.person).allowed).toBe(true);
  });

  it('an unmarked person has no quiet line at all, for anyone', async () => {
    const w = await world();
    const f = await w.file();
    await openPerson(w, f.person);
    await more();
    expect(screen.queryByText(/Do not automate: the AI never acts/)).toBeNull();
  });

  it('a mark set while the page is open shows after the page reads again, not before', async () => {
    const w = await world({ role: 'moderator' });
    const f = await w.file();
    await openPerson(w, f.person);
    w.cw.people.automation.set(f.person, { allowed: false, code: 'other', actor: 'sen_bea' });
    expect(screen.queryByText(/Do not automate: the AI never acts/)).toBeNull();
  });
});

describe('refusals', () => {
  it('a refusal from the server shows in words, the mark does not change and the form stays', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 403, headers: {}, body: { error: 'forbidden', message: 'x' } } : undefined);
    await user.click(await more());
    await user.click(screen.getByRole('button', { name: 'Do not automate this person' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the mark.');
    expect(w.cw.people.automation.get(f.person).allowed).toBe(true);
    expect(screen.getByRole('group', { name: 'Do not automate' })).toBeInTheDocument();
  });

  it('a store that cannot keep the mark (404) says so', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 404, headers: {}, body: { error: 'not_found', message: 'x' } } : undefined);
    await user.click(await more());
    await user.click(screen.getByRole('button', { name: 'Do not automate this person' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the mark.');
  });

  it('one click sends one request (a double click does not send two)', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    await user.click(await more());
    const go = screen.getByRole('button', { name: 'Do not automate this person' });
    await user.dblClick(go);
    await waitFor(() => expect(puts(w).length).toBeGreaterThan(0));
    expect(puts(w)).toHaveLength(1);
  });
});
