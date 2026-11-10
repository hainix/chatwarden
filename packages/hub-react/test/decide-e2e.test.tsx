import { playerRoutes } from '@chatwarden/http';
import { createRouter } from '@chatwarden/http/admin';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The whole path: a moderator decides in the UI; the sanction shows in the person's history; and the player, asking the real
// player routes, sees the notice with exactly the lines the moderator chose, and nothing else. `playerRoutes` uses Node's
// crypto, which works under vitest in Node even in this jsdom file.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'you are all trash at this game' },
  { who: 'target', text: 'first line from the target' },
  { who: 'bystander', text: 'chill out please' },
  { who: 'target', text: 'second line from the target' },
  { who: 'target', text: 'you zorbak' },
];

/** The player's own routes over the same kit, identifying the caller by a header (as an adopter's auth would). */
function playerAs(w: HubWorld) {
  const handle = createRouter(playerRoutes(w.cw, { identify: (req) => ({ clientKey: req.headers['x-player-key'] ?? '' }) }));
  return async (clientKey: string, method: string, path: string, body?: unknown) =>
    handle({ method, path, query: {}, headers: { 'x-player-key': clientKey }, body: undefined, ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }) });
}

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });

async function decideInUi(w: HubWorld, id: string, picks: { lines: RegExp[]; what: string; verdict?: string }) {
  const { user } = renderHub(w, { path: `/reports/${id}` });
  const p = await screen.findByRole('region', { name: 'Decision' });
  await within(p).findByRole('radio', { name: 'Fair' });
  await user.click(within(p).getByRole('radio', { name: picks.verdict ?? 'Fair' }));
  await user.click(within(p).getByRole('button', { name: 'Add an action' }));
  const group = within(p).getByRole('group', { name: 'Action 1' });
  const what = within(group).getByLabelText('What happens');
  await user.selectOptions(what, within(what).getByRole('option', { name: picks.what }));
  for (const line of picks.lines) await user.click(within(group).getByRole('checkbox', { name: line }));
  await user.type(within(p).getByRole('textbox', { name: 'Reason' }), 'Clear from the chat.');
  await user.click(within(p).getByRole('button', { name: 'Decide' }));
  await within(p).findByText('Decided. The report is closed.', { selector: 'strong' });
}

describe('decide in the UI, see it in the history, see it as the player', () => {
  it('a warning with two chosen lines: the history has it, and the notice carries those two lines only', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    await decideInUi(w, f.id, { what: 'Warning', lines: [/first line from the target/, /second line from the target/] });

    // The staff history: the sanction is there, with the code the panel showed.
    const history = await w.client.personHistory(f.person);
    expect(history.sanctions).toHaveLength(1);
    const sanction = history.sanctions[0]!;
    expect(sanction).toMatchObject({ kind: 'warning', actor: 'ann@example.test', reason: expect.any(String), revokedAt: null });
    expect(await within(panel()).findByText(`${sanction.refCode} (Warning)`)).toBeInTheDocument();
    expect(history.history).toEqual([expect.objectContaining({ kind: 'warning', revoked: false })]);

    // The player's own view.
    const asTarget = playerAs(w);
    const res = await asTarget('key-target-Mallory', 'GET', '/notices');
    expect(res.status).toBe(200);
    const notices = (res.body as { notices: Array<{ kind: string; refCode: string | null; excerpt: Array<{ text: string; day: string }>; mustAcknowledge: boolean }> }).notices;
    const warning = notices.find((n) => n.kind === 'warning');
    expect(warning).toBeDefined();
    expect(warning!.refCode).toBe(sanction.refCode);
    expect(warning!.mustAcknowledge).toBe(true);
    expect(warning!.excerpt.map((l) => l.text)).toEqual(['first line from the target', 'second line from the target']);
    // Nothing of anyone else, and no identifier, reaches the player.
    const text = JSON.stringify(res.body);
    for (const leak of ['trash at this game', 'chill out please', 'ann@example.test', 'Clear from the chat.', f.person, f.reporter, f.bystander as string, 'Rae', 'Sam']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('no lines chosen: the notice has an empty excerpt', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    await decideInUi(w, f.id, { what: 'Chat restriction, 24 hours', lines: [] });
    const res = await playerAs(w)('key-target-Mallory', 'GET', '/notices');
    const notices = (res.body as { notices: Array<{ kind: string; excerpt: unknown[] }> }).notices;
    expect(notices.find((n) => n.kind === 'chat')?.excerpt).toEqual([]);
  });

  it('a blocked line chosen for the player is shown to them masked, never as typed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    await decideInUi(w, f.id, { what: 'Warning', lines: [/you zorbak.*Blocked/] });
    const res = await playerAs(w)('key-target-Mallory', 'GET', '/notices');
    const notices = (res.body as { notices: Array<{ kind: string; excerpt: Array<{ text: string }> }> }).notices;
    const shown = notices.find((n) => n.kind === 'warning')?.excerpt ?? [];
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text).not.toContain('zorbak');
    expect(shown[0]!.text).toMatch(/\*/);
  });

  it('a note tells the player nothing, though it is on the record', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    await decideInUi(w, f.id, { what: 'Note', lines: [] });
    const history = await w.client.personHistory(f.person);
    expect(history.sanctions.map((s) => s.kind)).toEqual(['note']);
    const res = await playerAs(w)('key-target-Mallory', 'GET', '/notices');
    expect((res.body as { notices: unknown[] }).notices.filter((n) => (n as { kind: string }).kind !== 'report_outcome')).toEqual([]);
  });

  it('the reporter is told the outcome, without the other person\'s text', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    await decideInUi(w, f.id, { what: 'Warning', lines: [/first line from the target/] });
    const res = await playerAs(w)('key-reporter-Rae', 'GET', '/notices');
    const text = JSON.stringify(res.body);
    expect(text).toContain('report_outcome');
    expect(text).not.toContain('first line from the target');
    expect(text).not.toContain('Mallory');
  });

  it('a decision for someone else\'s report does not reach another player', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    await decideInUi(w, f.id, { what: 'Warning', lines: [/first line from the target/] });
    const res = await playerAs(w)('key-bystander-Sam', 'GET', '/notices');
    expect((res.body as { notices: unknown[] }).notices).toEqual([]);
  });

  it('a dismissal that sanctions the reporter reaches the reporter as a warning, never the reported person', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', bystander: 'Sam' });
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    const p = await screen.findByRole('region', { name: 'Decision' });
    await within(p).findByRole('radio', { name: 'Fair' });
    await user.click(within(p).getByRole('radio', { name: 'Not a problem' }));
    await user.click(within(p).getByRole('button', { name: 'Add an action' }));
    const group = within(p).getByRole('group', { name: 'Action 1' });
    const what = within(group).getByLabelText('What happens');
    await user.selectOptions(what, within(what).getByRole('option', { name: 'Warning' }));
    await user.click(within(group).getByRole('checkbox', { name: /you are all trash at this game/ }));
    await user.type(within(p).getByRole('textbox', { name: 'Reason' }), 'Provoked it.');
    await user.click(within(p).getByRole('button', { name: 'Decide' }));
    await within(p).findByText('Decided. The report is closed.', { selector: 'strong' });
    const asReporter = (await playerAs(w)('key-reporter-Rae', 'GET', '/notices')).body as { notices: Array<{ kind: string; excerpt: Array<{ text: string }> }> };
    expect(asReporter.notices.find((n) => n.kind === 'warning')?.excerpt.map((l) => l.text)).toEqual(['you are all trash at this game']);
    const asTarget = (await playerAs(w)('key-target-Mallory', 'GET', '/notices')).body as { notices: Array<{ kind: string }> };
    expect(asTarget.notices.filter((n) => n.kind === 'warning')).toEqual([]);
  });
});
