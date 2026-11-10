// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isSafeHref, safeHref } from '../src/safeHref.js';

// The appeal link is adopter config, but it becomes an href on a player's screen. The rule is the one hub-react uses for a link in
// a policy document: `https:` with a host, or a relative address on this site; everything else is refused.

const SAFE = [
  'https://game.test/appeal',
  'https://game.test/appeal?x=1&y=2#top',
  'HTTPS://GAME.TEST/appeal',
  '/help/appeal',
  '/',
  '/a/b?c=d',
  '#appeal',
  '?x=1',
  'appeal',
  './appeal',
  '../appeal',
  'help/appeal.html',
];

const UNSAFE = [
  // schemes
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'data:text/html,<b>x</b>',
  'vbscript:x',
  'ftp://x.test/a',
  'mailto:a@b.test',
  'tel:123',
  'blob:https://x.test/1',
  'file:///etc/passwd',
  // http is refused: https only
  'http://x',
  'http://game.test/appeal',
  'HTTP://game.test/appeal',
  // https without a host
  'https:',
  'https://',
  // protocol-relative, and the ways a browser reads one
  '//evil.test/x',
  '/\t/evil.test',
  '/\n/x',
  '/\r/x',
  '/ /x',
  '/\u0001/x',
  '/\u007f/x',
  '/\u0085/x',
  '/\\evil.test',
  '\\\\evil.test',
  '/a\\b',
  'a\\b',
  // whitespace and control characters anywhere
  'https://a b',
  'https://a.test/ b',
  'https://a.test/\u0000',
  '/a b',
  // entities
  '/&#47;x',
  '/&#x2F;x',
  '/&sol;x',
  'https://a.test/&#106;',
  // empty
  '',
  '   ',
];

describe('safeHref', () => {
  it.each(SAFE)('allows %j and gives it back trimmed', (url) => {
    expect(safeHref(url)).toBe(url);
    expect(safeHref(`  ${url}  `)).toBe(url);
  });

  it.each(UNSAFE)('refuses %j', (url) => {
    expect(safeHref(url)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const v of [undefined, null, 5, {}, [], true]) expect(safeHref(v as unknown as string)).toBeNull();
  });

  it('the table is not trivial (control): it holds both kinds', () => {
    expect(SAFE.length).toBeGreaterThan(8);
    expect(UNSAFE.length).toBeGreaterThan(30);
    expect(new Set([...SAFE, ...UNSAFE]).size).toBe(SAFE.length + UNSAFE.length);
  });
});

describe('isSafeHref', () => {
  it.each(SAFE)('allows %j', (url) => expect(isSafeHref(url)).toBe(true));
  it.each(UNSAFE)('refuses %j', (url) => expect(isSafeHref(url)).toBe(false));
});

// The two packages never import each other, so hub-react's rule is copied. This runs the real function from hub-react's source
// (its two functions are cut out of markdown.tsx and compiled here) beside ours on one table, so a change to either shows up.
describe('parity with hub-react isSafeHref', () => {
  const source = readFileSync(join(fileURLToPath(new URL('../../hub-react/src', import.meta.url)), 'markdown.tsx'), 'utf8');
  const start = source.indexOf('function hasControlOrSpace');
  const end = source.indexOf('/** The index of the first unescaped');
  const hub = new Function(`${ts.transpileModule(source.slice(start, end).replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn isSafeHref;`)() as (h: string) => boolean;

  it('found the real function', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(hub('https://x.test/')).toBe(true);
    expect(hub('javascript:alert(1)')).toBe(false);
  });

  it.each([...SAFE, ...UNSAFE, '/%09/x', 'https://x.test:8443/p', 'https://user@x.test/', 'https://[::1]/', '/ok#frag', ':x', 'a:b'])(
    'gives the same answer as hub-react for %j',
    (url) => {
      expect(isSafeHref(url)).toBe(hub(url));
    },
  );

  it('random strings: the same answer on 2,000 of them', () => {
    const alphabet = ['/', '\\', ':', 'a', 'h', 't', 'p', 's', ' ', '\t', '\n', '&', '#', ';', '.', 'x', '%', '1', '\u0001', '\u0085', '?'];
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 2000; i += 1) {
      const len = 1 + (next() % 12);
      let s = '';
      for (let j = 0; j < len; j += 1) s += alphabet[next() % alphabet.length];
      if (i % 3 === 0) s = `https://${s}`;
      expect(isSafeHref(s), JSON.stringify(s)).toBe(hub(s));
    }
  });
});
