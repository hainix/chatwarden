import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import { DEFAULT_SEVERE_RULES } from '../src/index.js';
import type { Platform, RawWho } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

const NOW = 1_800_000_000_000;

async function setup() {
  const clock = { now: () => NOW };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const store = new MemoryStore();
  const cw = await createChatwarden({ store, secret: 'feed-secret', platform, clock, logger: { warn: () => undefined }, retention: false });
  return { cw, store };
}

describe('DEFAULT_SEVERE_RULES', () => {
  it('is Community Rule 1, frozen, and is what an unset profile.severeRules means', async () => {
    expect([...DEFAULT_SEVERE_RULES]).toEqual([1]);
    expect(Object.isFrozen(DEFAULT_SEVERE_RULES)).toBe(true);
  });
});

describe('cw.people (canonical subject and aliases, for staff tools)', () => {
  it('an unknown id is its own canonical person and only alias', async () => {
    const { cw } = await setup();
    expect(cw.people.canonical('s_unknown')).toBe('s_unknown');
    expect(cw.people.aliases('s_unknown')).toEqual(['s_unknown']);
  });

  it('follows a merge: the alias resolves to the survivor and both list as aliases', async () => {
    const { cw } = await setup();
    cw.rooms.seat('r', 'a', { clientKey: 'k1' }, 'A');
    cw.rooms.seat('r', 'b', { clientKey: 'k2' }, 'B');
    const a = cw.rooms.subjectAt('r', 'a');
    const b = cw.rooms.subjectAt('r', 'b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    cw.rooms.seat('r', 'c', { clientKey: 'k1', accountId: 'acc' }, 'C');
    cw.rooms.seat('r', 'd', { clientKey: 'k2', accountId: 'acc' }, 'D');
    await cw.flush();
    const root = cw.people.canonical(a as string);
    expect(cw.people.canonical(b as string)).toBe(root);
    expect(cw.people.aliases(root).sort()).toEqual([a as string, b as string].sort());
    expect(cw.people.aliases(b as string).sort()).toEqual([a as string, b as string].sort());
  });
});

describe('cw.discordThreads (the thread map, over the store)', () => {
  it('get is null until put, put replaces, and rows are copies', async () => {
    const { cw, store } = await setup();
    expect(cw.discordThreads.get('s_x')).toBeNull();
    cw.discordThreads.put({ subject: 's_x', threadId: '1', label: 'Case AAAAA', createdAt: NOW });
    expect(cw.discordThreads.get('s_x')).toEqual({ subject: 's_x', threadId: '1', label: 'Case AAAAA', createdAt: NOW });
    cw.discordThreads.put({ subject: 's_x', threadId: '2', label: 'Case AAAAA', createdAt: NOW });
    expect(store.getDiscordThread('s_x')?.threadId).toBe('2');
  });

  it('rows are copies: changing a returned row, or the row that was put, changes nothing stored', async () => {
    const { cw } = await setup();
    const given = { subject: 's_c', threadId: '1', label: 'Case AAAAA', createdAt: NOW };
    cw.discordThreads.put(given);
    given.threadId = 'mutated-after-put';
    const read = cw.discordThreads.get('s_c');
    expect(read?.threadId).toBe('1');
    if (read !== null) read.threadId = 'mutated-after-get';
    expect(cw.discordThreads.get('s_c')?.threadId).toBe('1');
  });

  it('a failing store throws its own error (the feed fences it)', async () => {
    const { cw, store } = await setup();
    store.getDiscordThread = () => {
      throw new RangeError('db');
    };
    expect(() => cw.discordThreads.get('s_x')).toThrow(RangeError);
  });
});
