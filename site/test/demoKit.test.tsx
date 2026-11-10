// The demo UI on top of the REAL kit: the decide buttons follow the kit's suggestion, notices are labelled for what they are,
// every refusal and report refusal has a real message, and a visitor who trips the kit's automatic timeout sees it truthfully.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import type { PlayerNotice, Suggestion } from '../src/demo/engine';
import { KitEngine } from '../src/demo/kitEngine';
import { LOOP } from '../src/demo/script';

const RUDE = "uninstall the game, you're hopeless";

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

async function setup() {
  stubMatchMedia(false);
  const engine = new KitEngine();
  const user = userEvent.setup();
  const view = render(<Demo engine={engine} scripted={false} />);
  await screen.findByText(RUDE);
  return { engine, user, ...view };
}

const live = () => screen.getByTestId('demo-live');
const composer = () => screen.getByLabelText(/chat message/i) as HTMLInputElement;
const reportBtn = (re: RegExp) => screen.getByRole('button', { name: re });

async function fileReport(user: ReturnType<typeof userEvent.setup>, category = /harassment/i) {
  await user.click(reportBtn(/report bo's line: uninstall/i));
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('radio', { name: category }));
  await user.click(within(dialog).getByRole('button', { name: /send report/i }));
  await screen.findByRole('group', { name: 'Decide' });
}
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

describe('the decide buttons follow the kit suggestion', () => {
  it('a first rude line: Warn is starred, Timeout stays the ten minute default', async () => {
    const { user } = await setup();
    await fileReport(user);
    expect(screen.getByRole('button', { name: 'Warn' }).getAttribute('data-suggested')).toBe('true');
    expect(screen.getByRole('button', { name: 'Timeout 10m' }).getAttribute('data-suggested')).toBeNull();
    expect(screen.getByText(/suggested: warning/i)).toBeTruthy();
  });
  it('hate is a severe rule: the kit suggests 7 days of chat, the starred button is "Timeout 7d" and it sends 7 days', async () => {
    const { engine, user } = await setup();
    const decide = vi.spyOn(engine, 'decide');
    await fileReport(user, /hate/i);
    const timeout = await screen.findByRole('button', { name: 'Timeout 7d' });
    expect(timeout.getAttribute('data-suggested')).toBe('true');
    expect(screen.getByText(/suggested: restrict chat 7 days/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Timeout 10m' })).toBeNull();
    await user.click(timeout);
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[0].actions[0]).toMatchObject({ kind: 'chat', durationMs: 7 * 86_400_000, rule: 1 });
    // Bo's notice is the real one: a chat timeout of 7 days
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(frame.textContent).toMatch(/chat timeout/i);
    expect(frame.textContent).toMatch(/7 days/);
    await waitFor(() => expect(live().textContent).toMatch(/timeout, 7 days/i));
  });
  it('plain trash talk: No action is starred', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: ez/i));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    expect((await screen.findByRole('button', { name: 'No action' })).getAttribute('data-suggested')).toBe('true');
    expect(screen.getByRole('button', { name: 'Warn' }).getAttribute('data-suggested')).toBeNull();
  });
  const mockSuggestion = (engine: KitEngine, s: Omit<Suggestion, 'rule'>) => {
    vi.spyOn(engine, 'suggest').mockImplementation(async () => ({ ...s, rule: 2 }));
  };
  it('a 24 hour chat suggestion: "Timeout 24h" is starred and sends 24 hours', async () => {
    const { engine, user } = await setup();
    mockSuggestion(engine, { outcome: { kind: 'chat', durationMs: 86_400_000 }, label: 'Restrict chat 24 hours', why: 'x' });
    const decide = vi.spyOn(engine, 'decide');
    await fileReport(user);
    const timeout = await screen.findByRole('button', { name: 'Timeout 24h' });
    expect(timeout.getAttribute('data-suggested')).toBe('true');
    await user.click(timeout);
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[0].actions[0]).toMatchObject({ kind: 'chat', durationMs: 86_400_000 });
    await waitFor(() => expect(live().textContent).toMatch(/timeout, 24 hours/i));
  });
  it('a ban from public rooms or a full ban has no button here: nothing is starred, and the line says what the kit suggested', async () => {
    const { engine, user } = await setup();
    mockSuggestion(engine, { outcome: { kind: 'area', durationMs: 86_400_000 }, label: 'Ban from public rooms 24 hours', why: 'x' });
    await fileReport(user);
    await screen.findByText(/suggested: ban from public rooms 24 hours/i);
    const bar = screen.getByRole('group', { name: 'Decide' });
    expect(bar.querySelectorAll('[data-suggested]')).toHaveLength(0);
    expect(within(bar).getByRole('button', { name: 'Timeout 10m' })).toBeTruthy();
  });
  it('a note suggestion stars Note', async () => {
    const { engine, user } = await setup();
    mockSuggestion(engine, { outcome: 'note', label: 'Note', why: 'x' });
    await fileReport(user);
    expect((await screen.findByRole('button', { name: 'Note' })).getAttribute('data-suggested')).toBe('true');
  });
});

describe('a long evidence buffer (the kit keeps up to 100 lines)', () => {
  it('lists every line in a scrolling, keyboard-reachable box, and offers the reported line plus the five latest of the player', async () => {
    let t = Date.UTC(2026, 10, 10, 12, 0, 0);
    const clock = { now: () => t };
    stubMatchMedia(false);
    const engine = new KitEngine({ clock });
    const user = userEvent.setup();
    render(<Demo engine={engine} scripted={false} />);
    await screen.findByText(RUDE);
    // twelve more lines from Bo and Ada land in the room's evidence (spaced out so the 3 per 5 s limit is never hit)
    t += 6_000; // the opening used up Bo's three lines of the 5 s window
    for (let i = 0; i < 12; i++) {
      t += 2_000;
      await engine.chat.accept(i % 2 ? 'ada' : 'bo', `extra line ${i}`);
    }
    await fileReport(user);
    const list = screen.getByRole('list', { name: /evidence/i });
    expect(list.getAttribute('tabindex')).toBe('0'); // a scrollable region must be reachable by keyboard
    expect(list.querySelectorAll('li')).toHaveLength(5 + 12);
    expect(list.querySelectorAll('[data-reported="true"]')).toHaveLength(1);
    const group = screen.getByRole('group', { name: /line to show the player/i });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    // "don't quote" + the reported line + Bo's five latest lines (the reported line is among his older ones)
    expect(radios.length).toBeLessThanOrEqual(7);
    expect(radios.length).toBeGreaterThan(2);
    expect(radios.find((r) => r.checked)?.closest('label')?.textContent).toContain(RUDE);
    expect(within(group).getByLabelText(/extra line 10/)).toBeTruthy(); // Bo's latest
    expect(within(group).queryByLabelText(/ez, you're trash lol/)).toBeNull(); // his oldest is not offered
  });
});

describe('the player notice is the kit own, labelled for what it is', () => {
  it('a decided warning shows Bo a Warning with the chosen line, a ref code and Acknowledge; ack clears it and fills "My record"', async () => {
    const { engine, user } = await setup();
    await fileReport(user);
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(within(frame).getByRole('heading', { name: 'Warning' })).toBeTruthy();
    expect(frame.textContent).toMatch(/Community Rule 2/);
    expect(within(frame).getByText(RUDE)).toBeTruthy();
    const notice = (await engine.notices.pending('bo'))[0] as PlayerNotice;
    expect(notice.kind).toBe('warning');
    expect(within(frame).getByText(notice.refCode as string)).toBeTruthy();
    await user.click(within(frame).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /bo.s screen/i })).toBeNull());
    expect(await engine.notices.pending('bo')).toEqual([]);
    await user.click(screen.getByRole('button', { name: /my record/i }));
    const bo = await screen.findByRole('list', { name: /bo.s record/i });
    expect(within(bo).getByText('Warning')).toBeTruthy();
    expect(bo.textContent).toContain(RUDE);
  });
  it('masks the blocked word in the quoted line: stars, never the word', async () => {
    const { user } = await setup();
    await fileReport(user);
    await user.click(screen.getByRole('radio', { name: /absolute zorbak/i }));
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(frame.textContent).toContain('you absolute ******');
    expect(document.body.textContent?.match(/zorbak/g)?.length ?? 0).toBeLessThanOrEqual(2); // the evidence + the picker, staff views only
    expect(frame.textContent).not.toMatch(/zorbak/i);
  });
  it('the reporter gets no frame of her own: the tour stays on Bo', async () => {
    const { user } = await setup();
    await fileReport(user);
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    await screen.findByRole('region', { name: /bo.s screen/i });
    expect(screen.queryByRole('region', { name: /^your screen$/i })).toBeNull();
  });
  const noticeOf = (kind: PlayerNotice['kind'], extra: Partial<PlayerNotice> = {}): PlayerNotice => ({
    id: `n-${kind}`,
    kind,
    rule: 1,
    ruleLabel: 'Community Rule 1: No slurs',
    until: null,
    refCode: 'A-B1234',
    excerpt: [],
    createdAt: Date.now(),
    mustAcknowledge: false,
    ...extra,
  });
  it.each([
    ['chat', 'Chat timeout', /chat is paused for 30 minutes/i],
    ['area', 'Ban from public rooms', /banned from public rooms for 7 days/i],
    ['ban', 'Full ban', /banned from the game for 7 days/i],
  ] as const)('a %s notice is titled %s with its length, never "Warning"', async (kind, title, end) => {
    const { engine } = await setup();
    const ms = kind === 'chat' ? 30 * 60_000 : 7 * 86_400_000;
    vi.spyOn(engine.notices, 'pending').mockImplementation(async (seat) => (seat === 'bo' ? [noticeOf(kind, { until: Date.now() + ms })] : []));
    // a refresh happens after any action; trigger one with a blocked word
    const user = userEvent.setup();
    await say(user, 'you zorbak');
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(within(frame).getByRole('heading', { name: title })).toBeTruthy();
    expect(frame.textContent).toMatch(end);
    expect(frame.textContent).not.toMatch(/\bWarning\b/);
  });
  it('a report_outcome notice is "Action taken on your report", with no rule line and no Warning', async () => {
    const { engine } = await setup();
    vi.spyOn(engine.notices, 'pending').mockImplementation(async (seat) =>
      seat === 'you' ? [noticeOf('report_outcome', { rule: null, ruleLabel: null, refCode: null })] : [],
    );
    const user = userEvent.setup();
    await say(user, 'you zorbak');
    const frame = await screen.findByRole('region', { name: /^your screen$/i });
    expect(within(frame).getByRole('heading', { name: 'Action taken on your report' })).toBeTruthy();
    expect(frame.textContent).toMatch(/a moderator acted on a report you sent/i);
    expect(frame.textContent).not.toMatch(/\bWarning\b/);
    expect(frame.querySelector('.pframe-rule')).toBeNull();
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
      [{ refuse: { reason: 'restricted', until: Date.now() + 600_000, byModerator: true, rule: 2 } }, /a moderator has put you on a chat timeout until .*community rule 2.*reset demo/i],
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
  it('a report refusal of every kind is spelled out in the dialog, suspended included', async () => {
    const { engine, user } = await setup();
    const submit = vi.spyOn(engine.reports, 'submit');
    const cases = [
      ['suspended', /paused for you.*bad faith/i],
      ['rate', /out of reports for today/i],
      ['duplicate', /already reported bo in this lobby/i],
      ['self', /cannot report yourself/i],
      ['not_player', /cannot be reported/i],
      ['off', /reports are off/i],
    ] as const;
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /harassment/i }));
    for (const [refused, re] of cases) {
      submit.mockResolvedValueOnce({ ok: false, refused });
      await user.click(within(dialog).getByRole('button', { name: /send report/i }));
      await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(re));
    }
  });
});

describe('a visitor who trips the real automatic timeout', () => {
  async function spam() {
    const ctx = await setup();
    for (const w of ['zorbak', 'vlemmo', 'snerp']) await say(ctx.user, `you ${w}`);
    return ctx;
  }
  it('sees the restriction with its end time on her own screen, and the seat flag, as soon as it happens', async () => {
    await spam();
    const frame = await screen.findByRole('region', { name: /^your screen$/i });
    expect(within(frame).getByRole('heading', { name: 'Chat timeout' })).toBeTruthy();
    expect(frame.textContent).toMatch(/chat is paused for 30 minutes, until \d/i);
    // her own frame speaks to her, not about "You"
    expect(frame.textContent).toMatch(/Your screen/);
    expect(frame.textContent).toMatch(/what you see/);
    expect(frame.textContent).toMatch(/Only you get this/);
    expect(frame.textContent).not.toMatch(/You’s|what You sees|Only You gets/);
    expect(frame.textContent).toMatch(/Community Rule 1/);
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    expect(within(seats).getAllByRole('listitem')[0]?.textContent).toMatch(/timed out until/i);
    expect(within(seats).getAllByRole('listitem')[2]?.textContent).not.toMatch(/timed out/i); // Bo is fine
  });
  it('her next line says so with the end time and points at Reset; the line stays in the box', async () => {
    const { user } = await spam();
    await say(user, 'hello?');
    await waitFor(() => expect(document.querySelector('.composer-note')?.textContent).toMatch(/automatic filter has put you on a chat timeout until \d.*community rule 1.*press reset demo/i));
    expect(live().textContent).toMatch(/chat timeout until/i);
    expect(composer().value).toBe('hello?');
  });
  it('Reset is the way out: the lobby, the timeout and the notice are gone', async () => {
    const { user } = await spam();
    await screen.findByRole('region', { name: /^your screen$/i });
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await screen.findByText(RUDE);
    await waitFor(() => expect(screen.queryByRole('region', { name: /^your screen$/i })).toBeNull());
    expect(screen.queryByText(/timed out until/i)).toBeNull();
    await say(user, 'back again');
    expect(await screen.findByText('back again')).toBeTruthy();
    expect(document.querySelector('.composer-note')).toBeNull();
  });
  it('two blocked words are not enough (the kit needs three in an hour)', async () => {
    const { user } = await setup();
    await say(user, 'you zorbak');
    await say(user, 'you vlemmo');
    expect(screen.queryByRole('region', { name: /^your screen$/i })).toBeNull();
    await say(user, 'fine now');
    expect(await screen.findByText('fine now')).toBeTruthy();
  });
});

describe('the scripted players never get timed out', () => {
  it('ten full loops of the script: no timeout notice, no seat flag, no refused scripted line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    const accept = vi.spyOn(engine.chat, 'accept');
    render(<Demo engine={engine} scripted />);
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
    expect(screen.queryByRole('region', { name: /screen/i })).toBeNull();
    expect(screen.queryByText(/timed out until/i)).toBeNull();
    expect((await engine.rooms.seats()).map((s) => s.restrictedUntil)).toEqual([null, null, null]);
    expect(await engine.notices.pending('bo')).toEqual([]);
  });
});
