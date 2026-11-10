import { describe, expect, it } from 'vitest';
import type { Store, StrikeRow } from '@chatwarden/core';

// The contract of the strike methods of the Store. One suite, run against every Store.

const T = 1_800_000_000_000;
const strike = (id: string, at: number, over: Partial<StrikeRow> = {}): StrikeRow => ({
  id,
  at,
  subject: 's_a',
  roomId: 'ROOM1',
  termId: 'term1',
  rawLine: 'a line the subject typed',
  ...over,
});

export function strikesContract(name: string, make: () => Store): void {
  describe(`strikes contract: ${name}`, () => {
    it('insertStrike then loadStrikes round-trips every field', () => {
      const s = make();
      s.insertStrike(strike('k1', T));
      expect(s.loadStrikes(0)).toEqual([strike('k1', T)]);
    });

    it('loadStrikes keeps strikes at or after since, oldest first', () => {
      const s = make();
      s.insertStrike(strike('c', T + 20));
      s.insertStrike(strike('a', T));
      s.insertStrike(strike('b', T + 10));
      s.insertStrike(strike('z', T - 1));
      expect(s.loadStrikes(T).map((r) => r.id)).toEqual(['a', 'b', 'c']);
      expect(s.loadStrikes(T + 11).map((r) => r.id)).toEqual(['c']);
      expect(s.loadStrikes(T + 21)).toEqual([]);
    });

    it('several strikes by one subject are separate rows', () => {
      const s = make();
      s.insertStrike(strike('k1', T));
      s.insertStrike(strike('k2', T + 1));
      expect(s.loadStrikes(0)).toHaveLength(2);
    });

    it('loaded strikes are copies', () => {
      const s = make();
      s.insertStrike(strike('k1', T));
      s.loadStrikes(0)[0]!.rawLine = 'tampered';
      expect(s.loadStrikes(0)[0]?.rawLine).toBe('a line the subject typed');
    });

    it('purgeStrikes deletes strictly older rows and counts them', () => {
      const s = make();
      s.insertStrike(strike('below', T - 1));
      s.insertStrike(strike('at', T));
      s.insertStrike(strike('above', T + 1));
      expect(s.purgeStrikes(T)).toBe(1);
      expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['at', 'above']);
      expect(s.purgeStrikes(T)).toBe(0);
      expect(s.purgeStrikes(T + 100)).toBe(2);
    });

    it('an insert and a purge are undone with their transaction', () => {
      const s = make();
      s.insertStrike(strike('keep', T - 10));
      expect(() =>
        s.transaction(() => {
          s.insertStrike(strike('gone', T));
          expect(s.purgeStrikes(T)).toBe(1);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['keep']);
    });
  });
}
