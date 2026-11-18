import { describe, expect, it } from 'vitest';
import type { PaceStateRow } from '@chatwarden/core';
import { MemoryStore } from '../src/index.js';

// S3: the in-memory store's pace methods beyond the shared contract: they are part of the plain store (no wrapper), and the state is kept as copies.

const T = 1_800_000_000_000;
const row = (over: Partial<PaceStateRow> = {}): PaceStateRow => ({ roomId: 'r', who: 'w', lastAt: T, stamps: [T], recent: [{ h: '0123456789abcdef', at: T }], floodSignalAt: null, touchedAt: T, ...over });

describe('MemoryStore pace', () => {
  it('has the four methods on the plain store, with no opt-in wrapper', () => {
    const s = new MemoryStore();
    for (const m of ['paceLoad', 'paceUpdate', 'paceDropRoom', 'paceSweep'] as const) expect(typeof s[m], m).toBe('function');
  });

  it('keeps what it was given as a copy: changing the row after the update changes nothing stored', () => {
    const s = new MemoryStore();
    const given = row();
    s.paceUpdate('r', 'w', () => given);
    given.stamps.push(1);
    given.recent[0]!.h = 'changed';
    expect(s.paceLoad('r', 'w')).toEqual(row());
  });

  it('a fn that returns a row for another key stores it under the key that was asked for', () => {
    const s = new MemoryStore();
    s.paceUpdate('r', 'w', () => row({ roomId: 'elsewhere', who: 'someone' }));
    expect(s.paceLoad('r', 'w')).toMatchObject({ roomId: 'r', who: 'w' });
    expect(s.paceLoad('elsewhere', 'someone')).toBeNull();
  });

  it('a nested paceUpdate inside fn sees the stored row (no lock to deadlock on) and the outer result wins for its own key', () => {
    const s = new MemoryStore();
    s.paceUpdate('r', 'w', () => row({ lastAt: 1 }));
    s.paceUpdate('r', 'w', (prev) => {
      s.paceUpdate('r', 'other', () => row({ who: 'other' }));
      return { ...(prev as PaceStateRow), lastAt: 2 };
    });
    expect(s.paceLoad('r', 'w')?.lastAt).toBe(2);
    expect(s.paceLoad('r', 'other')).not.toBeNull();
  });

  it('a transaction that rolls back leaves pace state alone: it is operational state, not part of a decision', () => {
    const s = new MemoryStore();
    s.paceUpdate('r', 'w', () => row());
    expect(() =>
      s.transaction(() => {
        s.paceUpdate('r', 'w', () => row({ lastAt: 5 }));
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(s.paceLoad('r', 'w')?.lastAt).toBe(5);
  });
});
