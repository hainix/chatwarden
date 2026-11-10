import { describe, expect, it } from 'vitest';
import type { MuteRow, Store } from '@chatwarden/core';

// The contract of the mute methods of the Store. One suite, run against every Store.

const T = 1_800_000_000_000;
const mute = (viewer: string, target: string, createdAt = T): MuteRow => ({ viewer, target, createdAt });
const pairs = (rows: MuteRow[]) => rows.map((r) => `${r.viewer}>${r.target}`).sort();

export function mutesContract(name: string, make: () => Store): void {
  describe(`mutes contract: ${name}`, () => {
    it('upsertMute then loadMutes round-trips the row', () => {
      const s = make();
      s.upsertMute(mute('v', 't', T));
      expect(s.loadMutes(0)).toEqual([mute('v', 't', T)]);
    });

    it('muting the same person again refreshes createdAt and adds no row', () => {
      const s = make();
      s.upsertMute(mute('v', 't', T));
      s.upsertMute(mute('v', 't', T + 50));
      expect(s.loadMutes(0)).toEqual([mute('v', 't', T + 50)]);
    });

    it('the pair is ordered and exact: viewer and target differ, ids are case sensitive', () => {
      const s = make();
      s.upsertMute(mute('a', 'b'));
      s.upsertMute(mute('b', 'a'));
      s.upsertMute(mute('A', 'b'));
      expect(pairs(s.loadMutes(0))).toEqual(['A>b', 'a>b', 'b>a']);
    });

    it('loadMutes lists in write order; a refresh keeps the original place', () => {
      const s = make();
      s.upsertMute(mute('v', 'first', T));
      s.upsertMute(mute('v', 'second', T + 1));
      s.upsertMute(mute('v', 'third', T + 2));
      s.upsertMute(mute('v', 'first', T + 3));
      expect(s.loadMutes(0).map((r) => r.target)).toEqual(['first', 'second', 'third']);
    });

    describe('a rolled-back write puts everything back, in the same order', () => {
      const seeded = (): Store => {
        const s = make();
        s.upsertMute(mute('v', 'a', T));
        s.upsertMute(mute('v', 'b', T + 1));
        s.upsertMute(mute('v', 'c', T + 2));
        return s;
      };
      const order = (s: Store) => s.loadMutes(0).map((r) => `${r.viewer}>${r.target}`);
      const boom = (): never => {
        throw new Error('boom');
      };

      it('deleteMute of the first or a middle row', () => {
        for (const target of ['a', 'b']) {
          const s = seeded();
          expect(() =>
            s.transaction(() => {
              s.deleteMute('v', target);
              boom();
            }),
          ).toThrow('boom');
          expect(order(s)).toEqual(['v>a', 'v>b', 'v>c']);
        }
      });

      it('pruneMutes: the dropped rows come back, in their places', () => {
        const s = seeded();
        expect(() =>
          s.transaction(() => {
            expect(s.pruneMutes('v', 1)).toEqual(['a', 'b']);
            boom();
          }),
        ).toThrow('boom');
        expect(order(s)).toEqual(['v>a', 'v>b', 'v>c']);
        expect(s.loadMutes(0).map((r) => r.createdAt)).toEqual([T, T + 1, T + 2]);
      });

      it('a partial purgeMutes', () => {
        const s = seeded();
        expect(() =>
          s.transaction(() => {
            expect(s.purgeMutes(T + 2)).toBe(2);
            boom();
          }),
        ).toThrow('boom');
        expect(order(s)).toEqual(['v>a', 'v>b', 'v>c']);
      });

      it('a delete that is then re-muted inside the same failed transaction', () => {
        const s = seeded();
        expect(() =>
          s.transaction(() => {
            s.deleteMute('v', 'a');
            s.upsertMute(mute('v', 'a', T + 9));
            boom();
          }),
        ).toThrow('boom');
        expect(order(s)).toEqual(['v>a', 'v>b', 'v>c']);
        expect(s.loadMutes(0)[0]?.createdAt).toBe(T);
      });

      it('after a rolled-back prune, a later prune still drops the right rows', () => {
        const s = seeded();
        expect(() =>
          s.transaction(() => {
            s.pruneMutes('v', 0);
            boom();
          }),
        ).toThrow('boom');
        expect(s.pruneMutes('v', 2)).toEqual(['a']);
        expect(order(s)).toEqual(['v>b', 'v>c']);
      });
    });

    it('loadMutes keeps rows created at or after since', () => {
      const s = make();
      s.upsertMute(mute('v', 'old', T - 1));
      s.upsertMute(mute('v', 'edge', T));
      s.upsertMute(mute('v', 'new', T + 1));
      expect(pairs(s.loadMutes(T))).toEqual(['v>edge', 'v>new']);
      expect(s.loadMutes(T + 2)).toEqual([]);
    });

    it('deleteMute removes the exact pair and says whether it did', () => {
      const s = make();
      s.upsertMute(mute('v', 't'));
      expect(s.deleteMute('t', 'v')).toBe(false);
      expect(s.deleteMute('V', 't')).toBe(false);
      expect(s.deleteMute('v', 't')).toBe(true);
      expect(s.deleteMute('v', 't')).toBe(false);
      expect(s.loadMutes(0)).toEqual([]);
    });

    it('pruneMutes keeps the newest N of one viewer and returns the dropped targets, oldest first', () => {
      const s = make();
      s.upsertMute(mute('v', 't3', T + 3));
      s.upsertMute(mute('v', 't1', T + 1));
      s.upsertMute(mute('v', 't2', T + 2));
      s.upsertMute(mute('other', 'x', T));
      expect(s.pruneMutes('v', 2)).toEqual(['t1']);
      expect(pairs(s.loadMutes(0))).toEqual(['other>x', 'v>t2', 'v>t3']);
      expect(s.pruneMutes('v', 0)).toEqual(['t2', 't3']);
      expect(pairs(s.loadMutes(0))).toEqual(['other>x']);
    });

    it('pruneMutes with room to spare drops nothing; on a tie the one written last survives', () => {
      const s = make();
      s.upsertMute(mute('v', 'first', T));
      s.upsertMute(mute('v', 'second', T));
      s.upsertMute(mute('v', 'third', T));
      expect(s.pruneMutes('v', 5)).toEqual([]);
      expect(s.pruneMutes('v', 1)).toEqual(['first', 'second']);
      expect(pairs(s.loadMutes(0))).toEqual(['v>third']);
    });

    it('a refreshed mute is not the oldest any more', () => {
      const s = make();
      s.upsertMute(mute('v', 'a', T));
      s.upsertMute(mute('v', 'b', T + 1));
      s.upsertMute(mute('v', 'a', T + 2));
      expect(s.pruneMutes('v', 1)).toEqual(['b']);
      expect(pairs(s.loadMutes(0))).toEqual(['v>a']);
    });

    it('purgeMutes deletes strictly older rows and counts them', () => {
      const s = make();
      s.upsertMute(mute('v', 'below', T - 1));
      s.upsertMute(mute('v', 'at', T));
      s.upsertMute(mute('w', 'above', T + 1));
      expect(s.purgeMutes(T)).toBe(1);
      expect(pairs(s.loadMutes(0))).toEqual(['v>at', 'w>above']);
      expect(s.purgeMutes(T)).toBe(0);
    });

    it('loaded rows are copies', () => {
      const s = make();
      s.upsertMute(mute('v', 't'));
      s.loadMutes(0)[0]!.createdAt = 0;
      expect(s.loadMutes(0)[0]?.createdAt).toBe(T);
    });

    it('a rolled-back pruneMutes returns the rows it dropped', () => {
      const s = make();
      s.upsertMute(mute('v', 'a', T));
      s.upsertMute(mute('v', 'b', T + 1));
      expect(() =>
        s.transaction(() => {
          expect(s.pruneMutes('v', 0)).toEqual(['a', 'b']);
          expect(s.loadMutes(0)).toEqual([]);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(pairs(s.loadMutes(0))).toEqual(['v>a', 'v>b']);
    });

    it('every write is undone with its transaction', () => {
      const s = make();
      s.upsertMute(mute('v', 'keep', T));
      s.upsertMute(mute('v', 'old', T - 5));
      expect(() =>
        s.transaction(() => {
          s.upsertMute(mute('v', 'new', T + 1));
          s.upsertMute(mute('v', 'keep', T + 9));
          s.deleteMute('v', 'old');
          expect(s.pruneMutes('v', 1)).toEqual(['new']);
          s.purgeMutes(T + 100);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(s.loadMutes(0).sort((a, b) => a.createdAt - b.createdAt)).toEqual([mute('v', 'old', T - 5), mute('v', 'keep', T)]);
    });
  });
}
