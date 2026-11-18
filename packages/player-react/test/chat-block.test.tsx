import { act, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { enChat } from '../src/chat/words.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld, LocalTransport } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// M4: Block in the chat box. It sits in the line options next to Report and Mute (nothing new is visible outside the menu), asks one confirm, then hides the author's lines (the server hides the
// blocker's for them too); "Chat options" lists muted and blocked players with Unmute or Unblock. Real broadcaster, real kit, a local transport.

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
const optionsOf = (name: string): HTMLElement => within(log()).getAllByRole('button', { name: `Options for this message from ${name}` })[0] as HTMLElement;
const note = (): HTMLElement => document.querySelector('.cw-chat-note') as HTMLElement;

/** A transport whose connections answer every mute with `answer` (a server that changed nothing, or whose list is full). */
function answering(name: string, answer: { ok: boolean; hiddenIds: string[]; limit?: true }): LocalTransport {
  const transport = w.transportFor(name) as LocalTransport;
  const open = transport.open.bind(transport);
  transport.open = (room, events) => ({ ...open(room, events), mute: () => Promise.resolve(answer) });
  return transport;
}

async function join(name = 'snerp', props: Partial<ChatBoxProps> = {}, given?: LocalTransport) {
  const transport = given ?? (w.transportFor(name) as LocalTransport);
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport };
}
const say = async (name: string, text: string): Promise<void> => {
  await act(async () => {
    w.say('lobby', name, text);
  });
};
const openRow = async (user: ReturnType<typeof renderUi>['user'], name: string): Promise<void> => {
  await user.click(optionsOf(name));
};

const CONFIRM = 'They will not see your messages either. You can undo this in Chat options.';

describe('where Block is', () => {
  it('nothing about blocking is visible until the options row of a line is open', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { container } = await join();
    expect(within(log()).queryByRole('button', { name: /^Block / })).toBeNull();
    expect(container.textContent).not.toMatch(/Block /);
    expect(screen.queryByText(CONFIRM)).toBeNull();
  });

  it('the line options row holds Report, Mute and Block, in that order, and it closes with Escape as before', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user } = await join();
    await openRow(user, 'tarvo');
    const row = document.querySelector('.cw-chat-optrow') as HTMLElement;
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Report', 'Mute tarvo', 'Block tarvo']);
    await user.keyboard('{Escape}');
    expect(document.querySelector('.cw-chat-optrow')).toBeNull();
  });

  it('a line of your own has no options at all, so nothing to block', async () => {
    const { user } = await join('snerp');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'my own line{Enter}');
    await within(log()).findByText('my own line');
    expect(within(log()).queryByRole('button', { name: /Options for this message from snerp/ })).toBeNull();
  });
});

describe('the confirm', () => {
  it('Block asks once, in one line, and sends nothing until it is confirmed', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user, transport } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    expect(transport.mutes).toEqual([]);
    expect(within(log()).getByText('tarvo one')).toBeInTheDocument();
    const group = screen.getByText(CONFIRM).closest('[role="group"]') as HTMLElement;
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Block tarvo', 'Cancel']);
  });

  it('Cancel changes nothing: no request, the line stays, the confirm is gone and focus returns to the line control', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user, transport } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(transport.mutes).toEqual([]);
    expect(screen.queryByText(CONFIRM)).toBeNull();
    expect(within(log()).getByText('tarvo one')).toBeInTheDocument();
  });

  it('Escape on the confirm closes it without blocking', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user, transport } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByText(CONFIRM)).toBeNull();
    expect(transport.mutes).toEqual([]);
  });
});

describe('blocking', () => {
  it("confirming hides that author's lines at once and keeps hiding their new ones, and says it in the status region", async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    w.say('lobby', 'vlemmo', 'vlemmo one');
    const { user, transport } = await join();
    expect(note()).toHaveAttribute('role', 'status');
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    expect(transport.mutes).toHaveLength(1);
    expect(transport.mutes[0]).toMatchObject({ target: { lineId: expect.any(String) }, on: true, block: true });
    expect(within(log()).queryByText('tarvo one')).toBeNull();
    expect(within(log()).getByText('vlemmo one')).toBeInTheDocument();
    expect(note()).toHaveTextContent('Blocked tarvo. You will not see their messages, and they will not see yours.');
    await say('tarvo', 'tarvo two');
    await say('vlemmo', 'vlemmo two');
    expect(await within(log()).findByText('vlemmo two')).toBeInTheDocument();
    expect(within(log()).queryByText('tarvo two')).toBeNull();
    // the kit really holds a block, in both directions
    expect(w.cw.blocks.between(w.who('snerp'), w.who('tarvo'))).toBe(true);
  });

  it('the message of a line that is gone says nothing changed, with no Undo', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user } = await join('snerp', {}, answering('snerp', { ok: false, hiddenIds: [] }));
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    expect(note()).toHaveTextContent('Nothing changed. tarvo was not blocked.');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a full list says so in plain words: you have muted or blocked as many players as is allowed', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user } = await join('snerp', {}, answering('snerp', { ok: false, hiddenIds: [], limit: true }));
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    expect(screen.getByText('You have muted or blocked as many players as is allowed.')).toBeInTheDocument();
    expect(within(log()).getByText('tarvo one')).toBeInTheDocument();
  });

  it('a mute still works as it did: Mute tarvo is one click, with no confirm', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user, transport } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Mute tarvo' }));
    expect(screen.queryByText(CONFIRM)).toBeNull();
    expect(transport.mutes[0]).toMatchObject({ on: true });
    expect(transport.mutes[0]).not.toHaveProperty('block');
    expect(within(log()).queryByText('tarvo one')).toBeNull();
  });
});

describe('Chat options: muted and blocked players', () => {
  it('lists a block with a Blocked tag and Unblock, and a mute with Unmute; the title says both', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    w.say('lobby', 'vlemmo', 'vlemmo one');
    const { user } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await openRow(user, 'vlemmo');
    await user.click(screen.getByRole('button', { name: 'Mute vlemmo' }));
    await user.click(screen.getByRole('button', { name: 'Chat options' }));
    const panel = screen.getByRole('group', { name: 'Muted and blocked players' });
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const tarvo = items.find((i) => i.textContent?.includes('tarvo')) as HTMLElement;
    const vlemmo = items.find((i) => i.textContent?.includes('vlemmo')) as HTMLElement;
    expect(within(tarvo).getByText('Blocked')).toBeInTheDocument();
    expect(within(tarvo).getByRole('button', { name: 'Unblock tarvo' })).toBeInTheDocument();
    expect(within(vlemmo).queryByText('Blocked')).toBeNull();
    expect(within(vlemmo).getByRole('button', { name: 'Unmute vlemmo' })).toBeInTheDocument();
  });

  it('Unblock removes the block: the list empties, and their new lines come back', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Chat options' }));
    await user.click(screen.getByRole('button', { name: 'Unblock tarvo' }));
    await within(screen.getByRole('group', { name: 'Muted and blocked players' })).findByText('You have not muted or blocked anyone.');
    await say('tarvo', 'tarvo back');
    expect(await within(log()).findByText('tarvo back')).toBeInTheDocument();
    expect(w.cw.blocks.between(w.who('snerp'), w.who('tarvo'))).toBe(false);
  });

  it('the Undo on the status line removes the block too', async () => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user } = await join();
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await say('tarvo', 'tarvo back');
    expect(await within(log()).findByText('tarvo back')).toBeInTheDocument();
    expect(w.cw.blocks.between(w.who('snerp'), w.who('tarvo'))).toBe(false);
  });

  it('a block made in another tab shows in the list when the state frame arrives', async () => {
    const { user, transport } = await join();
    await act(async () => {
      transport.inject({ type: 'state', restriction: null, muted: [{ ref: 'abcd1234', name: 'quissel', block: true }, { ref: 'efgh5678', name: 'fenrisk' }] });
    });
    await user.click(screen.getByRole('button', { name: 'Chat options' }));
    const panel = screen.getByRole('group', { name: 'Muted and blocked players' });
    expect(within(panel).getByRole('button', { name: 'Unblock quissel' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Unmute fenrisk' })).toBeInTheDocument();
  });

  it('an empty list says you have not muted or blocked anyone', async () => {
    const { user } = await join();
    await user.click(screen.getByRole('button', { name: 'Chat options' }));
    expect(screen.getByText('You have not muted or blocked anyone.')).toBeInTheDocument();
  });
});

describe('the words', () => {
  it('the block keys exist in the chat catalog, say what they should and take only the placeholders they use', () => {
    const keys = Object.keys(enChat).filter((k) => /^player\.chat\.(block|unblock)/.test(k));
    expect(keys.sort()).toEqual(['player.chat.block', 'player.chat.blockCancel', 'player.chat.blockConfirm', 'player.chat.blockLimit', 'player.chat.blockUnchanged', 'player.chat.blocked', 'player.chat.blockedTag', 'player.chat.unblock', 'player.chat.unblockName']);
    expect(enChat['player.chat.blockConfirm']).toBe(CONFIRM);
    expect(enChat['player.chat.mutedList']).toBe('Muted and blocked players');
    expect(enChat['player.chat.mutedNone']).toBe('You have not muted or blocked anyone.');
    for (const key of keys) expect([...String(enChat[key as keyof typeof enChat])].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });

  it('none of the block words shames or threatens', () => {
    const text = keysText();
    expect(text).not.toMatch(/\b(punish|ban|report them|bad|toxic)\b/i);
  });
});

function keysText(): string {
  return Object.entries(enChat)
    .filter(([k]) => /^player\.chat\.(block|unblock)/.test(k))
    .map(([, v]) => v)
    .join(' ');
}

describe('axe', () => {
  it.each(['light', 'dark'] as const)('the options row, the confirm, the status line and the list have no violations in the %s theme', async (theme) => {
    w.say('lobby', 'tarvo', 'tarvo one');
    const { user, container } = await join('snerp', { theme });
    await openRow(user, 'tarvo');
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    const run = async () => (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
    expect(await run()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Block tarvo' }));
    expect(await run()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Chat options' }));
    expect(await run()).toEqual([]);
  });
});
