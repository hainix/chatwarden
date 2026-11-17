import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import { chatReducer, createChatState } from '../src/chat/state.js';
import type { ChatFrame, WireLine } from '../src/chat/wire.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// A retraction in the chat box: the line is replaced IN PLACE by "Message removed by a moderator." and its text is dropped from state (not hidden: gone). The placeholder takes no focus and has no controls. A
// line retracted before it was ever rendered never renders. A retract of several lines is one announcement, in the polite region.

const ROOM = 'lobby';
const SENTINEL = 'SENTINEL-retract-line-text';

let w: ChatWorld;
afterEach(() => {
  // The pure reducer tests build no world; a world from an earlier test closes again harmlessly.
  if ((w as ChatWorld | undefined) !== undefined) w.close();
});

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room={ROOM} {...FIXED} now={w.clock.now} {...props} />;
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const removedText = 'Message removed by a moderator.';

const line = (id: string, text = `line ${id}`, extra: Partial<WireLine> = {}): WireLine => ({ id, at: 1_800_000_000_000 + Number(id), name: 'tarvo', text, ...extra });
const hello = (lines: WireLine[]): ChatFrame => ({
  type: 'hello',
  v: 2,
  epoch: 'e1',
  room: ROOM,
  you: { name: 'snerp' },
  mode: { kind: 'normal', until: null },
  maxLength: 200,
  heartbeatMs: 20_000,
  summary: 'Be kind.',
  restriction: null,
  lines,
  muted: [],
});

/** The box over a transport the test writes frames into. */
async function injected(frames: ChatFrame[] = []) {
  w = await chatWorld();
  const transport = w.transportFor('snerp');
  const view = renderUi(box(transport));
  await screen.findByRole('textbox', { name: 'Message' });
  await act(async () => {
    transport.inject(hello([line('1', 'first'), line('2', SENTINEL), line('3', 'third'), line('4', 'fourth')]));
    for (const f of frames) transport.inject(f);
  });
  return { ...view, transport };
}

describe('the reducer', () => {
  it('a retract frame replaces the line in place and deletes its text from state (the sentinel is nowhere in the state)', () => {
    let state = chatReducer(createChatState(), { type: 'frame', frame: hello([line('1', 'a'), line('2', SENTINEL), line('3', 'c')]) });
    expect(JSON.stringify(state)).toContain(SENTINEL);
    state = chatReducer(state, { type: 'frame', frame: { type: 'retract', ids: ['2'] } });
    expect(JSON.stringify(state)).not.toContain(SENTINEL);
    expect(state.lines.map((l) => l.id)).toEqual(['1', '2', '3']);
    expect(state.lines[1]).toMatchObject({ id: '2', removed: true, text: '' });
  });

  it('keeps the placeholder\'s place by time and id, and the lines around it', () => {
    let state = chatReducer(createChatState(), { type: 'frame', frame: hello([line('1'), line('2'), line('3')]) });
    state = chatReducer(state, { type: 'frame', frame: { type: 'retract', ids: ['1', '3'] } });
    expect(state.lines.map((l) => [l.id, l.removed === true])).toEqual([['1', true], ['2', false], ['3', true]]);
    expect(state.lines[1]?.text).toBe('line 2');
  });

  it('a line retracted before it was ever held never appears: a later line frame, and a later hello, with that id are ignored', () => {
    let state = chatReducer(createChatState(), { type: 'frame', frame: hello([line('1')]) });
    state = chatReducer(state, { type: 'frame', frame: { type: 'retract', ids: ['9'] } });
    state = chatReducer(state, { type: 'frame', frame: { type: 'line', line: line('9', SENTINEL) } });
    expect(state.lines.map((l) => l.id)).toEqual(['1']);
    state = chatReducer(state, { type: 'frame', frame: hello([line('1'), line('9', SENTINEL)]) });
    expect(state.lines.map((l) => l.id)).toEqual(['1']);
    expect(JSON.stringify(state)).not.toContain(SENTINEL);
  });

  it('a retract of the viewer\'s own answer line (the sent action) is honoured too', () => {
    let state = chatReducer(createChatState(), { type: 'frame', frame: hello([]) });
    state = chatReducer(state, { type: 'frame', frame: { type: 'retract', ids: ['5'] } });
    state = chatReducer(state, { type: 'sent', line: line('5', SENTINEL, { mine: true }) });
    expect(JSON.stringify(state)).not.toContain(SENTINEL);
    expect(state.lines).toEqual([]);
  });

  it('a new epoch forgets what was retracted: ids restart in a reopened room', () => {
    let state = chatReducer(createChatState(), { type: 'frame', frame: hello([line('1')]) });
    state = chatReducer(state, { type: 'frame', frame: { type: 'retract', ids: ['9'] } });
    state = chatReducer(state, { type: 'frame', frame: { ...(hello([line('9', 'a new first line')]) as Extract<ChatFrame, { type: 'hello' }>), epoch: 'e2' } });
    expect(state.lines.map((l) => [l.id, l.text])).toEqual([['9', 'a new first line']]);
  });

  it('a retract with no ids, an unknown id or before the first hello changes nothing', () => {
    const first = createChatState();
    expect(chatReducer(first, { type: 'frame', frame: { type: 'retract', ids: ['1'] } })).toBe(first);
    const state = chatReducer(first, { type: 'frame', frame: hello([line('1')]) });
    expect(chatReducer(state, { type: 'frame', frame: { type: 'retract', ids: [] } })).toBe(state);
  });

  it('a mode frame and a hello set the mode and the read-only state; before the first hello a mode frame is ignored', () => {
    const first = createChatState();
    expect(chatReducer(first, { type: 'frame', frame: { type: 'mode', mode: { kind: 'locked', until: 5 }, readOnly: 'locked' } })).toBe(first);
    let state = chatReducer(first, { type: 'frame', frame: { ...(hello([]) as Extract<ChatFrame, { type: 'hello' }>), mode: { kind: 'emergency', until: 99 }, you: { name: 'snerp', readOnly: 'new_account' } } });
    expect(state.mode).toEqual({ kind: 'emergency', until: 99 });
    expect(state.readOnly).toBe('new_account');
    state = chatReducer(state, { type: 'frame', frame: { type: 'mode', mode: { kind: 'normal', until: null } } });
    expect(state.mode).toEqual({ kind: 'normal', until: null });
    expect(state.readOnly).toBeNull();
  });
});

describe('the box', () => {
  it('over the real kit: a moderator retracts a line and the viewer\'s box shows the placeholder where it was, with the text gone', async () => {
    w = await chatWorld();
    const author = w.transportFor('wumbo');
    const viewer = w.transportFor('snerp');
    renderUi(
      <>
        <ChatBox transport={author} room={ROOM} {...FIXED} now={w.clock.now} title="Author" />
        <ChatBox transport={viewer} room={ROOM} {...FIXED} now={w.clock.now} title="Viewer" />
      </>,
    );
    await screen.findAllByRole('textbox', { name: 'Message' });
    const send = async (text: string): Promise<string> => {
      w.clock.t += 2000;
      const res = w.say(ROOM, 'wumbo', text);
      if (!res.ok) throw new Error('refused');
      return res.line.id;
    };
    await act(async () => {
      await send('before it');
    });
    const gone = await act(async () => send(SENTINEL));
    await act(async () => {
      await send('after it');
    });
    const viewerLog = screen.getByRole('log', { name: 'Viewer' });
    await waitFor(() => expect(within(viewerLog).getByText(SENTINEL)).toBeInTheDocument());
    await act(async () => {
      w.real.rooms.retract(ROOM, gone);
    });
    await waitFor(() => expect(within(viewerLog).queryByText(SENTINEL)).toBeNull());
    const items = within(viewerLog).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('before it');
    expect(items[1]?.textContent).toBe(removedText);
    expect(items[2]).toHaveTextContent('after it');
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });

  it('the placeholder takes no focus: no control, no link, no tab stop inside it', async () => {
    const { transport } = await injected();
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['2'] });
    });
    const li = screen.getByText(removedText).closest('li') as HTMLElement;
    expect(li.querySelectorAll('button, a, input, textarea, select, [tabindex]')).toHaveLength(0);
    expect(li.textContent).toBe(removedText);
  });

  it('a line retracted before it was ever rendered never renders and leaves no placeholder', async () => {
    const { transport } = await injected();
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['9'] });
      transport.inject({ type: 'line', line: line('9', 'NEVER-SHOWN-LINE') });
    });
    expect(screen.queryByText('NEVER-SHOWN-LINE')).toBeNull();
    expect(screen.queryByText(removedText)).toBeNull();
  });

  it('the author\'s own box shows the placeholder too', async () => {
    w = await chatWorld();
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: SENTINEL } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(within(log()).getByText(SENTINEL)).toBeInTheDocument());
    const id = w.real.rooms.lineStates(ROOM)[0]?.lineId ?? '';
    await act(async () => {
      w.real.rooms.retract(ROOM, id);
    });
    await waitFor(() => expect(screen.getByText(removedText)).toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });

  it('a report dialog open on a line that is then retracted no longer quotes it', async () => {
    const { transport } = await injected();
    fireEvent.click(screen.getAllByRole('button', { name: /Options for this message/ })[1] as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Report' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(SENTINEL);
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['2'] });
    });
    expect(screen.getByRole('dialog')).not.toHaveTextContent(SENTINEL);
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });
});

describe('announcements', () => {
  it('a retract of several lines is one announcement in the polite region, with the count; nothing is assertive', async () => {
    const { container, transport } = await injected();
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['1', '2', '3'] });
    });
    const notes = screen.getAllByText('3 messages were removed by a moderator.');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.closest('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[aria-live="assertive"], [role="alert"]')).toBeNull();
  });

  it('one line is announced in the singular', async () => {
    const { transport } = await injected();
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['2'] });
    });
    expect(screen.getAllByText('A message was removed by a moderator.')).toHaveLength(1);
  });

  it('ids the box never held are not announced (nothing was removed from view)', async () => {
    const { transport } = await injected();
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['77', '78'] });
    });
    expect(screen.queryByText(/removed by a moderator/)).toBeNull();
  });

  it('the placeholder itself is not a second announcement: the log does not announce it as an addition', async () => {
    const { transport } = await injected();
    await act(async () => {
      transport.inject({ type: 'retract', ids: ['2'] });
    });
    const li = screen.getByText(removedText).closest('li') as HTMLElement;
    expect(li).toHaveAttribute('aria-live', 'off');
  });
});
