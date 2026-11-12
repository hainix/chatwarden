import { screen, within } from '@testing-library/react';
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
afterEach(() => w.close());

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const control = (): HTMLElement => screen.getByRole('button', { name: 'Chat options' });
const panel = (): HTMLElement => document.querySelector('.cw-chat-panel') as HTMLElement;

async function join(props: Partial<ChatBoxProps> = {}, transport: ChatTransport | LocalTransport = w.transportFor('snerp')) {
  const local = transport as LocalTransport;
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport: local };
}

/** snerp has muted `name` before the box opens (through a session, as another tab would). */
function premute(name: string, text = 'x'): void {
  const line = w.say('lobby', name, text);
  if (!line.ok) throw new Error('say refused');
  const s = w.chat.session('lobby', w.who('snerp'), w.member('snerp'));
  if ('refused' in s) throw new Error('refused');
  expect(s.mute({ lineId: line.line.id, on: true })).toBe(true);
}

describe('Chat options', () => {
  it('is one control that opens a panel, and closes it again', async () => {
    const { user } = await join();
    expect(control()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();
    await user.click(control());
    expect(control()).toHaveAttribute('aria-expanded', 'true');
    expect(control().getAttribute('aria-controls')).toBe(panel().id);
    await user.click(control());
    expect(panel()).toBeNull();
  });

  it('lists muted players and Unmute works', async () => {
    premute('tarvo');
    premute('quissel');
    const { user, transport } = await join();
    await user.click(control());
    const names = (): string[] => within(panel()).getAllByRole('listitem').map((i) => i.textContent?.replace(/Unmute.*/, '') ?? '').sort();
    expect(names()).toEqual(['quissel', 'tarvo']);
    await user.click(within(panel()).getByRole('button', { name: 'Unmute tarvo' }));
    expect(transport.mutes.at(-1)).toMatchObject({ on: false });
    expect(transport.mutes.at(-1)?.target).toHaveProperty('ref');
    // the server's state frame has come back: the list is one shorter
    expect(names()).toEqual(['quissel']);
  });

  it('an Unmute button names the player it unmutes', async () => {
    premute('tarvo');
    const { user } = await join();
    await user.click(control());
    expect(within(panel()).getByRole('button', { name: 'Unmute tarvo' })).toBeInTheDocument();
  });

  it('an empty list says so', async () => {
    const { user } = await join();
    await user.click(control());
    expect(within(panel()).getByText('You have not muted anyone.')).toBeInTheDocument();
    expect(within(panel()).getByText('Muted players')).toBeInTheDocument();
    expect(within(panel()).queryByRole('list')).toBeNull();
  });

  it('a muted player\'s lines stay out after a reload of the box (the snapshot respects the mute)', async () => {
    premute('tarvo', 'hidden one');
    await join();
    expect(within(log()).queryByText('hidden one')).toBeNull();
  });

  it('the standard line shows hello.summary', async () => {
    const { user } = await join();
    await user.click(control());
    expect(w.cw.summary).not.toBe('');
    expect(within(panel()).getByText(w.cw.summary)).toBeInTheDocument();
  });

  it('Read the rules appears only with onOpenRules and calls it', async () => {
    const first = await join();
    await first.user.click(control());
    expect(within(panel()).queryByRole('button', { name: 'Read the rules' })).toBeNull();
    first.unmount();
    const onOpenRules = vi.fn();
    const second = await join({ onOpenRules });
    await second.user.click(control());
    await second.user.click(within(panel()).getByRole('button', { name: 'Read the rules' }));
    expect(onOpenRules).toHaveBeenCalledTimes(1);
  });

  it('Escape closes and returns focus to the control', async () => {
    const { user } = await join();
    await user.click(control());
    within(panel()).getByText('Muted players').focus();
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();
    expect(control()).toHaveFocus();
  });

  it('Escape in the panel does not reach the game', async () => {
    const { user } = await join();
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    await user.click(control());
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(0);
  });

  it('a muted player\'s name is shown as text', async () => {
    premute('<b>tarvo</b>');
    const { user } = await join();
    await user.click(control());
    expect(within(panel()).getByText('<b>tarvo</b>')).toBeInTheDocument();
    expect(panel().querySelector('b')).toBeNull();
  });

  it('is not offered when the chat is closed', async () => {
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    const { act } = await import('@testing-library/react');
    act(() => transport.status('closed', 'banned'));
    await screen.findByText(/You are banned/);
    expect(screen.queryByRole('button', { name: 'Chat options' })).toBeNull();
  });

  it('is offered to a read-only viewer, who may still mute and read the standard', async () => {
    renderUi(box(w.transportFor('snerp'), { readOnly: true }));
    await screen.findByRole('log');
    expect(await screen.findByRole('button', { name: 'Chat options' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('is offered beside the restriction line', async () => {
    await w.sanction('chat', 'lobby', 'snerp');
    renderUi(box(w.transportFor('snerp')));
    await screen.findByText(/turned off your chat/);
    expect(screen.getByRole('button', { name: 'Chat options' })).toBeInTheDocument();
  });
});

describe('nothing else was added to the always-visible UI', () => {
  it('a DOM snapshot of the closed box has the list, the input, Send and one Chat options control, and nothing else', async () => {
    const { container } = await join();
    const roles = [...container.querySelectorAll('button, textarea, input, select, a[href], [role="log"], [role="status"], [tabindex]')].map(
      (el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') === null ? '' : `[${el.getAttribute('role')}]`}:${el.getAttribute('aria-label') ?? el.textContent ?? ''}`,
    );
    // The log, the quiet connection and mute lines (empty), the input, Send, the (empty) refusal line, and the one door.
    expect(roles).toEqual(['div[log]:Chat', 'div[status]:', 'div[status]:', 'textarea:', 'button:Send', 'div[status]:', 'button:Chat options']);
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(container.querySelector('[role="log"]')).not.toBeNull();
    expect(container.querySelectorAll('input, select, a')).toHaveLength(0);
  });

  it('a line from another player adds its one options control and nothing else', async () => {
    w.say('lobby', 'tarvo', 'hi');
    const { container } = await join();
    const labels = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(labels).toEqual(['Options for this message from tarvo', 'Send', 'Chat options']);
  });
});
