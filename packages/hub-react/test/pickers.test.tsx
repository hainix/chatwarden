import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Where a moderator picks a length: "Something else" in the decision bar, and the Sanction form on the person page. Both offer the
// profile's durations, "Custom length" when the profile allows it (with the kit's bounds), and permanent when the role may.

const H = 3_600_000;
const D = 24 * H;
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /\/decide$/.test(r.path));
const sanctions = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && r.path === '/sanctions');
const texts = (el: HTMLElement): string[] => within(el).getAllByRole('option').map((o) => o.textContent ?? '');
const seed = (w: HubWorld, layer: object) => {
  const r = w.cw.policy.save(layer, { version: 0, actor: 'x', reason: 'seed' });
  if (!r.ok) throw new Error(JSON.stringify(r));
};

async function finish(user: ReturnType<typeof renderHub>['user']): Promise<void> {
  await user.click(screen.getByRole('radio', { name: 'Fair' }));
  await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Light touch');
  await user.click(screen.getByRole('button', { name: 'Decide' }));
  window.dispatchEvent(new Event('pagehide'));
}

describe('the decision bar: Something else', () => {
  async function bar(options: WorldOptions = {}, layer?: object) {
    const w = await hubWorld({ role: 'senior', ...options });
    if (layer !== undefined) seed(w, layer);
    const f = await w.fileRich({});
    const r = renderHub(w, { path: `/reports/${f.id}` });
    const suggests = await screen.findByRole('group', { name: 'The ladder suggests' });
    await r.user.click(within(suggests).getByRole('button', { name: 'Change' }));
    return { w, f, ...r };
  }
  const action = () => screen.getByRole('group', { name: 'Action 1' });
  async function something(user: Awaited<ReturnType<typeof bar>>['user']) {
    await user.selectOptions(within(action()).getByLabelText('What happens'), 'Something else');
  }

  it('offers the profile lengths, permanent, and Custom length', async () => {
    const { user } = await bar();
    await something(user);
    expect(texts(within(action()).getByLabelText('Length'))).toEqual(['1 hour', '6 hours', '12 hours', '24 hours', '3 days', '7 days', '30 days', 'Permanent', 'Custom length']);
  });

  it('follows a saved change of the lengths, and hides Custom length when the profile turns it off', async () => {
    const { user } = await bar({}, { durations: [H, 2 * D], customDuration: false });
    await something(user);
    expect(texts(within(action()).getByLabelText('Length'))).toEqual(['1 hour', '2 days', 'Permanent']);
  });

  it('a listed length is what is sent', async () => {
    const { w, user } = await bar();
    await something(user);
    await user.selectOptions(within(action()).getByLabelText('Length'), '6 hours');
    await finish(user);
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    const body = decides(w)[0]?.body as { actions: Array<{ kind: string; durationMs: number }> };
    expect(body.actions.at(-1)).toMatchObject({ durationMs: 6 * H });
  });

  it('a custom length reads a number and hours or days, and is sent as milliseconds', async () => {
    const { w, user } = await bar();
    await something(user);
    await user.selectOptions(within(action()).getByLabelText('Length'), 'Custom length');
    await user.type(within(action()).getByLabelText('Number'), '36');
    await user.selectOptions(within(action()).getByLabelText('Unit'), 'Hours');
    await finish(user);
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    const body = decides(w)[0]?.body as { actions: Array<{ durationMs: number }> };
    expect(body.actions.at(-1)?.durationMs).toBe(36 * H);
  });

  it.each<[string, string, string]>([
    ['', 'Hours', 'Enter a length, such as 6 and hours.'],
    ['0', 'Hours', 'The shortest length is 1 minute.'],
    ['400', 'Days', 'The longest length is 365 days.'],
    ['1.00001', 'Hours', 'Use a length in whole minutes.'],
  ])('a custom length of %j %s is refused with a plain message, and Decide sends nothing', async (amount, unit, message) => {
    const { w, user } = await bar();
    await something(user);
    await user.selectOptions(within(action()).getByLabelText('Length'), 'Custom length');
    if (amount !== '') await user.type(within(action()).getByLabelText('Number'), amount);
    await user.selectOptions(within(action()).getByLabelText('Unit'), unit);
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'x');
    await user.click(screen.getByRole('button', { name: 'Decide' }));
    expect(within(action()).getByText(message)).toBeInTheDocument();
    expect(within(action()).getByLabelText('Number')).toHaveAttribute('aria-invalid', 'true');
    window.dispatchEvent(new Event('pagehide'));
    expect(decides(w)).toHaveLength(0);
  });

  it('a ban has no Permanent for a role that may not give one', async () => {
    const { user } = await bar({ role: 'moderator' });
    await something(user);
    await user.selectOptions(within(action()).getByLabelText('Kind'), 'Ban');
    expect(texts(within(action()).getByLabelText('Length'))).not.toContain('Permanent');
    await user.selectOptions(within(action()).getByLabelText('Kind'), 'Chat restriction');
    expect(texts(within(action()).getByLabelText('Length'))).toContain('Permanent');
  });

  it('when 24 hours is not offered, the length starts on one that is (the nearest to a day)', async () => {
    const { w, user } = await bar({}, { durations: [3 * D, 7 * D] });
    await something(user);
    expect(within(action()).getByLabelText('Length')).toHaveDisplayValue('3 days');
    await finish(user);
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]?.body as { actions: Array<{ durationMs: number }> }).actions.at(-1)?.durationMs).toBe(3 * D);
  });

  it('a 400 duration_not_offered (the profile changed under the moderator) is a plain sentence, with the form kept', async () => {
    const { w, user } = await bar();
    w.intercept.fn = (req) => (/\/decide$/.test(req.path) ? { status: 400, body: { error: 'duration_not_offered', message: 'x' } } : undefined);
    await something(user);
    await finish(user);
    expect(await screen.findByText('That length is not one of the lengths offered. Choose another length and try again.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveValue('Light touch');
  });
});

describe('the Sanction form on the person page', () => {
  async function page(options: WorldOptions = {}, layer?: object) {
    const w = await hubWorld({ role: 'senior', ...options });
    if (layer !== undefined) seed(w, layer);
    const f = await w.file({ target: 'Mallory' });
    const r = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    await r.user.click(screen.getByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: 'Sanction Mallory' });
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    return { w, f, ...r };
  }
  const length = () => screen.getByLabelText('How long');

  it('offers the profile lengths, permanent and Custom length', async () => {
    const { user } = await page();
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    expect(texts(length())).toEqual(['1 hour', '6 hours', '12 hours', '24 hours', '3 days', '7 days', '30 days', 'Permanent', 'Custom length']);
  });

  it('follows the profile: its own lengths, no custom', async () => {
    const { user } = await page({}, { durations: [H, 2 * D], customDuration: false });
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    expect(texts(length())).toEqual(['1 hour', '2 days', 'Permanent']);
  });

  it('sends a listed length (6 hours) and a custom one (3 days), as the body the kit takes', async () => {
    const { w, user } = await page();
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    await user.selectOptions(length(), '6 hours');
    await user.selectOptions(screen.getByLabelText('Community Rule'), '2');
    await user.type(screen.getByLabelText('Reason'), 'Light');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sanctions(w)).toHaveLength(1));
    expect(sanctions(w)[0]?.body).toMatchObject({ kind: 'chat', durationMs: 6 * H });
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: 'Sanction Mallory' });
    await user.selectOptions(screen.getByLabelText('What happens'), 'ban');
    await user.selectOptions(length(), 'Custom length');
    await user.type(screen.getByLabelText('Number'), '3');
    await user.selectOptions(screen.getByLabelText('Unit'), 'Days');
    await user.selectOptions(screen.getByLabelText('Community Rule'), '2');
    await user.type(screen.getByLabelText('Reason'), 'Again');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sanctions(w)).toHaveLength(2));
    expect(sanctions(w)[1]?.body).toMatchObject({ kind: 'ban', durationMs: 3 * D });
  });

  it.each([['', 'Enter a length, such as 6 and hours.'], ['0', 'The shortest length is 1 minute.'], ['999', 'The longest length is 365 days.']])(
    'a custom length of %j is refused before sending: %s',
    async (amount, message) => {
      const { w, user } = await page();
      await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
      await user.selectOptions(length(), 'Custom length');
      if (amount !== '') await user.type(screen.getByLabelText('Number'), amount);
      await user.selectOptions(screen.getByLabelText('Unit'), 'Days');
      await user.selectOptions(screen.getByLabelText('Community Rule'), '2');
      await user.type(screen.getByLabelText('Reason'), 'x');
      await user.click(screen.getByRole('button', { name: 'Apply' }));
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText('Number')).toHaveFocus();
      expect(sanctions(w)).toHaveLength(0);
    },
  );

  it('a 400 duration_not_offered is a plain sentence and the form keeps what was typed', async () => {
    const { w, user } = await page({}, { customDuration: false });
    w.intercept.fn = (req) => (req.path === '/sanctions' ? { status: 400, body: { error: 'duration_not_offered', message: 'x' } } : undefined);
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    await user.selectOptions(screen.getByLabelText('Community Rule'), '2');
    await user.type(screen.getByLabelText('Reason'), 'kept');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('That length is not one of the lengths offered. Choose another length and try again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveValue('kept');
  });

  it('the real server refuses a custom length when the profile turns it off, so the form never offers one', async () => {
    const { w } = await page({}, { customDuration: false });
    const r = await w.raw({ method: 'POST', path: '/sanctions', headers: { 'x-test-actor': 'a', 'x-test-role': 'owner' }, rawBody: JSON.stringify({ subject: 'nobody', kind: 'chat', durationMs: 5 * H, rule: 2, reason: 'x', includeIp: false }) });
    expect([400, 404]).toContain(r.status);
    expect(screen.queryByRole('option', { name: 'Custom length' })).toBeNull();
  });

  it('when 24 hours is not offered, the length starts on one that is', async () => {
    const { w, user } = await page({}, { durations: [3 * D, 7 * D] });
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    expect(length()).toHaveDisplayValue('3 days');
    await user.selectOptions(screen.getByLabelText('Community Rule'), '2');
    await user.type(screen.getByLabelText('Reason'), 'x');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sanctions(w)).toHaveLength(1));
    expect(sanctions(w)[0]?.body).toMatchObject({ durationMs: 3 * D });
  });
});
