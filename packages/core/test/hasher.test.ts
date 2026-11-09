import { describe, expect, it } from 'vitest';
import { hashWho, makeHasher } from '../src/hasher.js';
import * as core from '../src/index.js';

describe('makeHasher', () => {
  it('byte-compatible with Moxgate', () => {
    const h = makeHasher('cw-test-secret');
    expect(h.clientKey('tok-1')).toBe('3479e956cc5f4a6bf787a7d5e48d2924');
    expect(h.ip('203.0.113.7')).toBe('e46dc4c1d8ae7679e5a5871123cb155e');
  });

  it('empty secret throws', () => {
    expect(() => makeHasher('')).toThrow();
  });

  it('kinds never collide', () => {
    const h = makeHasher('cw-test-secret');
    expect(h.clientKey('x')).not.toBe(h.ip('x'));
  });

  it('is deterministic and 32 lowercase hex characters', () => {
    const h = makeHasher('cw-test-secret');
    expect(h.clientKey('tok-1')).toBe(h.clientKey('tok-1'));
    expect(h.ip('10.0.0.1')).toMatch(/^[0-9a-f]{32}$/);
    expect(h.clientKey('')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('different secrets give different hashes; different inputs too', () => {
    const a = makeHasher('secret-a');
    const b = makeHasher('secret-b');
    expect(a.clientKey('tok-1')).not.toBe(b.clientKey('tok-1'));
    expect(a.ip('1.1.1.1')).not.toBe(b.ip('1.1.1.1'));
    expect(a.clientKey('tok-1')).not.toBe(a.clientKey('tok-2'));
  });
});

describe('hashWho', () => {
  const h = makeHasher('cw-test-secret');

  it("hashWho drops empty, missing and 'unknown'", () => {
    expect(hashWho(h, {})).toEqual({ clientKey: null, accountId: null, ipHash: null });
    expect(hashWho(h, { clientKey: '', accountId: '', ip: '' })).toEqual({
      clientKey: null,
      accountId: null,
      ipHash: null,
    });
    expect(hashWho(h, { ip: 'unknown' }).ipHash).toBeNull();
    expect(hashWho(h, { ip: null }).ipHash).toBeNull();
    expect(hashWho(h, { ip: undefined }).ipHash).toBeNull();
  });

  it('hashWho keeps a raw account id', () => {
    const out = hashWho(h, { accountId: 'acct-42' });
    expect(out.accountId).toBe('acct-42');
    expect(out.clientKey).toBeNull();
    expect(out.ipHash).toBeNull();
  });

  it('hashes the client key and ip with the matching kinds, never leaving them raw', () => {
    const out = hashWho(h, { clientKey: 'tok-1', accountId: 'a', ip: '203.0.113.7' });
    expect(out).toEqual({
      clientKey: '3479e956cc5f4a6bf787a7d5e48d2924',
      accountId: 'a',
      ipHash: 'e46dc4c1d8ae7679e5a5871123cb155e',
    });
  });

  it("only the literal 'unknown' is a sentinel", () => {
    expect(hashWho(h, { ip: 'Unknown' }).ipHash).toBe(h.ip('Unknown'));
    expect(hashWho(h, { clientKey: 'unknown' }).clientKey).toBe(h.clientKey('unknown'));
  });
});

describe('index exports', () => {
  it('exports the hasher functions', () => {
    expect(core.makeHasher).toBe(makeHasher);
    expect(core.hashWho).toBe(hashWho);
  });
});
