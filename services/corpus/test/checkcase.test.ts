import { buildMatcher } from '@chatwarden/matcher';
import { describe, expect, it } from 'vitest';
import { MAX_CASE_LINES, MAX_CASE_LINE, checkCase, type CaseCode } from '../src/checkCase.js';

// checkCase (design 12): the privacy rules for a case that came from real chat, before a reviewer sees it. Closed codes, never a quote. Invented words
// only; the "real" things it must refuse (a URL, an email, a phone number, an invite code) are made-up examples on reserved test domains.

const corpus = buildMatcher([
  { id: 'a', term: 'quissel', language: 'en', active: true },
  { id: 'b', term: 'zorbak', language: 'en', active: true },
], []);

const line = (text: string, who: string = 'reported', extra: Record<string, unknown> = {}) => ({ who, text, ...extra });
const make = (lines: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'rude-quissel-1',
  group: 'rude',
  reason: 'harassment',
  note: null,
  lines,
  expect: { severity: 'rude', verdict: 'noted' },
  meta: { language: 'en', source: 'contributed', reviewed: 3 },
  ...over,
});
const codes = (c: unknown, source?: unknown, options?: Parameters<typeof checkCase>[2]): CaseCode[] => {
  const r = checkCase(c, source, options);
  return r.ok ? [] : r.codes;
};
const one = (text: string, who = 'reported') => make([line(text, who)]);

describe('checkCase refuses: a handle-shaped speaker, a URL, an email, a phone number, an invite code, 13 lines, a 201-character line, a line equal to the source line; accepts a paraphrase', () => {
  it('accepts an ordinary short case, with the three speakers and numbers of four digits or fewer', () => {
    const c = make([line('that was a fair fight', 'reporter'), line('you play like a quissel', 'reported'), line('ok, 3 to 1 gg', 'other'), line('room 12 had 1234 points')]);
    expect(checkCase(c)).toEqual({ ok: true });
  });

  it.each(['reporter#1234', 'zorbak_99', 'Alice', '@alice', 'player 3', 'reported ', 'REPORTED', '', 'reported\n', '12345'])('refuses the speaker %j as identifier', (who) => {
    expect(codes(one('hello', who))).toEqual(['identifier']);
  });

  it.each([
    'see https://example.test/page',
    'see http://example.test',
    'ftp://example.test/x',
    'visit www.example.test',
    'try example.com now',
    'my site is a.dev',
    'fullwidth \uff48\uff54\uff54\uff50\uff1a\uff0f\uff0fexample.test',
  ])('refuses the URL %j as contact', (text) => {
    expect(codes(one(text))).toEqual(['contact']);
  });

  it.each(['mail me at name@example.test', 'name (at) example dot test is not caught, but name@host.test is', 'ping @someone now', 'a @ b', 'full \uff20 width'])('refuses the email or mention %j as contact', (text) => {
    expect(codes(one(text)), text).toContain('contact');
  });

  it.each(['call 555-123-4567', 'call +1 (555) 123 4567', 'text me 5551234567', 'my number is 07700 900123', 'tel: 555.123.4567'])('refuses the phone number %j', (text) => {
    expect(codes(one(text)), text).toEqual(expect.arrayContaining(['contact']));
  });

  it.each(['join discord.gg/abcdEF1', 'discord.com/invite/xyz123', 'invite code: AB12CD34', 'join code 9XQ7ZZ', 'party link: AB12CD'])('refuses the invite code %j as contact', (text) => {
    expect(codes(one(text)), text).toContain('contact');
  });

  it.each(['I live at 221 Baker Street', '45 elm road please', '1600 Penn Avenue'])('refuses the street address %j as contact', (text) => {
    expect(codes(one(text)), text).toContain('contact');
  });

  it.each(['my ip is 192.168.1.20', 'host 10.0.0.1:8080', 'at 2001:db8:85a3:0:0:8a2e:370:7334', 'id 123456', 'steam 76561198000000000', 'ref 1234567890', 'full \uff11\uff12\uff13\uff14\uff15', 'at 14:35 today', 'on 2026-12-01 it happened', 'user#4821', 'uuid 123e4567-e89b-12d3-a456-426614174000', 'token deadbeefdeadbeefdeadbeef'])('refuses the identifier %j', (text) => {
    expect(codes(one(text)), text).toContain('identifier');
  });

  it('applies the same rules to the note', () => {
    expect(codes(make([line('fine')], { note: 'reported by user#4821' }))).toEqual(['identifier']);
    expect(codes(make([line('fine')], { note: 'see https://example.test' }))).toEqual(['contact']);
    expect(checkCase(make([line('fine')], { note: 'a plain note about tone' }))).toEqual({ ok: true });
  });

  it('applies the same rules to the reason and the group, which are published too', () => {
    expect(codes(make([line('fine')], { reason: 'reported by user#4821' }))).toEqual(['identifier']);
    expect(codes(make([line('fine')], { group: 'see https://example.test' }))).toEqual(['contact']);
    expect(codes(make([line('fine')], { reason: 'write to mail@example.test' }))).toEqual(['contact']);
    expect(codes(make([line('fine')], { group: 'room 192.0.2.7' }))).toEqual(['identifier']);
    expect(checkCase(make([line('fine')], { reason: 'harassment', group: 'long-room' }))).toEqual({ ok: true });
    expect(checkCase(make([line('fine')], { reason: null }))).toEqual({ ok: true });
    expect(checkCase(make([line('fine')], { reason: 12, group: undefined }))).toEqual({ ok: true });
  });

  it('holds a case to 12 lines: 12 pass, 13 are too long', () => {
    expect(MAX_CASE_LINES).toBe(12);
    expect(checkCase(make(Array.from({ length: 12 }, (_, i) => line(`line ${i}`))))).toEqual({ ok: true });
    expect(codes(make(Array.from({ length: 13 }, (_, i) => line(`line ${i}`))))).toEqual(['too_long']);
  });

  it('holds a line to 200 characters: 200 pass, 201 are too long', () => {
    expect(MAX_CASE_LINE).toBe(200);
    expect(checkCase(one('x'.repeat(200)))).toEqual({ ok: true });
    expect(codes(one('x'.repeat(201)))).toEqual(['too_long']);
  });

  it('refuses a line equal to a source line (ignoring case, spacing, punctuation and accents), and accepts a paraphrase', () => {
    const source = make([line('You play like a Quissel!!'), line('that was a fair fight', 'reporter')]);
    expect(codes(one('you  play like a quissel'), source)).toEqual(['copy_of_source']);
    expect(codes(one('YOU PLAY LIKE A QUISSEL.'), source)).toEqual(['copy_of_source']);
    expect(codes(one('that was a f\u00e1ir fight', 'reporter'), source)).toEqual(['copy_of_source']);
    expect(checkCase(one('your play is a quissel kind of bad'), source)).toEqual({ ok: true });
    expect(checkCase(one('that was fair'), source)).toEqual({ ok: true });
  });

  it('takes the source as a case, or a list of strings, and ignores empty lines in it', () => {
    expect(codes(one('same words here'), ['Same words here.'])).toEqual(['copy_of_source']);
    expect(checkCase(one('other words'), ['', '   ', '!!!'])).toEqual({ ok: true });
    expect(checkCase(one('other words'), undefined)).toEqual({ ok: true });
  });

  it('reports every code that applies, in a fixed order, and never a quote', () => {
    const c = make([line('mail name@example.test from 192.168.1.20', 'Alice'), line('x'.repeat(201))]);
    const r = checkCase(c, [(c.lines[1] as { text: string }).text]);
    expect(r).toEqual({ ok: false, codes: ['identifier', 'contact', 'too_long', 'copy_of_source'] });
    expect(JSON.stringify(r)).not.toMatch(/name@|192|Alice/);
  });
});

describe('a case whose term is not a corpus term is unknown_term', () => {
  it('a line marked blocked must be blocked by the corpus; one that is not is unknown_term', () => {
    const ok = make([line('you play like a quissel', 'reported', { blocked: true }), line('fine', 'reporter')]);
    expect(checkCase(ok, undefined, { corpus })).toEqual({ ok: true });
    const bad = make([line('you play like a snerpux', 'reported', { blocked: true })]);
    expect(codes(bad, undefined, { corpus })).toEqual(['unknown_term']);
  });

  it('a line that is not marked blocked is not asked for a term, and without a corpus the check is not made', () => {
    expect(checkCase(make([line('you play like a snerpux')]), undefined, { corpus })).toEqual({ ok: true });
    expect(checkCase(make([line('you play like a snerpux', 'reported', { blocked: true })]))).toEqual({ ok: true });
  });

  it('the matcher reads obfuscation the way the corpus does (accents, repeats, a zero-width space)', () => {
    const c = make([line('qu\u00efssel!!', 'reported', { blocked: true }), line('zorb\u200bak', 'reported', { blocked: true }), line('quisssel', 'reported', { blocked: true })]);
    expect(checkCase(c, undefined, { corpus })).toEqual({ ok: true });
  });
});

describe('the 64-line long-room exception is the repo\u2019s own cases only', () => {
  const longRoom = (n: number, source: string | undefined) => make(Array.from({ length: n }, (_, i) => line(`line ${i}`)), { group: 'long-room', meta: { language: 'en', ...(source === undefined ? {} : { source }), reviewed: 3 } });

  it('holds a contributed long-room case to 12 lines, whatever the group is called', () => {
    expect(codes(longRoom(20, 'contributed'))).toEqual(['too_long']);
    expect(codes(longRoom(13, 'contributed'))).toEqual(['too_long']);
  });

  it('allows 64 lines for a synthetic long-room case only, and 65 not', () => {
    expect(checkCase(longRoom(64, 'synthetic'))).toEqual({ ok: true });
    expect(codes(longRoom(65, 'synthetic'))).toEqual(['too_long']);
  });

  it('holds derived, unlabelled and other-group cases to 12', () => {
    expect(codes(longRoom(20, 'derived'))).toEqual(['too_long']);
    expect(codes(longRoom(20, undefined))).toEqual(['too_long']);
    expect(codes({ ...longRoom(20, 'synthetic'), group: 'rude' })).toEqual(['too_long']);
  });
});

describe('input it does not understand', () => {
  it('is refused as identifier (never thrown), whatever it is', () => {
    for (const bad of [null, undefined, 5, 'text', [], {}, { lines: 'x' }, { lines: [null] }, { lines: [{ who: 'reported' }] }, { lines: [{ who: 'reported', text: 5 }] }]) {
      expect(codes(bad), JSON.stringify(bad)).toEqual(['identifier']);
    }
  });
});
