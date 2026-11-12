// The guided tour on the real hub: four steps, each an instruction in the visitor's own words, pointing at hub controls by their
// accessible names (hub-react has no tour-hook option, so the page finds them the way a screen reader would), working by keyboard,
// and telling a phone visitor which tab to open (it never switches panes or scrolls the page by itself).
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_STEPS } from '../src/demo/codeSteps';
import { NO_NOTICE_HINT, NO_REPORT_HINT, TOUR_STEPS } from '../src/demo/script';
import { caseLink, closeReport, composer, gamePane, live, modPane, noticeBtn, oneTapReport, openCase, pickRule, reasonedReport, reportBtn, screen, sendHeldDecision, setup, stepText, stubMatchMedia, tour, waitFor, within } from './helpers/demoUi';

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const next = () => within(tour() as HTMLElement).getByRole('button', { name: /^next$/i });
const target = () => document.querySelector('[data-tour-target]') as HTMLElement | null;
const targetName = () => (target()?.getAttribute('aria-label') ?? target()?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the four steps', () => {
  it('are, in order: report Bo’s message, open the report in the hub, take the suggested action, see what Bo sees', () => {
    expect(TOUR_STEPS.map((s) => s.title)).toEqual([
      "Report Bo's message",
      'Open the report in the hub',
      'Take the suggested action',
      'See what Bo sees',
    ]);
  });
  it('none is optional (the Detailed switch and Steps and ladder steps are cut)', () => {
    expect(TOUR_STEPS.some((s) => 'optional' in s && s.optional === true)).toBe(false);
    expect(JSON.stringify(TOUR_STEPS)).not.toMatch(/Detailed|ladder|1, 6 and 12/);
  });
  it('say what to do, in the proposal’s words', () => {
    expect(TOUR_STEPS.map((s) => s.body)).toEqual([
      'Bo\'s being rude. Press Report next to his highlighted message, choose "Insults or harassment", then press Report.',
      'It just reached your moderator hub, with the chat around it as evidence. Press "1 new case", then open Bo\'s report.',
      "This is the hub's default view: one card per report. It shows what Bo said, his history, and the action your rules suggest. Press the suggested action. You have five seconds to undo.",
      "Bo gets a plain notice: what he did, which rule, and for how long. Press See Bo's screen.",
    ]);
  });
  it('use the hub’s own words and the game pane’s labels (the ring finds controls by their visible names)', () => {
    expect(TOUR_STEPS[1]?.body).toContain('"1 new case"');
    expect(TOUR_STEPS[3]?.body).toContain("See Bo's screen");
    expect(TOUR_STEPS[0]?.body).toContain('Insults or harassment');
  });
  it('avoid the retired words: simple mode, ladder, case-as-jargon, staff routes, "Warn", "category"', () => {
    for (const s of TOUR_STEPS) expect(`${s.title} ${s.body}`, s.title).not.toMatch(/\bWarn\b|timeout button|category|simple mode|ladder|staff routes|report again|add a reason/i);
  });
  it('the hints are the proposal’s', () => {
    expect(NO_NOTICE_HINT).toBe("You chose no action, so Bo isn't told anything. Report another message and take the suggested action to see his notice.");
    expect(NO_REPORT_HINT).toBe('Nothing to handle yet. Report one of Bo\'s messages first.');
  });
  it('the demo hands the dialog no onAddDetail (the dialog has no follow-up step; the prop is deprecated)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(__dirname, '..', 'src', 'demo', 'Demo.tsx'), 'utf8');
    expect(source).not.toMatch(/onAddDetail/);
    expect(source).not.toMatch(/ReportFollowUp/);
  });
});

describe('the tour card', () => {
  it('starts at step 1 of 4 with four pips, Skip tour and Next, and rings the report button of Bo’s rude line', async () => {
    await setup();
    const t = tour() as HTMLElement;
    expect(t.textContent).toMatch(/step 1 of 4/i);
    expect(t.textContent).toContain("Report Bo's message");
    expect(t.querySelectorAll('[data-pip]')).toHaveLength(4);
    expect(within(t).getByRole('button', { name: /^skip tour$/i })).toBeTruthy();
    expect(targetName()).toMatch(/report bo's message: "uninstall/i);
    expect(document.querySelectorAll('[data-tour-target]')).toHaveLength(1);
  });

  it('never takes keyboard focus, and Next, Skip tour and Show the code are reachable by Tab', async () => {
    const { user } = await setup();
    expect(tour()?.contains(document.activeElement)).toBe(false);
    next().focus();
    await user.keyboard('{Enter}');
    expect(stepText()).toMatch(/step 2 of 4/i);
    expect(within(tour() as HTMLElement).getByRole('button', { name: /^show the code$/i })).toBeTruthy();
  });
});

describe('the tour follows the visitor through the hub', () => {
  it('step 1 to 2: filing the report moves on; the hub says "1 new case" and that pill gets the ring, then the link for Bo', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    await closeReport(user);
    await waitFor(() => expect(targetName()).toBe('1 new case'));
    expect(modPane().contains(target())).toBe(true);
    expect(stepText()).toMatch(/1 new case/i);
    await user.click(target() as HTMLElement);
    await waitFor(() => expect(targetName()).toMatch(/^Bo/));
    expect(target()?.tagName).toBe('A');
    // pressing the pill put the report in the list; the step is done when the report is opened
    expect(stepText()).toMatch(/step 2 of 4/i);
  });

  it('step 2: opening the report moves on; with no reason chosen the ring is on "Which rule does this break?" and the card says to pick one', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await openCase(user);
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
    await waitFor(() => expect(target()?.tagName).toBe('SELECT'));
    expect(stepText()).toMatch(/take the suggested action/i);
    expect(stepText()).toContain('Pick the rule this breaks. The hub then suggests an action.');
  });

  it('choosing "Insults or harassment" (step 1’s advice) skips the rule picker: the ring goes straight to the suggested action', async () => {
    const { user } = await setup();
    await reasonedReport(user, undefined, 'harassment');
    await closeReport(user);
    await openCase(user);
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
    await waitFor(() => expect(targetName()).toMatch(/^(Restrict chat|Send a warning|Ban|Add a note)/));
    expect(within(modPane()).queryByRole('combobox', { name: /which rule does this break/i })).toBeNull();
    expect(stepText()).not.toContain('Pick the rule');
  });

  it('step 3: once a rule is picked the ring is on the suggested action; applying it shows Undo, and the sent decision moves on', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await openCase(user);
    await pickRule(user);
    await waitFor(() => expect(targetName()).toMatch(/^Restrict chat, 24 hours/));
    await user.click(target() as HTMLElement);
    await waitFor(() => expect(targetName()).toBe('Undo'));
    expect(stepText()).toMatch(/step 3 of 4/i);
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 4 of 4/i));
  });

  it('step 4: the ring is on "See Bo’s screen"; acknowledging the notice finishes the tour', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    const see = await noticeBtn('Bo');
    await waitFor(() => expect(target()).toBe(see));
    expect(stepText()).toMatch(/see what bo sees/i);
    await user.click(see);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(stepText()).toMatch(/whole loop/i));
    expect(live().textContent).toMatch(/tour done/i);
  });

  it('Next from the last step finishes: "That’s the whole loop", all four pips done, with Add it to your game, Play again and Close', async () => {
    const { user } = await setup();
    for (let i = 0; i < 4; i++) await user.click(next());
    const t = tour() as HTMLElement;
    expect(t.textContent).toMatch(/that's the whole loop/i);
    expect(t.textContent).toContain("A player reported, you decided in one click, and Bo was told why. That's what you add to your game.");
    expect(t.querySelectorAll('[data-pip="done"]')).toHaveLength(4);
    const add = within(t).getByRole('link', { name: /^add it to your game$/i });
    expect(add.getAttribute('href')).toBe('#add-it');
    expect(within(t).getByRole('button', { name: /^play again$/i })).toBeTruthy();
    expect(within(t).getByRole('button', { name: /^close$/i })).toBeTruthy();
    expect(targetName()).toMatch(/start over/i); // nothing left to point at in the hub: the ring rests on Start over
  });

  it('a decision that tells the player nothing sends you back to report another message, with the hint', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^no action needed/i }));
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 1 of 4/i));
    expect(stepText()).toContain(NO_NOTICE_HINT);
  });

  it('after that, the ring goes to another of Bo’s messages (the one reported already is not pointed at again)', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^no action needed/i }));
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 1 of 4/i));
    await waitFor(() => expect(targetName()).toMatch(/report bo's message: "ez, you're trash lol"/i));
  });

  it('with nothing reported yet, a later step says there is nothing to handle', async () => {
    const { user } = await setup();
    await user.click(next());
    expect(stepText()).toContain(NO_REPORT_HINT);
    await user.click(next());
    expect(stepText()).toContain(NO_REPORT_HINT);
  });

  it('doing a later step first jumps ahead (opening a report before the tour asks)', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await openCase(user);
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
  });

  it('Skip hides the tour and its ring; Restart the tour brings it back at step 1', async () => {
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /^skip tour$/i }));
    expect(tour()).toBeNull();
    expect(target()).toBeNull();
    await user.click(screen.getByRole('button', { name: /^restart the tour$/i }));
    expect(stepText()).toMatch(/step 1 of 4/i);
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
    await waitFor(() => expect(live().textContent).toMatch(/step 2 of 4.*open the report in the hub/i));
  });
});

describe('the whole tour by keyboard alone', () => {
  it('can be finished without a pointer', async () => {
    const { user } = await setup();
    // 1. Report: Enter on the button, Enter on Report, Enter on Close.
    reportBtn(/report bo's message: "uninstall/i).focus();
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
    // 2. The queue link, opened with Enter.
    const link = await caseLink(user);
    link.focus();
    await user.keyboard('{Enter}');
    await within(modPane()).findByRole('region', { name: /case against bo/i });
    // 3. Pick the rule with the keyboard, then act on the suggestion with focus in the card.
    const rule = await within(modPane()).findByRole('combobox', { name: /which rule/i });
    rule.focus();
    await user.selectOptions(rule, '2'); // (jsdom does not move a select with the arrow keys; this is the same change)
    await within(modPane()).findByText(/the ladder suggests/i);
    const warn = within(modPane()).getByRole('button', { name: /^send a warning/i });
    warn.focus();
    await user.keyboard('{Enter}');
    await sendHeldDecision();
    // 4. The notice: Enter on the button, Enter on Acknowledge.
    const see = await noticeBtn('Bo');
    see.focus();
    await user.keyboard('{Enter}');
    const ack = within(await screen.findByRole('dialog')).getByRole('button', { name: /acknowledge/i });
    ack.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(stepText()).toMatch(/whole loop/i));
  });
});

describe('on a phone (one pane at a time)', () => {
  it('does not switch panes by itself: the game stays up until the visitor opens the Moderator tab, and the announcement says so', async () => {
    const { user } = await setup({ stacked: true });
    expect(modPane().hidden).toBe(true);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    expect(modPane().hidden).toBe(true);
    expect(gamePane().hidden).toBe(false);
    expect(live().textContent).not.toMatch(/showing the moderator view/i);
    expect(stepText()).toMatch(/open the moderator tab/i);
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    await user.click(within(tabs).getAllByRole('button')[1] as HTMLElement);
    expect(modPane().hidden).toBe(false);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/step 4 of 4/i));
    expect(modPane().hidden).toBe(false); // still where the visitor put it
    expect(stepText()).toMatch(/open the game tab/i);
  });

  it('keeps focus on the opener when the report dialog closes (the game pane is still showing)', async () => {
    const { user } = await setup({ stacked: true });
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(document.activeElement).toBe(reportBtn(/report bo's message: "uninstall/i)));
  });

  it('the pane switch offers the moderator view, with the open-report count', async () => {
    const { user } = await setup({ stacked: true });
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Game', 'Moderator']);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(within(tabs).getAllByRole('button')[1]?.textContent).toMatch(/1/));
  });

  it('pressing Next to a hub step does not show the moderator pane: the card says which tab to open', async () => {
    const { user } = await setup({ stacked: true });
    await user.click(next());
    expect(modPane().hidden).toBe(true);
    expect(stepText()).toMatch(/step 2 of 4/i);
    expect(stepText()).toMatch(/open the moderator tab/i);
  });
});

describe('Show the code', () => {
  it('has a snippet per step, and the drawer follows the tour', async () => {
    expect(CODE_STEPS).toHaveLength(4);
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /^show the code$/i }));
    expect(screen.getByRole('region', { name: /kit code for step 1/i }).textContent).toContain('cw.reports.submit(');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 2/i }).textContent).toContain('<Hub client={client} />');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 3/i }).textContent).toContain('await cw.decide(');
    await user.click(next());
    expect(screen.getByRole('region', { name: /kit code for step 4/i }).textContent).toContain('client.notices()');
  });
});

describe('typing in the game does not disturb the tour', () => {
  it('a chat line keeps step 1 and the ring where they were', async () => {
    const { user } = await setup();
    composer().focus();
    await user.keyboard('hello there{Enter}');
    expect(stepText()).toMatch(/step 1 of 4/i);
    expect(fireEvent).toBeTruthy();
    expect(targetName()).toMatch(/report bo's message/i);
  });
});

describe('on a phone (under 600px) the tour is a compact bar', () => {
  const bar = () => tour() as HTMLElement;
  const toggle = () => within(bar()).getByRole('button', { name: /step \d of 4/i });

  it('is a bar: "Step 1 of 4" and the imperative title, with Next and Skip tour, and the longer text hidden until it is opened', async () => {
    await setup({ compact: true });
    expect(bar().hasAttribute('data-compact')).toBe(true);
    expect(bar().textContent).toMatch(/step 1 of 4/i);
    expect(bar().textContent).toContain("Report Bo's message");
    expect(within(bar()).getByRole('button', { name: /^next$/i })).toBeTruthy();
    expect(within(bar()).getByRole('button', { name: /^skip tour$/i })).toBeTruthy();
    expect(bar().textContent).not.toMatch(/Bo's being rude/); // the body waits for a tap
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('a tap on the step opens the full text (and Show the code); another closes it again', async () => {
    const { user } = await setup({ compact: true });
    await user.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(bar().textContent).toMatch(/Bo's being rude/);
    expect(within(bar()).getByRole('button', { name: /^show the code$/i })).toBeTruthy();
    await user.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(bar().textContent).not.toMatch(/Bo's being rude/);
  });

  it('the control the bar opens points at its text (aria-controls) only while open', async () => {
    const { user } = await setup({ compact: true });
    expect(toggle().hasAttribute('aria-controls')).toBe(false);
    await user.click(toggle());
    const id = toggle().getAttribute('aria-controls') as string;
    expect(document.getElementById(id)?.textContent).toMatch(/Bo's being rude/);
  });

  it('a new step closes it: the bar stays small as the tour moves on', async () => {
    const { user } = await setup({ compact: true });
    await user.click(toggle());
    await user.click(next());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(stepText()).toMatch(/step 2 of 4/i);
  });

  it('is the last thing in the demo’s panes, so it can stick to the bottom of the screen while the demo is in view', async () => {
    const { container } = await setup({ compact: true });
    const demo = container.querySelector('.demo') as HTMLElement;
    expect(bar().compareDocumentPosition(demo.querySelector('.demo-panes') as HTMLElement) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('the finished card is a bar too, with Add it to your game, Play again and Close', async () => {
    const { user } = await setup({ compact: true });
    for (let i = 0; i < 4; i++) await user.click(next());
    expect(bar().hasAttribute('data-compact')).toBe(true);
    expect(within(bar()).getByRole('button', { name: /play again/i })).toBeTruthy();
    expect(within(bar()).getByRole('button', { name: /^close$/i })).toBeTruthy();
    expect(within(bar()).getByRole('link', { name: /add it to your game/i }).getAttribute('href')).toBe('#add-it');
  });

  it('wider than a phone the card is the docked strip: no bar, no toggle, the text shown', async () => {
    await setup({ stacked: true });
    expect(bar().hasAttribute('data-compact')).toBe(false);
    expect(bar().textContent).toMatch(/Bo's being rude/);
    expect(within(bar()).queryByRole('button', { name: /step \d of 4/i })).toBeNull();
  });
});
