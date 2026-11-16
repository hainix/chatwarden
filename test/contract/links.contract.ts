import { describe, expect, it } from 'vitest';
import type { LinkRow, Store } from '@chatwarden/core';

// The contract of the optional link methods of the Store (K5 design 5.1): `getLink`, `putLink`, `listLinks` and `purgeLinks`, which keep "this kit
// id is that outside id" rows (Coop jobs, EOS sanctions, EOS report keys, the EOS cursor). One suite, run against every Store that has the
// methods; a store without them skips it, as a kit that needs no links never calls them. SqliteStore is the reference. Stores take a row the
// facade has already validated; they keep it exactly and return copies.

type Links = Required<Pick<Store, 'getLink' | 'putLink' | 'listLinks' | 'purgeLinks'>>;
const METHODS: Array<keyof Links> = ['getLink', 'putLink', 'listLinks', 'purgeLinks'];

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const link = (over: Partial<LinkRow> = {}): LinkRow => ({ system: 'coop-report', ref: 'r1', external: 'job-zorbak-1', state: 'sent', at: NOW, ...over });

export function linksContract(name: string, make: () => Store): void {
  const has = make().putLink !== undefined;
  const maybe = has ? describe : describe.skip;
  maybe(`links contract: ${name}${has ? '' : ' (no link methods)'}`, () => {
    const store = (): Links & Store => {
      const s = make();
      for (const m of METHODS) if (typeof s[m] !== 'function') throw new Error(`this store has no ${m}`);
      return s as Links & Store;
    };

    it('has the four methods', () => {
      const s = make();
      for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    });

    it('put/get/list/purge round-trip', () => {
      const s = store();
      const a = link({ ref: 'a', at: NOW });
      const b = link({ ref: 'b', at: NOW + 1, state: 'decided', external: 'job.vlemmo:2' });
      s.putLink(a);
      s.putLink(b);
      expect(s.getLink('coop-report', 'a')).toEqual(a);
      expect(s.getLink('coop-report', 'b')).toEqual(b);
      expect(s.listLinks('coop-report', { limit: 10 })).toEqual([a, b]);
      expect(s.purgeLinks(NOW + 1)).toBe(1);
      expect(s.getLink('coop-report', 'a')).toBeNull();
      expect(s.listLinks('coop-report', { limit: 10 })).toEqual([b]);
    });

    it('get returns null for an unknown row; put inserts, put again replaces (same system and ref), a different system with the same ref is another row', () => {
      const s = store();
      expect(s.getLink('coop-report', 'r1')).toBeNull();
      s.putLink(link());
      expect(s.getLink('coop-report', 'r1')?.state).toBe('sent');
      s.putLink(link({ state: 'decided', external: 'job-zorbak-2', at: NOW + 5 }));
      expect(s.getLink('coop-report', 'r1')).toEqual(link({ state: 'decided', external: 'job-zorbak-2', at: NOW + 5 }));
      expect(s.listLinks('coop-report', { limit: 10 })).toHaveLength(1);
      s.putLink(link({ system: 'eos-report', external: 'filed-1', state: 'filed' }));
      expect(s.getLink('eos-report', 'r1')?.external).toBe('filed-1');
      expect(s.getLink('coop-report', 'r1')?.external).toBe('job-zorbak-2');
      expect(s.getLink('eos-sanction', 'r1')).toBeNull();
    });

    it('lists by system, oldest at first then ref, optionally one state', () => {
      const s = store();
      s.putLink(link({ ref: 'c', at: NOW + 2 }));
      s.putLink(link({ ref: 'b', at: NOW + 1, state: 'decided' }));
      s.putLink(link({ ref: 'z', at: NOW }));
      s.putLink(link({ ref: 'a', at: NOW }));
      s.putLink(link({ system: 'eos-cursor', ref: 'only', at: NOW - 10, external: '2027-01-14T10:00:00.000Z', state: 'active' }));
      expect(s.listLinks('coop-report', { limit: 10 }).map((r) => r.ref)).toEqual(['a', 'z', 'b', 'c']);
      expect(s.listLinks('coop-report', { state: 'sent', limit: 10 }).map((r) => r.ref)).toEqual(['a', 'z', 'c']);
      expect(s.listLinks('coop-report', { state: 'decided', limit: 10 }).map((r) => r.ref)).toEqual(['b']);
      expect(s.listLinks('coop-report', { state: 'nothing', limit: 10 })).toEqual([]);
      expect(s.listLinks('eos-cursor', { limit: 10 }).map((r) => r.ref)).toEqual(['only']);
      expect(s.listLinks('eos-report', { limit: 10 })).toEqual([]);
    });

    it('a limit takes that many oldest rows and is clamped to 1..500', () => {
      const s = store();
      for (let i = 0; i < 520; i += 1) s.putLink(link({ ref: `r${String(i).padStart(4, '0')}`, at: NOW + i }));
      expect(s.listLinks('coop-report', { limit: 3 }).map((r) => r.ref)).toEqual(['r0000', 'r0001', 'r0002']);
      expect(s.listLinks('coop-report', { limit: 0 })).toHaveLength(1);
      expect(s.listLinks('coop-report', { limit: -4 })).toHaveLength(1);
      expect(s.listLinks('coop-report', { limit: 2.9 })).toHaveLength(2);
      expect(s.listLinks('coop-report', { limit: 9999 })).toHaveLength(500);
      expect(s.listLinks('coop-report', { limit: Number.NaN })).toHaveLength(1);
    });

    it('the state filter is applied before the limit', () => {
      const s = store();
      for (let i = 0; i < 5; i += 1) s.putLink(link({ ref: `old${i}`, at: NOW + i, state: 'decided' }));
      s.putLink(link({ ref: 'fresh', at: NOW + 99, state: 'sent' }));
      expect(s.listLinks('coop-report', { state: 'sent', limit: 2 }).map((r) => r.ref)).toEqual(['fresh']);
    });

    it('purge deletes rows strictly older than the cutoff, in every system, and keeps a row exactly on the line', () => {
      const s = store();
      s.putLink(link({ ref: 'old', at: NOW - DAY }));
      s.putLink(link({ system: 'eos-sanction', ref: 'old', at: NOW - DAY, external: 'ref-1', state: 'removed' }));
      s.putLink(link({ ref: 'edge', at: NOW }));
      s.putLink(link({ ref: 'new', at: NOW + DAY }));
      expect(s.purgeLinks(NOW)).toBe(2);
      expect(s.getLink('coop-report', 'old')).toBeNull();
      expect(s.getLink('eos-sanction', 'old')).toBeNull();
      expect(s.getLink('coop-report', 'edge')).not.toBeNull();
      expect(s.getLink('coop-report', 'new')).not.toBeNull();
      expect(s.purgeLinks(NOW)).toBe(0);
    });

    it('purge never deletes a live row by age: an active eos-sanction link and the eos-cursor row survive, however old', () => {
      const s = store();
      const live = link({ system: 'eos-sanction', ref: 'g1#puid-a', external: 'ref-1', state: 'active', at: NOW - 500 * DAY });
      const cursor = link({ system: 'eos-cursor', ref: 'reports', external: '2027-01-14T10:00:00.000Z', state: 'cursor', at: NOW - 500 * DAY });
      const cursorOdd = link({ system: 'eos-cursor', ref: 'other', external: '2027-01-14T10:00:00.000Z', state: 'active', at: NOW - 500 * DAY });
      for (const r of [live, cursor, cursorOdd]) s.putLink(r);
      expect(s.purgeLinks(NOW + 1000 * DAY)).toBe(0);
      expect(s.getLink('eos-sanction', 'g1#puid-a')).toEqual(live);
      expect(s.getLink('eos-cursor', 'reports')).toEqual(cursor);
      expect(s.getLink('eos-cursor', 'other')).toEqual(cursorOdd);
    });

    it('purge still deletes the same system once it is not live: a removed or failed eos-sanction link, and every old coop-report and eos-report row whatever its state', () => {
      const s = store();
      s.putLink(link({ system: 'eos-sanction', ref: 'removed', external: 'r', state: 'removed', at: NOW - DAY }));
      s.putLink(link({ system: 'eos-sanction', ref: 'failed', external: 'r', state: 'failed', at: NOW - DAY }));
      s.putLink(link({ system: 'eos-sanction', ref: 'active-old', external: 'r', state: 'active', at: NOW - DAY }));
      s.putLink(link({ system: 'coop-report', ref: 'active-coop', external: 'r', state: 'active', at: NOW - DAY }));
      s.putLink(link({ system: 'eos-report', ref: 'active-report', external: 'r', state: 'active', at: NOW - DAY }));
      expect(s.purgeLinks(NOW)).toBe(4);
      expect(s.getLink('eos-sanction', 'removed')).toBeNull();
      expect(s.getLink('eos-sanction', 'failed')).toBeNull();
      expect(s.getLink('coop-report', 'active-coop')).toBeNull();
      expect(s.getLink('eos-report', 'active-report')).toBeNull();
      expect(s.getLink('eos-sanction', 'active-old')).not.toBeNull();
    });

    it('a live eos-sanction link that is then marked removed is purged by its new time, not kept for good', () => {
      const s = store();
      s.putLink(link({ system: 'eos-sanction', ref: 'g', external: 'r', state: 'active', at: NOW - 400 * DAY }));
      expect(s.purgeLinks(NOW)).toBe(0);
      s.putLink(link({ system: 'eos-sanction', ref: 'g', external: 'r', state: 'removed', at: NOW - 1 }));
      expect(s.purgeLinks(NOW)).toBe(1);
      expect(s.getLink('eos-sanction', 'g')).toBeNull();
    });

    it('purge counts a re-put row by its new time', () => {
      const s = store();
      s.putLink(link({ at: NOW - DAY }));
      s.putLink(link({ at: NOW + DAY, state: 'decided' }));
      expect(s.purgeLinks(NOW)).toBe(0);
      expect(s.getLink('coop-report', 'r1')?.state).toBe('decided');
    });

    it('keeps each value exactly: the longest ref and external, the alphabet punctuation, a zero time, a fractional time', () => {
      const s = store();
      const long = `A${'b-'.repeat(63)}Z`;
      expect(long).toHaveLength(128);
      const rows = [
        link({ ref: long, external: long, state: 'a_b.c', at: 0 }),
        link({ ref: 'g#1:x.y_z-9', external: 'E:1#2.3_4-5', at: 1.5 }),
      ];
      for (const r of rows) s.putLink(r);
      for (const r of rows) expect(s.getLink(r.system, r.ref)).toEqual(r);
    });

    it('returns copies: changing a returned row changes nothing stored', () => {
      const s = store();
      s.putLink(link());
      const got = s.getLink('coop-report', 'r1') as LinkRow;
      got.state = 'tampered';
      const listed = s.listLinks('coop-report', { limit: 5 })[0] as LinkRow;
      listed.external = 'tampered';
      expect(s.getLink('coop-report', 'r1')).toEqual(link());
    });

    it('a stored row has exactly the five fields (no extra column leaks)', () => {
      const s = store();
      s.putLink(link());
      expect(Object.keys(s.getLink('coop-report', 'r1') as object).sort()).toEqual(['at', 'external', 'ref', 'state', 'system']);
    });

    it('a transaction that throws undoes a put, a replace and a purge', () => {
      const s = store();
      s.putLink(link({ ref: 'keep', at: NOW - DAY }));
      expect(() =>
        s.transaction(() => {
          s.putLink(link({ ref: 'fresh' }));
          s.putLink(link({ ref: 'keep', state: 'decided', at: NOW - DAY }));
          s.purgeLinks(NOW + 10 * DAY);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(s.getLink('coop-report', 'fresh')).toBeNull();
      expect(s.getLink('coop-report', 'keep')).toEqual(link({ ref: 'keep', at: NOW - DAY }));
    });

    it('a committed transaction keeps what it wrote', () => {
      const s = store();
      s.transaction(() => {
        s.putLink(link({ ref: 'x' }));
      });
      expect(s.getLink('coop-report', 'x')).not.toBeNull();
    });
  });
}
