import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import * as chatEntry from '../src/chat/index.js';
import type { ChatTransport } from '../src/chat/transport.js';
import type { ChatFrame, MuteResult } from '../src/chat/wire.js';
import { chatWorld, scripted, T0 } from './chat-world.js';
import type { ChatWorld, LocalTransport } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

let w: ChatWorld;
beforeEach(async () => {
  w = await chatWorld();
});
afterEach(() => w.close());

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const texts = (): string[] => within(log()).queryAllByRole('listitem').map((li) => (li.querySelector('.cw-chat-text')?.textContent ?? ''));
const lineId = (r: ReturnType<ChatWorld['say']>): string => {
  if (!r.ok) throw new Error('refused');
  return r.line.id;
};

/** A transport that drops the server's `hide` frames (a reconnect in the gap), and answers a mute as the box's caller dictates. */
function gappy(inner: LocalTransport, answer: (ok: boolean) => Promise<boolean | MuteResult>): ChatTransport {
  return {
    open: (room, events) => {
      const conn = inner.open(room, { status: events.status, frame: (f) => (f.type === 'hide' ? undefined : events.frame(f)) });
      return {
        ...conn,
        mute: async (target, on) => {
          const real = await conn.mute(target, on);
          return answer(typeof real === 'boolean' ? real : real.ok);
        },
      };
    },
  };
}

async function muteFirst(user: ReturnType<typeof renderUi>['user'], name: string): Promise<void> {
  const [control] = within(log()).getAllByRole('button', { name: `Options for this message from ${name}` });
  await user.click(control as HTMLElement);
  await user.click(within(log()).getByRole('button', { name: `Mute ${name}` }));
}

describe('a mute hides by line id, never by name', () => {
  it('two players with the same name: muting one leaves the other\'s lines', async () => {
    w.say('lobby', 'tarvo', 'A one', 'tarvo-a');
    w.say('lobby', 'tarvo', 'B one', 'tarvo-b');
    w.say('lobby', 'tarvo', 'A two', 'tarvo-a');
    w.say('lobby', 'tarvo', 'B two', 'tarvo-b');
    const inner = w.transportFor('snerp');
    const { user } = renderUi(box(inner));
    await screen.findByRole('textbox', { name: 'Message' });
    await muteFirst(user, 'tarvo');
    await waitFor(() => expect(texts()).toEqual(['B one', 'B two']));
  });

  it('the same with the server\'s hide frames lost: only the clicked line goes at once, nothing by name', async () => {
    w.say('lobby', 'tarvo', 'A one', 'tarvo-a');
    w.say('lobby', 'tarvo', 'B one', 'tarvo-b');
    w.say('lobby', 'tarvo', 'A two', 'tarvo-a');
    const inner = w.transportFor('snerp');
    const { user } = renderUi(box(gappy(inner, (ok) => Promise.resolve(ok))));
    await screen.findByRole('textbox', { name: 'Message' });
    await muteFirst(user, 'tarvo');
    await waitFor(() => expect(texts()).toEqual(['B one', 'A two']));
  });

  it('with the mute answer\'s hiddenIds, exactly those lines go', async () => {
    const a1 = lineId(w.say('lobby', 'tarvo', 'A one', 'tarvo-a'));
    w.say('lobby', 'tarvo', 'B one', 'tarvo-b');
    const a2 = lineId(w.say('lobby', 'tarvo', 'A two', 'tarvo-a'));
    w.say('lobby', 'tarvo', 'B two', 'tarvo-b');
    const inner = w.transportFor('snerp');
    const { user } = renderUi(box(gappy(inner, (ok) => Promise.resolve({ ok, hiddenIds: [a1, a2] }))));
    await screen.findByRole('textbox', { name: 'Message' });
    await muteFirst(user, 'tarvo');
    await waitFor(() => expect(texts()).toEqual(['B one', 'B two']));
  });

  it('hiddenIds that are not strings, or not held, change nothing', async () => {
    w.say('lobby', 'tarvo', 'A one', 'tarvo-a');
    w.say('lobby', 'tarvo', 'B one', 'tarvo-b');
    const inner = w.transportFor('snerp');
    const { user } = renderUi(box(gappy(inner, (ok) => Promise.resolve({ ok, hiddenIds: [7, null, 'nope'] as never }))));
    await screen.findByRole('textbox', { name: 'Message' });
    await muteFirst(user, 'tarvo');
    await waitFor(() => expect(texts()).toEqual(['B one']));
  });

  it('a reconnect in the gap still ends with the right lines hidden (hello first, then the answer)', async () => {
    const a1 = lineId(w.say('lobby', 'tarvo', 'A one', 'tarvo-a'));
    w.say('lobby', 'tarvo', 'B one', 'tarvo-b');
    const a2 = lineId(w.say('lobby', 'tarvo', 'A two', 'tarvo-a'));
    const inner = w.transportFor('snerp');
    let release: (() => void) | null = null;
    const held = gappy(inner, (ok) => new Promise((resolve) => (release = () => resolve({ ok, hiddenIds: [a1, a2] }))));
    const { user } = renderUi(box(held));
    await screen.findByRole('textbox', { name: 'Message' });
    await muteFirst(user, 'tarvo');
    await waitFor(() => expect(release).not.toBeNull());
    // the stream reconnects while the answer is on its way: the new hello is the server's (it respects the mute)
    const hello = await new Promise<ChatFrame>((resolve) => {
      const s = w.chat.session('lobby', w.who('snerp'), w.member('snerp'));
      if ('refused' in s) throw new Error('refused');
      const stream = s.open({ write: (f) => { if (f.type === 'hello') resolve(structuredClone(f)); } });
      if ('refused' in stream) throw new Error('refused');
      stream.close();
    });
    act(() => inner.inject(hello));
    // the snapshot cannot say which older lines were hidden (it only lacks them); the answer does
    expect(texts()).toContain('B one');
    await act(async () => {
      (release as unknown as () => void)();
    });
    expect(texts()).toEqual(['B one']);
  });

  it('a reconnect in the gap (answer first, then a hello that still carries the lines the server had not yet muted) ends hidden by the next server state', async () => {
    const a1 = lineId(w.say('lobby', 'tarvo', 'A one', 'tarvo-a'));
    w.say('lobby', 'tarvo', 'B one', 'tarvo-b');
    const inner = w.transportFor('snerp');
    const { user } = renderUi(box(gappy(inner, (ok) => Promise.resolve({ ok, hiddenIds: [a1] }))));
    await screen.findByRole('textbox', { name: 'Message' });
    await muteFirst(user, 'tarvo');
    await waitFor(() => expect(texts()).toEqual(['B one']));
    // A's later line is the server's to skip: nothing returns it
    await act(async () => {
      w.say('lobby', 'tarvo', 'A later', 'tarvo-a');
      w.say('lobby', 'tarvo', 'B later', 'tarvo-b');
    });
    expect(texts()).toEqual(['B one', 'B later']);
  });
});

describe('the chat entry', () => {
  it('exports enChat, so a translator has a catalog to copy', () => {
    expect(chatEntry.enChat['player.chat.send']).toBe('Send');
    expect(Object.keys(chatEntry.enChat).length).toBeGreaterThan(40);
  });
});

describe('closed is terminal but can be retried', () => {
  it.each(['unauthorized', 'forbidden', 'not_found', 'unsupported', 'shutdown', 'room_closed'] as const)('%s offers Try again, which reopens the stream', async (why) => {
    const transport = w.transportFor('snerp');
    const { user } = renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.status('closed', why));
    const again = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    await user.click(again);
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(transport.opened).toHaveLength(2);
    expect(transport.opened[0]?.closed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a ban does not offer it', async () => {
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.status('closed', 'banned'));
    await screen.findByText(/You are banned/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('the button is worded through t()', async () => {
    const { createT, en } = await import('../src/i18n.js');
    const t = createT({ ...en, 'player.state.retry': 'Nochmal' }, 'en');
    const transport = w.transportFor('snerp');
    renderUi(box(transport, { t }));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.status('closed', 'unauthorized'));
    expect(await screen.findByRole('button', { name: 'Nochmal' })).toBeInTheDocument();
  });
});

describe('a restriction with a client clock that is wrong', () => {
  const AHEAD = 5 * 60_000;

  it('a restricted refusal shows RestrictedChatLine whatever the local clock says', async () => {
    w.close();
    w = await chatWorld({ wrap: scripted((_r, _s, text) => (text === 'late' ? { refuse: { reason: 'restricted', until: T0 + 60_000, byModerator: true } } : undefined)) });
    renderUi(box(w.transportFor('snerp'), { now: () => T0 + AHEAD }));
    const field = await screen.findByRole('textbox', { name: 'Message' });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(field, { target: { value: 'late' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(await screen.findByText(/A moderator turned off your chat/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.queryByText('That message was not sent.')).toBeNull();
  });

  it("after a live line, the server's clock is known: a restriction lands against it, not against the player's clock", async () => {
    renderUi(box(w.transportFor('snerp'), { now: () => T0 + AHEAD }));
    await screen.findByRole('textbox', { name: 'Message' });
    await act(async () => {
      w.say('lobby', 'tarvo', 'a line to learn the time from');
    });
    await within(log()).findByText('a line to learn the time from');
    await w.sanction('chat', 'lobby', 'snerp', 60_000);
    expect(await screen.findByText(/A moderator turned off your chat until/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    // the countdown is the server's: about a minute, not "ended"
    expect(screen.getByText(/in 1 minute|in 60 seconds/)).toBeInTheDocument();
  });

  it('the hello carries the server clock: a restriction in the first hello is read against it, with no line seen yet', async () => {
    await w.sanction('chat', 'lobby', 'snerp', 60_000);
    renderUi(box(w.transportFor('snerp'), { now: () => T0 + AHEAD }));
    expect(await screen.findByText(/A moderator turned off your chat until/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.getByText(/in 1 minute/)).toBeInTheDocument();
  });

  it("a hello without now (an older server) reads the player's own clock", async () => {
    await w.sanction('chat', 'lobby', 'snerp', 60_000);
    const inner = w.transportFor('snerp');
    const stripped: ChatTransport = {
      open: (room, events) =>
        inner.open(room, {
          status: events.status,
          frame: (f) => {
            if (f.type === 'hello') {
              const copy: Record<string, unknown> = { ...f };
              delete copy.now;
              events.frame(copy as never);
            } else events.frame(f);
          },
        }),
    };
    renderUi(box(stripped, { now: () => T0 + AHEAD }));
    // the clock runs ahead and nothing says otherwise: the restriction looks over, so the input is offered
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it("a restriction the player's clock agrees with is unchanged", async () => {
    await w.sanction('chat', 'lobby', 'snerp', 60_000);
    renderUi(box(w.transportFor('snerp')));
    expect(await screen.findByText(/A moderator turned off your chat until/)).toBeInTheDocument();
  });
});
