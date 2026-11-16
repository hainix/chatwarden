import { describe, expect, it } from 'vitest';
import { MAX_SANCTION_DURATION_MS } from '@chatwarden/core';
import { actionOf, codeOf, encodeCustomId, parseCode, parseCustomId } from '../src/discord/customId.js';

// The `cw1` grammar (K5 D5, Review Focus 1): a custom_id is INPUT. The grammar is closed, canonical (what parses re-encodes to the same text) and short.

const ID22 = 'AbCdEfGhIjKlMnOpQrStUv';
const ID32 = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('custom_id: round trips', () => {
  it('round-trips every verb', () => {
    expect(parseCustomId(encodeCustomId({ verb: 'dis', reportId: ID22 }))).toEqual({ verb: 'dis', reportId: ID22 });
    expect(parseCustomId(encodeCustomId({ verb: 'sug', reportId: ID22 }))).toEqual({ verb: 'sug', reportId: ID22 });
    expect(parseCustomId(encodeCustomId({ verb: 'ok', reportId: ID22, code: 'n' }))).toEqual({ verb: 'ok', reportId: ID22, code: 'n' });
    expect(parseCustomId(encodeCustomId({ verb: 'x' }))).toEqual({ verb: 'x' });
  });

  it('the texts are the documented ones', () => {
    expect(encodeCustomId({ verb: 'dis', reportId: ID22 })).toBe(`cw1:dis:${ID22}`);
    expect(encodeCustomId({ verb: 'sug', reportId: ID22 })).toBe(`cw1:sug:${ID22}`);
    expect(encodeCustomId({ verb: 'ok', reportId: ID22, code: 'chat.86400000.2' })).toBe(`cw1:ok:${ID22}:chat.86400000.2`);
    expect(encodeCustomId({ verb: 'x' })).toBe('cw1:x');
  });

  it.each([
    ['n', null],
    ['chat.86400000.2', { kind: 'chat', durationMs: 86_400_000, rule: 2 }],
    ['area.604800000.4', { kind: 'area', durationMs: 604_800_000, rule: 4 }],
    ['ban.p.1', { kind: 'ban', durationMs: null, rule: 1 }],
    ['ban.2592000000.3', { kind: 'ban', durationMs: 2_592_000_000, rule: 3 }],
    ['warning.p.2', { kind: 'warning', durationMs: null, rule: 2 }],
    ['note.p.1', { kind: 'note', durationMs: null, rule: 1 }],
    ['chat.p.2', { kind: 'chat', durationMs: null, rule: 2 }],
    [`chat.${MAX_SANCTION_DURATION_MS}.999`, { kind: 'chat', durationMs: MAX_SANCTION_DURATION_MS, rule: 999 }],
  ])('every action code round-trips: %s', (code, action) => {
    const parsed = parseCode(code);
    expect(parsed).not.toBeNull();
    if (action === null) {
      expect(parsed).toEqual({ dismiss: true });
      expect(codeOf(null)).toBe('n');
      expect(actionOf(code)).toBeNull();
    } else {
      expect(parsed).toEqual({ dismiss: false, action });
      expect(actionOf(code)).toEqual(action);
      expect(codeOf(action as never)).toBe(code);
    }
  });

  it('the longest possible (32 character report id, the longest code) is at most 100 characters', () => {
    const longest = encodeCustomId({ verb: 'ok', reportId: ID32, code: `chat.${MAX_SANCTION_DURATION_MS}.999` });
    expect(longest.length).toBeLessThanOrEqual(100);
    expect(parseCustomId(longest)).not.toBeNull();
    expect(encodeCustomId({ verb: 'ok', reportId: ID32, code: 'ban.p.1' }).length).toBeLessThanOrEqual(100);
    expect(encodeCustomId({ verb: 'dis', reportId: ID32 }).length).toBeLessThanOrEqual(100);
  });

  it('encoding something outside the grammar is a RangeError (a programming error), never a bad text', () => {
    for (const bad of [
      { verb: 'dis' },
      { verb: 'dis', reportId: 'has space' },
      { verb: 'dis', reportId: 'a:b' },
      { verb: 'dis', reportId: 'x'.repeat(33) },
      { verb: 'ok', reportId: ID22 },
      { verb: 'ok', reportId: ID22, code: 'chat.-5.2' },
      { verb: 'nope', reportId: ID22 },
      { verb: 'x', reportId: ID22 },
    ]) {
      expect(() => encodeCustomId(bad as never), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe('custom_id: everything else parses to null, and never throws', () => {
  const cases: Array<[string, unknown]> = [
    ['garbage', 'hello'],
    ['empty', ''],
    ['an unknown version', `cw2:dis:${ID22}`],
    ['no version', `dis:${ID22}`],
    ['upper-case version', `CW1:dis:${ID22}`],
    ['an unknown verb', `cw1:ban:${ID22}`],
    ['an unknown verb of the right length', `cw1:xyz:${ID22}`],
    ['dis without a report id', 'cw1:dis'],
    ['dis with an empty report id', 'cw1:dis:'],
    ['dis with extra parts', `cw1:dis:${ID22}:n`],
    ['x with a part', 'cw1:x:y'],
    ['x with a trailing colon', 'cw1:x:'],
    ['a 101 character string', `cw1:dis:${'a'.repeat(101 - 8)}`],
    ['a report id of 33 characters', `cw1:dis:${'a'.repeat(33)}`],
    ['a report id with a space', 'cw1:dis:abc def'],
    ['a report id with a dot', 'cw1:dis:abc.def'],
    ['a report id with a slash', 'cw1:dis:abc/def'],
    ['a report id with a newline', 'cw1:dis:abc\ndef'],
    ['a report id with a non-ASCII letter', `cw1:dis:ab${String.fromCharCode(0x00e9)}`],
    ['ok without a code', `cw1:ok:${ID22}`],
    ['ok with an empty code', `cw1:ok:${ID22}:`],
    ['ok with an unknown kind', `cw1:ok:${ID22}:mute.86400000.2`],
    ['ok with a negative duration', `cw1:ok:${ID22}:chat.-86400000.2`],
    ['ok with a zero duration', `cw1:ok:${ID22}:chat.0.2`],
    ['ok with a duration with a leading zero', `cw1:ok:${ID22}:chat.086400000.2`],
    ['ok with a duration above the maximum', `cw1:ok:${ID22}:chat.${MAX_SANCTION_DURATION_MS + 1}.2`],
    ['ok with a 12 digit duration', `cw1:ok:${ID22}:chat.100000000000.2`],
    ['ok with a decimal duration', `cw1:ok:${ID22}:chat.1.5.2`],
    ['ok with an exponent duration', `cw1:ok:${ID22}:chat.1e9.2`],
    ['ok with a warning that has a length', `cw1:ok:${ID22}:warning.86400000.2`],
    ['ok with a note that has a length', `cw1:ok:${ID22}:note.1000.2`],
    ['ok with rule 0', `cw1:ok:${ID22}:chat.86400000.0`],
    ['ok with a negative rule', `cw1:ok:${ID22}:chat.86400000.-1`],
    ['ok with a four digit rule', `cw1:ok:${ID22}:chat.86400000.1000`],
    ['ok with the rule uncovered', `cw1:ok:${ID22}:chat.86400000.uncovered`],
    ['ok with a leading zero rule', `cw1:ok:${ID22}:chat.86400000.02`],
    ['ok with a missing rule', `cw1:ok:${ID22}:chat.86400000`],
    ['ok with an extra field', `cw1:ok:${ID22}:chat.86400000.2.1`],
    ['ok with an upper-case code', `cw1:ok:${ID22}:CHAT.86400000.2`],
    ['ok with n and more', `cw1:ok:${ID22}:n.p.1`],
    ['ok with a code and a colon', `cw1:ok:${ID22}:chat:86400000:2`],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['an object', { custom_id: 'cw1:x' }],
    ['an array', ['cw1:x']],
  ];
  it.each(cases)('%s', (_name, value) => {
    expect(parseCustomId(value)).toBeNull();
  });

  it('parseCode and actionOf refuse the same codes', () => {
    for (const code of ['', 'chat', 'x', 'N', 'chat.0.2', 'warning.5.2', 'chat.86400000.0', 5 as never, null as never]) {
      expect(parseCode(code), String(code)).toBeNull();
      expect(actionOf(code), String(code)).toBeNull();
    }
  });

  it('a hostile value never throws (a throwing toString, a proxy, a very long string)', () => {
    const evil = { toString: (): string => { throw new Error('x'); } };
    expect(parseCustomId(evil)).toBeNull();
    expect(parseCustomId('c'.repeat(100_000))).toBeNull();
    expect(parseCustomId(new Proxy({}, { get() { throw new Error('x'); } }))).toBeNull();
  });

  it('what parses is canonical: it encodes back to the same text', () => {
    for (const s of [`cw1:dis:${ID22}`, `cw1:sug:${ID32}`, 'cw1:x', `cw1:ok:${ID22}:n`, `cw1:ok:${ID22}:ban.p.1`, `cw1:ok:${ID22}:chat.86400000.2`]) {
      const p = parseCustomId(s);
      expect(p).not.toBeNull();
      expect(encodeCustomId(p as never)).toBe(s);
    }
  });
});
