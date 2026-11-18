import { afterEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../src/crypto.js';
import { mintAppealToken, verifyAppealToken } from '../src/appealLink.js';

// The signed appeal link at token level: what it holds, what forges it, when it expires. The link is a capability for one sanction, so every
// bad token must read the same: `{ ok: false }` with nothing to tell one cause from another.

const SECRET = 'link-test-secret';
const NOW = 1_800_000_000_000;
const PREFIX = 'chatwarden.appeal.v1.';

const seg = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const mac = (secret: string, prefix: string, segment: string): string => Buffer.from(hmacSha256Hex(secret, prefix + segment), 'hex').toString('base64url');
/** A token built by hand, signed under `prefix`, so a test can make a payload the minter never would. */
const hand = (payload: string, opts: { secret?: string; prefix?: string } = {}): string => {
  const s = seg(payload);
  return `${s}.${mac(opts.secret ?? SECRET, opts.prefix ?? PREFIX, s)}`;
};
const flip = (text: string, at: number): string => text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
const INVALID = { ok: false };

afterEach(() => vi.restoreAllMocks());

describe('mint and verify', () => {
  it('a minted token verifies and returns the notice id and the expiry', () => {
    const token = mintAppealToken(SECRET, 'notice-1', NOW + 1000);
    expect(verifyAppealToken(SECRET, token, NOW)).toEqual({ ok: true, noticeId: 'notice-1', expiresAt: NOW + 1000 });
  });

  it('the token is payload.signature, url safe, with a 43 character signature', () => {
    const token = mintAppealToken(SECRET, 'abc', NOW + 5);
    expect(token).toMatch(/^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/);
    expect(token.split('.')).toHaveLength(2);
    // The same inputs make the same token (the MAC is deterministic) and another expiry makes another.
    expect(mintAppealToken(SECRET, 'abc', NOW + 5)).toBe(token);
    expect(mintAppealToken(SECRET, 'abc', NOW + 6)).not.toBe(token);
  });

  it('the payload decodes to {"v":1,"n":..,"e":..} and holds no subject, key, account or ip', () => {
    const token = mintAppealToken(SECRET, 'a1b2c3', NOW + 77);
    const payload = Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8');
    expect(payload).toBe(`{"v":1,"n":"a1b2c3","e":${NOW + 77}}`);
    expect(Object.keys(JSON.parse(payload) as object)).toEqual(['v', 'n', 'e']);
    expect(payload).not.toMatch(/subject|key|account|ip/i);
  });

  it('the signature is HMAC-SHA256 under the appeal namespace, over the payload segment as sent', () => {
    const token = mintAppealToken(SECRET, 'n-9', NOW + 9);
    const [s, sig] = token.split('.') as [string, string];
    expect(sig).toBe(mac(SECRET, PREFIX, s));
  });

  it('a notice id with quotes, a backslash and non-ASCII text round trips', () => {
    const id = 'q"\\\u{e9}\u{4e2d}';
    expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, id, NOW + 1), NOW)).toEqual({ ok: true, noticeId: id, expiresAt: NOW + 1 });
  });

  it('the largest notice id (64 characters) and a 1 character one verify; minting refuses what could never verify', () => {
    for (const id of ['x', 'y'.repeat(64)]) expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, id, NOW + 1), NOW)).toMatchObject({ ok: true, noticeId: id });
    for (const id of ['', 'z'.repeat(65), 7 as never, null as never]) expect(() => mintAppealToken(SECRET, id, NOW + 1)).toThrow(RangeError);
    for (const e of [1.5, Number.NaN, Infinity, 2 ** 60, '5' as never]) expect(() => mintAppealToken(SECRET, 'n', e)).toThrow(RangeError);
  });
});

describe('forgery matrix: every one is { ok: false } and never throws', () => {
  const good = mintAppealToken(SECRET, 'notice-1', NOW + 60_000);
  const [p, s] = good.split('.') as [string, string];
  const other = mintAppealToken(SECRET, 'notice-2', NOW + 60_000);
  const cases: Array<[string, unknown]> = [
    ['one character of the payload changed', `${flip(p, 3)}.${s}`],
    ['one character of the signature changed', `${p}.${flip(s, 10)}`],
    ['the first character of the signature changed', `${p}.${flip(s, 0)}`],
    ['the last character of the signature changed', `${p}.${flip(s, 42)}`],
    ["another token's signature swapped in", `${p}.${other.split('.')[1]}`],
    ['the dot dropped', `${p}${s}`],
    ['two dots', `${p}.${s.slice(0, 20)}.${s.slice(20)}`],
    ['a trailing dot part', `${good}.`],
    ['an empty payload', `.${s}`],
    ['an empty signature', `${p}.`],
    ['a signature of 42 characters', `${p}.${s.slice(0, 42)}`],
    ['a signature of 44 characters', `${p}.${s}A`],
    ['characters outside the alphabet', `${p}!.${s}`],
    ['a plus sign (standard base64)', `${p}.${s.slice(0, 42)}+`],
    ['a space inside', `${p} .${s}`],
    ['trailing whitespace', `${good} `],
    ['leading whitespace', ` ${good}`],
    ['a trailing newline', `${good}\n`],
    ['a 600 character token', `${'A'.repeat(560)}.${s}`],
    ['a payload of 401 characters', `${'A'.repeat(401)}.${s}`],
    ['the empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['the number 7', 7],
    ['an empty object', {}],
    ['an array holding the token', [good]],
    ['a String object', new String(good)],
    ['a symbol', Symbol('t')],
    ['true', true],
  ];
  it.each(cases)('%s', (_name, token) => {
    expect(() => verifyAppealToken(SECRET, token, NOW)).not.toThrow();
    expect(verifyAppealToken(SECRET, token, NOW)).toEqual(INVALID);
  });

  it('the good token is the control: it verifies', () => {
    expect(verifyAppealToken(SECRET, good, NOW)).toMatchObject({ ok: true });
  });

  it('every refusal is the very same value: no detail says which check failed', () => {
    const answers = cases.map(([, t]) => JSON.stringify(verifyAppealToken(SECRET, t, NOW)));
    expect(new Set(answers)).toEqual(new Set([JSON.stringify(INVALID)]));
    const expired = verifyAppealToken(SECRET, mintAppealToken(SECRET, 'n', NOW - 1), NOW);
    const wrongSecret = verifyAppealToken('other', good, NOW);
    expect(JSON.stringify(expired)).toBe(JSON.stringify(INVALID));
    expect(JSON.stringify(wrongSecret)).toBe(JSON.stringify(INVALID));
  });

  it('a hostile object that throws when read as text reads invalid', () => {
    const hostile = {
      toString: () => {
        throw new Error('boom');
      },
    };
    expect(verifyAppealToken(SECRET, hostile, NOW)).toEqual(INVALID);
  });
});

describe('expiry', () => {
  it('e == now is invalid, e == now + 1 is valid', () => {
    expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, 'n', NOW), NOW)).toEqual(INVALID);
    expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, 'n', NOW + 1), NOW)).toMatchObject({ ok: true, expiresAt: NOW + 1 });
  });

  it('a token past its time is invalid; a time of zero or before is invalid', () => {
    expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, 'n', NOW - 5_000), NOW)).toEqual(INVALID);
    expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, 'n', 0), NOW)).toEqual(INVALID);
    expect(verifyAppealToken(SECRET, mintAppealToken(SECRET, 'n', -5), NOW)).toEqual(INVALID);
  });

  it('the clock is the one passed in, not the wall clock', () => {
    const token = mintAppealToken(SECRET, 'n', 1000);
    expect(verifyAppealToken(SECRET, token, 999)).toMatchObject({ ok: true });
    expect(verifyAppealToken(SECRET, token, 1000)).toEqual(INVALID);
  });
});

describe('the payload is checked after the MAC', () => {
  it('v other than 1 is invalid even when the MAC is right for that payload', () => {
    for (const v of ['2', '0', '"1"', 'null', 'true', '1.5']) {
      expect(verifyAppealToken(SECRET, hand(`{"v":${v},"n":"n1","e":${NOW + 9}}`), NOW), v).toEqual(INVALID);
    }
    expect(verifyAppealToken(SECRET, hand(`{"n":"n1","e":${NOW + 9}}`), NOW)).toEqual(INVALID);
    // control: the same payload with v 1 is fine
    expect(verifyAppealToken(SECRET, hand(`{"v":1,"n":"n1","e":${NOW + 9}}`), NOW)).toMatchObject({ ok: true });
  });

  it('a payload with no notice id, or a bad one, or a bad expiry, is invalid under a right MAC', () => {
    const bad = [
      `{"v":1,"e":${NOW + 9}}`,
      `{"v":1,"n":"","e":${NOW + 9}}`,
      `{"v":1,"n":7,"e":${NOW + 9}}`,
      `{"v":1,"n":null,"e":${NOW + 9}}`,
      `{"v":1,"n":"${'x'.repeat(65)}","e":${NOW + 9}}`,
      '{"v":1,"n":"n1"}',
      `{"v":1,"n":"n1","e":"${NOW + 9}"}`,
      `{"v":1,"n":"n1","e":${NOW + 9}.5}`,
      '{"v":1,"n":"n1","e":1e300}',
      '{"v":1,"n":"n1","e":null}',
      '[]',
      'null',
      '7',
      '"text"',
      '{}',
    ];
    for (const payload of bad) expect(verifyAppealToken(SECRET, hand(payload), NOW), payload).toEqual(INVALID);
  });

  it('a payload carrying a subject id is not read for it: the answer is the notice and the expiry and no more', () => {
    const r = verifyAppealToken(SECRET, hand(`{"v":1,"n":"n1","e":${NOW + 9},"s":"s_person","k":"key"}`), NOW);
    expect(r).toEqual({ ok: true, noticeId: 'n1', expiresAt: NOW + 9 });
  });

  it('a payload that is not valid UTF-8 or not JSON is invalid under a right MAC', () => {
    const s = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url');
    expect(verifyAppealToken(SECRET, `${s}.${mac(SECRET, PREFIX, s)}`, NOW)).toEqual(INVALID);
    expect(verifyAppealToken(SECRET, hand('{not json'), NOW)).toEqual(INVALID);
  });

  it('the MAC is checked before the payload is parsed: a wrong MAC over junk JSON never reaches JSON.parse', () => {
    const junk = seg('{not json at all');
    const forged = `${junk}.${'A'.repeat(43)}`;
    const spy = vi.spyOn(JSON, 'parse');
    expect(verifyAppealToken(SECRET, forged, NOW)).toEqual(INVALID);
    expect(spy).not.toHaveBeenCalled();
    // control: with the right MAC the very same junk is parsed (and refused)
    spy.mockClear();
    expect(verifyAppealToken(SECRET, `${junk}.${mac(SECRET, PREFIX, junk)}`, NOW)).toEqual(INVALID);
    expect(spy).toHaveBeenCalled();
  });
});

describe('namespacing: a MAC made for anything else does not verify', () => {
  const payload = `{"v":1,"n":"n1","e":${NOW + 9}}`;
  const s = seg(payload);

  it('the bare HMAC of the payload (the holdback hash form) does not verify', () => {
    const bare = Buffer.from(hmacSha256Hex(SECRET, s), 'hex').toString('base64url');
    expect(verifyAppealToken(SECRET, `${s}.${bare}`, NOW)).toEqual(INVALID);
  });

  it.each(['chatwarden.appeal.v2.', 'chatwarden.evidence.', 'chatwarden.appeal.', 'chatwarden.appeal.v1', 'Chatwarden.appeal.v1.', 'chatwarden.holdback.v1.'])('prefix %s does not verify', (prefix) => {
    expect(verifyAppealToken(SECRET, hand(payload, { prefix }), NOW)).toEqual(INVALID);
  });

  it('a MAC over the decoded JSON text instead of the segment does not verify', () => {
    const wrong = Buffer.from(hmacSha256Hex(SECRET, PREFIX + payload), 'hex').toString('base64url');
    expect(verifyAppealToken(SECRET, `${s}.${wrong}`, NOW)).toEqual(INVALID);
  });

  it('a token signed with another secret does not verify (and the right one does)', () => {
    expect(verifyAppealToken(SECRET, hand(payload, { secret: 'another-secret' }), NOW)).toEqual(INVALID);
    expect(verifyAppealToken(SECRET, hand(payload), NOW)).toMatchObject({ ok: true });
    expect(verifyAppealToken('another-secret', mintAppealToken(SECRET, 'n1', NOW + 9), NOW)).toEqual(INVALID);
  });
});

describe('the comparison', () => {
  it('signatures that differ at the first and at the last character are both invalid, whatever the position', () => {
    const token = mintAppealToken(SECRET, 'n1', NOW + 100);
    const [p, s] = token.split('.') as [string, string];
    for (let i = 0; i < 43; i++) expect(verifyAppealToken(SECRET, `${p}.${flip(s, i)}`, NOW), `position ${i}`).toEqual(INVALID);
    expect(verifyAppealToken(SECRET, token, NOW)).toMatchObject({ ok: true });
  });
});
