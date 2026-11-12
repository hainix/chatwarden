import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';
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
const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });
const send = (): HTMLElement => screen.getByRole('button', { name: 'Send' });
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const names = (): string[] => [...log().querySelectorAll('.cw-chat-name')].map((n) => (n.textContent ?? '').replace(/:\s*$/, '').trim());
/** A box as `name`, joined to the room before the test looks. */
async function join(name: string, props: Partial<ChatBoxProps> = {}) {
  const transport = w.transportFor(name);
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport };
}
const say = async (room: string, name: string, text: string): Promise<void> => {
  await act(async () => {
    w.say(room, name, text);
  });
};
const change = (el: HTMLElement, value: string): void => {
  fireEvent.change(el, { target: { value } });
};

describe('the box shows the room', () => {
  it('shows the snapshot, then a line another player sends', async () => {
    w.say('lobby', 'tarvo', 'anyone for a round?');
    await join('snerp');
    expect(within(log()).getByText('anyone for a round?')).toBeInTheDocument();
    expect(names()).toEqual(['tarvo']);
    await say('lobby', 'tarvo', 'gg');
    expect(await within(log()).findByText('gg')).toBeInTheDocument();
  });

  it('says there are no messages yet, and takes it away with the first line', async () => {
    await join('snerp');
    expect(screen.getByText('No messages yet. Say hello.')).toBeInTheDocument();
    await say('lobby', 'tarvo', 'hi');
    await within(log()).findByText('hi');
    expect(screen.queryByText('No messages yet. Say hello.')).toBeNull();
  });

  it('own lines read "You" and use the accent', async () => {
    const { user } = await join('snerp');
    await user.type(input(), 'hello there{Enter}');
    const line = await within(log()).findByText('hello there');
    const item = line.closest('li') as HTMLElement;
    const name = item.querySelector('.cw-chat-name') as HTMLElement;
    expect(name.textContent).toMatch(/^You/);
    expect(name).toHaveClass('cw-chat-name--you');
    expect(item).not.toHaveTextContent('snerp');
    expect(item).toHaveAttribute('data-mine', 'true');
  });

  it('another player\'s name is not the accent', async () => {
    w.say('lobby', 'tarvo', 'hello');
    await join('snerp');
    const name = within(log()).getByText('tarvo', { selector: '.cw-chat-name' });
    expect(name).not.toHaveClass('cw-chat-name--you');
  });

  it('consecutive lines by one name show the name once', async () => {
    w.say('lobby', 'tarvo', 'one');
    w.say('lobby', 'tarvo', 'two');
    w.say('lobby', 'vlemmo', 'three');
    w.say('lobby', 'tarvo', 'four');
    await join('snerp');
    expect(names()).toEqual(['tarvo', 'vlemmo', 'tarvo']);
    // The name is still read for every line, by a screen reader.
    const two = within(log()).getByText('two').closest('li') as HTMLElement;
    expect(two.textContent).toMatch(/tarvo/);
    expect(two.querySelector('.cw-chat-name')).toBeNull();
  });

  it('each line reads "name: text" with a hidden colon', async () => {
    w.say('lobby', 'tarvo', 'gg');
    await join('snerp');
    const item = within(log()).getByText('gg').closest('li') as HTMLElement;
    // (the options control's glyph is aria-hidden and not part of what is read)
    expect((item.querySelector('.cw-chat-name')?.textContent ?? '') + (item.querySelector('.cw-chat-text')?.textContent ?? '')).toBe('tarvo: gg');
  });

  it('the time of a line is on a <time> element, for those who hover', async () => {
    w.say('lobby', 'tarvo', 'gg');
    await join('snerp');
    const time = within(log()).getByText('gg').closest('time') as HTMLTimeElement;
    expect(time.dateTime).toBe(new Date(1_800_000_000_000).toISOString());
    expect(time.title).not.toBe('');
  });

  it('a new room closes the connection and opens another', async () => {
    w.say('lobby', 'tarvo', 'in the lobby');
    w.say('arena', 'tarvo', 'in the arena');
    const transport = w.transportFor('snerp');
    const { rerender } = renderUi(box(transport));
    await within(await screen.findByRole('log')).findByText('in the lobby');
    rerender(box(transport, { room: 'arena' }));
    await within(log()).findByText('in the arena');
    expect(within(log()).queryByText('in the lobby')).toBeNull();
    expect(transport.opened.map((o) => [o.room, o.closed])).toEqual([
      ['lobby', true],
      ['arena', false],
    ]);
  });

  it('a new transport closes the old connection too', async () => {
    const a = w.transportFor('snerp');
    const b = w.transportFor('snerp');
    const { rerender } = renderUi(box(a));
    await screen.findByRole('textbox', { name: 'Message' });
    rerender(box(b));
    await waitFor(() => expect(b.opened).toHaveLength(1));
    expect(a.opened[0]?.closed).toBe(true);
  });

  it('unmount closes the connection and leaves no timer', async () => {
    vi.useFakeTimers();
    const quiet = await chatWorld({ broadcaster: { schedule: () => () => undefined } });
    const transport = quiet.transportFor('snerp');
    const before = vi.getTimerCount();
    const { unmount } = renderUi(box(transport));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    expect(transport.opened[0]?.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(before);
    quiet.close();
  });

  it('a strict-mode double mount leaves one live connection', async () => {
    const { StrictMode } = await import('react');
    const transport = w.transportFor('snerp');
    renderUi(<StrictMode>{box(transport)}</StrictMode>);
    await screen.findByRole('textbox', { name: 'Message' });
    expect(transport.opened.filter((o) => !o.closed)).toHaveLength(1);
  });

  it('the title is the name of the log', async () => {
    await join('snerp', { title: 'Lobby chat' });
    expect(screen.getByRole('log', { name: 'Lobby chat' })).toBeInTheDocument();
  });

  it('keeps at most maxLines', async () => {
    for (let i = 1; i <= 8; i += 1) {
      w.say('lobby', `p${i}`, `line number ${i}`);
      w.clock.t += 1000;
    }
    await join('snerp', { maxLines: 3 });
    expect(within(log()).queryByText('line number 1')).toBeNull();
    expect(within(log()).getByText('line number 8')).toBeInTheDocument();
    expect(within(log()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('a frame a custom transport sends that is not a frame is ignored', async () => {
    const { transport } = await join('snerp');
    act(() => {
      transport.inject({ type: 'line', line: { id: 5 } } as never);
      transport.inject({ type: 'confetti' } as never);
    });
    expect(within(log()).queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('send', () => {
  it('Enter sends, clears the input on ok and keeps the draft on a refusal', async () => {
    const { user, transport } = await join('snerp');
    await user.type(input(), 'hello{Enter}');
    expect(await within(log()).findByText('hello')).toBeInTheDocument();
    expect(input()).toHaveValue('');
    expect(transport.sent).toEqual(['hello']);
    await user.type(input(), 'you zorbak{Enter}');
    await screen.findByText(/It breaks a community rule/);
    expect(input()).toHaveValue('you zorbak');
    expect(within(log()).queryByText('you zorbak')).toBeNull();
  });

  it('the Send button sends too', async () => {
    const { user } = await join('snerp');
    await user.type(input(), 'by button');
    await user.click(send());
    expect(await within(log()).findByText('by button')).toBeInTheDocument();
    expect(input()).toHaveValue('');
    // focus is back in the input, so the player can keep typing
    expect(input()).toHaveFocus();
  });

  it('Shift+Enter inserts a newline and sends nothing', async () => {
    const { user, transport } = await join('snerp');
    await user.type(input(), 'one{Shift>}{Enter}{/Shift}two');
    expect(input()).toHaveValue('one\ntwo');
    expect(transport.sent).toEqual([]);
  });

  it('Enter during IME composition does not send', async () => {
    const { transport } = await join('snerp');
    change(input(), 'nihon');
    fireEvent.compositionStart(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(transport.sent).toEqual([]);
    fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(transport.sent).toEqual([]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(transport.sent).toEqual(['nihon']));
  });

  it('a blank or whitespace line sends nothing', async () => {
    const { user, transport } = await join('snerp');
    await user.click(input());
    await user.keyboard('{Enter}');
    await user.type(input(), '   {Enter}');
    change(input(), '\n\n  \n');
    await user.click(send());
    expect(transport.sent).toEqual([]);
    expect(within(log()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('sends the text without the spaces around it', async () => {
    const { user, transport } = await join('snerp');
    await user.type(input(), '  padded  {Enter}');
    await within(log()).findByText('padded');
    expect(transport.sent).toEqual(['padded']);
  });

  it('Send is disabled while a request is in flight and cannot double-send', async () => {
    const inner = w.transportFor('snerp');
    let release: (() => void) | null = null;
    let calls = 0;
    const slow: ChatTransport = {
      open: (room, events) => {
        const conn = inner.open(room, events);
        return {
          ...conn,
          send: (text) => {
            calls += 1;
            return new Promise((resolve) => {
              release = () => resolve(conn.send(text));
            });
          },
        };
      },
    };
    const { user } = renderUi(box(slow));
    await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input(), 'only once{Enter}');
    expect(send()).toBeDisabled();
    await user.keyboard('{Enter}');
    fireEvent.click(send());
    fireEvent.submit(input().closest('form') as HTMLFormElement);
    expect(calls).toBe(1);
    await act(async () => {
      (release as unknown as () => void)();
    });
    expect(await within(log()).findByText('only once')).toBeInTheDocument();
    expect(send()).not.toBeDisabled();
    expect(calls).toBe(1);
  });

  it('a failed request shows the existing error words and keeps the draft', async () => {
    const transport = w.transportFor('snerp', { failSend: true });
    const { user } = renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    // The local transport rejects with a bare Error; the box words it like a dropped connection.
    await user.type(input(), 'will not arrive{Enter}');
    await screen.findByText(/Could not reach the server|Something went wrong/);
    expect(input()).toHaveValue('will not arrive');
    expect(send()).not.toBeDisabled();
  });

  it('the input has the length limit of the room', async () => {
    await join('snerp');
    expect(input()).toHaveAttribute('maxlength', '200');
  });

  it('the placeholder says what to do', async () => {
    await join('snerp');
    expect(input()).toHaveAttribute('placeholder', 'Say something');
  });

  it('the counter appears only in the last 20 characters, with the plural words', async () => {
    await join('snerp');
    change(input(), 'x'.repeat(179));
    expect(screen.queryByText(/characters? left/)).toBeNull();
    change(input(), 'x'.repeat(180));
    expect(screen.getByText('20 characters left')).toBeInTheDocument();
    change(input(), 'x'.repeat(199));
    expect(screen.getByText('1 character left')).toBeInTheDocument();
    change(input(), 'x'.repeat(200));
    expect(screen.getByText('0 characters left')).toBeInTheDocument();
    change(input(), 'x');
    expect(screen.queryByText(/characters? left/)).toBeNull();
  });
});

describe('another tab of the same player', () => {
  it('shows the line in both boxes, once each', async () => {
    const a = w.transportFor('snerp');
    const b = w.transportFor('snerp');
    const first = renderUi(box(a));
    await screen.findByRole('textbox', { name: 'Message' });
    const second = renderUi(box(b));
    await waitFor(() => expect(screen.getAllByRole('log')).toHaveLength(2));
    await first.user.type(within(first.container).getByRole('textbox'), 'both tabs{Enter}');
    await waitFor(() => expect(within(second.container).getAllByText('both tabs')).toHaveLength(1));
    expect(within(first.container).getAllByText('both tabs')).toHaveLength(1);
  });
});

describe('only what the player may see is shown', () => {
  it('text is shown as text: markup is not parsed', async () => {
    w.say('lobby', 'tarvo', '<img src=x onerror=alert(1)>');
    await join('snerp');
    expect(within(log()).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(log().querySelector('img')).toBeNull();
  });
});
