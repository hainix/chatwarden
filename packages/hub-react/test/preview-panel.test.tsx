import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeOp } from '@chatwarden/core/notice-copy';
import { LazyPlayerPreview, partLoaders, resetLazyParts } from '../src/lazyParts.js';
import type { PlayerPreviewProps } from '../src/preview/PlayerPreview.js';
import { HubProvider } from '../src/provider.js';
import { appealsHub } from './appealsWorld.js';
import { renderPieces } from './pieces-kit.js';
import { renderHub } from './render.js';
import { hubWorld, DAY, HOUR } from './world.js';
import type { HubWorld } from './world.js';

// "What the player sees" (0.2.0): the panel, on its own, over a plan the form asks for. The words of the notice are core's; these tests hold what the
// panel draws around them: the nothing-sent lines, the effects, who is told, the live sentence. Synthetic terms only.

const NAME = () => 'Mallory';
const region = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'What the player sees' });

async function mount(w: HubWorld, op: NoticeOp | null, more: Partial<PlayerPreviewProps> = {}) {
  const r = renderPieces(w, <LazyPlayerPreview op={op} nameOf={NAME} {...more} />);
  return { ...r, panel: await region() };
}
function HubProviderAgain({ w, children }: { w: HubWorld; children: ReactNode }) {
  return (
    <HubProvider client={w.client} now={w.now} mode="detailed">
      {children}
    </HubProvider>
  );
}

/** A panel that can be given a new op: returns `set`. With fake timers on, the page is let to settle by hand (the Testing Library waits would never end). */
async function live(w: HubWorld, first: NoticeOp | null, more: Partial<PlayerPreviewProps> = {}) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = (op: NoticeOp | null) => (
    <HubProviderAgain w={w}>
      <LazyPlayerPreview op={op} nameOf={NAME} {...more} />
    </HubProviderAgain>
  );
  const r = render(view(first));
  if (vi.isFakeTimers()) {
    for (let i = 0; i < 20 && screen.queryByRole('region', { name: 'What the player sees' }) === null; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
    }
    expect(screen.queryByRole('region', { name: 'What the player sees' })).not.toBeNull();
  } else await region();
  return { ...r, user, set: (op: NoticeOp | null) => r.rerender(view(op)) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('nothing sent', () => {
  it('a note: "Nothing is sent to the player. Only your team sees this note."', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'note' });
    expect(panel).toHaveTextContent('Nothing is sent to the player. Only your team sees this note.');
    expect(within(panel).queryByRole('heading', { level: 4 })).toBeNull();
  });

  it('a direct chat restriction: no notice, and the chat-box line the player will see, with its end', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind: 'chat', durationMs: DAY });
    expect(panel).toHaveTextContent('No notice is sent. Only a decision on a report sends one.');
    expect(panel).toHaveTextContent('This is what the chat box shows them when they next try to type:');
    expect(panel).toHaveTextContent(/A moderator turned off your chat until .+ \(in 24 hours\)\./);
    expect(panel.querySelector('.cw-pv-chatline .cw-card--restriction')).not.toBeNull();
    expect(within(panel).queryByRole('heading', { level: 4 })).toBeNull();
  });

  it('a direct restriction with no end reads the no-end line', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind: 'chat', durationMs: null });
    expect(panel).toHaveTextContent('A moderator turned off your chat. It does not end on its own.');
  });

  it.each([
    ['area', DAY],
    ['ban', null],
  ] as const)('a direct %s: the game shows its own message and the kit sends none', async (kind, durationMs) => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind, durationMs });
    expect(panel).toHaveTextContent('Your game shows its own message when they try to join; the kit sends none.');
    expect(panel.querySelector('.cw-pv-chatline')).toBeNull();
  });

  it.each([
    ['area', DAY, /They cannot join public rooms until .+\./],
    ['area', null, /They cannot join public rooms until a moderator lifts it\./],
    ['ban', 7 * DAY, /They are banned until .+\./],
    ['ban', null, /They are banned until a moderator lifts it\./],
  ] as const)('a direct %s (%s): its end-time line is shown, as the notice of a decision would say it', async (kind, durationMs, line) => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind, durationMs });
    const effects = [...panel.querySelectorAll('.cw-pv-effects li')].map((n) => n.textContent ?? '');
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatch(line);
  });

  it('a direct chat restriction shows its end once, in the drawn chat line, not again as an effect', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind: 'chat', durationMs: DAY });
    expect(panel.querySelector('.cw-pv-effects')).toBeNull();
    expect(panel.textContent?.match(/cannot chat until/g) ?? []).toHaveLength(0);
  });

  it('a direct warning: staff only', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind: 'warning', durationMs: null });
    expect(panel).toHaveTextContent("A warning from a person's page is on their record for staff only.");
  });

  it('a dismissal says nothing is sent to anyone', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'dismiss' });
    expect(panel).toHaveTextContent('Nothing is sent to anyone. The report is closed.');
  });

  it('nothing chosen: the prompt, and the choose-a-rule prompt for a rename', async () => {
    const w = await hubWorld();
    const first = await mount(w, null);
    expect(first.panel).toHaveTextContent('Choose what happens to see what the player is sent.');
    first.unmount();
    const second = await mount(w, null, { prompt: 'chooseRule' });
    expect(second.panel).toHaveTextContent('Choose a rule to see the notice they would get.');
  });
});

describe('a rename', () => {
  it('shows the rename notice with the rule label and "They are asked to pick a new name before they can chat."', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'rename', rule: 7 });
    expect(within(panel).getByRole('heading', { level: 4, name: 'Please choose a new name' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('Choose a new name to keep playing.');
    expect(panel).toHaveTextContent('RuleCommunity Rule 7: No offensive names');
    expect(panel).toHaveTextContent('They are asked to pick a new name before they can chat.');
    // No end, no reference, no lines on a rename.
    expect(panel.querySelector('dt')?.textContent).toBe('Rule');
    expect(panel.querySelectorAll('dt')).toHaveLength(1);
    expect(panel).toHaveTextContent('Button: Got it');
  });

  it('without sanctions: a rule the kit does not list still reads as the kit reads it', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'rename', rule: 99 });
    expect(panel).toHaveTextContent('Community Rule 99');
  });
});

describe('revoke', () => {
  it.each([
    ['chat', 'They can chat again at once.'],
    ['area', 'They can join public rooms again.'],
    ['ban', 'They are no longer banned.'],
    ['warning', 'The warning is taken off their record.'],
  ] as const)('%s: no new notice, what lifts, and that an unseen notice is never shown', async (kind, line) => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'revoke', kind });
    expect(panel).toHaveTextContent('No new notice is sent. A notice they have not seen is never shown; one they have seen leaves their record.');
    expect(panel).toHaveTextContent(line);
    expect(within(panel).queryByRole('heading', { level: 4 })).toBeNull();
    expect(panel).not.toHaveTextContent('appeal');
  });

  it('a note: nothing changes for the player', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'revoke', kind: 'note' });
    expect(panel).toHaveTextContent('Nothing changes for the player. Only your team sees this note.');
  });

  it('the appeals line only with appeals on', async () => {
    const off = await mount(await hubWorld({ role: 'senior' }), { op: 'revoke', kind: 'chat' });
    expect(off.panel).not.toHaveTextContent('the appeal is closed');
    off.unmount();
    const w = await appealsHub({ role: 'senior' });
    const on = await mount(w, { op: 'revoke', kind: 'chat' });
    await waitFor(() => expect(on.panel).toHaveTextContent('If they appealed, the appeal is closed with no message.'));
  });
});

describe('live', () => {
  it('changing the kind, the length or the IP line changes the panel at once; nothing is shown until a kind is chosen', async () => {
    const w = await hubWorld();
    const r = await live(w, null);
    const panel = (): HTMLElement => screen.getByRole('region', { name: 'What the player sees' });
    expect(panel()).toHaveTextContent('Choose what happens to see what the player is sent.');
    r.set({ op: 'sanction', kind: 'chat', durationMs: HOUR });
    await waitFor(() => expect(panel()).toHaveTextContent('(in 1 hour)'));
    r.set({ op: 'sanction', kind: 'chat', durationMs: 7 * DAY });
    await waitFor(() => expect(panel()).toHaveTextContent('(in 7 days)'));
    r.set({ op: 'sanction', kind: 'ban', durationMs: null });
    await waitFor(() => expect(panel()).toHaveTextContent('Your game shows its own message'));
    expect(panel()).not.toHaveTextContent('chat box');
    r.set(null);
    await waitFor(() => expect(panel()).toHaveTextContent('Choose what happens'));
  });

  it('extra effect lines from the form (the IP) are listed beside the effects', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'sanction', kind: 'ban', durationMs: DAY }, { extraEffects: ['Their network address is also restricted for 24 hours.'] });
    expect(within(panel).getAllByRole('listitem').map((li) => li.textContent)).toContain('Their network address is also restricted for 24 hours.');
  });

  it('the end time moves with the clock: it is read again each minute', async () => {
    const w = await hubWorld();
    // The panel's code is fetched before the timers are faked, so the lazy chunk is there when the panel mounts.
    await partLoaders.playerPreview();
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const r = await live(w, { op: 'sanction', kind: 'chat', durationMs: 90 * 60_000 });
    const panel = (): HTMLElement => screen.getByRole('region', { name: 'What the player sees' });
    const first = /until (.+?) \(in 2 hours\)/.exec(panel().textContent ?? '');
    expect(first).not.toBeNull();
    w.clock.t += 30 * 60_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const later = /until (.+?) \((.+?)\)/.exec(panel().textContent ?? '');
    expect(later?.[1]).not.toBe(first?.[1]);
    expect(later?.[2]).toBe('in 2 hours');
    r.unmount();
  });
});

describe('who is told, in what order', () => {
  const decide = (over: Record<string, unknown> = {}): NoticeOp =>
    ({ op: 'decide', verdict: 'upheld', target: 'P-bob', reporter: 'P-rep', actions: [{ person: 'P-bob', kind: 'chat', durationMs: DAY, rule: 2, lines: [{ text: 'you are a *****', day: '2027-01-15' }] }], rename: null, ...over }) as NoticeOp;
  const names = (to: string): string => ({ 'P-bob': 'Bob', 'P-rep': 'Rae' })[to] ?? to;

  it('two people each under their own name; the reporter reads "who reported, sees"', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, decide(), { nameOf: names, reporter: 'P-rep' });
    expect(panel).toHaveTextContent('Bob sees');
    expect(panel).toHaveTextContent('Rae, who reported, sees');
    expect(panel.textContent?.indexOf('Bob sees')).toBeLessThan(panel.textContent?.indexOf('Rae, who reported, sees') ?? -1);
    expect(within(panel).getByRole('heading', { level: 4, name: 'Your chat is turned off' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { level: 4, name: 'Thanks for your report' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('Your messages that led to this');
    expect(panel).toHaveTextContent('you are a *****');
  });

  it('two notices for one person are numbered, and "The player sees them one at a time."', async () => {
    const w = await hubWorld();
    const op = decide({ rename: { rule: 7 } });
    const { panel } = await mount(w, op, { nameOf: names, reporter: 'P-rep' });
    expect(panel).toHaveTextContent('Notice 1 of 2');
    expect(panel).toHaveTextContent('Notice 2 of 2');
    expect(panel).toHaveTextContent('The player sees them one at a time.');
    const titles = within(panel).getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    // Each person's notices together: the reported person's sanction and then their rename (the core's order), then the reporter's thank-you.
    expect(titles).toEqual(['Your chat is turned off', 'Please choose a new name', 'Thanks for your report']);
  });

  it('rename plus a ban: the effect adds that they will be asked once they can play again', async () => {
    const w = await hubWorld();
    const op = decide({ actions: [{ person: 'P-bob', kind: 'ban', durationMs: null, rule: 2, lines: [] }], rename: { rule: 7 } });
    const { panel } = await mount(w, op, { nameOf: names, reporter: 'P-rep' });
    expect(panel).toHaveTextContent('They are asked to pick a new name before they can chat. They will be asked once they can play again.');
  });

  it('a warning shows Acknowledge and its hint; a chat restriction shows Got it and the appeal button only with appeals on', async () => {
    const off = await mount(await hubWorld(), decide({ actions: [{ person: 'P-bob', kind: 'warning', durationMs: null, rule: 2, lines: [] }] }), { nameOf: names, reporter: 'P-rep' });
    expect(off.panel).toHaveTextContent('Press Acknowledge to confirm you saw this.');
    expect(off.panel).toHaveTextContent('Button: Acknowledge');
    expect(off.panel).not.toHaveTextContent('Think this is a mistake?');
    off.unmount();
    const w = await appealsHub({ role: 'senior' });
    const on = await mount(w, decide(), { nameOf: names, reporter: 'P-rep' });
    await waitFor(() => expect(on.panel).toHaveTextContent('Button: Think this is a mistake?'));
    expect(on.panel).toHaveTextContent('Button: Got it');
  });

  it('the reference reads "Made when it is sent"', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, decide(), { nameOf: names, reporter: 'P-rep' });
    expect(panel).toHaveTextContent('ReferenceMade when it is sent');
  });

  it('a decision on two people names whose effect each line is', async () => {
    const w = await hubWorld();
    const op = decide({
      actions: [
        { person: 'P-bob', kind: 'chat', durationMs: DAY, rule: 2, lines: [] },
        { person: 'P-rep', kind: 'warning', durationMs: null, rule: 2, lines: [] },
      ],
      verdict: 'bad_faith',
    });
    const { panel } = await mount(w, op, { nameOf: names, reporter: 'P-rep' });
    expect(within(panel).getAllByRole('listitem').map((li) => li.textContent)).toContain('Bob: They cannot chat until ' + /until (.+?)\./.exec(panel.textContent ?? '')?.[1] + '.');
  });
});

describe('no focus, a calm box', () => {
  it('nothing in the panel can take focus, and the drawn buttons are spans', async () => {
    const w = await appealsHub({ role: 'senior' });
    const { panel } = await mount(w, { op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b', actions: [{ person: 'a', kind: 'warning', durationMs: null, rule: 2, lines: [] }], rename: { rule: 7 } } as NoticeOp, { nameOf: () => 'A', reporter: 'b' });
    expect(panel.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
    const buttons = [...panel.querySelectorAll('.cw-pv-btn')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.tagName).toBe('SPAN');
  });

  it('the notice block says lang="en"; the heading is an h3 and the caption says the preview is in English', async () => {
    const w = await hubWorld();
    const { panel } = await mount(w, { op: 'rename', rule: 2 });
    expect(panel.querySelector('.cw-pv-notice')).toHaveAttribute('lang', 'en');
    expect(within(panel).getByRole('heading', { level: 3, name: 'What the player sees' })).toBeInTheDocument();
    expect(panel).toHaveTextContent("Shown in the player's language. This preview is in English.");
  });
});

describe('the live sentence', () => {
  it('is silent on the first render, then said once, 600 ms after a change, and only when it changed', async () => {
    const w = await hubWorld();
    await partLoaders.playerPreview();
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const said: string[] = [];
    const r = await live(w, null, { announce: (s) => void said.push(s) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(said).toEqual([]);
    r.set({ op: 'rename', rule: 7 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(said).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(said).toEqual(['Preview updated: they see Please choose a new name.']);
    // The same plan again says nothing more.
    r.set({ op: 'rename', rule: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(said).toHaveLength(1);
    r.set({ op: 'note' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(said.at(-1)).toBe('Preview updated: nothing is sent.');
    r.unmount();
  });

  it('a change inside the 600 ms restarts the wait; only the last is said', async () => {
    const w = await hubWorld();
    await partLoaders.playerPreview();
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const said: string[] = [];
    const r = await live(w, null, { announce: (s) => void said.push(s) });
    r.set({ op: 'rename', rule: 7 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    r.set({ op: 'note' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(said).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(said).toEqual(['Preview updated: nothing is sent.']);
    r.unmount();
  });

  it('without an announce prop the panel keeps its own polite region', async () => {
    const w = await hubWorld();
    await partLoaders.playerPreview();
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const r = await live(w, null);
    const region = (): HTMLElement => screen.getByRole('region', { name: 'What the player sees' }).querySelector('[role="status"]') as HTMLElement;
    expect(region()).toHaveTextContent('');
    expect(region()).toHaveAttribute('aria-live', 'polite');
    r.set({ op: 'note' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(region()).toHaveTextContent('Preview updated: nothing is sent.');
    r.unmount();
  });
});

describe('the panel waits for what it words itself with', () => {
  const rename = { op: 'rename', rule: 7 } as NoticeOp;

  it('is not drawn until the rules\' titles have arrived, so a label never shows without its title and then changes', async () => {
    const w = await hubWorld();
    let release!: () => void;
    const gate = new Promise<undefined>((res) => {
      release = () => res(undefined);
    });
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/policy' ? gate : undefined);
    await partLoaders.playerPreview();
    renderPieces(w, <LazyPlayerPreview op={rename} nameOf={NAME} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole('region', { name: 'What the player sees' })).toBeNull();
    expect(document.body.textContent).not.toContain('Community Rule 7');
    release();
    const panel = await region();
    expect(panel).toHaveTextContent('Community Rule 7: No offensive names');
  });

  it('a policy that cannot be read does not hold the panel back: it shows the number alone', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/policy' ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    const { panel } = await mount(w, rename);
    expect(panel).toHaveTextContent('Community Rule 7');
    expect(panel).not.toHaveTextContent('No offensive names');
  });

  it('a role that cannot read the policy gets the panel at once, with the numbers alone', async () => {
    const w = await hubWorld({ permissions: { 'policy.read': 'owner' } });
    const { panel } = await mount(w, rename);
    expect(panel).toHaveTextContent('Community Rule 7');
    expect(panel).not.toHaveTextContent('No offensive names');
    expect(w.sent.filter((r) => r.path === '/policy')).toHaveLength(0);
  });
});

describe('the time is read when the form changes', () => {
  it('a changed form is worded against the time now, not the minute-old time of the last tick', async () => {
    const w = await hubWorld();
    const r = await live(w, { op: 'sanction', kind: 'chat', durationMs: 2 * 3_600_000 });
    const panel = (): HTMLElement => screen.getByRole('region', { name: 'What the player sees' });
    const endOf = (): string => /until (.+?) \(in/.exec(panel().textContent ?? '')?.[1] ?? '';
    const first = endOf();
    expect(first).not.toBe('');
    // Half an hour passes on the world's clock and no minute tick has fired; the moderator changes the form.
    w.clock.t += 30 * 60_000;
    r.set({ op: 'sanction', kind: 'chat', durationMs: 2 * 3_600_000 + 1 });
    await waitFor(() => expect(endOf()).not.toBe(first));
    expect(panel()).toHaveTextContent(/\(in 2 hours\)/);
    r.unmount();
  });
});

describe('when the panel\'s code cannot be loaded', () => {
  const real = { ...partLoaders };
  afterEach(() => {
    Object.assign(partLoaders, real);
    resetLazyParts();
  });

  it('says so in one short line, never silently, and asks for the code again the next time it is drawn', async () => {
    resetLazyParts();
    partLoaders.playerPreview = () => Promise.reject(new Error('offline'));
    const w = await hubWorld();
    const r = renderPieces(w, <LazyPlayerPreview op={{ op: 'note' }} nameOf={NAME} />);
    expect(await screen.findByText('The preview could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What the player sees' })).toBeNull();
    r.unmount();
    Object.assign(partLoaders, real);
    const again = renderPieces(w, <LazyPlayerPreview op={{ op: 'note' }} nameOf={NAME} />);
    expect(await region()).toHaveTextContent('Nothing is sent to the player.');
    expect(screen.queryByText('The preview could not be loaded.')).toBeNull();
    again.unmount();
  });

  it('a part that fails inside the hub (the decision bar) leaves the form and its Decide button in place', async () => {
    resetLazyParts();
    partLoaders.playerPreview = () => Promise.reject(new Error('offline'));
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({});
    renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    const bar = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(bar).findByText('The preview could not be loaded.')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Decide' })).toBeInTheDocument();
  });
});
