import { describe, expect, it } from 'vitest';
import type { ErasePlan, PaceStateRow, Store } from '@chatwarden/core';

// The contract of the shared pacer's state (spec 3.7): one row per (room, person), read and merged atomically by `paceUpdate`. One suite, run against every Store that has the methods.

const T = 1_800_000_000_000;
const row = (over: Partial<PaceStateRow> = {}): PaceStateRow => ({
  roomId: 'room-1',
  who: 's_aaaaaaaaaaaaaaaaaaaaaa',
  lastAt: T,
  stamps: [T - 3000, T - 2000, T],
  recent: [{ h: '0123456789abcdef', at: T - 3000 }, { h: 'fedcba9876543210', at: T }],
  floodSignalAt: null,
  touchedAt: T,
  ...over,
});
/** The same row after an update: the function gets the stored row and returns the next. */
const merge = (prev: PaceStateRow | null, over: Partial<PaceStateRow> = {}): PaceStateRow => ({ ...(prev ?? row()), ...over });

const plan = (over: Partial<ErasePlan> = {}): ErasePlan => ({ subjects: ['s_pace_a'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_receipt_pace', at: T, ...over });

export function paceContract(name: string, make: () => Store): void {
  describe(`pace contract: ${name}`, () => {
    it('has the four methods', () => {
      const s = make();
      for (const m of ['paceLoad', 'paceUpdate', 'paceDropRoom', 'paceSweep'] as const) expect(typeof s[m], m).toBe('function');
    });

    it('load of nothing is null', () => {
      const s = make();
      expect(s.paceLoad?.('room-1', 'who-1')).toBeNull();
    });

    it('update creates the row (fn sees null), then merges (fn sees the stored row exactly once each time); load returns what was stored', () => {
      const s = make();
      const seen: Array<PaceStateRow | null> = [];
      const first = s.paceUpdate?.('room-1', 'who-1', (prev) => {
        seen.push(prev);
        return row({ roomId: 'room-1', who: 'who-1', lastAt: T });
      });
      expect(first).toEqual(row({ roomId: 'room-1', who: 'who-1', lastAt: T }));
      expect(seen).toEqual([null]);
      const second = s.paceUpdate?.('room-1', 'who-1', (prev) => {
        seen.push(prev);
        return merge(prev, { lastAt: T + 1000, stamps: [...(prev?.stamps ?? []), T + 1000], touchedAt: T + 1000 });
      });
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual(row({ roomId: 'room-1', who: 'who-1', lastAt: T }));
      expect(second?.stamps).toEqual([T - 3000, T - 2000, T, T + 1000]);
      expect(s.paceLoad?.('room-1', 'who-1')).toEqual(second);
    });

    it('stamps and recent round-trip exactly: order, numbers and digests; floodSignalAt null and a number round-trip', () => {
      const s = make();
      const stamps = [1, 5, 3, 1_800_000_000_123, 0];
      const recent = [{ h: 'aaaaaaaaaaaaaaaa', at: 9 }, { h: '0000000000000000', at: 2 }, { h: 'aaaaaaaaaaaaaaaa', at: 9 }];
      s.paceUpdate?.('r', 'w', () => row({ roomId: 'r', who: 'w', stamps, recent, floodSignalAt: null }));
      expect(s.paceLoad?.('r', 'w')).toMatchObject({ stamps, recent, floodSignalAt: null });
      s.paceUpdate?.('r', 'w', (prev) => merge(prev, { floodSignalAt: T + 7 }));
      expect(s.paceLoad?.('r', 'w')?.floodSignalAt).toBe(T + 7);
      s.paceUpdate?.('r', 'w', (prev) => merge(prev, { floodSignalAt: null, stamps: [], recent: [] }));
      expect(s.paceLoad?.('r', 'w')).toMatchObject({ stamps: [], recent: [], floodSignalAt: null });
    });

    it('a throwing fn leaves the row unchanged (and no row for a new key) and rethrows the same error', () => {
      const s = make();
      const boom = new Error('fn failed');
      expect(() =>
        s.paceUpdate?.('r', 'new', () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(s.paceLoad?.('r', 'new')).toBeNull();
      s.paceUpdate?.('r', 'old', () => row({ roomId: 'r', who: 'old' }));
      const before = s.paceLoad?.('r', 'old');
      expect(() =>
        s.paceUpdate?.('r', 'old', (prev) => {
          void merge(prev, { lastAt: 5 });
          throw boom;
        }),
      ).toThrow(boom);
      expect(s.paceLoad?.('r', 'old')).toEqual(before);
    });

    it('a row returned by load is a copy: changing it changes nothing stored; the row fn is given is a copy too', () => {
      const s = make();
      s.paceUpdate?.('r', 'w', () => row({ roomId: 'r', who: 'w' }));
      const loaded = s.paceLoad?.('r', 'w') as PaceStateRow;
      loaded.stamps.push(999);
      loaded.recent.push({ h: 'x', at: 1 });
      expect(s.paceLoad?.('r', 'w')?.stamps).toEqual([T - 3000, T - 2000, T]);
      s.paceUpdate?.('r', 'w', (prev) => {
        prev?.stamps.push(888);
        return merge(prev, { lastAt: T + 1 });
      });
      expect(s.paceLoad?.('r', 'w')?.stamps.includes(888)).toBe(true);
      const returned = s.paceUpdate?.('r', 'w', (prev) => merge(prev, { lastAt: T + 2 })) as PaceStateRow;
      returned.stamps.length = 0;
      expect(s.paceLoad?.('r', 'w')?.stamps.length).toBeGreaterThan(0);
    });

    it('rows are keyed by room and person exactly: another room, another person, another case are other rows', () => {
      const s = make();
      s.paceUpdate?.('room-a', 'who-1', () => row({ roomId: 'room-a', who: 'who-1', lastAt: 1 }));
      s.paceUpdate?.('room-b', 'who-1', () => row({ roomId: 'room-b', who: 'who-1', lastAt: 2 }));
      s.paceUpdate?.('room-a', 'who-2', () => row({ roomId: 'room-a', who: 'who-2', lastAt: 3 }));
      s.paceUpdate?.('ROOM-A', 'who-1', () => row({ roomId: 'ROOM-A', who: 'who-1', lastAt: 4 }));
      s.paceUpdate?.('room-a', 'seat:guest-1', () => row({ roomId: 'room-a', who: 'seat:guest-1', lastAt: 5 }));
      expect([s.paceLoad?.('room-a', 'who-1')?.lastAt, s.paceLoad?.('room-b', 'who-1')?.lastAt, s.paceLoad?.('room-a', 'who-2')?.lastAt, s.paceLoad?.('ROOM-A', 'who-1')?.lastAt, s.paceLoad?.('room-a', 'seat:guest-1')?.lastAt]).toEqual([1, 2, 3, 4, 5]);
      expect(s.paceLoad?.('room-a', 'WHO-1')).toBeNull();
    });

    it('ids of the game\'s own kind (colons, at signs, a NUL, a 128-character id) are plain keys and do not collide', () => {
      const s = make();
      const ids = ['a:b', 'a@b', 'a\u0000b', 'x'.repeat(128), 'a b', 'a.b'];
      ids.forEach((id, i) => s.paceUpdate?.(id, id, () => row({ roomId: id, who: id, lastAt: i })));
      ids.forEach((id, i) => expect(s.paceLoad?.(id, id)?.lastAt, id).toBe(i));
      // a room id that ends where a person id begins is not the same key
      s.paceUpdate?.('ab', 'c', () => row({ roomId: 'ab', who: 'c', lastAt: 100 }));
      s.paceUpdate?.('a', 'bc', () => row({ roomId: 'a', who: 'bc', lastAt: 200 }));
      expect(s.paceLoad?.('ab', 'c')?.lastAt).toBe(100);
      expect(s.paceLoad?.('a', 'bc')?.lastAt).toBe(200);
    });

    it('sweep deletes touchedAt < before, strictly: a row at the edge stays; it returns how many went', () => {
      const s = make();
      for (const [who, touchedAt] of [['old', T - 10], ['edge', T], ['new', T + 10]] as const) s.paceUpdate?.('r', who, () => row({ roomId: 'r', who, touchedAt }));
      expect(s.paceSweep?.(T)).toBe(1);
      expect(s.paceLoad?.('r', 'old')).toBeNull();
      expect(s.paceLoad?.('r', 'edge')).not.toBeNull();
      expect(s.paceSweep?.(T + 1)).toBe(1);
      expect(s.paceSweep?.(T + 1)).toBe(0);
      expect(s.paceLoad?.('r', 'new')).not.toBeNull();
      expect(s.paceSweep?.(0)).toBe(0);
    });

    it('dropRoom deletes one room\'s rows and leaves the others; it returns how many went; an unknown room is 0', () => {
      const s = make();
      for (const [room, who] of [['r1', 'a'], ['r1', 'b'], ['r2', 'a'], ['r10', 'a']] as const) s.paceUpdate?.(room, who, () => row({ roomId: room, who }));
      expect(s.paceDropRoom?.('r1')).toBe(2);
      expect(s.paceLoad?.('r1', 'a')).toBeNull();
      expect(s.paceLoad?.('r2', 'a')).not.toBeNull();
      expect(s.paceLoad?.('r10', 'a')).not.toBeNull();
      expect(s.paceDropRoom?.('r1')).toBe(0);
      expect(s.paceDropRoom?.('none')).toBe(0);
    });

    it('a row is stored with digests only: the dumped store holds the digest and none of the line text the digest stood for', () => {
      const s = make();
      s.paceUpdate?.('r', 'w', () => row({ roomId: 'r', who: 'w', recent: [{ h: 'a1b2c3d4e5f60718', at: T }] }));
      const rows = JSON.stringify(s.paceLoad?.('r', 'w'));
      expect(rows).toContain('a1b2c3d4e5f60718');
      expect(rows).not.toMatch(/"(text|raw|line)"/);
    });

    describe('privacy: a row keyed by a person is exported as a count and erased with the person, in both directions of a merge', () => {
      const seed = async (s: Store): Promise<void> => {
        for (const id of ['s_pace_a', 's_pace_b', 's_pace_other']) await s.saveSubject({ id, createdAt: T, mergedInto: null });
        await s.markMerged('s_pace_b', 's_pace_a');
        for (const [room, who] of [['r1', 's_pace_a'], ['r2', 's_pace_a'], ['r1', 's_pace_b'], ['r1', 's_pace_other'], ['r1', 'seat:guest-1']] as const) s.paceUpdate?.(room, who, () => row({ roomId: room, who }));
      };

      it('exportSubjects counts the rows of the person and every alias (the rooms they are paced in), never the digests', async () => {
        const s = make();
        await seed(s);
        const out = s.exportSubjects(['s_pace_a', 's_pace_b']);
        expect(out.pace).toEqual({ rooms: 3 });
        expect(JSON.stringify(out)).not.toContain('0123456789abcdef');
        expect(s.exportSubjects(['s_pace_other']).pace).toEqual({ rooms: 1 });
        expect(s.exportSubjects(['s_nobody']).pace).toEqual({ rooms: 0 });
      });

      it.each(['none', 'safety'] as const)('eraseSubjects (%s) deletes the rows of the person and the aliases, counts them under pace, and leaves everyone else\'s', async (mode) => {
        const s = make();
        await seed(s);
        const counts = s.eraseSubjects(plan({ mode, subjects: ['s_pace_a'] }));
        expect(counts.removed.pace).toBe(3);
        expect([s.paceLoad?.('r1', 's_pace_a'), s.paceLoad?.('r2', 's_pace_a'), s.paceLoad?.('r1', 's_pace_b')]).toEqual([null, null, null]);
        expect(s.paceLoad?.('r1', 's_pace_other')).not.toBeNull();
        expect(s.paceLoad?.('r1', 'seat:guest-1')).not.toBeNull();
      });

      it('a dry run counts the same and writes nothing', async () => {
        const s = make();
        await seed(s);
        const preview = s.eraseSubjects(plan({ dryRun: true }));
        expect(preview.removed.pace).toBe(3);
        expect(s.paceLoad?.('r1', 's_pace_a')).not.toBeNull();
        expect(s.eraseSubjects(plan()).removed.pace).toBe(3);
      });
    });
  });
}
