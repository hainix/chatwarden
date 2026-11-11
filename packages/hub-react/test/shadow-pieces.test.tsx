import { waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { CaseWorkbench } from '../src/pieces/CaseWorkbench.js';
import { PersonRecord } from '../src/pieces/PersonRecord.js';
import type { TransportRequest } from '../src/transport.js';
import { focusedIn, piecesInShadow, removeShadowHosts, shadowRootIn } from './shadow.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// Pieces in a page's shadow root: the same keys, windows and focus as on the page. A piece answers keys only when focus is in it.

afterEach(removeShadowHosts);

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
];
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path));
const pageHides = (): void => {
  window.dispatchEvent(new Event('pagehide'));
};

describe('CaseCard in a shadow root', () => {
  async function card(extra: Parameters<typeof hubWorld>[0] = {}) {
    const w = await hubWorld(extra);
    const f = await w.fileRich({ lines: TALK, target: 'Alpha' });
    const onOpenReport = vi.fn();
    const s = piecesInShadow(w, <CaseCard reportId={f.id} onOpenReport={onOpenReport} />);
    const region = await s.q.findByRole('region', { name: 'Case against Alpha' });
    await within(region).findByRole('button', { name: /^No action needed/ });
    return { w, f, s, region, onOpenReport };
  }

  it('Ctrl+Enter decides from a button in the card', async () => {
    const { w, s, region } = await card();
    within(region).getByRole('button', { name: /^No action needed/ }).focus();
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    expect(await s.q.findAllByRole('button', { name: 'Undo' })).not.toHaveLength(0);
    pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
  });

  it('2 sends the no-action decision when focus is in the card', async () => {
    const { w, s, region } = await card();
    within(region).getByRole('button', { name: /^No action needed/ }).focus();
    await s.user.keyboard('2');
    await s.q.findByText('Decision queued.');
    pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.body).toMatchObject({ verdict: 'no_action' });
  });

  it('the same key with focus on the adopter\'s own control beside the card does nothing', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Alpha' });
    const shadow = shadowRootIn();
    const mine = document.createElement('button');
    shadow.append(mine);
    const s = piecesInShadow(w, <CaseCard reportId={f.id} />, { shadow });
    await within(await s.q.findByRole('region', { name: 'Case against Alpha' })).findByRole('button', { name: /^No action needed/ });
    mine.focus();
    await s.user.keyboard('2');
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('a modal window anywhere in the same shadow root holds the keys', async () => {
    const { w, s, region } = await card();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    s.shadow.append(dialog);
    within(region).getByRole('button', { name: /^No action needed/ }).focus();
    await s.user.keyboard('2');
    pageHides();
    expect(decides(w)).toHaveLength(0);
    dialog.remove();
  });
});

describe('CaseWorkbench in a shadow root', () => {
  it('1 chooses a verdict in the decision bar, and a problem in the list moves focus to its field', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK, target: 'Alpha' });
    const s = piecesInShadow(w, <CaseWorkbench reportId={f.id} />);
    const decision = await s.q.findByRole('region', { name: 'Decision' });
    const fair = await within(decision).findByRole('radio', { name: 'Fair' });
    // (A radio is a field: a digit pressed on it is its own. Focus is on a button of the bar.)
    within(decision).getByRole('button', { name: 'Decide' }).focus();
    await s.user.keyboard('1');
    expect(fair).toBeChecked();
    await s.user.click(within(decision).getByRole('button', { name: 'Decide' }));
    const summary = await within(decision).findByRole('alert');
    const first = within(summary).getAllByRole('button')[0] as HTMLElement;
    await s.user.click(first);
    expect(decision.contains(focusedIn(s.shadow))).toBe(true);
    expect(focusedIn(s.shadow)).not.toBe(first);
  });
});

describe('two pieces in two shadow roots', () => {
  it('a key in one card reaches only that card', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'R1', room: 'ra' });
    const b = await w.fileRich({ lines: TALK, target: 'Bravo', reporter: 'R2', room: 'rb' });
    const one = piecesInShadow(w, <CaseCard reportId={a.id} />);
    const two = piecesInShadow(w, <CaseCard reportId={b.id} />);
    const regionA = await one.q.findByRole('region', { name: 'Case against Alpha' });
    const regionB = await two.q.findByRole('region', { name: 'Case against Bravo' });
    await within(regionA).findByRole('button', { name: /^No action needed/ });
    await within(regionB).findByRole('button', { name: /^No action needed/ });
    within(regionB).getByRole('button', { name: /^No action needed/ }).focus();
    await two.user.keyboard('2');
    pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.path).toBe(`/reports/${b.id}/decide`);
  });
});

describe('the list and the record in a shadow root', () => {
  it('CaseList rows open by Enter and PersonRecord draws, with no violations', async () => {
    const w = await hubWorld({ role: 'owner' });
    const f = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const s = piecesInShadow(
      w,
      <>
        <CaseList onOpenCase={onOpenCase} />
        <PersonRecord person={f.person} />
      </>,
    );
    await s.q.findByText('Alpha');
    (s.container.querySelector('.cw-case-link') as HTMLElement).focus();
    await s.user.keyboard('{Enter}');
    await waitFor(() => expect(onOpenCase).toHaveBeenCalled());
    await s.q.findByRole('region', { name: 'Timeline' });
    const result = await axe.run(s.container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`)).toEqual([]);
  });
});
