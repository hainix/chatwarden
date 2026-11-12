import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetHiddenAi } from '../src/case/CaseContext.js';
import { QUICK_KEYS_KEY, resetQuickKeysVisit } from '../src/quickKeys.js';
import { AI_KEYS, SHORTCUT_GROUPS, shortcutFor } from '../src/shortcuts.js';
import { aiBar, aiCase, aiWorld, decides, decision, flushHold, lastDecide, noAiBar, open, reads, rewrite, settle, strip } from './aiHub.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The Simple mode card at level 2: its primary button becomes "Accept AI suggestion" with the step in words; at level 1 it gets the
// one-line read and nothing new. And the keys, the sheet and the bar around the AI, held to the rules every other key follows.

afterEach(() => {
  forgetHiddenAi();
  resetQuickKeysVisit();
  window.localStorage.removeItem(QUICK_KEYS_KEY);
  cleanup();
});

const press = (key: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
};
const card = (): HTMLElement => screen.getByRole('region', { name: /^Case against Mallory/ });
const held = (): HTMLElement | null => screen.queryByText('Decision queued.');

describe('the Simple mode card', () => {
  it('Simple mode: at level 2 the primary button reads Accept AI suggestion with the step in words; at level 1 there is only the one-line read', async () => {
    await aiCase({ level: 2, mode: 'simple', stay: true });
    await strip();
    const accept = await within(card()).findByRole('button', { name: 'Accept AI suggestion: Send a warning' });
    expect(accept).toHaveClass('cw-btn--primary');
    // Next to "No action needed", and the ladder's own step does not repeat it: the AI's is the one primary button.
    expect(within(card()).getByRole('button', { name: 'No action needed' })).toBeInTheDocument();
    const primaries = [...card().querySelectorAll('.cw-scard-actions .cw-btn--primary')];
    expect(primaries).toEqual([accept]);
    cleanup();

    await aiCase({ level: 1, mode: 'simple', stay: true });
    await strip();
    expect(within(card()).queryByRole('button', { name: /Accept AI/ })).toBeNull();
    expect(card().querySelectorAll('.cw-scard-actions .cw-btn--primary')).toHaveLength(1);
    expect(within(card()).getByText('The reported player was rude in chat.')).toBeInTheDocument();
  });

  it('the card says what the AI suggests, not what the ladder suggests, above the buttons', async () => {
    await aiCase({ level: 2, mode: 'simple', stay: true, script: reads({ severity: 'hostile', rule: 2 }) });
    await within(card()).findByRole('button', { name: 'Accept AI suggestion: Restrict chat, 24 hours' });
    expect(within(card()).getAllByText('Chat restriction, 24 hours').length).toBeGreaterThan(0);
  });

  it('clicking it sends what the AI suggested through the Undo hold, with the echo', async () => {
    const { w, f } = await aiCase({ level: 2, mode: 'simple', stay: true });
    const read = (await w.client.getReport(f.id)).ai!;
    fireEvent.click(await within(card()).findByRole('button', { name: /^Accept AI suggestion/ }), { detail: 1 });
    await waitFor(() => expect(held()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    const body = lastDecide(w) as { verdict: string; actions: Array<Record<string, unknown>>; ai: unknown };
    expect(body.verdict).toBe('upheld');
    expect(body.actions[0]).toMatchObject({ kind: 'warning', rule: 2 });
    expect(body.ai).toEqual({ readId: read.id, accepted: true, severity: 'rude' });
  });

  it('the keys: A and 1 accept the AI\'s suggestion, 2 is nothing wrong here, and the echo says which', async () => {
    const outcomes: Array<[string, boolean]> = [];
    for (const key of ['a', 'A', '1', '2']) {
      cleanup();
      const { w, f } = await aiCase({ level: 2, mode: 'simple', stay: true });
      const read = (await w.client.getReport(f.id)).ai!;
      await within(card()).findByRole('button', { name: /^Accept AI suggestion/ });
      press(key);
      await waitFor(() => expect(held()).not.toBeNull());
      await flushHold();
      await waitFor(() => expect(decides(w)).toHaveLength(1));
      const ai = (lastDecide(w) as { ai: { readId: string; accepted: boolean } }).ai;
      expect(ai.readId, key).toBe(read.id);
      outcomes.push([key, ai.accepted]);
    }
    expect(outcomes).toEqual([['a', true], ['A', true], ['1', true], ['2', false]]);
  });

  it('with the ladder only (no AI) the card is as it was: the ladder\'s own primary on key 1', async () => {
    const { w } = await aiCase({ level: 0, mode: 'simple', stay: true });
    await within(card()).findByRole('button', { name: 'No action needed' });
    press('1');
    await waitFor(() => expect(held()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(Object.keys(lastDecide(w) as object)).not.toContain('ai');
  });

  it('over the ceilings, the card offers the ladder\'s step as the ladder\'s and says the AI does not fill it', async () => {
    await aiCase({ level: 2, mode: 'simple', stay: true, script: reads({ severity: 'severe', rule: 2 }) });
    await strip();
    await within(card()).findByText(/never fills a ban, an area ban or a step over 24 hours/);
    // The ladder's own one-click is still the primary button, as before; the AI's suggestion is not on offer.
    expect(within(card()).queryByRole('button', { name: /Accept AI/ })).toBeNull();
    expect(card().querySelectorAll('.cw-scard-actions .cw-btn--primary')).toHaveLength(1);
    expect(within(card()).getByText(/never fills a ban, an area ban or a step over 24 hours/)).toBeInTheDocument();
    press('a');
    await settle(40);
    expect(held()).toBeNull();
  });

  it('a stale read, a case held by someone else: the ladder\'s buttons as before and the reason in text', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    rewrite(w, f.id, (b) => {
      b.ai.stale = true;
    });
    await open(w, f.id, { mode: 'simple', stay: true });
    await strip();
    expect(within(card()).queryByRole('button', { name: /Accept AI/ })).toBeNull();
    expect(within(card()).getByText('This read is out of date. A new one is on its way.')).toBeInTheDocument();
    expect(card().querySelectorAll('.cw-scard-actions .cw-btn--primary')).toHaveLength(1);
  });

  it('a recommendation of no action: Accept AI suggestion says so, and sends the dismissal as accepted', async () => {
    const { w, f } = await aiCase({
      level: 2,
      mode: 'simple',
      stay: true,
      script: reads({ severity: 'banter', rule: null, evidence: [], recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] } }),
    });
    const read = (await w.client.getReport(f.id)).ai!;
    fireEvent.click(await within(card()).findByRole('button', { name: 'Accept AI suggestion: no action needed' }), { detail: 1 });
    await waitFor(() => expect(held()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(lastDecide(w)).toEqual({ verdict: 'no_action', actions: [], ai: { readId: read.id, accepted: true, severity: 'banter' } });
  });

  it('Something else opens the editor with the AI\'s suggestion in it, labelled; Edit is the same door', async () => {
    const { user } = await aiCase({ level: 2, mode: 'simple', stay: true });
    await user.click(await within(card()).findByRole('button', { name: 'Something else…' }));
    const bar = await aiBar();
    expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
  });

  it('E is Something else on the card', async () => {
    await aiCase({ level: 2, mode: 'simple', stay: true });
    await within(card()).findByRole('button', { name: /^Accept AI suggestion/ });
    press('e');
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Back to the suggestion' })).toBeInTheDocument());
  });
});

describe('the shortcut sheet', () => {
  const sheet = async (user: ReturnType<typeof renderHub>['user']) => {
    await user.keyboard('?');
    return screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
  };

  it('the shortcut sheet lists A and E only when the level is 2', async () => {
    for (const [level, shown] of [[0, false], [1, false], [2, true]] as const) {
      cleanup();
      const { user } = await aiCase({ level, mode: 'detailed', stay: true });
      const dialog = await sheet(user);
      // The rows are in; let the policy the sheet reads come.
      await settle(60);
      expect(within(dialog).queryByText('Accept the AI suggestion') !== null, `level ${level}`).toBe(shown);
      expect(within(dialog).queryByText('Edit the AI suggestion') !== null, `level ${level}`).toBe(shown);
    }
  });

  it('the rows are Quick keys rows: the sheet says so while Quick keys are off', async () => {
    const { user } = await aiCase({ level: 2, mode: 'detailed', stay: true });
    const dialog = await sheet(user);
    const row = (await within(dialog).findByText('Accept the AI suggestion')).closest('.cw-sheet-row') as HTMLElement;
    expect(row.querySelector('kbd')?.textContent).toBe('A');
    expect(row.textContent).toMatch(/quick keys/i);
  });

  it('check for a key collision with every other shortcut', () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null };
    const keys = (names: string[]) => names.map((key) => ({ key, mod: shortcutFor({ ...base, key }) }));
    // Every key the hub's one listener answers, by what it does.
    const hub = keys(['j', 'J', 'k', 'K', 'n', 'N', 'u', 'U', '?', 'Escape']).filter((k) => k.mod !== null);
    expect(hub).toHaveLength(10);
    const taken = new Set(hub.map((k) => k.key.toLowerCase()));
    // The keys the case answers: the digits and Enter with Ctrl (Quick keys), and now A and E.
    const case_ = ['1', '2', '3', 'Enter', AI_KEYS.accept, AI_KEYS.edit];
    expect(new Set(case_.map((k) => k.toLowerCase())).size).toBe(case_.length);
    for (const key of case_) expect(taken.has(key.toLowerCase()), `${key} is also the hub's`).toBe(false);
    // The hub's listener does not take A or E: they are the case's.
    for (const key of [AI_KEYS.accept, AI_KEYS.edit, AI_KEYS.accept.toUpperCase(), AI_KEYS.edit.toUpperCase()]) expect(shortcutFor({ ...base, key })).toBeNull();
    // And no row of the sheet lists a key twice.
    const rows = SHORTCUT_GROUPS.flatMap((g) => g.rows.map((r) => r.keys.join('+')));
    expect(new Set(rows).size).toBe(rows.length);
    expect(AI_KEYS).toEqual({ accept: 'a', edit: 'e' });
  });
});

describe('the bar around it', () => {
  it('with the AI off, the decision bar is byte-identical to before', async () => {
    const markup = async (o: Parameters<typeof aiCase>[0]) => {
      cleanup();
      const { container } = await aiCase({ stay: true, ...o });
      await settle(60);
      const dock = container.querySelector('.cw-dock') as HTMLElement;
      // Ids come from the order things were drawn in; times and the case's own ids are not what this is about.
      return dock.outerHTML.replace(/_r_[0-9a-z]+_/g, '_id_').replace(/report [\w-]+/g, 'report');
    };
    // A first render brings in the lazy sweep disclosure, so it is in every render that follows.
    await markup({ level: 0 });
    const off = await markup({ level: 0 });
    // The adapter configured but the level 0 (the owner switched it off), and level 1 (a read, no recommendation): the bar is the same.
    const zero = await (async () => {
      cleanup();
      const w = await hubWorld({ actor: 'ann@example.test', ai: { level: 0 } });
      const f = await w.fileRich({});
      const { container } = await open(w, f.id, { stay: true });
      await settle(60);
      return (container.querySelector('.cw-dock') as HTMLElement).outerHTML.replace(/_r_[0-9a-z]+_/g, '_id_').replace(/report [\w-]+/g, 'report');
    })();
    expect(zero).toBe(off);
    const one = await markup({ level: 1 });
    expect(one).toBe(off);
    expect(noAiBar()).toBeNull();
  });
});

describe('axe', () => {
  const RULES = { 'color-contrast': { enabled: false } } as const;
  const violations = async (container: HTMLElement): Promise<string[]> => {
    const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
  };

  it.each(['light', 'dark'] as const)('axe: no violations; the Accept button\'s accessible name includes the step (Detailed, %s)', async (theme) => {
    const { container } = await aiCase({ level: 2, theme, stay: true });
    const bar = await aiBar();
    expect(within(bar).getByRole('button', { name: 'Accept AI suggestion: Send a warning' })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it.each(['light', 'dark'] as const)('and on the Simple card (%s)', async (theme) => {
    const { container } = await aiCase({ level: 2, theme, mode: 'simple', stay: true });
    await within(card()).findByRole('button', { name: /^Accept AI suggestion/ });
    expect(await violations(container)).toEqual([]);
  });

  it('with the reason it cannot be accepted, and the not-sure hint', async () => {
    const { container } = await aiCase({ level: 2, stay: true, script: reads({ severity: 'severe', rule: 2 }) });
    await aiBar();
    expect(await violations(container)).toEqual([]);
    cleanup();
    const unsure = await aiCase({ level: 2, stay: true, script: reads({ recommendation: { verdict: 'unclear', severity: 'rude', rule: 1, evidence: [] } }) });
    await aiBar();
    expect(await violations(unsure.container)).toEqual([]);
  });

  it('the AI bar keeps the decision area in the same order: AI header, verdicts, then the rest', async () => {
    await aiCase({ level: 2, stay: true });
    const bar = await aiBar();
    const verdicts = within(decision()).getByRole('group', { name: 'Your decision' });
    expect(bar.compareDocumentPosition(verdicts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
