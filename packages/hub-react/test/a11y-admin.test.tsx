import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Terms, Blocked, Rule gaps, Audit and the Guide under axe, in both themes, in each state a moderator meets: the list, a form with
// its messages, the dry-run confirm, words shown and hidden, empty and failed. jsdom paints no colours, so `color-contrast` is off
// here; the stylesheet's contrast is computed from its tokens by the static tests.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

async function busy(role: 'moderator' | 'senior' | 'owner' = 'owner'): Promise<HubWorld> {
  const w = await hubWorld({ role, actor: 'ann@example.test' });
  const a = await w.file({ target: 'Vantablob' });
  await w.sanction(a.person, 'warning', 'uncovered');
  const b = await w.file({ target: 'Kestrel' });
  const two = await w.sanction(b.person, 'chat', 'uncovered');
  await w.clientFor('bea@example.test', 'owner').closeGap(two.groupId, { status: 'ruled', ref: 2 });
  w.blockLine('Vantablob', 'you zorbak, learn to rotate');
  w.blockLine('Kestrel', 'fenrisk team');
  await w.direct.addTerm({ term: 'zorbako', language: 'es' });
  await w.direct.updateTerm('syn:snerp', { note: 'a made-up pest' });
  for (let i = 0; i < 3; i += 1) await w.clientFor('bea@example.test', 'senior').personHistory(a.person);
  return w;
}

describe.each(['light', 'dark'] as const)('axe on the admin screens, %s theme', (theme) => {
  async function open(w: HubWorld, path: string, ready: string | RegExp) {
    const r = renderHub(w, { theme, path });
    await screen.findByRole('region', { name: ready });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    return r;
  }

  describe('Terms', () => {
    it('the list, words hidden and then shown, has no violations', async () => {
      const w = await busy();
      const { container, user } = await open(w, '/terms', /^English/);
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('checkbox', { name: 'Show words' }));
      expect(await violations(container)).toEqual([]);
    });

    it('the add form with its messages, then the dry-run confirm, has no violations', async () => {
      const w = await busy();
      const { container, user } = await open(w, '/terms', /^English/);
      await user.click(screen.getByRole('button', { name: 'Add a term' }));
      await user.click(screen.getByRole('button', { name: 'Add term' }));
      expect(screen.getByText('Enter a word.')).toBeInTheDocument();
      expect(await violations(container)).toEqual([]);
      await user.type(screen.getByLabelText('Word'), 'zorba');
      await user.click(screen.getByRole('button', { name: 'Add term' }));
      await screen.findByRole('button', { name: 'Save anyway' });
      expect(await violations(container)).toEqual([]);
    });

    it('an edit form, a refusal, and a tester verdict have no violations', async () => {
      const w = await busy();
      const { container, user } = await open(w, '/terms', /^English/);
      await user.click(screen.getByRole('button', { name: 'Edit term 2' }));
      // The word is hidden in the form until shown: that state first, then the shown one.
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Show the word in this form' }));
      await user.clear(screen.getByLabelText('Word'));
      await user.type(screen.getByLabelText('Word'), 'zorbak');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await screen.findByText(/The list refused this word/);
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.type(screen.getByLabelText('Message to test'), 'you zorbak');
      await user.click(within(screen.getByRole('region', { name: 'Test a message' })).getByRole('button', { name: 'Test' }));
      await screen.findByText('This message would be blocked.');
      expect(await violations(container)).toEqual([]);
    });

    it('a term turned back on with hits on the row, hidden and then shown, has no violations', async () => {
      const w = await busy();
      const { id } = await w.direct.addTerm({ term: 'zorba', language: 'en' });
      await w.direct.setTermActive(id, false);
      const { container, user } = await open(w, '/terms', /^English/);
      await user.click(screen.getByRole('checkbox', { name: 'Active: term 8' }));
      await screen.findByRole('group', { name: 'Lines it would block' });
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Show the lines' }));
      expect(await violations(container)).toEqual([]);
    });

    it('the prefilled exception form from a blocked line, masked and shown, has no violations', async () => {
      const w = await busy();
      const { container, user } = await open(w, '/blocked', 'Blocked lines');
      await user.click(screen.getAllByRole('button', { name: /^Add an exception for the line from/ })[0]!);
      await screen.findByRole('form', { name: 'Add an exception' });
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Show the phrase in this form' }));
      expect(await violations(container)).toEqual([]);
    });

    it('a role that may only read, and a server with no term routes, have no violations', async () => {
      const w = await hubWorld({ permissions: { 'terms.write': 'owner' } });
      const { container, unmount } = await open(w, '/terms', /^English/);
      expect(await violations(container)).toEqual([]);
      unmount();
      const none = await hubWorld({ terms: false });
      const r = renderHub(none, { theme, path: '/terms' });
      await screen.findByText('The terms are not set up on this server.');
      expect(await violations(r.container)).toEqual([]);
    });
  });

  describe('Blocked', () => {
    it('the list, a shown row, the whole screen shown, and an empty window have no violations', async () => {
      const w = await busy();
      const { container, user } = await open(w, '/blocked', 'Blocked lines');
      expect(await violations(container)).toEqual([]);
      await user.click(within(screen.getByRole('region', { name: 'Blocked lines' })).getAllByRole('button', { name: /^Show the blocked line/ })[0]!);
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
      expect(await violations(container)).toEqual([]);
      w.clock.t += 40 * 24 * 60 * 60 * 1000;
      await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
      await screen.findByText('Nothing was blocked in this time.');
      expect(await violations(container)).toEqual([]);
    });

    it('a role that cannot read terms (no term, no actions) has no violations', async () => {
      const w = await hubWorld({ permissions: { 'terms.read': 'owner' } });
      w.blockLine('Vantablob', 'zorbak');
      const { container } = await open(w, '/blocked', 'Blocked lines');
      expect(await violations(container)).toEqual([]);
    });
  });

  describe('Rule gaps', () => {
    it('open and closed gaps, and the close form with its message, have no violations', async () => {
      const w = await busy();
      const { container, user } = await open(w, '/gaps', 'Open');
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getAllByRole('button', { name: /^Close the gap/ })[0]!);
      await waitFor(() => expect((screen.getByLabelText('Close it as') as HTMLSelectElement).options.length).toBeGreaterThan(2));
      await user.click(screen.getByRole('button', { name: 'Close gap' }));
      expect(screen.getByText('Choose how to close it.')).toBeInTheDocument();
      expect(await violations(container)).toEqual([]);
    });

    it('empty, and a moderator\'s read-only view, have no violations', async () => {
      const empty = await hubWorld({ role: 'owner' });
      const { container, unmount } = await open(empty, '/gaps', 'Open');
      expect(await violations(container)).toEqual([]);
      unmount();
      const mod = await busy('moderator');
      const r = await open(mod, '/gaps', 'Open');
      expect(await violations(r.container)).toEqual([]);
    });
  });

  describe('Audit', () => {
    it('a page of entries with Load more, a filtered list and an empty filter have no violations', async () => {
      const w = await busy('senior');
      const f = await w.file({ target: 'Glarn' });
      for (let i = 0; i < 60; i += 1) await w.clientFor('cal@example.test', 'senior').personHistory(f.person);
      const { container, user } = await open(w, '/audit', 'Audit entries');
      expect(await violations(container)).toEqual([]);
      await user.type(screen.getByLabelText('Staff member'), 'cal@example.test');
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'history.view' } });
      await user.click(screen.getByRole('button', { name: 'Filter' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument());
      await screen.findByRole('region', { name: 'Audit entries' });
      expect(await violations(container)).toEqual([]);
      await user.clear(screen.getByLabelText('Staff member'));
      await user.type(screen.getByLabelText('Staff member'), 'nobody@example.test');
      await user.click(screen.getByRole('button', { name: 'Filter' }));
      await screen.findByText('No entries match this filter.');
      expect(await violations(container)).toEqual([]);
    });
  });

  describe('Guide', () => {
    it('the rules, the ladder and the generated guide have no violations', async () => {
      const w = await busy();
      const { container } = await open(w, '/guide', 'The full moderator guide');
      expect(await violations(container)).toEqual([]);
    });

    it('hostile markdown drawn as text has no violations', async () => {
      const w = await hubWorld();
      const real = await w.direct.policy({ format: 'markdown' });
      w.intercept.fn = (req) =>
        req.path === '/policy' ? { status: 200, body: { ...real, documents: { ...real.documents, moderatorGuide: '# T\n\n<script>x</script> [a](javascript:x) [b](https://example.test)\n\n| a |\n| --- |\n| <b>x</b> |' } } } : undefined;
      const { container } = await open(w, '/guide', 'The full moderator guide');
      expect(await violations(container)).toEqual([]);
    });

    it('a failed load has no violations', async () => {
      const w = await hubWorld();
      w.intercept.fn = (req) => (req.path === '/policy' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
      const { container } = renderHub(w, { theme, path: '/guide' });
      await screen.findByRole('alert');
      expect(await violations(container)).toEqual([]);
    });
  });
});
