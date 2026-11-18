// @vitest-environment jsdom
import { createElement } from 'react';
import { ChatBox } from '@chatwarden/player-react/chat';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatWorld } from '../../packages/player-react/test/chat-world.js';
import type { ChatWorld } from '../../packages/player-react/test/chat-world.js';
import { socketTransport } from './cases/express-sqlite-box-socketio/chatwarden/socketTransport.js';

// The generated client transport drives the real ChatBox. The socket is a stand-in with the part of the socket.io-client API the transport uses; the
// server end of it is the real room broadcaster (the same session calls attachChat makes), so frames, acks and refusals are the kit's own.

type Listener = (...args: unknown[]) => void;

function fakeSocket(w: ChatWorld, name: string) {
  const listeners = new Map<string, Set<Listener>>();
  const fire = (event: string, ...args: unknown[]): void => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
  };
  const calls: string[] = [];
  let stream: { close(): void } | undefined;
  let session: ReturnType<ChatWorld['chat']['session']> | undefined;
  const socket = {
    calls,
    connected: false,
    auth: {} as Record<string, unknown>,
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(fn);
      return socket;
    },
    off(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return socket;
    },
    connect() {
      session = w.chat.session(String(socket.auth.room), w.who(name), w.member(name));
      socket.connected = true;
      fire('connect');
      if ('refused' in session) {
        fire('chat:refused', session.refused);
        socket.connected = false;
        fire('disconnect', 'io server disconnect');
        return socket;
      }
      const opened = session.open({
        write: (frame) => {
          fire('chat:frame', structuredClone(frame));
          return true;
        },
      });
      if (!('refused' in opened)) stream = opened;
      return socket;
    },
    disconnect() {
      stream?.close();
      socket.connected = false;
      fire('disconnect', 'io client disconnect');
      return socket;
    },
    timeout: () => ({
      emit(event: string, input: unknown, ack: (err: Error | null, answer: unknown) => void) {
        calls.push(event);
        const s = session;
        if (s === undefined || 'refused' in s) return ack(new Error('no session'), undefined);
        if (event === 'chat:send') return ack(null, structuredClone(s.send({ text: String((input as { text: string }).text) })));
        if (event === 'chat:mute') return ack(null, structuredClone(s.muteResult(input as never)));
        void s.report(input as never).then((out) => ack(null, structuredClone(out)));
        return undefined;
      },
    }),
  };
  return socket;
}

let w: ChatWorld;
beforeEach(async () => {
  w = await chatWorld();
});
afterEach(() => {
  cleanup();
  w.close();
});

const mount = (name: string) => {
  const socket = fakeSocket(w, name);
  render(createElement(ChatBox, { transport: socketTransport(socket as unknown as Socket), room: 'lobby', locale: 'en', timeZone: 'UTC', now: w.clock.now }));
  return socket;
};
const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const type = (text: string): void => {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
};

describe('socketTransport drives a real ChatBox', () => {
  it('the transport drives a real ChatBox in jsdom: send', async () => {
    w.say('lobby', 'tarvo', 'anyone for a round?');
    mount('snerp');
    expect(await within(await screen.findByRole('log', { name: 'Chat' })).findByText('anyone for a round?')).toBeTruthy();
    type('count me in');
    expect(await within(log()).findByText('count me in')).toBeTruthy();
    // The line reached the room with the author's own name, through the kit.
    expect(w.say('lobby', 'tarvo', 'gg')).toMatchObject({ ok: true });
    expect(await within(log()).findByText('gg')).toBeTruthy();
  });

  it('refusal: a blocked line is refused with its sentence, and nothing of it is in the log', async () => {
    mount('snerp');
    await screen.findByRole('textbox', { name: 'Message' });
    type('you zorbak');
    await waitFor(() => expect(document.querySelector('.cw-chat-refusal')?.textContent ?? '').not.toBe(''));
    expect(log().textContent ?? '').not.toContain('zorbak');
  });

  it("report: the options row on another player's line files a report through the transport", async () => {
    w.say('lobby', 'tarvo', 'rude words here');
    const socket = mount('snerp');
    const line = await within(await screen.findByRole('log', { name: 'Chat' })).findByText('rude words here');
    fireEvent.click(within(line.closest('li') as HTMLElement).getByRole('button', { name: /Options for this message from tarvo/ }));
    fireEvent.click(within(log()).getByRole('button', { name: 'Report' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(socket.calls).toContain('chat:report'));
    expect(await screen.findByText(/Thanks for the report. We.ll look into it./)).toBeTruthy();
  });

  it('a banned player is closed with the reason banned (no retry), and close() disconnects only this socket', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const socket = fakeSocket(w, 'snerp');
    await w.sanction('ban', 'lobby', 'snerp');
    const conn = socketTransport(socket as unknown as Socket).open('lobby', { frame: () => undefined, status: (status, why) => seen.push([status, why]) });
    expect(seen).toEqual([['connecting', undefined], ['closed', 'banned']]);
    conn.close();
    expect(socket.connected).toBe(false);
  });
});
