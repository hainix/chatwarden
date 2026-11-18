import { describe, expect, it } from 'vitest';
import { PhraseBookError, checkPhraseBooks } from '../src/phrases.js';
import { ProfileError } from '../src/profileError.js';
import { contextsWorld } from './contextsWorld.js';

// M5: phrase books. Declared in code, checked once at start: the grammar, the sizes, and each phrase through the matcher and the profanity filter.
// Synthetic words only (zorbak is blocked by the test matcher, snerp is starred by the test profanity filter).

const book = (n: number, over: Record<string, unknown> = {}): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `Phrase number ${i}`, ...over }));

const caught = (fn: () => unknown): PhraseBookError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PhraseBookError);
    return err as PhraseBookError;
  }
  throw new Error('expected PhraseBookError');
};

describe('books: sizes', () => {
  it('a valid book of 300 is accepted and 301 is refused, naming the book', () => {
    expect(Object.keys(checkPhraseBooks({ big: book(300) }))).toEqual(['big']);
    expect(checkPhraseBooks({ big: book(300) }).big).toHaveLength(300);
    const err = caught(() => checkPhraseBooks({ big: book(301) }));
    expect(err.book).toBe('big');
    expect(err.phraseId).toBeNull();
    expect(err.message).toContain('big');
  });

  it('20 books are accepted and 21 are refused', () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, book(1)]));
    expect(Object.keys(checkPhraseBooks(many(20)))).toHaveLength(20);
    expect(() => checkPhraseBooks(many(21))).toThrow(PhraseBookError);
  });

  it('no books at all (undefined, or an empty object) is fine and an empty book is a book with nothing to say', () => {
    expect(checkPhraseBooks(undefined)).toEqual({});
    expect(checkPhraseBooks({})).toEqual({});
    expect(checkPhraseBooks({ quiet: [] })).toEqual({ quiet: [] });
  });

  it('a value that is not an object of lists is refused', () => {
    for (const bad of [null, 7, 'junior', [], [book(1)], { junior: 'gg' }, { junior: null }, { junior: { id: 'gg', text: 'hi' } }]) {
      expect(() => checkPhraseBooks(bad), JSON.stringify(bad)).toThrow(PhraseBookError);
    }
  });
});

describe('books: ids', () => {
  it('a book id is a lowercase letter then lowercase letters, digits, _ or -, up to 32 characters', () => {
    for (const ok of ['a', 'junior', 'book_1-b', 'a'.repeat(32)]) expect(Object.keys(checkPhraseBooks({ [ok]: book(1) })), ok).toEqual([ok]);
    for (const no of ['', 'Junior', '1junior', 'a b', 'a'.repeat(33), '_a', 'caf\u00e9', '__proto__']) {
      expect(() => checkPhraseBooks({ [no]: book(1) }), no).toThrow(PhraseBookError);
    }
  });

  it('a phrase id is 1 to 32 characters of A-Za-z0-9_-', () => {
    for (const ok of ['gg', 'A-b_9', 'a'.repeat(32), '7']) expect(checkPhraseBooks({ j: [{ id: ok, text: 'hi' }] }).j?.[0]?.id, ok).toBe(ok);
    for (const no of ['', 'a b', 'a'.repeat(33), 'caf\u00e9', 'a.b', 5, null, undefined]) {
      expect(() => checkPhraseBooks({ j: [{ id: no, text: 'hi' }] }), String(no)).toThrow(PhraseBookError);
    }
  });

  it('a duplicate id in one book is refused naming the book and the id; the same id in two books is fine', () => {
    const err = caught(() =>
      checkPhraseBooks({
        j: [
          { id: 'gg', text: 'Good game!' },
          { id: 'gg', text: 'Another' },
        ],
      }),
    );
    expect(err.book).toBe('j');
    expect(err.phraseId).toBe('gg');
    expect(() => checkPhraseBooks({ a: [{ id: 'gg', text: 'Good game!' }], b: [{ id: 'gg', text: 'Good game!' }] })).not.toThrow();
  });
});

describe('books: texts and groups', () => {
  it('text is 1 to 100 characters: 100 accepted, 101 and empty refused, whitespace only is empty', () => {
    expect(checkPhraseBooks({ j: [{ id: 'a', text: 'x'.repeat(100) }] }).j).toHaveLength(1);
    for (const no of ['x'.repeat(101), '', '   ', 5, null]) {
      const err = caught(() => checkPhraseBooks({ j: [{ id: 'a', text: no }] }));
      expect(err.book).toBe('j');
      expect(err.phraseId).toBe('a');
    }
  });

  it('control characters and bidi controls are refused, accents, emoji and ordinary punctuation are fine', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b', 'a\u202eb', 'a\u2066b', 'a\u2069b', 'a\u200fb', 'a\u200eb', 'a\u061cb']) {
      expect(() => checkPhraseBooks({ j: [{ id: 'a', text: bad }] }), JSON.stringify(bad)).toThrow(PhraseBookError);
    }
    for (const good of ['Good game!', 'Tu es g\u00e9nial', 'Thanks \ud83d\ude00', "Can you help me? It's OK."]) {
      expect(checkPhraseBooks({ j: [{ id: 'a', text: good }] }).j?.[0]?.text).toBe(good);
    }
  });

  it('a group is optional, 1 to 24 characters, a string', () => {
    expect(checkPhraseBooks({ j: [{ id: 'a', text: 'hi', group: 'Ask' }] }).j?.[0]?.group).toBe('Ask');
    expect(checkPhraseBooks({ j: [{ id: 'a', text: 'hi', group: 'g'.repeat(24) }] }).j).toHaveLength(1);
    for (const no of ['', 'g'.repeat(25), 3, null, 'a\nb']) {
      expect(() => checkPhraseBooks({ j: [{ id: 'a', text: 'hi', group: no }] }), String(no)).toThrow(PhraseBookError);
    }
  });

  it('a phrase with a key of its own is refused (strict), and the id is named, not the key value', () => {
    const err = caught(() => checkPhraseBooks({ j: [{ id: 'a', text: 'hi', secret: 'the value' }] }));
    expect(err.phraseId).toBe('a');
    expect(err.message).not.toContain('the value');
  });

  it('a refusal never carries the text, whatever the fault', () => {
    const text = 'PRIVATE words zorbak here';
    const faults: unknown[] = [
      { j: [{ id: 'a', text: `${text}\u0000` }] },
      { j: [{ id: 'a b', text }] },
      { j: [{ id: 'a', text: text.repeat(10) }] },
      { j: [{ id: 'a', text, group: '' }] },
      { j: [{ id: 'a', text }, { id: 'a', text }] },
      { j: [{ id: 'a', text, other: text }] },
    ];
    for (const f of faults) {
      const err = caught(() => checkPhraseBooks(f));
      expect(err.message).not.toContain('PRIVATE');
      expect(err.message).not.toContain('zorbak');
    }
  });

  it('the result is a frozen copy: changing the input afterwards changes nothing', () => {
    const input = { j: [{ id: 'a', text: 'hi', group: 'G' }] };
    const out = checkPhraseBooks(input);
    input.j[0]!.text = 'changed';
    input.j.push({ id: 'b', text: 'more', group: 'G' });
    expect(out.j).toEqual([{ id: 'a', text: 'hi', group: 'G' }]);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.j)).toBe(true);
    expect(Object.isFrozen(out.j?.[0])).toBe(true);
  });
});

describe('books: the matcher and the profanity filter', () => {
  const screens = {
    matcher: { match: (t: string) => (/\bzorbak\b/i.test(t) ? { termId: 'syn:zorbak' } : null), spans: () => [] },
    filters: [{ apply: (t: string) => ({ hit: /\bsnerp\b/i.test(t), text: t }) }],
  };

  it('a phrase the matcher hits throws PhraseBookError naming book and id only', () => {
    const err = caught(() => checkPhraseBooks({ j: [{ id: 'ok', text: 'hello' }, { id: 'bad', text: 'you zorbak' }] }, screens));
    expect(err.book).toBe('j');
    expect(err.phraseId).toBe('bad');
    expect(err.message).not.toContain('zorbak');
    expect(err.message).not.toContain('you ');
  });

  it('a phrase the profanity filter flags throws too', () => {
    const err = caught(() => checkPhraseBooks({ j: [{ id: 'bad', text: 'a snerp day' }] }, screens));
    expect(err.phraseId).toBe('bad');
    expect(err.message).not.toContain('snerp');
  });

  it('a clean book passes both, and without screens nothing is looked up', () => {
    expect(() => checkPhraseBooks({ j: [{ id: 'ok', text: 'hello there' }] }, screens)).not.toThrow();
    expect(() => checkPhraseBooks({ j: [{ id: 'bad', text: 'you zorbak' }] })).not.toThrow();
  });

  it('a matcher or a filter that throws fails the start (a phrase that could not be checked is not trusted)', () => {
    const boom = () => {
      throw new Error('down');
    };
    const err = caught(() => checkPhraseBooks({ j: [{ id: 'a', text: 'hi' }] }, { matcher: { match: boom, spans: () => [] } }));
    expect(err.phraseId).toBe('a');
    expect(() => checkPhraseBooks({ j: [{ id: 'a', text: 'hi' }] }, { filters: [{ apply: boom }] })).toThrow(PhraseBookError);
  });
});

describe('createChatwarden: the books', () => {
  it('a phrase that the matcher hits or the profanity filter flags throws PhraseBookError at createChatwarden naming book and id only', async () => {
    const slur = (await contextsWorld({}, { phrases: { j: [{ id: 'bad', text: 'you zorbak' }] } }).catch((e: unknown) => e)) as PhraseBookError;
    expect(slur).toBeInstanceOf(PhraseBookError);
    expect(slur).toMatchObject({ book: 'j', phraseId: 'bad' });
    expect(slur.message).not.toContain('zorbak');
    const swear = contextsWorld({}, { phrases: { j: [{ id: 'sw', text: 'such a snerp' }] } });
    await expect(swear).rejects.toMatchObject({ book: 'j', phraseId: 'sw' });
  });

  it('a profane phrase is refused even where the base mode would allow swearing, when a context filter is in force', async () => {
    const w = contextsWorld({ kids: { profanity: { mode: 'refuse' }, chat: { phrases: 'j' } } }, { phrases: { j: [{ id: 'sw', text: 'such a snerp' }] } });
    await expect(w).rejects.toBeInstanceOf(PhraseBookError);
  });

  it('a good book starts, and the kit has the book for a tagged room only', async () => {
    const w = await contextsWorld({ junior: { chat: { phrases: 'junior' } }, free: {} }, { phrases: { junior: [{ id: 'gg', text: 'Good game!' }, { id: 'help', text: 'Can you help me?', group: 'Ask' }] } });
    const kid = w.player('K', { tags: { context: 'junior' } });
    const free = w.player('F', { tags: { context: 'free' } });
    const base = w.player('B');
    expect(w.cw.phrases.book('K')).toEqual([{ id: 'gg', text: 'Good game!' }, { id: 'help', text: 'Can you help me?', group: 'Ask' }]);
    expect(w.cw.phrases.book('F')).toBeNull();
    expect(w.cw.phrases.book('B')).toBeNull();
    expect(w.cw.phrases.book('nobody-here')).toBeNull();
    expect(w.cw.phrases.names()).toEqual(['junior']);
    expect([kid, free, base]).toHaveLength(3);
  });

  it('a kit with no books has none: names is empty and every room is null', async () => {
    const w = await contextsWorld({});
    expect(w.cw.phrases.names()).toEqual([]);
    expect(w.cw.phrases.book('anything')).toBeNull();
  });

  it('the book handed back is frozen and cannot change the kit', async () => {
    const w = await contextsWorld({ junior: { chat: { phrases: 'junior' } } }, { phrases: { junior: [{ id: 'gg', text: 'Good game!' }] } });
    w.player('K', { tags: { context: 'junior' } });
    const held = w.cw.phrases.book('K') as unknown as Array<{ text: string }>;
    expect(() => {
      held[0]!.text = 'changed';
    }).toThrow();
    expect(w.cw.phrases.book('K')?.[0]?.text).toBe('Good game!');
  });
});

describe('createChatwarden: a context and its book', () => {
  it('a context naming an undeclared book is refused at start, naming the setting', async () => {
    const w = contextsWorld({ kids: { chat: { phrases: 'junior' } } }, { phrases: { other: [{ id: 'a', text: 'hi' }] } });
    await expect(w).rejects.toBeInstanceOf(ProfileError);
    await expect(w).rejects.toMatchObject({ path: 'profile.contexts.kids.chat.phrases' });
  });

  it('a context naming a book when the game declared no books at all is refused too', async () => {
    await expect(contextsWorld({ kids: { chat: { phrases: 'junior' } } })).rejects.toMatchObject({ path: 'profile.contexts.kids.chat.phrases' });
  });

  it('a declared book no context uses is fine, and so is a context with phrases null', async () => {
    const w = await contextsWorld({ kids: { chat: { phrases: null } } }, { phrases: { unused: [{ id: 'a', text: 'hi' }] } });
    expect(w.cw.phrases.names()).toEqual(['unused']);
    w.player('K', { tags: { context: 'kids' } });
    expect(w.cw.phrases.book('K')).toBeNull();
  });

  it('two contexts may share one book', async () => {
    const w = await contextsWorld({ a: { chat: { phrases: 'j' } }, b: { chat: { phrases: 'j' } } }, { phrases: { j: [{ id: 'gg', text: 'Good game!' }] } });
    w.player('A', { tags: { context: 'a' } });
    w.player('B', { tags: { context: 'b' } });
    expect(w.cw.phrases.book('A')).toEqual(w.cw.phrases.book('B'));
  });

  it('the phrases option itself is checked at start (grammar), before the store is touched', async () => {
    await expect(contextsWorld({}, { phrases: { Bad: [{ id: 'a', text: 'hi' }] } as never })).rejects.toBeInstanceOf(PhraseBookError);
  });
});
