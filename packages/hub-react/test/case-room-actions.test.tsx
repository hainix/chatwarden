import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseline, normalized } from './baseline.js';
import { renderHub } from './render.js';
import { HOUR, MINUTE, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// On a case: "Lock this room" and "Emergency mode" in the case's menu (design 9.1), and "Remove from the room" in a line's own menu (9.2). Only with rooms.manage, only for a room the
// report has, only for a line the server says is still removable. A mode and a retraction are never a sanction. Real routes, real kit.

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'More actions on this case' });
const modePosts = (w: HubWorld) => w.sent.filter((r) => r.method === 'POST' && /^\/rooms\/[^/]+\/mode$/.test(r.path));
const retractPosts = (w: HubWorld) => w.sent.filter((r) => r.method === 'POST' && /\/retract$/.test(r.path));

async function roomCase(options: WorldOptions = {}) {
  const w = await hubWorld(options);
  const f = await w.fileRich({ room: 'lobby-1', target: 'Mallory', reporter: 'Rhea' });
  return { w, f };
}
async function open(w: HubWorld, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('tablist');
  return r;
}
const items = (): string[] => within(screen.getByRole('group', { name: 'More actions on this case' })).getAllByRole('button').map((b) => b.textContent ?? '');

describe('the case menu', () => {
  it('offers Lock this room and Emergency mode to a moderator, for the room the report is in', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    expect(items()).toEqual(['Mark as urgent', 'Lock this room', 'Emergency mode']);
  });

  it('a report with no room has neither', async () => {
    const { w, f } = await roomCase();
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) {
        const real = await w.direct.getReport(f.id);
        return { status: 200, body: { ...real, report: { ...real.report, roomId: '' } } };
      }
      return undefined;
    };
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    expect(items()).toEqual(['Mark as urgent']);
  });

  it('only with rooms.manage: raised to the owner, a moderator has neither', async () => {
    const { w, f } = await roomCase({ permissions: { 'rooms.manage': 'owner' } });
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    expect(items()).toEqual(['Mark as urgent']);
  });

  it('a decided case offers neither (and, with nothing else, no menu at all)', async () => {
    const { w, f } = await roomCase({ role: 'senior' });
    await w.direct.decide(f.id, { verdict: 'no_action', actions: [] });
    const { container } = await open(w, f.id);
    expect(container.querySelector('.cw-case-menu')).toBeNull();
  });

  it('Lock this room: the confirm names the room and the duration, follows the choice, and sends it', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Lock this room' }));
    const form = screen.getByRole('group', { name: 'Lock this room' });
    expect(within(form).getByText('Lock lobby-1 for 30 minutes? Only staff can post until then.')).toBeInTheDocument();
    await user.selectOptions(within(form).getByRole('combobox', { name: 'How long' }), '4 hours');
    expect(within(form).getByText('Lock lobby-1 for 4 hours? Only staff can post until then.')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(modePosts(w)).toHaveLength(1));
    expect(modePosts(w)[0]?.path).toBe('/rooms/lobby-1/mode');
    expect(modePosts(w)[0]?.body).toEqual({ mode: 'locked', forMs: 4 * HOUR });
    expect(w.cw.rooms.mode('lobby-1').mode).toBe('locked');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Emergency mode: names what it does and the duration, and sends it', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Emergency mode' }));
    const form = screen.getByRole('group', { name: 'Emergency mode' });
    expect(within(form).getByText('Start emergency mode in lobby-1 for 30 minutes? Slow mode is on and new accounts can only read.')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(modePosts(w)).toHaveLength(1));
    expect(modePosts(w)[0]?.body).toEqual({ mode: 'emergency', forMs: 30 * MINUTE });
  });

  it('Cancel changes nothing', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Lock this room' }));
    await user.click(within(screen.getByRole('group', { name: 'Lock this room' })).getByRole('button', { name: 'Cancel' }));
    expect(modePosts(w)).toEqual([]);
    expect(w.cw.rooms.mode('lobby-1').mode).toBe('normal');
  });

  it('a failure says why in words and keeps the form', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Lock this room' }));
    w.intercept.fn = (req) => (req.path.endsWith('/mode') ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await user.click(within(screen.getByRole('group', { name: 'Lock this room' })).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Lock this room' })).toBeInTheDocument();
  });

  it('a room id with characters a path would mangle is sent safely', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ room: 'lobby/1 a#b', target: 'Mallory', reporter: 'Rhea' });
    const { user } = await open(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Lock this room' }));
    await user.click(within(screen.getByRole('group', { name: 'Lock this room' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(modePosts(w)).toHaveLength(1));
    expect(modePosts(w)[0]?.path).toBe('/rooms/lobby%2F1%20a%23b/mode');
    expect(w.cw.rooms.mode('lobby/1 a#b').mode).toBe('locked');
  });
});

describe('Remove from the room', () => {
  const lineMenu = (text: string): HTMLElement => {
    const li = screen.getAllByRole('listitem').find((x) => x.textContent?.includes(text) && x.classList.contains('cw-line'));
    if (li === undefined) throw new Error(`no line ${text}`);
    return within(li).getByRole('button', { name: /Remove options for the line at/ });
  };

  it('appears only on a removable line, for rooms.manage, in the line\'s own menu', async () => {
    const { w, f } = await roomCase();
    await open(w, f.id);
    const lines = screen.getAllByRole('listitem').filter((x) => x.classList.contains('cw-line'));
    expect(lines.length).toBe(4);
    for (const line of lines) expect(within(line).getByRole('button', { name: /Remove options for the line at/ })).toBeInTheDocument();
    // Nothing is open until it is asked for: no always-visible Remove button.
    expect(screen.queryByRole('button', { name: 'Remove from the room' })).toBeNull();
  });

  it('is absent for a line that is too old to take back, and without rooms.manage', async () => {
    const old = await roomCase();
    old.w.clock.t += 20 * MINUTE;
    await open(old.w, old.f.id);
    expect(screen.queryByRole('button', { name: /Remove options for the line at/ })).toBeNull();
    const none = await roomCase({ permissions: { 'rooms.manage': 'owner' } });
    renderHub(none.w, { path: `/reports/${none.f.id}` });
    await screen.findAllByRole('tablist');
    expect(screen.queryByRole('button', { name: /Remove options for the line at/ })).toBeNull();
  });

  it('removes one line for everyone, then shows "Removed from the room" and offers nothing more for it', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(lineMenu('a line from the target'));
    await user.click(screen.getByRole('button', { name: 'Remove from the room' }));
    await waitFor(() => expect(retractPosts(w)).toHaveLength(1));
    expect(retractPosts(w)[0]?.body === undefined || (retractPosts(w)[0]?.body as Record<string, unknown>)['allFromAuthor'] === undefined).toBe(true);
    await waitFor(() => expect(screen.getAllByText('Removed from the room').length).toBe(1));
    const line = screen.getAllByRole('listitem').find((x) => x.classList.contains('cw-line') && x.textContent?.includes('Removed from the room')) as HTMLElement;
    expect(line.textContent).toContain('a line from the target');
    expect(within(line).queryByRole('button', { name: /Remove options for the line at/ })).toBeNull();
  });

  it('"Remove all recent lines from this player" sends allFromAuthor and marks each of their lines', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(lineMenu('a line from the target'));
    await user.click(screen.getByRole('button', { name: 'Remove all recent lines from this player' }));
    await waitFor(() => expect(retractPosts(w)).toHaveLength(1));
    expect(retractPosts(w)[0]?.body).toEqual({ allFromAuthor: true });
    await waitFor(() => expect(screen.getAllByText('Removed from the room').length).toBe(2));
  });

  it('a 404 says in words that the line is too old, and keeps the menu', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(lineMenu('a line from the target'));
    // The room closed under the moderator: the server no longer has the line.
    w.cw.rooms.close('lobby-1');
    await user.click(screen.getByRole('button', { name: 'Remove from the room' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That line is too old to take back, or is already gone.');
    expect(screen.getByRole('button', { name: 'Remove from the room' })).toBeInTheDocument();
  });

  it('a retraction writes no sanction and no notice: only the line changes', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(lineMenu('a line from the target'));
    await user.click(screen.getByRole('button', { name: 'Remove from the room' }));
    await waitFor(() => expect(retractPosts(w)).toHaveLength(1));
    expect((await w.direct.personHistory(f.person)).sanctions).toEqual([]);
    expect((await w.direct.getReport(f.id)).report.status).toBe('open');
  });

  it('the evidence stays: the text of a removed line is still in the case', async () => {
    const { w, f } = await roomCase();
    const { user } = await open(w, f.id);
    await user.click(lineMenu('a line from the target'));
    await user.click(screen.getByRole('button', { name: 'Remove from the room' }));
    await waitFor(() => expect(screen.getAllByText('Removed from the room').length).toBe(1));
    const line = screen.getAllByRole('listitem').find((x) => x.classList.contains('cw-line') && x.textContent?.includes('Removed from the room')) as HTMLElement;
    expect(within(line).getByText('a line from the target')).toBeInTheDocument();
  });

  it('Escape closes the line\'s menu and gives the focus back, and does not also leave the case', async () => {
    const { w, f } = await roomCase();
    const { user, router } = await open(w, f.id);
    const button = lineMenu('a line from the target');
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    expect(router.path).toBe(`/reports/${f.id}`);
  });
});

describe('without rooms.manage, rooms.read or the data none of it renders', () => {
  const quiet: WorldOptions = { permissions: { 'rooms.manage': 'owner', 'rooms.read': 'owner', 'reports.urgent': 'owner' } };

  it('the case has no menu, no line menu, no surge and no evidence; the Person page has only its ... button', async () => {
    const { w, f } = await roomCase(quiet);
    const { container } = await open(w, f.id);
    await waitFor(() => expect(container.querySelectorAll('.cw-line').length).toBeGreaterThan(0));
    for (const gone of ['.cw-case-menu', '.cw-line-menu', '.cw-surge', '.cw-evidence', '.cw-urgent-strip', '.cw-asked', '.cw-break-note']) expect(container.querySelector(gone), gone).toBeNull();
    expect(screen.queryByText('Removed from the room')).toBeNull();
  });

  it('the queue pane is what it was, byte for byte (the baseline file)', async () => {
    const w = await hubWorld(quiet);
    await w.file({ target: 'Alpha', reporter: 'Rep-A' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo', reporter: 'Rep-B' });
    renderHub(w, { path: '/reports' });
    const region = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(region).getAllByRole('listitem').length).toBe(2));
    await expect(normalized(region)).toMatchFileSnapshot(baseline('queue-pane-detailed'));
  });
});
