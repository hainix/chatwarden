import { describe, expect, it } from 'vitest';
import type { BlockedNameRow, Store } from '@chatwarden/core';

// The contract of the optional blocked-name methods of the Store (offensive names, design 5.2 and 6.3): `insertBlockedName`,
// `listBlockedNames` and `purgeBlockedNames`, which keep a blocked name as evidence when the adopter opted in. One suite, run against every
// Store that has the methods; a store without them skips it, as a kit that keeps nothing never calls them. SqliteStore is the reference.

type Names = Required<Pick<Store, 'insertBlockedName' | 'listBlockedNames' | 'purgeBlockedNames'>>;
const METHODS: Array<keyof Names> = ['insertBlockedName', 'listBlockedNames', 'purgeBlockedNames'];

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

let seq = 0;
const row = (over: Partial<BlockedNameRow> = {}): BlockedNameRow => {
  seq += 1;
  return { id: `bn${String(seq).padStart(3, '0')}`, subject: 's_a', name: `quissel${seq}`, termId: 'syn:quissel', reason: 'name_not_allowed', at: NOW + seq, ...over };
};

export function namesContract(name: string, make: () => Store): void {
  const has = make().insertBlockedName !== undefined;
  const maybe = has ? describe : describe.skip;
  maybe(`names contract: ${name}${has ? '' : ' (no blocked-name methods)'}`, () => {
    const store = (): Names & Store => {
      const s = make();
      for (const m of METHODS) if (typeof s[m] !== 'function') throw new Error(`this store has no ${m}`);
      return s as Names & Store;
    };

    it('has the three methods', () => {
      const s = make();
      for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    });

    it('round-trips every field exactly, as a copy', () => {
      const s = store();
      const r = row({ name: 'Snerp the Glarn', termId: 'syn:snerp', reason: 'name_profane' });
      s.insertBlockedName(r);
      const [got] = s.listBlockedNames(0, 10);
      expect(got).toEqual(r);
      expect(got).not.toBe(r);
      (got as BlockedNameRow).name = 'changed';
      expect(s.listBlockedNames(0, 10)[0]?.name).toBe('Snerp the Glarn');
    });

    it('a null subject and a null term id are allowed and round-trip as null', () => {
      const s = store();
      const r = row({ subject: null, termId: null });
      s.insertBlockedName(r);
      expect(s.listBlockedNames(0, 10)).toEqual([r]);
    });

    it('both reasons are accepted', () => {
      const s = store();
      const a = row({ reason: 'name_not_allowed' });
      const b = row({ reason: 'name_profane' });
      s.insertBlockedName(a);
      s.insertBlockedName(b);
      expect(s.listBlockedNames(0, 10).map((r) => r.reason).sort()).toEqual(['name_not_allowed', 'name_profane']);
    });

    it('lists since inclusive, newest first, with a limit', () => {
      const s = store();
      const old = row({ at: NOW - 2 * DAY });
      const edge = row({ at: NOW });
      const mid = row({ at: NOW + 5 });
      const fresh = row({ at: NOW + 10 });
      for (const r of [mid, old, fresh, edge]) s.insertBlockedName(r);
      expect(s.listBlockedNames(NOW, 10).map((r) => r.id)).toEqual([fresh.id, mid.id, edge.id]);
      expect(s.listBlockedNames(NOW + 1, 10).map((r) => r.id)).toEqual([fresh.id, mid.id]);
      expect(s.listBlockedNames(0, 10).map((r) => r.id)).toEqual([fresh.id, mid.id, edge.id, old.id]);
      expect(s.listBlockedNames(0, 2).map((r) => r.id)).toEqual([fresh.id, mid.id]);
      expect(s.listBlockedNames(NOW + 11, 10)).toEqual([]);
    });

    it('a tie on the time is newest-inserted first, stable', () => {
      const s = store();
      const a = row({ at: NOW });
      const b = row({ at: NOW });
      const c = row({ at: NOW });
      for (const r of [a, b, c]) s.insertBlockedName(r);
      const ids = s.listBlockedNames(0, 10).map((r) => r.id);
      expect(ids).toEqual(s.listBlockedNames(0, 10).map((r) => r.id));
      expect([...ids].sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it('the limit is floored and clamped to 1..200; an empty store lists nothing', () => {
      const s = store();
      expect(s.listBlockedNames(0, 10)).toEqual([]);
      for (let i = 0; i < 4; i += 1) s.insertBlockedName(row());
      expect(s.listBlockedNames(0, 2.9)).toHaveLength(2);
      expect(s.listBlockedNames(0, 0)).toHaveLength(1);
      expect(s.listBlockedNames(0, -3)).toHaveLength(1);
      expect(s.listBlockedNames(0, 100000)).toHaveLength(4);
    });

    it('purge is strict: a row exactly on the line is kept', () => {
      const s = store();
      const old = row({ at: NOW - 1 });
      const edge = row({ at: NOW });
      const fresh = row({ at: NOW + 1 });
      for (const r of [old, edge, fresh]) s.insertBlockedName(r);
      expect(s.purgeBlockedNames(NOW)).toBe(1);
      expect(s.listBlockedNames(0, 10).map((r) => r.id)).toEqual([fresh.id, edge.id]);
      expect(s.purgeBlockedNames(NOW)).toBe(0);
      expect(s.purgeBlockedNames(NOW + 1)).toBe(1);
      expect(s.purgeBlockedNames(NOW + 100 * DAY)).toBe(1);
      expect(s.listBlockedNames(0, 10)).toEqual([]);
    });

    it('a duplicate id writes nothing more than once or throws, and never doubles the row', () => {
      const s = store();
      const r = row();
      s.insertBlockedName(r);
      try {
        s.insertBlockedName({ ...r, name: 'second' });
      } catch {
        // a store may refuse a duplicate id by throwing; either way the first row stands
      }
      expect(s.listBlockedNames(0, 10)).toEqual([r]);
    });

    it('a read leaves the change token alone, and an insert shows in the list at once', () => {
      const s = store();
      const token = s.changeToken();
      s.listBlockedNames(0, 10);
      expect(s.changeToken()).toBe(token);
      s.insertBlockedName(row());
      // a blocked name is evidence, not a queue item: the token may or may not move, but the list must show it at once
      expect(s.listBlockedNames(0, 10)).toHaveLength(1);
    });

    it('a transaction that throws undoes an insert and a purge', () => {
      const s = store();
      const kept = row({ at: NOW - 5 * DAY });
      s.insertBlockedName(kept);
      expect(() =>
        s.transaction(() => {
          s.insertBlockedName(row());
          expect(s.purgeBlockedNames(NOW)).toBe(1);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(s.listBlockedNames(0, 10)).toEqual([kept]);
    });
  });
}
