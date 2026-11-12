// The demo holds still: fixes A to J of docs/design/2026-11-11-site-copy-rewrite.md (section 4). Nothing under the visitor's pointer
// moves on its own. jsdom has no layout, so scroll positions are faked on the elements; the real pixels are measured in Chromium in
// browser.test.ts ("the demo holds still").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REPORT_REASONS } from '@chatwarden/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import { KitEngine } from '../src/demo/kitEngine';
import { appendLine, FEED_MAX, pickTourLine } from '../src/demo/feed';
import { LOOP, REPLIES, SEED, THANKS } from '../src/demo/script';
import type { FeedItem } from '../src/demo/types';
import { closeReport, composer, gamePane, modPane, oneTapReport, openCase, pickRule, reasonedReport, reportBtn, sendHeldDecision, setup, stepText, stubMatchMedia, tour } from './helpers/demoUi';

const css = readFileSync(join(__dirname, '..', 'src', 'demo', 'demo.css'), 'utf8').split('\r\n').join('\n');
const demoSrc = readFileSync(join(__dirname, '..', 'src', 'demo', 'Demo.tsx'), 'utf8');
const bodies = (selector: string): string[] => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[{}]|\\*\\/)\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] as string);
};

const FAKE = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as Array<'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'Date'> };
beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const item = (id: string, over: Partial<FeedItem> = {}): FeedItem => ({ id, seat: 'ada', name: 'Ada', text: id, you: false, ...over });
const chatEl = () => screen.getByRole('log', { name: /lobby chat/i });
const lines = () => chatEl().querySelectorAll('.msg').length;
const pill = () => screen.queryByRole('button', { name: /new messages?$/i });

/** Gives the chat box a fake layout: 1000px of content in a 300px window, and a scrollTop the test controls. */
function fakeScroll(el: HTMLElement, top: number) {
  let current = top;
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      writes.push(v);
      current = v;
    },
  });
  return { writes, get top() { return current; }, scrollTo: (v: number) => { current = v; fireEvent.scroll(el); } };
}

/** Types a line and sends it. fireEvent, not user-event: user-event and findBy* wait on timers, and these tests hold the clock. */
function say(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.submit(composer().closest('form') as HTMLFormElement);
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the feed (pure helpers)', () => {
  it('appends a line, and trims the oldest only while the reader is at the bottom', () => {
    const full = Array.from({ length: FEED_MAX }, (_, i) => item(`m${i}`));
    const atBottom = appendLine(full, item('new'), true);
    expect(atBottom).toHaveLength(FEED_MAX);
    expect(atBottom[0]?.id).toBe('m1');
    expect(atBottom[atBottom.length - 1]?.id).toBe('new');
    const scrolledUp = appendLine(full, item('new'), false);
    expect(scrolledUp).toHaveLength(FEED_MAX + 1);
    expect(scrolledUp[0]?.id).toBe('m0'); // the line the reader is looking at is still there
  });
  it('even a reader who stays scrolled up cannot grow the feed without bound', () => {
    let feed: FeedItem[] = [];
    for (let i = 0; i < 400; i++) feed = appendLine(feed, item(`m${i}`), false);
    expect(feed.length).toBeLessThanOrEqual(FEED_MAX * 3);
    expect(feed[feed.length - 1]?.id).toBe('m399');
  });
  it('does not mutate the feed it is given', () => {
    const feed = [item('a')];
    appendLine(feed, item('b'), true);
    expect(feed).toHaveLength(1);
  });
});

describe('the tour target (fix E): picked once, then frozen', () => {
  const feed = [
    item('a1'),
    item('b1', { seat: 'bo', name: 'Bo', rude: true }),
    item('a2'),
    item('b2', { seat: 'bo', name: 'Bo', rude: true }),
    item('b3', { seat: 'bo', name: 'Bo' }),
  ];
  it('is Bo’s newest rude line that has not been reported', () => {
    expect(pickTourLine(feed, new Set(), null)).toBe('b2');
    expect(pickTourLine(feed, new Set(['b2']), null)).toBe('b1');
  });
  it('keeps the line it has while that line is still in the feed, however many rude lines arrive', () => {
    expect(pickTourLine(feed, new Set(), 'b1')).toBe('b1');
    expect(pickTourLine([...feed, item('b4', { seat: 'bo', name: 'Bo', rude: true })], new Set(), 'b2')).toBe('b2');
  });
  it('moves on when the line is reported or has left the feed', () => {
    expect(pickTourLine(feed, new Set(['b1']), 'b1')).toBe('b2');
    expect(pickTourLine(feed.slice(2), new Set(), 'b1')).toBe('b2');
  });
  it('falls back to any Bo line, then to the last line that is not yours, and to null in an empty room', () => {
    expect(pickTourLine([item('a1'), item('b3', { seat: 'bo', name: 'Bo' })], new Set(), null)).toBe('b3');
    expect(pickTourLine([item('a1'), item('y1', { seat: 'you', name: 'You', you: true })], new Set(), null)).toBe('a1');
    expect(pickTourLine([], new Set(), null)).toBeNull();
  });
});

describe('the scripted players (fix A): finite, and they answer only when spoken to', () => {
  it('play the opening once, ending on Bo’s rude line, and then the room goes quiet: no endless loop', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted />);
    await tick(200);
    const seeded = lines();
    expect(seeded).toBe(SEED.length - 1); // Bo's blocked line is only Bo's to see
    expect(within(chatEl()).getByText(SEED[SEED.length - 1]?.text ?? '')).toBeTruthy();
    expect(SEED[SEED.length - 1]).toMatchObject({ seat: 'bo', rude: true });
    await tick(10 * 60_000); // ten idle minutes
    expect(lines()).toBe(seeded);
  });
  it('answer a line the visitor sends, once, two seconds later', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted />);
    await tick(200);
    const before = lines();
    say('good luck all');
    await tick(10);
    expect(lines()).toBe(before + 1); // her own line
    await tick(1500);
    expect(lines()).toBe(before + 1); // not before two seconds
    await tick(700);
    expect(lines()).toBe(before + 2);
    await tick(60_000);
    expect(lines()).toBe(before + 2); // and then quiet again
  });
  it('a burst of lines gets one answer, not one each', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted />);
    await tick(200);
    const before = lines();
    for (const t of ['one', 'two']) {
      say(t);
      await tick(50);
    }
    await tick(5000);
    expect(lines()).toBe(before + 3);
  });
  it('do not answer a line that was blocked (nobody else saw it) or while paused', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted />);
    await tick(200);
    const before = lines();
    say('you absolute zorbak');
    await tick(5000);
    expect(chatEl().querySelectorAll('[data-verdict="refused"]')).toHaveLength(1);
    expect(lines()).toBe(before + 1); // only the blocked line itself, which the visitor sees
    fireEvent.click(within(gamePane()).getByRole('button', { name: /^pause$/i }));
    say('anyone there');
    await tick(5000);
    expect(lines()).toBe(before + 2);
  });
  it('have replies to give, none of them a blocked word, and a thank-you for the moderators', () => {
    expect(REPLIES.length).toBeGreaterThanOrEqual(3);
    expect(THANKS).toMatchObject({ seat: 'ada', text: 'thanks mods' });
    for (const l of [...REPLIES, THANKS]) expect(l.text).not.toMatch(/zorbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp|glarn/i);
  });
  it('after a decision Ada says thanks, and Bo stays silent while he is timed out', async () => {
    const { user } = await setup({ scripted: true });
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    const before = lines();
    await user.click(within(card).getByRole('button', { name: /^restrict chat, 24 hours/i }));
    await sendHeldDecision();
    await waitFor(() => expect([...chatEl().querySelectorAll('.msg')].filter((m) => (m.textContent ?? '').includes('thanks mods'))).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 2500)); // long enough for Bo's line, if he were going to say one
    expect(lines()).toBe(before + 1); // Ada's thanks; nothing from Bo
  }, 30_000);
  it('Bo adds a line of his own after a warning, which leaves him able to chat', async () => {
    // Bo's opening lines used up his 3 lines in 5 seconds; a person takes longer than that to reach the decision, the test skips ahead.
    const skew = { ms: 0 };
    const { user } = await setup({ scripted: true, engine: new KitEngine({ clock: { now: () => Date.now() + skew.ms } }) });
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    const before = lines();
    skew.ms = 6_000;
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await waitFor(() => expect(lines()).toBe(before + 2), { timeout: 6000 });
    expect(chatEl().textContent).toContain('thanks mods');
    expect(chatEl().textContent).toContain('ok ok, my bad');
  }, 30_000);
  it('the old endless script is still there for tests, behind scripted="loop"', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const before = lines();
    await tick(7000);
    expect(lines()).toBe(before + 1);
    expect(LOOP.length).toBeGreaterThan(6);
  });
});

describe('scrolling the chat (fix C): only when the reader is at the bottom', () => {
  it('keeps the position of a reader who has scrolled up, and shows a "new messages" pill with a count', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const sc = fakeScroll(chatEl(), 100);
    sc.scrollTo(100); // the reader scrolled up
    sc.writes.length = 0;
    expect(pill()).toBeNull();
    await tick(7000);
    expect(sc.writes).toEqual([]); // the chat did not move by itself
    expect(sc.top).toBe(100);
    expect(pill()?.textContent).toMatch(/1 new message$/);
    await tick(6000);
    expect(pill()?.textContent).toMatch(/2 new messages$/);
    expect(sc.writes).toEqual([]);
  });
  it('the pill takes the reader to the newest line and goes away', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const sc = fakeScroll(chatEl(), 0);
    sc.scrollTo(0);
    await tick(7000);
    fireEvent.click(pill() as HTMLElement);
    expect(sc.top).toBe(1000);
    expect(pill()).toBeNull();
  });
  it('the pill goes away by itself when the reader scrolls back to the bottom', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const sc = fakeScroll(chatEl(), 0);
    sc.scrollTo(0);
    await tick(7000);
    expect(pill()).toBeTruthy();
    sc.scrollTo(700); // 1000 - 700 - 300 = 0 from the bottom
    expect(pill()).toBeNull();
  });
  it('a reader at the bottom stays at the bottom when a line arrives', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const sc = fakeScroll(chatEl(), 700);
    sc.scrollTo(700);
    sc.writes.length = 0;
    await tick(7000);
    expect(sc.writes.length).toBeGreaterThan(0);
    expect(sc.top).toBe(1000);
    expect(pill()).toBeNull();
  });
  it('does not move the chat while the pointer is in it, even at the bottom (a pointer on a Report button keeps its button)', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const sc = fakeScroll(chatEl(), 700);
    sc.scrollTo(700);
    sc.writes.length = 0;
    fireEvent.pointerEnter(chatEl());
    await tick(7000);
    expect(sc.writes).toEqual([]);
    expect(pill()?.textContent).toMatch(/1 new message$/);
    fireEvent.pointerLeave(chatEl());
  });
  it('the visitor’s own line always brings the chat to the bottom', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted />);
    await tick(200);
    const sc = fakeScroll(chatEl(), 0);
    sc.scrollTo(0);
    say('hello');
    await tick(50);
    expect(sc.top).toBe(1000);
    expect(pill()).toBeNull();
  });
  it('the pill is not part of a normal start: nothing to say, no pill', async () => {
    await setup();
    expect(pill()).toBeNull();
  });
});

describe('the Report button (fix D): always there, in a column of its own', () => {
  it('is on every line that is not yours, a direct child of the line, labelled with the message, and never hidden', async () => {
    await setup();
    const others = [...chatEl().querySelectorAll('.msg')].filter((m) => m.getAttribute('data-seat') !== 'you');
    expect(others.length).toBeGreaterThanOrEqual(3);
    for (const m of others) {
      const b = m.querySelector(':scope > .report-btn') as HTMLElement;
      expect(b, m.textContent ?? '').toBeTruthy();
      expect(b.textContent).toBe('Report');
      expect(b.hasAttribute('hidden')).toBe(false);
      expect(b.getAttribute('aria-hidden')).toBeNull();
    }
    expect(reportBtn(/^report bo's message: "uninstall the game, you're hopeless"$/i)).toBeTruthy();
  });
  it('is not on your own lines', async () => {
    const { user } = await setup();
    await user.type(composer(), 'mine');
    await user.keyboard('{Enter}');
    const mine = await within(chatEl()).findByText('mine');
    expect(mine.closest('.msg')?.querySelector('.report-btn')).toBeNull();
  });
  it('the stylesheet gives every line the same three columns with the Report column a fixed width, and never hides the button', () => {
    const row = bodies('.chat .msg').join(';');
    expect(row).toMatch(/grid-template-columns:\s*34px minmax\(0,\s*1fr\)\s+\d+px/);
    const btn = bodies('.report-btn').join(';');
    expect(btn).not.toMatch(/opacity:\s*0\s*;/);
    expect(btn).toMatch(/color:\s*var\(--screen-muted\)/); // muted at rest
    expect(css).not.toMatch(/\.msg:hover \.report-btn\s*,?\s*\n?[^{]*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/\.report-btn:hover,\s*\.report-btn:focus-visible\s*\{[^}]*color:\s*#ff9cc4/); // full colour on hover or focus
  });
  it('the game pane is wider (360 to 400px) so bubbles wrap less', () => {
    expect(css).toMatch(/grid-template-columns:\s*minmax\(360px, 400px\) minmax\(0, 1fr\)/);
  });
});

describe('the tour card (fix F): docked, not floating', () => {
  it('is a strip above the panes on a wide screen, with the step, the title, the instruction and Skip tour / Next', async () => {
    const { container } = await setup();
    const card = tour() as HTMLElement;
    const panes = container.querySelector('.demo-panes') as HTMLElement;
    expect(card.compareDocumentPosition(panes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toMatch(/step 1 of 4/i);
    expect(within(card).getByRole('button', { name: /^skip tour$/i })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^next$/i })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^show the code$/i })).toBeTruthy();
  });
  it('never gets a position of its own: no left or top, no arrow, whatever the ring is on and however the chat scrolls', async () => {
    const { user } = await setup();
    const card = tour() as HTMLElement;
    const style = () => card.getAttribute('style') ?? '';
    expect(style()).not.toMatch(/left|top|--arrow/);
    fireEvent.scroll(chatEl());
    fireEvent(window, new Event('resize'));
    expect(style()).not.toMatch(/left|top|--arrow/);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    expect(style()).not.toMatch(/left|top|--arrow/);
    expect(card.hasAttribute('data-placement')).toBe(false);
  });
  it('the code that moved it is gone, and the stylesheet has no floating card', () => {
    expect(demoSrc).not.toMatch(/getBoundingClientRect\(\)/);
    expect(demoSrc).not.toMatch(/addEventListener\('scroll'/);
    expect(demoSrc).not.toMatch(/ResizeObserver/);
    const tourRule = bodies('.tour').join(';');
    expect(tourRule).not.toMatch(/position:\s*absolute/);
    expect(tourRule).not.toMatch(/transition:\s*left/);
    expect(css).not.toMatch(/\.tour::before/);
    expect(css).not.toMatch(/data-placement/);
  });
  it('keeps the ring on the control, which does not move the card', async () => {
    await setup();
    const ring = document.querySelector('[data-tour-target]') as HTMLElement;
    expect(ring.getAttribute('aria-label')).toMatch(/report bo's message/i);
    expect(document.querySelectorAll('[data-tour-target]')).toHaveLength(1);
  });
});

describe('the tour target holds still (fix E) in the demo', () => {
  it('stays on the same line while Bo says more rude things, and the card text does not change', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    const ring = () => document.querySelector('[data-tour-target]') as HTMLElement | null;
    const first = ring();
    const label = first?.getAttribute('aria-label');
    expect(label).toMatch(/report bo's message: "uninstall the game/i);
    const text = tour()?.textContent;
    await tick(60_000); // the loop has said several rude things by now
    expect(ring()).toBe(first);
    expect(ring()?.getAttribute('aria-label')).toBe(label);
    expect(tour()?.textContent).toBe(text);
  });
});

describe('the space between the chat and the composer (fix G): reserved, not inserted', () => {
  it('puts the notice bar in an overlay on the chat’s bottom edge, not between the chat and the composer', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    const bar = await screen.findByRole('list', { name: /players with a notice waiting/i });
    const overlay = bar.closest('.chat-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.parentElement?.classList.contains('chat-wrap')).toBe(true);
    expect(overlay.parentElement?.querySelector('.chat')).toBeTruthy();
    expect(bar.parentElement?.closest('.pane-game')?.querySelector(':scope > .notice-bar')).toBeNull();
  });
  it('says what happened in the notice bar: "Bo has a notice." and "See Bo’s screen", and why a timed out player is quiet', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^restrict chat, 24 hours/i }));
    await sendHeldDecision();
    const bar = await screen.findByRole('list', { name: /players with a notice waiting/i });
    await waitFor(() => expect(bar.textContent).toContain('Bo has a notice.'));
    expect(within(bar).getByRole('button', { name: /^see bo's screen/i }).textContent).toBe("See Bo's screen");
    await waitFor(() => expect(bar.textContent).toMatch(/Bo is timed out for 24 hours, so he's gone quiet\. Press Start over to replay\./));
  });
  it('the seats note is one line, whatever it says', () => {
    const note = bodies('.seats-note').join(';');
    expect(note).toMatch(/white-space:\s*nowrap/);
    expect(note).toMatch(/text-overflow:\s*ellipsis/);
  });
  it('the overlay does not take space from the chat, and its entrance is a fade with no travel', () => {
    expect(bodies('.chat-overlay').join(';')).toMatch(/position:\s*absolute/);
    expect(bodies('.chat-wrap').join(';')).toMatch(/position:\s*relative/);
    const frame = /@keyframes frame-in\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(frame).toMatch(/opacity/);
    expect(frame).not.toMatch(/translate|scale/);
    expect(css).not.toMatch(/translateY\(36px\)/);
  });
  it('a note about your own line (too fast, timed out) is an overlay above the box, not a new row in the form', async () => {
    const { user } = await setup();
    for (let i = 0; i < 5; i++) {
      await user.type(composer(), `spam ${i}`);
      await user.keyboard('{Enter}');
    }
    const note = await waitFor(() => {
      const n = document.querySelector('.composer-note') as HTMLElement | null;
      if (n === null) throw new Error('not yet');
      return n;
    });
    expect(note.closest('.chat-overlay')).toBeTruthy();
    expect(note.closest('form')).toBeNull();
    expect(note.textContent).toMatch(/too fast/i);
  });
});

describe('Pause (fix F): in the game pane header', () => {
  it('sits next to #lobby in the pane header, not in the page toolbar', async () => {
    const { container } = await setup();
    const head = gamePane().querySelector('.pane-head') as HTMLElement;
    expect(within(head).getByRole('button', { name: /^pause$/i })).toBeTruthy();
    expect(head.textContent).toContain('#lobby');
    expect(within(container.querySelector('.demo-toolbar') as HTMLElement).queryByRole('button', { name: /pause|resume/i })).toBeNull();
  });
  it('turns into Resume and back, and says so with aria-pressed', async () => {
    const { user } = await setup();
    const btn = () => within(gamePane().querySelector('.pane-head') as HTMLElement).getByRole('button', { name: /^(pause|resume)$/i });
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    await user.click(btn());
    expect(btn().textContent).toMatch(/resume/i);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    await user.click(btn());
    expect(btn().textContent).toMatch(/pause/i);
  });
  it('stops the loop while paused and starts it again', async () => {
    vi.useFakeTimers(FAKE);
    render(<Demo engine={new KitEngine()} scripted="loop" />);
    await tick(200);
    fireEvent.click(within(gamePane()).getByRole('button', { name: /^pause$/i }));
    const frozen = lines();
    await tick(30_000);
    expect(lines()).toBe(frozen);
    fireEvent.click(within(gamePane()).getByRole('button', { name: /^resume$/i }));
    await tick(7000);
    expect(lines()).toBeGreaterThan(frozen);
  });
});

describe('the demo fits the window (fix J)', () => {
  it('puts the badge and "Demo settings" under the panes, not above them', async () => {
    const { container } = await setup();
    const panes = container.querySelector('.demo-panes') as HTMLElement;
    const badge = container.querySelector('.demo-badge') as HTMLElement;
    const details = container.querySelector('.demo-details') as HTMLElement;
    expect(panes.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panes.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(badge.textContent).toBe('The real packages, running in your browser. The blocked words are made up, like "zorbak".');
    expect(details.querySelector('summary')?.textContent).toBe('Demo settings');
    expect(details.querySelector('p')?.textContent).toBe(
      `Swearing is allowed. Bo's notice opens here so you can see his screen. You get no "action taken" notice for your own reports, so the tour stays on Bo's screen. You're signed in as the owner, so every page of the hub is open. Everything else is the default.`,
    );
  });
  it('sizes the panes to the window, up to 660px', () => {
    expect(css).toMatch(/\.demo:not\(\.is-stacked\) \.pane\s*\{[^}]*height:\s*min\(660px, calc\(100vh - [^)]*\)\)/);
  });
});

describe('a phone (fix H): nothing scrolls or switches by itself', () => {
  function spies() {
    const calls: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(`scrollIntoView ${(this as HTMLElement).getAttribute('aria-label') ?? this.textContent?.slice(0, 20)}`);
    };
    vi.spyOn(window, 'scrollTo').mockImplementation(() => calls.push('scrollTo'));
    vi.spyOn(window, 'scrollBy').mockImplementation(() => calls.push('scrollBy'));
    return calls;
  }

  it('through the whole loop, the page is never scrolled and the pane never switches by itself', async () => {
    const calls = spies();
    const { user } = await setup({ compact: true });
    expect(gamePane().hidden).toBe(false);
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    await new Promise((r) => setTimeout(r, 700)); // the old code re-scrolled 650ms later
    expect(gamePane().hidden).toBe(false);
    expect(modPane().hidden).toBe(true);
    expect(calls).toEqual([]);
  });
  it('tells the visitor to open the Moderator tab, and pulses it (with its count) instead of switching', async () => {
    const { user } = await setup({ compact: true });
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    const modTab = within(tabs).getAllByRole('button')[1] as HTMLElement;
    expect(modTab.hasAttribute('data-pulse')).toBe(false); // step 1 is about the game
    await oneTapReport(user);
    await closeReport(user);
    await waitFor(() => expect(modTab.hasAttribute('data-pulse')).toBe(true));
    expect(modTab.textContent).toMatch(/1/);
    await user.click(within(tour() as HTMLElement).getByRole('button', { name: /step 2 of 4/i }));
    expect(tour()?.textContent).toMatch(/open the moderator tab/i);
    expect(document.querySelector('[data-tour-target]')).toBe(modTab); // the ring is on the tab
  });
  it('the tab press is the only thing that changes the pane, and it scrolls nothing', async () => {
    const calls = spies();
    const { user } = await setup({ compact: true });
    await oneTapReport(user);
    await closeReport(user);
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    await user.click(within(tabs).getAllByRole('button')[1] as HTMLElement);
    expect(modPane().hidden).toBe(false);
    expect(gamePane().hidden).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(calls).toEqual([]);
  });
  it('no longer carries the code that scrolled it: the settle re-scroll and the target scrollIntoView', () => {
    expect(demoSrc).not.toMatch(/SETTLE_CANCEL|scrolledTo|stopSettle/);
    expect(demoSrc).not.toMatch(/target\.scrollIntoView/);
  });
});

describe('calmer motion (fix I)', () => {
  const styles = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').split('\r\n').join('\n');
  it('a new chat line fades in for 120ms with no translate or scale', () => {
    const frame = /@keyframes msg-fade\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(frame).toMatch(/opacity/);
    expect(frame).not.toMatch(/translate|scale/);
    // (the hero keeps its staged, travelling arrival: msg-in in styles.css)
    expect(styles).toMatch(/@keyframes msg-in/);
    const chatLine = bodies('.chat .msg').join(';');
    expect(chatLine).toMatch(/animation:\s*msg-fade 0\.12s/);
    expect(chatLine).not.toMatch(/cubic-bezier/);
  });
  it('keeps the stamp slam, which is the point of a blocked line', () => {
    expect(styles).toMatch(/@keyframes stamp-slam/);
    expect(bodies('.chat .msg-refused .stamp').join(';')).toMatch(/animation-delay/);
  });
  it('turns every animation off under prefers-reduced-motion', () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/);
  });
});

describe('the reasons Bo’s report can name (the tour tells the visitor to pick "Insults or harassment")', () => {
  it('that reason maps to exactly one rule, so the hub card pre-selects it and shows the suggestion at once', async () => {
    const harassment = DEFAULT_REPORT_REASONS.find((r) => r.id === 'harassment');
    expect({ label: harassment?.label, rules: harassment?.rules }).toEqual({ label: 'Insults or harassment', rules: [2] });
    const { user } = await setup();
    await reasonedReport(user, undefined, 'harassment');
    await closeReport(user);
    const card = await openCase(user);
    expect(within(modPane()).queryByRole('combobox', { name: /which rule does this break/i })).toBeNull();
    await within(card).findByRole('button', { name: /^restrict chat, 24 hours/i });
  });
});
