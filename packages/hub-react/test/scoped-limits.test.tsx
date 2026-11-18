import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { limitChoices, presets } from '../src/decision.js';
import type { Choice } from '../src/decision.js';
import { menuOf } from '../src/policy/lengths.js';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { WorldOptions } from './world.js';
import { appealsHub } from './appealsWorld.js';

// M-2: a scoped caller's hub offers only what the server would accept: the kinds and lengths of the caller's limits (GET /me carries them), no IP, no rename.

const A = 'creator:alice';
const LIMITS = { kinds: ['warning', 'chat'] as const, maxDurationMs: 7 * DAY };

describe('limitChoices and menuOf narrow what a form offers', () => {
  const all: Choice[] = presets({}, [{ kind: 'ban', durationMs: HOUR }]);

  it('keeps only the kinds of the limits and, for a timed kind, a length of at most the limit; a note and a permanent restriction go', () => {
    const kept = limitChoices(all, LIMITS);
    expect(kept.length).toBeGreaterThan(0);
    for (const c of kept) {
      expect(['warning', 'chat']).toContain(c.kind);
      if (c.kind === 'chat') expect(c.durationMs).not.toBeNull();
      if (c.kind === 'chat') expect(c.durationMs as number).toBeLessThanOrEqual(7 * DAY);
    }
    expect(kept.some((c) => c.kind === 'warning')).toBe(true);
    expect(kept.some((c) => c.kind === 'chat')).toBe(true);
  });

  it('a wider limit keeps more; the exact limit is kept; none (a global caller) changes nothing', () => {
    const wide = limitChoices(all, { kinds: ['warning', 'chat', 'area', 'ban'], maxDurationMs: 365 * DAY });
    expect(wide.filter((c) => c.kind === 'ban' && c.durationMs !== null).length).toBeGreaterThan(0);
    expect(wide.some((c) => c.kind === 'ban' && c.durationMs === null)).toBe(false);
    expect(limitChoices([{ kind: 'chat', durationMs: 7 * DAY }, { kind: 'chat', durationMs: 7 * DAY + 1 }], LIMITS)).toEqual([{ kind: 'chat', durationMs: 7 * DAY }]);
    expect(limitChoices(all, undefined)).toEqual(all);
  });

  it('menuOf with limits: lengths over the limit are gone, no permanent, no custom; without limits it is what it was', () => {
    const lengths = { durations: [HOUR, DAY, 7 * DAY, 30 * DAY], custom: true };
    const menu = menuOf(lengths, 'chat', true, LIMITS);
    expect(menu).toEqual({ durations: [HOUR, DAY, 7 * DAY], permanent: false, custom: false });
    expect(menuOf(lengths, 'chat', true)).toEqual({ durations: [HOUR, DAY, 7 * DAY, 30 * DAY], permanent: true, custom: true });
    // nothing on the profile's list fits: the limit itself is the one length offered
    expect(menuOf({ durations: [30 * DAY], custom: true }, 'chat', true, LIMITS).durations).toEqual([7 * DAY]);
    // the legacy menu (profile not read, as for a scoped caller) is cut the same way
    const legacy = menuOf(undefined, 'chat', true, LIMITS);
    expect(Math.max(...legacy.durations)).toBeLessThanOrEqual(7 * DAY);
    expect(legacy.permanent).toBe(false);
  });
});

async function person(o: WorldOptions) {
  const w = await hubWorld(o);
  const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
  const r = renderHub(w, { path: `/people/${f.person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  await r.user.click(screen.getByRole('button', { name: 'Sanction' }));
  await screen.findByRole('region', { name: 'Sanction Mallory' });
  return { w, f, ...r };
}
const what = (): HTMLSelectElement => screen.getByLabelText('What happens');
const optionNames = (select: HTMLSelectElement): string[] => within(select).getAllByRole('option').map((o) => o.textContent ?? '');
const ipBox = (): HTMLElement | null => screen.queryByRole('checkbox', { name: /IP address/ });

describe('the Person page of a scoped caller', () => {
  it('renders (the scoped history carries no reporter record, so there is no reporter panel) and still offers the Sanction button', async () => {
    const w = await hubWorld({ role: 'senior', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    renderHub(w, { path: `/people/${f.person}` });
    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'As a reporter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sanction' })).toBeInTheDocument();
  });
});

describe('the Sanction form of a scoped caller', () => {
  it('offers a warning and a chat restriction, no area or ban, no request for a new name, and no IP box', async () => {
    const { user } = await person({ role: 'senior', scope: [A] });
    const names = optionNames(what());
    expect(names).toContain('Warning');
    expect(names).toContain('Chat restriction');
    expect(names.join('|')).not.toMatch(/Area|Ban/);
    expect(names.join('|')).not.toMatch(/new name/i);
    await user.selectOptions(what(), 'chat');
    expect(ipBox()).toBeNull();
    const lengths = optionNames(screen.getByLabelText('How long') as HTMLSelectElement);
    expect(lengths.join('|')).not.toMatch(/Permanent|Custom/i);
    expect(lengths.join('|')).not.toMatch(/30 days|90 days|year/i);
  });

  it('follows the limits the kit was given: a wider set offers area and longer lengths, still never the IP', async () => {
    const { user } = await person({ role: 'senior', scope: [A], scopedLimits: { kinds: ['warning', 'chat', 'area'], maxDurationMs: 30 * DAY } });
    const names = optionNames(what());
    expect(names.join('|')).toMatch(/Area/);
    expect(names.join('|')).not.toMatch(/Ban/);
    await user.selectOptions(what(), 'area');
    expect(ipBox()).toBeNull();
  });

  it('control: the same form for an unscoped senior still offers every kind, the IP box and a permanent length', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: 'Sanction Mallory' });
    const names = optionNames(what());
    for (const n of ['Warning', 'Chat restriction']) expect(names).toContain(n);
    expect(names.join('|')).toMatch(/Area/);
    expect(names.join('|')).toMatch(/Ban/);
    await user.selectOptions(what(), 'ban');
    expect(optionNames(screen.getByLabelText('How long') as HTMLSelectElement).join('|')).toMatch(/Permanent/);
    await user.selectOptions(what(), 'chat');
    expect(ipBox()).not.toBeNull();
  });
});

describe('the decision bar of a scoped caller on a name report', () => {
  it('shows neither the row to ask for a new name nor the line that says renames are off (they cannot be asked for here)', async () => {
    const w = await appealsHub({ names: { renames: true }, role: 'senior', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', reason: 'name', tags: { scope: A } });
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    const bar = await screen.findByRole('region', { name: 'Decision' });
    await within(bar).findByRole('radio', { name: 'Fair' });
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    expect(within(bar).queryByRole('checkbox', { name: 'Ask for a new name' })).toBeNull();
    expect(bar.querySelector('.cw-rename-off')).toBeNull();
  });

  it('GET /me told the hub so: features.renames is false and the limits are there', async () => {
    const w = await appealsHub({ names: { renames: true }, role: 'senior', scope: [A] });
    const me = await w.client.me();
    expect(me.features?.renames).toBe(false);
    expect(me.scopedLimits).toEqual({ kinds: ['warning', 'chat'], maxDurationMs: 7 * DAY });
  });
});
