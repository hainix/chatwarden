import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The person page under axe, in both themes, in each state a moderator meets: a full timeline, a revoke form with its error, the
// sanction form with its messages, and the note form. jsdom paints no colours, so `color-contrast` is off here; the stylesheet's
// contrast is computed from its tokens by the static tests.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

async function busy(): Promise<{ w: HubWorld; person: string }> {
  const w = await hubWorld({ role: 'senior', actor: 'ann@example.test' });
  const f = await w.fileRich({ target: 'Vlemmo', reporter: 'Rae' });
  await w.file({ target: 'Vlemmo', category: 'spam' });
  await w.sanction(f.person, 'warning', 1);
  const old = await w.sanction(f.person, 'chat', 2, HOUR);
  await w.sanction(f.person, 'note', 'uncovered');
  await w.sanction(f.person, 'ban', 3, 7 * DAY);
  await w.clientFor('bea@example.test').revokeSanction(old.groupId, 'a misread');
  await w.cw.sanctions.apply({ kind: 'chat', subject: f.person, includeIp: false, durationMs: HOUR, reason: 'auto', actor: 'system', source: 'auto_filter', automated: true, rule: 1 });
  await w.cw.sanctions.apply({ kind: 'warning', subject: f.person, includeIp: false, durationMs: null, reason: 'ai', actor: 'ai', source: 'ai', automated: false, rule: 1 });
  w.clock.t += 3 * HOUR;
  return { w, person: f.person };
}

describe.each(['light', 'dark'] as const)('axe on the person page, %s theme', (theme) => {
  async function open(w: HubWorld, person: string) {
    const r = renderHub(w, { theme, path: `/people/${person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    return r;
  }

  it('a full timeline (active, ended, revoked, note, automatic, AI, reports) and a reporter record has no violations', async () => {
    const { w, person } = await busy();
    const { container } = await open(w, person);
    expect(await violations(container)).toEqual([]);
  });

  it('an empty person has no violations', async () => {
    const w = await hubWorld();
    const { container } = await open(w, 's_nobody_000000');
    expect(await violations(container)).toEqual([]);
  });

  it('the revoke form, with its message, has no violations', async () => {
    const { w, person } = await busy();
    const { container, user } = await open(w, person);
    await user.click(within(screen.getByRole('region', { name: 'In force now' })).getAllByRole('button', { name: /^Revoke/ })[0]!);
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect(screen.getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('the sanction form with its messages, and with a gap note and the IP box, has no violations', async () => {
    const { w, person } = await busy();
    const { container, user } = await open(w, person);
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await violations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText('What happens'), 'ban');
    await user.selectOptions(screen.getByLabelText('Community Rule'), 'uncovered');
    expect(screen.getByRole('checkbox', { name: /IP address/ })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('the note form has no violations', async () => {
    const { w, person } = await busy();
    const { container, user } = await open(w, person);
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await violations(container)).toEqual([]);
  });

  it('a failed load has no violations', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (/\/history$/.test(req.path) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { container } = renderHub(w, { theme, path: '/people/s_nobody_000000' });
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });
});
