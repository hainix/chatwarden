import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld, ChatWorldOptions } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// The box over REAL pacing (flood control through the real core, chat box design 8.3): slow mode, the burst limit and repeat refusal come from
// the kit as `slow_mode`, `flood` and `duplicate` with a wait. The box says each in its own words, holds Send for the wait and lets the next
// line through when it has passed. Nothing here is scripted.

let w: ChatWorld;
const make = async (o: ChatWorldOptions = {}): Promise<void> => {
  w = await chatWorld(o);
};
afterEach(() => {
  w.close();
  vi.useRealTimers();
});

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });
const send = (): HTMLElement => screen.getByRole('button', { name: 'Send' });
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
async function join(name: string) {
  const transport = w.transportFor(name);
  const view = renderUi(box(transport));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport };
}
const press = async (value: string): Promise<void> => {
  fireEvent.change(input(), { target: { value } });
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Enter' });
  });
};
/** Move the kit's clock and the box's timers together. */
const wait = async (ms: number): Promise<void> => {
  w.clock.t += ms;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('real slow mode', () => {
  it('the second line is refused slow_mode: the box says it in its words with the wait, holds Send, and lets the next line through after the wait', async () => {
    await make({ pace: { slowModeMs: 3000 } });
    await join('snerp');
    vi.useFakeTimers();
    await press('first line');
    expect(within(log()).getByText('first line')).toBeInTheDocument();
    await wait(1000);
    await press('second line');
    expect(screen.getByText('Slow mode is on. You can send another message in 2 seconds.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(input()).toHaveValue('second line');
    await wait(1999);
    expect(send()).toBeDisabled();
    await wait(1);
    expect(send()).not.toBeDisabled();
    await press('second line');
    expect(within(log()).getByText('second line')).toBeInTheDocument();
    expect(input()).toHaveValue('');
  });

  it('is a pause, not a sanction: no referee card, no restricted line, and the refused line is not in the log', async () => {
    await make({ pace: { slowModeMs: 3000 } });
    const { container } = await join('snerp');
    vi.useFakeTimers();
    await press('first line');
    await press('a refused line');
    expect(screen.getByText(/Slow mode is on/)).toBeInTheDocument();
    expect(container.querySelector('.cw-card')).toBeNull();
    expect(container.querySelector('.cw-restricted')).toBeNull();
    expect(within(log()).queryByText('a refused line')).toBeNull();
  });
});

describe('real flood and duplicate', () => {
  it('a burst of three in ten seconds: the fourth is flood, said with its wait', async () => {
    await make({ pace: { burst: { lines: 3, windowMs: 10_000 } } });
    await join('snerp');
    vi.useFakeTimers();
    for (const text of ['one', 'two', 'three']) {
      await press(text);
      await wait(1500);
    }
    await press('four');
    // The oldest line was 4.5 s ago: 5.5 s until it leaves the window, shown rounded up.
    expect(screen.getByText('You are sending messages too fast. Try again in 6 seconds.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    await wait(5500);
    expect(send()).not.toBeDisabled();
    await press('four');
    expect(within(log()).getByText('four')).toBeInTheDocument();
  });

  it('the same line again is duplicate, said with its wait; a different line goes through at once', async () => {
    await make({ pace: { duplicateWindowMs: 15_000 } });
    await join('snerp');
    vi.useFakeTimers();
    await press('same words here');
    await wait(2000);
    await press('Same words here!');
    expect(screen.getByText('You already sent that. Say something different, or try again in 13 seconds.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    await wait(13_000);
    expect(send()).not.toBeDisabled();
    await press('something different');
    expect(within(log()).getByText('something different')).toBeInTheDocument();
  });
});

describe('pace in one room only', () => {
  it('a room with an override is paced and another is not (the kit decides, the box only shows it)', async () => {
    await make();
    w.real.rooms.setPace('lobby', { slowModeMs: 3000 });
    await join('snerp');
    vi.useFakeTimers();
    await press('one');
    await press('two');
    expect(screen.getByText(/Slow mode is on/)).toBeInTheDocument();
    // Another player in a room with no override is never held.
    expect(w.say('free-room', 'wumbo', 'one').ok).toBe(true);
    expect(w.say('free-room', 'wumbo', 'two').ok).toBe(true);
  });
});
