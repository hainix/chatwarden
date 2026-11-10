import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { DAY, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// Sanctioning from the person page: the Sanction form and the note. Against the real routes; the server stays the judge, and a
// refusal it gives is shown with what was typed kept.

const inForce = (): HTMLElement => screen.getByRole('region', { name: 'In force now' });
const timeline = (): HTMLElement => screen.getByRole('region', { name: 'Timeline' });
const items = (el: HTMLElement): HTMLElement[] => within(el).queryAllByRole('listitem');
const audits = (w: HubWorld, action: string): unknown[] => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action);
const posts = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && r.path === '/sanctions');
const histories = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'GET' && /^\/people\/[^/]+\/history$/.test(r.path));

const form = (name: string | RegExp): HTMLElement => screen.getByRole('region', { name });
const what = (): HTMLSelectElement => screen.getByLabelText('What happens');
const length = (): HTMLSelectElement => screen.getByLabelText('How long');
const rule = (): HTMLSelectElement => screen.getByLabelText('Community Rule');
const reason = (): HTMLTextAreaElement => screen.getByLabelText('Reason');
const ip = (): HTMLInputElement => screen.getByRole('checkbox', { name: /IP address/ });
const apply = (): HTMLElement => screen.getByRole('button', { name: 'Apply' });

async function page(options: WorldOptions = {}, target = 'Mallory') {
  const w = await hubWorld(options);
  const f = await w.file({ target });
  const r = renderHub(w, { path: `/people/${f.person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return { w, f, ...r };
}

async function openSanction(user: Awaited<ReturnType<typeof page>>['user']) {
  await user.click(screen.getByRole('button', { name: 'Sanction' }));
  await screen.findByRole('region', { name: 'Sanction Mallory' });
  await waitFor(() => expect(rule().options.length).toBeGreaterThan(2));
}

describe('opening and closing the form', () => {
  it('the buttons are Sanction and Add a note, for a role that may apply sanctions', async () => {
    await page();
    expect(screen.getByRole('button', { name: 'Sanction' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
  });

  it('Sanction opens a form under the title with the first field focused; Cancel closes it and returns focus to the button', async () => {
    const { user } = await page();
    const button = screen.getByRole('button', { name: 'Sanction' });
    await user.click(button);
    expect(form('Sanction Mallory')).toBeInTheDocument();
    expect(what()).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Sanction Mallory' })).toBeNull();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape does not close it (a half-written reason is not thrown away by a stray key); Cancel does', async () => {
    const { user } = await page();
    await openSanction(user);
    await user.type(reason(), 'half');
    await user.keyboard('{Escape}');
    expect(reason()).toHaveValue('half');
  });

  it('the Sanction form and the note form are never open together', async () => {
    const { user } = await page();
    await openSanction(user);
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    expect(screen.queryByRole('region', { name: 'Sanction Mallory' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Add a note about Mallory' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    expect(screen.queryByRole('region', { name: 'Add a note about Mallory' })).toBeNull();
  });

  it('reads the rules only when the form is opened, once for the session (one policy.view)', async () => {
    const { w, user } = await page();
    expect(audits(w, 'policy.view')).toHaveLength(0);
    expect(w.sent.some((r) => r.path === '/policy')).toBe(false);
    await openSanction(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openSanction(user);
    expect(audits(w, 'policy.view')).toHaveLength(1);
  });
});

describe('the fields', () => {
  it('start with nothing chosen, offer the kinds a moderator can apply, and no note kind', async () => {
    const { user } = await page();
    await openSanction(user);
    expect(what()).toHaveValue('');
    expect([...what().options].map((o) => o.textContent)).toEqual(['Choose', 'Warning', 'Chat restriction', 'Area restriction', 'Ban']);
    expect(rule()).toHaveValue('');
    expect(reason()).toHaveValue('');
  });

  it('the length and the IP box appear for a timed kind and go for a warning', async () => {
    const { user } = await page();
    await openSanction(user);
    expect(screen.queryByLabelText('How long')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /IP address/ })).toBeNull();
    await user.selectOptions(what(), 'chat');
    expect(length()).toHaveValue('24h');
    expect([...length().options].map((o) => o.textContent)).toEqual(['1 hour', '24 hours', '7 days', '30 days', 'Permanent']);
    expect(ip()).toBeInTheDocument();
    await user.selectOptions(what(), 'warning');
    expect(screen.queryByLabelText('How long')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /IP address/ })).toBeNull();
  });

  it('the IP box says what it does: the last address, up to 24 hours, never shown', async () => {
    const { user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'ban');
    expect(ip()).toHaveAccessibleDescription(/last played from.*24 hours.*never shown/);
    expect(screen.getByText('Also block their IP address for up to 24 hours')).toBeInTheDocument();
  });

  it('says the player is not sent a notice from here', async () => {
    const { user } = await page();
    await openSanction(user);
    expect(within(form('Sanction Mallory')).getByText(/The player is not sent a notice/)).toBeInTheDocument();
  });

  it('the rule picker lists the rules in force and "No rule covers this", not a retired rule', async () => {
    const { user } = await page({ retire: [3] });
    await openSanction(user);
    const labels = [...rule().options].map((o) => o.textContent ?? '');
    expect(labels[0]).toBe('Choose a rule');
    expect(labels.at(-1)).toBe('No rule covers this');
    expect(labels.some((l) => l.startsWith('Rule 1:'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Rule 2:'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Rule 3:'))).toBe(false);
  });

  it('a role that cannot read the rules still has "No rule covers this", and nothing is read', async () => {
    const { w, user } = await page({ permissions: { 'policy.read': 'owner' } });
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: 'Sanction Mallory' });
    expect([...rule().options].map((o) => o.textContent)).toEqual(['Choose a rule', 'No rule covers this']);
    expect(w.sent.some((r) => r.path === '/policy')).toBe(false);
  });

  it('a failed read of the rules says so and offers Try again', async () => {
    const { w, user } = await page();
    w.intercept.fn = (req) => (req.path === '/policy' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the Community Rules.');
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rule().options.length).toBeGreaterThan(2));
  });

  it('"No rule covers this" asks what the rules do not cover', async () => {
    const { user } = await page();
    await openSanction(user);
    expect(screen.queryByLabelText('What the rules do not cover')).toBeNull();
    await user.selectOptions(rule(), 'uncovered');
    expect(screen.getByLabelText('What the rules do not cover')).toBeInTheDocument();
    await user.selectOptions(rule(), '1');
    expect(screen.queryByLabelText('What the rules do not cover')).toBeNull();
  });

  it('permanent: a moderator cannot make a ban permanent, but can a chat restriction; a senior can both', async () => {
    const mod = await page({ role: 'moderator' });
    await openSanction(mod.user);
    await mod.user.selectOptions(what(), 'ban');
    expect([...length().options].map((o) => o.textContent)).not.toContain('Permanent');
    await mod.user.selectOptions(what(), 'chat');
    expect([...length().options].map((o) => o.textContent)).toContain('Permanent');
  });

  it('a senior sees Permanent on a ban', async () => {
    const senior = await page({ role: 'senior' });
    await openSanction(senior.user);
    await senior.user.selectOptions(what(), 'ban');
    expect([...length().options].map((o) => o.textContent)).toContain('Permanent');
  });

  it('a length a kind may not have is dropped when the kind changes: permanent on a chat restriction, then Ban, is 24 hours for a moderator', async () => {
    const { user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'chat');
    await user.selectOptions(length(), 'permanent');
    await user.selectOptions(what(), 'ban');
    expect(length()).toHaveValue('24h');
  });

  it('a senior keeps a permanent length when the kind changes to a ban', async () => {
    const { user } = await page({ role: 'senior' });
    await openSanction(user);
    await user.selectOptions(what(), 'chat');
    await user.selectOptions(length(), 'permanent');
    await user.selectOptions(what(), 'ban');
    expect(length()).toHaveValue('permanent');
  });
});

describe('applying a sanction', () => {
  it('sends the body, closes the form, and the sanction shows in the timeline and in force, after exactly one more read', async () => {
    const { w, f, user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'chat');
    await user.selectOptions(length(), '7d');
    await user.selectOptions(rule(), '2');
    await user.type(reason(), 'Kept spamming the lobby after a warning');
    await user.click(apply());
    await waitFor(() => expect(items(inForce())).toHaveLength(1));
    expect(posts(w)).toHaveLength(1);
    expect(posts(w)[0]?.body).toEqual({ subject: f.person, kind: 'chat', durationMs: 7 * DAY, rule: 2, reason: 'Kept spamming the lobby after a warning', includeIp: false });
    expect(screen.queryByRole('region', { name: 'Sanction Mallory' })).toBeNull();
    const row = items(timeline())[0]!;
    expect(row).toHaveTextContent('Chat restriction, 7 days');
    expect(row).toHaveTextContent('Rule 2');
    expect(row).toHaveTextContent('by ann@example.test');
    expect(row).toHaveTextContent('Kept spamming the lobby after a warning');
    expect(row.querySelector('.cw-card--restriction')).not.toBeNull();
    const stored = w.cw.sanctions.forPerson(f.person);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'chat', actor: 'ann@example.test', source: 'moderator', automated: false, reason: 'Kept spamming the lobby after a warning' });
    expect(histories(w)).toHaveLength(2);
    expect(await screen.findByText(new RegExp(`^Chat restriction, 7 days applied\\. Ref ${stored[0]!.refCode}\\.$`))).toBeInTheDocument();
    expect(audits(w, 'sanction.apply')).toHaveLength(1);
  });

  it('a warning sends no length and no IP', async () => {
    const { w, f, user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'warning');
    await user.selectOptions(rule(), '1');
    await user.type(reason(), 'Please keep it civil');
    await user.click(apply());
    await waitFor(() => expect(items(inForce())).toHaveLength(1));
    expect(posts(w)[0]?.body).toEqual({ subject: f.person, kind: 'warning', durationMs: null, rule: 1, reason: 'Please keep it civil', includeIp: false });
    expect(items(timeline())[0]!.querySelector('.cw-card--warning')).not.toBeNull();
  });

  it('a ticked IP box is sent; switching to a warning afterwards drops it', async () => {
    const { w, f, user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'ban');
    await user.selectOptions(rule(), '2');
    await user.type(reason(), 'Evading a ban');
    await user.click(ip());
    await user.click(apply());
    await waitFor(() => expect(posts(w)).toHaveLength(1));
    expect(posts(w)[0]?.body).toMatchObject({ kind: 'ban', durationMs: DAY, includeIp: true });
    await waitFor(() => expect(items(inForce())).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    await waitFor(() => expect(rule().options.length).toBeGreaterThan(2));
    await user.selectOptions(what(), 'ban');
    await user.click(ip());
    await user.selectOptions(what(), 'warning');
    await user.selectOptions(rule(), '1');
    await user.type(reason(), 'Second thoughts');
    await user.click(apply());
    await waitFor(() => expect(posts(w)).toHaveLength(2));
    expect(posts(w)[1]?.body).toMatchObject({ subject: f.person, kind: 'warning', durationMs: null, includeIp: false });
  });

  it('a senior can make a ban permanent, and it shows as Ban, permanent', async () => {
    const { w, user } = await page({ role: 'senior' });
    await openSanction(user);
    await user.selectOptions(what(), 'ban');
    await user.selectOptions(length(), 'permanent');
    await user.selectOptions(rule(), '2');
    await user.type(reason(), 'Selling accounts');
    await user.click(apply());
    await waitFor(() => expect(items(inForce())).toHaveLength(1));
    expect(posts(w)[0]?.body).toMatchObject({ kind: 'ban', durationMs: null });
    expect(items(inForce())[0]).toHaveTextContent('Ban, permanent');
  });

  it('"No rule covers this" sends the word and the gap note, and opens a gap for the rules review', async () => {
    const { w, user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'warning');
    await user.selectOptions(rule(), 'uncovered');
    await user.type(screen.getByLabelText('What the rules do not cover'), 'Nothing about griefing the tutorial');
    await user.type(reason(), 'Griefing the tutorial');
    await user.click(apply());
    await waitFor(() => expect(items(inForce())).toHaveLength(1));
    expect(posts(w)[0]?.body).toMatchObject({ rule: 'uncovered', gapNote: 'Nothing about griefing the tutorial' });
    expect(items(inForce())[0]).toHaveTextContent('No rule fits yet');
    expect(w.cw.gaps.list()).toHaveLength(1);
  });

  it('reopening the form after a success starts empty', async () => {
    const { user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'warning');
    await user.selectOptions(rule(), '1');
    await user.type(reason(), 'first');
    await user.click(apply());
    await waitFor(() => expect(items(inForce())).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    expect(what()).toHaveValue('');
    expect(reason()).toHaveValue('');
  });

  it('works for a person nobody has reported: the page is titled by the tag and the sanction is on that person', async () => {
    const w = await hubWorld();
    const { user } = renderHub(w, { path: '/people/s_nobody_reported_00' });
    await screen.findByRole('heading', { level: 2, name: 'Person s_nobody' });
    await user.click(await screen.findByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: 'Sanction Person s_nobody' });
    await waitFor(() => expect(rule().options.length).toBeGreaterThan(2));
    await user.selectOptions(what(), 'warning');
    await user.selectOptions(rule(), '1');
    await user.type(reason(), 'seen on another server');
    await user.click(apply());
    await waitFor(() => expect(items(inForce())).toHaveLength(1));
    expect(posts(w)[0]?.body).toMatchObject({ subject: 's_nobody_reported_00' });
  });

  describe('before sending', () => {
    it('an empty form lists what is missing next to each field, sends nothing, and puts focus on the first', async () => {
      const { w, user } = await page();
      await openSanction(user);
      await user.click(apply());
      expect(screen.getByText('Choose what happens.')).toBeInTheDocument();
      expect(screen.getByText('Choose the rule this is under.')).toBeInTheDocument();
      expect(screen.getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
      expect(what()).toHaveAttribute('aria-invalid', 'true');
      expect(what()).toHaveFocus();
      expect(posts(w)).toHaveLength(0);
    });

    it('the messages go as the fields are fixed', async () => {
      const { user } = await page();
      await openSanction(user);
      await user.click(apply());
      await user.selectOptions(what(), 'warning');
      expect(screen.queryByText('Choose what happens.')).toBeNull();
      expect(screen.getByText('Choose the rule this is under.')).toBeInTheDocument();
    });

    it('"No rule covers this" with no note, and a reason of spaces, are refused', async () => {
      const { w, user } = await page();
      await openSanction(user);
      await user.selectOptions(what(), 'warning');
      await user.selectOptions(rule(), 'uncovered');
      await user.type(reason(), '   ');
      await user.click(apply());
      expect(screen.getByText('Say what the rules do not cover.')).toBeInTheDocument();
      expect(screen.getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
      expect(posts(w)).toHaveLength(0);
    });

    it('a reason over 500 characters is refused with a counter', async () => {
      const { w, user } = await page();
      await openSanction(user);
      await user.selectOptions(what(), 'warning');
      await user.selectOptions(rule(), '1');
      await user.click(reason());
      await user.paste('x'.repeat(501));
      expect(screen.getByText('501 of 500')).toBeInTheDocument();
      await user.click(apply());
      expect(screen.getByText('The reason is over 500 characters. Shorten it.')).toBeInTheDocument();
      expect(posts(w)).toHaveLength(0);
    });
  });

  describe('when the server says no', () => {
    async function ready() {
      const p = await page();
      await openSanction(p.user);
      await p.user.selectOptions(what(), 'chat');
      await p.user.selectOptions(rule(), '2');
      await p.user.type(reason(), 'a reason I do not want to lose');
      return p;
    }

    it('403: a plain message, the form and what was typed kept, no reload', async () => {
      const { w, user } = await ready();
      w.intercept.fn = (req) => (req.path === '/sanctions' && req.method === 'POST' ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
      await user.click(apply());
      expect(await screen.findByRole('alert')).toHaveTextContent('Your role cannot do this.');
      expect(reason()).toHaveValue('a reason I do not want to lose');
      expect(what()).toHaveValue('chat');
      expect(histories(w)).toHaveLength(1);
      expect(items(inForce())).toHaveLength(0);
    });

    it('400 from the server: says it did not accept it, with what was typed kept', async () => {
      const { w, user } = await ready();
      w.intercept.fn = (req) => (req.path === '/sanctions' && req.method === 'POST' ? { status: 400, body: { error: 'invalid_sanction', message: 'x' } } : undefined);
      await user.click(apply());
      expect(await screen.findByRole('alert')).toHaveTextContent('The server did not accept this. Check each field, then try again.');
      expect(reason()).toHaveValue('a reason I do not want to lose');
    });

    it('a network failure keeps the input, and Try again sends it once more', async () => {
      const { w, user } = await ready();
      let down = true;
      w.intercept.fn = (req) => {
        if (down && req.path === '/sanctions' && req.method === 'POST') throw new Error('offline');
        return undefined;
      };
      await user.click(apply());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not reach the server');
      expect(reason()).toHaveValue('a reason I do not want to lose');
      down = false;
      await user.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(items(inForce())).toHaveLength(1));
      expect(w.cw.sanctions.forPerson((await w.direct.listSanctions()).items[0]!.person)).toHaveLength(1);
    });

    it('a double click on Apply sends one sanction', async () => {
      const { w, user } = await ready();
      await user.dblClick(apply());
      await waitFor(() => expect(items(inForce())).toHaveLength(1));
      expect(posts(w)).toHaveLength(1);
      expect((await w.direct.listSanctions()).items).toHaveLength(1);
    });

    it('a server problem (500) is a plain sentence and keeps the form', async () => {
      const { w, user } = await ready();
      w.intercept.fn = (req) => (req.path === '/sanctions' && req.method === 'POST' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
      await user.click(apply());
      expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem');
      expect(reason()).toHaveValue('a reason I do not want to lose');
    });
  });

  describe('when another moderator is handling the person (409)', () => {
    it('a moderator is told who, with the input kept, and no way past it', async () => {
      const { w, f, user } = await page();
      await w.clientFor('bea@example.test').claimCase(f.person);
      await openSanction(user);
      await user.selectOptions(what(), 'warning');
      await user.selectOptions(rule(), '1');
      await user.type(reason(), 'kept');
      await user.click(apply());
      expect(await screen.findByRole('alert')).toHaveTextContent('bea is handling this player’s case, so this was not applied. What you entered is kept.');
      expect(reason()).toHaveValue('kept');
      expect(screen.queryByRole('button', { name: 'Take over and apply' })).toBeNull();
      expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(0);
    });

    it('a senior can take over and apply in one step (audited by the server as a takeover)', async () => {
      const { w, f, user } = await page({ role: 'senior' });
      await w.clientFor('bea@example.test').claimCase(f.person);
      await openSanction(user);
      await user.selectOptions(what(), 'warning');
      await user.selectOptions(rule(), '1');
      await user.type(reason(), 'urgent');
      await user.click(apply());
      await user.click(await screen.findByRole('button', { name: 'Take over and apply' }));
      await waitFor(() => expect(items(inForce())).toHaveLength(1));
      expect(posts(w).map((r) => (r.body as { takeOver?: boolean }).takeOver)).toEqual([undefined, true]);
      expect(audits(w, 'case.takeover')).toHaveLength(1);
      expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
    });

    it('a claim that lapsed is no claim', async () => {
      const { w, f, user } = await page();
      await w.clientFor('bea@example.test').claimCase(f.person);
      w.clock.t += 11 * 60_000;
      await openSanction(user);
      await user.selectOptions(what(), 'warning');
      await user.selectOptions(rule(), '1');
      await user.type(reason(), 'later');
      await user.click(apply());
      await waitFor(() => expect(items(inForce())).toHaveLength(1));
      expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
    });
  });
});

describe('adding a note', () => {
  const noteBox = (): HTMLTextAreaElement => screen.getByLabelText('Note');

  async function openNote(user: Awaited<ReturnType<typeof page>>['user']) {
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await screen.findByRole('region', { name: 'Add a note about Mallory' });
    await waitFor(() => expect(rule().options.length).toBeGreaterThan(2));
  }

  it('has a rule and the note, and none of what a sanction has (kind, length, IP, "not sent a notice")', async () => {
    const { user } = await page();
    await openNote(user);
    expect(noteBox()).toHaveFocus();
    expect(screen.queryByLabelText('What happens')).toBeNull();
    expect(screen.queryByLabelText('How long')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save note' })).toBeInTheDocument();
  });

  it('sends a note-kind sanction with the rule and the note as the reason, and shows it as a note', async () => {
    const { w, f, user } = await page();
    await openNote(user);
    await user.selectOptions(rule(), '1');
    await user.type(noteBox(), 'Second warning from the same room; watch for a third');
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(items(timeline()).some((li) => li.textContent?.includes('Note'))).toBe(true));
    expect(posts(w)).toHaveLength(1);
    expect(posts(w)[0]?.body).toEqual({ subject: f.person, kind: 'note', durationMs: null, rule: 1, reason: 'Second warning from the same room; watch for a third', includeIp: false });
    const row = items(timeline()).find((li) => li.textContent?.includes('Note'))!;
    expect(row.querySelector('.cw-card--note')).not.toBeNull();
    expect(row).toHaveTextContent('Second warning from the same room; watch for a third');
    expect(row).not.toHaveTextContent('left');
    expect(await screen.findByText('Note added.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Add a note about Mallory' })).toBeNull();
    expect(histories(w)).toHaveLength(2);
  });

  it('a note round trip: after the page is opened afresh the note is there, with its text, and it can be revoked', async () => {
    const { w, f, user, unmount } = await page();
    await openNote(user);
    await user.selectOptions(rule(), 'uncovered');
    await user.type(screen.getByLabelText('What the rules do not cover'), 'no rule about this yet');
    await user.type(noteBox(), 'Friendly with the others; keep an eye on it');
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(posts(w)).toHaveLength(1));
    unmount();

    const again = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    const row = await within(timeline()).findByText('Friendly with the others; keep an eye on it');
    expect(row.closest('li')).toHaveTextContent('Note');
    expect(row.closest('li')).toHaveTextContent('No rule fits yet');
    await again.user.click(within(inForce()).getByRole('button', { name: /^Revoke Note/ }));
    await again.user.type(screen.getByLabelText('Why are you revoking this?'), 'not needed');
    await again.user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(within(inForce()).getByText('Nothing is in force right now.')).toBeInTheDocument());
  });

  it('needs a rule and the note; says "note", not "reason"', async () => {
    const { w, user } = await page();
    await openNote(user);
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(screen.getByText('Choose the rule this is under.')).toBeInTheDocument();
    expect(screen.getByText('Write the note. Only staff see it.')).toBeInTheDocument();
    expect(posts(w)).toHaveLength(0);
  });

  it('a note over 500 characters is refused', async () => {
    const { w, user } = await page();
    await openNote(user);
    await user.selectOptions(rule(), '1');
    await user.click(noteBox());
    await user.paste('y'.repeat(501));
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(screen.getByText('The note is over 500 characters. Shorten it.')).toBeInTheDocument();
    expect(posts(w)).toHaveLength(0);
  });

  it('never carries over a ticked IP box or a kind from the Sanction form that was open before', async () => {
    const { w, f, user } = await page();
    await openSanction(user);
    await user.selectOptions(what(), 'ban');
    await user.click(ip());
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await screen.findByRole('region', { name: 'Add a note about Mallory' });
    await user.selectOptions(rule(), '1');
    await user.type(noteBox(), 'just a note');
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(posts(w)).toHaveLength(1));
    expect(posts(w)[0]?.body).toEqual({ subject: f.person, kind: 'note', durationMs: null, rule: 1, reason: 'just a note', includeIp: false });
  });

  it('Cancel closes it without sending', async () => {
    const { w, user } = await page();
    await openNote(user);
    await user.type(noteBox(), 'never mind');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Add a note about Mallory' })).toBeNull();
    expect(posts(w)).toHaveLength(0);
  });

  it('a 403 keeps the note and says so plainly', async () => {
    const { w, user } = await page();
    await openNote(user);
    await user.selectOptions(rule(), '1');
    await user.type(noteBox(), 'keep this text');
    w.intercept.fn = (req) => (req.path === '/sanctions' && req.method === 'POST' ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role cannot do this.');
    expect(noteBox()).toHaveValue('keep this text');
  });
});

describe('who sees the buttons', () => {
  it('no Sanction or Add a note for a role that may not apply sanctions', async () => {
    await page({ permissions: { 'sanctions.apply': 'owner' } });
    expect(screen.queryByRole('button', { name: 'Sanction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
  });
});

