import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RawWho } from '@chatwarden/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld, scripted } from './chat-world.js';
import type { ChatWorld, ChatWorldOptions } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// The chat box under a room's mode, over the REAL kit and the REAL broadcaster. A lock or an emergency is one status line above the composer; a viewer who cannot post gets a composer that is aria-disabled (still in
// the tab order, its description the status line), never a vanished input. Refusals of the mode have words of their own. Nothing is assertive.

const MIN = 60_000;
const ROOM = 'lobby';

/** Account ids say their age: `new-*` is a day old, `old-*` is 90 days. */
const signals = { accountAgeDays: (ids: readonly string[]) => (ids[0]?.startsWith('new-') === true ? 1 : ids[0]?.startsWith('old-') === true ? 90 : undefined) };
const clockText = (ms: number): string => new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: 'UTC' }).format(ms).replace(new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, 'g'), ' ');

let w: ChatWorld;
const make = async (o: ChatWorldOptions = {}): Promise<void> => {
  w = await chatWorld({ signals, ...o });
};
afterEach(() => w.close());

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room={ROOM} {...FIXED} now={w.clock.now} {...props} />;
const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Send' });
async function join(name: string, extra: { who?: RawWho; member?: { staff?: boolean } } = {}) {
  const transport = w.transportFor(name, {}, { ...(extra.who === undefined ? {} : { who: extra.who }), ...(extra.member === undefined ? {} : { member: extra.member }) });
  const view = renderUi(box(transport));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport };
}
const veteran = (name: string) => ({ accountId: `old-${name}` });
const newbie = (name: string) => ({ accountId: `new-${name}` });

describe('a locked room', () => {
  it('a locked hello disables the composer with aria-disabled and "Chat is locked until ..." as its description; the composer stays in the tab order', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    await join('snerp', { who: veteran('snerp') });
    const until = w.clock.t + 30 * MIN;
    const line = `Chat is locked until ${clockText(until)}.`;
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-disabled', 'true');
    expect(input()).not.toBeDisabled();
    expect(input()).toHaveAttribute('readonly');
    expect(input()).not.toHaveAttribute('tabindex', '-1');
    expect(input()).toHaveAccessibleDescription(line);
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    expect(sendButton()).not.toBeDisabled();
    input().focus();
    expect(input()).toHaveFocus();
  });

  it('typing and Send do nothing while it is locked: nothing is sent', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    const { transport } = await join('snerp', { who: veteran('snerp') });
    fireEvent.change(input(), { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.click(sendButton());
    });
    expect(transport.sent).toEqual([]);
  });

  it('a mode frame back to normal removes both the status line and the disabled state', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    await join('snerp', { who: veteran('snerp') });
    expect(input()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      w.real.rooms.setMode(ROOM, 'normal');
    });
    await waitFor(() => expect(input()).not.toHaveAttribute('aria-disabled', 'true'));
    expect(input()).not.toHaveAttribute('readonly');
    expect(screen.queryByText(/Chat is locked/)).toBeNull();
    expect(sendButton()).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a lock that arrives while the box is open disables it', async () => {
    await make();
    await join('snerp', { who: veteran('snerp') });
    expect(input()).not.toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    });
    await waitFor(() => expect(input()).toHaveAttribute('aria-disabled', 'true'));
  });

  it('a staff viewer sees the line but can type and send in a locked room', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    const { transport } = await join('modmo', { who: veteran('modmo'), member: { staff: true } });
    // Not "Chat is locked until ...": that would sit above an input that works. It says whom the lock is for.
    expect(screen.getByText(`Chat is locked for players until ${clockText(w.clock.t + 30 * MIN)}.`)).toBeInTheDocument();
    expect(screen.queryByText(/^Chat is locked until/)).toBeNull();
    expect(input()).not.toHaveAttribute('aria-disabled', 'true');
    expect(input()).not.toHaveAttribute('readonly');
    fireEvent.change(input(), { target: { value: 'a staff line' } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    await waitFor(() => expect(transport.sent).toEqual(['a staff line']));
    expect(within(screen.getByRole('log', { name: 'Chat' })).getByText('a staff line')).toBeInTheDocument();
  });

  it('a staff viewer in a lock is told it is for players, and a player in the same room still reads the plain line (control)', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    const mod = await join('modmo', { who: veteran('modmo'), member: { staff: true } });
    expect(screen.queryByText(/Chat is locked until/)).toBeNull();
    expect(screen.getByText(/Chat is locked for players/)).toBeInTheDocument();
    mod.unmount();
    await join('snerp', { who: veteran('snerp') });
    expect(screen.getByText(/^Chat is locked until/)).toBeInTheDocument();
    expect(screen.queryByText(/locked for players/)).toBeNull();
  });

  it('a staff viewer is not told the room is locked "for players" once it is back to normal, and an emergency line is the same for staff', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 30 * MIN });
    await join('modmo', { who: veteran('modmo'), member: { staff: true } });
    expect(screen.getByText('Slow mode is on.')).toBeInTheDocument();
    expect(screen.queryByText(/locked/)).toBeNull();
    await act(async () => {
      w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    });
    await waitFor(() => expect(screen.getByText(/Chat is locked for players/)).toBeInTheDocument());
    await act(async () => {
      w.real.rooms.setMode(ROOM, 'normal');
    });
    await waitFor(() => expect(screen.queryByText(/locked/)).toBeNull());
  });

  it('the history is still shown in a locked room', async () => {
    await make();
    w.say(ROOM, 'wumbo', 'an earlier line', 'old-wumbo');
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    await join('snerp', { who: veteran('snerp') });
    expect(within(screen.getByRole('log', { name: 'Chat' })).getByText('an earlier line')).toBeInTheDocument();
  });
});

describe('an emergency', () => {
  it('shows "Slow mode is on." and, for a read-only new account, "New accounts can only read right now."', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 30 * MIN });
    await join('newbie', { who: newbie('newbie') });
    const status = screen.getByText('Slow mode is on.', { exact: false });
    expect(status).toHaveTextContent('Slow mode is on.');
    expect(status).toHaveTextContent('New accounts can only read right now.');
    expect(input()).toHaveAttribute('aria-disabled', 'true');
    expect(input()).toHaveAccessibleDescription('Slow mode is on. New accounts can only read right now.');
  });

  it('a veteran account in an emergency sees "Slow mode is on." only and can type', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 30 * MIN });
    await join('vet', { who: veteran('vet') });
    expect(screen.getByText('Slow mode is on.')).toBeInTheDocument();
    expect(screen.queryByText(/New accounts can only read/)).toBeNull();
    expect(input()).not.toHaveAttribute('aria-disabled', 'true');
    expect(input()).toHaveAccessibleDescription('Slow mode is on.');
  });

  it('with no age hook an unknown age is not read-only (unknownAge allow)', async () => {
    await make({ signals: {} });
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 30 * MIN });
    await join('anon');
    expect(input()).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('what a refusal says', () => {
  const refuse = async (refuse: Record<string, unknown>) => {
    await make({ wrap: scripted(() => ({ refuse: refuse as never })) });
    await join('snerp', { who: veteran('snerp') });
    fireEvent.change(input(), { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
  };

  it('locked: "Chat is locked until ..." with the time', async () => {
    await refuse({ reason: 'locked', until: 1_800_000_000_000 + 30 * MIN });
    expect(await screen.findByText(`Chat is locked until ${clockText(1_800_000_000_000 + 30 * MIN)}.`)).toBeInTheDocument();
  });

  it('new_account: its own words', async () => {
    await refuse({ reason: 'new_account', until: 1_800_000_000_000 + 30 * MIN });
    expect(await screen.findByText('New accounts can only read right now.')).toBeInTheDocument();
  });

  it('probation: its own words with the wait, and Send is held for it', async () => {
    await refuse({ reason: 'probation', retryAfterMs: 4000 });
    expect(await screen.findByText('New accounts chat a little slower. You can send another message in 4 seconds.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('probation with no usable wait says it without a time', async () => {
    await refuse({ reason: 'probation' });
    expect(await screen.findByText('New accounts chat a little slower. Please wait a moment before sending another message.')).toBeInTheDocument();
  });

  it('a locked refusal with no end says so without a time; an unknown reason falls back to the generic line', async () => {
    await refuse({ reason: 'locked' });
    expect(await screen.findByText('Chat is locked right now.')).toBeInTheDocument();
  });

  it('an unknown reason is the generic line', async () => {
    await refuse({ reason: 'some_future_reason' });
    expect(await screen.findByText('That message was not sent.')).toBeInTheDocument();
  });

  it('the refusal never says why the room is locked or who did it', async () => {
    await refuse({ reason: 'locked', until: 1_800_000_000_000 + 30 * MIN, seat: 'p1', handle: 'Tgt', text: 'zorbak' });
    const html = document.body.innerHTML;
    for (const leak of ['p1', 'Tgt', 'zorbak', 'moderator']) expect(html, leak).not.toContain(leak);
  });
});

describe('announcements', () => {
  it('a mode change goes to the polite live region once; nothing in the box is assertive', async () => {
    await make();
    const { container } = await join('snerp', { who: veteran('snerp') });
    await act(async () => {
      w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    });
    const status = await screen.findByText(/Chat is locked until/);
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByText(/Chat is locked until/)).toHaveLength(1);
    expect(container.querySelector('[aria-live="assertive"], [role="alert"]')).toBeNull();
  });

  it('a mode of the same kind and end sent again does not change the text', async () => {
    await make();
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 30 * MIN });
    const { transport } = await join('snerp', { who: veteran('snerp') });
    const before = screen.getByText(/Chat is locked until/).textContent;
    await act(async () => {
      transport.inject({ type: 'mode', mode: { kind: 'locked', until: w.clock.t + 30 * MIN }, readOnly: 'locked' });
    });
    expect(screen.getByText(/Chat is locked until/).textContent).toBe(before);
  });
});

describe('versions', () => {
  it('a v1 hello is refused as an unsupported server with the existing offline wording and no retry loop', async () => {
    await make();
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await act(async () => {
      transport.inject({ type: 'hello', v: 1, epoch: 'e', room: ROOM, you: { name: 'snerp' }, maxLength: 200, heartbeatMs: 20_000, summary: 's', restriction: null, lines: [], muted: [] } as never);
    });
    expect(await screen.findByText('Chat is not working here right now.')).toBeInTheDocument();
    expect(transport.opened.every((o) => o.closed || o.session !== null)).toBe(true);
  });

  it('a v3 hello is refused the same way', async () => {
    await make();
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await act(async () => {
      transport.inject({ type: 'hello', v: 3, epoch: 'e', room: ROOM, you: { name: 'snerp' }, mode: { kind: 'normal', until: null }, maxLength: 200, heartbeatMs: 20_000, summary: 's', restriction: null, lines: [], muted: [] } as never);
    });
    expect(await screen.findByText('Chat is not working here right now.')).toBeInTheDocument();
  });
});
