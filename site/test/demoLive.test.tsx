// N1 from the Task 2 re-review: two announcements in one tick must keep distinct keys, and Reset must clear the live region.
// (N2, the heading scrolled into view after an automatic pane switch, went with the automatic pane switch: demoCalm.test.tsx, fix H.)
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, setup as baseSetup, stubMatchMedia as stub } from './helpers/demoUi';

async function setup(opts: { stacked?: boolean; reduced?: boolean } = {}) {
  stub(opts.stacked ?? true, opts.reduced ?? false);
  const base = await baseSetup({ stacked: opts.stacked ?? true, reduced: opts.reduced ?? false });
  return { user: base.user };
}

const lines = () => [...live().querySelectorAll('p')].map((p) => p.textContent ?? '');
/** Reports Bo's rude line with the keyboard only and closes the thank-you. */
async function reportByKeyboard(user: ReturnType<typeof userEvent.setup>) {
  screen.getByRole('button', { name: /report bo's message: "uninstall/i }).focus();
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog');
  within(dialog).getByRole('button', { name: 'Report' }).focus();
  await user.keyboard('{Enter}');
  await within(dialog).findByRole('heading', { name: 'Report sent' });
  within(dialog).getByRole('button', { name: 'Close' }).focus();
  await user.keyboard('{Enter}');
}
const tourNext = () => within(screen.getByRole('region', { name: /guided tour/i })).getByRole('button', { name: /^next$/i });

beforeEach(() => stub(true));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('live region announcements (stacked layout)', () => {
  it('keeps both announcements of one report, each once, with no duplicate-key warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { user } = await setup();
    await reportByKeyboard(user);
    await waitFor(() => expect(lines().some((l) => /report filed against bo/i.test(l))).toBe(true));
    await waitFor(() => expect(lines().some((l) => /^Tour step 2 of 4/.test(l))).toBe(true));
    const got = lines();
    expect(got.filter((l) => /^Tour step 2 of 4/.test(l))).toHaveLength(1);
    expect(got.filter((l) => /report filed against bo/i.test(l))).toHaveLength(1);
    expect(got.some((l) => /showing the (moderator|game) view/i.test(l))).toBe(false); // the page no longer switches panes by itself
    expect(new Set(got).size).toBe(got.length);
    const keyWarnings = err.mock.calls.filter((c) => /same key|unique "key"/i.test(String(c[0]) + String(c[1] ?? '')));
    expect(keyWarnings).toEqual([]);
  });

  it('keeps the last announcements distinct through a whole tour', async () => {
    const { user } = await setup();
    for (let i = 0; i < 4; i++) await user.click(tourNext());
    const got = lines();
    expect(got.length).toBeLessThanOrEqual(4);
    expect(new Set(got).size).toBe(got.length);
    expect(got.some((l) => /tour done/i.test(l))).toBe(true);
  });

  it('Start over clears every stale line and leaves only its message', async () => {
    const { user } = await setup();
    for (let i = 0; i < 3; i++) await user.click(tourNext());
    expect(lines().length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await waitFor(() => expect(lines()).toEqual(['Started over. The lobby is back to the start.']));
  });

  it('announcing again after Start over still starts clean (a second full tour is as tidy as the first)', async () => {
    const { user } = await setup();
    for (let i = 0; i < 3; i++) await user.click(tourNext());
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    for (let i = 0; i < 3; i++) await user.click(tourNext());
    const got = lines();
    expect(new Set(got).size).toBe(got.length);
    expect(got.filter((l) => /^Tour step 3 of 4/.test(l))).toHaveLength(1);
  });
});
