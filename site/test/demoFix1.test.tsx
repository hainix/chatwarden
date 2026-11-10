// Fix round 1: focus handling, stacked pane switches, honest copy, robustness (double dispatch, reset races, throwing
// engine), refusal announcements, the stand-in badge and inert-ness behind the dialog.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import { FakeEngine } from '../src/demo/fakeEngine';

const RUDE = "uninstall the game, you're hopeless";
const FRIENDLY = 'Something went wrong in the demo. Reset to try again.';

function stubMatchMedia(stacked: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: /max-width/.test(q) ? stacked : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function setup(opts: { stacked?: boolean; engine?: FakeEngine; scripted?: boolean } = {}) {
  stubMatchMedia(opts.stacked ?? false);
  const engine = opts.engine ?? new FakeEngine();
  const user = userEvent.setup();
  const view = render(<Demo engine={engine} scripted={opts.scripted ?? false} />);
  await screen.findByText(RUDE);
  return { engine, user, ...view };
}

const live = () => screen.getByTestId('demo-live');
const tour = () => screen.queryByRole('region', { name: /guided tour/i });
const composer = () => screen.getByLabelText(/chat message/i) as HTMLInputElement;
const active = () => document.activeElement as HTMLElement | null;

async function sayBad(user: ReturnType<typeof userEvent.setup>) {
  await user.type(composer(), 'you absolute zorbak');
  await user.keyboard('{Enter}');
}
/** Reports Bo's rude line with the keyboard only. */
async function reportByKeyboard(user: ReturnType<typeof userEvent.setup>) {
  screen.getByRole('button', { name: /report bo's line: uninstall/i }).focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('dialog');
  await user.keyboard(' ');
  screen.getByRole('button', { name: /send report/i }).focus();
  await user.keyboard('{Enter}');
}

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('focus when the tour card goes away', () => {
  it('Skip hands focus to "Restart tour", not to the page body', async () => {
    const { user } = await setup();
    const skip = within(tour()!).getByRole('button', { name: /skip tour/i });
    skip.focus();
    await user.keyboard('{Enter}');
    expect(tour()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: /restart tour/i }));
  });
  it('Escape in the card does the same', async () => {
    const { user } = await setup();
    within(tour()!).getByRole('button', { name: /^next$/i }).focus();
    await user.keyboard('{Escape}');
    expect(tour()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: /restart tour/i }));
  });
  it('Close on the finished card does the same', async () => {
    const { user } = await setup();
    for (let i = 0; i < 4; i++) await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    await user.click(within(tour()!).getByRole('button', { name: /^close$/i }));
    expect(tour()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: /restart tour/i }));
  });
  it('Restart tour removes the button that was pressed, so focus moves on to the new card (Next), not the body', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /skip tour/i }));
    await user.click(screen.getByRole('button', { name: /restart tour/i }));
    expect(tour()).toBeTruthy();
    expect(active()).toBe(within(tour()!).getByRole('button', { name: /^next$/i }));
  });
  it('leaves focus alone when it is somewhere that still exists (a click on Reset keeps it on Reset)', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /skip tour/i }));
    const reset = screen.getByRole('button', { name: /reset demo/i });
    await user.click(reset);
    expect(tour()).toBeTruthy();
    expect(active()).toBe(reset);
  });
});

describe('stacked layout: the pane switch keeps focus and says so', () => {
  it('report then Moderator: focus lands on the moderator heading and the switch is announced', async () => {
    const { user } = await setup({ stacked: true });
    await sayBad(user);
    await reportByKeyboard(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /^moderator/i }).getAttribute('aria-pressed')).toBe('true'));
    const heading = screen.getByRole('heading', { name: 'Your moderator' });
    await waitFor(() => expect(active()).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(live().textContent).toMatch(/showing the moderator view/i);
  });
  it('Warn then Game: focus lands on the game heading and the switch is announced (step 4 too)', async () => {
    const { user } = await setup({ stacked: true });
    await sayBad(user);
    await reportByKeyboard(user);
    const warn = await screen.findByRole('button', { name: 'Warn' });
    warn.focus();
    await user.keyboard('{Enter}');
    const heading = screen.getByRole('heading', { name: 'The game' });
    await waitFor(() => expect(active()).toBe(heading));
    expect(screen.getByRole('button', { name: /^game$/i }).getAttribute('aria-pressed')).toBe('true');
    expect(live().textContent).toMatch(/showing the game view/i);
    expect(screen.getByRole('region', { name: /bo.s screen/i })).toBeTruthy();
  });
  it('does not pull focus off the tour card when Next switches the pane', async () => {
    const { user } = await setup({ stacked: true });
    const next = () => within(tour()!).getByRole('button', { name: /^next$/i });
    await user.click(next());
    await user.click(next()); // step 3: the moderator pane
    next().focus();
    await user.keyboard('{Enter}'); // step 4: back to the game pane
    expect(active()).toBe(next());
    expect(live().textContent).toMatch(/showing the game view/i);
  });
  it('the switcher is two aria-pressed buttons, with no tab roles', async () => {
    const { user } = await setup({ stacked: true });
    const group = screen.getByRole('group', { name: /switch pane/i });
    expect(group.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    await user.click(within(group).getByRole('button', { name: /moderator/i }));
    expect(within(group).getByRole('button', { name: /moderator/i }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: /game/i }).getAttribute('aria-pressed')).toBe('false');
  });
  it('the moderator console views are aria-pressed buttons too', async () => {
    await setup();
    const reports = screen.getByRole('button', { name: /reports, 0 open/i });
    expect(reports.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /my record/i }).getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.demo [role="tab"]')).toBeNull();
    expect(document.querySelector('.demo [role="tabpanel"]')).toBeNull();
  });
});

describe('honest copy', () => {
  it('says "no IP, no account or subject id", never a bare "no ids"', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await user.click(await screen.findByRole('button', { name: 'Warn' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(frame.textContent).toMatch(/no one else.s chat, no IP, no account or subject id/);
    expect(frame.textContent).not.toMatch(/no ids/i);
  });
  it('the step 4 code blurb says the same', async () => {
    const { CODE_STEPS } = await import('../src/demo/codeSteps');
    expect(CODE_STEPS[3]?.blurb).toMatch(/no IP|an IP/);
    expect(CODE_STEPS[3]?.blurb).toMatch(/account or subject id/);
    expect(CODE_STEPS[3]?.blurb).not.toMatch(/an id\b/);
  });
});

describe('double dispatch and reset races', () => {
  it('two clicks on Warn in one task decide once (one announcement, one notice)', async () => {
    const { engine } = await setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    const warn = await screen.findByRole('button', { name: 'Warn' });
    await act(async () => {
      warn.click();
      warn.click();
    });
    await screen.findByRole('region', { name: /bo.s screen/i });
    expect(await engine.notices.pending('bo')).toHaveLength(1);
    const made = [...live().querySelectorAll('p')].filter((p) => /decision made/i.test(p.textContent ?? ''));
    expect(made).toHaveLength(1);
  });
  it('a decision still in flight when Reset is pressed leaves nothing behind', async () => {
    await setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    const warn = await screen.findByRole('button', { name: 'Warn' });
    const reset = screen.getByRole('button', { name: /reset demo/i });
    await act(async () => {
      warn.click();
      reset.click();
    });
    await waitFor(() => expect(live().textContent).toMatch(/demo reset/i));
    await new Promise((r) => setTimeout(r, 40));
    expect(live().textContent).not.toMatch(/decision made/i);
    expect(screen.queryByRole('region', { name: /bo.s screen/i })).toBeNull();
    expect(screen.getByText(/no open reports/i)).toBeTruthy();
    // and the decide buttons work again afterwards
    await user.click(await screen.findByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    expect((await screen.findByRole('button', { name: 'Warn' })).hasAttribute('disabled')).toBe(false);
  });
  it('a report still in flight when Reset is pressed does not file into the new lobby', async () => {
    const { engine } = await setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    const send = screen.getByRole('button', { name: /send report/i });
    const reset = screen.getByRole('button', { name: /reset demo/i });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(reset);
    });
    await waitFor(() => expect(live().textContent).toMatch(/demo reset/i));
    await new Promise((r) => setTimeout(r, 40));
    expect(live().textContent).not.toMatch(/report filed/i);
    expect((await engine.reports.list()).items).toHaveLength(0);
    expect(screen.getByRole('button', { name: /reports, 0 open/i })).toBeTruthy();
  });
});

describe('a failing engine never breaks the demo', () => {
  it('a rejected report shows a plain message in the dialog and keeps it open', async () => {
    const { engine, user } = await setup();
    vi.spyOn(engine.reports, 'submit').mockRejectedValue(new Error('store down'));
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FRIENDLY));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('button', { name: /send report/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('a rejected decision shows the message, clears busy, and the buttons work again', async () => {
    const { engine, user } = await setup();
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    const warn = await screen.findByRole('button', { name: 'Warn' });
    const spy = vi.spyOn(engine, 'decide').mockRejectedValueOnce(new Error('store down'));
    await user.click(warn);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FRIENDLY));
    expect(spy).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Warn' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    await screen.findByRole('region', { name: /bo.s screen/i });
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toBe(FRIENDLY); // success clears it
  });
  it('a rejected chat call keeps what you typed and says so', async () => {
    const { engine, user } = await setup();
    vi.spyOn(engine.chat, 'accept').mockRejectedValue(new Error('boom'));
    await user.type(composer(), 'hello there');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FRIENDLY));
    expect(composer().value).toBe('hello there');
  });
  it('a rejected acknowledge shows the message and keeps the notice', async () => {
    const { engine, user } = await setup();
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await user.click(await screen.findByRole('button', { name: 'Warn' }));
    const ack = await screen.findByRole('button', { name: /acknowledge/i });
    vi.spyOn(engine.notices, 'ack').mockRejectedValueOnce(new Error('boom'));
    await user.click(ack);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FRIENDLY));
    expect(screen.getByRole('region', { name: /bo.s screen/i })).toBeTruthy();
  });
  it('a failing first reset shows the message, does not hang the scripted players, and Reset recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new FakeEngine();
    vi.spyOn(engine, 'reset').mockRejectedValueOnce(new Error('store down'));
    render(<Demo engine={engine} scripted />);
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
    fireEvent.click(screen.getByRole('button', { name: /reset demo/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(RUDE)).toBeTruthy();
  });
  it('a failing console read (reports.list) shows the message instead of an unhandled rejection', async () => {
    const { engine, user } = await setup();
    vi.spyOn(engine.reports, 'list').mockRejectedValue(new Error('bad cursor'));
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
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
    accept.mockResolvedValueOnce({ refuse: { reason: 'gate' as never } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live().textContent).toMatch(/that line was not sent/i));
    accept.mockResolvedValueOnce({ refuse: { reason: 'profanity' as never } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect([...live().querySelectorAll('p')].filter((p) => /not sent/i.test(p.textContent ?? ''))).toHaveLength(2));
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

describe('the stand-in badge and the modal', () => {
  it('the stand-in disclosure sits above the panes, as a badge', async () => {
    const { container } = await setup();
    const badge = container.querySelector('.demo-badge') as HTMLElement;
    expect(badge.textContent).toMatch(/stand-in/i);
    const panes = container.querySelector('.demo-panes') as HTMLElement;
    expect(badge.compareDocumentPosition(panes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.demo-note')).toBeNull();
  });
  it('while the report dialog is open, the tour card, the toolbar, the panes and the pane switcher are inert', async () => {
    const { user, container } = await setup({ stacked: true });
    await user.click(screen.getByRole('button', { name: /report bo's line: uninstall/i }));
    for (const sel of ['.tour', '.pane-tabs', '.demo-toolbar', '.demo-panes']) {
      expect(container.querySelector(sel)?.hasAttribute('inert'), sel).toBe(true);
    }
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    for (const sel of ['.tour', '.pane-tabs', '.demo-toolbar', '.demo-panes']) {
      expect(container.querySelector(sel)?.hasAttribute('inert'), sel).toBe(false);
    }
  });
  it('aria-controls on Show me the code only points at the drawer while it exists', async () => {
    const { user } = await setup();
    const toggle = within(tour()!).getByRole('button', { name: /show me the code/i });
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-controls')).toBe('demo-code');
    expect(document.getElementById('demo-code')).toBeTruthy();
    await user.click(toggle);
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
  });
  it('the toolbar toggle (tour skipped) follows the same rule', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /skip tour/i }));
    const toggle = screen.getByRole('button', { name: /show me the code/i });
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-controls')).toBe('demo-code');
  });
});
