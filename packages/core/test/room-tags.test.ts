import { describe, expect, it } from 'vitest';
import { checkRoomTags, MAX_ROOM_TAGS } from '../src/contexts.js';
import { contextsWorld, delivered } from './contextsWorld.js';

// M1: the reserved room tags (context, scope) and the shape of every tag, checked where a game seats a player.

const TAGS_OK = { context: 'kids', scope: 'creator:alice', mode: 'ranked', Region: 'eu-west_1' };

describe('checkRoomTags', () => {
  it('accepts undefined, an empty object, the reserved keys with good values and other keys of the grammar', () => {
    expect(() => checkRoomTags(undefined)).not.toThrow();
    expect(() => checkRoomTags({})).not.toThrow();
    expect(() => checkRoomTags(TAGS_OK)).not.toThrow();
    expect(() => checkRoomTags({ a: '' })).not.toThrow();
    expect(() => checkRoomTags({ k: 'x'.repeat(64) })).not.toThrow();
  });

  it('9 keys, a key that starts with a digit, a 65-character value, a non-string value all refused with RangeError', () => {
    const nine = Object.fromEntries(Array.from({ length: MAX_ROOM_TAGS + 1 }, (_, i) => [`k${i}`, 'v']));
    expect(() => checkRoomTags(nine)).toThrow(RangeError);
    expect(() => checkRoomTags(Object.fromEntries(Array.from({ length: MAX_ROOM_TAGS }, (_, i) => [`k${i}`, 'v'])))).not.toThrow();
    for (const tags of [{ '1a': 'v' }, { '': 'v' }, { 'a b': 'v' }, { [`k${'a'.repeat(32)}`]: 'v' }, { k: 'x'.repeat(65) }, { k: 5 }, { k: null }, { k: ['a'] }, { k: undefined }, 'x', 5, null, []]) {
      expect(() => checkRoomTags(tags), JSON.stringify(tags)).toThrow(RangeError);
    }
  });

  it('a bad context or scope value is refused, and the message never echoes the value', () => {
    for (const [key, value] of [['context', 'Kids'], ['context', ''], ['context', '1kids'], ['context', 'k'.repeat(33)], ['context', 'a b'], ['scope', 'Creator'], ['scope', ':x'], ['scope', 'a b'], ['scope', ''], ['scope', 'a'.repeat(65)]] as const) {
      let message = '';
      try {
        checkRoomTags({ [key]: value });
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
        message = (err as Error).message;
      }
      expect(message, `${key}=${value}`).not.toBe('');
      if (value.length > 2) expect(message).not.toContain(value);
    }
  });

  it('other keys pass through, including ones that look like reserved words', () => {
    expect(() => checkRoomTags({ contexts: 'Whatever Goes', scoped: 'x y z' })).not.toThrow();
  });
});

describe('cw.rooms.seat and the tags', () => {
  it('a malformed context tag at seat throws RangeError and seats nobody', async () => {
    const w = await contextsWorld({ kids: {} });
    expect(() => w.player('R1', { seat: 'a', tags: { context: 'Kids' } })).toThrow(RangeError);
    expect(w.cw.rooms.subjectAt('R1', 'a')).toBeNull();
    expect(w.cw.chat.accept('R1', 'a', 'hi')).toMatchObject({ refuse: { reason: 'gate' } });
    expect(w.cw.rooms.list()).toEqual([]);
    expect(w.cw.contexts.of('R1')).toBeNull();
  });

  it('seatConnection checks the tags the same way', async () => {
    const w = await contextsWorld({ kids: {} });
    expect(() => w.cw.rooms.seatConnection('R1', 'a', { clientKey: 'ck-aaaaaaaaaaaa' }, 'A', { scope: 'No Good' })).toThrow(RangeError);
    expect(() => w.cw.rooms.seatConnection('R1', 'a', { clientKey: 'ck-aaaaaaaaaaaa' }, 'A', { context: 'kids' })).not.toThrow();
    expect(w.cw.contexts.of('R1')).toBe('kids');
  });

  it("changing a room's context on a later seat throws, and the room keeps the first; the same context again is fine", async () => {
    const w = await contextsWorld({ kids: {}, ranked: {} });
    w.player('R1', { tags: { context: 'kids' } });
    expect(() => w.player('R1', { tags: { context: 'ranked' } })).toThrow(RangeError);
    expect(w.cw.contexts.of('R1')).toBe('kids');
    expect(() => w.player('R1', { tags: { context: 'kids' } })).not.toThrow();
    expect(() => w.player('R1')).not.toThrow();
    expect(w.cw.contexts.of('R1')).toBe('kids');
    w.cw.rooms.close('R1');
    expect(() => w.player('R1', { tags: { context: 'ranked' } })).not.toThrow();
    expect(w.cw.contexts.of('R1')).toBe('ranked');
  });

  it('a room that had no context cannot gain one mid-life without being refused only when it changes a set tag; a first context is allowed', async () => {
    const w = await contextsWorld({ kids: {} });
    w.player('R1');
    expect(() => w.player('R1', { tags: { context: 'kids' } })).not.toThrow();
    expect(w.cw.contexts.of('R1')).toBe('kids');
  });

  it('the scope tag grammar is checked the same, and a room scope cannot change on a later seat', async () => {
    const w = await contextsWorld({});
    w.player('R1', { tags: { scope: 'creator:alice' } });
    expect(() => w.player('R1', { tags: { scope: 'creator:bob' } })).toThrow(RangeError);
    expect(() => w.player('R1', { tags: { scope: 'creator:alice' } })).not.toThrow();
    expect(() => w.player('R2', { tags: { scope: 'Creator' } })).toThrow(RangeError);
    expect(w.cw.rooms.list().map((r) => r.tags['scope'])).toEqual(['creator:alice']);
  });

  it('tags merge across seats up to 8 keys in all; a 9th key refuses the seat and changes nothing', async () => {
    const w = await contextsWorld({});
    w.player('R1', { tags: { a: '1', b: '2', c: '3', d: '4' } });
    w.player('R1', { tags: { e: '5', f: '6', g: '7', h: '8' } });
    expect(() => w.player('R1', { tags: { i: '9' } })).toThrow(RangeError);
    expect(Object.keys(w.cw.rooms.list()[0]!.tags)).toHaveLength(8);
    expect(() => w.player('R1', { tags: { a: 'changed' } })).not.toThrow();
  });

  it('a refused seat creates no person and leaves an earlier occupant in place', async () => {
    const w = await contextsWorld({ kids: {} });
    const first = w.player('R1', { tags: { context: 'kids' } });
    const before = w.cw.rooms.subjectAt('R1', first);
    expect(() => w.cw.rooms.seat('R1', first, { clientKey: 'someone-else-aaaa' }, 'X', { context: 'nope1', scope: '' })).toThrow(RangeError);
    expect(w.cw.rooms.subjectAt('R1', first)).toBe(before);
    expect(delivered(w.cw.chat.accept('R1', first, 'hi'))).toBe(true);
  });

  it('the reserved keys and the others pass through to the report tags', async () => {
    const w = await contextsWorld({ kids: {} });
    w.cw.rooms.seat('R1', 'p1', { clientKey: 'key-reporter-aaaa' }, 'Rep', { context: 'kids', scope: 'creator:alice', mode: 'ranked' });
    w.cw.rooms.seat('R1', 'p2', { clientKey: 'key-target-aaaaaa' }, 'Tgt');
    const res = await w.submit('R1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(w.store.loadReport(res.reportId)?.tags).toEqual({ context: 'kids', scope: 'creator:alice', mode: 'ranked' });
  });

  it('cw.contexts.of returns the tag only when it is well formed, and null for a non-string room', async () => {
    const w = await contextsWorld({});
    w.player('R1', { tags: { context: 'kidz' } });
    expect(w.cw.contexts.of('R1')).toBe('kidz');
    expect(w.cw.contexts.of(5 as never)).toBeNull();
    expect(w.cw.contexts.of('')).toBeNull();
  });
});
