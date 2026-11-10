import { describe, expect, it } from 'vitest';
import { CONTENT_MAX } from '../src/forum.js';
import { esc, fitMessage, humanDuration, oneLine, safeText } from '../src/text.js';
import { INJECTIONS } from './support.js';

const ZW = '\u200B';

describe('safeText: the injection matrix', () => {
  it.each(INJECTIONS)('%s', (_name, input, expected) => {
    const out = safeText(input, 200);
    // The exact result is pinned...
    expect(out).toBe(expected);
    // ...and the properties that matter are asserted on their own, so a changed expectation cannot hide a hole.
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).not.toMatch(/@(?!\u200B)/); // every at sign is followed by a zero-width space
    expect(out).not.toMatch(/(?<!\\)[<>]/); // no unescaped angle bracket: no mention, channel, emoji or timestamp form
    expect(out).not.toMatch(/(?<!\\)[`*_~|#[\]():]/); // no unescaped markdown or link syntax
    expect(out).not.toContain('](');
    expect(out).not.toContain('```');
    expect(out).not.toContain('@everyone');
    expect(out).not.toContain('@here');
    expect(out).not.toMatch(/[\p{Cc}]/u);
    // An even run of trailing backslashes: nothing after this text can be escaped by it.
    expect(/\\*$/.exec(out)?.[0].length ?? 0).toSatisfy((n: number) => n % 2 === 0);
  });

  it('cuts before it escapes, so a cut never splits an escape pair', () => {
    const out = safeText('*'.repeat(50), 10);
    expect(out).toBe('\\*'.repeat(10));
  });

  it('cuts by characters, not through a surrogate pair', () => {
    const out = safeText(`${'a'.repeat(9)}\u{1F600}`, 10);
    expect(out).toBe('a'.repeat(9));
  });

  it('turns a non-string into its text, never throws', () => {
    expect(safeText(undefined, 10)).toBe('undefined');
    expect(safeText(12345, 10)).toBe('12345');
    expect(safeText({ toString: () => '@everyone' }, 20)).toBe(`@${ZW}everyone`);
  });
});

describe('esc', () => {
  it('escapes a backslash so it cannot cancel the escape that follows it', () => {
    expect(esc('\\@everyone')).toBe(`\\\\@${ZW}everyone`);
    expect(esc('\\*x')).toBe('\\\\\\*x');
  });

  it('leaves plain text, digits, hyphens and spaces alone', () => {
    expect(esc('Community Rule 2 - No spam, please.')).toBe('Community Rule 2 - No spam, please.');
  });
});

describe('oneLine', () => {
  it('collapses whitespace before it drops control characters', () => {
    expect(oneLine('  a\u0007  \t b \n')).toBe('a b');
  });
});

describe('humanDuration', () => {
  it.each([
    [0, 'under a minute'],
    [-5, 'under a minute'],
    [Number.NaN, 'under a minute'],
    [60_000, '1 minute'],
    [3_600_000, '1 hour'],
    [48 * 3_600_000, '2 days'],
  ])('%d ms reads %s', (ms, label) => {
    expect(humanDuration(ms)).toBe(label);
  });
});

describe('fitMessage: the facts are cut, the head and the links never are', () => {
  const HEAD = '<@&987654321098765432> **Severe report**';
  const LINKS = '[Open report](<https://hub.example.test/report/abc>) · [Open person](<https://hub.example.test/person/s_abc>)';

  it('joins head, facts and links when they fit, and skips an empty links line', () => {
    expect(fitMessage('H', ['a', 'b'], 'L')).toBe('H\na\nb\nL');
    expect(fitMessage('H', ['a'], '')).toBe('H\na');
    expect(fitMessage('H', [], 'L')).toBe('H\nL');
    expect(fitMessage('H', [], '')).toBe('H');
  });

  it('reaches the truncation branch with a long facts body: at most 2000 characters, head first, links last and whole', () => {
    const facts = ['Category: Hate speech', ...Array.from({ length: 200 }, (_, i) => `Fact line number ${i} with some padding text to make it long`)];
    const out = fitMessage(HEAD, facts, LINKS);
    expect(out.length).toBeLessThanOrEqual(CONTENT_MAX);
    expect(out.startsWith(`${HEAD}\nCategory: Hate speech`)).toBe(true);
    expect(out.endsWith(`…\n${LINKS}`)).toBe(true);
    expect(out).toContain('<@&987654321098765432>');
    // The links survive balanced.
    expect((out.match(/\[/g) ?? []).length).toBe((out.match(/\]/g) ?? []).length);
    expect((out.match(/</g) ?? []).length - 1).toBe((out.match(/>/g) ?? []).length - 1);
  });

  it('fills the message right up to the limit rather than cutting early', () => {
    const out = fitMessage(HEAD, ['x'.repeat(5000)], LINKS);
    expect(out.length).toBe(CONTENT_MAX);
  });

  it('never leaves an odd run of backslashes before the ellipsis, whichever way the cut falls', () => {
    for (let pad = 0; pad < 4; pad++) {
      const out = fitMessage(HEAD + 'h'.repeat(pad), ['\\*'.repeat(2000)], LINKS);
      expect(out.length).toBeLessThanOrEqual(CONTENT_MAX);
      const before = out.slice(0, out.indexOf('…'));
      expect(/\\*$/.exec(before)?.[0].length ?? 0).toSatisfy((n: number) => n % 2 === 0);
    }
  });

  it('does not cut through a surrogate pair', () => {
    for (let pad = 0; pad < 3; pad++) {
      const out = fitMessage(HEAD + 'h'.repeat(pad), ['\u{1F600}'.repeat(2000)], LINKS);
      expect(out.length).toBeLessThanOrEqual(CONTENT_MAX);
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it('keeps the head and the links whole when there is no room for any fact', () => {
    const links = `[Open](<https://hub.example.test/${'p'.repeat(1919)}>)`;
    const out = fitMessage(HEAD, ['some fact'], links);
    expect(out.length).toBeLessThanOrEqual(CONTENT_MAX);
    expect(out.startsWith(HEAD)).toBe(true);
    expect(out.endsWith(links)).toBe(true);
    expect(out).not.toContain('some fact');
  });

  it('drops the links line, and not the head or the facts that fit, if head and links together could never fit', () => {
    const out = fitMessage(HEAD, ['fact'], 'L'.repeat(3000));
    expect(out).toBe(`${HEAD}
fact`);
  });
});
