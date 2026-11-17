import { describe, expect, it } from 'vitest';
import { resolveFilters, type ResolvedPersonalInfo } from '../src/filters.js';
import { scanPersonal } from '../src/filters/personal.js';

const cfg = (extra: Record<string, unknown> = {}): ResolvedPersonalInfo => resolveFilters({ personalInfo: { action: 'mask', ...extra } } as never).personalInfo!;
const details = (text: string, c: ResolvedPersonalInfo = cfg()): string[] => scanPersonal(text, c).map((m) => m.detail);
const covered = (text: string, c: ResolvedPersonalInfo = cfg()): string[] => scanPersonal(text, c).map((m) => text.slice(m.span.start, m.span.end));
const hits = (text: string, detail: string, c: ResolvedPersonalInfo = cfg()): boolean => details(text, c).includes(detail);

describe('phone, formatted', () => {
  it.each(['+44 20 7946 0958', '(555) 010-9999', '555-010-9999', '555.010.9999', '+1 555 010 9999', '555 010 9999', '020 7946 0958', '+49 30 1234 5678'])('matches %s', (t) => {
    expect(hits(`call ${t} now`, 'phone'), t).toBe(true);
    expect(covered(`call ${t} now`).includes(t), t).toBe(true);
  });

  it.each([
    '100 200 300 400', // stepped
    '10 20 30 40',
    '1500 2000', // two groups
    '1500 2000 3000', // round numbers
    '3-1',
    '2024-11-17', // a date: 8 digits
    '12:30:45',
    '100/200/300',
    '40.7128 -74.0060', // coordinates
    '1.234.567.890', // thousands separators
    '1000 1000 1000 1000', // identical
    '5 5 5 5 5 5 5 5 5 5', // too many groups
    '1,234,567,890',
    '19.99 29.99 39.99',
    'score 12 - 9',
    '3 2 1',
    '123456789', // a bare run is not formatted
    '5550109999',
  ])('does not match %s', (t) => {
    expect(hits(`it was ${t} ok`, 'phone'), t).toBe(false);
  });

  it('a run glued to a letter is not a phone', () => {
    expect(hits('id A555-010-9999', 'phone')).toBe(false);
    expect(hits('x555 010 9999y', 'phone')).toBe(false);
  });

  it('a phone with the plus form takes 8 to 15 digits', () => {
    expect(hits('+12345678', 'phone')).toBe(true);
    expect(hits('+1234567', 'phone')).toBe(false);
    expect(hits('+123456789012345', 'phone')).toBe(true);
    expect(hits('+1234567890123456', 'phone')).toBe(false);
  });
});

describe('phone, any', () => {
  const any = cfg({ phone: 'any' });
  it('matches 9 to 15 digit runs, and its false positives are listed here', () => {
    for (const t of ['5550109999', '555 010 9999', '123456789', '123456789012345']) expect(hits(`n ${t}`, 'phone', any), t).toBe(true);
    // The documented false positives of `any`: a plain number, a list of round numbers, a long id.
    for (const t of ['1500 2000 3000', '100 200 300 400', '1234567890']) expect(hits(`n ${t}`, 'phone', any), t).toBe(true);
    for (const t of ['12345678', '1234567890123456', '3-1', '2024-11-17', '12:30:45']) expect(hits(`n ${t}`, 'phone', any), t).toBe(false);
  });
});

describe('card', () => {
  it('a Luhn-valid 16 digit number with spaces or dashes matches', () => {
    for (const t of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '5500 0000 0000 0004', '3782 822463 10005']) {
      expect(hits(`card ${t} ok`, 'card'), t).toBe(true);
    }
    expect(covered('card 4111 1111 1111 1111 ok')).toContain('4111 1111 1111 1111');
  });

  it('the same digits failing Luhn do not', () => {
    for (const t of ['4111 1111 1111 1112', '4111-1111-1111-1110', '1234 5678 9012 3456']) expect(hits(`card ${t} ok`, 'card'), t).toBe(false);
  });

  it('12 and 20 digits do not; 13 and 19 can', () => {
    expect(hits('x 4111 1111 1111', 'card')).toBe(false);
    expect(hits('x 4111 1111 1111 1111 1111', 'card')).toBe(false);
    expect(hits('x 4222222222222', 'card')).toBe(true);
    expect(hits('x 1234567890123456789', 'card')).toBe(false);
  });

  it('a card glued to a letter, or split by a double space, is not read', () => {
    expect(hits('A4111111111111111', 'card')).toBe(false);
    expect(hits('4111  1111  1111  1111', 'card')).toBe(false);
  });
});

describe('email', () => {
  it.each(['a@b.com', 'a.b+c@mail.example.com', 'tarvo_x@snerp.io', 'a [at] b [dot] com', 'a(at)b(dot)com', 'a{at}b{dot}com', 'x [AT] y [DOT] net', 'first.last@sub.vlemmo.co.uk'])('matches %s', (t) => {
    expect(hits(`mail ${t} please`, 'email'), t).toBe(true);
  });

  it('covers the whole address, and brackets and spaces inside the bracketed form', () => {
    expect(covered('mail a.b@c.com now')).toEqual(['a.b@c.com']);
    expect(covered('mail a [at] b [dot] com now')).toEqual(['a [at] b [dot] com']);
  });

  it.each(['a at b dot com', 'meet at noon', 'a@b', 'a@b.', '@b.com', 'a@.com', 'a@b..com', 'a@b.zip', 'user@@domain', 'name at example'])('does not match %s', (t) => {
    expect(hits(`x ${t} y`, 'email'), t).toBe(false);
  });

  it('a bare " at " is never read, even with two words that look like a domain', () => {
    expect(hits('mail me at example com', 'email')).toBe(false);
    expect(hits('tarvo at snerp dot com', 'email')).toBe(false);
  });

  it('the local part is at most 64 characters', () => {
    expect(covered(`${'a'.repeat(64)}@b.com`)).toEqual([`${'a'.repeat(64)}@b.com`]);
    expect(covered(`${'a'.repeat(70)}@b.com`)[0]!.length).toBeLessThanOrEqual(64 + 6);
  });
});

describe('contact', () => {
  it.each(['my snap is john_doe99', 'add me on discord name#1234', 'insta @tarvo_x', 'whatsapp me: glarn.snerp', 'kik zorbak_77', 'skype: vlemmo.quissel', 'telegram @drakkuun', 'tiktok fenrisk99', 'signal tarvo_01', 'SNAPCHAT: Zorbak_99'])('matches %s', (t) => {
    expect(hits(`hey ${t} bye`, 'contact'), t).toBe(true);
  });

  it.each(['discord is down', 'I love snap', 'snapchat is cool', 'signal strength', 'my discord server', 'insta 2', 'signal 3.5 bars', 'discord 12345', 'telegram me later', 'skype is great', 'tiktok is fun lol', 'kik me'])('does not match %s', (t) => {
    expect(hits(`hey ${t} bye`, 'contact'), t).toBe(false);
  });

  it('covers the lead word through the handle', () => {
    expect(covered('hey my snap is john_doe99 bye')).toEqual(['snap is john_doe99']);
  });

  it('the handle must come within three words', () => {
    expect(hits('snap one two three john_doe99', 'contact')).toBe(false);
    expect(hits('snap one two john_doe99', 'contact')).toBe(true);
  });
});

describe('address', () => {
  it('221 Baker Street and 10 Downing St match as address only when address is on', () => {
    for (const t of ['221 Baker Street', '10 Downing St', '5 Oak Ave', '1600 Pennsylvania Avenue', '42 Elm Lane.', '7 Long Dr']) {
      expect(hits(`I live at ${t} ok`, 'address', cfg({ address: 'count' })), t).toBe(true);
      expect(hits(`I live at ${t} ok`, 'address', cfg()), t).toBe(false);
      expect(hits(`I live at ${t} ok`, 'address', cfg({ address: null })), t).toBe(false);
    }
  });

  it('is not an address without a number, a word and a street word', () => {
    const on = cfg({ address: 'flag' });
    for (const t of ['Baker Street', '221 Street', '221 123 Street', '2 gold coins', '12345678 Baker Street', 'level 5 boss', 'room 12 east']) expect(hits(`at ${t} ok`, 'address', on), t).toBe(false);
  });

  it("the detector reports only phone, email, card, contact and address, and the action cap is the settings' job", () => {
    const text = 'a@b.com 555-010-9999 and 4111 1111 1111 1111 snap john_doe99 221 Baker Street';
    const kinds = new Set(scanPersonal(text, cfg({ address: 'flag' })).map((m) => m.detail));
    expect([...kinds].sort()).toEqual(['address', 'card', 'contact', 'email', 'phone']);
  });
});

describe('kinds', () => {
  it('only the configured kinds are scanned', () => {
    const text = 'a@b.com 555-010-9999 and 4111 1111 1111 1111 snap john_doe99';
    expect(details(text, cfg({ kinds: ['email'] }))).toEqual(['email']);
    expect(details(text, cfg({ kinds: ['phone'] }))).toEqual(['phone']);
    expect(details(text, cfg({ kinds: ['card'] }))).toEqual(['card']);
    expect(details(text, cfg({ kinds: ['contact'] }))).toEqual(['contact']);
    expect(details(text, cfg({ kinds: ['email', 'card'] })).sort()).toEqual(['card', 'email']);
  });

  it('results come in text order, with spans on the original text', () => {
    const text = 'call 555-010-9999 or a@b.com';
    const r = scanPersonal(text, cfg());
    expect(r.map((m) => m.detail)).toEqual(['phone', 'email']);
    for (const m of r) expect(m.span.start).toBeLessThan(m.span.end);
    expect(r[0]!.span.start).toBeLessThan(r[1]!.span.start);
  });

  it('empty and non-string input give nothing and do not throw', () => {
    expect(scanPersonal('', cfg())).toEqual([]);
    expect(scanPersonal(undefined as never, cfg())).toEqual([]);
    expect(scanPersonal(5 as never, cfg())).toEqual([]);
  });

  it('only the first 2 000 characters are read', () => {
    expect(scanPersonal(`${'x '.repeat(1100)}a@b.com`, cfg())).toEqual([]);
  });
});
