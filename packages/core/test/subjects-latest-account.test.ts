import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@chatwarden/store-memory';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, SubjectId } from '../src/types.js';

// SubjectIndex.latestAccount: the account (as the game gave it) most recently seen on a person or anyone merged into them. A read: it creates nothing.

const HOUR = 3_600_000;
const who = (clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers => ({ clientKey, accountId, ipHash });

async function setup() {
  const store = createMemoryStore();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (d: number) => void (t += d) };
  const index = new SubjectIndex(store, clock, { logger: { warn() {} } });
  await index.load();
  const resolve = (w: Identifiers): SubjectId => {
    const s = index.resolve(w);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  return { store, clock, index, resolve };
}

describe('SubjectIndex.latestAccount', () => {
  it('is null for a person with no account and for an unknown or odd id', async () => {
    const { index, resolve } = await setup();
    const s = resolve(who('k1'));
    expect(index.latestAccount(s)).toBeNull();
    expect(index.latestAccount('s_unknown')).toBeNull();
    expect(index.latestAccount('')).toBeNull();
    expect(index.latestAccount(5 as never)).toBeNull();
  });

  it('returns the only account seen, as the game gave it (raw, not hashed)', async () => {
    const { index, resolve } = await setup();
    const s = resolve(who('k1', 'Acct-One'));
    expect(index.latestAccount(s)).toBe('Acct-One');
  });

  it('the most recently seen account wins, even minutes apart (inside the store write throttle)', async () => {
    const { index, clock, resolve } = await setup();
    const s = resolve(who('k1', 'acct-a'));
    clock.advance(1_000);
    resolve(who('k1', 'acct-b'));
    expect(index.latestAccount(s)).toBe('acct-b');
    clock.advance(1_000);
    resolve(who('k1', 'acct-a')); // back on the first account
    expect(index.latestAccount(s)).toBe('acct-a');
    clock.advance(3 * HOUR);
    resolve(who('k1', 'acct-b'));
    expect(index.latestAccount(s)).toBe('acct-b');
  });

  it('a tie takes the smaller value', async () => {
    const { index, resolve } = await setup();
    const s = resolve(who('k1', 'acct-b'));
    resolve(who('k1', 'acct-a'));
    expect(index.latestAccount(s)).toBe('acct-a');
    const t = resolve(who('k2', 'acct-z'));
    resolve(who('k2', 'acct-y'));
    expect(index.latestAccount(t)).toBe('acct-y');
  });

  it('merged aliases count: the newest account on any of them, asked of the root or of any alias', async () => {
    const { index, clock, resolve } = await setup();
    const a = resolve(who('k1', 'acct-a'));
    clock.advance(10_000);
    const b = resolve(who('k2', 'acct-b'));
    clock.advance(10_000);
    resolve(who('k1', null, 'ip-1'));
    resolve(who('k2', null, 'ip-1'));
    expect(index.canonical(a)).not.toBe(index.canonical(b));
    // join them through a shared key and account
    resolve(who('k1', 'acct-b'));
    const root = index.canonical(a);
    expect(index.canonical(b)).toBe(root);
    for (const id of [a, b, root]) expect(index.latestAccount(id)).toBe('acct-b');
    clock.advance(10_000);
    resolve(who('k2', 'acct-a'));
    for (const id of [a, b, root]) expect(index.latestAccount(id)).toBe('acct-a');
  });

  it('survives a reload from the store (uses the stored last seen)', async () => {
    const { index, clock, store, resolve } = await setup();
    const s = resolve(who('k1', 'acct-a'));
    clock.advance(2 * HOUR);
    resolve(who('k1', 'acct-b'));
    clock.advance(2 * HOUR);
    resolve(who('k1', 'acct-a'));
    await index.flush();
    const again = new SubjectIndex(store, clock, { logger: { warn() {} } });
    await again.load();
    expect(again.latestAccount(s)).toBe('acct-a');
  });

  it('only reads: it creates no subject, records nothing and queues no store write', async () => {
    const { index, store, resolve } = await setup();
    const s = resolve(who('k1', 'acct-a'));
    await index.flush();
    const before = JSON.stringify(await store.loadSubjects());
    const knownBefore = index.lookup(who('k-never-seen', 'acct-never-seen'));
    expect(index.latestAccount(s)).toBe('acct-a');
    expect(index.latestAccount('s_nobody')).toBeNull();
    await index.flush();
    expect(JSON.stringify(await store.loadSubjects())).toBe(before);
    expect(index.lookup(who('k-never-seen', 'acct-never-seen'))).toBe(knownBefore);
    expect(knownBefore).toBeNull();
  });

  it('an erased person has no account to give', async () => {
    const { index, resolve } = await setup();
    const s = resolve(who('k1', 'acct-a'));
    index.forget(new Set([s]));
    expect(index.latestAccount(s)).toBeNull();
  });
});
