import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld, LocalTransport } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

let w: ChatWorld;
beforeEach(async () => {
  w = await chatWorld();
});
afterEach(() => {
  w.close();
  vi.useRealTimers();
});

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const optionsOf = (name: string, root: HTMLElement = log()): HTMLElement => within(root).getAllByRole('button', { name: `Options for this message from ${name}` })[0] as HTMLElement;
const note = (): HTMLElement => document.querySelector('.cw-chat-note') as HTMLElement;

async function join(name = 'snerp', props: Partial<ChatBoxProps> = {}, transport: ChatTransport | LocalTransport = w.transportFor(name)) {
  const local = transport as LocalTransport;
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport: local };
}
const muteFrom = async (user: ReturnType<typeof renderUi>['user'], name: string, root: HTMLElement = log()): Promise<void> => {
  await user.click(optionsOf(name, root));
  await user.click(within(root).getByRole('button', { name: `Mute ${name}` }));
};
const say = async (name: string, text: string): Promise<void> => {
  await act(async () => {
    w.say('lobby', name, text);
  });
};

describe('mute', () => {
  it('hides that author\'s lines at once and keeps hiding their new ones', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    w.say('lobby', 'vlemmo', 'vlemmo one');
    w.say('lobby', 'tarvo', 'tarvo two');
    const { user } = await join();
    await muteFrom(user, 'tarvo');
    expect(within(log()).queryByText('tarvo one')).toBeNull();
    expect(within(log()).queryByText('tarvo two')).toBeNull();
    expect(within(log()).getByText('vlemmo one')).toBeInTheDocument();
    await say('tarvo', 'tarvo three');
    await say('vlemmo', 'vlemmo two');
    expect(await within(log()).findByText('vlemmo two')).toBeInTheDocument();
    expect(within(log()).queryByText('tarvo three')).toBeNull();
  });

  it('says so in a status region that was there before, with the words of the catalog', async () => {
    w.say('lobby', 'tarvo', 'hi');
    const { user } = await join();
    expect(note()).toHaveAttribute('role', 'status');
    expect(note()).toBeEmptyDOMElement();
    await muteFrom(user, 'tarvo');
    expect(note()).toHaveTextContent('Muted tarvo. You will not see their messages.');
    expect(within(note()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('closes the row, and focus goes to a place that still exists', async () => {
    w.say('lobby', 'tarvo', 'hi');
    w.say('lobby', 'vlemmo', 'yo');
    const { user } = await join();
    await muteFrom(user, 'tarvo');
    expect(within(log()).queryByRole('button', { name: 'Mute tarvo' })).toBeNull();
    // the author's lines are gone, and so is the control that had focus: focus is on the log, not lost to the page
    expect(document.body).not.toHaveFocus();
  });

  it('Undo within 8 s unmutes (via ref) and later lines return', async () => {
    w.say('lobby', 'tarvo', 'before');
    const { user, transport } = await join();
    await muteFrom(user, 'tarvo');
    await say('tarvo', 'while muted');
    expect(within(log()).queryByText('while muted')).toBeNull();
    await user.click(within(note()).getByRole('button', { name: 'Undo' }));
    expect(transport.mutes).toHaveLength(2);
    expect(transport.mutes[0]?.target).toHaveProperty('lineId');
    expect(transport.mutes[1]).toMatchObject({ on: false });
    expect(transport.mutes[1]?.target).toHaveProperty('ref');
    expect(note()).toBeEmptyDOMElement();
    await say('tarvo', 'after undo');
    expect(await within(log()).findByText('after undo')).toBeInTheDocument();
  });

  it('Undo after 8 s is gone', async () => {
    w.say('lobby', 'tarvo', 'hi');
    await join();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(optionsOf('tarvo'));
    });
    await act(async () => {
      fireEvent.click(within(log()).getByRole('button', { name: 'Mute tarvo' }));
    });
    expect(within(note()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7999);
    });
    expect(within(note()).queryByRole('button', { name: 'Undo' })).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(note()).toBeEmptyDOMElement();
  });

  it('Undo is disabled until the state frame with the ref has arrived', async () => {
    w.say('lobby', 'tarvo', 'hi');
    const inner = w.transportFor('snerp');
    let gate: ((frame: unknown) => void) | null = null;
    const held: unknown[] = [];
    let release = false;
    const slowState: ChatTransport = {
      open: (room, events) =>
        inner.open(room, {
          status: events.status,
          frame: (f) => {
            if (f.type === 'state' && !release) held.push(f);
            else events.frame(f);
          },
        }),
    };
    gate = (f) => inner.inject(f as never);
    const { user } = await join('snerp', {}, slowState);
    await muteFrom(user, 'tarvo');
    const undo = within(note()).getByRole('button', { name: 'Undo' });
    expect(undo).toBeDisabled();
    release = true;
    await act(async () => {
      for (const f of held) (gate as (frame: unknown) => void)(f);
    });
    expect(within(note()).getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('a mute that fails says so with the existing error words, and hides nothing', async () => {
    w.say('lobby', 'tarvo', 'still here');
    const inner = w.transportFor('snerp');
    const failing: ChatTransport = { open: (room, events) => ({ ...inner.open(room, events), mute: () => Promise.reject(new Error('Failed to fetch')) }) };
    const { user } = await join('snerp', {}, failing);
    await muteFrom(user, 'tarvo');
    expect(await screen.findByText('Could not reach the server. Check your connection and try again.')).toBeInTheDocument();
    expect(within(log()).getByText('still here')).toBeInTheDocument();
  });

  it.each([
    ['false', () => Promise.resolve(false as const)],
    ['{ ok: false, hiddenIds: [] }', () => Promise.resolve({ ok: false, hiddenIds: [] as string[] })],
  ])('a mute that changes nothing (%s) hides nothing and says so, with no Undo', async (_what, answer) => {
    w.say('lobby', 'tarvo', 'still here');
    const inner = w.transportFor('snerp');
    const refusing: ChatTransport = { open: (room, events) => ({ ...inner.open(room, events), mute: answer }) };
    const { user } = await join('snerp', {}, refusing);
    await muteFrom(user, 'tarvo');
    expect(within(log()).getByText('still here')).toBeInTheDocument();
    expect(await within(note()).findByText('Nothing changed. tarvo was not muted.')).toBeInTheDocument();
    expect(within(note()).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('muting is silent: the muted player\'s own box shows nothing', async () => {
    w.say('lobby', 'tarvo', 'from tarvo');
    const mine = await join('snerp');
    const theirs = renderUi(box(w.transportFor('tarvo')));
    await vi.waitFor(() => expect(screen.getAllByRole('log')).toHaveLength(2));
    const theirBox = theirs.container;
    await muteFrom(mine.user, 'tarvo', within(mine.container).getByRole('log'));
    // tarvo's box: nothing new anywhere, no status text
    expect(within(theirBox).getByText('from tarvo')).toBeInTheDocument();
    for (const region of theirBox.querySelectorAll('[role="status"]')) expect(region).toBeEmptyDOMElement();
    // he goes on talking: snerp does not see it, and he sees himself, and everyone else
    await act(async () => {
      w.say('lobby', 'tarvo', 'still talking');
      w.say('lobby', 'vlemmo', 'hello both');
    });
    expect(await within(theirBox).findByText('still talking')).toBeInTheDocument();
    expect(within(theirBox).getByText('hello both')).toBeInTheDocument();
    expect(within(mine.container).queryByText('still talking')).toBeNull();
    expect(within(mine.container).getByText('hello both')).toBeInTheDocument();
    // and his own line was answered ok (no refusal anywhere)
    for (const region of theirBox.querySelectorAll('[role="status"]')) expect(region).toBeEmptyDOMElement();
  });

  it('two lines by one author are hidden together (by the hide the server sends); another name is not', async () => {
    w.say('lobby', 'tarvo', 'a');
    w.say('lobby', 'tarvo', 'b');
    w.say('lobby', 'quissel', 'c');
    const { user } = await join();
    await muteFrom(user, 'tarvo');
    expect(within(log()).queryAllByRole('listitem').map((li) => li.textContent)).toEqual(['quissel: c⋯']);
  });
});
