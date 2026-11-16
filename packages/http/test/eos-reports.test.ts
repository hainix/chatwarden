import type { Chatwarden } from '@chatwarden/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eosWorld, reportKey, until } from './eos-world.js';
import type { EosReport, EosWorld } from './eos-world.js';

// K5 E3: EOS player reports become kit reports (design 9.4). Nothing here touches the network: the adapter's `fetch` is the fake EOS, and its clock and jitter are injected.

afterEach(() => {
  vi.useRealTimers();
});

const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;
let n = 0;

/** A room with a reporter in p1 and `targets` other players in p2..; each has an EOS product user id the adopter's table knows. */
function room(c: EosWorld, targets = 1) {
  const roomId = `eos-room-${++n}`;
  const reporter = `puid-reporter-${n}`;
  c.cw.rooms.seat(roomId, 'p1', { clientKey: `raw-client-key-rep-${n}`, ip: '198.51.100.23' }, 'Rep');
  c.seats.set(reporter, { roomId, seatId: 'p1' });
  const ids: string[] = [];
  for (let i = 0; i < targets; i++) {
    const id = `puid-target-${n}-${i}`;
    c.cw.rooms.seat(roomId, `p${i + 2}`, { clientKey: `raw-client-key-tgt-${n}-${i}`, ip: '203.0.113.99' }, `Tgt${i}`);
    c.seats.set(id, { roomId, seatId: `p${i + 2}` });
    c.players.push(id);
    ids.push(id);
  }
  return { roomId, reporter, targets: ids };
}

/** An EOS report as a client would have written it. */
const report = (c: EosWorld, r: Partial<EosReport> & Pick<EosReport, 'reportingPlayerId' | 'reportedPlayerId'>): EosReport => c.fake.addReport({ time: iso(c.w.clock.t - MIN), ...r });

const find = (c: EosWorld) => c.fake.calls.filter((x) => x.method === 'GET' && x.path.includes('/player-reports/'));
const eosLogs = (c: EosWorld) => c.logged.filter(([e]) => e.startsWith('chatwarden.eos'));
const cursor = (c: EosWorld) => c.cw.links.get('eos-cursor', 'reports');
const rows = (c: EosWorld) => c.cw.reports.list({ status: 'open', limit: 200 }).items;

describe('poll: what is asked', () => {
  it("the fake's both-filters-empty refusal is never triggered: with no players the adapter makes no request", async () => {
    const c = await eosWorld();
    expect(await c.adapter.pollReports()).toEqual({ seen: 0, filed: 0, skipped: {}, refused: {} });
    expect(c.fake.calls).toEqual([]);
    expect(c.fake.state.bothEmptyRefusals).toBe(0);
    for (const bad of [[], ['', 5, null, 'has space'], [undefined]]) {
      c.players.length = 0;
      c.players.push(...(bad as string[]));
      await c.adapter.pollReports();
    }
    expect(c.fake.calls).toEqual([]);
    c.adapter.dispose();
  });

  it('players are batched by 20, deduplicated, junk is dropped and at most 500 are used; every request pages, orders and starts 10 minutes before the cursor', async () => {
    const c = await eosWorld();
    const many = Array.from({ length: 45 }, (_, i) => `puid-batch-${i}`);
    c.players.push(...many, ...many.slice(0, 10), '', 'has space');
    await c.adapter.pollReports();
    const calls = find(c);
    expect(calls).toHaveLength(3);
    const ids = (x: (typeof calls)[number]) => x.query.filter(([k]) => k === 'reportedPlayerId').map(([, v]) => v);
    expect(calls.map((x) => ids(x).length)).toEqual([20, 20, 5]);
    expect(calls.flatMap(ids)).toEqual(many);
    expect(calls.some((x) => x.query.some(([k]) => k === 'reportingPlayerId'))).toBe(false);
    for (const call of calls) {
      expect(call.query.filter(([k]) => k !== 'reportedPlayerId')).toEqual([
        ['startTime', iso(c.w.clock.t - 10 * MIN)],
        ['pagination', 'true'],
        ['offset', '0'],
        ['limit', '50'],
        ['order', 'time:asc'],
      ]);
    }
    expect(c.fake.state.withoutPagination).toBe(0);
    c.adapter.dispose();

    const d = await eosWorld({ reports: { batch: 100 }, fake: { maxReportedIds: 100 } });
    d.players.push(...Array.from({ length: 600 }, (_, i) => `puid-cap-${i}`));
    await d.adapter.pollReports();
    const sent = find(d).flatMap((x) => x.query.filter(([k]) => k === 'reportedPlayerId'));
    expect(sent).toHaveLength(500);
    expect(find(d)).toHaveLength(5);
    d.adapter.dispose();
  });

  it('a players() that throws, rejects or answers something else logs op players by class and asks for nothing', async () => {
    for (const [cls, fn] of [
      ['Error', () => { throw new Error('boom puid-glarn-SECRETP'); }],
      ['TypeError', () => Promise.reject(new TypeError('x'))],
      ['BadAnswer', () => 'puid-glarn-SECRETP'],
      ['BadAnswer', () => undefined],
    ] as Array<[string, () => unknown]>) {
      const c = await eosWorld({ reports: { players: fn } });
      expect(await c.adapter.pollReports()).toEqual({ seen: 0, filed: 0, skipped: {}, refused: {} });
      expect(eosLogs(c), cls).toEqual([['chatwarden.eos_failed', { op: 'players', error: cls }]]);
      expect(JSON.stringify(c.logged)).not.toContain('SECRETP');
      expect(c.fake.calls).toEqual([]);
      c.adapter.dispose();
    }
  });
});

describe('poll: filing', () => {
  it("a report about a seated player by a seated reporter in the same room becomes a kit report with the mapped reason, the message as the note, the kit's clock as createdAt and the line from context only when it is a short string", async () => {
    const c = await eosWorld();
    const r = room(c);
    const eosTime = iso(c.w.clock.t - 5 * MIN);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4, message: 'zorbak is rude to vlemmo', time: eosTime, context: JSON.stringify({ lineId: 'line-snerp-1', other: { deep: true } }) });
    const out = await c.adapter.pollReports();
    expect(out).toEqual({ seen: 1, filed: 1, skipped: {}, refused: {} });
    const [filed] = rows(c);
    expect(filed).toMatchObject({ roomId: r.roomId, reporterSeat: 'p1', targetSeat: 'p2', reportedReason: 'harassment', note: 'zorbak is rude to vlemmo', createdAt: c.w.clock.t });
    expect(filed?.createdAt).not.toBe(Date.parse(eosTime));
    const row = c.cw.links.get('eos-report', reportKey({ time: eosTime, reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 }));
    expect(row).toMatchObject({ system: 'eos-report', state: 'filed', external: filed?.id, at: c.w.clock.t });
    // The row holds a hash, never the ids.
    expect(JSON.stringify(row)).not.toContain('puid-');
    c.adapter.dispose();
  });

  it('every EOS reason maps to a kit reason; one with no mapping is filed with no reason', async () => {
    const c = await eosWorld({ reports: { reasons: { 7: null } } });
    const kinds: Array<[number, string | null]> = [[1, 'cheating'], [2, 'cheating'], [3, 'other'], [4, 'harassment'], [5, 'spam'], [6, 'spam'], [7, null], [8, null], [99, null]];
    for (const [id] of kinds) {
      const r = room(c);
      report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: id });
    }
    const out = await c.adapter.pollReports();
    expect(out).toMatchObject({ seen: kinds.length, filed: kinds.length, refused: {} });
    const byRoom = new Map(rows(c).map((x) => [x.roomId, x]));
    const got = kinds.map((_, i) => byRoom.get(`eos-room-${n - kinds.length + 1 + i}`)?.reportedReason);
    expect(got).toEqual(kinds.map(([, want]) => want));
    c.adapter.dispose();
  });

  it('a different room, an unseated reporter or reported player, and a report of someone against themselves are skipped, counted and linked as skipped; they are not asked about again', async () => {
    const c = await eosWorld();
    const a = room(c);
    const b = room(c);
    const lone = room(c);
    // different room: reporter in room a, reported in room b.
    report(c, { reportingPlayerId: a.reporter, reportedPlayerId: b.targets[0] as string, reasonId: 4 });
    // unseated reporter.
    report(c, { reportingPlayerId: 'puid-nowhere-1', reportedPlayerId: lone.targets[0] as string, reasonId: 4 });
    // unseated reported (not in a room, but named by players()).
    c.players.push('puid-nowhere-2');
    report(c, { reportingPlayerId: lone.reporter, reportedPlayerId: 'puid-nowhere-2', reasonId: 4 });
    // against themselves.
    report(c, { reportingPlayerId: b.targets[0] as string, reportedPlayerId: b.targets[0] as string, reasonId: 4 });
    const out = await c.adapter.pollReports();
    expect(out).toEqual({ seen: 4, filed: 0, skipped: { different_room: 1, unseated: 2, self: 1 }, refused: {} });
    expect(rows(c)).toEqual([]);
    expect(c.cw.links.list('eos-report', { state: 'skipped', limit: 10 })).toHaveLength(4);
    expect(eosLogs(c).map(([, d]) => d).sort((x, y) => String(x?.['reason']).localeCompare(String(y?.['reason'])))).toEqual([
      { reason: 'different_room', count: 1 },
      { reason: 'self', count: 1 },
      { reason: 'unseated', count: 2 },
    ]);
    // A second poll sees the same reports, knows them, and counts nothing new.
    c.logged.length = 0;
    expect(await c.adapter.pollReports()).toEqual({ seen: 4, filed: 0, skipped: {}, refused: {} });
    expect(eosLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('a seatOf that throws, rejects or answers a bad seat leaves the report unlinked for the next poll, counts it, and logs by class', async () => {
    let mode: 'ok' | 'throw' | 'reject' | 'bad' = 'throw';
    const c = await eosWorld({
      reports: {
        seatOf: (id: string) => {
          if (mode === 'throw') throw new Error('boom puid-glarn-SECRETP');
          if (mode === 'reject') return Promise.reject(new TypeError('x'));
          if (mode === 'bad') return { roomId: 5, seatId: {} };
          return c.seats.get(id) ?? null;
        },
      },
    });
    const r = room(c);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    for (const m of ['throw', 'reject', 'bad'] as const) {
      mode = m;
      expect(await c.adapter.pollReports(), m).toMatchObject({ filed: 0, skipped: { seat_error: 1 } });
    }
    expect(c.cw.links.list('eos-report', { limit: 10 })).toEqual([]);
    expect(rows(c)).toEqual([]);
    expect(JSON.stringify(c.logged)).not.toContain('SECRETP');
    mode = 'ok';
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 1 });
    c.adapter.dispose();
  });

  it("the kit's refusals are counted by code: the 11th report from one reporter in a day is refused rate and its link is skipped; an unknown reason is refused; a suspended reporter is refused", async () => {
    const c = await eosWorld();
    const r = room(c, 12);
    for (const t of r.targets) report(c, { reportingPlayerId: r.reporter, reportedPlayerId: t, reasonId: 4 });
    const out = await c.adapter.pollReports();
    expect(out).toMatchObject({ seen: 12, filed: 10, refused: { rate: 2 } });
    expect(c.cw.links.list('eos-report', { state: 'skipped', limit: 10 })).toHaveLength(2);
    expect(eosLogs(c)).toContainEqual(['chatwarden.eos_report_skipped', { reason: 'refused_rate', count: 2 }]);
    c.adapter.dispose();

    const d = await eosWorld({ reports: { reasons: { 4: 'no-such-reason' } } });
    const r2 = room(d);
    report(d, { reportingPlayerId: r2.reporter, reportedPlayerId: r2.targets[0] as string, reasonId: 4 });
    expect(await d.adapter.pollReports()).toMatchObject({ filed: 0, refused: { reason_unknown: 1 } });
    d.adapter.dispose();

    const e = await eosWorld({
      wrapKit: (cw): Chatwarden =>
        new Proxy(cw, {
          get: (t, p, rcv) => (p === 'reports' ? { ...t.reports, submit: () => Promise.resolve({ ok: false as const, refused: 'suspended' as const }) } : (Reflect.get(t, p, rcv) as unknown)),
        }),
    });
    const r3 = room(e);
    report(e, { reportingPlayerId: r3.reporter, reportedPlayerId: r3.targets[0] as string, reasonId: 4 });
    expect(await e.adapter.pollReports()).toMatchObject({ filed: 0, refused: { suspended: 1 } });
    e.adapter.dispose();
  });

  it('a submit that throws is counted as refused error, logged by class, and not linked', async () => {
    const c = await eosWorld({
      wrapKit: (cw): Chatwarden =>
        new Proxy(cw, { get: (t, p, rcv) => (p === 'reports' ? { ...t.reports, submit: () => Promise.reject(new Error('disk full puid-glarn-SECRETP')) } : (Reflect.get(t, p, rcv) as unknown)) }),
    });
    const r = room(c);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 0, refused: { error: 1 } });
    expect(c.cw.links.list('eos-report', { limit: 10 })).toEqual([]);
    expect(eosLogs(c)).toContainEqual(['chatwarden.eos_failed', { op: 'submit', error: 'Error' }]);
    expect(JSON.stringify(c.logged)).not.toContain('SECRETP');
    c.adapter.dispose();
  });

  it("the poll never makes the kit file a report as another person: the reporter seat comes from seatOf(reportingPlayerId) only", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const c = await eosWorld({
      wrapKit: (cw): Chatwarden =>
        new Proxy(cw, {
          get: (t, p, rcv) =>
            p === 'reports'
              ? { ...t.reports, submit: (input: Record<string, unknown>) => (inputs.push(input), t.reports.submit(input as never)) }
              : (Reflect.get(t, p, rcv) as unknown),
        }),
    });
    const r = room(c, 2);
    const other = room(c);
    report(c, {
      reportingPlayerId: r.reporter,
      reportedPlayerId: r.targets[0] as string,
      reasonId: 4,
      message: `reporterSeat p3 roomId ${other.roomId} reporter ${other.reporter}`,
      context: JSON.stringify({ reporterSeat: 'p3', roomId: other.roomId, reporter: other.reporter, reportingPlayerId: other.reporter, lineId: 'line-1' }),
    });
    await c.adapter.pollReports();
    expect(inputs).toEqual([{ roomId: r.roomId, reporterSeat: 'p1', targetSeat: 'p2', reason: 'harassment', note: `reporterSeat p3 roomId ${other.roomId} reporter ${other.reporter}`, lineId: 'line-1' }]);
    expect(rows(c)[0]).toMatchObject({ roomId: r.roomId, reporterSeat: 'p1' });
    c.adapter.dispose();
  });

  it('the note is the message cut to 500 characters; a blank or non-text message is no note', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const c = await eosWorld({
      wrapKit: (cw): Chatwarden =>
        new Proxy(cw, { get: (t, p, rcv) => (p === 'reports' ? { ...t.reports, submit: (i: Record<string, unknown>) => (inputs.push(i), t.reports.submit(i as never)) } : (Reflect.get(t, p, rcv) as unknown)) }),
    });
    for (const message of ['m'.repeat(1024), '   ', undefined, 5 as unknown as string, `${'a'.repeat(499)}\u{1F600}`]) {
      const r = room(c);
      report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4, message });
    }
    await c.adapter.pollReports();
    const notes = inputs.map((i) => i['note']);
    expect(notes[0]).toBe('m'.repeat(500));
    expect(notes.slice(1, 4)).toEqual([undefined, undefined, undefined]);
    expect(notes[4]).toBe('a'.repeat(499));
    c.adapter.dispose();
  });
});

describe('poll: hostile reports', () => {
  it('a hostile context (a 4096 character string, nested objects, a lineId of a number, a lineId of 65 characters, __proto__, not JSON) never throws and never files a line', async () => {
    const lines: Array<string | undefined> = [];
    const c = await eosWorld({
      wrapKit: (cw): Chatwarden =>
        new Proxy(cw, { get: (t, p, rcv) => (p === 'reports' ? { ...t.reports, submit: (i: { lineId?: string }) => (lines.push(i.lineId), t.reports.submit(i as never)) } : (Reflect.get(t, p, rcv) as unknown)) }),
    });
    const contexts: Array<[string | undefined, string | undefined]> = [
      [JSON.stringify({ lineId: 'ok-line' }), 'ok-line'],
      [JSON.stringify({ lineId: 'x'.repeat(64) }), 'x'.repeat(64)],
      [JSON.stringify({ lineId: 'x'.repeat(65) }), undefined],
      [JSON.stringify({ lineId: 5 }), undefined],
      [JSON.stringify({ lineId: ['a'] }), undefined],
      [JSON.stringify({ lineId: { id: 'a' } }), undefined],
      [JSON.stringify({ lineId: '' }), undefined],
      [JSON.stringify({ lineId: 'has space' }), undefined],
      [JSON.stringify({ lineId: 'ctl\u0007' }), undefined],
      [JSON.stringify({ nested: { lineId: 'deep' } }), undefined],
      ['{"__proto__":{"lineId":"polluted"},"constructor":{"lineId":"c"}}', undefined],
      ['{"__proto__":"x","lineId":"after-proto"}', 'after-proto'],
      [JSON.stringify(['lineId']), undefined],
      ['null', undefined],
      ['"lineId"', undefined],
      ['not json {', undefined],
      [`{"lineId":"ok","pad":"${'p'.repeat(5000)}"}`, undefined],
      ['"' + 'z'.repeat(4094) + '"', undefined],
      [undefined, undefined],
    ];
    for (const [context] of contexts) {
      const r = room(c);
      report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4, ...(context === undefined ? {} : { context }) });
    }
    await expect(c.adapter.pollReports()).resolves.toMatchObject({ seen: contexts.length, filed: contexts.length });
    expect(lines).toEqual(contexts.map(([, want]) => want));
    expect(({} as Record<string, unknown>)['lineId']).toBeUndefined();
    c.adapter.dispose();
  });

  it('malformed elements are skipped as malformed without a link or a throw: not objects, missing or mistyped ids, bad time, bad reason id', async () => {
    const c = await eosWorld();
    const r = room(c);
    const good = report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    const t = good.time;
    const base = { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 3, time: t };
    const junk: unknown[] = [
      null,
      5,
      'text',
      [],
      {},
      { ...base, reportingPlayerId: 5 },
      { ...base, reportedPlayerId: '' },
      { ...base, reportedPlayerId: 'has space' },
      { ...base, time: 'yesterday' },
      { ...base, time: 5 },
      { ...base, time: '2026-11-16T10:00:00' },
      { ...base, time: 'x'.repeat(100) },
      { ...base, reasonId: '3' },
      { ...base, reasonId: 3.5 },
      { ...base, reasonId: -1 },
      { ...base, reasonId: null },
    ];
    c.fake.script.push({ on: 'reports', status: 200, body: { elements: [...junk, { ...good, productId: 'p' }], paging: { total: junk.length + 1, offset: 0, limit: 50 } } });
    const out = await c.adapter.pollReports();
    expect(out).toEqual({ seen: junk.length + 1, filed: 1, skipped: { malformed: junk.length }, refused: {} });
    expect(c.cw.links.list('eos-report', { limit: 50 })).toHaveLength(1);
    c.adapter.dispose();
  });

  it('an answer that is not a page (no elements, elements that are not a list, an array, text, null) is a bad answer: logged, nothing filed, the cursor not moved', async () => {
    for (const body of [{}, { elements: 'x' }, { elements: { 0: {} } }, [], 'text', null]) {
      const c = await eosWorld();
      const r = room(c);
      report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
      await c.adapter.pollReports(); // sets the cursor and files the report
      const before = cursor(c);
      c.fake.reports.length = 0;
      c.logged.length = 0;
      c.fake.script.push({ on: 'reports', status: 200, body });
      const out = await c.adapter.pollReports();
      expect(out, JSON.stringify(body)).toMatchObject({ seen: 0, filed: 0 });
      expect(eosLogs(c), JSON.stringify(body)).toEqual([['chatwarden.eos_failed', { op: 'poll', error: 'BadAnswer' }]]);
      expect(cursor(c)).toEqual(before);
      c.adapter.dispose();
    }
  });

  it('a page is cut at 100 elements however many come back, and an endless run of full pages stops at 20 pages', async () => {
    const c = await eosWorld();
    const r = room(c);
    const one = report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    c.fake.reports.length = 0;
    // A page of 300 distinct, valid, unseated reports: only 100 are looked at.
    const flood = Array.from({ length: 300 }, (_, i) => ({ ...one, reportingPlayerId: `puid-flood-${i}` }));
    c.fake.script.push({ on: 'reports', status: 200, body: { elements: flood, paging: { total: 300, offset: 0, limit: 50 } } });
    const out = await c.adapter.pollReports();
    expect(out.seen).toBe(100);
    c.adapter.dispose();

    const d = await eosWorld({ reports: { maxPerPoll: 1000 } });
    const r2 = room(d);
    const known = { time: iso(d.w.clock.t), reportingPlayerId: r2.reporter, reportedPlayerId: r2.targets[0] as string, reasonId: 4 };
    for (let i = 0; i < 40; i++) d.fake.script.push({ on: 'reports', status: 200, body: { elements: Array.from({ length: 50 }, (_, j) => ({ ...known, reasonId: 1 + ((i * 50 + j) % 7), time: iso(d.w.clock.t - (i * 50 + j) * 1000) })) } });
    await d.adapter.pollReports();
    expect(find(d)).toHaveLength(20);
    d.adapter.dispose();
  });
});

describe('poll: dedupe and the cursor', () => {
  it('the same report on two polls, and across the 10 minute overlap, is filed once; two reports with the same time and ids but another reason are two', async () => {
    const c = await eosWorld();
    const r = room(c, 2);
    const t = iso(c.w.clock.t - MIN);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4, time: t });
    expect(await c.adapter.pollReports()).toMatchObject({ seen: 1, filed: 1 });
    c.w.clock.t += 5 * MIN; // the overlap still returns it
    expect(await c.adapter.pollReports()).toMatchObject({ seen: 1, filed: 0 });
    // The cursor starts at the first poll's now and only moves forward, so the window is the same ten minutes back from it.
    expect(find(c).at(-1)?.query.find(([k]) => k === 'startTime')?.[1]).toBe(iso(Date.parse(t) + MIN - 10 * MIN));
    // Same time and ids, another reason: a second report. (Another target so the kit's own duplicate rule does not apply.)
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[1] as string, reasonId: 4, time: t });
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[1] as string, reasonId: 5, time: t });
    const out = await c.adapter.pollReports();
    expect(out.seen).toBe(3);
    expect(out.filed + (out.refused['duplicate'] ?? 0)).toBe(2);
    expect(c.cw.links.list('eos-report', { limit: 10 })).toHaveLength(3);
    // The very same report twice in one page is one.
    const dup = report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 6, time: iso(c.w.clock.t - 2 * MIN) });
    c.fake.reports.push({ ...dup });
    const before = c.cw.links.list('eos-report', { limit: 20 }).length;
    await c.adapter.pollReports();
    expect(c.cw.links.list('eos-report', { limit: 20 }).length).toBe(before + 1);
    c.adapter.dispose();
  });

  it('the first poll starts 10 minutes before now and stores now as the cursor; later polls move it to the newest report time seen and never back', async () => {
    const c = await eosWorld();
    const r = room(c);
    c.players.push('puid-someone');
    await c.adapter.pollReports();
    const start = c.w.clock.t;
    expect(cursor(c)).toMatchObject({ system: 'eos-cursor', ref: 'reports', external: iso(start), state: 'cursor', at: start });
    expect(find(c)[0]?.query.find(([k]) => k === 'startTime')?.[1]).toBe(iso(start - 10 * MIN));
    c.w.clock.t += 5 * MIN;
    const newer = iso(start + 2 * MIN);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4, time: newer });
    await c.adapter.pollReports();
    expect(cursor(c)?.external).toBe(newer);
    expect(find(c).at(-1)?.query.find(([k]) => k === 'startTime')?.[1]).toBe(iso(start - 10 * MIN));
    // An older report arriving later does not pull it back.
    c.w.clock.t += MIN;
    report(c, { reportingPlayerId: 'puid-old', reportedPlayerId: r.targets[0] as string, reasonId: 4, time: iso(start - 5 * MIN) });
    await c.adapter.pollReports();
    expect(cursor(c)?.external).toBe(newer);
    c.adapter.dispose();
  });

  it('a time in the future cannot move the cursor past now plus a minute', async () => {
    const c = await eosWorld();
    const r = room(c, 3);
    await c.adapter.pollReports();
    for (const [i, future] of [iso(c.w.clock.t + 3_600_000), '9999-12-31T23:59:59.999Z', iso(c.w.clock.t + 61_000)].entries()) {
      report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[i] as string, reasonId: 4, time: future });
    }
    await c.adapter.pollReports();
    expect(cursor(c)?.external).toBe(iso(c.w.clock.t + 60_000));
    // The report itself is still handled (a future time is the client's lie, not a reason to lose it); its createdAt is the kit's clock.
    expect(rows(c)).toHaveLength(3);
    expect(rows(c).every((x) => x.createdAt === c.w.clock.t)).toBe(true);
    c.adapter.dispose();
  });

  it('a time far in the past is found only within the 10 minute overlap, and is otherwise missed (documented)', async () => {
    const c = await eosWorld();
    const r = room(c, 2);
    c.players.push('puid-x');
    await c.adapter.pollReports();
    const start = c.w.clock.t;
    c.w.clock.t += MIN;
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4, time: iso(start - 9 * MIN) });
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[1] as string, reasonId: 4, time: iso(start - 11 * MIN) });
    expect(await c.adapter.pollReports()).toMatchObject({ seen: 1, filed: 1 });
    c.adapter.dispose();
  });

  it('an unreadable stored cursor is treated as none', async () => {
    const c = await eosWorld();
    c.players.push('puid-x');
    c.cw.links.put({ system: 'eos-cursor', ref: 'reports', external: 'not-a-time', state: 'cursor', at: 1 });
    await c.adapter.pollReports();
    expect(find(c)[0]?.query.find(([k]) => k === 'startTime')?.[1]).toBe(iso(c.w.clock.t - 10 * MIN));
    expect(cursor(c)?.external).toBe(iso(c.w.clock.t));
    c.adapter.dispose();
  });
});

describe('poll: bounds and failures', () => {
  it('maxPerPoll caps the new reports one poll handles; the rest are picked up by the next polls, each filed once, and the cursor never passes what was not handled', async () => {
    const c = await eosWorld({ reports: { maxPerPoll: 2 } });
    const r = room(c, 5);
    c.players.push('puid-x');
    await c.adapter.pollReports();
    const start = c.w.clock.t;
    c.w.clock.t += 10 * MIN;
    r.targets.forEach((t, i) => report(c, { reportingPlayerId: r.reporter, reportedPlayerId: t, reasonId: 4, time: iso(start + (i + 1) * 1000) }));
    const first = await c.adapter.pollReports();
    expect(first.filed).toBe(2);
    expect(Date.parse(cursor(c)?.external ?? '')).toBeLessThan(start + 3000);
    const second = await c.adapter.pollReports();
    expect(second.filed).toBe(2);
    const third = await c.adapter.pollReports();
    expect(third.filed).toBe(1);
    expect(rows(c)).toHaveLength(5);
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 0 });
    expect(cursor(c)?.external).toBe(iso(start + 5000));
    c.adapter.dispose();
  });

  it('a 5xx ends the poll with a log by status and leaves the cursor; the next poll tries again; a 4xx is the same; no request is retried inside a poll', async () => {
    const c = await eosWorld();
    const r = room(c);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    c.fake.script.push({ on: 'reports', status: 503 });
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 0 });
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'poll', status: 503 }]]);
    expect(find(c)).toHaveLength(1);
    expect(cursor(c)?.external).toBe(iso(c.w.clock.t));
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 1 });
    c.logged.length = 0;
    c.fake.script.push({ on: 'reports', status: 400 });
    await c.adapter.pollReports();
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'poll', status: 400 }]]);
    c.adapter.dispose();
  });

  it('a 429 pauses polling for its retry-after (between 1 and 60 seconds); polls inside the pause make no request', async () => {
    const c = await eosWorld();
    c.players.push('puid-x');
    c.fake.script.push({ on: 'reports', status: 429, headers: { 'retry-after': '30' } });
    await c.adapter.pollReports();
    expect(find(c)).toHaveLength(1);
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'poll', status: 429 }]]);
    c.w.clock.t += 29_000;
    await c.adapter.pollReports();
    expect(find(c)).toHaveLength(1);
    c.w.clock.t += 1000;
    await c.adapter.pollReports();
    expect(find(c)).toHaveLength(2);
    // A huge or junk retry-after is clamped (60 s); none at all is 60 s too.
    for (const [header, wait] of [['99999', 60_000], ['abc', 60_000], ['0', 1000]] as const) {
      c.fake.script.push({ on: 'reports', status: 429, headers: { 'retry-after': header } });
      await c.adapter.pollReports();
      const calls = find(c).length;
      c.w.clock.t += wait - 1;
      await c.adapter.pollReports();
      expect(find(c).length, header).toBe(calls);
      c.w.clock.t += 1;
      await c.adapter.pollReports();
      expect(find(c).length, header).toBe(calls + 1);
    }
    c.adapter.dispose();
  });

  it('a 401 refreshes the token once and the poll goes through', async () => {
    const c = await eosWorld();
    const r = room(c);
    await c.adapter.pollReports();
    c.fake.expireTokens();
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 1 });
    expect(c.fake.tokensIssued()).toBe(2);
    c.adapter.dispose();
  });

  it('a failure on one batch leaves the cursor at its old place so the failed players are not lost, while the good batch is filed', async () => {
    const c = await eosWorld({ reports: { batch: 1 } });
    const a = room(c);
    const b = room(c);
    c.players.length = 0;
    c.players.push(a.targets[0] as string, b.targets[0] as string);
    await c.adapter.pollReports();
    const start = c.w.clock.t;
    c.w.clock.t += MIN;
    report(c, { reportingPlayerId: a.reporter, reportedPlayerId: a.targets[0] as string, reasonId: 4, time: iso(start + 10_000) });
    report(c, { reportingPlayerId: b.reporter, reportedPlayerId: b.targets[0] as string, reasonId: 4, time: iso(start + 20_000) });
    // Batch one answers; batch two fails.
    c.fake.script.push({ on: 'reports', status: 200, body: { elements: c.fake.reports.filter((x) => x.reportedPlayerId === a.targets[0]).map((x) => ({ ...x })), paging: { total: 1, offset: 0, limit: 50 } } });
    c.fake.script.push({ on: 'reports', status: 503 });
    const out = await c.adapter.pollReports();
    expect(out).toMatchObject({ filed: 1 });
    expect(Date.parse(cursor(c)?.external ?? '')).toBeLessThanOrEqual(start + 10_000);
    expect(await c.adapter.pollReports()).toMatchObject({ filed: 1 });
    expect(rows(c)).toHaveLength(2);
    c.adapter.dispose();
  });

  it('a link write that fails is logged by class; the report was filed and nothing throws', async () => {
    const c = await eosWorld({
      wrapKit: (cw): Chatwarden =>
        new Proxy(cw, {
          get: (t, p, rcv) =>
            p === 'links'
              ? { supported: true, get: (a: never, b: string) => t.links.get(a, b), put: () => { throw new Error('disk full puid-glarn-SECRETP'); }, list: (a: never, q?: never) => t.links.list(a, q) }
              : (Reflect.get(t, p, rcv) as unknown),
        }),
    });
    const r = room(c);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    await expect(c.adapter.pollReports()).resolves.toMatchObject({ filed: 1 });
    expect(eosLogs(c).every(([e, d]) => e === 'chatwarden.eos_failed' && d?.['op'] === 'link' && d['error'] === 'Error')).toBe(true);
    expect(JSON.stringify(c.logged)).not.toContain('SECRETP');
    c.adapter.dispose();
  });

  it('two polls started together share one run', async () => {
    const c = await eosWorld();
    const r = room(c);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    const [a, b] = await Promise.all([c.adapter.pollReports(), c.adapter.pollReports()]);
    expect(a).toBe(b);
    expect(find(c)).toHaveLength(1);
    c.adapter.dispose();
  });
});

describe('poll: nothing identifying leaves in a log or an error', () => {
  it('seeded user ids, messages and contexts appear in no log line in any failure', async () => {
    const SEED_ID = 'puid-glarn-SECRETP';
    const SEED_MSG = 'snerp-message-SECRETM tarvo';
    const SEED_CTX = 'SECRETC-context-vlemmo';
    const c = await eosWorld();
    const r = room(c, 3);
    const t = r.targets;
    // Skips, refusals, malformed answers, failing maps and a 5xx, all with the seeds in play.
    report(c, { reportingPlayerId: SEED_ID, reportedPlayerId: t[0] as string, reasonId: 4, message: SEED_MSG, context: JSON.stringify({ x: SEED_CTX, lineId: SEED_CTX }) });
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: t[1] as string, reasonId: 4, message: SEED_MSG, context: `{${SEED_CTX}` });
    c.fake.script.push({ on: 'reports', status: 200, body: { elements: [{ reportingPlayerId: SEED_ID, reportedPlayerId: SEED_MSG, time: SEED_CTX, reasonId: 4 }] } });
    await c.adapter.pollReports();
    c.fake.script.push({ on: 'reports', status: 500, body: { echoed: SEED_ID, message: SEED_MSG } });
    await c.adapter.pollReports();
    c.fake.script.push({ on: 'reports', status: 200, body: { elements: SEED_MSG } });
    await c.adapter.pollReports();
    const text = JSON.stringify(c.logged);
    expect(eosLogs(c).length).toBeGreaterThan(0);
    for (const seed of [SEED_ID, SEED_MSG, SEED_CTX, 'SECRET', ...t, r.reporter, r.roomId, 'fake-access-token', 'fake-secret-quissel']) expect(text).not.toContain(seed);
    const stored = JSON.stringify(c.cw.links.list('eos-report', { limit: 100 })) + JSON.stringify(cursor(c));
    for (const seed of [SEED_ID, SEED_MSG, SEED_CTX, ...t, r.reporter]) expect(stored).not.toContain(seed);
    c.adapter.dispose();
  });
});

describe('start, stop, dispose', () => {
  it('start polls on the timer, skips a poll that is still running, does not keep the process alive, and stop and dispose end it', async () => {
    const c = await eosWorld({ reports: { pollMs: 1000 } });
    const r = room(c);
    const spy = vi.spyOn(globalThis, 'setInterval');
    c.adapter.start();
    c.adapter.start();
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]?.value as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    spy.mockRestore();
    c.adapter.stop();
    c.adapter.stop();

    vi.useFakeTimers();
    c.players.length = 0;
    c.players.push(r.targets[0] as string);
    c.adapter.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(find(c)).toHaveLength(3);
    c.adapter.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(find(c)).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);

    // A poll still running at the next tick is skipped.
    c.fake.script.push({ on: 'reports', hang: true });
    c.adapter.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(find(c)).toHaveLength(4);
    c.adapter.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(find(c)).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    c.adapter.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(find(c)).toHaveLength(4);
    expect(await c.adapter.pollReports()).toEqual({ seen: 0, filed: 0, skipped: {}, refused: {} });
  });

  it('dispose aborts the poll in flight and nothing is written afterwards', async () => {
    const c = await eosWorld();
    const r = room(c);
    report(c, { reportingPlayerId: r.reporter, reportedPlayerId: r.targets[0] as string, reasonId: 4 });
    c.fake.script.push({ on: 'reports', hang: true });
    const pending = c.adapter.pollReports();
    await until(() => find(c).length === 1, 'the request');
    c.adapter.dispose();
    await expect(pending).resolves.toMatchObject({ filed: 0 });
    expect(rows(c)).toEqual([]);
    expect(c.cw.links.list('eos-report', { limit: 10 })).toEqual([]);
    expect(cursor(c)?.external).toBe(iso(c.w.clock.t));
  });

  it('with reports not configured, pollReports files nothing and start sets no timer', async () => {
    const c = await eosWorld({ reports: false });
    const spy = vi.spyOn(globalThis, 'setInterval');
    c.adapter.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(await c.adapter.pollReports()).toEqual({ seen: 0, filed: 0, skipped: {}, refused: {} });
    c.adapter.dispose();
  });
});
