import { describe, expect, it } from 'vitest';
import { resolveFilters, type ResolvedLinks } from '../src/filters.js';
import { judgeLink, parseHost, scanLinks, type LinkCandidate } from '../src/filters/links.js';
import { stripHidden } from '../src/filters/chars.js';

const hosts = (text: string): Array<string | null> => scanLinks(text).map((c) => c.host);
const sliced = (text: string): string[] => scanLinks(text).map((c) => text.slice(c.start, c.end));
const cfg = (extra: Record<string, unknown> = {}): ResolvedLinks => resolveFilters({ links: { action: 'flag', ...extra } } as never).links!;
const one = (text: string): LinkCandidate => {
  const found = scanLinks(text);
  expect(found, text).toHaveLength(1);
  return found[0]!;
};
const verdict = (text: string, c: ResolvedLinks = cfg(), isNew: boolean | (() => boolean) = false) => judgeLink(one(text), c, isNew);

describe('candidates', () => {
  it('a scheme', () => {
    expect(one('visit https://zorbak.example/a now')).toMatchObject({ host: 'zorbak.example', scheme: 'https', path: '/a', shape: 'host' });
    expect(sliced('visit https://zorbak.example/a now')).toEqual(['https://zorbak.example/a']);
    expect(one('ftp://vlemmo.test')).toMatchObject({ host: 'vlemmo.test', scheme: 'ftp', path: '' });
    expect(one('steam://vlemmo/join')).toMatchObject({ host: 'vlemmo', scheme: 'steam' });
  });

  it('www. with any ending', () => {
    expect(one('go to www.quissel.test')).toMatchObject({ host: 'www.quissel.test', scheme: null });
    expect(hosts('WWW.QUISSEL.TEST/x')).toEqual(['www.quissel.test']);
  });

  it('a strong TLD bare', () => {
    expect(hosts('drakkuun.com')).toEqual(['drakkuun.com']);
    expect(hosts('see drakkuun.gg and fenrisk.io')).toEqual(['drakkuun.gg', 'fenrisk.io']);
    expect(hosts('a.b.c.tarvo.net')).toEqual(['a.b.c.tarvo.net']);
  });

  it('a weak TLD only with a path', () => {
    expect(hosts('t.me/snerp')).toEqual(['t.me']);
    expect(hosts('me.my/abc')).toEqual(['me.my']);
    expect(hosts('x.to/y')).toEqual(['x.to']);
    for (const t of ['t.me', 'this.is', 'check.in', 'ok.so', 'go.to', 'about.me', 't.me/', 't.me. ok', 'x.to ']) expect(scanLinks(t), t).toEqual([]);
  });

  it('IPv4 with and without a port', () => {
    expect(one('192.168.0.5')).toMatchObject({ host: '192.168.0.5', shape: 'ip' });
    expect(one('join 10.0.0.1:7777 now')).toMatchObject({ host: '10.0.0.1', shape: 'ip' });
    expect(sliced('join 10.0.0.1:7777 now')).toEqual(['10.0.0.1:7777']);
    expect(one('http://192.168.0.5/x')).toMatchObject({ host: '192.168.0.5', shape: 'ip', scheme: 'http' });
  });

  it('a decimal, hex or octal IP host with a scheme', () => {
    expect(one('http://3232235777')).toMatchObject({ shape: 'ip', host: '3232235777' });
    expect(one('http://0xC0A80001/x')).toMatchObject({ shape: 'ip', host: '0xc0a80001' });
    expect(one('http://0300.0250.0.1')).toMatchObject({ shape: 'ip' });
  });

  it('not links', () => {
    for (const t of [
      '1.2.3', '3.14', 'v1.2', 'v1.2.3', 'e.g.', 'i.e.', 'readme.md', 'file.zip', 'notes.py', 'this.is', 'check.in', 'ok.so',
      'good game.see you', 'name@mail.com', 'name.surname@mail.com', 'I scored 3.14 points', 'the end.The next', '1.2.3.4.5', '999.1.1.1', '256.1.1.1',
    ]) {
      expect(scanLinks(t), t).toEqual([]);
    }
  });

  it('a sentence with a missing space after a full stop is not a link', () => {
    expect(scanLinks('I agree.So what now. It is fine.Really')).toEqual([]);
  });

  it('at most 20 candidates, the rest ignored', () => {
    expect(scanLinks('zorbak.com '.repeat(50))).toHaveLength(20);
  });

  it('candidates come in text order, and the same link twice is two candidates', () => {
    expect(hosts('vlemmo.com then quissel.net then vlemmo.com')).toEqual(['vlemmo.com', 'quissel.net', 'vlemmo.com']);
  });

  it('an email address is never a link, but a link inside a sentence beside one is', () => {
    expect(scanLinks('mail me at tarvo@snerp.com please')).toEqual([]);
    expect(hosts('mail tarvo@snerp.com or visit glarn.com')).toEqual(['glarn.com']);
  });

  it('a candidate ends before the punctuation that closes a sentence', () => {
    expect(sliced('see zorbak.com.')).toEqual(['zorbak.com']);
    expect(sliced('see (zorbak.com)')).toEqual(['zorbak.com']);
    expect(sliced('see "zorbak.com/x?y=1".')).toEqual(['zorbak.com/x?y=1']);
    expect(sliced('is it zorbak.com/x?')).toEqual(['zorbak.com/x']);
    expect(sliced('<https://zorbak.com>')).toEqual(['https://zorbak.com']);
  });
});

describe('defang and dots', () => {
  it.each([
    ['evil[.]com', 'evil.com'],
    ['evil(.)com', 'evil.com'],
    ['evil{.}com', 'evil.com'],
    ['evil\u{3002}com', 'evil.com'],
    ['evil\u{ff0e}com', 'evil.com'],
    ['evil\u{ff61}com', 'evil.com'],
    ['hxxp://evil[.]com', 'evil.com'],
    ['hxxps://evil.com', 'evil.com'],
    ['evil(dot)com', 'evil.com'],
    ['evil[dot]com', 'evil.com'],
    ['a[.]b(.)evil{.}com', 'a.b.evil.com'],
  ])('%s reads as %s', (text, host) => {
    expect(hosts(text)).toEqual([host]);
  });

  it('hxxp and hxxps read as http and https', () => {
    expect(one('hxxp://evil.com').scheme).toBe('http');
    expect(one('hxxps://evil.com').scheme).toBe('https');
    expect(one('HXXPS://evil.com').scheme).toBe('https');
  });

  it('(dot) and [dot] only before a strong TLD', () => {
    for (const t of ['foo(dot)bar', 'foo[dot]bar', 'evil(dot)zip', 'this(dot)is', 'a (dot) b', 'dot com', 'zorbak dot com']) expect(scanLinks(t), t).toEqual([]);
  });

  it('a space after a dot is not read', () => {
    for (const t of ['evil. com', 'evil .com', 'evil . com', 'evil[.] com', 'evil, com']) expect(scanLinks(t), t).toEqual([]);
  });

  it('a masked defanged link covers the defang characters', () => {
    expect(sliced('x evil[.]com y')).toEqual(['evil[.]com']);
    expect(sliced('x hxxps://evil[.]com/a y')).toEqual(['hxxps://evil[.]com/a']);
  });
});

describe('host rules', () => {
  it('the last @ wins', () => {
    expect(parseHost('google.com@evil.com')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('a@b@evil.com')).toMatchObject({ host: 'evil.com', ok: true });
    expect(hosts('https://google.com@evil.com/x')).toEqual(['evil.com']);
    expect(hosts('google.com@evil.com')).toEqual(['evil.com']);
    expect(hosts('evil.com\\@google.com')).toEqual(['evil.com']);
  });

  it('a port is dropped', () => {
    expect(parseHost('evil.com:8080')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('user:pw@evil.com:80')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('evil.com:')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('evil.com:80x').ok).toBe(false);
  });

  it('brackets give ipv6, which is never allowable', () => {
    expect(parseHost('[::1]')).toMatchObject({ shape: 'ipv6', ok: true });
    expect(parseHost('[2001:db8::1]:443')).toMatchObject({ shape: 'ipv6', ok: true });
    expect(one('http://[::1]/x').shape).toBe('ipv6');
    expect(one('http://[2001:db8::1]:8080').shape).toBe('ipv6');
    expect(parseHost('[::1').ok).toBe(false);
    expect(parseHost('[zz]').ok).toBe(false);
  });

  it('%65vil.com decodes; %2F or a non-LDH decode is invalid and still a link', () => {
    expect(parseHost('%65vil.com')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('evil%2ecom')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('%2Fevil.com').ok).toBe(false);
    expect(parseHost('evil%40.com').ok).toBe(false);
    expect(parseHost('%zz.com').ok).toBe(false);
    expect(parseHost('evil%.com').ok).toBe(false);
    expect(hosts('%65vil.com')).toEqual(['evil.com']);
    expect(hosts('https://%65vil.com')).toEqual(['evil.com']);
    const bad = one('http://%2Fevil.com');
    expect(bad).toMatchObject({ shape: 'invalid', host: null });
  });

  it('uppercase, full-width and trailing dots fold', () => {
    expect(parseHost('EVIL.COM.')).toMatchObject({ host: 'evil.com', ok: true });
    expect(parseHost('\u{ff25}\u{ff36}\u{ff29}\u{ff2c}.\u{ff43}\u{ff4f}\u{ff4d}')).toMatchObject({ host: 'evil.com', ok: true });
    expect(hosts('EVIL.COM')).toEqual(['evil.com']);
  });

  it('a 64 character label and a 254 character host are invalid', () => {
    expect(parseHost(`${'a'.repeat(63)}.com`).ok).toBe(true);
    expect(parseHost(`${'a'.repeat(64)}.com`).ok).toBe(false);
    expect(parseHost(`${'a'.repeat(62)}.`.repeat(4) + 'co').ok).toBe(false);
    expect(parseHost(`${'a.'.repeat(125)}com`).ok).toBe(true);
    expect(parseHost(`${'a.'.repeat(126)}com`).ok).toBe(false);
    expect(one(`https://${'a'.repeat(64)}.com`)).toMatchObject({ shape: 'invalid', host: null });
  });

  it('an empty label, an empty host and a stray character are invalid', () => {
    for (const a of ['', 'a..b.com', '.com', 'ev il.com', 'evil!.com']) expect(parseHost(a).ok, a).toBe(false);
  });

  it('numbers: decimal, hex, octal and dotted are ip', () => {
    expect(parseHost('3232235777')).toMatchObject({ shape: 'ip', ok: true });
    expect(parseHost('0xc0a80001')).toMatchObject({ shape: 'ip', ok: true });
    expect(parseHost('192.168.0.5')).toMatchObject({ shape: 'ip', host: '192.168.0.5' });
    expect(parseHost('evil.com').shape).toBe('host');
  });
});

describe('hidden characters', () => {
  it('zero-width, bidi and control characters inside a host are stripped; start and end index the original text', () => {
    for (const hidden of ['\u{200b}', '\u{200d}', '\u{202e}', '\u{2060}', '\u{feff}', '\u0001', '\u{ad}']) {
      const text = `see ev${hidden}il.com now`;
      const c = one(text);
      expect(c.host, JSON.stringify(hidden)).toBe('evil.com');
      expect(text.slice(c.start, c.end)).toBe(`ev${hidden}il.com`);
    }
  });

  it('hidden characters in the scheme and the dot', () => {
    const text = 'x ht\u{200b}tps://evil\u{200b}.com/a y';
    const c = one(text);
    expect(c.host).toBe('evil.com');
    expect(text.slice(c.start, c.end)).toBe('ht\u{200b}tps://evil\u{200b}.com/a');
  });

  it('stripHidden keeps a map to the original', () => {
    const r = stripHidden('a\u{200b}b\u{202e}c');
    expect(r.text).toBe('abc');
    expect(r.map).toEqual([0, 2, 4]);
    expect(stripHidden('plain')).toEqual({ text: 'plain', map: [0, 1, 2, 3, 4] });
    expect(stripHidden('')).toEqual({ text: '', map: [] });
  });

  it('whitespace is not hidden: a tab or a newline still ends a link', () => {
    expect(hosts('evil.com\tzorbak.net\nvlemmo.org')).toEqual(['evil.com', 'zorbak.net', 'vlemmo.org']);
  });
});

describe('judge', () => {
  it('deny beats allow, through a parent domain', () => {
    const c = cfg({ deny: ['evil.com'], allow: ['sub.evil.com'] });
    expect(verdict('sub.evil.com', c)).toBe('deny');
    expect(verdict('evil.com', c)).toBe('deny');
    expect(verdict('x.sub.evil.com', c)).toBe('deny');
  });

  it('allow matches the host and its subdomains; = is exact', () => {
    const c = cfg({ allow: ['example.com', '=exact.test'] });
    expect(verdict('example.com', c)).toBeNull();
    expect(verdict('cdn.example.com', c)).toBeNull();
    expect(verdict('a.b.example.com', c)).toBeNull();
    expect(verdict('notexample.com', c)).toBe('unlisted');
    expect(verdict('example.com.evil.net', c)).toBe('unlisted');
    expect(verdict('https://exact.test', c)).toBeNull();
    expect(verdict('https://cdn.exact.test', c)).toBe('unlisted');
  });

  it('deny with = is exact too', () => {
    const c = cfg({ deny: ['=evil.com'], unlisted: 'allow' });
    expect(verdict('evil.com', c)).toBe('deny');
    expect(verdict('sub.evil.com', c)).toBeNull();
  });

  it('invites and shorteners hit unless allowed', () => {
    expect(verdict('discord.gg/zorbak')).toBe('invite');
    expect(verdict('dsc.gg/x')).toBe('invite');
    expect(verdict('chat.whatsapp.com/x')).toBe('invite');
    expect(verdict('https://signal.group/x')).toBe('invite');
    expect(verdict('bit.ly/x')).toBe('shortener');
    expect(verdict('www.bit.ly/x')).toBe('shortener');
    expect(verdict('t.co/x')).toBe('shortener');
    expect(verdict('discord.gg/x', cfg({ allow: ['discord.gg'] }))).toBeNull();
    expect(verdict('bit.ly/x', cfg({ allow: ['bit.ly'] }))).toBeNull();
    expect(verdict('discord.gg/x', cfg({ invites: false }))).toBe('unlisted');
    expect(verdict('bit.ly/x', cfg({ shorteners: false }))).toBe('unlisted');
    expect(verdict('discord.gg/x', cfg({ invites: false, unlisted: 'allow' }))).toBeNull();
  });

  it('an invite on a path hits while the bare host does not', () => {
    expect(verdict('discord.com/invite/x')).toBe('invite');
    expect(verdict('https://discord.com/invite')).toBe('invite');
    expect(verdict('discordapp.com/invite/x')).toBe('invite');
    expect(verdict('discord.com')).toBe('unlisted');
    expect(verdict('discord.com/channels/1')).toBe('unlisted');
    expect(verdict('discord.com/invitee')).toBe('unlisted');
    expect(verdict('discord.com', cfg({ unlisted: 'allow' }))).toBeNull();
    expect(verdict('t.me/+abc')).toBe('invite');
    expect(verdict('t.me/joinchat/abc')).toBe('invite');
    expect(verdict('t.me/zorbak')).toBe('unlisted');
  });

  it('unlisted acts or passes by the setting', () => {
    expect(verdict('zorbak.com')).toBe('unlisted');
    expect(verdict('zorbak.com', cfg({ unlisted: 'act' }))).toBe('unlisted');
    expect(verdict('zorbak.com', cfg({ unlisted: 'allow' }))).toBeNull();
  });

  it('new_account acts despite unlisted allow, never over the allow list', () => {
    const c = cfg({ unlisted: 'allow', newAccountDays: 3, allow: ['example.com'] });
    expect(verdict('zorbak.com', c, true)).toBe('new_account');
    expect(verdict('zorbak.com', c, false)).toBeNull();
    expect(verdict('example.com', c, true)).toBeNull();
    expect(verdict('discord.gg/x', c, true)).toBe('invite');
    expect(verdict('zorbak.com', cfg({ unlisted: 'act', newAccountDays: 3 }), true)).toBe('unlisted');
    expect(verdict('zorbak.com', cfg({ unlisted: 'allow' }), true)).toBeNull();
  });

  it('the account-age answer is asked for only when it can matter, and once per call', () => {
    const calls: string[] = [];
    const ask = (): boolean => {
      calls.push('x');
      return true;
    };
    const c = cfg({ unlisted: 'allow', newAccountDays: 3, allow: ['example.com'], deny: ['evil.com'] });
    for (const t of ['example.com', 'evil.com', 'discord.gg/x', 'bit.ly/x']) verdict(t, c, ask);
    verdict('zorbak.com', cfg({ unlisted: 'allow' }), ask);
    verdict('zorbak.com', cfg({ unlisted: 'act', newAccountDays: 3 }), ask);
    expect(calls).toEqual([]);
    expect(verdict('zorbak.com', c, ask)).toBe('new_account');
    expect(calls).toEqual(['x']);
  });

  it('an IDN host is unlisted even when unlisted is allow, and passes only if listed', () => {
    const c = cfg({ unlisted: 'allow' });
    expect(verdict('https://\u{430}\u{440}\u{440}\u{4cf}.com', c)).toBe('unlisted');
    expect(verdict('https://b\u{fc}cher.example', c)).toBe('unlisted');
    expect(verdict('https://\u{430}\u{440}\u{440}\u{4cf}.com', cfg({ unlisted: 'allow', allow: ['\u{430}\u{440}\u{440}\u{4cf}.com'] }))).toBeNull();
    expect(verdict('https://b\u{fc}cher.example', cfg({ unlisted: 'allow', deny: ['b\u{fc}cher.example'] }))).toBe('deny');
  });

  it('an IP, an ipv6 and an invalid host are unlisted even when unlisted is allow; only the exact IP can be allowed', () => {
    const c = cfg({ unlisted: 'allow' });
    expect(verdict('192.168.0.5', c)).toBe('unlisted');
    expect(verdict('http://3232235777', c)).toBe('unlisted');
    expect(verdict('http://[::1]/', c)).toBe('unlisted');
    expect(verdict('http://%2Fevil.com', c)).toBe('unlisted');
    expect(verdict('192.168.0.5', cfg({ unlisted: 'allow', allow: ['192.168.0.5'] }))).toBeNull();
    expect(verdict('192.168.0.6', cfg({ unlisted: 'allow', allow: ['192.168.0.5'] }))).toBe('unlisted');
    expect(verdict('http://[::1]/', cfg({ unlisted: 'allow', allow: ['localhost.test'] }))).toBe('unlisted');
    expect(verdict('192.168.0.5', cfg({ deny: ['192.168.0.5'] }))).toBe('deny');
  });

  it('a look-alike of an allowed brand does not pass', () => {
    const c = cfg({ unlisted: 'allow', allow: ['example.com'] });
    expect(verdict('https://exampl\u{435}.com', c)).toBe('unlisted');
    expect(verdict('example.com@evil.com', c)).toBeNull();
    expect(verdict('https://example.com@evil.com', cfg({ unlisted: 'act', allow: ['example.com'] }))).toBe('unlisted');
  });

  it('judging never throws, whatever the candidate', () => {
    const odd: LinkCandidate[] = [
      { start: 0, end: 0, host: null, shape: 'invalid', path: '', scheme: null },
      { start: 0, end: 1, host: '', shape: 'host', path: '', scheme: null },
      { start: 0, end: 1, host: 'a'.repeat(5000), shape: 'host', path: 'x'.repeat(5000), scheme: 'x' },
    ];
    for (const c of odd) expect(() => judgeLink(c, cfg(), false)).not.toThrow();
  });
});

describe('purity', () => {
  it('the same input always gives the same candidates (no state, no clock)', () => {
    const text = 'x zorbak.com y https://vlemmo.net/a z 10.0.0.1 evil[.]com t.me/x';
    const first = JSON.stringify(scanLinks(text));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(scanLinks(text))).toBe(first);
    expect(scanLinks(text).length).toBe(5);
  });

  it('a non-string and an empty string give no candidates and do not throw', () => {
    expect(scanLinks('')).toEqual([]);
    expect(scanLinks(undefined as never)).toEqual([]);
    expect(scanLinks(5 as never)).toEqual([]);
    expect(scanLinks(null as never)).toEqual([]);
  });

  it('a line longer than 2000 characters is read only up to 2000', () => {
    const text = `${'x'.repeat(2000)} zorbak.com`;
    expect(scanLinks(text)).toEqual([]);
    expect(scanLinks(`zorbak.com ${'x'.repeat(2500)}`)).toHaveLength(1);
  });
});
