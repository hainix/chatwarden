import { describe, expect, it } from 'vitest';
import { world } from './world.js';

// R4: what GET /reports/:id gains: `surge` (only with desk.surge on and the person over the threshold), `evidence: { ref, url } | null`, and on each excerpt line `retracted` and `removable`. The queue summary carries none
// of them. The raw evidenceRef column never appears under its own name.

type W = Awaited<ReturnType<typeof world>>;
let n = 0;

async function fileWith(w: W, o: { evidenceRef?: string; targetKey?: string } = {}) {
  n += 1;
  const room = `case-room-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `case-reporter-${n}-aaaaaaaaaaaa` }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: o.targetKey ?? `case-target-${n}-bbbbbbbbbbbb` }, 'TargetName');
  const said = w.cw.chat.accept(room, 'p2', `a line from the target ${n}`);
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', reason: 'harassment', ...(o.evidenceRef === undefined ? {} : { evidenceRef: o.evidenceRef }) });
  if (!res.ok) throw new Error(res.refused);
  return { id: res.reportId, room, lineId: 'deliver' in said ? said.deliver.lineId : '' };
}

const detail = async (w: W, id: string) => ((await w.call('GET', `/reports/${id}`)).body as { report: Record<string, unknown> & { excerpt: Array<Record<string, unknown>> } }).report;

describe('surge', () => {
  const ON = { overrides: { desk: { surge: { enabled: true, reports: 3, windowMinutes: 10, newAccountDays: 2 } } } } as const;

  it('appears only with desk.surge on and the person over the threshold, with counts only', async () => {
    const w = await world(ON);
    const key = 'case-surge-target-aaaaaaaaaaa';
    const a = await fileWith(w, { targetKey: key });
    await fileWith(w, { targetKey: key });
    expect('surge' in (await detail(w, a.id))).toBe(false);
    await fileWith(w, { targetKey: key });
    const report = await detail(w, a.id);
    expect(report.surge).toEqual({ reports: 3, reporters: 3, windowMinutes: 10, newAccounts: null, newAccountDays: 2 });
  });

  it('with desk.surge off the key is not there at all, over the threshold or not', async () => {
    const w = await world();
    const key = 'case-nosurge-target-aaaaaaaaaa';
    const a = await fileWith(w, { targetKey: key });
    for (let i = 0; i < 6; i += 1) await fileWith(w, { targetKey: key });
    expect('surge' in (await detail(w, a.id))).toBe(false);
  });

  it('the queue summary never carries a surge, an evidence read or the raw ref', async () => {
    const w = await world(ON);
    const key = 'case-summary-target-aaaaaaaaa';
    for (let i = 0; i < 4; i += 1) await fileWith(w, { targetKey: key, evidenceRef: `match_${i}` });
    const list = (await w.call('GET', '/reports', { query: { status: 'open' } })).body as { items: Array<Record<string, unknown>> };
    expect(list.items.length).toBe(4);
    for (const item of list.items) for (const k of ['surge', 'evidence', 'evidenceRef', 'removable']) expect(Object.keys(item), k).not.toContain(k);
  });
});

describe('evidence', () => {
  it('is null with no ref, { ref, url: null } with a ref and no template, and a url only for an https template', async () => {
    const none = await world();
    expect((await detail(none, (await fileWith(none)).id)).evidence).toBeNull();
    expect((await detail(none, (await fileWith(none, { evidenceRef: 'match_42' })).id)).evidence).toEqual({ ref: 'match_42', url: null });
    const tpl = await world({ overrides: { reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } });
    expect((await detail(tpl, (await fileWith(tpl, { evidenceRef: 'match_42:t-1' })).id)).evidence).toEqual({ ref: 'match_42:t-1', url: 'https://replays.example.test/m/match_42%3At-1' });
  });

  it('the raw evidenceRef column is not in the body under its own name', async () => {
    const w = await world({ overrides: { reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } });
    const report = await detail(w, (await fileWith(w, { evidenceRef: 'match_9' })).id);
    expect(Object.keys(report)).not.toContain('evidenceRef');
    expect(report.evidence).toEqual({ ref: 'match_9', url: 'https://replays.example.test/m/match_9' });
  });

  it('the ref is in no event the case read raises and in no audit row', async () => {
    const w = await world();
    const f = await fileWith(w, { evidenceRef: 'match_SENTINEL' });
    await detail(w, f.id);
    expect(JSON.stringify(w.routeAudit())).not.toContain('SENTINEL');
  });
});

describe('excerpt lines', () => {
  it('carry retracted and removable on every line: a line still in the buffer is removable', async () => {
    const w = await world();
    const f = await fileWith(w);
    const report = await detail(w, f.id);
    expect(report.excerpt.length).toBeGreaterThan(0);
    for (const line of report.excerpt) {
      expect(typeof line.retracted).toBe('boolean');
      expect(typeof line.removable).toBe('boolean');
    }
    expect(report.excerpt.find((l) => l.lineId === f.lineId)).toMatchObject({ retracted: false, removable: true });
  });

  it('a line retracted after the report was filed reads retracted and no longer removable; the stored text stays', async () => {
    const w = await world();
    const f = await fileWith(w);
    expect(w.cw.rooms.retract(f.room, f.lineId).ok).toBe(true);
    const line = (await detail(w, f.id)).excerpt.find((l) => l.lineId === f.lineId);
    expect(line).toMatchObject({ retracted: true, removable: false });
    expect(String(line?.raw)).toContain('a line from the target');
  });

  it('a report filed after a retraction carries retracted from the start', async () => {
    const w = await world();
    const first = await fileWith(w);
    w.cw.rooms.retract(first.room, first.lineId);
    w.cw.rooms.seat(first.room, 'p3', { clientKey: 'case-third-aaaaaaaaaaaaaaaa' }, 'Third');
    const res = await w.cw.reports.submit({ roomId: first.room, reporterSeat: 'p3', targetSeat: 'p2' });
    if (!res.ok) throw new Error(res.refused);
    expect((await detail(w, res.reportId)).excerpt.find((l) => l.lineId === first.lineId)).toMatchObject({ retracted: true, removable: false });
  });

  it('a line that has left the evidence window is not removable, and not retracted if it never was', async () => {
    const w = await world();
    const f = await fileWith(w);
    w.clock.t += 16 * 60_000;
    expect((await detail(w, f.id)).excerpt.find((l) => l.lineId === f.lineId)).toMatchObject({ retracted: false, removable: false });
  });

  it('a room that was closed and reopened does not make an old report\'s line removable (ids restart)', async () => {
    const w = await world();
    const f = await fileWith(w);
    w.cw.rooms.close(f.room);
    w.cw.rooms.seat(f.room, 'p1', { clientKey: 'case-reopen-aaaaaaaaaaaaaaaaa' }, 'New');
    w.clock.t += 1000;
    const again = w.cw.chat.accept(f.room, 'p1', 'a different first line');
    expect('deliver' in again && again.deliver.lineId).toBe(f.lineId);
    expect((await detail(w, f.id)).excerpt.find((l) => l.lineId === f.lineId)).toMatchObject({ removable: false });
  });

  it('a blocked line was never delivered and is not removable', async () => {
    const w = await world({ matcher: { match: (t: string) => (/\bzorbak\b/i.test(t) ? { termId: 'syn:zorbak' } : null), spans: () => [] } });
    w.cw.rooms.seat('B1', 'p1', { clientKey: 'case-blocked-rep-aaaaaaaaaaaa' }, 'Rep');
    w.cw.rooms.seat('B1', 'p2', { clientKey: 'case-blocked-tgt-aaaaaaaaaaaa' }, 'Tgt');
    w.cw.chat.accept('B1', 'p2', 'you zorbak');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: 'B1', reporterSeat: 'p1', targetSeat: 'p2' });
    if (!res.ok) throw new Error(res.refused);
    const blocked = (await detail(w, res.reportId)).excerpt.find((l) => l.blocked === true);
    expect(blocked).toMatchObject({ removable: false, retracted: false });
  });

  it('reading the case never changes a line: the same read twice is the same', async () => {
    const w = await world();
    const f = await fileWith(w);
    const a = await detail(w, f.id);
    const b = await detail(w, f.id);
    expect(a.excerpt).toEqual(b.excerpt);
  });
});
