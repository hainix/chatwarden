import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import { chatReducer, createChatState } from '../src/chat/state.js';
import type { ChatConnection, ChatTransport } from '../src/chat/transport.js';
import { enChat } from '../src/chat/words.js';
import type { ChatFrame, SendResult, WireRefusal } from '../src/chat/wire.js';
import { createT, en } from '../src/i18n.js';
import type { PlayerT } from '../src/i18n.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld, LocalTransport } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// M5: the phrase picker. In a phrase-only room (the hello carries `phrases`) the chat box shows a picker instead of the input; each button sends one phrase by id, and every viewer reads the phrase in their own
// catalogue (`phrase.<id>`) when it has the key, else the canonical `text`. Real kit, real broadcaster, a local transport.

const KIDS = 'kids';
const BOOK = [
  { id: 'gg', text: 'Good game!' },
  { id: 'help', text: 'Can you help me?', group: 'Ask' },
  { id: 'thx', text: 'Thank you' },
  { id: 'where', text: 'Where is everyone?', group: 'Ask' },
];
const CONTEXTS = { junior: { chat: { phrases: 'junior' } } };
const TAGS = { context: 'junior' };

let w: ChatWorld;
const make = async (over: Parameters<typeof chatWorld>[0] = {}): Promise<void> => {
  w = await chatWorld({ contexts: CONTEXTS, phrases: { junior: BOOK }, ...over });
};
afterEach(() => w.close());

const withCatalog = (extra: Record<string, string>, locale = 'en'): PlayerT => createT({ ...en, ...enChat, ...extra }, locale);
const picker = (): HTMLElement => screen.getByRole('group', { name: 'Phrases' });
const buttons = (): HTMLElement[] => within(picker()).getAllByRole('button');
const names = (): string[] => buttons().map((b) => b.textContent ?? '');
const status = (): HTMLElement => document.querySelector('.cw-chat-refusal') as HTMLElement;
const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room={KIDS} {...FIXED} now={w.clock.now} {...props} />;

async function join(name = 'snerp', props: Partial<ChatBoxProps> = {}, extra: { who?: { accountId: string } } = {}) {
  const transport = w.transportFor(name, {}, { member: { tags: TAGS }, ...(extra.who === undefined ? {} : { who: extra.who }) }) as LocalTransport;
  const view = renderUi(box(transport, props));
  await screen.findByRole('group', { name: 'Phrases' });
  return { ...view, transport };
}

/** `name` says a phrase in the kids room, from outside any box. */
const sayPhrase = async (name: string, phrase: string): Promise<SendResult> => {
  const s = w.chat.session(KIDS, w.who(name), w.member(name, { tags: TAGS }));
  if ('refused' in s) throw new Error('refused');
  let out: SendResult | undefined;
  await act(async () => {
    out = s.sendPhrase({ phrase });
  });
  return out as SendResult;
};

/** A transport whose connections answer every phrase with `answer` (a scripted refusal). */
function refusing(name: string, answer: SendResult): LocalTransport {
  const transport = w.transportFor(name, {}, { member: { tags: TAGS } }) as LocalTransport;
  const open = transport.open.bind(transport);
  transport.open = (room, events): ChatConnection => ({ ...open(room, events), sendPhrase: () => Promise.resolve(answer) });
  return transport;
}
const refusal = (r: WireRefusal): SendResult => ({ ok: false, refused: r });

describe('the box in a phrase room', () => {
  it('shows the picker and no text input and no Send button; a free room shows the input and no picker', async () => {
    await make();
    await join();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(names()).toEqual(['Good game!', 'Thank you', 'Can you help me?', 'Where is everyone?']);
    const free = w.transportFor('wumbo');
    renderUi(<ChatBox transport={free} room="lobby" {...FIXED} now={w.clock.now} />);
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getAllByRole('group', { name: 'Phrases' })).toHaveLength(1);
  });

  it('groups the phrases under headings, ungrouped first with no heading, and a book with no groups has no headings at all', async () => {
    await make();
    await join();
    const headings = within(picker()).getAllByRole('heading');
    expect(headings.map((h) => h.textContent)).toEqual(['Ask']);
    expect(within(picker()).getAllByRole('list')).toHaveLength(2);
    w.close();
    await make({ phrases: { junior: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }] } });
    document.body.innerHTML = '';
    await join('plenk');
    expect(within(picker()).queryAllByRole('heading')).toHaveLength(0);
  });

  it('clicking a phrase sends its id, not its text, and the line appears in the log with the canonical text', async () => {
    await make();
    const { user, transport } = await join();
    await user.click(within(picker()).getByRole('button', { name: 'Can you help me?' }));
    expect(transport.sentPhrases).toEqual(['help']);
    expect(transport.sent).toEqual([]);
    expect(await within(screen.getByRole('log', { name: 'Chat' })).findByText('Can you help me?')).toBeInTheDocument();
    expect(status()).toHaveTextContent('Sent: Can you help me?');
  });

  it('another player\'s phrase arrives as a line with the canonical text', async () => {
    await make();
    await join();
    await sayPhrase('tarvo', 'gg');
    expect(await within(screen.getByRole('log', { name: 'Chat' })).findByText('Good game!')).toBeInTheDocument();
  });

  it('a spectator (readOnly) has no picker, and a restricted player sees the restriction line in its place', async () => {
    await make();
    const transport = w.transportFor('snerp', {}, { member: { tags: TAGS } });
    renderUi(box(transport, { readOnly: true }));
    await screen.findByRole('log', { name: 'Chat' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Phrases' })).toBeNull());
    document.body.innerHTML = '';
    const other = w.transportFor('plenk', {}, { member: { tags: TAGS } });
    w.chat.session(KIDS, w.who('plenk'), w.member('plenk', { tags: TAGS }));
    await w.sanction('chat', KIDS, 'plenk');
    renderUi(box(other));
    await screen.findByRole('log', { name: 'Chat' });
    expect(screen.queryByRole('group', { name: 'Phrases' })).toBeNull();
    expect(document.querySelector('.cw-restricted, [class*="restricted"]')).not.toBeNull();
  });

  it('phrase text is shown as text, never as markup', async () => {
    await make({ phrases: { junior: [{ id: 'x', text: '<b>bold</b> & <img src=x onerror=alert(1)>' }] } });
    await join();
    expect(buttons()[0]).toHaveTextContent('<b>bold</b> & <img src=x onerror=alert(1)>');
    expect(document.querySelector('b, img')).toBeNull();
  });
});

describe('each viewer reads the phrase in their own words', () => {
  it('a catalogue key phrase.gg is shown on the button and in the log when present; text otherwise', async () => {
    await make();
    const t = withCatalog({ 'phrase.gg': 'Bon match !' }, 'fr');
    const { user } = await join('snerp', { t, locale: 'fr' });
    expect(names()).toEqual(['Bon match !', 'Thank you', 'Can you help me?', 'Where is everyone?']);
    await user.click(within(picker()).getByRole('button', { name: 'Bon match !' }));
    const log = within(screen.getByRole('log', { name: 'Chat' }));
    expect(await log.findByText('Bon match !')).toBeInTheDocument();
    expect(log.queryByText('Good game!')).toBeNull();
    await sayPhrase('tarvo', 'thx');
    expect(await log.findByText('Thank you')).toBeInTheDocument();
  });

  it('the sender and a viewer in different locales see their own words for the same line', async () => {
    await make();
    const es = withCatalog({ 'phrase.gg': 'Buen juego' }, 'es');
    const fr = withCatalog({ 'phrase.gg': 'Bon match !' }, 'fr');
    const a = w.transportFor('snerp', {}, { member: { tags: TAGS } });
    const b = w.transportFor('tarvo', {}, { member: { tags: TAGS } });
    const { user } = renderUi(
      <>
        <ChatBox transport={a} room={KIDS} {...FIXED} now={w.clock.now} t={es} locale="es" />
        <ChatBox transport={b} room={KIDS} {...FIXED} now={w.clock.now} t={fr} locale="fr" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole('group', { name: 'Phrases' })).toHaveLength(2));
    const [boxA] = screen.getAllByRole('group', { name: 'Phrases' }) as [HTMLElement, HTMLElement];
    await user.click(within(boxA).getByRole('button', { name: 'Buen juego' }));
    const [logA, logB] = screen.getAllByRole('log') as [HTMLElement, HTMLElement];
    expect(await within(logA).findByText('Buen juego')).toBeInTheDocument();
    expect(await within(logB).findByText('Bon match !')).toBeInTheDocument();
    expect(within(logB).queryByText('Buen juego')).toBeNull();
  });

  it('a phrase the viewer has no key for, and a line whose phrase id the book does not know, show the line\'s text', async () => {
    await make();
    const t = withCatalog({ 'phrase.other': 'Autre' });
    await join('snerp', { t });
    await sayPhrase('tarvo', 'gg');
    expect(await within(screen.getByRole('log', { name: 'Chat' })).findByText('Good game!')).toBeInTheDocument();
    // a history line whose id the catalogue has no key for, and one with an id that is not a token, both fall back to the text
    const transport = w.transportFor('plenk', {}, { member: { tags: TAGS } }) as LocalTransport;
    document.body.innerHTML = '';
    renderUi(box(transport, { t }));
    await screen.findByRole('group', { name: 'Phrases' });
    await act(async () => {
      transport.inject({ type: 'line', line: { id: '900', at: w.clock.t, name: 'quissel', text: 'Fallback text', phrase: 'gone' } });
    });
    expect(await within(screen.getByRole('log', { name: 'Chat' })).findByText('Fallback text')).toBeInTheDocument();
  });

  it('a host t that answers the key itself for a missing phrase falls back to the text (no phrase.gg shown)', async () => {
    await make();
    const host: PlayerT = (key, params) => createT({ ...en, ...enChat })(key, params);
    await join('snerp', { t: host });
    expect(names()[0]).toBe('Good game!');
    expect(document.body.textContent).not.toContain('phrase.gg');
  });
});

describe('the picker', () => {
  const MANY = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, text: `Phrase ${i}${i % 2 === 0 ? ' even' : ' odd'}` }));
  const TWELVE = MANY.slice(0, 12);

  it('has a filter box only above 12 phrases, labelled, and the filter narrows the list and says how many remain', async () => {
    await make({ phrases: { junior: TWELVE } });
    await join();
    expect(screen.queryByRole('searchbox', { name: 'Find a phrase' })).toBeNull();
    w.close();
    document.body.innerHTML = '';
    await make({ phrases: { junior: MANY } });
    const { user } = await join('plenk');
    const filter = screen.getByRole('searchbox', { name: 'Find a phrase' });
    expect(buttons()).toHaveLength(13);
    await user.type(filter, 'ODD');
    expect(buttons().map((b) => b.textContent)).toEqual(['Phrase 1 odd', 'Phrase 3 odd', 'Phrase 5 odd', 'Phrase 7 odd', 'Phrase 9 odd', 'Phrase 11 odd']);
    expect(document.querySelector('.cw-chat-note, .cw-chat-phrase-count, [role="status"]')).not.toBeNull();
    expect(screen.getByText('6 phrases shown')).toBeInTheDocument();
    await user.clear(filter);
    await user.type(filter, 'Phrase 12');
    expect(screen.getByText('1 phrase shown')).toBeInTheDocument();
    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(screen.getByText('No phrase matches.')).toBeInTheDocument();
    expect(within(picker()).queryAllByRole('button')).toHaveLength(0);
  });

  it('filters on the viewer\'s own words, not the canonical text', async () => {
    await make({ phrases: { junior: MANY } });
    const t = withCatalog({ 'phrase.p3': 'Zorro merece' }, 'es');
    const { user } = await join('snerp', { t, locale: 'es' });
    await user.type(screen.getByRole('searchbox', { name: 'Find a phrase' }), 'zorro');
    expect(names()).toEqual(['Zorro merece']);
  });

  it('is one tab stop: one button has tabindex 0, and the arrow keys, Home and End move focus and the stop', async () => {
    await make();
    const { user } = await join();
    const stops = (): HTMLElement[] => buttons().filter((b) => b.getAttribute('tabindex') === '0');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(buttons()[0]);
    await user.tab();
    const first = buttons()[0]!;
    // focus lands on the one tab stop (the log is focusable before it)
    for (let i = 0; i < 4 && document.activeElement !== first; i += 1) await user.tab();
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(buttons()[1]).toHaveFocus();
    expect(stops()).toEqual([buttons()[1]]);
    await user.keyboard('{ArrowRight}');
    expect(buttons()[2]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(buttons()[1]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(buttons()[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(buttons()[3]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(buttons()[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(buttons()[3]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(buttons()[0]).toHaveFocus();
  });

  it('Enter on a focused phrase sends it, and focus stays on that phrase', async () => {
    await make();
    const { user, transport } = await join();
    const target = within(picker()).getByRole('button', { name: 'Thank you' });
    target.focus();
    await user.keyboard('{Enter}');
    expect(transport.sentPhrases).toEqual(['thx']);
    await waitFor(() => expect(target).toHaveFocus());
  });

  it('the live region announces the result: Sent, and then nothing more until the next', async () => {
    await make();
    const { user } = await join();
    expect(status()).toHaveAttribute('role', 'status');
    expect(status()).toHaveTextContent('');
    await user.click(within(picker()).getByRole('button', { name: 'Good game!' }));
    expect(status()).toHaveTextContent('Sent: Good game!');
  });

  it('announces the sent phrase in the viewer\'s own words', async () => {
    await make();
    const { user } = await join('snerp', { t: withCatalog({ 'phrase.gg': 'Bon match !' }, 'fr') });
    await user.click(within(picker()).getByRole('button', { name: 'Bon match !' }));
    expect(status()).toHaveTextContent('Sent: Bon match !');
  });

  it('a refused send shows the refusal sentence in the live region and keeps the picker', async () => {
    await make();
    const cases: Array<[WireRefusal, string]> = [
      [{ reason: 'phrase_unknown' }, 'That phrase is not available.'],
      [{ reason: 'phrases_only' }, 'This chat uses phrases. Choose one from the list.'],
      [{ reason: 'account_too_new' }, 'Your account is too new to chat here yet.'],
      [{ reason: 'rate' }, 'You are sending messages too fast. Wait a moment.'],
      [{ reason: 'gate' }, 'You cannot send messages here right now.'],
      [{ reason: 'blocked', rule: 1 }, 'That message was not sent. It breaks a community rule. Community Rule 1.'],
    ];
    for (const [answer, sentence] of cases) {
      document.body.innerHTML = '';
      const transport = refusing('snerp', refusal(answer));
      const { user } = renderUi(box(transport));
      await screen.findByRole('group', { name: 'Phrases' });
      await user.click(within(picker()).getByRole('button', { name: 'Good game!' }));
      expect(status(), answer.reason).toHaveTextContent(sentence);
      expect(screen.getByRole('group', { name: 'Phrases' })).toBeInTheDocument();
    }
  });

  it('a pacing refusal with a wait holds the phrases (aria-disabled) for that long, then gives them back', async () => {
    await make();
    const transport = refusing('snerp', refusal({ reason: 'slow_mode', retryAfterMs: 120 }));
    const { user } = renderUi(box(transport));
    await screen.findByRole('group', { name: 'Phrases' });
    await user.click(within(picker()).getByRole('button', { name: 'Good game!' }));
    expect(status()).toHaveTextContent('Slow mode is on. You can send another message in 1 second.');
    for (const b of buttons()) expect(b).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(buttons()[0]).not.toHaveAttribute('aria-disabled'), { timeout: 2000 });
    expect(status()).toHaveTextContent('');
  });

  it('a dropped connection words the failure and does not lose the picker', async () => {
    await make();
    const transport = w.transportFor('snerp', { failSend: true }, { member: { tags: TAGS } });
    const { user } = renderUi(box(transport));
    await screen.findByRole('group', { name: 'Phrases' });
    await user.click(within(picker()).getByRole('button', { name: 'Good game!' }));
    expect(status()).toHaveTextContent('Could not reach the server.');
    expect(picker()).toBeInTheDocument();
  });

  it('a double click sends once while the first is in flight', async () => {
    await make();
    let release: (r: SendResult) => void = () => undefined;
    const transport = w.transportFor('snerp', {}, { member: { tags: TAGS } }) as LocalTransport;
    const open = transport.open.bind(transport);
    let calls = 0;
    transport.open = (room, events): ChatConnection => ({
      ...open(room, events),
      sendPhrase: () => {
        calls += 1;
        return new Promise<SendResult>((resolve) => {
          release = resolve;
        });
      },
    });
    renderUi(box(transport));
    await screen.findByRole('group', { name: 'Phrases' });
    const target = within(picker()).getByRole('button', { name: 'Good game!' });
    fireEvent.click(target);
    fireEvent.click(target);
    expect(calls).toBe(1);
    await act(async () => {
      release({ ok: true, line: { id: '1', at: w.clock.t, name: 'snerp', text: 'Good game!', phrase: 'gg', mine: true } });
    });
    fireEvent.click(target);
    expect(calls).toBe(2);
  });

  it('a transport with no sendPhrase (a custom one) fails the send with words and sends nothing as text', async () => {
    await make();
    const base = w.transportFor('snerp', {}, { member: { tags: TAGS } }) as LocalTransport;
    const open = base.open.bind(base);
    base.open = (room, events): ChatConnection => {
      const { sendPhrase: _unused, ...rest } = open(room, events);
      void _unused;
      return rest;
    };
    const { user } = renderUi(box(base));
    await screen.findByRole('group', { name: 'Phrases' });
    await user.click(within(picker()).getByRole('button', { name: 'Good game!' }));
    expect(status().textContent).not.toBe('');
    expect(base.sent).toEqual([]);
  });

  it('a real account-too-new refusal from the kit reads as the sentence', async () => {
    await make({
      contexts: { junior: { chat: { phrases: 'junior', minAccountAgeDays: 7 } } },
      signals: { accountAgeDays: (ids) => (ids[0]?.startsWith('new-') === true ? 1 : 90) },
    });
    const { user } = await join('snerp', {}, { who: { accountId: 'new-snerp' } });
    await user.click(within(picker()).getByRole('button', { name: 'Good game!' }));
    expect(status()).toHaveTextContent('Your account is too new to chat here yet.');
  });

  it('a locked room pauses the picker: aria-disabled buttons that send nothing, as the composer does', async () => {
    await make({ signals: { accountAgeDays: (ids) => (ids[0]?.startsWith('old-') === true ? 90 : undefined) } });
    w.real.rooms.setMode(KIDS, 'locked', { forMs: 30 * 60_000 });
    const { user, transport } = await join('snerp', {}, { who: { accountId: 'old-snerp' } });
    for (const b of buttons()) expect(b).toHaveAttribute('aria-disabled', 'true');
    await user.click(buttons()[0]!);
    expect(transport.sentPhrases).toEqual([]);
    expect(screen.getByText(/^Chat is locked until /)).toBeInTheDocument();
  });
});

describe('the state', () => {
  const hello = (phrases: unknown): ChatFrame => ({ type: 'hello', v: 2, mode: { kind: 'normal', until: null }, epoch: 'e', room: KIDS, you: { name: 'snerp' }, maxLength: 200, heartbeatMs: 20_000, summary: '', restriction: null, lines: [], muted: [], phrases } as unknown as ChatFrame);

  it('holds the book from the hello, null for a free room, and a later hello replaces it', () => {
    let state = chatReducer(createChatState(), { type: 'frame', frame: hello({ book: BOOK }) });
    expect(state.phrases).toEqual(BOOK);
    state = chatReducer(state, { type: 'frame', frame: hello(null) });
    expect(state.phrases).toBeNull();
    expect(createChatState().phrases).toBeNull();
  });

  it('a line with a phrase id is held with it, and a re-delivered copy with a different phrase replaces it', () => {
    const base = chatReducer(createChatState(), { type: 'frame', frame: hello(null) });
    const a = chatReducer(base, { type: 'frame', frame: { type: 'line', line: { id: '1', at: 1, name: 'x', text: 'Good game!', phrase: 'gg' } } });
    expect(a.lines[0]).toMatchObject({ phrase: 'gg' });
    const b = chatReducer(a, { type: 'frame', frame: { type: 'line', line: { id: '1', at: 1, name: 'x', text: 'Good game!', phrase: 'thx' } } });
    expect(b.lines[0]).toMatchObject({ phrase: 'thx' });
    expect(b).not.toBe(a);
    const same = chatReducer(b, { type: 'frame', frame: { type: 'line', line: { id: '1', at: 1, name: 'x', text: 'Good game!', phrase: 'thx' } } });
    expect(same).toBe(b);
  });

  it('a retracted phrase line keeps no phrase on its placeholder', () => {
    const base = chatReducer(createChatState(), { type: 'frame', frame: hello(null) });
    const a = chatReducer(base, { type: 'frame', frame: { type: 'line', line: { id: '1', at: 1, name: 'x', text: 'Good game!', phrase: 'gg' } } });
    const b = chatReducer(a, { type: 'frame', frame: { type: 'retract', ids: ['1'] } });
    expect(b.lines[0]).toEqual({ id: '1', at: 1, name: '', text: '', removed: true });
  });
});

describe('the words', () => {
  const NINE = [
    'player.chat.phrases',
    'player.chat.phraseFilter',
    'player.chat.phraseNone',
    'player.chat.phraseSent',
    'player.chat.phraseMatches.one',
    'player.chat.phraseMatches.other',
    'player.chat.refused.phrases_only',
    'player.chat.refused.phrase_unknown',
    'player.chat.refused.account_too_new',
  ];

  it('the nine keys exist, in plain ASCII, with only the placeholders they use', () => {
    for (const key of NINE) expect(Object.keys(enChat), key).toContain(key);
    const found = Object.keys(enChat).filter((k) => /^player\.chat\.(phrase|refused\.(phrases_only|phrase_unknown|account_too_new))/.test(k));
    expect(found.sort()).toEqual([...NINE].sort());
    for (const key of NINE) {
      const text = String(enChat[key as keyof typeof enChat]);
      expect([...text].every((ch) => ch.charCodeAt(0) < 128), key).toBe(true);
      const holes = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(holes.every((h) => ['count', 'text'].includes(h as string)), key).toBe(true);
    }
    expect(enChat['player.chat.refused.phrases_only']).toBe('This chat uses phrases. Choose one from the list.');
    expect(enChat['player.chat.refused.account_too_new']).toBe('Your account is too new to chat here yet.');
  });

  it('none of the phrase words shames or threatens', () => {
    const text = NINE.map((k) => String(enChat[k as keyof typeof enChat])).join(' ');
    expect(text).not.toMatch(/\b(punish|ban|bad|toxic|banned|violat)/i);
  });
});

describe('axe', () => {
  it.each(['light', 'dark'] as const)('the picker with a filter, a refusal and a sent line has no violations in the %s theme', async (theme) => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, text: `Phrase ${i}`, ...(i % 3 === 0 ? { group: 'Ask' } : {}) }));
    await make({ phrases: { junior: many } });
    const { user, container } = await join('snerp', { theme });
    const run = async () => (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
    expect(await run()).toEqual([]);
    await user.type(screen.getByRole('searchbox', { name: 'Find a phrase' }), '1');
    expect(await run()).toEqual([]);
    await user.click(buttons()[0]!);
    expect(await run()).toEqual([]);
    await user.clear(screen.getByRole('searchbox', { name: 'Find a phrase' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a phrase' }), 'zzz');
    expect(await run()).toEqual([]);
  });
});
