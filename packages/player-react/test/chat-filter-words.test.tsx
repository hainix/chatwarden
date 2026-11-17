import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createT, en } from '../src/i18n.js';
import { enChat } from '../src/chat/words.js';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld, scripted } from './chat-world.js';
import type { ChatWorld, ChatWorldOptions } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// F7: the three refusal words of the chat filters (`link`, `personal_info`, `filter`), each followed by the rule's own label as `blocked` is. A masked line
// shows its author the delivered text. Nothing in the box says which pattern matched.

let w: ChatWorld;
const make = async (o: ChatWorldOptions = {}): Promise<void> => {
  w = await chatWorld(o);
};
beforeEach(async () => {
  await make();
});
afterEach(() => {
  w.close();
});

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const input = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });
async function join(name: string, props: Partial<ChatBoxProps> = {}) {
  const transport = w.transportFor(name);
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport };
}
const press = async (value: string): Promise<void> => {
  fireEvent.change(input(), { target: { value } });
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Enter' });
  });
};
const refuse = (reason: string, rule?: number) => scripted(() => ({ refuse: { reason: reason as never, ...(rule === undefined ? {} : { rule }) } }));

const WORDS = {
  link: 'Links are not allowed in chat here.',
  personal_info: "Please don't share personal details such as phone numbers or emails.",
  filter: 'That message was not sent. It breaks a chat rule.',
} as const;

describe('the composer shows each reason in words with the rule label', () => {
  for (const reason of ['link', 'personal_info', 'filter'] as const) {
    it(`${reason}: its own sentence, then Community Rule N when the refusal names one; the draft is kept`, async () => {
      w.close();
      await make({ wrap: refuse(reason, 4) });
      await join('snerp');
      await press('some words');
      expect(await screen.findByText(`${WORDS[reason]} Community Rule 4.`)).toBeInTheDocument();
      expect(input()).toHaveValue('some words');
    });

    it(`${reason}: no rule, no label`, async () => {
      w.close();
      await make({ wrap: refuse(reason) });
      await join('snerp');
      await press('some words');
      expect(await screen.findByText(WORDS[reason])).toBeInTheDocument();
    });
  }

  it('an unknown reason falls back to the generic sentence; the three new ones are not the generic one', async () => {
    w.close();
    await make({ wrap: refuse('brand_new_reason') });
    await join('snerp');
    await press('hello');
    expect(await screen.findByText('That message was not sent.')).toBeInTheDocument();
  });

  it('the refusal region says nothing about a pattern, a link, a range or a counter', async () => {
    w.close();
    await make({ wrap: refuse('link', 4) });
    await join('snerp');
    await press('see blorf.com now');
    await screen.findByText(/Links are not allowed/);
    const region = (document.querySelector('.cw-chat-refusal') as HTMLElement).textContent ?? '';
    expect(region).not.toMatch(/blorf|pattern|link\.|unlisted|start|range|spans/i);
  });
});

describe('both catalogs have every key', () => {
  const KEYS = ['player.chat.refused.link', 'player.chat.refused.personal_info', 'player.chat.refused.filter'] as const;

  it('the chat words (the fallback) have each key, in plain words, no shaming', () => {
    for (const key of KEYS) {
      expect(Object.keys(enChat), key).toContain(key);
      expect(enChat[key], key).toBe(WORDS[key.replace('player.chat.refused.', '') as keyof typeof WORDS]);
    }
  });

  it('a catalog with no chat words (en alone) still shows them in the box: the box falls back to the chat words', async () => {
    for (const reason of ['link', 'personal_info', 'filter'] as const) {
      w.close();
      await make({ wrap: refuse(reason) });
      await join('snerp', { t: createT({ ...en }, 'en') });
      await press('hello');
      expect(await screen.findByText(WORDS[reason])).toBeInTheDocument();
    }
  });

  it('a translation of one of them is used', async () => {
    w.close();
    await make({ wrap: refuse('link') });
    await join('snerp', { t: createT({ ...en, ...enChat, 'player.chat.refused.link': 'Keine Links hier.' }, 'en') });
    await press('hello');
    expect(await screen.findByText('Keine Links hier.')).toBeInTheDocument();
  });
});

describe('a masked line', () => {
  it('shows the author the delivered text, and nothing in the box says which pattern matched', async () => {
    w.close();
    await make({ wrap: scripted((_r, _s, text) => (text.includes('555') ? { deliver: { lineId: 'm1', text: 'call me ************' } } : undefined)) });
    await join('snerp');
    await press('call me 555-010-9999');
    expect(await screen.findByText('call me ************')).toBeInTheDocument();
    const log = screen.getByRole('log', { name: 'Chat' }).textContent ?? '';
    expect(log).not.toContain('555');
    expect(log).not.toMatch(/pattern|phone|masked|hidden|personal/i);
    expect(input()).toHaveValue('');
  });
});
