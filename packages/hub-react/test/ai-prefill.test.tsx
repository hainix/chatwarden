import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { AI_MAX_PREFILL_MS } from '@chatwarden/core';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetHiddenAi } from '../src/case/CaseContext.js';
import { aiBar, aiCase, aiWorld, decision, noAiBar, open, openPlain, reads, rewrite, settle, strip } from './aiHub.js';
import { aiLoaders, resetAiOffer } from '../src/ai/load.js';
import { resetQuickKeysVisit } from '../src/quickKeys.js';

// Level 2: the decision bar opens pre-filled from the AI's recommendation, labelled, and never fills a ban, an area ban or more than 24
// hours, whatever the wire says. On the real routes, with the scripted fake behind them.

afterEach(() => {
  forgetHiddenAi();
  resetQuickKeysVisit();
  cleanup();
});

const HOUR = 3_600_000;
const verdict = (name: 'Fair' | 'Not a problem' | 'Bad faith'): HTMLInputElement => within(decision()).getByRole('radio', { name }) as HTMLInputElement;
const reason = (): HTMLTextAreaElement => within(decision()).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement;
const ruleSelect = (): HTMLSelectElement => within(decision()).getByLabelText('Community Rule') as HTMLSelectElement;
/** What the Actions part of the bar says and the reason it opens with: the ladder's pre-fill, to compare other pre-fills with. */
const prefillOf = (): { actions: string; reason: string; verdict: boolean } => ({
  actions: (decision().querySelector('.cw-actions') as HTMLElement).textContent ?? '',
  reason: reason().value,
  verdict: verdict('Fair').checked || verdict('Not a problem').checked || verdict('Bad faith').checked,
});
const picked = (): string[] => [...document.querySelectorAll<HTMLInputElement>('.cw-lines input[type="checkbox"]')].filter((b) => b.checked).map((b) => b.closest('.cw-line')?.querySelector('.cw-line-text')?.textContent ?? '');

describe('level 1 and the cases where the AI has nothing to fill', () => {
  it('level 1 never pre-fills from the AI', async () => {
    // The ladder's pre-fill is what the bar opens with when the AI is off ...
    await aiCase({ level: 0 });
    const ladder = prefillOf();
    expect(ladder.verdict).toBe(false);
    cleanup();
    // ... and level 1 opens with exactly that: a read to look at, never a form to start from.
    await aiCase({ level: 1 });
    await strip();
    expect(noAiBar()).toBeNull();
    expect(screen.queryByText('Suggested by AI')).toBeNull();
    expect(screen.queryByRole('button', { name: /Accept AI/ })).toBeNull();
    expect(prefillOf()).toEqual(ladder);
  });

  it('level 2 with no recommendation falls back to the ladder pre-fill with a quiet hint', async () => {
    await aiCase({
      level: 2,
      script: reads({ recommendation: { verdict: 'unclear', severity: 'rude', rule: 1, evidence: [] } }),
    });
    const bar = await aiBar();
    expect(within(bar).getByText('The AI was not sure, so this is the usual starting point.')).toBeInTheDocument();
    expect(within(bar).queryByText('Suggested by AI')).toBeNull();
    expect(within(bar).queryByRole('button', { name: /Accept/ })).toBeNull();
    // The bar is the ladder's pre-fill exactly as today.
    const unsure = prefillOf();
    cleanup();
    await aiCase({ level: 0 });
    expect(unsure).toEqual(prefillOf());
    expect(reason().value).toBe('');
  });

  it('a recommendation with no line by the reported person is not pre-filled', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    rewrite(w, f.id, (b) => {
      (b.ai.recommendation as { evidenceLineIds: string[] }).evidenceLineIds = ['1']; // the reporter's line
    });
    await open(w, f.id);
    const bar = await aiBar();
    expect(within(bar).getByText(/The AI was not sure/)).toBeInTheDocument();
    expect(verdict('Fair').checked).toBe(false);
  });

  it('a recommendation under a rule that is no longer active is not pre-filled', async () => {
    const { w, f } = await aiWorld({ level: 2, world: { retire: [3] } });
    rewrite(w, f.id, (b) => {
      (b.ai.recommendation as { rule: unknown }).rule = 3;
    });
    await open(w, f.id);
    expect(await aiBar()).toBeInTheDocument();
    expect(verdict('Fair').checked).toBe(false);
  });

  it('the AI hidden on a case gives the ladder\'s pre-fill and no header', async () => {
    const { w, f, user } = await aiCase({ level: 2 });
    await aiBar();
    await user.click(within(await strip()).getByRole('button', { name: 'AI details' }));
    await user.click(screen.getByRole('button', { name: 'Hide the AI on this case' }));
    expect(noAiBar()).toBeNull();
    cleanup();
    await open(w, f.id);
    await settle(60);
    expect(noAiBar()).toBeNull();
    expect(verdict('Fair').checked).toBe(false);
  });
});

describe('what a recommendation fills', () => {
  it('pre-fill: verdict, rule, the reported person\'s cited lines and the step', async () => {
    await aiCase({ level: 2 });
    const bar = await aiBar();
    expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
    expect(within(bar).getByText('AI')).toBeInTheDocument();
    expect(verdict('Fair').checked).toBe(true);
    // The step (a warning for a rude first offence), under the rule the AI cited, with the rule's title as the reason.
    expect(within(decision()).getByText('Warning')).toBeInTheDocument();
    expect(ruleSelect().value).toBe('2');
    expect(reason().value).not.toBe('');
    // The cited line is the one shown to the player, and no other.
    expect(picked()).toEqual(['you are trash']);
    expect(within(decision()).getByText('1 line is shown to Mallory.')).toBeInTheDocument();
  });

  it('a pre-fill from a recommendation of no action is Not a problem with no step and no reason to type', async () => {
    await aiCase({
      level: 2,
      script: reads({ severity: 'banter', rule: null, evidence: [], recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] } }),
    });
    const bar = await aiBar();
    expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
    expect(verdict('Not a problem').checked).toBe(true);
    expect(reason().value).toBe('');
    expect(within(decision()).queryByText('Warning')).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Accept AI suggestion: no action needed' })).toBeInTheDocument();
  });

  it('a note recommendation fills a note with no lines', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    rewrite(w, f.id, (b) => {
      const r = b.ai.recommendation as { verdict: string; step: unknown };
      r.verdict = 'noted';
      r.step = { kind: 'note', durationMs: null, label: 'Note' };
    });
    await open(w, f.id);
    await aiBar();
    expect(verdict('Fair').checked).toBe(true);
    expect(within(decision()).getByText('Note')).toBeInTheDocument();
    expect(picked()).toEqual([]);
  });

  it('a warning, a note and a 24 hour chat restriction are pre-filled', async () => {
    const cases: Array<[string, { kind: string; durationMs: number | null; label: string }, RegExp]> = [
      ['warning', { kind: 'warning', durationMs: null, label: 'Warning' }, /^Warning$/],
      ['note', { kind: 'note', durationMs: null, label: 'Note' }, /^Note$/],
      ['24 hours', { kind: 'chat', durationMs: 24 * HOUR, label: 'Chat restriction, 24 hours' }, /^Chat restriction, 24 hours$/],
      ['1 hour', { kind: 'chat', durationMs: HOUR, label: 'Chat restriction, 1 hour' }, /^Chat restriction, 1 hour$/],
    ];
    for (const [name, step, label] of cases) {
      cleanup();
      const { w, f } = await aiWorld({ level: 2 });
      rewrite(w, f.id, (b) => {
        (b.ai.recommendation as { step: unknown }).step = step;
      });
      await open(w, f.id);
      await aiBar();
      expect(verdict('Fair').checked, name).toBe(true);
      expect(within(decision()).getByText(label), name).toBeInTheDocument();
    }
  });

  it('the real ladder\'s 24 hour restriction for a hostile first offence is pre-filled', async () => {
    await aiCase({ level: 2, script: reads({ severity: 'hostile', rule: 2 }) });
    await aiBar();
    expect(verdict('Fair').checked).toBe(true);
    expect(within(decision()).getByText('Chat restriction, 24 hours')).toBeInTheDocument();
  });

  it('the label is also the header of the bar in Detailed only: the Simple card has its own button', async () => {
    await aiCase({ level: 2, mode: 'simple' });
    await strip();
    expect(noAiBar()).toBeNull();
  });
});

describe('the ceilings hold in the hub, whatever the wire says', () => {
  const step = (kind: string, durationMs: number | null, label: string) => ({ kind, durationMs, label });

  it('a 7 day ban or an area ban is not pre-filled and shows Add suggested step', async () => {
    for (const bad of [step('ban', 7 * 24 * HOUR, 'Ban, 7 days'), step('area', 24 * HOUR, 'Area restriction, 24 hours'), step('ban', null, 'Ban, permanent')]) {
      cleanup();
      const { w, f } = await aiWorld({ level: 2 });
      // The wire says it is within the ceilings. The hub does not believe it.
      rewrite(w, f.id, (b) => {
        const r = b.ai.recommendation as { step: unknown; stepWithinCeiling: boolean };
        r.step = bad;
        r.stepWithinCeiling = true;
      });
      await open(w, f.id);
      const bar = await aiBar();
      expect(verdict('Fair').checked, bad.label).toBe(true);
      // No action of the AI's making is in the form, and the step is offered as the ladder's, to add by hand.
      expect(within(decision()).queryByText(bad.label), bad.label).toBeNull();
      expect(within(decision()).queryByRole('group', { name: /^Action \d+$/ }), bad.label).toBeNull();
      expect(within(decision()).getByRole('button', { name: 'Add suggested step' })).toBeInTheDocument();
      expect(within(bar).queryByRole('button', { name: /^Accept AI/ })).toBeNull();
      expect(within(bar).getByText(/never fills a ban, an area ban or a step over 24 hours/)).toBeInTheDocument();
    }
  });

  it('a 25 hour restriction is not pre-filled', async () => {
    for (const ms of [25 * HOUR, 24 * HOUR + 1, 7 * 24 * HOUR]) {
      cleanup();
      const { w, f } = await aiWorld({ level: 2 });
      rewrite(w, f.id, (b) => {
        const r = b.ai.recommendation as { step: unknown; stepWithinCeiling: boolean };
        r.step = step('chat', ms, 'Chat restriction');
        r.stepWithinCeiling = true;
      });
      await open(w, f.id);
      const bar = await aiBar();
      expect(within(bar).queryByRole('button', { name: /^Accept AI/ }), String(ms)).toBeNull();
      expect(within(decision()).getByRole('button', { name: 'Add suggested step' }), String(ms)).toBeInTheDocument();
    }
  });

  it('a step the wire marks as over the ceilings is not pre-filled even when it looks small', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    rewrite(w, f.id, (b) => {
      (b.ai.recommendation as { stepWithinCeiling: boolean }).stepWithinCeiling = false;
    });
    await open(w, f.id);
    const bar = await aiBar();
    expect(within(bar).queryByRole('button', { name: /^Accept AI/ })).toBeNull();
  });

  it('the real ladder\'s 7 day restriction for severe conduct is not pre-filled', async () => {
    await aiCase({ level: 2, script: reads({ severity: 'severe', rule: 2 }) });
    const bar = await aiBar();
    expect(within(bar).queryByRole('button', { name: /^Accept AI/ })).toBeNull();
    // No action is in the form: the ladder's step is offered, by name, to add ("Add suggested step"), and says it is the ladder's.
    const add = await within(decision()).findByRole('button', { name: 'Add suggested step' });
    expect(decision().querySelector('.cw-suggest')).toHaveAttribute('data-added', 'false');
    expect(within(decision()).getByText('The ladder suggests')).toBeInTheDocument();
    expect(within(decision()).getByText('Chat restriction, 7 days')).toBeInTheDocument();
    expect(within(bar).getByText(/ladder/i)).toBeInTheDocument();
    expect(add).toBeEnabled();
  });

  it('adding the suggested step carries the AI\'s rule and its cited lines, and the label flips to Edited', async () => {
    const { user } = await aiCase({ level: 2, script: reads({ severity: 'severe', rule: 2 }) });
    const bar = await aiBar();
    await user.click(await within(decision()).findByRole('button', { name: 'Add suggested step' }));
    expect(within(bar).getByText('Edited')).toBeInTheDocument();
    expect(ruleSelect().value).toBe('2');
    expect(picked()).toEqual(['you are trash']);
    expect(within(decision()).getByText('Chat restriction, 7 days')).toBeInTheDocument();
  });

  it('the cap is the core constant: 24 hours exactly', () => {
    expect(AI_MAX_PREFILL_MS).toBe(24 * HOUR);
  });
});

describe('the role and the rules', () => {
  it('a role that cannot apply sanctions gets the verdict and the reason, and no action', async () => {
    const { w, f } = await aiWorld({ level: 2, world: { permissions: { 'sanctions.apply': 'owner' } } });
    await open(w, f.id);
    const bar = await aiBar();
    expect(verdict('Fair').checked).toBe(true);
    expect(within(decision()).queryByText('Warning')).toBeNull();
    expect(within(bar).queryByRole('button', { name: /^Accept AI/ })).toBeNull();
    expect(within(bar).getByText('Your role cannot apply this step.')).toBeInTheDocument();
  });

  it('a recommendation of no action needs no right to apply anything: it is pre-filled for any role that decides', async () => {
    const { w, f } = await aiWorld({
      level: 2,
      script: reads({ severity: 'banter', rule: null, evidence: [], recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] } }),
      world: { permissions: { 'sanctions.apply': 'owner' } },
    });
    await open(w, f.id);
    const bar = await aiBar();
    expect(verdict('Not a problem').checked).toBe(true);
    expect(within(bar).getByRole('button', { name: 'Accept AI suggestion: no action needed' })).toBeInTheDocument();
  });

  it('a role that cannot decide at all sees the read and no bar', async () => {
    const { w, f } = await aiWorld({ level: 2, world: { permissions: { 'reports.decide': 'owner' } } });
    await openPlain(w, f.id);
    await strip();
    expect(noAiBar()).toBeNull();
  });
});

describe('the label', () => {
  it('E opens the editor; any edit flips the label to Edited', async () => {
    const { user } = await aiCase({ level: 2 });
    const bar = await aiBar();
    expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Edit' }));
    // The full editor is open (the action's own fields), and nothing has changed yet: it still says whose it is.
    expect(within(decision()).getByRole('group', { name: 'Action 1' })).toBeInTheDocument();
    expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
    await user.type(reason(), ' Also repeated.');
    await waitFor(() => expect(within(bar).getByText('Edited')).toBeInTheDocument());
    expect(within(bar).queryByText('Suggested by AI')).toBeNull();
    // An edited form can no longer be accepted as the AI's.
    expect(within(bar).queryByRole('button', { name: /^Accept AI/ })).toBeNull();
  });

  it('changing the verdict, the rule or a line counts as an edit', async () => {
    const { user } = await aiCase({ level: 2 });
    const bar = await aiBar();
    await user.click(verdict('Not a problem'));
    expect(within(bar).getByText('Edited')).toBeInTheDocument();
  });

  it('changing something and changing it back is still an edit: the label does not flip back', async () => {
    const { user } = await aiCase({ level: 2 });
    const bar = await aiBar();
    await user.click(verdict('Not a problem'));
    await user.click(verdict('Fair'));
    expect(within(bar).getByText('Edited')).toBeInTheDocument();
  });

  it('the AI bar is the only new thing in the bar: nothing else carries the AI tag', async () => {
    await aiCase({ level: 2 });
    await aiBar();
    expect(decision().querySelectorAll('.cw-aitag')).toHaveLength(1);
  });
});

describe('when the code that fills from the AI cannot be fetched', () => {
  it('the bar is the ladder pre-fill and the case is not stuck loading', async () => {
    await aiCase({ level: 0 });
    const ladder = prefillOf();
    cleanup();
    const real = aiLoaders.offer;
    resetAiOffer();
    aiLoaders.offer = () => Promise.reject(new Error('offline'));
    try {
      await aiCase({ level: 2 });
      // The form came, as the ladder's: no verdict, no label, nothing to accept.
      expect(prefillOf()).toEqual(ladder);
      expect(screen.queryByText('Suggested by AI')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Accept AI/ })).toBeNull();
    } finally {
      aiLoaders.offer = real;
      resetAiOffer();
    }
  });
});
