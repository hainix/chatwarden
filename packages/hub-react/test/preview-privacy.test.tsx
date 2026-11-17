import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// Review Focus 1: a moderator-only field in the panel. A sentinel typed into every private field of a form (the reason, the gap note) and the person's
// staff ref must never appear in the panel's DOM, its aria text or its polite sentence, whatever the form says. Synthetic terms only.

const SENTINEL_REASON = 'SENTINEL-REASON-quissel-7f3a';
const SENTINEL_GAP = 'SENTINEL-GAP-drakkuun-91bc';
const BAD = 'zorbakKid';

afterEach(() => {
  vi.useRealTimers();
});

/** Everything in an element a reader or a screen reader could get: its text and every attribute value. */
const everything = (el: Element): string => [el.textContent ?? '', ...[...el.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.value))].join('\n');

describe('a sentinel typed into the form never reaches the panel', () => {
  it('the reason, the gap note and the ref, in the Sanction form (every kind), the rename and the note', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.file({ target: 'Mallory' });
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    const form = await screen.findByRole('region', { name: 'Sanction Mallory' });
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    const panel = await within(form).findByRole('region', { name: 'What the player sees' });
    await user.selectOptions(screen.getByLabelText('Community Rule'), 'uncovered');
    await user.type(screen.getByLabelText('What the rules do not cover'), SENTINEL_GAP);
    await user.type(screen.getByLabelText('Reason'), SENTINEL_REASON);
    for (const kind of ['warning', 'chat', 'area', 'ban', 'rename']) {
      await user.selectOptions(screen.getByLabelText('What happens'), kind);
      if (kind === 'rename') await user.selectOptions(screen.getByLabelText('Community Rule'), '7');
      await waitFor(() => expect(panel.textContent).not.toBe(''));
      const seen = everything(panel);
      for (const secret of [SENTINEL_REASON, SENTINEL_GAP, f.person, 'private', 'mod_ann']) expect(seen, `${kind}: ${secret}`).not.toContain(secret);
    }
  });

  it('the revoke reason and the sanction reference never reach the panel', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    const s = await w.sanction(f.person, 'chat', 2, 24 * 3_600_000);
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'In force now' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    await user.click(within(screen.getByRole('region', { name: 'In force now' })).getAllByRole('button', { name: /^Revoke/ })[0] as HTMLElement);
    const form = screen.getByRole('form', { name: /^Revoke/ });
    const panel = await within(form).findByRole('region', { name: 'What the player sees' });
    await user.type(within(form).getByRole('textbox'), SENTINEL_REASON);
    const seen = everything(panel);
    for (const secret of [SENTINEL_REASON, f.person, s.refCode, s.groupId]) expect(seen, secret).not.toContain(secret);
  });

  it('the polite sentence says what the player is sent, never what was typed', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    const form = await screen.findByRole('region', { name: 'Add a note about Mallory' });
    const panel = await within(form).findByRole('region', { name: 'What the player sees' });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const status = panel.querySelector('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    await act(async () => {
      await user.type(within(form).getByRole('textbox'), SENTINEL_REASON);
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(status.textContent).not.toContain(SENTINEL_REASON);
    expect(everything(panel)).not.toContain(SENTINEL_REASON);
  });
});

describe('no raw handle in the DOM', () => {
  it('a flagged name stays the hidden label through every kind of the Sanction form and the rename', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.file({ target: BAD });
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    const form = await screen.findByRole('region', { name: /^Sanction / });
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    const panel = await within(form).findByRole('region', { name: 'What the player sees' });
    for (const kind of ['warning', 'chat', 'ban', 'rename']) {
      await user.selectOptions(screen.getByLabelText('What happens'), kind);
      if (kind === 'rename') await user.selectOptions(screen.getByLabelText('Community Rule'), '7');
      expect(/zorbak/i.test(panel.innerHTML), kind).toBe(false);
    }
    expect(/zorbak/i.test(form.innerHTML)).toBe(false);
  });
});
