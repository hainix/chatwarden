import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@chatwarden/http';
import { errorOf, keysDeep, world } from './world.js';

// U5: the urgent lane over the staff routes. `reports.urgent` and `reports.handoff` are a moderator's by default; every route is no-store JSON.

type W = Awaited<ReturnType<typeof world>>;
let n = 0;

/** One open report under a reason id, against a new person (or `targetKey`'s). */
async function fileUnder(w: W, reason: string, targetKey?: string) {
  n += 1;
  const room = `urg-room-${n}`;
  const key = targetKey ?? `urg-target-key-${n}-aaaaaaaaaaaa`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `urg-reporter-key-${n}-bbbbbbbbbbbb` }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: key }, 'TargetName');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', reason, note: 'a note about quissel' });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  if (report === null) throw new Error('missing');
  return { id: res.reportId, target: report.targetPerson, key };
}

const items = (res: { body: unknown }) => (res.body as { items: Array<Record<string, unknown>> }).items;

describe('permission boundaries', () => {
  it('reports.urgent and reports.handoff are a moderator\'s by default and follow the permissions option', async () => {
    expect(PERMISSIONS['reports.urgent']).toBe('moderator');
    expect(PERMISSIONS['reports.handoff']).toBe('moderator');
    const w = await world({ permissions: { 'reports.urgent': 'senior', 'reports.handoff': 'owner' } });
    const f = await fileUnder(w, 'harassment');
    expect((await w.call('POST', `/reports/${f.id}/urgent`, { role: 'moderator', body: { on: true } })).status).toBe(403);
    expect((await w.call('POST', `/reports/${f.id}/urgent`, { role: 'senior', body: { on: true } })).status).toBe(200);
    expect((await w.call('POST', `/reports/${f.id}/handoff`, { role: 'senior', body: {} })).status).toBe(403);
    expect((await w.call('POST', `/reports/${f.id}/handoff`, { role: 'owner', body: {} })).status).toBe(200);
    expect((await w.call('POST', `/reports/${f.id}/urgent`, { role: null, body: { on: true } })).status).toBe(401);
  });

  it('every route answers no-store JSON', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    for (const [method, path, body] of [
      ['GET', '/reports', undefined],
      ['POST', `/reports/${f.id}/urgent`, { on: true }],
      ['POST', `/reports/${f.id}/handoff`, {}],
      ['GET', '/changes', undefined],
    ] as const) {
      const res = await w.call(method, path, { ...(body === undefined ? {} : { body }), query: path === '/reports' ? { status: 'open', urgent: '1' } : {} });
      expect(res.status, path).toBe(200);
      expect(res.headers?.['cache-control'], path).toBe('no-store');
      expect(res.headers?.['content-type'] ?? 'application/json', path).toMatch(/json/);
    }
  });
});

describe('GET /reports?urgent=1', () => {
  it('returns only open urgent summaries, older ones past the first page included', async () => {
    const w = await world();
    const old = await fileUnder(w, 'threat');
    for (let i = 0; i < 4; i++) await fileUnder(w, 'harassment');
    const newer = await fileUnder(w, 'threat');
    await fileUnder(w, 'spam');
    // the plain queue page of 3 does not reach the old urgent report; the urgent read does
    const plain = await w.call('GET', '/reports', { query: { status: 'open', limit: '3' } });
    expect(items(plain).map((r) => r.id)).not.toContain(old.id);
    const res = await w.call('GET', '/reports', { query: { status: 'open', urgent: '1' } });
    expect(res.status).toBe(200);
    expect(items(res).map((r) => r.id)).toEqual([newer.id, old.id]);
    for (const r of items(res)) expect(r).toMatchObject({ urgent: true, status: 'open' });
  });

  it('without a status it means open; a decided urgent report is not listed', async () => {
    const w = await world();
    const a = await fileUnder(w, 'threat');
    const b = await fileUnder(w, 'threat');
    await w.cw.decide({ reportId: a.id, verdict: 'no_action', actions: [], actor: 'ann' });
    const res = await w.call('GET', '/reports', { query: { urgent: '1' } });
    expect(items(res).map((r) => r.id)).toEqual([b.id]);
  });

  it('pages with the cursor', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await fileUnder(w, 'threat')).id);
    const first = await w.call('GET', '/reports', { query: { urgent: '1', limit: '2' } });
    const body1 = first.body as { items: Array<{ id: string }>; next: string | null };
    expect(body1.items.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    expect(body1.next).not.toBeNull();
    const second = await w.call('GET', '/reports', { query: { urgent: '1', limit: '10', cursor: body1.next as string } });
    expect((second.body as { items: Array<{ id: string }> }).items.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it.each([
    [{ urgent: '0' }],
    [{ urgent: 'true' }],
    [{ urgent: '' }],
    [{ urgent: '2' }],
    [{ urgent: '1', status: 'actioned' }],
    [{ urgent: '1', status: 'dismissed' }],
    [{ urgent: '1', status: 'nope' }],
  ])('a bad value or a decided status is 400 invalid_query: %j', async (query) => {
    const w = await world();
    const res = await w.call('GET', '/reports', { query });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_query']);
  });

  it('a plain GET /reports with no urgent still lists everything, urgent rows marked', async () => {
    const w = await world();
    const a = await fileUnder(w, 'threat');
    const b = await fileUnder(w, 'harassment');
    const res = await w.call('GET', '/reports', { query: { status: 'open' } });
    const rows = items(res);
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ urgent: true });
    expect('urgent' in (rows.find((r) => r.id === b.id) ?? {})).toBe(false);
  });
});

describe('the summary and the body carry urgent and nothing of the evidence', () => {
  it('ReportSummary carries urgent only when true and no excerpt, note, handle or text', async () => {
    const w = await world();
    const urgent = await fileUnder(w, 'threat');
    await fileUnder(w, 'harassment');
    const res = await w.call('GET', '/reports', { query: { status: 'open' } });
    const rows = items(res);
    const hit = rows.find((r) => r.id === urgent.id) as Record<string, unknown>;
    expect(hit.urgent).toBe(true);
    expect(rows.filter((r) => 'urgent' in r)).toHaveLength(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/quissel|a line from the target/);
    for (const k of ['excerpt', 'note', 'handoffBy', 'escalatedBy', 'evidenceRef']) expect(keysDeep(res.body).has(k), k).toBe(false);
  });

  it('a summary carries handoffAt after a hand-off, and never who', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    await w.call('POST', `/reports/${f.id}/handoff`, { actor: 'mod_ann', body: {} });
    const row = items(await w.call('GET', '/reports', { query: { status: 'open', urgent: '1' } }))[0] as Record<string, unknown>;
    expect(row.handoffAt).toBe(w.clock.t);
    expect(JSON.stringify(row)).not.toContain('mod_ann');
  });

  it('GET /reports/:id has urgent and handoff: { at, by } or null, and no raw hand-off, escalation or evidence columns', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    const before = (await w.call('GET', `/reports/${f.id}`)).body as { report: Record<string, unknown> };
    expect(before.report.urgent).toBe(true);
    expect(before.report.handoff).toBeNull();
    await w.call('POST', `/reports/${f.id}/handoff`, { actor: 'mod_ann', body: {} });
    const after = (await w.call('GET', `/reports/${f.id}`)).body as { report: Record<string, unknown> };
    expect(after.report.handoff).toEqual({ at: w.clock.t, by: 'mod_ann' });
    for (const k of ['handoffAt', 'handoffBy', 'escalatedTo', 'escalatedBy', 'escalatedAt', 'evidenceRef']) expect(after.report, k).not.toHaveProperty(k);
    const plain = await fileUnder(w, 'harassment');
    const body = (await w.call('GET', `/reports/${plain.id}`)).body as { report: Record<string, unknown> };
    expect(body.report.urgent).toBe(false);
  });
});

describe('GET /changes', () => {
  it('carries urgent as a count, and the count follows setUrgent and decide', async () => {
    const w = await world();
    const count = async () => ((await w.call('GET', '/changes')).body as { urgent: number }).urgent;
    expect(await count()).toBe(0);
    const a = await fileUnder(w, 'threat');
    const b = await fileUnder(w, 'harassment');
    expect(await count()).toBe(1);
    await w.call('POST', `/reports/${b.id}/urgent`, { body: { on: true } });
    expect(await count()).toBe(2);
    await w.call('POST', `/reports/${a.id}/urgent`, { body: { on: false } });
    expect(await count()).toBe(1);
    await w.cw.decide({ reportId: b.id, verdict: 'no_action', actions: [], actor: 'ann' });
    expect(await count()).toBe(0);
  });

  it('moves the token when the urgent flag changes', async () => {
    const w = await world();
    const f = await fileUnder(w, 'harassment');
    const t0 = ((await w.call('GET', '/changes')).body as { token: string }).token;
    await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: true } });
    expect(((await w.call('GET', '/changes', { query: { since: t0 } })).body as { changed: boolean }).changed).toBe(true);
  });
});

describe('POST /reports/:id/urgent', () => {
  it('200 on and off; the report follows; the body echoes nothing', async () => {
    const w = await world();
    const f = await fileUnder(w, 'harassment');
    const on = await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: true } });
    expect([on.status, on.body]).toEqual([200, { ok: true }]);
    expect(w.cw.reports.get(f.id)?.urgent).toBe(true);
    const off = await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: false } });
    expect([off.status, off.body]).toEqual([200, { ok: true }]);
    expect(w.cw.reports.get(f.id)?.urgent).toBe(false);
    // a repeat is still 200
    expect((await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: false } })).status).toBe(200);
  });

  it('404 for an unknown id, 409 already_decided for a decided one, 400 for a non-boolean or a missing flag or an extra key', async () => {
    const w = await world();
    const f = await fileUnder(w, 'harassment');
    const unknown = await w.call('POST', '/reports/nope/urgent', { body: { on: true } });
    expect([unknown.status, errorOf(unknown)]).toEqual([404, 'not_found']);
    for (const body of [{ on: 'yes' }, { on: 1 }, {}, { on: true, extra: 1 }, { on: null }]) {
      const bad = await w.call('POST', `/reports/${f.id}/urgent`, { body });
      expect([bad.status, errorOf(bad)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
    expect(w.cw.reports.get(f.id)?.urgent).toBe(false);
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: 'ann' });
    const closed = await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: true } });
    expect([closed.status, errorOf(closed)]).toEqual([409, 'already_decided']);
  });

  it('audits report.urgent after the write, best-effort, on the report, with no detail; the body never echoes the audit failure', async () => {
    const w = await world();
    const f = await fileUnder(w, 'harassment');
    const res = await w.call('POST', `/reports/${f.id}/urgent`, { actor: 'mod_ann', body: { on: true } });
    expect(res.status).toBe(200);
    expect(w.routeAudit().filter((r) => r.action === 'report.urgent')).toEqual([expect.objectContaining({ actor: 'mod_ann', role: 'moderator', target: { type: 'report', ref: f.id } })]);
    expect(JSON.stringify(w.routeAudit())).not.toMatch(/quissel|"detail"/);
    // a failing audit write does not undo the change or fail the call
    const orig = w.cw.audit.record.bind(w.cw.audit);
    w.cw.audit.record = () => {
      throw new Error('audit down');
    };
    const again = await w.call('POST', `/reports/${f.id}/urgent`, { actor: 'mod_ann', body: { on: false } });
    w.cw.audit.record = orig;
    expect(again.status).toBe(200);
    expect(w.cw.reports.get(f.id)?.urgent).toBe(false);
  });

  it('a failed call (unknown id) writes no audit row', async () => {
    const w = await world();
    await w.call('POST', '/reports/nope/urgent', { body: { on: true } });
    expect(w.routeAudit()).toEqual([]);
  });
});

describe('POST /reports/:id/handoff', () => {
  it('honours the claim gate exactly like a decision: another moderator\'s claim is 409 claimed, the holder and a senior with takeOver may', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    expect(w.cw.cases.claim(f.target, 'mod_bea')).toMatchObject({ ok: true });
    const blocked = await w.call('POST', `/reports/${f.id}/handoff`, { actor: 'mod_ann', body: {} });
    expect([blocked.status, errorOf(blocked)]).toEqual([409, 'claimed']);
    expect(w.cw.reports.get(f.id)?.handoffAt).toBeNull();
    // a moderator cannot take over; a senior can, and the takeover is audited first
    const noTake = await w.call('POST', `/reports/${f.id}/handoff`, { actor: 'mod_ann', body: { takeOver: true } });
    expect([noTake.status, errorOf(noTake)]).toEqual([409, 'claimed']);
    const taken = await w.call('POST', `/reports/${f.id}/handoff`, { role: 'senior', actor: 'sen_cy', body: { takeOver: true } });
    expect(taken.status).toBe(200);
    expect(w.cw.reports.get(f.id)).toMatchObject({ handoffBy: 'sen_cy' });
    expect(w.routeAudit().map((r) => r.action)).toEqual(expect.arrayContaining(['case.takeover', 'report.handoff']));
    const rows = w.routeAudit().map((r) => r.action);
    expect(rows.indexOf('case.takeover')).toBeGreaterThanOrEqual(0);
    // the holder may mark it without a takeover
    const g = await fileUnder(w, 'harassment');
    w.cw.cases.claim(g.target, 'mod_bea');
    expect((await w.call('POST', `/reports/${g.id}/handoff`, { actor: 'mod_bea', body: {} })).status).toBe(200);
  });

  it('200 idempotent: the first mark stays; audit report.handoff best-effort on every call', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    const first = await w.call('POST', `/reports/${f.id}/handoff`, { actor: 'mod_ann', body: {} });
    const at = w.clock.t;
    expect([first.status, first.body]).toEqual([200, { ok: true }]);
    w.clock.t += 5000;
    const second = await w.call('POST', `/reports/${f.id}/handoff`, { actor: 'mod_bea', body: {} });
    expect([second.status, second.body]).toEqual([200, { ok: true }]);
    expect(w.cw.reports.get(f.id)).toMatchObject({ handoffBy: 'mod_ann', handoffAt: at });
    expect(w.routeAudit().filter((r) => r.action === 'report.handoff').map((r) => r.actor)).toEqual(['mod_bea', 'mod_ann']);
  });

  it('works on an ordinary open report; 409 already_decided when closed; 404 unknown; a body with an unknown key is 400', async () => {
    const w = await world();
    const f = await fileUnder(w, 'harassment');
    expect((await w.call('POST', `/reports/${f.id}/handoff`, { body: {} })).status).toBe(200);
    const g = await fileUnder(w, 'threat');
    await w.cw.decide({ reportId: g.id, verdict: 'no_action', actions: [], actor: 'ann' });
    const closed = await w.call('POST', `/reports/${g.id}/handoff`, { body: {} });
    expect([closed.status, errorOf(closed)]).toEqual([409, 'already_decided']);
    const unknown = await w.call('POST', '/reports/nope/handoff', { body: {} });
    expect([unknown.status, errorOf(unknown)]).toEqual([404, 'not_found']);
    const bad = await w.call('POST', `/reports/${f.id}/handoff`, { body: { note: 'x' } });
    expect([bad.status, errorOf(bad)]).toEqual([400, 'invalid_request']);
    const badTake = await w.call('POST', `/reports/${f.id}/handoff`, { body: { takeOver: 'yes' } });
    expect([badTake.status, errorOf(badTake)]).toEqual([400, 'invalid_request']);
  });

  it('no body at all is allowed', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    const res = await w.call('POST', `/reports/${f.id}/handoff`, {});
    expect(res.status).toBe(200);
  });

  it('writes nothing to the person and the body holds no id', async () => {
    const w = await world();
    const f = await fileUnder(w, 'threat');
    const res = await w.call('POST', `/reports/${f.id}/handoff`, { body: {} });
    expect(JSON.stringify(res.body)).toBe('{"ok":true}');
    expect(w.cw.notices.pending({ clientKey: f.key })).toEqual([]);
  });
});

describe('a store without the urgent-lane methods', () => {
  /** The first-party store with the named methods taken off, as a custom store written before the lane would be. */
  const without = (...names: string[]) => (store: object) => {
    for (const name of names) Object.defineProperty(store, name, { value: undefined, configurable: true });
  };

  it.each([
    ['POST', (id: string) => `/reports/${id}/urgent`, { on: true }, 'setReportUrgent'],
    ['POST', (id: string) => `/reports/${id}/handoff`, {}, 'setHandoff'],
  ] as const)('%s %s answers 501 not_supported (not a bare 500), writes no audit row, and logs the class by name', async (method, path, body, missing) => {
    const w = await world({ editStore: without(missing) });
    const f = await fileUnder(w, 'harassment');
    w.logged.length = 0;
    const res = await w.call(method, path(f.id), { body });
    expect([res.status, errorOf(res)]).toEqual([501, 'not_supported']);
    expect(JSON.stringify(res.body)).not.toContain(missing);
    expect(w.routeAudit()).toEqual([]);
    expect(w.logged.filter(([event]) => event === 'chatwarden.http_error')).toEqual([]);
    expect(res.headers?.['cache-control']).toBe('no-store');
  });

  it('a route that needs only the other method still works (each answers for its own method)', async () => {
    const w = await world({ editStore: without('setHandoff') });
    const f = await fileUnder(w, 'harassment');
    expect((await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: true } })).status).toBe(200);
    expect((await w.call('POST', `/reports/${f.id}/handoff`, { body: {} })).status).toBe(501);
  });

  it('control: a full store answers 200 and logs no capability line', async () => {
    const w = await world();
    const f = await fileUnder(w, 'harassment');
    expect((await w.call('POST', `/reports/${f.id}/urgent`, { body: { on: true } })).status).toBe(200);
    expect((await w.call('POST', `/reports/${f.id}/handoff`, { body: {} })).status).toBe(200);
    expect(w.logged.filter(([event]) => event === 'chatwarden.store_no_urgent_lane')).toEqual([]);
  });
});
