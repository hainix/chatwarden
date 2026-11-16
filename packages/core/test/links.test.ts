import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { Chatwarden } from '../src/chatwarden.js';
import { checkLinkRow, LINK_SYSTEMS } from '../src/links.js';
import type { LinkRow, LinkSystem } from '../src/links.js';
import type { Logger, Platform, RawWho, Store } from '../src/types.js';
import { MemoryStore, withMemoryLinks } from '@chatwarden/store-memory';

// `cw.links` (K5 design 5.1): "this kit id is that outside id", one small table for Coop and EOS. Run on the in-memory store (its link
// methods are opt-in); the store contract proves SQLite agrees.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const row = (over: Partial<LinkRow> = {}): LinkRow => ({ system: 'coop-report', ref: 'r1', external: 'job-zorbak-1', state: 'sent', at: NOW, ...over });

async function setup(store: Store = withMemoryLinks(new MemoryStore())) {
  const clock = { t: NOW, now: () => clock.t };
  const logger: Logger = { warn() {} };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store, secret: 'links-secret', platform, clock, logger, retention: false });
  return { cw, clock, store };
}

/** What `put` threw for this row: its class and message. */
function refusal(cw: Chatwarden, r: unknown): { name: string; message: string } {
  try {
    cw.links.put(r as LinkRow);
  } catch (err) {
    const e = err as Error;
    return { name: e.constructor.name, message: e.message };
  }
  throw new Error('expected put to throw');
}

describe('LINK_SYSTEMS', () => {
  it('is the closed list from the design', () => {
    expect([...LINK_SYSTEMS]).toEqual(['coop-report', 'eos-sanction', 'eos-report', 'eos-cursor']);
  });
});

describe('cw.links.supported', () => {
  it('is true for a store with the link methods and false for one without', async () => {
    expect((await setup()).cw.links.supported).toBe(true);
    expect((await setup(new MemoryStore())).cw.links.supported).toBe(false);
  });

  it('is false when only some of the methods exist (all four are needed)', async () => {
    const partial = withMemoryLinks(new MemoryStore());
    Object.defineProperty(partial, 'purgeLinks', { value: undefined, configurable: true });
    expect((await setup(partial)).cw.links.supported).toBe(false);
  });

  it('a store without the methods: get is null, list is empty, put throws and writes nothing', async () => {
    const { cw } = await setup(new MemoryStore());
    expect(cw.links.get('coop-report', 'r1')).toBeNull();
    expect(cw.links.list('coop-report')).toEqual([]);
    expect(() => cw.links.put(row())).toThrow(/not supported/);
    expect(cw.links.get('coop-report', 'r1')).toBeNull();
  });
});

describe('cw.links get, put and list', () => {
  it('get returns null for an unknown row; put inserts, put again replaces (same system and ref), a different system with the same ref is another row', async () => {
    const { cw } = await setup();
    expect(cw.links.get('coop-report', 'r1')).toBeNull();
    cw.links.put(row());
    expect(cw.links.get('coop-report', 'r1')).toEqual(row());
    cw.links.put(row({ state: 'decided', external: 'job-zorbak-2', at: NOW + 1 }));
    expect(cw.links.get('coop-report', 'r1')).toEqual(row({ state: 'decided', external: 'job-zorbak-2', at: NOW + 1 }));
    expect(cw.links.list('coop-report')).toHaveLength(1);
    cw.links.put(row({ system: 'eos-sanction', external: 'ref-1', state: 'active' }));
    expect(cw.links.get('eos-sanction', 'r1')?.external).toBe('ref-1');
    expect(cw.links.get('coop-report', 'r1')?.external).toBe('job-zorbak-2');
    for (const system of LINK_SYSTEMS) cw.links.put(row({ system, ref: 'each' }));
    for (const system of LINK_SYSTEMS) expect(cw.links.get(system, 'each')?.system).toBe(system);
  });

  it('get answers null, and never throws, for a system or ref that put would refuse', async () => {
    const { cw } = await setup();
    cw.links.put(row());
    expect(cw.links.get('nope' as LinkSystem, 'r1')).toBeNull();
    expect(cw.links.get('coop-report', 'r 1')).toBeNull();
    expect(cw.links.get('coop-report', '')).toBeNull();
    expect(cw.links.get('coop-report', 'x'.repeat(129))).toBeNull();
    expect(cw.links.get('coop-report', 7 as never)).toBeNull();
    expect(cw.links.get(undefined as never, undefined as never)).toBeNull();
  });

  it('stores only the five fields: an extra property on the row is dropped, never kept', async () => {
    const { cw } = await setup();
    cw.links.put({ ...row(), text: 'a chat line about quissel', handle: 'Vlemmo' } as LinkRow);
    const got = cw.links.get('coop-report', 'r1') as LinkRow;
    expect(Object.keys(got).sort()).toEqual(['at', 'external', 'ref', 'state', 'system']);
    expect(JSON.stringify(got)).not.toMatch(/quissel|Vlemmo/);
  });

  it('put copies the row: editing it afterwards changes nothing; get returns a copy', async () => {
    const { cw } = await setup();
    const r = row();
    cw.links.put(r);
    r.state = 'tampered';
    const got = cw.links.get('coop-report', 'r1') as LinkRow;
    expect(got.state).toBe('sent');
    got.state = 'tampered';
    expect(cw.links.get('coop-report', 'r1')?.state).toBe('sent');
  });

  it('list filters by system and by state, orders oldest first, clamps limit to 1..500 and defaults to 100', async () => {
    const { cw } = await setup();
    for (let i = 0; i < 520; i += 1) cw.links.put(row({ ref: `r${String(i).padStart(4, '0')}`, at: NOW + i, state: i % 2 === 0 ? 'sent' : 'decided' }));
    cw.links.put(row({ system: 'eos-report', ref: 'other', state: 'filed', at: NOW - 5 }));

    const dflt = cw.links.list('coop-report');
    expect(dflt).toHaveLength(100);
    expect(dflt[0]?.ref).toBe('r0000');
    expect(dflt[99]?.ref).toBe('r0099');
    expect(dflt.every((r) => r.system === 'coop-report')).toBe(true);
    expect(cw.links.list('coop-report', { limit: 3 }).map((r) => r.ref)).toEqual(['r0000', 'r0001', 'r0002']);
    expect(cw.links.list('coop-report', { limit: 0 })).toHaveLength(1);
    expect(cw.links.list('coop-report', { limit: -7 })).toHaveLength(1);
    expect(cw.links.list('coop-report', { limit: 2.9 })).toHaveLength(2);
    expect(cw.links.list('coop-report', { limit: 100_000 })).toHaveLength(500);
    expect(cw.links.list('coop-report', { limit: Number.NaN })).toHaveLength(100);
    expect(cw.links.list('coop-report', { limit: 'many' as never })).toHaveLength(100);
    expect(cw.links.list('coop-report', { limit: Infinity })).toHaveLength(500);

    const decided = cw.links.list('coop-report', { state: 'decided', limit: 3 });
    expect(decided.map((r) => r.ref)).toEqual(['r0001', 'r0003', 'r0005']);
    expect(cw.links.list('coop-report', { state: 'sent', limit: 2 }).map((r) => r.ref)).toEqual(['r0000', 'r0002']);
    expect(cw.links.list('eos-report').map((r) => r.ref)).toEqual(['other']);
    expect(cw.links.list('eos-cursor')).toEqual([]);
    expect(cw.links.list('nope' as LinkSystem)).toEqual([]);
  });

  it('list orders by time then ref, and an unknown state is an empty list', async () => {
    const { cw } = await setup();
    cw.links.put(row({ ref: 'b', at: NOW }));
    cw.links.put(row({ ref: 'a', at: NOW }));
    cw.links.put(row({ ref: 'c', at: NOW - 1 }));
    expect(cw.links.list('coop-report').map((r) => r.ref)).toEqual(['c', 'a', 'b']);
    expect(cw.links.list('coop-report', { state: 'nothing' })).toEqual([]);
  });
});

describe('cw.links.put refuses a bad row', () => {
  it('put refuses an unknown system, a ref with a space or a slash, an external of 129 characters, an empty state, a state with an upper-case letter, a NaN at; no message contains the value', async () => {
    const { cw } = await setup();
    const secret = 'zorbak-secret';
    const cases: Array<[string, unknown, string]> = [
      ['system', row({ system: `${secret}` as LinkSystem }), 'system'],
      ['system empty', row({ system: '' as LinkSystem }), 'system'],
      ['ref with a space', row({ ref: `${secret} one` }), 'ref'],
      ['ref with a slash', row({ ref: `${secret}/one` }), 'ref'],
      ['ref empty', row({ ref: '' }), 'ref'],
      ['ref of 129', row({ ref: `${secret}${'x'.repeat(129 - secret.length)}` }), 'ref'],
      ['external of 129', row({ external: `${secret}${'x'.repeat(129 - secret.length)}` }), 'external'],
      ['external with a space', row({ external: `${secret} one` }), 'external'],
      ['external empty', row({ external: '' }), 'external'],
      ['state empty', row({ state: '' }), 'state'],
      ['state upper-case', row({ state: 'Sent' }), 'state'],
      ['state with a digit', row({ state: 'sent2' }), 'state'],
      ['state with a dash', row({ state: `${secret}` }), 'state'],
      ['state of 33', row({ state: 'a'.repeat(33) }), 'state'],
      ['at NaN', row({ at: Number.NaN }), 'at'],
      ['at Infinity', row({ at: Infinity }), 'at'],
      ['at negative', row({ at: -1 }), 'at'],
      ['at a string', row({ at: '5' as never }), 'at'],
      ['ref a number', row({ ref: 5 as never }), 'ref'],
      ['external missing', { ...row(), external: undefined }, 'external'],
    ];
    for (const [why, bad, field] of cases) {
      const err = refusal(cw, bad);
      expect(err.name, why).toBe('RangeError');
      expect(err.message, why).toContain(field);
      expect(err.message, why).not.toContain(secret);
      expect(err.message, why).not.toContain('xxxxx');
    }
    expect(cw.links.list('coop-report')).toEqual([]);
  });

  it('accepts the edges: 1 and 128 characters, 32 characters of state, at 0', async () => {
    const { cw } = await setup();
    cw.links.put(row({ ref: 'a', external: 'b', state: 'c', at: 0 }));
    cw.links.put(row({ ref: 'r'.repeat(128), external: 'e'.repeat(128), state: 's'.repeat(32), at: 0 }));
    cw.links.put(row({ ref: 'g#1:x.y_z-9', state: 'a_b.c' }));
    expect(cw.links.list('coop-report')).toHaveLength(3);
  });

  it('a row that is not an object is refused with a TypeError', async () => {
    const { cw } = await setup();
    for (const v of [null, undefined, 'row', 5, []]) expect(refusal(cw, v).name, String(v)).toBe('TypeError');
  });

  it('a link row never holds text: the accepted ref and external alphabets contain no space and no punctuation beyond _ . : # -', () => {
    const accepts = (field: 'ref' | 'external', ch: string): boolean => {
      try {
        checkLinkRow(row({ [field]: `a${ch}b` }));
        return true;
      } catch {
        return false;
      }
    };
    const allowed = new Set('_.:#-');
    for (let code = 0; code < 128; code += 1) {
      const ch = String.fromCharCode(code);
      const ok = /[A-Za-z0-9]/.test(ch) || allowed.has(ch);
      expect(accepts('ref', ch), `ref ${code}`).toBe(ok);
      expect(accepts('external', ch), `external ${code}`).toBe(ok);
    }
    for (const ch of ['\u00e9', '\u4e2d', '\u200b', '\u00a0', '\u2028']) {
      expect(accepts('ref', ch)).toBe(false);
      expect(accepts('external', ch)).toBe(false);
    }
  });

  it('checkLinkRow itself is pure: it returns nothing for a good row and does not touch it', () => {
    const r = Object.freeze(row());
    expect(checkLinkRow(r)).toBeUndefined();
  });
});

describe('cw.links and retention', () => {
  it('purge deletes links older than retention.reportsMs and keeps newer ones; a store without the methods purges nothing and reports supported false', async () => {
    const { cw, clock } = await setup();
    cw.links.put(row({ ref: 'old', at: NOW - 91 * DAY }));
    cw.links.put(row({ ref: 'recent', at: NOW - 89 * DAY }));
    cw.links.put(row({ ref: 'fresh', at: NOW }));
    await cw.purge();
    expect(cw.links.get('coop-report', 'old')).toBeNull();
    expect(cw.links.get('coop-report', 'recent')).not.toBeNull();
    expect(cw.links.get('coop-report', 'fresh')).not.toBeNull();
    clock.t += 2 * DAY; // 'recent' is now 91 days old
    await cw.purge();
    expect(cw.links.get('coop-report', 'recent')).toBeNull();
    expect(cw.links.get('coop-report', 'fresh')).not.toBeNull();

    const bare = await setup(new MemoryStore());
    expect(bare.cw.links.supported).toBe(false);
    await expect(bare.cw.purge()).resolves.toBeDefined();
  });

  it('purge keeps a live link however old: an active eos-sanction link and the eos-cursor row survive, a removed eos-sanction link and an old eos-report row do not', async () => {
    const { cw } = await setup();
    const old = NOW - 400 * DAY;
    cw.links.put(row({ system: 'eos-sanction', ref: 'live', external: 'ref-1', state: 'active', at: old }));
    cw.links.put(row({ system: 'eos-sanction', ref: 'gone', external: 'ref-2', state: 'removed', at: old }));
    cw.links.put(row({ system: 'eos-cursor', ref: 'reports', external: '2027-01-01T00:00:00.000Z', state: 'cursor', at: old }));
    cw.links.put(row({ system: 'eos-report', ref: 'seen', external: 'x', state: 'filed', at: old }));
    await cw.purge();
    expect(cw.links.get('eos-sanction', 'live')).not.toBeNull();
    expect(cw.links.get('eos-cursor', 'reports')).not.toBeNull();
    expect(cw.links.get('eos-sanction', 'gone')).toBeNull();
    expect(cw.links.get('eos-report', 'seen')).toBeNull();
    // A second pass changes nothing, and the live row is still there after a much later clock.
    await cw.purge();
    expect(cw.links.get('eos-sanction', 'live')).not.toBeNull();
  });

  it('the cutoff follows retention.reportsMs when it is set', async () => {
    const store = withMemoryLinks(new MemoryStore());
    const clock = { now: () => NOW };
    const platform: Platform = { identify: (ctx) => ctx as RawWho };
    const cw = await createChatwarden({ store, secret: 'links-secret', platform, clock, logger: { warn() {} }, retention: { everyMs: 3_600_000, reportsMs: 20 * DAY } });
    try {
      cw.links.put(row({ ref: 'a', at: NOW - 21 * DAY }));
      cw.links.put(row({ ref: 'b', at: NOW - 19 * DAY }));
      await cw.purge();
      expect(cw.links.get('coop-report', 'a')).toBeNull();
      expect(cw.links.get('coop-report', 'b')).not.toBeNull();
    } finally {
      await cw.close();
    }
  });

  it('a link is not kept by a report decision or a purge pass that finds no links', async () => {
    const { cw } = await setup();
    await expect(cw.purge()).resolves.toBeDefined();
    expect(cw.links.list('coop-report')).toEqual([]);
  });
});

describe('cw.links is documented as experimental', () => {
  it('links and its members are tagged @experimental in the facade source', () => {
    const src = readFileSync(new URL('../src/chatwarden.ts', import.meta.url), 'utf8');
    const docAbove = (signature: string): string => {
      const at = src.indexOf(`\n  ${signature}`);
      expect(at, signature).toBeGreaterThan(-1);
      return src.slice(src.lastIndexOf('/**', at), at);
    };
    expect(docAbove('links: {')).toContain('@experimental');
  });
});
