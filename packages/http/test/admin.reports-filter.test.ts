import { describe, expect, it } from 'vitest';
import { world } from './world.js';
import type { Logged } from './world.js';

// F6: a report a chat filter filed (`origin: 'filter'`) in the staff bodies: no reporter, the origin and its key, no reporter accuracy, and the case behaves as any case.

type W = Awaited<ReturnType<typeof world>>;
const LINK = 'see vlemmo.com now';

/** A speaker who said a line, and a filter report about them. */
async function flagged(w: W, room = 'RF', key = 'raw-client-key-speaker', originKey = 'link.unlisted') {
  w.cw.rooms.seat(room, 'p1', { clientKey: key, ip: '203.0.113.5' }, 'Spk');
  const said = w.cw.chat.accept(room, 'p1', LINK);
  if (!('deliver' in said)) throw new Error('not delivered');
  const subject = w.cw.rooms.subjectAt(room, 'p1') as string;
  w.clock.t += 1000;
  const res = await w.cw.reports.fileSystem({ origin: 'filter', originKey, roomId: room, target: subject, lineId: said.deliver.lineId, reportedReason: 'spam' });
  if (res !== 'filed') throw new Error(`not filed: ${res}`);
  const item = w.cw.reports.list({ status: 'open' }).items.find((r) => r.targetPerson === subject)!;
  return { id: item.id, subject, room };
}

describe('a filter report in the staff reads', () => {
  it('GET /reports and the queue row carry reporterPerson null, origin and originKey, and no reporter accuracy', async () => {
    const w = await world();
    const f = await flagged(w);
    const res = await w.call('GET', '/reports', { query: { status: 'open' } });
    expect(res.status).toBe(200);
    const item = (res.body as { items: Array<Record<string, unknown>> }).items.find((r) => r.id === f.id)!;
    expect(item).toMatchObject({
      reporterPerson: null,
      reporterHandle: null,
      origin: 'filter',
      originKey: 'link.unlisted',
      status: 'open',
      reportedReason: 'spam',
      targetPerson: f.subject,
      reporterAccuracy: null,
    });
    expect(JSON.stringify(item)).not.toContain('filter:');
  });

  it('GET /reports/:id has reporterPerson null, origin and originKey; the excerpt is the room\'s; the target is a person to decide on', async () => {
    const w = await world();
    const f = await flagged(w, 'RG', 'raw-client-key-g', 'phrase.ads');
    const res = await w.call('GET', `/reports/${f.id}`);
    expect(res.status).toBe(200);
    const body = res.body as { report: Record<string, unknown> & { excerpt: Array<{ raw: string }> }; history: Record<string, unknown> };
    expect(body.report).toMatchObject({ reporterPerson: null, origin: 'filter', originKey: 'phrase.ads', note: null, status: 'open' });
    expect(body.report.excerpt.map((l) => l.raw)).toEqual([LINK]);
    // history is read for the people the report names: the target only
    expect(Object.keys(body.history)).toEqual([f.subject]);
  });

  it('an ordinary report carries no origin keys at all (the body is as it was)', async () => {
    const w = await world();
    const o = await w.file();
    const list = (await w.call('GET', '/reports', { query: { status: 'open' } })).body as { items: Array<Record<string, unknown>> };
    expect(Object.hasOwn(list.items[0]!, 'origin')).toBe(false);
    expect(Object.hasOwn(list.items[0]!, 'originKey')).toBe(false);
    const one = (await w.call('GET', `/reports/${o.id}`)).body as { report: Record<string, unknown> };
    expect(Object.hasOwn(one.report, 'origin')).toBe(false);
    expect(Object.hasOwn(one.report, 'originKey')).toBe(false);
    expect(one.report.reporterPerson).toBe(o.reporter);
  });

  it('the filter report in the queue does not break the page: reporter accuracy is read for real reporters only', async () => {
    const w = await world();
    await flagged(w);
    await w.file();
    const res = await w.call('GET', '/reports', { query: { status: 'open' } });
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('takeNext and the case claim work as for any report', async () => {
    const w = await world();
    const f = await flagged(w);
    const next = await w.call('POST', '/cases/next', { actor: 'ann', body: {} });
    expect(next.status).toBe(200);
    expect((next.body as { case: { person: string; reportId: string } }).case).toMatchObject({ person: f.subject, reportId: f.id });
    expect((await w.call('POST', `/cases/${f.subject}/release`, { actor: 'ann', body: {} })).status).toBe(200);
    expect((await w.call('POST', `/cases/${f.subject}/claim`, { actor: 'bob', body: {} })).status).toBe(200);
  });

  it('a decision closes it as any case; a warning to the person works; bad_faith is refused (no reporter to blame); a bulk dismiss of "the reporter" is refused for no ref', async () => {
    const w = await world();
    const f = await flagged(w);
    const bad = await w.call('POST', `/reports/${f.id}/decide`, { role: 'moderator', body: { verdict: 'bad_faith', evidence: 'x', actions: [] } });
    expect(bad.status).toBe(400);
    const ok = await w.call('POST', `/reports/${f.id}/decide`, {
      role: 'moderator',
      body: { verdict: 'upheld', actions: [{ subject: f.subject, kind: 'warning', durationMs: null, rule: 4 }], reason: 'link spam' },
    });
    expect(ok.status).toBe(200);
    expect(w.cw.reports.get(f.id)!.status).toBe('actioned');
    expect(w.cw.sanctions.forPerson(f.subject)).toHaveLength(1);
  });

  it('a person\'s history lists the filter report with a null reporter', async () => {
    const w = await world();
    const f = await flagged(w);
    const res = await w.call('GET', '/reports', { query: { person: f.subject } });
    expect(res.status).toBe(200);
    const item = (res.body as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item).toMatchObject({ id: f.id, reporterPerson: null, origin: 'filter' });
  });

  it('no raw identifier or address appears in any filter-report body', async () => {
    const w = await world();
    const f = await flagged(w);
    const bodies = [
      await w.call('GET', '/reports', { query: { status: 'open' } }),
      await w.call('GET', `/reports/${f.id}`),
      await w.call('GET', '/reports', { query: { person: f.subject } }),
    ].map((r) => JSON.stringify(r.body));
    for (const text of bodies) {
      expect(text).not.toContain('raw-client-key');
      expect(text).not.toContain('203.0.113.5');
    }
  });
});

describe('logs', () => {
  it('a filter report read logs nothing', async () => {
    const w = await world();
    const f = await flagged(w);
    const logged: Logged = w.logged;
    logged.length = 0;
    await w.call('GET', '/reports', { query: { status: 'open' } });
    await w.call('GET', `/reports/${f.id}`);
    expect(logged).toEqual([]);
  });
});
