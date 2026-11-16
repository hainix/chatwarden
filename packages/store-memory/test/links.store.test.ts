import { describe, expect, it } from 'vitest';
import type { LinkRow } from '@chatwarden/core';
import { MemoryStore, createMemoryStore, withMemoryAppeals, withMemoryLinks, withMemoryNames } from '../src/index.js';

// What is specific to MemoryStore in the link methods: they are opt-in (a bundle that never needs a Coop or EOS adapter does not carry them),
// the state lives per store, and rows go in and come out as copies. The behaviour it shares with SqliteStore is in the shared contract suite
// (test/contract/links.contract.ts, run by contract.test.ts).

const NOW = 1_800_000_000_000;
const METHODS = ['getLink', 'putLink', 'listLinks', 'purgeLinks'] as const;
const row = (over: Partial<LinkRow> = {}): LinkRow => ({ system: 'coop-report', ref: 'r1', external: 'job-zorbak-1', state: 'sent', at: NOW, ...over });

describe('withMemoryLinks: the link methods are opt-in', () => {
  it('a plain MemoryStore, and createMemoryStore(), have none of the four methods', () => {
    for (const s of [new MemoryStore(), createMemoryStore()] as unknown as Array<Record<string, unknown>>) for (const m of METHODS) expect(s[m], m).toBeUndefined();
  });

  it('returns the same store, now with the methods, that work', () => {
    const plain = new MemoryStore();
    const s = withMemoryLinks(plain);
    expect(s).toBe(plain);
    for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    s.putLink(row());
    expect(s.getLink('coop-report', 'r1')).toEqual(row());
  });

  it('does not give the appeal or blocked-name methods, and those wrappers do not give the link ones', () => {
    const s = withMemoryLinks(new MemoryStore()) as unknown as Record<string, unknown>;
    expect(s.insertAppeal).toBeUndefined();
    expect(s.insertBlockedName).toBeUndefined();
    const o = withMemoryNames(withMemoryAppeals(new MemoryStore())) as unknown as Record<string, unknown>;
    expect(o.putLink).toBeUndefined();
  });

  it('the methods are not enumerable, so they do not show as own state', () => {
    const s = withMemoryLinks(new MemoryStore());
    expect(Object.keys(s)).not.toContain('putLink');
  });

  it('is idempotent: a second call changes nothing, and rows already stored stay', () => {
    const s = withMemoryLinks(new MemoryStore());
    s.putLink(row());
    expect(withMemoryLinks(s)).toBe(s);
    expect(s.getLink('coop-report', 'r1')).toEqual(row());
  });

  it('keeps a method the store already has (a subclass override)', () => {
    class Custom extends MemoryStore {
      getLink(): LinkRow | null {
        return row({ ref: 'custom' });
      }
    }
    const s = withMemoryLinks(new Custom());
    expect(s.getLink('coop-report', 'anything')?.ref).toBe('custom');
    expect(typeof s.putLink).toBe('function');
  });

  it('keeps the state apart per store', () => {
    const a = withMemoryLinks(new MemoryStore());
    const b = withMemoryLinks(new MemoryStore());
    a.putLink(row());
    expect(b.getLink('coop-report', 'r1')).toBeNull();
    expect(b.listLinks('coop-report', { limit: 5 })).toEqual([]);
  });

  it('can be applied after the other optional wrappers, in any order', () => {
    const s = withMemoryNames(withMemoryLinks(withMemoryAppeals(new MemoryStore())));
    for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    expect(typeof s.insertBlockedName).toBe('function');
  });
});

describe('MemoryStore links', () => {
  it('stores a copy: editing the row after the put changes nothing', () => {
    const s = withMemoryLinks(new MemoryStore());
    const r = row();
    s.putLink(r);
    r.state = 'tampered';
    expect(s.getLink('coop-report', 'r1')?.state).toBe('sent');
  });

  it('a link write is not a queue change: it does not move the change token', () => {
    const s = withMemoryLinks(new MemoryStore());
    const before = s.changeToken();
    s.putLink(row());
    s.purgeLinks(NOW + 1);
    expect(s.changeToken()).toBe(before);
  });
});
