// Focus handling, stacked pane switches, honest copy, robustness (double dispatch, reset races, a throwing engine), refusal
// announcements, the disclosure line and the modal dialogs. The moderator side is the real hub and the player side is player-react,
// so what is checked here is how the demo behaves around them.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import { KitEngine } from '../src/demo/kitEngine';
import { closeReport, composer, live, modPane, noticeBtn, oneTapReport, openCase, pickRule, reportBtn, RUDE, sendHeldDecision, setup, stepText, stubMatchMedia, tour } from './helpers/demoUi';

const FRIENDLY = 'Something went wrong in the demo. Press Start over.';
const active = () => document.activeElement as HTMLElement | null;
const next = () => within(tour() as HTMLElement).getByRole('button', { name: /^next$/i });

async function sayBad(user: ReturnType<typeof userEvent.setup>) {
  await user.type(composer(), 'you absolute zorbak');
  await user.keyboard('{Enter}');
}

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('focus when the tour card goes away', () => {
  it('Skip hands focus to "restart the tour", not to the page body', async () => {
    const { user } = await setup();
    const skip = within(tour() as HTMLElement).getByRole('button', { name: /skip tour/i });
    skip.focus();
    await user.keyboard('{Enter}');
    expect(tour()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: /restart the tour/i }));
  });
  it('Escape in the card does the same', async () => {
    const { user } = await setup();
    next().focus();
    await user.keyboard('{Escape}');
    expect(tour()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: /restart the tour/i }));
  });
  it('Close on the finished card does the same', async () => {
    const { user } = await setup();
    for (let i = 0; i < 4; i++) await user.click(next());
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /^close$/i }));
    expect(tour()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: /restart the tour/i }));
  });
  it('restart the tour removes the button that was pressed, so focus moves on to the new card (Next), not the body', async () => {
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /skip tour/i }));
    await user.click(screen.getByRole('button', { name: /restart the tour/i }));
    expect(tour()).toBeTruthy();
    expect(active()).toBe(next());
  });
  it('leaves focus alone when it is somewhere that still exists (a click on Reset keeps it on Reset)', async () => {
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /skip tour/i }));
    const reset = screen.getByRole('button', { name: /start over/i });
    await user.click(reset);
    expect(tour()).toBeTruthy();
    expect(active()).toBe(reset);
  });
});

describe('stacked layout: the visitor switches panes, the demo never does', () => {
  it('report, then close the thank-you: the game pane is still showing and focus is back on the Report button; the tour says which tab to open', async () => {
    const { user } = await setup({ stacked: true });
    await sayBad(user);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(active()).toBe(reportBtn(/report bo's message: "uninstall/i)));
    expect(screen.getByRole('button', { name: /^game$/i }).getAttribute('aria-pressed')).toBe('true');
    expect(live().textContent).not.toMatch(/showing the (moderator|game) view/i);
    expect(stepText()).toMatch(/open the moderator tab/i);
  });
  it('the decision, then the Game tab by hand: Bo’s notice is on the game pane (step 4), and the tour said so', async () => {
    const { user } = await setup({ stacked: true });
    await oneTapReport(user);
    await closeReport(user);
    await user.click(screen.getByRole('button', { name: /^moderator/i }));
    const card = await openCase(user);
    await pickRule(user);
    const warn = within(card).getByRole('button', { name: /^send a warning/i });
    warn.focus();
    await user.keyboard('{Enter}');
    await sendHeldDecision();
    await waitFor(() => expect(stepText()).toMatch(/open the game tab/i));
    expect(screen.getByRole('button', { name: /^moderator/i }).getAttribute('aria-pressed')).toBe('true'); // still where the visitor put it
    await user.click(screen.getByRole('button', { name: /^game$/i }));
    await noticeBtn('Bo');
  });
  it('does not pull focus off the tour card when Next is pressed (no pane switch happens)', async () => {
    const { user } = await setup({ stacked: true });
    next().focus();
    await user.keyboard('{Enter}'); // step 2
    expect(active()).toBe(next());
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}'); // step 4
    expect(active()).toBe(next());
    expect(screen.getByRole('button', { name: /^game$/i }).getAttribute('aria-pressed')).toBe('true');
  });
  it('the switcher is two aria-pressed buttons, with no tab roles', async () => {
    const { user } = await setup({ stacked: true });
    const group = screen.getByRole('group', { name: /switch pane/i });
    expect(group.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    await user.click(within(group).getByRole('button', { name: /moderator/i }));
    expect(within(group).getByRole('button', { name: /moderator/i }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: /game/i }).getAttribute('aria-pressed')).toBe('false');
  });
  it('the hub’s own Simple/Detailed switch is aria-pressed buttons, and the demo adds no tab widgets of its own', async () => {
    await setup();
    const view = within(modPane()).getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'Simple' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.demo [role="tablist"]')).toBeNull();
  });
});

describe('honest copy', () => {
  it('the notice step’s code blurb says: no IP, no account or subject id, never a bare "no ids"', async () => {
    const { CODE_STEPS } = await import('../src/demo/codeSteps');
    const blurb = CODE_STEPS[3]?.demoNote ?? '';
    expect(blurb).toMatch(/an IP/);
    expect(blurb).toMatch(/account or subject id/);
    expect(blurb).not.toMatch(/no ids|an id\b/);
    expect(blurb).toContain('cw.notices.pending');
    expect(blurb).toMatch(/in process/);
  });
  it('the notice dialog keeps the kit’s promise: nothing of anyone else’s chat, no subject id', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await user.click(await noticeBtn('Bo'));
    const dialog = await screen.findByRole('dialog');
    const person = (await engine.kit()).reports.list({ status: 'actioned' }).items[0]?.targetPerson ?? 'none';
    expect(dialog.textContent).not.toContain(person);
    expect(dialog.textContent).not.toMatch(/demo-bo|demo-you|gg, that last clutch/);
  });
});

describe('double dispatch and reset races', () => {
  it('two clicks on "Send a warning" in one task decide once (one notice, one announcement)', async () => {
    const { engine, user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    const warn = within(card).getByRole('button', { name: /^send a warning/i });
    await act(async () => {
      warn.click();
      warn.click();
    });
    await sendHeldDecision();
    await noticeBtn('Bo');
    expect(await engine.notices.pending('bo')).toHaveLength(1);
    expect([...live().querySelectorAll('p')].filter((p) => /decision taken/i.test(p.textContent ?? ''))).toHaveLength(1);
  });
  it('a decision still held when Reset is pressed leaves nothing behind', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await within(modPane()).findAllByRole('button', { name: 'Undo' });
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await waitFor(() => expect(live().textContent).toMatch(/started over/i));
    await act(async () => {
      window.dispatchEvent(new Event('pagehide')); // anything the old hub still holds goes out now
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(live().textContent).not.toMatch(/decision taken/i);
    expect(screen.queryByRole('button', { name: /see bo's screen/i })).toBeNull();
    expect(stepText()).toMatch(/step 1 of 4/i);
    await waitFor(() => expect(modPane().textContent).toMatch(/nothing is waiting/i));
  });
  it('a report still in flight when Reset is pressed does not file into the new lobby', async () => {
    const { engine, user } = await setup();
    await user.click(reportBtn(/report bo's message: "uninstall/i));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Report' });
    const reset = screen.getByRole('button', { name: /start over/i });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(reset);
    });
    await waitFor(() => expect(live().textContent).toMatch(/started over/i));
    await new Promise((r) => setTimeout(r, 60));
    expect(live().textContent).not.toMatch(/report filed/i);
    expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(0);
  });
});

describe('a failing engine never breaks the demo', () => {
  it('a report that could not be sent keeps the dialog open with the player’s own message, and can be sent again', async () => {
    const { engine, user } = await setup();
    const submit = vi.spyOn(engine.reports, 'submit').mockRejectedValueOnce(new Error('store down'));
    await user.click(reportBtn(/report bo's message: "uninstall/i));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/your report was not sent/i));
    expect(submit).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Report' }));
    await within(dialog).findByRole('heading', { name: 'Report sent' });
  });
  it('a decision the kit fails to take is the hub’s to report: nothing is announced and the tour waits', async () => {
    const { engine, user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    const cw = await engine.kit();
    vi.spyOn(cw, 'decide').mockRejectedValueOnce(new Error('store down'));
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await new Promise((r) => setTimeout(r, 120));
    expect(live().textContent).not.toMatch(/decision taken/i);
    expect(screen.queryByRole('button', { name: /see bo's screen/i })).toBeNull();
    expect(stepText()).toMatch(/step 3 of 4/i);
    expect(screen.queryByText(FRIENDLY)).toBeNull(); // the hub says so itself; the demo is not broken
  });
  it('a rejected chat call keeps what you typed and says so', async () => {
    const { engine, user } = await setup();
    vi.spyOn(engine.chat, 'accept').mockRejectedValue(new Error('boom'));
    await user.type(composer(), 'hello there');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FRIENDLY));
    expect(composer().value).toBe('hello there');
  });
  it('a rejected acknowledge keeps the notice and says so, inline, in player-react’s words', async () => {
    const { engine, user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await user.click(await noticeBtn('Bo'));
    const dialog = await screen.findByRole('dialog');
    vi.spyOn(engine.notices, 'ack').mockRejectedValueOnce(new Error('boom'));
    await user.click(within(dialog).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/still here|could not|try again/i));
    expect(await engine.notices.pending('bo')).toHaveLength(1);
  });
  it('a failing first reset shows the message, does not hang the scripted players, and Reset recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    vi.spyOn(engine, 'reset').mockRejectedValueOnce(new Error('store down'));
    render(<Demo engine={engine} scripted="loop" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole('alert').textContent).toBe(FRIENDLY);
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    expect(count()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000); // `ready` must not be stuck false: the scripted players still speak
    });
    expect(count()).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /start over/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(RUDE)).toBeTruthy();
  });
  it('a failing read of the seats shows the message instead of an unhandled rejection', async () => {
    const { engine, user } = await setup();
    vi.spyOn(engine.rooms, 'seats').mockRejectedValue(new Error('bad'));
    await sayBad(user); // a blocked line refreshes the seats and the notices
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FRIENDLY));
  });
});

describe('every refusal is announced; the note clears when you edit', () => {
  it('announces length, restricted, and anything else the kit may refuse with', async () => {
    const { engine, user } = await setup();
    const accept = vi.spyOn(engine.chat, 'accept');
    accept.mockResolvedValueOnce({ refuse: { reason: 'length' } });
    await user.type(composer(), 'x');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live().textContent).toMatch(/too long/i));
    accept.mockResolvedValueOnce({ refuse: { reason: 'restricted', until: Date.now() + 600_000, byModerator: true, rule: 2 } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live().textContent).toMatch(/timeout until/i));
    accept.mockResolvedValueOnce({ refuse: { reason: 'gate' } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live().textContent).toMatch(/cannot chat in this lobby right now/i));
    accept.mockResolvedValueOnce({ refuse: { reason: 'profanity' } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live().textContent).toMatch(/language this lobby does not allow/i));
    expect(composer().value).toBe('x'); // nothing was sent, so the line is still there to edit
  });
  it('shows the reason under the composer and clears it as soon as you edit', async () => {
    const { user } = await setup();
    for (let i = 0; i < 8; i++) {
      await user.type(composer(), `spam ${i}`);
      await user.keyboard('{Enter}');
    }
    await waitFor(() => expect(document.querySelector('.composer-note')?.textContent).toMatch(/too fast/i));
    await user.type(composer(), 'a');
    expect(document.querySelector('.composer-note')).toBeNull();
  });
  it('counts the 200 limit in UTF-16 units, the way the kit does: 100 emoji read 200/200', async () => {
    await setup();
    fireEvent.change(composer(), { target: { value: '\u{1F600}'.repeat(100) } });
    expect(screen.getByText('200/200')).toBeTruthy();
  });
});

describe('the disclosure and the modals', () => {
  it('the one honest line about what runs the demo sits under the panes: the real packages, a made-up word list, no stand-in', async () => {
    const { container } = await setup();
    const badge = container.querySelector('.demo-badge') as HTMLElement;
    expect(badge.textContent).toBe('The real packages, running in your browser. The blocked words are made up, like "zorbak".');
    expect(container.textContent).not.toMatch(/stand-in/i);
    const panes = container.querySelector('.demo-panes') as HTMLElement;
    expect(panes.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.demo-note')).toBeNull();
  });
  it('while the player’s notice is open, the tour card, the toolbar, the panes and the pane switcher are inert too', async () => {
    const { user, container } = await setup({ stacked: true });
    await oneTapReport(user);
    await closeReport(user);
    await user.click(screen.getByRole('button', { name: /^moderator/i }));
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await user.click(screen.getByRole('button', { name: /^game$/i }));
    await user.click(await noticeBtn('Bo'));
    await screen.findByRole('dialog');
    for (const sel of ['.tour', '.pane-tabs', '.demo-toolbar', '.demo-panes']) {
      expect(container.querySelector(sel)?.hasAttribute('inert'), sel).toBe(true);
    }
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(container.querySelector('.demo-panes')?.hasAttribute('inert')).toBe(false));
  });
  it('aria-controls on show the code only points at the drawer while it exists', async () => {
    const { user } = await setup();
    const toggle = within(tour() as HTMLElement).getByRole('button', { name: /show the code/i });
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-controls')).toBe('demo-code');
    expect(document.getElementById('demo-code')).toBeTruthy();
    await user.click(toggle);
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
  });
  it('the toolbar toggle (tour skipped) follows the same rule', async () => {
    const { user } = await setup();
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /skip tour/i }));
    const toggle = screen.getByRole('button', { name: /show the code/i });
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-controls')).toBe('demo-code');
  });
});
