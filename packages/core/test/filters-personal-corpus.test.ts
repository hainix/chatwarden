import { describe, expect, it } from 'vitest';
import { resolveFilters } from '../src/filters.js';
import { scanPersonal } from '../src/filters/personal.js';

// Lines with ordinary numbers and words that must NOT be read as personal details (scores, levels, coordinates, version numbers, prices,
// dates, ids, times), and lines that must be. Synthetic names only. The default settings: all four kinds, phone formatted, address off.

const cfg = resolveFilters({ personalInfo: { action: 'mask' } }).personalInfo!;

export const MUST_NOT: readonly string[] = [
  'final score 15 - 12 in overtime', // scores
  'we won 3-1',
  'score was 10 20 30 40 50',
  'level 85 mage needs 1500 2000 3000 xp', // levels and experience
  'lvl 60 to 70 takes 12 34 56 minutes',
  'need 100 200 300 400 gold for the set', // round amounts
  'it costs 1,234,567 gold', // prices
  'price is $19.99 or 29.99 or 39.99',
  'deal: 4 for 3 on all 10 packs',
  'coordinates 40.7128 -74.0060 are the spawn', // coordinates
  'go to x=120 y=340 z=560',
  'patch 1.2.3.4 is out', // version numbers
  'v10.20.30 released',
  'build 2024.11.17.1 passed',
  'on 2024-11-17 at 12:30:45', // dates and times
  'event runs 11/17/2024 to 11/24/2024',
  'queue time 1:23:45',
  'order id 5550109 shipped', // ids that are short
  'room 1234 5678', // two groups
  'match 4455667 ended',
  'rank 1 of 1000',
  'I have 5 gold 10 silver 15 copper',
  '3 2 1 go',
  'discord is down', // contact lead words with nothing after
  'I use snap to take photos',
  'the signal is weak',
  'telegram me when ready', // 'me when ready' has no handle
  'insta kill the boss',
  'tiktok is a clock',
  'skype is old',
  'add me when you can',
  'my email is broken', // the word email is nothing
  'meet me at the north gate',
  'what time at noon dot',
  'at 5 pm',
  'a@b',
  'user @ home',
  'save 20 percent at checkout',
  'raid at 8 pm tonight bring snacks',
  'I live in 2 places',
  'the 3 amigos 5 street fighters', // street word needs a number, a word, a street word
  'Baker Street is famous',
  'my street is long',
  'press 1 2 3 4 5 6 7 8 9 for the menu',
  'run 5 6 7 8 9 10 11 12', // lists of small numbers
  'phone',
  'call me',
  'text me 555', // too short
  'order 12 and 34',
  'a 5.5 b 6.6',
  'bag of 25 items at 4 each',
  '9999999999 is not formatted', // a bare run is not a formatted phone
  '4111 1111 1111 1112 failed luhn',
];

export const MUST: ReadonlyArray<readonly [line: string, detail: string]> = [
  ['call me on +44 20 7946 0958', 'phone'],
  ['text (555) 010-9999 now', 'phone'],
  ['it is 555-010-9999', 'phone'],
  ['it is 555.010.9999', 'phone'],
  ['+1 555 010 9999 is my number', 'phone'],
  ['mine is 555 010 9999', 'phone'],
  ['pay with 4111 1111 1111 1111', 'card'],
  ['pay with 4111-1111-1111-1111', 'card'],
  ['5500000000000004 is mine', 'card'],
  ['mail tarvo@snerp.com', 'email'],
  ['mail tarvo.glarn+game@mail.vlemmo.net', 'email'],
  ['mail tarvo [at] snerp [dot] com', 'email'],
  ['mail tarvo(at)snerp(dot)com', 'email'],
  ['my snap is john_doe99', 'contact'],
  ['add me on discord name#1234', 'contact'],
  ['insta @tarvo_x', 'contact'],
  ['whatsapp zorbak_77 ok', 'contact'],
  ['tiktok fenrisk99', 'contact'],
];

describe('personal info corpus', () => {
  it('has plenty of each kind', () => {
    expect(MUST_NOT.length).toBeGreaterThanOrEqual(50);
    expect(MUST.length).toBeGreaterThanOrEqual(15);
  });

  it.each(MUST_NOT.map((l) => [l]))('must not match: %s', (line) => {
    expect(scanPersonal(line, cfg).map((m) => m.detail), line).toEqual([]);
  });

  it.each(MUST)('must match: %s', (line, detail) => {
    expect(scanPersonal(line, cfg).map((m) => m.detail), line).toContain(detail);
  });
});
