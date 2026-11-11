// The interactive demo: a chat room (left), the real moderator hub (right), a seven-step tour and a "show me the code" drawer.
// These tests cover the game side and the frame around the hub; demoHub.test.tsx plays the loop through the hub and the player
// components, demoTour.test.tsx the tour. They run against KitEngine, the real Chatwarden kit, and never touch the network.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import { KitEngine } from '../src/demo/kitEngine';
import { closeReport, composer, live, oneTapReport, reportBtn, RUDE, setup, stubMatchMedia } from './helpers/demoUi';

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

describe('the room', () => {
  it('shows the game and the moderator panes, three seats, and the seeded conversation', async () => {
    await setup();
    expect(screen.getByRole('heading', { name: 'The game' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your moderator' })).toBeTruthy();
    expect(document.querySelector('[data-pane="mod"] .cw-hub')).toBeTruthy(); // the real hub
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    expect(within(seats).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('You'),
      expect.stringContaining('Ada'),
      expect.stringContaining('Bo'),
    ]);
    const log = screen.getByRole('log', { name: /lobby chat/i });
    expect(within(log).getByText('gg, that last clutch was wild')).toBeTruthy();
    expect(within(log).getByText(RUDE)).toBeTruthy();
    // Bo's blocked line is private to Bo: the room never shows it
    expect(within(log).queryByText(/absolute zorbak/)).toBeNull();
  });
  it('says the other two players are scripted', async () => {
    await setup();
    expect(screen.getAllByText(/scripted/i).length).toBeGreaterThan(0);
  });
  it('limits the composer to 200 characters and shows a counter', async () => {
    const { user } = await setup();
    expect(composer().maxLength).toBe(200);
    await user.type(composer(), 'hello');
    expect(screen.getByText('5/200')).toBeTruthy();
  });
  it('sends a delivered line to the room, clears the box, and refuses to send nothing', async () => {
    const { user } = await setup();
    const send = screen.getByRole('button', { name: /^send$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(composer(), 'good luck all');
    await user.keyboard('{Enter}');
    const log = screen.getByRole('log', { name: /lobby chat/i });
    expect(await within(log).findByText('good luck all')).toBeTruthy();
    expect(composer().value).toBe('');
    await user.keyboard('{Enter}');
    expect(within(log).getAllByText('good luck all')).toHaveLength(1);
  });
  it('the suggestion chips send gg and fill the composer with a blocked word to try', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'gg' }));
    const log = screen.getByRole('log', { name: /lobby chat/i });
    expect(await within(log).findByText('gg')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /try a blocked word/i }));
    expect(composer().value).toMatch(/zorbak/i);
    expect(document.activeElement).toBe(composer());
  });
});

describe('a refused line', () => {
  it('is struck through with the REFUSED! stamp and a note that only you see it', async () => {
    const { user } = await setup();
    await sayBad(user);
    const log = screen.getByRole('log', { name: /lobby chat/i });
    const refused = await waitFor(() => {
      const el = log.querySelector('[data-verdict="refused"]');
      if (!el) throw new Error('not yet');
      return el as HTMLElement;
    });
    expect(within(refused).getByText(/refused!/i)).toBeTruthy();
    expect(within(refused).getByText('you absolute zorbak')).toBeTruthy();
    expect(refused.textContent).toMatch(/Community Rule 1/);
    expect(refused.textContent).toMatch(/only you/i);
  });
  it('is announced in the polite live region', async () => {
    const { user } = await setup();
    const region = live();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    await sayBad(user);
    await waitFor(() => expect(live().textContent).toMatch(/blocked.*community rule 1/i));
  });
  it('cannot be reported (you cannot report your own line)', async () => {
    const { user } = await setup();
    await sayBad(user);
    await screen.findByText(/refused!/i);
    expect(screen.queryByRole('button', { name: /report you/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /report your/i })).toBeNull();
  });
  it('catches the look-alike forms too, and delivers a near miss', async () => {
    const { user } = await setup();
    await user.type(composer(), 'z0rbak!!');
    await user.keyboard('{Enter}');
    await screen.findByText(/refused!/i);
    await user.type(composer(), 'zorbaking along');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('zorbaking along')).toBeTruthy();
  });
  it('a flood is slowed down with a plain message (no stamp)', async () => {
    const { user } = await setup();
    for (let i = 0; i < 8; i++) {
      await user.type(composer(), `spam ${i}`);
      await user.keyboard('{Enter}');
    }
    await waitFor(() => expect(live().textContent).toMatch(/too fast|slow down/i));
  });
});

describe('the report button', () => {
  it('is on the other players’ lines and none on yours', async () => {
    const { user } = await setup();
    expect(reportBtn(/report bo's line: uninstall/i)).toBeTruthy();
    expect(reportBtn(/report ada's line: gg/i)).toBeTruthy();
    await user.type(composer(), 'mine');
    await user.keyboard('{Enter}');
    await screen.findByText('mine');
    expect(screen.queryByRole('button', { name: /report you/i })).toBeNull();
  });
  it('opens player-react’s dialog, a modal with focus inside (the dialog itself is tested in demoHub.test.tsx)', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.closest('.cw-player')).toBeTruthy();
  });
  it('keeps Tab inside the dialog', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = await screen.findByRole('dialog');
    for (let i = 0; i < 10; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
  it('while the dialog is open, the tour card, the toolbar, the panes and the pane switcher are inert', async () => {
    const { user, container } = await setup({ stacked: true });
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await screen.findByRole('dialog');
    expect(container.querySelector('.demo-toolbar')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('.demo-panes')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('.pane-tabs')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('.tour')?.hasAttribute('inert')).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(container.querySelector('.demo-panes')?.hasAttribute('inert')).toBe(false));
  });
  it('files nothing when it is cancelled', async () => {
    const { user, engine } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(0);
  });
  it('files one report in the kit for the line, from You about Bo, and announces it', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    const [one] = (await engine.kit()).reports.list({ status: 'open' }).items;
    expect(one).toMatchObject({ reporterHandle: 'You', targetHandle: 'Bo' });
    expect(one?.excerpt.map((l) => l.raw)).toContain(RUDE);
    await waitFor(() => expect(live().textContent).toMatch(/report filed against bo/i));
    await closeReport(user);
  });
});

describe('reset', () => {
  it('clears the room, the queue, the notices and the tour, and reseeds the conversation', async () => {
    const { user, engine } = await setup();
    await sayBad(user);
    await oneTapReport(user);
    await closeReport(user);
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await waitFor(() => expect(screen.queryByText(/refused!/i)).toBeNull());
    expect(screen.getByRole('region', { name: /guided tour/i }).textContent).toMatch(/step 1 of 7/i);
    expect(composer().value).toBe('');
    expect(await screen.findByText(RUDE)).toBeTruthy();
    expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(0);
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect(await engine.notices.record('bo')).toEqual([]);
    await waitFor(() => expect(live().textContent).toMatch(/demo reset/i));
  });
  it('brings back a skipped tour and closes the code drawer and any open dialog', async () => {
    const { user } = await setup();
    const t = () => screen.getByRole('region', { name: /guided tour/i });
    await user.click(within(t()).getByRole('button', { name: /show me the code/i }));
    await user.click(within(t()).getByRole('button', { name: /skip tour/i }));
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    expect(t()).toBeTruthy();
    expect(screen.queryByRole('region', { name: /kit code/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('does not leave a stale queue or a doubled lobby when pressed repeatedly', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await screen.findByText(RUDE);
    expect(screen.getAllByText(RUDE)).toHaveLength(1);
    await waitFor(() => expect(document.querySelector('[data-pane="mod"]')?.textContent).toMatch(/nothing is waiting/i));
  });
});

describe('every control has a name', () => {
  it('every button in the demo has a name a screen reader can read', async () => {
    await setup();
    const root = screen.getByRole('group', { name: /chatwarden interactive demo/i });
    for (const b of within(root).getAllByRole('button')) expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length).toBeGreaterThan(0);
  });
});

describe('the scripted players', () => {
  it('chat on a gentle timer, about every 4 to 6 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    render(<Demo engine={engine} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    const before = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(count()).toBe(before); // not before 4 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2700);
    });
    expect(count()).toBe(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(count()).toBeGreaterThanOrEqual(before + 3);
  });
  it('pause stops them, resume starts them again, and the button says which', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    render(<Demo engine={new KitEngine()} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    fireEvent.click(screen.getByRole('button', { name: /pause chat/i }));
    expect(screen.getByRole('button', { name: /resume chat/i })).toBeTruthy();
    const frozen = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(count()).toBe(frozen);
    fireEvent.click(screen.getByRole('button', { name: /resume chat/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(count()).toBeGreaterThan(frozen);
  });
  it('wait while you are typing, and while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    render(<Demo engine={new KitEngine()} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    const before = count();
    // typing: a focused, non-empty composer
    const box = composer();
    box.focus();
    fireEvent.change(box, { target: { value: 'half a thou' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(count()).toBe(before);
    fireEvent.change(box, { target: { value: '' } });
    box.blur();
    // hidden tab
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(count()).toBe(before);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(count()).toBeGreaterThan(before);
  });
  it('stop for good when the demo unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    const spy = vi.spyOn(engine.chat, 'accept');
    const { unmount } = render(<Demo engine={engine} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    unmount();
    const calls = spy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(spy.mock.calls.length).toBe(calls);
  });
});

describe('layout', () => {
  it('is side by side on a wide screen: no stacked class, no pane tabs', async () => {
    const { container } = await setup({ stacked: false });
    expect(container.querySelector('.demo')?.classList.contains('is-stacked')).toBe(false);
    expect(screen.queryByRole('group', { name: /switch pane/i })).toBeNull();
  });
  it('stacks below 1152px (the hub wants about 720px beside the game), game first, with a sticky mini-tab to switch to the moderator', async () => {
    const { container, user } = await setup({ stacked: true });
    expect(container.querySelector('.demo')?.classList.contains('is-stacked')).toBe(true);
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    const [game, mod] = within(tabs).getAllByRole('button');
    expect(game?.textContent).toMatch(/game/i);
    expect(mod?.textContent).toMatch(/moderator/i);
    expect(game?.getAttribute('aria-pressed')).toBe('true');
    expect(mod?.getAttribute('aria-pressed')).toBe('false');
    expect(tabs.querySelector('[role="tab"]')).toBeNull(); // a plain toggle pair, not a half-built tab widget
    const panes = container.querySelectorAll('.demo-panes > section');
    expect([...panes].map((p) => p.getAttribute('data-pane'))).toEqual(['game', 'mod']);
    expect((panes[1] as HTMLElement).hidden).toBe(true);
    await user.click(mod!);
    expect(mod?.getAttribute('aria-pressed')).toBe('true');
    expect((panes[0] as HTMLElement).hidden).toBe(true);
    expect((panes[1] as HTMLElement).hidden).toBe(false);
    expect(within(panes[1] as HTMLElement).getByRole('heading', { name: 'Moderation' })).toBeTruthy(); // the hub is there to use
  });
  it('the moderator tab carries the open-report count', async () => {
    const { user } = await setup({ stacked: true });
    await oneTapReport(user);
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    await waitFor(() => expect(within(tabs).getAllByRole('button')[1]?.textContent).toMatch(/1/));
  });
});
