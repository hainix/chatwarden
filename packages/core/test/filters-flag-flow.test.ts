import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// F5: the facade wires a `flag` to `cw.reports.fileSystem` and the hit counters to the store. One flag = at most one report; the counters say what came of it
// (flag: a report was filed, flag_capped: the daily cap stopped it, count: one was already open, a guest, or anything went wrong).

const ROOM = 'RFF';
const DAY = 86_400_000;
const LINK = 'see vlemmo.com now';

const sit = (w: World, room = ROOM, key = 'k-speaker'): void => {
  w.cw.rooms.seat(room, 'p1', { clientKey: key }, 'Spk');
  w.cw.rooms.seat(room, 'p2', { clientKey: `${key}-other` }, 'Oth');
};
const flagWorld = (extra: Record<string, unknown> = {}, store: MemoryStore = new MemoryStore()) =>
  world({ overrides: { filters: { links: { action: 'flag' }, ...extra } } }, store);

describe('a flag files a report with no reporter', () => {
  it('the line is delivered and one open filter report exists for the speaker, with the line cited and the room as its excerpt', async () => {
    const w = await flagWorld();
    sit(w);
    const r = w.cw.chat.accept(ROOM, 'p1', LINK);
    expect(r).toMatchObject({ deliver: { text: LINK } });
    const [one, ...rest] = w.cw.reports.list({ status: 'open' }).items;
    expect(rest).toEqual([]);
    expect(one).toMatchObject({ origin: 'filter', originKey: 'link.unlisted', reportedReason: 'spam', reporterPerson: null, lineId: (r as { deliver: { lineId: string } }).deliver.lineId });
    expect(one!.excerpt.map((l) => l.raw)).toEqual([LINK]);
    expect(await w.cw.filters.stats({ days: 7 })).toEqual({ days: 7, keys: { 'link.unlisted': { count: 0, flag: 1, mask: 0, refuse: 0, flag_capped: 0 } } });
    await w.cw.close();
  });

  it('a personal-info flag files the reason personal_info', async () => {
    const w = await world({ overrides: { filters: { personalInfo: { action: 'flag' } } } });
    sit(w);
    w.cw.chat.accept(ROOM, 'p1', 'mail me at a@b.com');
    expect(w.cw.reports.list({}).items[0]).toMatchObject({ reportedReason: 'personal_info', originKey: 'personal_info.email' });
    await w.cw.close();
  });

  it('the flag is announced: report.created carries origin filter', async () => {
    const w = await flagWorld();
    const seen: Array<Record<string, unknown>> = [];
    w.cw.on('report.created', (e) => void seen.push({ ...e }));
    sit(w);
    w.cw.chat.accept(ROOM, 'p1', LINK);
    await w.cw.filters.stats({ days: 7 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: 'filter', reportedReason: 'spam' });
    await w.cw.close();
  });

  it('a flag never strikes, sanctions or notifies the speaker', async () => {
    const w = await flagWorld();
    sit(w);
    w.cw.chat.accept(ROOM, 'p1', LINK);
    await w.cw.filters.stats({ days: 7 });
    expect(w.cw.notices.pending({ clientKey: 'k-speaker' })).toEqual([]);
    expect(w.cw.chat.restricted({ clientKey: 'k-speaker' }, { roomId: ROOM, seatId: 'p1' })).toMatchObject({ restricted: false });
    await w.cw.close();
  });
});

describe('what the counters say', () => {
  it('a second flag while one is open counts as a plain count and files nothing', async () => {
    const w = await flagWorld();
    sit(w);
    w.cw.chat.accept(ROOM, 'p1', LINK);
    w.clock.t += 10_000;
    w.cw.chat.accept(ROOM, 'p1', LINK);
    expect(w.cw.reports.list({}).items).toHaveLength(1);
    expect((await w.cw.filters.stats({ days: 7 })).keys['link.unlisted']).toEqual({ count: 1, flag: 1, mask: 0, refuse: 0, flag_capped: 0 });
    await w.cw.close();
  });

  it('past the daily cap a flag is flag_capped and files nothing; the next UTC day files again', async () => {
    const w = await flagWorld({ flagCapPerDay: 1 });
    w.clock.t = Math.floor(w.clock.t / DAY) * DAY + 1000;
    sit(w, 'A', 'ka');
    sit(w, 'B', 'kb');
    w.cw.chat.accept('A', 'p1', LINK);
    w.cw.chat.accept('B', 'p1', LINK);
    expect(w.cw.reports.list({}).items).toHaveLength(1);
    expect((await w.cw.filters.stats({ days: 7 })).keys['link.unlisted']).toEqual({ count: 0, flag: 1, mask: 0, refuse: 0, flag_capped: 1 });
    w.clock.t += DAY;
    w.cw.chat.accept('B', 'p1', 'see zorbakk.com ok');
    expect(w.cw.reports.list({}).items).toHaveLength(2);
    await w.cw.close();
  });

  it('a guest is delivered, files nothing and counts as a plain count', async () => {
    const w = await flagWorld();
    // a seat with no identifiers has no subject
    w.cw.rooms.seat(ROOM, 'p1', {}, 'Guest');
    expect(w.cw.chat.accept(ROOM, 'p1', LINK)).toMatchObject({ deliver: {} });
    expect(w.cw.reports.list({}).items).toEqual([]);
    expect((await w.cw.filters.stats({ days: 7 })).keys['link.unlisted']).toEqual({ count: 1, flag: 0, mask: 0, refuse: 0, flag_capped: 0 });
    await w.cw.close();
  });

  it('a store that fails the report still delivers the line, counts a plain count and logs the class only', async () => {
    const w = await flagWorld();
    sit(w);
    w.store.insertReport = () => {
      throw new RangeError('boom vlemmo.com');
    };
    expect(w.cw.chat.accept(ROOM, 'p1', LINK)).toMatchObject({ deliver: { text: LINK } });
    expect((await w.cw.filters.stats({ days: 7 })).keys['link.unlisted']).toMatchObject({ count: 1, flag: 0 });
    expect(JSON.stringify(w.logged)).not.toContain('vlemmo');
    await w.cw.close();
  });

  it('with moderation off a flag files nothing and counts a plain count', async () => {
    let on = true;
    const w = await world({ enabled: () => on, overrides: { filters: { links: { action: 'flag' } } } });
    sit(w);
    on = false;
    w.cw.chat.accept(ROOM, 'p1', LINK);
    on = true;
    expect(w.cw.reports.list({}).items).toEqual([]);
    expect((await w.cw.filters.stats({ days: 7 })).keys['link.unlisted']).toMatchObject({ count: 1, flag: 0 });
    await w.cw.close();
  });

  it('a mask, a refuse and a count are counted under their own action, as before', async () => {
    const w = await world({ overrides: { filters: { links: { action: 'mask' }, personalInfo: { action: 'refuse' }, phrases: [{ id: 'ads', action: 'count', phrases: ['buy gold'] }] } } });
    sit(w);
    w.cw.chat.accept(ROOM, 'p1', 'see vlemmo.com');
    w.clock.t += 10_000;
    w.cw.chat.accept(ROOM, 'p1', 'mail a@b.com');
    w.clock.t += 10_000;
    w.cw.chat.accept(ROOM, 'p1', 'buy gold now');
    const keys = (await w.cw.filters.stats({ days: 7 })).keys;
    expect(keys['link.unlisted']!.mask).toBe(1);
    expect(keys['personal_info.email']!.refuse).toBe(1);
    expect(keys['phrase.ads']!.count).toBe(1);
    expect(w.cw.reports.list({}).items).toEqual([]);
    await w.cw.close();
  });
});

describe('the counters live in the store', () => {
  it('stats are read from the store: a second kit on the same store sees what the first wrote, after the first closed', async () => {
    const store = new MemoryStore();
    const a = await flagWorld({}, store);
    sit(a);
    a.cw.chat.accept(ROOM, 'p1', LINK);
    await a.cw.close();
    expect(store.listFilterHits(0, 10 ** 9).reduce((n, r) => n + r.hits, 0)).toBe(1);
    const b = await flagWorld({}, store);
    expect((await b.cw.filters.stats({ days: 7 })).keys['link.unlisted']).toMatchObject({ flag: 1 });
    await b.cw.close();
  });

  it('close writes the held counts to the store and the counts are added, not replaced, by a second flush', async () => {
    const store = new MemoryStore();
    const a = await world({ overrides: { filters: { links: { action: 'count' } } } }, store);
    sit(a);
    a.cw.chat.accept(ROOM, 'p1', LINK);
    await a.cw.filters.stats({ days: 7 });
    a.clock.t += 10_000;
    a.cw.chat.accept(ROOM, 'p1', LINK);
    await a.cw.close();
    const rows = store.listFilterHits(0, 10 ** 9);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'link.unlisted', action: 'count', hits: 2 });
  });

  it('a store that cannot write the counts logs the class and keeps the rows for the next flush', async () => {
    const store = new MemoryStore();
    const a = await world({ overrides: { filters: { links: { action: 'count' } } } }, store);
    sit(a);
    const add = store.addFilterHits.bind(store);
    let fail = true;
    store.addFilterHits = (rows) => {
      if (fail) throw new TypeError('disk full vlemmo.com');
      add(rows);
    };
    a.cw.chat.accept(ROOM, 'p1', LINK);
    await a.cw.close();
    expect(store.listFilterHits(0, 10 ** 9)).toEqual([]);
    expect(JSON.stringify(a.logged)).not.toContain('vlemmo');
    fail = false;
    await a.cw.close();
  });

  it('the filters off: no counter row and no report is ever written', async () => {
    const store = new MemoryStore();
    const w = await world({}, store);
    sit(w);
    w.cw.chat.accept(ROOM, 'p1', LINK);
    await w.cw.close();
    expect(store.listFilterHits(0, 10 ** 9)).toEqual([]);
    expect(store.countOriginReports('filter', 0)).toBe(0);
  });
});
