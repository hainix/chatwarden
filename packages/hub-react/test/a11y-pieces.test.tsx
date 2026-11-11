import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/pieces/AuditLog.js';
import { BlockedList } from '../src/pieces/BlockedList.js';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { CaseWorkbench } from '../src/pieces/CaseWorkbench.js';
import { Guide } from '../src/pieces/Guide.js';
import { PersonRecord } from '../src/pieces/PersonRecord.js';
import { RecentActions } from '../src/pieces/RecentActions.js';
import { RuleGaps } from '../src/pieces/RuleGaps.js';
import { TermsManager } from '../src/pieces/TermsManager.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';
import { renderPieces } from './pieces-kit.js';

// Every piece under axe, in both themes, with its callbacks wired and without (a link is a button or text). jsdom paints no colours,
// so `color-contrast` is off here; the stylesheet's contrast is computed from its tokens by the static tests.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

async function busy(): Promise<{ w: HubWorld; id: string; person: string }> {
  const w = await hubWorld({ role: 'owner', actor: 'ann@example.test' });
  const a = await w.file({ target: 'Vantablob', room: 'room-a' });
  await w.file({ target: 'Vantablob', room: 'room-b' });
  await w.file({ target: 'Kestrel' });
  await w.sanction(a.person, 'chat', 'uncovered');
  w.blockLine('Vantablob', 'you zorbak, learn to rotate');
  return { w, id: a.id, person: a.person };
}

describe.each(['light', 'dark'] as const)('axe on the pieces, %s theme', (theme) => {
  const wired = { onOpenCase: vi.fn(), onOpenPerson: vi.fn(), onOpenReport: vi.fn(), onOpenTerms: vi.fn() };

  async function check(make: (ids: { id: string; person: string }) => ReactNode, ready: () => Promise<unknown>, withCallbacks: boolean) {
    const { w, id, person } = await busy();
    const r = renderPieces(w, make({ id, person }), { theme });
    await ready();
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    expect(await violations(r.container)).toEqual([]);
    return { ...r, w, withCallbacks };
  }

  for (const withCallbacks of [false, true]) {
    const cb: Partial<typeof wired> = withCallbacks ? wired : {};
    const label = withCallbacks ? 'with callbacks' : 'without callbacks';

    it(`CaseList ${label}`, async () => {
      await check(() => <CaseList {...cb} />, () => screen.findByText('Kestrel'), withCallbacks);
    });

    it(`CaseCard ${label}, then Something else`, async () => {
      const { user, container } = await check(({ id }) => <CaseCard reportId={id} {...cb} />, () => screen.findByRole('button', { name: /^No action needed/ }), withCallbacks);
      await user.click(screen.getByRole('button', { name: /^Something else/ }));
      await screen.findByRole('radio', { name: /Fair/ });
      expect(await violations(container)).toEqual([]);
    });

    it(`CaseWorkbench ${label}, in each tab`, async () => {
      const { user, container } = await check(({ id }) => <CaseWorkbench reportId={id} {...cb} />, () => screen.findByRole('complementary', { name: 'About this case' }), withCallbacks);
      for (const name of [/Reports/, /History/]) {
        await user.click(screen.getByRole('tab', { name }));
        expect(await violations(container), String(name)).toEqual([]);
      }
    });

    it(`PersonRecord ${label}`, async () => {
      await check(({ person }) => <PersonRecord person={person} {...cb} />, () => screen.findByRole('region', { name: 'Timeline' }), withCallbacks);
    });

    it(`TermsManager ${label}`, async () => {
      await check(() => <TermsManager />, () => screen.findByRole('heading', { level: 2, name: 'Terms' }), withCallbacks);
    });

    it(`BlockedList ${label}`, async () => {
      await check(() => <BlockedList {...cb} />, () => screen.findByRole('table'), withCallbacks);
    });

    it(`AuditLog ${label}`, async () => {
      await check(() => <AuditLog {...cb} />, () => screen.findByRole('heading', { level: 2, name: 'Audit' }), withCallbacks);
    });

    it(`RuleGaps ${label}`, async () => {
      await check(() => <RuleGaps />, () => screen.findByRole('heading', { level: 2, name: 'Rule gaps' }), withCallbacks);
    });

    it(`Guide ${label}`, async () => {
      await check(() => <Guide />, () => screen.findByRole('heading', { level: 2, name: 'Guide' }), withCallbacks);
    });

    it(`RecentActions ${label}`, async () => {
      await check(() => <RecentActions {...cb} />, () => screen.findByRole('heading', { level: 2, name: 'All actions' }), withCallbacks);
    });
  }

  it('the plain "no permission" message has no violations', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const r = renderPieces(w, <AuditLog />, { theme });
    await screen.findByText(/can.t open this/);
    expect(await violations(r.container)).toEqual([]);
  });

  it('every piece together on one page has no violations, and no duplicate ids or landmarks', async () => {
    const { w, id, person } = await busy();
    const r = renderPieces(
      w,
      <>
        <CaseList />
        <CaseCard reportId={id} />
        <PersonRecord person={person} />
        <RecentActions />
      </>,
      { theme },
    );
    await screen.findByRole('region', { name: 'Case against Vantablob' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    expect(await violations(r.container)).toEqual([]);
    expect(within(r.container).queryAllByRole('main')).toEqual([]);
  });
});
