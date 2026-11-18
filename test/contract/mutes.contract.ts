import { describe, expect, it } from 'vitest';
import type { MuteRow, Store } from '@chatwarden/core';

// The contract of the mute methods of the Store. One suite, run against every Store.

const T = 1_800_000_000_000;
const mute = (viewer: string, target: string, createdAt = T, block = false): MuteRow => ({ viewer, target, createdAt, block });
const DAY = 86_400_000;
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

    describe('blocks: the block flag of a row', () => {
      it('a block round-trips with block true and a mute with block false', () => {
        const s = make();
        s.upsertMute(mute('v', 'b', T, true));
        s.upsertMute(mute('v', 'm', T + 1));
        expect(s.loadMutes(0)).toEqual([mute('v', 'b', T, true), mute('v', 'm', T + 1, false)]);
      });

      it('a block over a mute makes the row a block, one row; a mute over a block keeps the block (a mute never downgrades a block); deleteMute removes it either way', () => {
        const s = make();
        s.upsertMute(mute('v', 't', T, false));
        s.upsertMute(mute('v', 't', T + 1, true));
        expect(s.loadMutes(0)).toEqual([mute('v', 't', T + 1, true)]);
        s.upsertMute(mute('v', 't', T + 2, false));
        expect(s.loadMutes(0).map((r) => r.block)).toEqual([true]);
        expect(s.deleteMute('v', 't')).toBe(true);
        expect(s.loadMutes(0)).toEqual([]);
      });

      it('loadMutes keeps a block whatever its age, and a mute only from since', () => {
        const s = make();
        s.upsertMute(mute('v', 'oldblock', T - 900 * DAY, true));
        s.upsertMute(mute('v', 'oldmute', T - 900 * DAY, false));
        s.upsertMute(mute('v', 'newmute', T + 1, false));
        expect(pairs(s.loadMutes(T))).toEqual(['v>newmute', 'v>oldblock']);
        expect(pairs(s.loadMutes(T + 5))).toEqual(['v>oldblock']);
      });

      it('purgeMutes skips a block at any age and counts only the mutes it deletes', () => {
        const s = make();
        s.upsertMute(mute('v', 'oldblock', T - 900 * DAY, true));
        s.upsertMute(mute('v', 'oldmute', T - 900 * DAY, false));
        s.upsertMute(mute('w', 'oldmute2', T - 10, false));
        s.upsertMute(mute('w', 'new', T + 1, false));
        expect(s.purgeMutes(T)).toBe(2);
        expect(pairs(s.loadMutes(0))).toEqual(['v>oldblock', 'w>new']);
        expect(s.purgeMutes(T + 1000 * DAY)).toBe(1);
        expect(pairs(s.loadMutes(0))).toEqual(['v>oldblock']);
      });

      it('pruneMutes drops the oldest mutes and never a block, even the oldest row; it may leave more than N when only blocks remain', () => {
        const s = make();
        s.upsertMute(mute('v', 'b1', T, true));
        s.upsertMute(mute('v', 'm1', T + 1));
        s.upsertMute(mute('v', 'b2', T + 2, true));
        s.upsertMute(mute('v', 'm2', T + 3));
        expect(s.pruneMutes('v', 3)).toEqual(['m1']);
        expect(pairs(s.loadMutes(0))).toEqual(['v>b1', 'v>b2', 'v>m2']);
        expect(s.pruneMutes('v', 0)).toEqual(['m2']);
        expect(pairs(s.loadMutes(0))).toEqual(['v>b1', 'v>b2']);
        expect(s.pruneMutes('v', 1)).toEqual([]);
        expect(pairs(s.loadMutes(0))).toEqual(['v>b1', 'v>b2']);
      });

      it("pruneMutes of one viewer never touches another viewer's blocks or mutes", () => {
        const s = make();
        s.upsertMute(mute('v', 'a', T));
        s.upsertMute(mute('w', 'b', T - 5, true));
        s.upsertMute(mute('w', 'c', T - 6));
        expect(s.pruneMutes('v', 0)).toEqual(['a']);
        expect(pairs(s.loadMutes(0))).toEqual(['w>b', 'w>c']);
      });

      it('a rolled-back block write, delete or purge puts the block back, flag included', () => {
        const s = make();
        s.upsertMute(mute('v', 'b', T - 900 * DAY, true));
        expect(() =>
          s.transaction(() => {
            s.deleteMute('v', 'b');
            s.upsertMute(mute('v', 'n', T, true));
            s.upsertMute(mute('v', 'b2', T, false));
            s.purgeMutes(T + 100);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadMutes(0)).toEqual([mute('v', 'b', T - 900 * DAY, true)]);
        expect(() =>
          s.transaction(() => {
            s.upsertMute(mute('v', 'b', T, false));
            s.upsertMute(mute('v', 'm', T, false));
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadMutes(0)).toEqual([mute('v', 'b', T - 900 * DAY, true)]);
      });
    });

    describe('blocks: privacy (both directions, in export and erase)', () => {
      const plan = (subjects: string[]) => ({ subjects, mode: 'none' as const, heldReportIds: new Set<string>(), receiptId: 'e_blocks', at: T });

      it("erasing a person deletes the blocks and mutes they placed and the ones placed on them, and nobody else's", async () => {
        const s = make();
        for (const id of ['s_me', 's_a', 's_b', 's_c']) await s.saveSubject({ id, createdAt: T, mergedInto: null });
        s.upsertMute(mute('s_me', 's_a', T, true));
        s.upsertMute(mute('s_me', 's_b', T, false));
        s.upsertMute(mute('s_a', 's_me', T, true));
        s.upsertMute(mute('s_b', 's_me', T, false));
        s.upsertMute(mute('s_a', 's_b', T, true));
        s.upsertMute(mute('s_c', 's_a', T, false));
        const counts = s.eraseSubjects(plan(['s_me']));
        expect(counts.removed.mutes).toBe(4);
        expect(pairs(s.loadMutes(0))).toEqual(['s_a>s_b', 's_c>s_a']);
        expect(s.loadMutes(0).find((r) => r.viewer === 's_a')?.block).toBe(true);
      });

      it('a dry run counts the blocks and writes nothing', async () => {
        const s = make();
        for (const id of ['s_me', 's_a']) await s.saveSubject({ id, createdAt: T, mergedInto: null });
        s.upsertMute(mute('s_me', 's_a', T, true));
        s.upsertMute(mute('s_a', 's_me', T, true));
        const counts = s.eraseSubjects({ ...plan(['s_me']), dryRun: true });
        expect(counts.removed.mutes).toBe(2);
        expect(s.loadMutes(0)).toHaveLength(2);
      });

      it('the export counts the blocks a person placed with their mutes, and never says they were blocked: a block placed on them is not in what they receive', async () => {
        const s = make();
        for (const id of ['s_me', 's_a', 's_b']) await s.saveSubject({ id, createdAt: T, mergedInto: null });
        s.upsertMute(mute('s_me', 's_a', T, true));
        s.upsertMute(mute('s_me', 's_b', T, false));
        s.upsertMute(mute('s_a', 's_me', T, true));
        s.upsertMute(mute('s_b', 's_me', T, false));
        const out = s.exportSubjects(['s_me']);
        expect(out.mutes).toEqual({ placed: 2, received: 1 });
        expect(Object.keys(out.mutes)).toEqual(['placed', 'received']);
        const onlyBlocked = make();
        for (const id of ['s_me', 's_a']) await onlyBlocked.saveSubject({ id, createdAt: T, mergedInto: null });
        onlyBlocked.upsertMute(mute('s_a', 's_me', T, true));
        expect(onlyBlocked.exportSubjects(['s_me']).mutes).toEqual({ placed: 0, received: 0 });
      });
    });
  });
}
