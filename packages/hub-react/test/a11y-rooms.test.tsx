import { screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { rulesCss } from './css.js';
import { renderHub } from './render.js';
import { MINUTE, hubWorld } from './world.js';

// The Rooms panel, the room actions on a case, the surge and evidence lines and the Person page's menu under axe, in both themes; the 360 px checks read the stylesheet. Words, not colour.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on rooms, %s theme', (theme) => {
  it('the Rooms panel (empty, listed, a duration question, a refusal, read-only) has none', async () => {
    const w = await hubWorld();
    const empty = renderHub(w, { theme, path: '/settings/advanced' });
    await screen.findByText('No rooms are known to this server right now.');
    expect(await violations(empty.container)).toEqual([]);
    empty.unmount();
    await w.file({ room: 'lobby-1' });
    w.cw.rooms.setMode('lobby-1', 'locked', { forMs: 30 * MINUTE });
    const { container, user } = renderHub(w, { theme, path: '/settings/advanced' });
    const group = await screen.findByRole('group', { name: 'Mode for lobby-1' });
    expect(await violations(container)).toEqual([]);
    await user.click(within(group).getByRole('radio', { name: 'Emergency' }));
    expect(await violations(container)).toEqual([]);
    w.intercept.fn = (req) => (req.path.endsWith('/mode') ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await user.click(within(group).getByRole('button', { name: 'Start emergency mode' }));
    await within(group).findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('a read-only Rooms panel has none', async () => {
    const w = await hubWorld({ permissions: { 'rooms.manage': 'owner' } });
    await w.file({ room: 'lobby-1' });
    const { container } = renderHub(w, { theme, path: '/settings/advanced' });
    await screen.findByText('lobby-1');
    expect(await violations(container)).toEqual([]);
  });

  it('a case with the room actions, the line menu, the surge and the evidence has none', async () => {
    const w = await hubWorld({ overrides: { desk: { surge: { enabled: true, reports: 3 } }, reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } });
    w.cw.rooms.seat('room-x', 'p1', { clientKey: 'key-1' }, 'Mallory');
    w.cw.rooms.seat('room-x', 'p2', { clientKey: 'key-2' }, 'Rhea');
    w.cw.chat.accept('room-x', 'p1', 'a line from the target');
    w.clock.t += 1000;
    let id = '';
    for (let i = 0; i < 3; i += 1) {
      const res = await w.cw.reports.submit({ roomId: 'room-x', reporterSeat: 'p2', targetSeat: 'p1', category: 'harassment', evidenceRef: 'match_1' }).catch(() => null);
      if (res !== null && res.ok) id = res.reportId;
      w.clock.t += 1000;
    }
    const f = id === '' ? await w.fileRich({ room: 'room-y' }) : { id };
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await screen.findByRole('tablist');
    await user.click(await screen.findByRole('button', { name: 'More actions on this case' }));
    await user.click(screen.getByRole('button', { name: 'Lock this room' }));
    expect(await violations(container)).toEqual([]);
    await user.click(within(screen.getByRole('group', { name: 'Lock this room' })).getByRole('button', { name: 'Cancel' }));
    const lineButton = screen.getAllByRole('button', { name: /Remove options for the line at/ })[0] as HTMLElement;
    await user.click(lineButton);
    expect(await violations(container)).toEqual([]);
  });

  it('the Person page\'s menu, closed and open with its line, has none', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Mallory', reporter: 'Rhea' });
    const { container, user } = renderHub(w, { theme, path: `/people/${f.person}` });
    await screen.findByRole('heading', { level: 2, name: /Mallory/ });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'More about this person' }));
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    await screen.findByText(/linked to this person|No accounts or devices/);
    expect(await violations(container)).toEqual([]);
  });
});

describe('at 360 px nothing scrolls sideways', () => {
  const css = rulesCss();
  const rule = (selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] as string).split(',').map((s) => s.trim()).includes(selector))
      .map((m) => m[2])
      .join(';');

  it('a room can shrink, wraps long ids and wraps its radios; the surge and evidence lines wrap', () => {
    expect(rule('.cw-hub .cw-room')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-room')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-room-radios')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-surge')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-line-menu-panel')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-person-menu-panel')).toMatch(/min-width:\s*0/);
  });

  it('use no colour of their own', () => {
    for (const s of ['.cw-hub .cw-room', '.cw-hub .cw-surge', '.cw-hub .cw-line-menu-panel', '.cw-hub .cw-person-menu-panel']) {
      expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
    }
  });
});
