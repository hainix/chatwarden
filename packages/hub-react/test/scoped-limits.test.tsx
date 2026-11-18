import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { limitChoices, presets } from '../src/decision.js';
import type { Choice } from '../src/decision.js';
import { menuOf } from '../src/policy/lengths.js';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
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

const what = (): HTMLSelectElement => screen.getByLabelText('What happens');
const optionNames = (select: HTMLSelectElement): string[] => within(select).getAllByRole('option').map((o) => o.textContent ?? '');
const ipBox = (): HTMLElement | null => screen.queryByRole('checkbox', { name: /IP address/ });

describe('the Person page of a scoped caller', () => {
  it('renders (the scoped history carries no reporter record, so there is no reporter panel) and offers no Sanction button (they act from a case)', async () => {
    const w = await hubWorld({ role: 'senior', scope: [A] });
    const f = await w.fileRich({ target: 'Mallory', tags: { scope: A } });
    renderHub(w, { path: `/people/${f.person}` });
    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'As a reporter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sanction' })).toBeNull();
  });
});

// The Person page offers a scoped caller no Sanction form (C11 task 0), so the form's own trimming is checked where a scoped caller does act: the decision bar (scoped-decide.test.tsx). The control stays.
describe('the Sanction form', () => {
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

// Today a scoped caller cannot read the rules (policy.read is not scope-aware), so the decision bar offers no action row to them at all; these two keep it that way if that changes.
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

  it('control: the same name report, unscoped, does show the row (so the test above is not looking at nothing)', async () => {
    const w = await appealsHub({ names: { renames: true }, role: 'senior' });
    const f = await w.fileRich({ target: 'Mallory', reason: 'name' });
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    const bar = await screen.findByRole('region', { name: 'Decision' });
    await within(bar).findByRole('radio', { name: 'Fair' });
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    expect(within(bar).getByRole('checkbox', { name: 'Ask for a new name' })).toBeInTheDocument();
  });

  it('GET /me told the hub so: features.renames is false and the limits are there', async () => {
    const w = await appealsHub({ names: { renames: true }, role: 'senior', scope: [A] });
    const me = await w.client.me();
    expect(me.features?.renames).toBe(false);
    expect(me.scopedLimits).toEqual({ kinds: ['warning', 'chat'], maxDurationMs: 7 * DAY });
  });
});
