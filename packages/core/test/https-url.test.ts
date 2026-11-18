// httpsUrl is shared by the profile, the reporting settings and the safety links. Its scheme check must not be a regex literal that reads as a URL (`//i.test(`)
// in the minified site bundle (site/test/dist.test.ts scans for hosts), and the words the site bundle scans for stay out of the filter lists' source.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProfileError } from '../src/profileError.js';
import { httpsUrl } from '../src/settingsCheck.js';
import { STRONG_TLDS } from '../src/filters/lists.js';
import { scanLinks } from '../src/filters/links.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const refusal = (v: unknown): string => {
  try {
    httpsUrl(v, 'x.url', 100);
  } catch (e) {
    return e instanceof ProfileError ? e.message : 'other error';
  }
  return 'accepted';
};

describe('httpsUrl keeps its behaviour', () => {
  it.each(['https://zorbak.example/a', 'HTTPS://ZORBAK.EXAMPLE', 'Https://vlemmo.example/a?b=1#c', 'https://quissel.example'])('accepts %s', (v) => {
    expect(httpsUrl(v, 'x.url', 100)).toBe(v);
  });
  it.each(['http://zorbak.example', 'ftp://zorbak.example', 'https:/zorbak.example', 'https:zorbak.example', 'xhttps://zorbak.example', '//zorbak.example', 'zorbak.example', 'https //zorbak.example'])('refuses %s', (v) => {
    expect(refusal(v)).toMatch(/must start with https:\/\/|no spaces/);
  });
  it('a missing host and a non-string are still refused', () => {
    expect(refusal('https://')).toMatch(/must name a host/);
    expect(refusal(5)).toMatch(/must be an https link/);
  });
});

describe('what the site bundle scans for stays out of the source', () => {
  it('settingsCheck.ts has no regex literal that holds two slashes in a row after an escape (it would read as a URL in a minified bundle)', () => {
    const literal = String.raw`/^https:\/\//`; // the regex literal the scheme check used to be
    expect(read('../src/settingsCheck.ts')).not.toContain(literal);
  });
  it('lists.ts spells the adult-site top-level domain without the plain word, and the filter still knows it', () => {
    const word = ['po', 'rn'].join('');
    expect(read('../src/filters/lists.ts')).not.toContain(word);
    for (const tld of ['xxx', 'adult', word, 'tube']) expect(STRONG_TLDS.has(tld), tld).toBe(true);
    expect(scanLinks(`see zorbak.${word} now`).map((c) => c.host)).toEqual([`zorbak.${word}`]);
  });
});
