// The demo UI on top of the REAL kit: the player's notice is the kit's own (in player-react's dialog), a long timeout is dated and
// explained, every refusal in the chat has a real message, and a visitor who trips the kit's automatic timeout sees it truthfully.
// (What the moderator sees and decides is the hub's, tested in hub-react; demoHub.test.tsx plays it through the demo.)
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import type { PlayerNotice } from '../src/demo/engine';
import { KitEngine } from '../src/demo/kitEngine';
import { LOOP } from '../src/demo/script';
import { closeReport, composer, live, noticeBtn, oneTapReport, openCase, pickRule, RUDE, sendHeldDecision, setup, stubMatchMedia } from './helpers/demoUi';

async function say(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(composer());
  await user.type(composer(), text);
  await user.keyboard('{Enter}');
}

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('honest about the demo', () => {
  it('lists the demo settings under "Demo settings": swearing allowed, no "action taken" notice for the reporter, a signed-in owner', async () => {
    await setup();
    const more = document.querySelector('.demo-details') as HTMLElement;
    expect(more).toBeTruthy();
    expect(more.querySelector('summary')?.textContent).toBe('Demo settings');
    expect(more.textContent).toMatch(/swearing is allowed/i);
    expect(more.textContent).toMatch(/no "action taken" notice for your own reports/i);
    expect(more.textContent).toMatch(/signed in as the owner/i);
    expect(more.textContent).not.toMatch(/keyword|heuristic|tone check/i); // the suggestion is the kit's ladder now, not a demo guess
  });
  it('says what runs the demo: the real kit, a made-up word list', async () => {
    await setup();
    expect(document.querySelector('.demo-badge')?.textContent).toBe('The real packages, running in your browser. The blocked words are made up, like "zorbak".');
  });
});

describe('a long timeout is dated and explained', () => {
  const md = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  /** Rule 1 is a severe rule: the kit's ladder suggests 7 days of chat for Bo, and the hub's first button applies it. */
  async function timeout7d() {
    const ctx = await setup();
    await oneTapReport(ctx.user);
    await closeReport(ctx.user);
    const card = await openCase(ctx.user);
    await pickRule(ctx.user, '1');
    await ctx.user.click(within(card).getByRole('button', { name: /^restrict chat, 7 days/i }));
    await sendHeldDecision();
    await noticeBtn('Bo');
    return ctx;
  }
  it('the seat chip says the date, not a bare clock time, and so does the player’s own notice', async () => {
    const { user } = await timeout7d();
    const date = md(Date.now() + 7 * 86_400_000);
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    await waitFor(() => expect(within(seats).getAllByRole('listitem')[2]?.textContent).toContain(`timed out until ${date}`));
    await user.click(await noticeBtn('Bo'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /chat/i })).toBeTruthy();
    expect(dialog.textContent).toContain(date);
  });
  it('says in the notice bar that Bo is timed out for 7 days and has gone quiet (the seats note stays one line), and Start over puts it back', async () => {
    const { user } = await timeout7d();
    const sentence = "Bo is timed out for 7 days, so he's gone quiet. Press Start over to replay.";
    await waitFor(() => expect(document.querySelector('.notice-bar .notice-quiet')?.textContent).toBe(sentence));
    expect(document.querySelector('.seats-note')?.textContent).toBe('Ada and Bo are bots. You can type too.');
    expect(live().textContent).toContain(`Bo has a notice waiting. ${sentence}`);
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await waitFor(() => expect(document.querySelector('.notice-quiet')).toBeNull());
    expect(document.querySelector('.seats-note')?.textContent).toBe('Ada and Bo are bots. You can type too.');
    expect(live().textContent).not.toContain('gone quiet');
  });
  it('a warning leaves the note alone', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await noticeBtn('Bo');
    expect(document.querySelector('.seats-note')?.textContent).toBe('Ada and Bo are bots. You can type too.');
    expect(live().textContent).not.toContain('gone quiet');
  });
  it('the visitor’s own 30 minute automatic timeout shows an end time and does not claim anyone has gone quiet', async () => {
    const { user } = await setup();
    for (const w of ['zorbak', 'vlemmo', 'snerp']) await say(user, `you ${w}`);
    await noticeBtn('you');
    expect(document.querySelector('.seats-note')?.textContent).toBe('Ada and Bo are bots. You can type too.');
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    expect(within(seats).getAllByRole('listitem')[0]?.textContent).toMatch(/timed out until/i);
  });
});

describe('the player notice is the kit’s own, in player-react’s dialog', () => {
  it('a warning quotes the lines the moderator chose with the blocked word starred out, never the word', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    // Simple sends the person's own lines with the warning: Bo's rude line, and his refused one, masked.
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    const notice = (await engine.notices.pending('bo'))[0];
    expect(notice?.kind).toBe('warning');
    await user.click(await noticeBtn('Bo'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(RUDE);
    expect(dialog.textContent).toContain('you absolute ******');
    expect(dialog.textContent).not.toMatch(/zorbak/i);
    expect(dialog.textContent).toContain(notice?.refCode as string);
    // the staff's reason, the reporter and the room's other chat never reach the player
    expect(dialog.textContent).not.toMatch(/gg, that last clutch|ok that was close|demo-mod/);
  });
  it('is gone once acknowledged, and moves to the record', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await user.click(await noticeBtn('Bo'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /see bo's screen/i })).toBeNull());
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect((await engine.notices.record('bo')).map((n) => n.kind)).toEqual(['warning']);
  });
  it('the reporter gets no notice of her own: the tour stays on Bo', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await noticeBtn('Bo');
    expect(screen.queryByRole('button', { name: /see your screen/i })).toBeNull();
  });
  it.each([
    ['chat', /chat/i, 30 * 60_000],
    ['area', /public rooms|area/i, 7 * 86_400_000],
    ['ban', /ban/i, 7 * 86_400_000],
  ] as const)('a %s notice for Bo opens in the dialog with its own title (never "Warning")', async (kind, title, ms) => {
    const { user, engine } = await setup();
    const notice: PlayerNotice = { id: `n-${kind}`, kind, rule: 1, ruleLabel: 'Community Rule 1: No slurs', until: Date.now() + ms, refCode: 'A-B1234', excerpt: [], createdAt: Date.now(), mustAcknowledge: false };
    vi.spyOn(engine.notices, 'pending').mockImplementation(async (seat) => (seat === 'bo' ? [notice] : []));
    await say(user, 'you zorbak'); // any action refreshes what is waiting
    await user.click(await noticeBtn('Bo'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: title })).toBeTruthy();
    expect(within(dialog).queryByRole('heading', { name: /warning/i })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /got it/i })).toBeTruthy();
  });
});

describe('refusals, in the kit own words', () => {
  it('a full set: rate, gate, profanity and a moderator timeout each get their message under the composer and in the live region', async () => {
    const { engine, user } = await setup();
    const accept = vi.spyOn(engine.chat, 'accept');
    await user.type(composer(), 'x');
    const cases: Array<[Parameters<typeof accept.mockResolvedValueOnce>[0], RegExp]> = [
      [{ refuse: { reason: 'rate' } }, /three lines every five seconds/i],
      [{ refuse: { reason: 'gate' } }, /cannot chat in this lobby right now/i],
      [{ refuse: { reason: 'profanity' } }, /language this lobby does not allow/i],
      [{ refuse: { reason: 'restricted', until: Date.now() + 600_000, byModerator: true, rule: 2 } }, /a moderator has put you on a chat timeout until .*community rule 2.*start over/i],
      [{ refuse: { reason: 'restricted', until: null, byModerator: true } }, /banned you from chat/i],
    ];
    for (const [result, re] of cases) {
      accept.mockResolvedValueOnce(result);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(document.querySelector('.composer-note')?.textContent).toMatch(re));
      expect(live().textContent).toMatch(re);
    }
    expect(composer().value).toBe('x');
  });
});

describe('a visitor who trips the real automatic timeout', () => {
  async function spam() {
    const ctx = await setup();
    for (const w of ['zorbak', 'vlemmo', 'snerp']) await say(ctx.user, `you ${w}`);
    return ctx;
  }
  it('sees the restriction on her own screen, with its rule and an end time, and the seat flag, as soon as it happens', async () => {
    const { user } = await spam();
    await user.click(await noticeBtn('you'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /chat/i })).toBeTruthy();
    expect(dialog.textContent).toMatch(/rule 1/i);
    expect(dialog.textContent).toMatch(/until/i);
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    expect(within(seats).getAllByRole('listitem')[0]?.textContent).toMatch(/timed out until/i);
    expect(within(seats).getAllByRole('listitem')[2]?.textContent).not.toMatch(/timed out/i); // Bo is fine
  });
  it('speaks to her, not about "You"', async () => {
    await spam();
    const bar = await screen.findByRole('list', { name: /players with a notice waiting/i });
    expect(bar.textContent).toMatch(/You have a notice\./);
    expect(bar.textContent).toMatch(/See your screen/);
    expect(bar.textContent).not.toMatch(/You has|what You sees/);
  });
  it('her next line says so with the end time and points at Reset; the line stays in the box', async () => {
    const { user } = await spam();
    await say(user, 'hello?');
    await waitFor(() => expect(document.querySelector('.composer-note')?.textContent).toMatch(/automatic filter has put you on a chat timeout until \d.*community rule 1.*press start over/i));
    expect(live().textContent).toMatch(/chat timeout until/i);
    expect(composer().value).toBe('hello?');
  });
  it('Reset is the way out: the lobby, the timeout and the notice are gone', async () => {
    const { user } = await spam();
    await noticeBtn('you');
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await screen.findByText(RUDE);
    await waitFor(() => expect(screen.queryByRole('button', { name: /see your screen/i })).toBeNull());
    expect(screen.queryByText(/timed out until/i)).toBeNull();
    await say(user, 'back again');
    expect(await screen.findByText('back again')).toBeTruthy();
    expect(document.querySelector('.composer-note')).toBeNull();
  });
  it('two blocked words are not enough (the kit needs three in an hour)', async () => {
    const { user } = await setup();
    await say(user, 'you zorbak');
    await say(user, 'you vlemmo');
    expect(screen.queryByRole('button', { name: /see your screen/i })).toBeNull();
    await say(user, 'fine now');
    expect(await screen.findByText('fine now')).toBeTruthy();
  });
});

describe('the scripted players never get timed out (the endless script, scripted="loop")', () => {
  it('ten full loops of the script: no timeout notice, no seat flag, no refused scripted line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    const accept = vi.spyOn(engine.chat, 'accept');
    render(<Demo engine={engine} scripted="loop" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // the timer waits 4 to 6 seconds a line: the slowest cadence still has to fit ten loops, so step 6 s at a time
    for (let i = 0; i < LOOP.length * 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }
    const refused = (await Promise.all(accept.mock.results.map((r) => r.value as Promise<{ refuse?: { reason: string } }>))).filter((r) => r.refuse !== undefined);
    // exactly one refusal in the whole run: Bo's single blocked word in the opening
    expect(refused.map((r) => r.refuse?.reason)).toEqual(['blocked']);
    expect(accept.mock.calls.length).toBeGreaterThanOrEqual(5 + LOOP.length * 10);
    expect(screen.queryByRole('button', { name: /see .* screen/i })).toBeNull();
    expect(screen.queryByText(/timed out until/i)).toBeNull();
    expect((await engine.rooms.seats()).map((s) => s.restrictedUntil)).toEqual([null, null, null]);
    expect(await engine.notices.pending('bo')).toEqual([]);
  });
});
