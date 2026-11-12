import { describe, expect, it } from 'vitest';
import type { SignalRow, SignalSourceRow, Store } from '@chatwarden/core';

// The contract of signal rows (flood control and signals, design 5.8): `insertSignal`, `listSignalSources` and `purgeSignals`, the optional
// methods that keep what a game records about a player. One suite, run against every Store. The unique tuple (kind, subject, sourceKey,
// capBucket) is the per-source cap: of two inserts of the same tuple exactly one writes. SqliteStore is the reference.

interface WithSignals {
  insertSignal(row: SignalRow): boolean;
  listSignalSources(subjects: readonly string[], since: number): SignalSourceRow[];
  purgeSignals(before: number): number;
}

const signals = (s: Store): WithSignals => {
  if (s.insertSignal === undefined || s.listSignalSources === undefined || s.purgeSignals === undefined) {
    throw new Error('this store has no signal methods');
  }
  return s as unknown as WithSignals;
};

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

let n = 0;
const row = (over: Partial<SignalRow> = {}): SignalRow => {
  n += 1;
  return {
    id: `sig-${n}`,
    kind: 'muted_by_player',
    subject: 's_target',
    sourceKey: 'b:s_from_1',
    bySubject: 's_from_1',
    roomId: null,
    at: NOW,
    weight: 1,
    capBucket: Math.floor(NOW / DAY),
    ...over,
  };
};

const byKey = (rows: SignalSourceRow[]): SignalSourceRow[] =>
  [...rows].sort((a, b) => `${a.subject}|${a.kind}|${a.sourceKey}`.localeCompare(`${b.subject}|${b.kind}|${b.sourceKey}`));

export function signalsContract(name: string, make: () => Store): void {
  describe(`signals contract: ${name}`, () => {
    it('has the three methods', () => {
      const s = make();
      expect(typeof s.insertSignal).toBe('function');
      expect(typeof s.listSignalSources).toBe('function');
      expect(typeof s.purgeSignals).toBe('function');
    });

    describe('insertSignal', () => {
      it('returns true, then false for the same (kind, subject, sourceKey, capBucket)', () => {
        const s = signals(make());
        expect(s.insertSignal(row())).toBe(true);
        expect(s.insertSignal(row())).toBe(false);
        expect(s.insertSignal(row({ at: NOW + 1000, weight: 5 }))).toBe(false);
      });

      it('a different bucket, kind, subject or source inserts', () => {
        const s = signals(make());
        expect(s.insertSignal(row())).toBe(true);
        expect(s.insertSignal(row({ capBucket: Math.floor(NOW / DAY) + 1 }))).toBe(true);
        expect(s.insertSignal(row({ kind: 'blocked_by_player' }))).toBe(true);
        expect(s.insertSignal(row({ subject: 's_other' }))).toBe(true);
        expect(s.insertSignal(row({ sourceKey: 'b:s_from_2', bySubject: 's_from_2' }))).toBe(true);
        expect(s.insertSignal(row({ sourceKey: 'r:room-1', bySubject: null, roomId: 'room-1' }))).toBe(true);
        expect(s.insertSignal(row({ sourceKey: 'd:2027-01-15', bySubject: null }))).toBe(true);
      });

      it('a refused insert writes nothing: the first row stays as it was', () => {
        const s = signals(make());
        s.insertSignal(row({ weight: 2, at: NOW }));
        s.insertSignal(row({ weight: 9, at: NOW + 5000 }));
        const [only] = s.listSignalSources(['s_target'], 0);
        expect(only).toMatchObject({ weight: 2, firstAt: NOW, lastAt: NOW });
      });

      it('a duplicate id with another tuple writes nothing and returns false', () => {
        const s = signals(make());
        const first = row();
        expect(s.insertSignal(first)).toBe(true);
        expect(s.insertSignal(row({ id: first.id, kind: 'blocked_by_player' }))).toBe(false);
        expect(s.listSignalSources(['s_target'], 0)).toHaveLength(1);
      });

      it('keeps a fractional weight, zero, and a null roomId and bySubject', () => {
        const s = signals(make());
        expect(s.insertSignal(row({ weight: 0.5, sourceKey: 'd:2027-01-15', bySubject: null, roomId: null }))).toBe(true);
        expect(s.insertSignal(row({ weight: 0, sourceKey: 'd:2027-01-16', bySubject: null }))).toBe(true);
        const out = byKey(s.listSignalSources(['s_target'], 0));
        expect(out.map((r) => [r.sourceKey, r.weight, r.bySubject])).toEqual([
          ['d:2027-01-15', 0.5, null],
          ['d:2027-01-16', 0, null],
        ]);
      });

      it('an undone transaction undoes the insert (the cap slot is free again)', () => {
        const s = make();
        const w = signals(s);
        expect(() =>
          s.transaction(() => {
            expect(w.insertSignal(row())).toBe(true);
            throw new Error('undo');
          }),
        ).toThrow('undo');
        expect(w.listSignalSources(['s_target'], 0)).toEqual([]);
        expect(w.insertSignal(row())).toBe(true);
      });
    });

    describe('listSignalSources', () => {
      it('one row per (subject, kind, sourceKey) with the highest weight, MIN(at) and MAX(at)', () => {
        const s = signals(make());
        const b0 = Math.floor(NOW / DAY);
        s.insertSignal(row({ at: NOW, weight: 1, capBucket: b0 }));
        s.insertSignal(row({ at: NOW + DAY, weight: 3, capBucket: b0 + 1 }));
        s.insertSignal(row({ at: NOW + 2 * DAY, weight: 2, capBucket: b0 + 2 }));
        s.insertSignal(row({ sourceKey: 'b:s_from_2', bySubject: 's_from_2', at: NOW + 500, weight: 1 }));
        s.insertSignal(row({ kind: 'blocked_by_player', at: NOW + 700, weight: 1 }));
        const out = byKey(s.listSignalSources(['s_target'], 0));
        expect(out).toEqual([
          { subject: 's_target', kind: 'blocked_by_player', sourceKey: 'b:s_from_1', bySubject: 's_from_1', weight: 1, firstAt: NOW + 700, lastAt: NOW + 700 },
          { subject: 's_target', kind: 'muted_by_player', sourceKey: 'b:s_from_1', bySubject: 's_from_1', weight: 3, firstAt: NOW, lastAt: NOW + 2 * DAY },
          { subject: 's_target', kind: 'muted_by_player', sourceKey: 'b:s_from_2', bySubject: 's_from_2', weight: 1, firstAt: NOW + 500, lastAt: NOW + 500 },
        ]);
      });

      it('only rows at or after since count, and since is inclusive', () => {
        const s = signals(make());
        const b0 = Math.floor(NOW / DAY);
        s.insertSignal(row({ at: NOW - 1, weight: 9, capBucket: b0 - 1 }));
        s.insertSignal(row({ at: NOW, weight: 1, capBucket: b0 }));
        s.insertSignal(row({ at: NOW + 1, weight: 2, capBucket: b0 + 1 }));
        expect(s.listSignalSources(['s_target'], NOW)).toMatchObject([{ weight: 2, firstAt: NOW, lastAt: NOW + 1 }]);
        expect(s.listSignalSources(['s_target'], NOW + 1)).toMatchObject([{ weight: 2, firstAt: NOW + 1, lastAt: NOW + 1 }]);
        expect(s.listSignalSources(['s_target'], NOW + 2)).toEqual([]);
        // The row before since neither adds its weight nor its time.
        expect(s.listSignalSources(['s_target'], NOW - 1)[0]).toMatchObject({ weight: 9, firstAt: NOW - 1 });
      });

      it('several subjects (a person\'s aliases) in one call; other subjects are not returned', () => {
        const s = signals(make());
        s.insertSignal(row({ subject: 's_a' }));
        s.insertSignal(row({ subject: 's_b', sourceKey: 'b:s_from_2', bySubject: 's_from_2' }));
        s.insertSignal(row({ subject: 's_c' }));
        const out = byKey(s.listSignalSources(['s_a', 's_b'], 0));
        expect(out.map((r) => r.subject)).toEqual(['s_a', 's_b']);
        expect(s.listSignalSources(['s_b'], 0).map((r) => r.subject)).toEqual(['s_b']);
      });

      it('the same source for two aliases stays two rows (counting folds them, not the store)', () => {
        const s = signals(make());
        s.insertSignal(row({ subject: 's_a' }));
        s.insertSignal(row({ subject: 's_b' }));
        expect(s.listSignalSources(['s_a', 's_b'], 0)).toHaveLength(2);
      });

      it('an empty list, an unknown subject and a store with no rows give []', () => {
        const s = signals(make());
        expect(s.listSignalSources([], 0)).toEqual([]);
        expect(s.listSignalSources(['s_nobody'], 0)).toEqual([]);
        s.insertSignal(row());
        expect(s.listSignalSources([], 0)).toEqual([]);
        expect(s.listSignalSources(['s_nobody'], 0)).toEqual([]);
      });

      it('a duplicate in the subject list changes nothing', () => {
        const s = signals(make());
        s.insertSignal(row());
        expect(s.listSignalSources(['s_target', 's_target'], 0)).toHaveLength(1);
      });

      it('the grouped result is bounded by distinct sources, not by row volume', () => {
        const s = signals(make());
        const b0 = Math.floor(NOW / DAY);
        for (let day = 0; day < 90; day += 1) {
          for (const from of ['s_from_1', 's_from_2', 's_from_3']) {
            s.insertSignal(row({ sourceKey: `b:${from}`, bySubject: from, at: NOW + day * DAY, capBucket: b0 + day, weight: 1 + (day % 3) }));
          }
        }
        const out = s.listSignalSources(['s_target'], 0);
        expect(out).toHaveLength(3);
        for (const r of out) expect(r).toMatchObject({ weight: 3, firstAt: NOW, lastAt: NOW + 89 * DAY });
      });

      it('returns copies: changing a result changes nothing stored', () => {
        const s = signals(make());
        s.insertSignal(row());
        const first = s.listSignalSources(['s_target'], 0);
        first[0]!.weight = 99;
        first.length = 0;
        expect(s.listSignalSources(['s_target'], 0)).toMatchObject([{ weight: 1 }]);
      });

      it('subject ids that look like SQL or prototype names are plain values', () => {
        const s = signals(make());
        for (const id of ["s_'; DROP TABLE kit_signals;--", '__proto__', 'constructor']) {
          expect(s.insertSignal(row({ subject: id, sourceKey: 'd:2027-01-15', bySubject: null }))).toBe(true);
          expect(s.listSignalSources([id], 0)).toHaveLength(1);
        }
      });
    });

    describe('purgeSignals', () => {
      it('deletes at < before, keeps at == before, and returns the count', () => {
        const s = signals(make());
        const b0 = Math.floor(NOW / DAY);
        s.insertSignal(row({ at: NOW - 2, capBucket: b0 - 2, sourceKey: 'd:a', bySubject: null }));
        s.insertSignal(row({ at: NOW - 1, capBucket: b0 - 1, sourceKey: 'd:b', bySubject: null }));
        s.insertSignal(row({ at: NOW, capBucket: b0, sourceKey: 'd:c', bySubject: null }));
        s.insertSignal(row({ at: NOW + 1, capBucket: b0 + 1, sourceKey: 'd:d', bySubject: null }));
        expect(s.purgeSignals(NOW)).toBe(2);
        expect(byKey(s.listSignalSources(['s_target'], 0)).map((r) => r.sourceKey)).toEqual(['d:c', 'd:d']);
        expect(s.purgeSignals(NOW)).toBe(0);
        expect(s.purgeSignals(NOW + 1)).toBe(1);
      });

      it('an empty store purges 0, and a purge frees the cap slot', () => {
        const s = signals(make());
        expect(s.purgeSignals(NOW)).toBe(0);
        s.insertSignal(row({ at: NOW - 10 }));
        expect(s.insertSignal(row({ at: NOW - 10 }))).toBe(false);
        expect(s.purgeSignals(NOW)).toBe(1);
        expect(s.insertSignal(row({ at: NOW - 10 }))).toBe(true);
      });

      it('deletes flood_triggered rows by the same rule as any kind', () => {
        const s = signals(make());
        s.insertSignal(row({ kind: 'flood_triggered', at: NOW - 5, sourceKey: 'r:room-1', bySubject: null, roomId: 'room-1' }));
        s.insertSignal(row({ kind: 'muted_by_player', at: NOW - 5 }));
        expect(s.purgeSignals(NOW)).toBe(2);
      });

      it('an undone transaction brings the purged rows back', () => {
        const store = make();
        const s = signals(store);
        s.insertSignal(row({ at: NOW - 5 }));
        expect(() =>
          store.transaction(() => {
            expect(s.purgeSignals(NOW)).toBe(1);
            throw new Error('undo');
          }),
        ).toThrow('undo');
        expect(s.listSignalSources(['s_target'], 0)).toHaveLength(1);
      });
    });
  });
}
