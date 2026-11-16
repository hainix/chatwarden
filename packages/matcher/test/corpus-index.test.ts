import { describe, expect, it } from 'vitest';
import { CorpusError, chooseRelease, parseIndex, revokedKeyIdsOf, verifySignature, type CorpusIndex } from '../src/corpus/index.js';
import { exampleIndex, indexBytes, indexWithRelease, makeKey, sigFileFor } from './corpus-world.js';

const NOW = Date.parse('2026-12-15T00:00:00Z');
const enc = new TextEncoder();

const parse = (json: unknown, now = NOW): CorpusIndex => parseIndex(json, now);
function codeOf(json: unknown, now = NOW): string {
  try {
    parseIndex(json, now);
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    expect((e as CorpusError).stage).toBe('index');
    return (e as CorpusError).code;
  }
  return 'none';
}
const withTop = (over: Record<string, unknown>): Record<string, unknown> => exampleIndex(over);
const dropTop = (key: string): Record<string, unknown> => {
  const i = exampleIndex();
  delete i[key];
  return i;
};

describe('parseIndex', () => {
  it("parseIndex: round-trips the design's example; unknown major schema, negative or non-integer sequence, missing latest, duplicate versions, a zip path with .. or a scheme, an expiresAt in the past (index_expired), a malformed date: each refused with its code", () => {
    const index = parse(JSON.stringify(exampleIndex()));
    expect(index.schema).toBe('chatwarden-corpus-index/1');
    expect(index.sequence).toBe(14);
    expect(index.keyId).toBe('k1');
    expect(index.issuedAt).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(index.expiresAt).toBe(Date.parse('2027-03-01T00:00:00Z'));
    expect(index.revokedKeyIds).toEqual([]);
    expect(index.revokedReleases).toEqual([{ kind: 'terms', version: '2026.11.0', reason: 'bad_release' }]);
    expect(index.latest).toEqual({ terms: '2026.12.0', eval: '2026.12.0' });
    expect(index.releases.map((r) => `${r.kind}:${r.version}`)).toEqual(['terms:2026.11.0', 'terms:2026.12.0', 'eval:2026.12.0']);
    const r = index.releases[1]!;
    expect(r).toMatchObject({
      kind: 'terms',
      version: '2026.12.0',
      publishedAt: Date.parse('2026-12-01T00:00:00Z'),
      minKit: '0.1.7',
      bytes: 1234,
      sha256: 'b'.repeat(64),
      zip: 'terms/2026.12.0/terms-2026.12.0.zip',
      sig: 'terms/2026.12.0/terms-2026.12.0.zip.sig',
      notes: 'Plain sentences; never a term.',
    });
    expect(r.languages).toEqual({ en: { terms: 3, exceptions: 1 }, es: { terms: 2, exceptions: 0 } });
    expect(r.mirrors).toEqual([{ kind: 'zenodo', doi: '10.5281/zenodo.0000000', url: 'https://zenodo.org/records/0000000/files/terms-2026.12.0.zip?download=1' }]);
    expect(index.releases[0]!.mirrors).toEqual([]);
    expect(index.releases[0]!.notes).toBeUndefined();
    // the same index as text, as bytes and as an object parses to the same thing
    expect(parse(indexBytes(exampleIndex()))).toEqual(index);
    expect(parse(structuredClone(exampleIndex()))).toEqual(index);
    // every refusal below is a CorpusError with the stage `index`
    expect(codeOf(withTop({ schema: 'chatwarden-corpus-index/2' }))).toBe('bad_index');
    expect(codeOf(withTop({ sequence: -1 }))).toBe('bad_index');
    expect(codeOf(withTop({ sequence: 1.5 }))).toBe('bad_index');
    expect(codeOf(dropTop('latest'))).toBe('bad_index');
    expect(codeOf(withTop({ expiresAt: '2026-12-10T00:00:00Z' }))).toBe('index_expired');
    expect(codeOf(withTop({ issuedAt: 'not a date' }))).toBe('bad_index');
  });

  it('the top-level fields: each wrong type or value is bad_index', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['schema a number', withTop({ schema: 1 })],
      ['schema missing', dropTop('schema')],
      ['schema of another family', withTop({ schema: 'chatwarden-corpus-manifest/1' })],
      ['schema major 0', withTop({ schema: 'chatwarden-corpus-index/0' })],
      ['schema major 10', withTop({ schema: 'chatwarden-corpus-index/10' })],
      ['schema 1.1', withTop({ schema: 'chatwarden-corpus-index/1.1' })],
      ['sequence a string', withTop({ sequence: '14' })],
      ['sequence null', withTop({ sequence: null })],
      ['sequence missing', dropTop('sequence')],
      ['sequence beyond the safe integers', withTop({ sequence: 2 ** 53 })],
      ['sequence -0.5', withTop({ sequence: -0.5 })],
      ['keyId missing', dropTop('keyId')],
      ['keyId with a space', withTop({ keyId: 'k 1' })],
      ['keyId 65 characters', withTop({ keyId: 'k'.repeat(65) })],
      ['revokedKeyIds not a list', withTop({ revokedKeyIds: 'k1' })],
      ['revokedKeyIds with a number', withTop({ revokedKeyIds: [1] })],
      ['revokedKeyIds missing', dropTop('revokedKeyIds')],
      ['revokedReleases not a list', withTop({ revokedReleases: {} })],
      ['revokedReleases a reason outside the closed list', withTop({ revokedReleases: [{ kind: 'terms', version: '2026.11.0', reason: 'because' }] })],
      ['revokedReleases a bad kind', withTop({ revokedReleases: [{ kind: 'zip', version: '2026.11.0', reason: 'legal' }] })],
      ['revokedReleases a bad version', withTop({ revokedReleases: [{ kind: 'terms', version: '11', reason: 'legal' }] })],
      ['latest not an object', withTop({ latest: '2026.12.0' })],
      ['latest empty', withTop({ latest: {} })],
      ['latest names a release that does not exist', withTop({ latest: { terms: '2027.1.0' } })],
      ['latest names the wrong kind', withTop({ latest: { eval: '2026.11.0' } })],
      ['latest a bad version', withTop({ latest: { terms: 'latest' } })],
      ['releases missing', dropTop('releases')],
      ['releases not a list', withTop({ releases: {} })],
      ['releases empty', withTop({ releases: [] })],
      ['a release that is null', withTop({ releases: [null] })],
      ['a release that is a string', withTop({ releases: ['2026.12.0'] })],
      ['expiresAt before issuedAt', withTop({ expiresAt: '2026-11-30T00:00:00Z' })],
    ];
    for (const [name, json] of cases) expect(codeOf(json), name).toBe('bad_index');
  });

  it('dates: only a full UTC timestamp that is a real calendar moment is accepted', () => {
    const ok = ['2026-12-01T00:00:00Z', '2026-12-01T23:59:59Z', '2026-12-01T00:00:00.5Z'];
    for (const d of ok) expect(codeOf(withTop({ issuedAt: d })), d).toBe('none');
    // a leap day is a real day (and a later expiry is fine); the same date in a common year is not
    expect(codeOf(withTop({ expiresAt: '2028-02-29T00:00:00Z' }))).toBe('none');
    const bad = [
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2027-02-29T00:00:00Z',
      '2026-12-32T00:00:00Z',
      '2026-12-01T24:00:00Z',
      '2026-12-01T00:60:00Z',
      '2026-12-01',
      '2026-12-01T00:00:00',
      '2026-12-01T00:00:00+01:00',
      '2026-12-01 00:00:00Z',
      'yesterday',
      '',
      '2026-12-01T00:00:00Z ',
      '26-12-01T00:00:00Z',
      20261201,
      null,
      {},
    ];
    for (const d of bad) expect(codeOf(withTop({ issuedAt: d })), String(d)).toBe('bad_index');
    for (const d of bad) expect(codeOf(withTop({ expiresAt: d })), String(d)).toBe('bad_index');
  });

  it('expiry: an index is refused at its expiry moment and after, accepted one millisecond before; a malformed index is bad_index even when it is also expired', () => {
    const at = Date.parse('2027-03-01T00:00:00Z');
    expect(codeOf(exampleIndex(), at - 1)).toBe('none');
    expect(codeOf(exampleIndex(), at)).toBe('index_expired');
    expect(codeOf(exampleIndex(), at + 86_400_000)).toBe('index_expired');
    expect(codeOf(withTop({ sequence: -3 }), at + 1)).toBe('bad_index');
    // a clock that is not a finite number cannot approve an index
    for (const now of [NaN, Infinity, -Infinity]) expect(codeOf(exampleIndex(), now)).toBe('bad_index');
  });

  it('releases: each field of an entry, wrong or hostile, is bad_index', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['kind other', { kind: 'other' }],
      ['kind missing', { kind: undefined }],
      ['version v-prefixed', { version: 'v2026.12.0' }],
      ['version month 13', { version: '2026.13.0' }],
      ['version month 00', { version: '2026.00.0' }],
      ['version two parts', { version: '2026.12' }],
      ['version four parts', { version: '2026.12.0.1' }],
      ['version with a slash', { version: '2026.12/0' }],
      ['version with a letter', { version: '2026.12.x' }],
      ['version a number', { version: 2026.12 }],
      ['publishedAt malformed', { publishedAt: '2026-12-01' }],
      ['minKit two parts', { minKit: '0.1' }],
      ['minKit text', { minKit: 'latest' }],
      ['minKit with a range', { minKit: '^0.1.7' }],
      ['minKit missing', { minKit: undefined }],
      ['bytes zero', { bytes: 0 }],
      ['bytes negative', { bytes: -1 }],
      ['bytes fractional', { bytes: 1.5 }],
      ['bytes a string', { bytes: '1234' }],
      ['bytes over 8 MiB', { bytes: 8 * 1024 * 1024 + 1 }],
      ['sha256 63 hex characters', { sha256: 'b'.repeat(63) }],
      ['sha256 65 hex characters', { sha256: 'b'.repeat(65) }],
      ['sha256 upper case', { sha256: 'B'.repeat(64) }],
      ['sha256 not hex', { sha256: 'g'.repeat(64) }],
      ['zip with ..', { zip: 'terms/../../secrets.zip' }],
      ['zip with a leading ..', { zip: '../terms.zip' }],
      ['zip with a scheme', { zip: 'https://evil.example/terms.zip' }],
      ['zip with a scheme of another kind', { zip: 'file:terms.zip' }],
      ['zip with a leading slash', { zip: '/terms/x.zip' }],
      ['zip with a backslash', { zip: 'terms\\x.zip' }],
      ['zip with a double slash', { zip: 'terms//x.zip' }],
      ['zip with a dot segment', { zip: 'terms/./x.zip' }],
      ['zip with an encoded dot', { zip: 'terms/%2e%2e/x.zip' }],
      ['zip with a query', { zip: 'terms/x.zip?x=1' }],
      ['zip with a fragment', { zip: 'terms/x.zip#y' }],
      ['zip with a space', { zip: 'terms/x y.zip' }],
      ['zip with a control character', { zip: 'terms/x\n.zip' }],
      ['zip empty', { zip: '' }],
      ['zip 201 characters', { zip: `terms/${'a'.repeat(196)}.zip` }],
      ['zip a number', { zip: 12 }],
      ['sig with ..', { sig: 'terms/../x.sig' }],
      ['sig with a scheme', { sig: 'data:text/plain,x' }],
      ['mirrors not a list', { mirrors: {} }],
      ['mirror over http', { mirrors: [{ kind: 'zenodo', url: 'http://zenodo.org/x.zip' }] }],
      ['mirror a javascript url', { mirrors: [{ kind: 'zenodo', url: 'javascript:alert(1)' }] }],
      ['mirror with credentials', { mirrors: [{ kind: 'zenodo', url: 'https://user:pw@zenodo.org/x.zip' }] }],
      ['mirror a relative url', { mirrors: [{ kind: 'zenodo', url: '/x.zip' }] }],
      ['mirror without a url', { mirrors: [{ kind: 'zenodo' }] }],
      ['mirror a url of 2 000 characters', { mirrors: [{ kind: 'zenodo', url: `https://zenodo.org/${'a'.repeat(2000)}` }] }],
      ['mirror a doi that is a number', { mirrors: [{ kind: 'zenodo', doi: 5, url: 'https://zenodo.org/x.zip' }] }],
      ['notes a number', { notes: 5 }],
      ['notes 501 characters', { notes: 'n'.repeat(501) }],
      ['languages a list', { languages: [] }],
      ['languages a count that is negative', { languages: { en: { terms: -1, exceptions: 0 } } }],
      ['languages a count that is a string', { languages: { en: { terms: '3' } } }],
      ['languages a tag with a space', { languages: { 'e n': { terms: 3 } } }],
    ];
    for (const [name, patch] of cases) expect(codeOf(indexWithRelease(1, patch)), name).toBe('bad_index');
    // controls: the neighbours of the refused values are fine
    expect(codeOf(indexWithRelease(1, { version: '2026.12.12' }))).toBe('bad_index'); // no longer the latest release
    expect(codeOf(indexWithRelease(0, { version: '2026.11.12', zip: 'terms/2026.11.12/terms.zip' }))).toBe('none');
    expect(codeOf(indexWithRelease(1, { bytes: 8 * 1024 * 1024 }))).toBe('none');
    expect(codeOf(indexWithRelease(1, { zip: 'terms/a-b_c.d/e.zip', mirrors: [] }))).toBe('none');
    expect(codeOf(indexWithRelease(1, { languages: { 'pt-BR': { terms: 0, exceptions: 0 } } }))).toBe('none');
  });

  it('duplicate versions are refused; the same version under two kinds is fine', () => {
    const base = exampleIndex();
    const releases = base.releases as Record<string, unknown>[];
    expect(codeOf({ ...base, releases: [...releases, { ...releases[1]! }] })).toBe('bad_index');
    expect(codeOf({ ...base, releases: [...releases, { ...releases[1]!, sha256: 'd'.repeat(64) }] })).toBe('bad_index');
    // 2026.12.0 is both a terms and an eval release in the example already
    expect(parse(base).releases.filter((r) => r.version === '2026.12.0')).toHaveLength(2);
  });

  it('not JSON, not an object, not text: bad_index; and an index over 256 KiB is too_large, unread', () => {
    for (const bad of ['', '   ', 'not json', '{', '[]', 'null', '12', '"text"', 'true', '{"a":1}', null, undefined, 12, [], () => 1, Symbol('x')]) {
      expect(codeOf(bad), String(bad)).toBe('bad_index');
    }
    expect(codeOf(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe('bad_index');
    expect(codeOf(enc.encode('﻿' + JSON.stringify(exampleIndex())))).toBe('bad_index');
    expect(codeOf(new Uint8Array(0))).toBe('bad_index');
    const big = JSON.stringify({ ...exampleIndex(), notes: 'x'.repeat(300 * 1024) });
    expect(codeOf(big)).toBe('too_large');
    expect(codeOf(enc.encode(big))).toBe('too_large');
    // a limit is on size, so a large but valid index is fine just under it
    const padded = JSON.stringify({ ...exampleIndex(), pad: 'x'.repeat(200 * 1024) });
    expect(codeOf(padded)).toBe('none');
  });

  it('a hostile object: a __proto__ key, getters that throw, a proxy and a cyclic value never throw anything but CorpusError and never pollute', () => {
    const text = JSON.stringify(exampleIndex()).replace('{', '{"__proto__":{"polluted":true},');
    expect(codeOf(text)).toBe('none');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const evil = exampleIndex();
    Object.defineProperty(evil, 'sequence', {
      enumerable: true,
      get: () => {
        throw new Error('zorbak getter');
      },
    });
    expect(codeOf(evil)).toBe('bad_index');
    const trap = (): never => {
      throw new Error('vlemmo trap');
    };
    expect(codeOf(new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }))).toBe('bad_index');
    const cyclic: Record<string, unknown> = exampleIndex();
    cyclic.latest = cyclic;
    expect(codeOf(cyclic)).toBe('bad_index');
    const deep = '['.repeat(100_000);
    expect(codeOf(deep)).toBe('bad_index');
  });

  it('CorpusError from parseIndex: no message contains any string from the input', () => {
    const words = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
    const inputs: unknown[] = [
      withTop({ schema: 'zorbak/1' }),
      withTop({ keyId: 'vlemmo quissel' }),
      withTop({ latest: { terms: 'drakkuun' } }),
      indexWithRelease(1, { zip: 'https://fenrisk.example/tarvo.zip' }),
      indexWithRelease(1, { version: 'snerp-glarn' }),
      indexWithRelease(1, { notes: 5, sha256: 'zorbak' }),
      withTop({ issuedAt: 'zorbak vlemmo' }),
      `{"zorbak": ${words.map((w) => `"${w}"`).join(',')}`,
      words.join(' '),
      withTop({ expiresAt: '2000-01-01T00:00:00Z', notes: words.join(' ') }),
    ];
    for (const input of inputs) {
      try {
        parseIndex(input, NOW);
        throw new Error('expected a refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(CorpusError);
        const err = e as CorpusError;
        for (const text of [err.message, String(err), JSON.stringify(err), JSON.stringify(Object.getOwnPropertyNames(err)), err.code, err.stage]) {
          for (const w of words) expect(text.toLowerCase(), text).not.toContain(w);
        }
      }
    }
  });
});

describe('chooseRelease', () => {
  const index = parse(exampleIndex());

  it('chooseRelease: pin finds its version; a pin that is absent is no_such_version; follow takes latest.terms; a revoked release is revoked_release; minKit above the kit is kit_too_old (compare as numbers, 0.1.10 above 0.1.9)', () => {
    expect(chooseRelease(index, { kind: 'terms', pin: '2026.12.0', kit: '0.1.10' }).version).toBe('2026.12.0');
    expect(chooseRelease(index, { kind: 'terms', pin: '2026.12.0', kit: '0.1.10' }).kind).toBe('terms');
    // the same version under the other kind is a different release
    const ev = chooseRelease(index, { kind: 'eval', pin: '2026.12.0', kit: '0.1.10' });
    expect(ev.kind).toBe('eval');
    expect(ev.zip).toBe('eval/2026.12.0/eval-2026.12.0.zip');
    expect(chooseRelease(index, { kind: 'terms', follow: 'stable', kit: '0.1.10' }).version).toBe('2026.12.0');
    expect(chooseRelease(index, { kind: 'eval', follow: 'stable', kit: '0.1.10' }).kind).toBe('eval');
    // absent
    for (const pin of ['2027.1.0', '2026.12', 'latest', '', '2026.12.0 ', '../x']) {
      expect(codeOfChoose(index, { kind: 'terms', pin, kit: '0.1.10' }), pin).toBe('no_such_version');
    }
    expect(codeOfChoose(index, { kind: 'eval', pin: '2026.11.0', kit: '0.1.10' })).toBe('no_such_version');
    // revoked: a pin on it, and following a latest that has been revoked
    expect(codeOfChoose(index, { kind: 'terms', pin: '2026.11.0', kit: '0.1.10' })).toBe('revoked_release');
    const latestRevoked = parse(withTop({ revokedReleases: [{ kind: 'terms', version: '2026.12.0', reason: 'legal' }] }));
    expect(codeOfChoose(latestRevoked, { kind: 'terms', follow: 'stable', kit: '0.1.10' })).toBe('revoked_release');
    // a revoked terms release does not revoke the eval release of the same version
    expect(chooseRelease(latestRevoked, { kind: 'eval', follow: 'stable', kit: '0.1.10' }).version).toBe('2026.12.0');
    // kit: compared as numbers
    expect(codeOfChoose(index, { kind: 'terms', pin: '2026.12.0', kit: '0.1.6' })).toBe('kit_too_old');
    expect(chooseRelease(index, { kind: 'terms', pin: '2026.12.0', kit: '0.1.7' }).version).toBe('2026.12.0');
    const needs10 = parse(indexWithRelease(1, { minKit: '0.1.10' }));
    expect(codeOfChoose(needs10, { kind: 'terms', pin: '2026.12.0', kit: '0.1.9' })).toBe('kit_too_old');
    expect(chooseRelease(needs10, { kind: 'terms', pin: '2026.12.0', kit: '0.1.10' }).version).toBe('2026.12.0');
    expect(chooseRelease(needs10, { kind: 'terms', pin: '2026.12.0', kit: '0.1.11' }).version).toBe('2026.12.0');
    expect(chooseRelease(needs10, { kind: 'terms', pin: '2026.12.0', kit: '0.2.0' }).version).toBe('2026.12.0');
    expect(chooseRelease(needs10, { kind: 'terms', pin: '2026.12.0', kit: '1.0.0' }).version).toBe('2026.12.0');
    const needsBig = parse(indexWithRelease(1, { minKit: '1.0.0' }));
    expect(codeOfChoose(needsBig, { kind: 'terms', pin: '2026.12.0', kit: '0.99.99' })).toBe('kit_too_old');
    // a pre-release or build suffix on the kit reads as its release numbers
    expect(chooseRelease(needs10, { kind: 'terms', pin: '2026.12.0', kit: '0.1.10-rc.1' }).version).toBe('2026.12.0');
    expect(codeOfChoose(needs10, { kind: 'terms', pin: '2026.12.0', kit: '0.1.9+build.5' })).toBe('kit_too_old');
  });

  it('the order of the checks: no_such_version, then revoked_release, then kit_too_old', () => {
    const idx = parse(
      withTop({
        revokedReleases: [{ kind: 'terms', version: '2026.12.0', reason: 'bad_release' }],
        releases: (exampleIndex().releases as Record<string, unknown>[]).map((r) => ({ ...r, minKit: '9.0.0' })),
      }),
    );
    expect(codeOfChoose(idx, { kind: 'terms', pin: '2030.1.0', kit: '0.1.10' })).toBe('no_such_version');
    expect(codeOfChoose(idx, { kind: 'terms', pin: '2026.12.0', kit: '0.1.10' })).toBe('revoked_release');
    expect(codeOfChoose(idx, { kind: 'eval', pin: '2026.12.0', kit: '0.1.10' })).toBe('kit_too_old');
  });

  it('follow with no latest for the kind is no_such_version', () => {
    const onlyTerms = parse(withTop({ latest: { terms: '2026.12.0' } }));
    expect(codeOfChoose(onlyTerms, { kind: 'eval', follow: 'stable', kit: '0.1.10' })).toBe('no_such_version');
    expect(chooseRelease(onlyTerms, { kind: 'terms', follow: 'stable', kit: '0.1.10' }).version).toBe('2026.12.0');
  });

  it('pin and follow together, neither, a follow other than stable, or a kit that is not a version are programming errors (RangeError naming the option)', () => {
    const both = { kind: 'terms', pin: '2026.12.0', follow: 'stable', kit: '0.1.10' } as never;
    expect(() => chooseRelease(index, both)).toThrow(RangeError);
    expect(() => chooseRelease(index, { kind: 'terms', kit: '0.1.10' } as never)).toThrow(/pin/);
    expect(() => chooseRelease(index, { kind: 'terms', follow: 'newest', kit: '0.1.10' } as never)).toThrow(RangeError);
    for (const kit of ['', 'dev', '0.1', 'x.y.z', undefined, 7]) {
      expect(() => chooseRelease(index, { kind: 'terms', pin: '2026.12.0', kit } as never), String(kit)).toThrow(/kit/);
    }
    expect(() => chooseRelease(index, { kind: 'zip', pin: '2026.12.0', kit: '0.1.10' } as never)).toThrow(RangeError);
  });
});

describe('revokedKeyIdsOf', () => {
  it('honours the index list except for the key that signed the index (a key cannot revoke itself away from the check that just trusted it)', () => {
    const idx = parse(withTop({ revokedKeyIds: ['k1', 'k2', 'k2', 'k7'] }));
    expect(revokedKeyIdsOf(idx, 'k1')).toEqual(['k2', 'k7']);
    expect(revokedKeyIdsOf(idx, 'k2')).toEqual(['k1', 'k7']);
    expect(revokedKeyIdsOf(idx, 'k9')).toEqual(['k1', 'k2', 'k7']);
    expect(revokedKeyIdsOf(parse(exampleIndex()), 'k1')).toEqual([]);
  });

  it('end to end: an index signed by k1 that revokes k2 makes a release signed by k2 revoked_key, and one revoking only k1 does not stop k1', async () => {
    const k1 = await makeKey('k1');
    const k2 = await makeKey('k2');
    const keys = [
      { id: 'k1', publicKey: k1.publicKey },
      { id: 'k2', publicKey: k2.publicKey },
    ];
    const zip = enc.encode('zip bytes stand-in');
    const zipSig = await sigFileFor(k2, 'zip', zip);
    const revokesK2 = indexBytes(withTop({ revokedKeyIds: ['k2'] }));
    const signer = await verifySignature('index', revokesK2, await sigFileFor(k1, 'index', revokesK2), keys);
    expect(signer.keyId).toBe('k1');
    const parsed = parse(revokesK2);
    const revoked = revokedKeyIdsOf(parsed, signer.keyId);
    await expect(verifySignature('zip', zip, zipSig, keys, { revokedKeyIds: revoked })).rejects.toMatchObject({ code: 'revoked_key' });
    // an index that names only its own signer revokes nothing for this check
    const revokesSelf = indexBytes(withTop({ revokedKeyIds: ['k1'] }));
    const selfSigner = await verifySignature('index', revokesSelf, await sigFileFor(k1, 'index', revokesSelf), keys);
    const none = revokedKeyIdsOf(parse(revokesSelf), selfSigner.keyId);
    expect(none).toEqual([]);
    expect(await verifySignature('zip', zip, await sigFileFor(k1, 'zip', zip), keys, { revokedKeyIds: none })).toEqual({ keyId: 'k1' });
  });
});

function codeOfChoose(index: CorpusIndex, options: Parameters<typeof chooseRelease>[1]): string {
  try {
    chooseRelease(index, options);
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    expect((e as CorpusError).stage).toBe('index');
    return (e as CorpusError).code;
  }
  return 'none';
}
