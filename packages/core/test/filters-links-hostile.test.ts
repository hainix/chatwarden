import { describe, expect, it } from 'vitest';
import { __scanSteps, scanLinks } from '../src/filters/links.js';

// Hostile text: pathological dots, @, %, brackets and labels. Nothing throws, at most 20 candidates come back, and doubling the input at most
// 2.5 times the work, per family. (The scanner reads at most 2 000 characters, so the doubling is measured below that.)

const FAMILIES: Record<string, (n: number) => string> = {
  dots: (n) => '.'.repeat(n),
  'a.a.a.': (n) => 'a.'.repeat(Math.ceil(n / 2)),
  '@@@@': (n) => '@'.repeat(n),
  '%%%%': (n) => '%'.repeat(n),
  '[[[[': (n) => '['.repeat(n),
  ')))))': (n) => ')'.repeat(n),
  'labels then com': (n) => `${'a.'.repeat(Math.ceil(n / 2))}com`,
  'nested [[.]]': (n) => `${'[['.repeat(Math.ceil(n / 4))}.${']]'.repeat(Math.ceil(n / 4))}`,
  '(dot) runs': (n) => '(dot)'.repeat(Math.ceil(n / 5)),
  'a(dot) then com': (n) => `${'a(dot)'.repeat(Math.ceil(n / 6))}com`,
  'http:// runs': (n) => 'http://'.repeat(Math.ceil(n / 7)),
  ':// runs': (n) => '://'.repeat(Math.ceil(n / 3)),
  'a@ then host': (n) => `${'a@'.repeat(Math.ceil(n / 2))}b.com`,
  'escapes': (n) => `${'%65'.repeat(Math.ceil(n / 3))}.com`,
  'www runs': (n) => 'www.'.repeat(Math.ceil(n / 4)),
  'numbers': (n) => '1.'.repeat(Math.ceil(n / 2)),
  'hidden characters': (n) => '\u{200b}'.repeat(n),
  'hidden between dots': (n) => 'a\u{200b}.'.repeat(Math.ceil(n / 3)),
  'bidi in a host': (n) => `evil${'\u{202e}'.repeat(n)}.com`,
  'one long label': (n) => `${'a'.repeat(n)}.com`,
  'one long path': (n) => `zorbak.com/${'x'.repeat(n)}`,
  'many links': (n) => 'zorbak.com '.repeat(Math.ceil(n / 11)),
  'brackets and ports': (n) => '[::1]:80'.repeat(Math.ceil(n / 8)),
  'colons': (n) => ':'.repeat(n),
  'slashes and backslashes': (n) => '/\\'.repeat(Math.ceil(n / 2)),
  'at then dots': (n) => '@.'.repeat(Math.ceil(n / 2)),
  'mixed': (n) => 'a.b(dot)%2e[.]@:'.repeat(Math.ceil(n / 16)),
};

describe('hostile text', () => {
  for (const [name, make] of Object.entries(FAMILIES)) {
    it(`${name}: 100 000 characters do not throw and give at most 20 candidates`, () => {
      const found = scanLinks(make(100_000));
      expect(found.length).toBeLessThanOrEqual(20);
      for (const c of found) {
        expect(c.start).toBeGreaterThanOrEqual(0);
        expect(c.end).toBeGreaterThan(c.start);
      }
    });

    it(`${name}: steps for 2n are at most 2.5 times the steps for n`, () => {
      __scanSteps.n = 0;
      scanLinks(make(400));
      const small = __scanSteps.n;
      __scanSteps.n = 0;
      scanLinks(make(800));
      const big = __scanSteps.n;
      expect(small).toBeGreaterThan(0);
      expect(big).toBeLessThanOrEqual(small * 2.5);
    });
  }

  it('the work is bounded by the 2 000 character cap whatever the length', () => {
    __scanSteps.n = 0;
    scanLinks('a.'.repeat(1000));
    const capped = __scanSteps.n;
    __scanSteps.n = 0;
    scanLinks('a.'.repeat(500_000));
    expect(__scanSteps.n).toBeLessThanOrEqual(capped * 1.1);
  });

  it('lone surrogates, NUL and control characters do not throw', () => {
    for (const t of ['\ud800zorbak.com', 'zorbak\udc00.com', '\u0000'.repeat(50), 'zorbak.com\u0000x', '\u{1f600}'.repeat(100), 'https://\ud800.com']) {
      expect(() => scanLinks(t)).not.toThrow();
    }
  });
});
