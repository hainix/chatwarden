import { describe, expect, it } from 'vitest';
import { scanLinks } from '../src/filters/links.js';

// A corpus for the link scanner: lines that must contain a link (with the host of the first one) and lines that must not. The domains are
// synthetic (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn). A comment sits on every row that is there to catch a
// surprising reading. The same lines drive the engine and the dry run in later tests.

export const MUST_MATCH: ReadonlyArray<readonly [line: string, host: string]> = [
  ['visit zorbak-gold.com today', 'zorbak-gold.com'],
  ['https://vlemmo.net/shop', 'vlemmo.net'],
  ['http://quissel.gg', 'quissel.gg'],
  ['www.drakkuun.example', 'www.drakkuun.example'], // www. makes any ending a link
  ['WWW.FENRISK.TEST/x', 'www.fenrisk.test'],
  ['join discord.gg/zorbak', 'discord.gg'],
  ['discord.com/invite/vlemmo', 'discord.com'],
  ['dsc.gg/tarvo', 'dsc.gg'],
  ['t.me/snerp', 't.me'], // a weak ending counts when a path follows
  ['t.me/+abcDEF', 't.me'],
  ['chat.whatsapp.com/glarn', 'chat.whatsapp.com'],
  ['bit.ly/3zorbak', 'bit.ly'],
  ['tinyurl.com/vlemmo', 'tinyurl.com'],
  ['go to goo.gl/xyz', 'goo.gl'],
  ['zorbak.io', 'zorbak.io'],
  ['vlemmo.tv', 'vlemmo.tv'],
  ['quissel.xyz', 'quissel.xyz'],
  ['drakkuun.info', 'drakkuun.info'],
  ['fenrisk.biz', 'fenrisk.biz'],
  ['tarvo.app', 'tarvo.app'],
  ['snerp.dev', 'snerp.dev'],
  ['glarn.co', 'glarn.co'],
  ['zorbak.ly', 'zorbak.ly'],
  ['vlemmo.ru', 'vlemmo.ru'],
  ['quissel.uk', 'quissel.uk'],
  ['drakkuun.de', 'drakkuun.de'],
  ['fenrisk.fr', 'fenrisk.fr'],
  ['tarvo.br', 'tarvo.br'],
  ['snerp.es', 'snerp.es'],
  ['glarn.top', 'glarn.top'],
  ['192.168.0.5', '192.168.0.5'],
  ['10.0.0.1:7777', '10.0.0.1'], // a port does not hide it
  ['http://192.168.0.5/join', '192.168.0.5'],
  ['http://3232235777', '3232235777'], // a decimal integer host
  ['http://0xC0A80001/x', '0xc0a80001'], // a hex integer host
  ['ftp://zorbak.example/file', 'zorbak.example'],
  ['steam://vlemmo/join', 'vlemmo'], // any scheme is a link
  ['evil[.]com', 'evil.com'], // defanged dots
  ['evil(.)com', 'evil.com'],
  ['evil{.}com', 'evil.com'],
  ['hxxp://evil[.]com', 'evil.com'],
  ['hxxps://quissel.com', 'quissel.com'],
  ['evil(dot)com', 'evil.com'],
  ['zorbak[dot]net', 'zorbak.net'],
  ['evil\u{3002}com', 'evil.com'], // ideographic full stop
  ['evil\u{ff0e}com', 'evil.com'], // full-width full stop
  ['evil\u{ff61}com', 'evil.com'], // half-width ideographic full stop
  ['https://google.com@evil.com/x', 'evil.com'], // the host is after the last @
  ['evil.com\\@google.com', 'evil.com'], // a backslash ends the host, as a browser reads it
  ['%65vil.com', 'evil.com'], // a percent-escaped letter
  ['https://%65vil.com', 'evil.com'],
  ['ev\u{200b}il.com', 'evil.com'], // a zero-width space inside the host
  ['EVIL.COM', 'evil.com'],
  ['Evil.Com/Path', 'evil.com'],
  ['evil.com.', 'evil.com'], // the full stop ends the sentence
  ['(see zorbak.com)', 'zorbak.com'],
  ['<https://vlemmo.com>', 'vlemmo.com'],
  ['"quissel.net"', 'quissel.net'],
  ['zorbak.com,vlemmo.com', 'zorbak.com'], // two links with no space
  ['hello,zorbak.com', 'zorbak.com'], // a missing space after a comma
  ['visit:zorbak.com', 'zorbak.com'],
  ['a.zorbak.com', 'a.zorbak.com'],
  ['deep.sub.zorbak.com/p?q=1#f', 'deep.sub.zorbak.com'],
  ['zorbak.com:8080/x', 'zorbak.com'],
  ['http://zorbak.com:80', 'zorbak.com'],
  ['zorbak.com?ref=1', 'zorbak.com'],
  ['zorbak.com#top', 'zorbak.com'],
  ['i love zorbak.com lol', 'zorbak.com'],
  ['dm me on t.me/vlemmo_x ok', 't.me'],
  ['me.my/abc', 'me.my'],
  ['go.to/x', 'go.to'],
  ['xn--vlemmo-abc.com', 'xn--vlemmo-abc.com'], // punycode is compared as written
  ['http://[::1]/x', '::1'], // an ipv6 literal
  ['http://[2001:db8::1]:8080', '2001:db8::1'],
  ['https://ex\u{e4}mple.com', 'ex\u{e4}mple.com'], // an internationalised host is a link
  ['\u{430}\u{440}\u{440}\u{4cf}.com', '\u{430}\u{440}\u{440}\u{4cf}.com'], // a Cyrillic look-alike is a link (and is judged unlisted)
  ['zorbak.com/@user', 'zorbak.com'],
  ['zorbak_site.com', 'zorbak_site.com'], // an underscore is a host character
  ['https://zorbak.com/a/b/c.php?x=1&y=2', 'zorbak.com'],
  ['ZORBAK-GOLD.NET', 'zorbak-gold.net'],
  ['v1.zorbak.com', 'v1.zorbak.com'], // a version-like label is not the ending
  ['  \t zorbak.com  ', 'zorbak.com'],
];

export const MUST_NOT_MATCH: readonly string[] = [
  '1.2.3', // a version
  '3.14', // a number
  'v1.2',
  'v1.2.3',
  'e.g. this one',
  'i.e. that one',
  'readme.md', // a file ending
  'file.zip',
  'notes.py',
  'this.is', // a weak ending without a path
  'check.in',
  'ok.so',
  'good.game',
  'a name@mail.com', // an email is personal info, not a link
  'name.surname@mail.com',
  'I scored 3.14 points',
  'level 2.5 reached',
  'the end.The next',
  'Mr.Smith said hi',
  'hello.world',
  'wait...what',
  'ok...',
  'lol..',
  '...',
  'a . com',
  'evil. com', // a space after the dot is a sentence
  'evil .com',
  'evil , com',
  'dot com',
  'zorbak dot com',
  'foo(dot)bar', // (dot) only before a strong ending
  'script.js',
  'index.html',
  'data.json',
  'notes.txt',
  'archive.tar.gz',
  'photo.jpg',
  'cat.png',
  'song.mp3',
  'run.exe',
  'setup.bat',
  'lib.dll',
  'main.cpp',
  'App.java',
  'a.b.c',
  'x.y',
  '10.5 percent',
  '2024-11-17',
  '12:30:45',
  '100/200/300',
  '1,000.50',
  '$3.99',
  '50.5%',
  '(1.5x)',
  '1.5x multiplier',
  'hi.there',
  'so.what',
  'well.maybe',
  'yes.no',
  'it.is',
  'go.to',
  'me.my',
  'about.me',
  'is.it',
  'in.us',
  'by.am',
  'a@b',
  '@@@@',
  '%%%%',
  '[[[[',
  '))))',
  'http:// ',
  'www.',
  'www. evil',
  'https://',
  ':// ',
  'version 1.0.0.0.0 released', // five numbers are not an address
  '1.2.3.4.5',
  '999.999.999.999', // not an address
  '256.1.1.1',
  '1.2.3.',
  'tel 555.010.9999',
  '40.7128, -74.0060',
  'x=1.5;y=2.5',
  'a.zip b.mov c.sh d.pl e.rs f.md',
  'gold.for.sale',
  'wow.cool',
  'true.love',
  'big.one',
  'right.now',
  'lets.go',
  'we.win',
];

describe('link corpus', () => {
  it('has at least 80 lines of each kind', () => {
    expect(MUST_MATCH.length).toBeGreaterThanOrEqual(80);
    expect(MUST_NOT_MATCH.length).toBeGreaterThanOrEqual(80);
  });

  it.each(MUST_MATCH)('must match: %s', (line, host) => {
    const found = scanLinks(line);
    expect(found.length, line).toBeGreaterThanOrEqual(1);
    expect(found[0]!.host, line).toBe(host);
    expect(found[0]!.start).toBeLessThan(found[0]!.end);
    expect(line.slice(found[0]!.start, found[0]!.end).trim(), line).not.toBe('');
  });

  it.each(MUST_NOT_MATCH.map((l) => [l]))('must not match: %s', (line) => {
    expect(scanLinks(line), line).toEqual([]);
  });
});
