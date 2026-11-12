import { describe, expect, it } from 'vitest';
import { redactNote, redactText } from '../../src/ai/redact.js';

const aliases: Record<string, string> = { tarvo: 'P1', Glarn: 'P2', 'a.b+c': 'P3', fenrisk: 'P4', al: 'P5' };
const aliasOf = (h: string) => aliases[h] ?? null;
const handles = Object.keys(aliases);
const r = (text: string, hs: readonly string[] = handles) => redactText(text, hs, aliasOf);

describe('redactText: handles', () => {
  it('replaces every handle with its alias, whole token, any case', () => {
    expect(r('hey tarvo, TARVO and Tarvo!')).toBe('hey P1, P1 and P1!');
    expect(r('glarn said "glarn"')).toBe('P2 said "P2"');
    expect(r('(tarvo)')).toBe('(P1)');
    expect(r('tarvo')).toBe('P1');
    expect(r('tarvo_tarvo')).toBe('tarvo_tarvo'); // an underscore joins a word
    expect(r('tarvo-tarvo')).toBe('P1-P1'); // a hyphen does not
  });

  it('does not replace a handle under 3 characters inside a longer word', () => {
    expect(r('alpine and pal and balance')).toBe('alpine and pal and balance');
    // A 2-character handle is never replaced as a bare word either (it would eat ordinary words)...
    expect(r('al is here')).toBe('al is here');
    // ...but an explicit @-mention of it is a mention of that person.
    expect(r('hey @al')).toBe('hey @P5');
  });

  it('does not replace a handle inside a longer word', () => {
    expect(r('tarvos and untarvo and tarvo2 and xtarvox')).toBe('tarvos and untarvo and tarvo2 and xtarvox');
  });

  it("replaces a handle inside another player's line, including after an @", () => {
    expect(r('@tarvo you are bad, ask fenrisk')).toBe('@P1 you are bad, ask P4');
    expect(r('is that Glarn?')).toBe('is that P2?');
  });

  it('handles with regex characters are literal', () => {
    expect(r('hi a.b+c bye')).toBe('hi P3 bye');
    expect(r('hi aXb+c bye')).toBe('hi aXb+c bye');
    expect(r('hi a.bbc', ['a.b+c', '.*'])).toBe('hi a.bbc');
    expect(redactText('x.*y and xzzy', ['x.*y'], () => 'P9')).toBe('P9 and xzzy');
    expect(redactText('weird (round) [sq] {cu} ^$|?', ['(round)', '[sq]', '{cu}', '^$|?'], () => 'P8')).toBe('weird P8 P8 P8 P8');
  });

  it('prefers the longer handle when one contains another', () => {
    const map: Record<string, string> = { tarvo: 'P1', 'tarvo the great': 'P7' };
    expect(redactText('tarvo the great and tarvo', Object.keys(map), (h) => map[h] ?? null)).toBe('P7 and P1');
  });

  it('skips a handle with no alias, and an empty handle', () => {
    expect(redactText('vlemmo is here', ['vlemmo', ''], () => null)).toBe('vlemmo is here');
    expect(redactText('anything', [''], () => 'P1')).toBe('anything');
  });

  it('matches non-ASCII handles', () => {
    expect(redactText('hola Ñandú!', ['ñandú'], () => 'P6')).toBe('hola P6!');
    expect(redactText('Ñandúes', ['ñandú'], () => 'P6')).toBe('Ñandúes');
  });
});

describe('redactText: placeholders', () => {
  const cases: Array<[string, string, string]> = [
    ['email', 'mail me at zorbak.quissel+x@example.co.uk now', 'mail me at [email] now'],
    ['email upper', 'JOE@EXAMPLE.COM', '[email]'],
    ['phone with spaces', 'call 555 123 4567 tonight', 'call [phone] tonight'],
    ['phone with dashes', 'call 555-123-4567 tonight', 'call [phone] tonight'],
    ['phone with a country code', 'call +1 (555) 123-4567 tonight', 'call [phone] tonight'],
    ['phone, bare digits', 'call 5551234 tonight', 'call [phone] tonight'],
    ['ipv4', 'his ip is 192.168.0.12, ban it', 'his ip is [ip], ban it'],
    ['ipv6 full', 'ip 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok', 'ip [ip] ok'],
    ['ipv6 short', 'ip 2001:db8::ff00:42:8329 ok', 'ip [ip] ok'],
    ['ipv6 loopback', 'try ::1 now', 'try [ip] now'],
    ['ipv6 link-local', 'try fe80::1 now', 'try [ip] now'],
    ['url', 'see https://evil.example/a?b=c#d for it', 'see [link] for it'],
    ['url with trailing punctuation', 'see https://evil.example/a, then', 'see [link], then'],
    ['www', 'visit www.evil.example today', 'visit [link] today'],
    ['bare domain with a path', 'go evil.example.net/promo/1 now', 'go [link] now'],
    ['bare domain with a known ending', 'go to spam.com now', 'go to [link] now'],
    ['discord invite', 'join discord.gg/abc123 now', 'join [link] now'],
    ['discord invite, full', 'join https://discord.com/invite/abc123 now', 'join [link] now'],
    ['tag', 'add zorbak#1234 on there', 'add [tag] on there'],
    ['tag with underscore', 'add snerp_fan#00421 please', 'add [tag] please'],
    ['mention', 'ping @quissel_99 please', 'ping [mention] please'],
    ['two mentions', '@vlemmo @drakkuun', '[mention] [mention]'],
    ['long hex token', 'key 0123456789abcdef0123456789abcdef ok', 'key [token] ok'],
    ['long base64-like token', 'key dGhpcyBpcyBhIHRva2VuMTIzNDU2Nzg5 ok', 'key [token] ok'],
    ['uuid', 'id 123e4567-e89b-12d3-a456-426614174000 ok', 'id [token] ok'],
  ];
  it.each(cases)('placeholders: %s', (_name, input, expected) => {
    expect(r(input, [])).toBe(expected);
  });

  it('placeholders: email, phone with spaces and dashes, ipv4, ipv6, url, invite link, name#1234, mention, long token', () => {
    const line = 'a@b.co 555 123 4567 1.2.3.4 ::1 http://x.example/y discord.gg/zz zorbak#1234 @tarvo0 ' + 'f'.repeat(24);
    expect(r(line, [])).toBe('[email] [phone] [ip] [ip] [link] [link] [tag] [mention] [token]');
  });

  it('a sentence with no personal data is unchanged', () => {
    for (const s of [
      'gg wp, that was close',
      'You are so bad at this game, honestly.',
      'round 3 of 5, score 12 to 9',
      'it costs 1,000 gold',
      'Wait... what? No way.',
      'antidisestablishmentarianism is a long word',
      'see you at 10:30',
      'a 6 digit code 123456 is fine',
      'P1 is mad',
      'std::vector and std::map',
      'v1.2/3 of the map',
    ]) {
      expect(r(s, []), s).toBe(s);
    }
  });

  it('a doxxing line keeps a [phone] placeholder, not the number', () => {
    const out = r('his number is 555-123-4567 and he lives at 10.0.0.9, call him');
    expect(out).toBe('his number is [phone] and he lives at [ip], call him');
    expect(out).not.toMatch(/\d{3}/);
  });

  it('does not turn an alias into a mention', () => {
    expect(r('@tarvo and @P3 and @nobody')).toBe('@P1 and @P3 and [mention]');
  });

  it('is deterministic and idempotent', () => {
    const once = r('zorbak#1234 mail a@b.co 555-123-4567 @tarvo https://x.example');
    expect(r(once)).toBe(once);
    expect(r('zorbak#1234 mail a@b.co 555-123-4567 @tarvo https://x.example')).toBe(once);
  });

  it('redacts through obfuscation by zero-width characters', () => {
    expect(r('5​5​5 123 4567', [])).toBe('[phone]');
    expect(r('a​@b.co', [])).toBe('[email]');
    expect(r('tar​vo', handles)).toBe('P1');
  });
});

describe('redactText: characters', () => {
  it('strips zero-width and bidi characters', () => {
    const noisy = [
      '​', '‌', '‍', '⁠', '﻿', '‎', '‏', '‪', '‫', '‬', '‭', '‮',
      '⁦', '⁧', '⁨', '⁩', '؜', '­',
    ];
    for (const c of noisy) expect(r(`ab${c}cd`, []), JSON.stringify(c)).toBe('abcd');
    expect(r('‮evil‬ text', [])).toBe('evil text');
  });

  it('strips control characters', () => {
    expect(r('a\u0000b\u0007c\u007Fd\u009Be', [])).toBe('abcde');
  });

  it('collapses whitespace', () => {
    expect(r('  a   b\t\tc\n\nd \r\n e  ', [])).toBe('a b c d e');
    expect(r('a  b', [])).toBe('a b');
    expect(r('   ', [])).toBe('');
    expect(r('', [])).toBe('');
  });

  it('keeps emoji and non-Latin text', () => {
    expect(r('\u{1F600} こんにちは', [])).toBe('\u{1F600} こんにちは');
  });
});

describe('redactNote', () => {
  const LONE = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]');

  it('redacts then cuts at 300', () => {
    const out = redactNote('call 555-123-4567 ' + 'x'.repeat(400), handles, aliasOf);
    expect([...(out ?? '')].length).toBe(300);
    expect(out?.startsWith('call [phone] ')).toBe(true);
  });

  it('cuts the note at 300 without splitting a surrogate pair', () => {
    const note = 'x'.repeat(299) + '\u{1F600}' + 'tail';
    const out = redactNote(note, [], aliasOf) ?? '';
    expect(out).toBe('x'.repeat(299) + '\u{1F600}');
    expect(out.length).toBe(301); // 301 UTF-16 units, 300 characters: the pair is whole
    expect(out).not.toMatch(LONE);
    // An all-emoji note too.
    const emoji = redactNote('\u{1F600}'.repeat(500), [], aliasOf) ?? '';
    expect([...emoji].length).toBe(300);
    expect(emoji.length).toBe(600);
    expect(emoji).not.toMatch(LONE);
  });

  it('leaves a short note whole, trims it and returns null for an empty one', () => {
    expect(redactNote('  hello   there ', [], aliasOf)).toBe('hello there');
    expect(redactNote('', [], aliasOf)).toBeNull();
    expect(redactNote('   ', [], aliasOf)).toBeNull();
    expect(redactNote('​', [], aliasOf)).toBeNull();
    expect(redactNote(null, [], aliasOf)).toBeNull();
  });

  it('honours a different cut', () => {
    expect(redactNote('abcdefghij', [], aliasOf, 4)).toBe('abcd');
  });

  it('replaces a handle in the note', () => {
    expect(redactNote('tarvo keeps insulting me', handles, aliasOf)).toBe('P1 keeps insulting me');
  });
});
