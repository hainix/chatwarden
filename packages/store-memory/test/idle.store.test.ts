import { describe, expect, it } from 'vitest';
import { IDLE_SEEDERS } from '../../../test/contract/idle.contract.js';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '../src/index.js';

// The identity age-out in the in-memory store (0.2.2, W6). The shared contract (test/contract/idle.contract.ts) runs from contract.test.ts. This file adds what only
// this store has to get right: the opt-in wrappers keep state of their own, and a record in any of them must keep the person whatever order they were added in; a
// bare store has none of them and must still work.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const BEFORE = NOW - 400 * DAY;

const ALL = (): MemoryStore => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));
const REVERSED = (): MemoryStore => withMemoryAi(withMemorySignals(withMemoryAppeals(withMemoryNames(withMemoryLinks(new MemoryStore())))));
const dump = (s: unknown): string => JSON.stringify(s, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v.values()] : v));

async function idle(s: MemoryStore, id: string): Promise<void> {
  await s.saveSubject({ id, createdAt: BEFORE - 20 * DAY, mergedInto: null });
  for (const [kind, value] of [['account', `acct-${id}`], ['key', `key-${id}`], ['ip', `ip-${id}`]] as const) {
    await s.saveIdentifier({ subjectId: id, kind, value, firstSeen: BEFORE - 20 * DAY, lastSeen: BEFORE - 10 * DAY });
  }
}

describe.each([
  ['every wrapper', ALL],
  ['the wrappers in the other order', REVERSED],
])('%s', (_name, make) => {
  it.each(Object.entries(IDLE_SEEDERS))('a record in %s keeps the person, and nobody else is touched', async (_column, seed) => {
    const s = make();
    await idle(s, 's_idle');
    await idle(s, 's_free');
    await seed(s, 's_idle');
    expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
    expect((await s.loadSubjects()).subjects.map((x) => x.id)).toEqual(['s_idle']);
  });

  it('a person with no record leaves nothing of themselves anywhere in the store, wrappers included', async () => {
    const s = make();
    await idle(s, 's_gone_id');
    await idle(s, 's_keep');
    s.insertStrike({ id: 'st', at: NOW, subject: 's_keep', roomId: 'R', termId: 't', rawLine: 'zorbak' });
    expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
    const after = dump(s);
    for (const needle of ['s_gone_id', 'acct-s_gone_id', 'key-s_gone_id', 'ip-s_gone_id']) expect(after, needle).not.toContain(needle);
    expect(after).toContain('s_keep');
  });
});

describe('a bare MemoryStore (no wrappers)', () => {
  it('ages out what it has: the tables the wrappers own are simply empty, never an error', async () => {
    const s = new MemoryStore();
    await idle(s, 's_idle');
    await idle(s, 's_strike');
    s.insertStrike({ id: 'st', at: NOW, subject: 's_strike', roomId: 'R', termId: 't', rawLine: 'zorbak' });
    expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
    expect((await s.loadSubjects()).subjects.map((x) => x.id)).toEqual(['s_strike']);
  });

  it('is undone with the transaction that failed, identifier rows and the epoch included', async () => {
    const s = new MemoryStore();
    await idle(s, 's_idle');
    const epoch = s.erasureEpoch();
    expect(() =>
      s.transaction(() => {
        s.purgeIdleSubjects(BEFORE);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.erasureEpoch()).toBe(epoch);
    expect((await s.loadSubjects()).ids).toHaveLength(3);
  });
});
