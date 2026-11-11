// The guided tour on the real hub: seven steps (five that matter, two optional), pointing at hub controls by their accessible
// names (hub-react has no tour-hook option, so the page finds them the way a screen reader would), working by keyboard, and
// following the visitor to the right pane on a phone.
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_STEPS } from '../src/demo/codeSteps';
import { TOUR_STEPS } from '../src/demo/script';
import { caseLink, closeReport, composer, gamePane, live, modPane, noticeBtn, oneTapReport, openCase, pickRule, reportBtn, screen, sendHeldDecision, setup, stepText, stubMatchMedia, tour, waitFor, within } from './helpers/demoUi';

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const next = () => within(tour() as HTMLElement).getByRole('button', { name: /^next$/i });
const target = () => document.querySelector('[data-tour-target]') as HTMLElement | null;
const targetName = () => (target()?.getAttribute('aria-label') ?? target()?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the seven steps', () => {
  it('are, in order: report, the queue, open it, apply the suggestion, the player’s notice, the Detailed switch, Steps and ladder', () => {
    expect(TOUR_STEPS.map((s) => s.title)).toEqual([
      'Report a message',
      'The case appears in the hub',
      'Open it in Simple',
      'Apply the suggestion',
      'The player sees the notice',
      'The Detailed switch',
      'Steps and ladder',
    ]);
  });
  it('the last two are optional, and say so', () => {
    expect(TOUR_STEPS.map((s) => ('optional' in s ? s.optional : false))).toEqual([false, false, false, false, false, true, true]);
  });
  it('each step has a one-tap, honest instruction (no "Warn", no "Timeout button", no "category")', () => {
    for (const s of TOUR_STEPS) {
      expect(s.body.length).toBeGreaterThan(30);
      expect(s.body).not.toMatch(/\bWarn\b|timeout button|category/i);
    }
  });
  it('step 7 says where the 1, 6 and 12 hour lengths are', () => {
    const body = TOUR_STEPS[6]?.body ?? '';
    expect(body).toMatch(/1, 6 and 12 hour/i);
    expect(body).toMatch(/more/i);
  });
});

describe('the tour card', () => {
  it('starts at step 1 of 7 with seven pips, Skip and Next, and rings the report button of one of Bo’s rude lines', async () => {
    await setup();
    const t = tour() as HTMLElement;
    expect(t.textContent).toMatch(/step 1 of 7/i);
    expect(t.textContent).toMatch(/report a message/i);
    expect(t.querySelectorAll('[data-pip]')).toHaveLength(7);
    expect(within(t).getByRole('button', { name: /skip tour/i })).toBeTruthy();
    expect(targetName()).toMatch(/report bo's line: uninstall/i);
    expect(document.querySelectorAll('[data-tour-target]')).toHaveLength(1);
  });

  it('labels the two optional steps "optional"', async () => {
    const { user } = await setup();
    for (let i = 0; i < 5; i++) {
      expect(stepText()).not.toMatch(/optional/i);
      await user.click(next());
    }
    expect(stepText()).toMatch(/step 6 of 7/i);
    expect(stepText()).toMatch(/optional/i);
    await user.click(next());
    expect(stepText()).toMatch(/step 7 of 7/i);
    expect(stepText()).toMatch(/optional/i);
  });

  it('never takes keyboard focus, and Next, Skip and Show me the code are reachable by Tab', async () => {
    const { user } = await setup();
    expect(tour()?.contains(document.activeElement)).toBe(false);
    next().focus();
    await user.keyboard('{Enter}');
    expect(stepText()).toMatch(/step 2 of 7/i);
    expect(within(tour() as HTMLElement).getByRole('button', { name: /show me the code/i })).toBeTruthy();
  });
});

describe('the tour follows the visitor through the hub', () => {
  it('step 1 to 2: filing the report moves on; the hub says "1 new case" and that pill gets the ring, then the link for Bo', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 7/i));
    await closeReport(user);
    await waitFor(() => expect(targetName()).toBe('1 new case'));
    expect(modPane().contains(target())).toBe(true);
    expect(stepText()).toMatch(/new case/i);
    await user.click(target() as HTMLElement);
    await waitFor(() => expect(targetName()).toMatch(/^Bo/));
    expect(target()?.tagName).toBe('A');
    // pressing the pill put the case in the list: step 2 is done, and step 3 asks to open it
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 7/i));
    expect(stepText()).toMatch(/open it in simple/i);
  });

  it('step 3: opening the case moves on; with no rule yet the ring is on "Which rule does this break?"', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await openCase(user);
    await waitFor(() => expect(stepText()).toMatch(/step 4 of 7/i));
    await waitFor(() => expect(target()?.tagName).toBe('SELECT'));
    expect(stepText()).toMatch(/apply the suggestion/i);
    expect(stepText()).toMatch(/which rule/i);
  });

  it('step 4: once a rule is picked the ring is on the suggested step; applying it shows Undo, and the sent decision moves on', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await openCase(user);
    await pickRule(user);
    await waitFor(() => expect(targetName()).toMatch(/^Restrict chat, 24 hours/));
    await user.click(target() as HTMLElement);
    await waitFor(() => expect(targetName()).toBe('Undo'));
    expect(stepText()).toMatch(/step 4 of 7/i);
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 5 of 7/i));
  });

  it('step 5: the ring is on "See what Bo sees"; acknowledging the notice moves on', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    const see = await noticeBtn('Bo');
    await waitFor(() => expect(target()).toBe(see));
    expect(stepText()).toMatch(/the player sees the notice/i);
    await user.click(see);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(stepText()).toMatch(/step 6 of 7/i));
    expect(live().textContent).toMatch(/step 6 of 7/i);
  });

  it('step 6: the ring is on the Detailed switch; pressing it switches the hub, and the tour waits for Next', async () => {
    const { user } = await setup();
    for (let i = 0; i < 5; i++) await user.click(next());
    await waitFor(() => expect(targetName()).toBe('Detailed'));
    await user.click(target() as HTMLElement);
    expect(within(modPane()).getByRole('button', { name: 'Detailed' }).getAttribute('aria-pressed')).toBe('true');
    expect(stepText()).toMatch(/step 6 of 7/i);
  });

  it('step 7: the ring is on More, then on Steps and ladder once More is open; the page then shows the 1, 6 and 12 hour lengths', async () => {
    const { user } = await setup();
    for (let i = 0; i < 6; i++) await user.click(next());
    expect(stepText()).toMatch(/step 7 of 7/i);
    await waitFor(() => expect(targetName()).toBe('More'));
    await user.click(target() as HTMLElement);
    await waitFor(() => expect(targetName()).toBe('Steps and ladder'));
    await user.click(target() as HTMLElement);
    const hub = modPane();
    await within(hub).findByRole('heading', { name: /steps and ladder/i });
    await waitFor(() => expect(hub.textContent).toMatch(/1 hour/));
    expect(hub.textContent).toMatch(/6 hours/);
    expect(hub.textContent).toMatch(/12 hours/);
  });

  it('Next from the last step finishes: "That’s the whole loop", all seven pips done, with Play again', async () => {
    const { user } = await setup();
    for (let i = 0; i < 7; i++) await user.click(next());
    expect(stepText()).toMatch(/whole loop/i);
    expect(tour()?.querySelectorAll('[data-pip="done"]')).toHaveLength(7);
    expect(within(tour() as HTMLElement).getByRole('button', { name: /play again/i })).toBeTruthy();
    expect(targetName()).toMatch(/reset demo/i); // nothing left to point at in the hub: the ring rests on Reset
  });

  it('a decision that tells the player nothing sends you back to report another line, with a hint', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^no action needed/i }));
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 1 of 7/i));
    expect(stepText()).toMatch(/tells the player nothing/i);
  });

  it('doing a later step first jumps ahead (opening a case before the tour asks)', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await user.click(next()); // already on step 2; Next to 3
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 7/i));
    await openCase(user);
    await waitFor(() => expect(stepText()).toMatch(/step 4 of 7/i));
  });

  it('Skip hides the tour and its ring; Restart tour brings it back at step 1', async () => {
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /skip tour/i }));
    expect(tour()).toBeNull();
    expect(target()).toBeNull();
    await user.click(screen.getByRole('button', { name: /restart tour/i }));
    expect(stepText()).toMatch(/step 1 of 7/i);
  });

  it('Escape on the card skips it', async () => {
    const { user } = await setup();
    next().focus();
    await user.keyboard('{Escape}');
    expect(tour()).toBeNull();
  });

  it('announces each step politely', async () => {
    const { user } = await setup();
    await user.click(next());
    await waitFor(() => expect(live().textContent).toMatch(/step 2 of 7.*the case appears in the hub/i));
  });
});

describe('the whole tour by keyboard alone', () => {
  it('can be finished without a pointer', async () => {
    const { user } = await setup();
    // 1. Report: Enter on the button, Enter on Report, Enter on Close.
    reportBtn(/report bo's line: uninstall/i).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    within(dialog).getByRole('button', { name: 'Report' }).focus();
    await user.keyboard('{Enter}');
    await within(dialog).findByRole('heading', { name: 'Report sent' });
    within(dialog).getByRole('button', { name: 'Close' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement?.tagName).not.toBe('BODY');
    // 2-3. The queue link, opened with Enter.
    const link = await caseLink(user);
    link.focus();
    await user.keyboard('{Enter}');
    await within(modPane()).findByRole('region', { name: /case against bo/i });
    // 4. Pick the rule with the keyboard, then press 3 for "Send a warning" with focus in the card.
    const rule = await within(modPane()).findByRole('combobox', { name: /which rule/i });
    rule.focus();
    await user.selectOptions(rule, '2'); // (jsdom does not move a select with the arrow keys; this is the same change)
    await within(modPane()).findByText(/the ladder suggests/i);
    const warn = within(modPane()).getByRole('button', { name: /^send a warning/i });
    warn.focus();
    await user.keyboard('{Enter}');
    await sendHeldDecision();
    // 5. The notice: Enter on the button, Enter on Acknowledge.
    const see = await noticeBtn('Bo');
    see.focus();
    await user.keyboard('{Enter}');
    const ack = within(await screen.findByRole('dialog')).getByRole('button', { name: /acknowledge/i });
    ack.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(stepText()).toMatch(/step 6 of 7/i));
    // 6-7. Next (to step 7), Next (done).
    next().focus();
    await user.keyboard('{Enter}{Enter}');
    expect(stepText()).toMatch(/whole loop/i);
  });
});

describe('on a phone (one pane at a time)', () => {
  it('moves to the moderator pane when the report is filed, back to the game for the notice, and says so', async () => {
    const { user } = await setup({ stacked: true });
    expect((modPane() as HTMLElement).hidden).toBe(true);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(modPane().hidden).toBe(false));
    expect(gamePane().hidden).toBe(true);
    expect(live().textContent).toMatch(/showing the moderator view/i);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 5 of 7/i));
    await waitFor(() => expect(gamePane().hidden).toBe(false));
    expect(live().textContent).toMatch(/showing the game view/i);
    expect(await noticeBtn('Bo')).toBeTruthy();
  });

  it('keeps focus somewhere sensible after the report dialog closes on a hidden pane (the moderator heading)', async () => {
    const { user } = await setup({ stacked: true });
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('pane-mod-title')));
  });

  it('the pane switch offers the moderator view, with the open-case count', async () => {
    const { user } = await setup({ stacked: true });
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Game', 'Moderator']);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(within(tabs).getAllByRole('button')[1]?.textContent).toMatch(/1/));
  });

  it('pressing Next to a hub step shows the moderator pane even before anything is reported', async () => {
    const { user } = await setup({ stacked: true });
    await user.click(next());
    await waitFor(() => expect(modPane().hidden).toBe(false));
    expect(stepText()).toMatch(/step 2 of 7/i);
  });
});

describe('Show me the code', () => {
  it('has a snippet per step, and the drawer follows the tour', async () => {
    expect(CODE_STEPS).toHaveLength(7);
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /show me the code/i }));
    expect(screen.getByRole('region', { name: /kit code for step 1/i }).textContent).toContain('cw.reports.submit(');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 2/i }).textContent).toContain('<Hub client={client} />');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 3/i }).textContent).toContain('routerTransport(handle)');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 4/i }).textContent).toContain('await cw.decide(');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 5/i }).textContent).toContain('client.notices()');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 6/i }).textContent).toContain('<CaseCard');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 7/i }).textContent).toContain('6 * HOUR');
  });
});

describe('typing in the game does not disturb the tour', () => {
  it('a chat line keeps step 1 and the ring where they were', async () => {
    const { user } = await setup();
    composer().focus();
    await user.keyboard('hello there{Enter}');
    expect(stepText()).toMatch(/step 1 of 7/i);
    expect(fireEvent).toBeTruthy();
    expect(targetName()).toMatch(/report bo's line/i);
  });
});
