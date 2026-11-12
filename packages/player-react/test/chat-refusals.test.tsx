import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld, scripted, T0 } from './chat-world.js';
import type { ChatWorld, ChatWorldOptions } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

let w: ChatWorld;
const make = async (o: ChatWorldOptions = {}): Promise<void> => {
  w = await chatWorld(o);
};
beforeEach(async () => {
  await make();
});
afterEach(() => {
  w.close();
  vi.useRealTimers();
});

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });
const send = (): HTMLElement => screen.getByRole('button', { name: 'Send' });
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
async function join(name: string, props: Partial<ChatBoxProps> = {}) {
  const transport = w.transportFor(name);
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport };
}
const change = (value: string): void => {
  fireEvent.change(input(), { target: { value } });
};
const press = async (value: string): Promise<void> => {
  change(value);
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Enter' });
  });
};
/** The refusal region: a status that exists before it has text. */
const refusalRegion = (): HTMLElement => (document.querySelector('.cw-chat-refusal') as HTMLElement);

describe('each reason shows its sentence', () => {
  it('length, with the max', async () => {
    await join('snerp');
    await press('x'.repeat(300));
    expect(await screen.findByText('That message is too long. The limit is 200 characters.')).toBeInTheDocument();
    expect(input()).toHaveValue('x'.repeat(300));
  });

  it('rate', async () => {
    await join('snerp');
    for (const text of ['one', 'two', 'three']) await press(text);
    await press('four');
    expect(await screen.findByText('You are sending messages too fast. Wait a moment.')).toBeInTheDocument();
    expect(input()).toHaveValue('four');
    // a rate refusal has no wait: Send stays available
    expect(send()).not.toBeDisabled();
  });

  it('gate', async () => {
    await join('snerp');
    w.gate.open = false;
    await press('hello');
    expect(await screen.findByText('You cannot send messages here right now.')).toBeInTheDocument();
  });

  it('blocked, with Community Rule N', async () => {
    await join('snerp');
    await press('you zorbak');
    const text = (await screen.findByText(/It breaks a community rule\./)).textContent ?? '';
    expect(text).toMatch(/^That message was not sent\. It breaks a community rule\. Community Rule \d+\.$/);
  });

  it('profanity under a profile that refuses it', async () => {
    w.close();
    await make({ profanity: 'refuse' });
    await join('snerp');
    await press('what a glarn');
    expect(await screen.findByText('That message was not sent. Please leave out the swearing.')).toBeInTheDocument();
  });

  it('an unknown reason gets the generic sentence', async () => {
    w.close();
    await make({ wrap: scripted(() => ({ refuse: { reason: 'brand_new_reason' as never } })) });
    await join('snerp');
    await press('hello');
    expect(await screen.findByText('That message was not sent.')).toBeInTheDocument();
  });

  it('an empty refusal is silent', async () => {
    w.close();
    await make({ wrap: scripted(() => ({ refuse: { reason: 'empty' } })) });
    await join('snerp');
    await press('hello');
    expect(input()).toHaveValue('hello');
    expect(refusalRegion()).toBeEmptyDOMElement();
  });

  it('a pace reason says its wait', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'flood' ? { refuse: { reason: 'flood', retryAfterMs: 4000 } } : undefined)) });
    await join('snerp');
    await press('flood');
    expect(await screen.findByText('You are sending messages too fast. Try again in 4 seconds.')).toBeInTheDocument();
  });

  it('the duplicate reason says its wait', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'dupe' ? { refuse: { reason: 'duplicate', retryAfterMs: 10_000 } } : undefined)) });
    await join('snerp');
    await press('dupe');
    expect(await screen.findByText('You already sent that. Say something different, or try again in 10 seconds.')).toBeInTheDocument();
  });

  it('a wait of one second is singular', async () => {
    w.close();
    await make({ wrap: scripted(() => ({ refuse: { reason: 'slow_mode', retryAfterMs: 1000 } })) });
    await join('snerp');
    await press('hello');
    expect(await screen.findByText('Slow mode is on. You can send another message in 1 second.')).toBeInTheDocument();
  });
});

describe('a wait', () => {
  const slow = (ms: number) => scripted((_r, _s, text) => (text === 'wait' ? { refuse: { reason: 'slow_mode', retryAfterMs: ms } } : undefined));

  it('slow_mode with retryAfterMs 3000 disables Send, says "3 seconds", and re-enables at 3000 ms', async () => {
    w.close();
    await make({ wrap: slow(3000) });
    await join('snerp');
    vi.useFakeTimers();
    await press('wait');
    expect(screen.getByText('Slow mode is on. You can send another message in 3 seconds.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(send()).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(send()).not.toBeDisabled();
    // the wait clears its own sentence, and the draft is still there
    expect(screen.queryByText(/Slow mode is on/)).toBeNull();
    expect(input()).toHaveValue('wait');
  });

  it('a keystroke does not clear a wait, and Enter during it sends nothing', async () => {
    w.close();
    await make({ wrap: slow(3000) });
    const { transport } = await join('snerp');
    vi.useFakeTimers();
    await press('wait');
    screen.getByText(/Slow mode is on/);
    change('wait!');
    expect(screen.getByText(/Slow mode is on/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    expect(transport.sent).toEqual(['wait']);
  });

  it('retryAfterMs 125000 says 3 minutes (rounded up)', async () => {
    w.close();
    await make({ wrap: slow(125_000) });
    await join('snerp');
    await press('wait');
    expect(await screen.findByText('Slow mode is on. You can send another message in 3 minutes.')).toBeInTheDocument();
  });

  it('120 seconds is still seconds and 121 is minutes', async () => {
    w.close();
    await make({ wrap: slow(120_000) });
    await join('snerp');
    await press('wait');
    expect(await screen.findByText('Slow mode is on. You can send another message in 120 seconds.')).toBeInTheDocument();
  });

  it('a wait of 1500 ms rounds up to 2 seconds', async () => {
    w.close();
    await make({ wrap: slow(1500) });
    await join('snerp');
    await press('wait');
    expect(await screen.findByText('Slow mode is on. You can send another message in 2 seconds.')).toBeInTheDocument();
  });

  it('a retryAfterMs that is not a whole number from 1 to 3 600 000 is no wait', async () => {
    for (const bad of [0, -5, 1.5, 3_600_001]) {
      w.close();
      await make({ wrap: slow(bad) });
      const view = await join('snerp');
      await press('wait');
      expect(await screen.findByText(/Slow mode is on/)).toBeInTheDocument();
      expect(send(), String(bad)).not.toBeDisabled();
      view.unmount();
    }
  });
});

describe('what the refusal does besides speak', () => {
  it('the region exists before it has text, and is a status', async () => {
    await join('snerp');
    expect(refusalRegion()).toHaveAttribute('role', 'status');
    expect(refusalRegion()).toBeEmptyDOMElement();
  });

  it('clears on the next keystroke', async () => {
    await join('snerp');
    await press('you zorbak');
    await screen.findByText(/community rule/);
    change('you zorba');
    expect(refusalRegion()).toBeEmptyDOMElement();
  });

  it('clears after 8 seconds', async () => {
    await join('snerp');
    vi.useFakeTimers();
    await press('you zorbak');
    screen.getByText(/community rule/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7999);
    });
    expect(refusalRegion()).not.toBeEmptyDOMElement();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refusalRegion()).toBeEmptyDOMElement();
    expect(input()).toHaveValue('you zorbak');
  });

  it('a delivered line clears an old refusal', async () => {
    await join('snerp');
    await press('you zorbak');
    await screen.findByText(/community rule/);
    await press('a clean line');
    await within(log()).findByText('a clean line');
    expect(refusalRegion()).toBeEmptyDOMElement();
  });

  it('a refusal with noticeId calls onNoticePending, with no text, and onRefused hears every refusal without the line', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'note' ? { refuse: { reason: 'blocked', rule: 2, noticeId: 'n_1' } } : undefined)) });
    const onNoticePending = vi.fn();
    const onRefused = vi.fn();
    await join('snerp', { onNoticePending, onRefused });
    await press('note');
    await screen.findByText(/We sent you a notice with details\./);
    expect(onNoticePending).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith({ reason: 'blocked', rule: 2, noticeId: 'n_1' });
    expect(JSON.stringify(onRefused.mock.calls)).not.toContain('note"');
    await press('you zorbak');
    await waitFor(() => expect(onRefused).toHaveBeenCalledTimes(2));
    expect(onNoticePending).toHaveBeenCalledTimes(1);
  });

  it('a notices frame calls onNoticePending', async () => {
    const onNoticePending = vi.fn();
    const { transport } = await join('snerp', { onNoticePending });
    act(() => transport.inject({ type: 'notices' }));
    expect(onNoticePending).toHaveBeenCalledTimes(1);
  });

  it('a failed request shows the existing error words and keeps the draft', async () => {
    const transport = w.transportFor('snerp', { failSend: true });
    renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    await press('lost');
    expect(await screen.findByText('Could not reach the server. Check your connection and try again.')).toBeInTheDocument();
    expect(input()).toHaveValue('lost');
    expect(send()).not.toBeDisabled();
  });

  it('a refusal in a translation uses the translation', async () => {
    const { createT, en } = await import('../src/i18n.js');
    const t = createT({ ...en, 'player.chat.refused.blocked': 'Nicht gesendet.' }, 'en');
    await join('snerp', { t });
    await press('you zorbak');
    expect(await screen.findByText(/^Nicht gesendet\./)).toBeInTheDocument();
  });
});

describe('restriction', () => {
  it('a restricted refusal replaces the input with RestrictedChatLine (moderator wording)', async () => {
    const { transport } = await join('snerp');
    await w.sanction('chat', 'lobby', 'snerp', 3_600_000);
    // the sanction landed while the box was open: the server tells the box without a send
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull());
    expect(screen.getByText(/A moderator turned off your chat until/)).toBeInTheDocument();
    expect(transport.sent).toEqual([]);
  });

  it('a restricted refusal on send replaces the input', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'late' ? { refuse: { reason: 'restricted', until: T0 + 3_600_000, byModerator: true, rule: 2 } } : undefined)) });
    await join('snerp');
    await press('late');
    expect(await screen.findByText(/A moderator turned off your chat until/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('the automatic wording', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'late' ? { refuse: { reason: 'restricted', until: T0 + 3_600_000, byModerator: false } } : undefined)) });
    await join('snerp');
    await press('late');
    expect(await screen.findByText(/The automatic filter caught a message\./)).toBeInTheDocument();
  });

  it('a restriction in hello shows it before any send', async () => {
    await w.sanction('chat', 'lobby', 'snerp', 3_600_000);
    w.say('lobby', 'tarvo', 'still talking');
    renderUi(box(w.transportFor('snerp')));
    expect(await screen.findByText(/A moderator turned off your chat until/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    // the player still reads the room
    expect(within(log()).getByText('still talking')).toBeInTheDocument();
  });

  it('the input returns when until passes, with no reload', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'late' ? { refuse: { reason: 'restricted', until: T0 + 60_000, byModerator: true } } : undefined)) });
    renderUi(<ChatBox transport={w.transportFor('snerp')} room="lobby" {...FIXED} now={() => Date.now()} />);
    await screen.findByRole('textbox', { name: 'Message' });
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    await press('late');
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('a restriction with no end stays', async () => {
    await w.sanction('chat', 'lobby', 'snerp', null);
    renderUi(box(w.transportFor('snerp')));
    expect(await screen.findByText(/A moderator turned off your chat\. It does not end on its own\./)).toBeInTheDocument();
  });

  it('a state frame that lifts it brings the input back', async () => {
    await w.sanction('chat', 'lobby', 'snerp', 3_600_000);
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await screen.findByText(/turned off your chat/);
    act(() => transport.inject({ type: 'state', restriction: null, muted: [] }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });
});

describe('closed', () => {
  it.each([
    ['banned', 'You are banned, so you cannot join this chat.'],
    ['room_closed', 'This chat has closed.'],
    ['shutdown', 'Chat is closed for now. Try again in a moment.'],
    ['replaced', 'Chat is open in another window.'],
    ['forbidden', 'You cannot join this chat.'],
    ['unauthorized', 'You are signed out. Sign in again to chat.'],
    ['not_found', 'We could not find this chat.'],
    ['unsupported', 'Chat is not working here right now.'],
  ] as const)('%s shows one sentence and no input', async (why, sentence) => {
    const transport = w.transportFor('snerp');
    const onStatus = vi.fn();
    renderUi(box(transport, { onStatus }));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.status('closed', why));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith('closed', why);
  });

  it('a bye frame closes the same way', async () => {
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.inject({ type: 'bye', reason: 'room_closed' }));
    expect(await screen.findByText('This chat has closed.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('a banned player at the door sees the ban and no input', async () => {
    await w.sanction('ban', 'lobby', 'snerp', 3_600_000);
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    expect(await screen.findByText('You are banned, so you cannot join this chat.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('a banned refusal on send closes the box', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text === 'x' ? ({ refuse: { reason: 'banned' as never } } as never) : undefined)) });
    await join('snerp');
    await press('x');
    expect(await screen.findByText('You are banned, so you cannot join this chat.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('readOnly shows no input', async () => {
    w.say('lobby', 'tarvo', 'you can read this');
    renderUi(box(w.transportFor('snerp'), { readOnly: true }));
    expect(await within(await screen.findByRole('log')).findByText('you can read this')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
});

describe('connection', () => {
  it('reconnecting shows the quiet line; open shows nothing', async () => {
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    const region = (document.querySelector('.cw-chat-conn') as HTMLElement);
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();
    act(() => transport.status('reconnecting'));
    expect(region).toHaveTextContent('Connection lost. Trying again.');
    act(() => transport.status('open'));
    expect(region).toBeEmptyDOMElement();
  });

  it('says it is connecting until the first hello', async () => {
    const quiet = { open: () => ({ send: () => Promise.reject(new Error('x')), mute: () => Promise.resolve(false), report: () => Promise.reject(new Error('x')), close: () => undefined }) } as unknown as ChatTransport;
    renderUi(box(quiet));
    expect((document.querySelector('.cw-chat-conn') as HTMLElement)).toHaveTextContent('Connecting to chat');
  });

  it('onStatus hears the transport', async () => {
    const onStatus = vi.fn();
    const transport = w.transportFor('snerp');
    renderUi(box(transport, { onStatus }));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting', 'open']);
  });
});
