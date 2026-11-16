import { cleanup, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_WORD } from './communityWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The Share disclosure and the Community section under axe, in both themes and in each state a moderator meets, and the layout rules for
// 360 px. jsdom paints no colours, so `color-contrast` is off here; the section adds no colour token of its own (the static tests compute
// the stylesheet's contrast from its tokens).
const RULES = { 'color-contrast': { enabled: false } } as const;
afterEach(cleanup);

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on the community list, %s theme', (theme) => {
  async function editOwn() {
    const w = await hubWorld({ community: {} });
    await w.direct.addTerm({ term: OWN_WORD, language: 'en' });
    const r = renderHub(w, { theme, path: '/terms' });
    await screen.findByRole('region', { name: /^English/ });
    await r.user.click(screen.getByRole('checkbox', { name: 'Show words' }));
    await r.user.click(screen.getByRole('button', { name: `Edit ${OWN_WORD}` }));
    await screen.findByRole('button', { name: 'Share with the community list' });
    return { w, ...r };
  }

  it('the editor with the disclosure closed, open, with a slur target, after a send and after a failure have none', async () => {
    const { w, container, user } = await editOwn();
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Share with the community list' }));
    expect(await violations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText('Category'), 'Slur');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Pick who it is aimed at.')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText('Aimed at'), 'Religion');
    w.community!.rig.shareResult = { ok: false, code: 'offline' };
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
    w.community!.rig.shareResult = { ok: true, status: 'received', id: 'sub_abc123' };
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/^Sent\. Status:/);
    expect(await violations(container)).toEqual([]);
  });

  it('the report disclosure on a community term has none: closed, open, after a failure and after a send', async () => {
    const w = await hubWorld({ community: { exposeCommunityRows: true } });
    const { container, user } = renderHub(w, { theme, path: '/terms' });
    await screen.findByRole('region', { name: /^English/ });
    await user.click(screen.getByRole('checkbox', { name: 'Show words' }));
    await user.click(screen.getByRole('button', { name: 'Edit glarn' }));
    await user.click(await screen.findByRole('button', { name: 'Report a problem with this community term' }));
    expect(await violations(container)).toEqual([]);
    w.community!.rig.reportResult = { ok: false, code: 'offline' };
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
    w.community!.rig.reportResult = { ok: true, id: 'rep_abc123' };
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Sent. A reviewer will look at it.');
    expect(await violations(container)).toEqual([]);
  });

  it('the Community section has none: the status, the question before an apply, a failed check, a miss in Find a word', async () => {
    const w = await hubWorld({ role: 'owner', community: { seed: false } });
    const { container, user } = renderHub(w, { theme, path: '/settings/community' });
    await screen.findByText('No community list is in use yet.');
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Apply version 2026.12.0' }));
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    w.community!.rig.onRefresh = () => {
      w.community!.rig.current = { ...w.community!.rig.current, state: 'failed', lastError: { code: 'offline', stage: 'index', at: 1 } };
    };
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
    await user.type(screen.getByLabelText('Word to find'), 'nothingatall');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await screen.findByText('That word is not in your list.');
    expect(await violations(container)).toEqual([]);
  });
});

describe('keyboard', () => {
  it('every control of the section is reachable by Tab in order: Check now, Apply, then the word box', async () => {
    const w = await hubWorld({ role: 'owner', community: { seed: false } });
    const { user } = renderHub(w, { path: '/settings/community' });
    await screen.findByText('No community list is in use yet.');
    screen.getByRole('button', { name: 'Check now' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Apply version 2026.12.0' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Word to find'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Find' }));
  });
});
