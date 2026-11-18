import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The privacy and legal-hold parts under axe, in both themes and in each state: the Person page's Data requests (closed and open), the erase dialog (counting, a ban, the
// stronger warning, an error, the receipt), Settings > Advanced > Privacy requests (with its table) and the case's hold dialogs. jsdom paints no colours, so `color-contrast`
// is off; the parts add no colour token (the notice tones and tags are the existing ones). 360 px: the statement table scrolls inside its own region, nothing is a fixed width.
const RULES = { 'color-contrast': { enabled: false } } as const;

afterEach(() => cleanup());

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on the privacy parts, %s theme', (theme) => {
  it('the Person page with Data requests closed and open has no violations', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const f = await w.file();
    const { container, user } = renderHub(w, { theme, path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
    await user.click(await screen.findByRole('button', { name: 'Data requests' }));
    await screen.findByRole('group', { name: 'Data requests' });
    expect(await violations(container)).toEqual([]);
  });

  it('the erase dialog counting, with a ban, with the stronger warning and with an error has none', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const f = await w.file();
    await w.cw.sanctions.apply({ kind: 'ban', subject: f.person, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    await w.cw.legal.hold(f.id, { code: 'other', actor: 'senior_gus' });
    const { container, user } = renderHub(w, { theme, path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(await screen.findByRole('button', { name: 'Data requests' }));
    await user.click(screen.getByRole('button', { name: 'Erase data...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Erase the data about this person' });
    await waitFor(() => expect(within(dialog).queryByText('Counting what would be removed.')).toBeNull());
    expect(await violations(container)).toEqual([]);
    await user.click(within(dialog).getByRole('radio', { name: 'Keep only held reports' }));
    await within(dialog).findByText(/will stop applying/);
    expect(await violations(container)).toEqual([]);
    w.intercept.fn = (req) => (/privacy\/erase$/.test(req.path) && (req.body as { dryRun?: boolean }).dryRun !== true ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    await user.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    await within(dialog).findByText(/Could not erase/);
    expect(await violations(container)).toEqual([]);
  });

  it('the receipt has none', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const f = await w.file();
    const { container, user } = renderHub(w, { theme, path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(await screen.findByRole('button', { name: 'Data requests' }));
    await user.click(screen.getByRole('button', { name: 'Erase data...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Erase the data about this person' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    await user.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    await screen.findByRole('dialog', { name: 'Erased' });
    expect(await violations(container)).toEqual([]);
  });

  it('Settings > Advanced > Privacy requests, with its table and a "not found" answer, has none', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const { container, user } = renderHub(w, { theme, path: '/settings/advanced' });
    const panel = await screen.findByRole('region', { name: 'Privacy requests' });
    await within(panel).findByRole('table');
    expect(await violations(container)).toEqual([]);
    await user.type(within(panel).getByRole('textbox', { name: 'Account id' }), 'acct-nobody');
    await user.click(within(panel).getByRole('button', { name: 'Find person' }));
    await within(panel).findByText(/No person has this account id/);
    expect(await violations(container)).toEqual([]);
  });

  it('the case with a hold line, the hold dialog and the release dialog have none', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const f = await w.file();
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}`, stay: true });
    await screen.findAllByRole('heading', { level: 2 });
    await user.click(await screen.findByRole('button', { name: 'Legal hold' }));
    await user.click(screen.getByRole('button', { name: 'Hold for legal...' }));
    await screen.findByRole('dialog', { name: 'Hold this report' });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Hold report' }));
    await screen.findByText(/Held for legal reasons/);
    expect(await violations(container)).toEqual([]);
    await user.click(await screen.findByRole('button', { name: 'Legal hold' }));
    await user.click(screen.getByRole('button', { name: 'Release hold...' }));
    await screen.findByRole('dialog', { name: 'Release the hold' });
    expect(await violations(container)).toEqual([]);
  });
});

describe('360 px: no sideways scroll from the privacy parts', () => {
  it('the statement table is its own scroll region (tab-reachable and named), and no part sets a fixed width', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    renderHub(w, { path: '/settings/advanced' });
    const panel = await screen.findByRole('region', { name: 'Privacy requests' });
    await within(panel).findByRole('table');
    const region = within(panel).getByRole('region', { name: 'What the kit keeps' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toContain('cw-privacy-table');
  });
});
