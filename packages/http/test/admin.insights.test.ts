import { describe, expect, it } from 'vitest';
import { errorOf, keysDeep, world } from './world.js';

// U7: GET /insights?days=7|30|90 over the kit's own rows. Staff only (insights.read), 404 when desk.insights is off, no-store, times and counts only.

const on = { overrides: { desk: { insights: true } } };

describe('GET /insights', () => {
  it('is 404 when desk.insights is off, and the body is the same as any unknown route', async () => {
    const w = await world();
    const off = await w.call('GET', '/insights');
    const unknown = await w.call('GET', '/does-not-exist/at-all');
    expect([off.status, errorOf(off)]).toEqual([404, 'not_found']);
    expect(off.body).toEqual(unknown.body);
    expect(w.routeAudit().filter((r) => r.action === 'insights.view')).toEqual([]);
  });

  it('needs insights.read: a moderator by default, raised by the permissions option; 401 without authz', async () => {
    const w = await world({ ...on, permissions: { 'insights.read': 'senior' } });
    expect((await w.call('GET', '/insights', { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/insights', { role: 'senior' })).status).toBe(200);
    expect((await w.call('GET', '/insights', { role: null })).status).toBe(401);
    const d = await world(on);
    expect((await d.call('GET', '/insights', { role: 'moderator' })).status).toBe(200);
  });

  it('answers the shape of the spec, 30 days by default, no-store JSON', async () => {
    const w = await world(on);
    await w.file('harassment');
    const res = await w.call('GET', '/insights');
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['byOutcome', 'byReason', 'byRule', 'chat', 'days', 'decision', 'from', 'partial', 'reports', 'to', 'urgent', 'wait']);
    expect(body.days).toBe(30);
    expect(body.reports).toEqual({ filed: 1, decided: 0, open: 1 });
    // the world's own chat line was counted today: counting began inside the window, so there is no rate
    expect(body.chat).toEqual({ delivered: 1, refused: 0, reportsPer1000: null });
    expect(body.partial).toBe(false);
  });

  it('days 7, 30 and 90 are taken; anything else is 400 invalid_query', async () => {
    const w = await world(on);
    for (const days of ['7', '30', '90']) expect((await w.call('GET', '/insights', { query: { days } })).body).toMatchObject({ days: Number(days) });
    for (const days of ['', '0', '1', '14', '365', '7.0', '07', '-7', 'abc', '7 ', '1e1']) {
      const res = await w.call('GET', '/insights', { query: { days } });
      expect([res.status, errorOf(res)], JSON.stringify(days)).toEqual([400, 'invalid_query']);
    }
    expect(w.routeAudit().filter((r) => r.action === 'insights.view')).toHaveLength(3);
  });

  it('audits insights.view with no target, best-effort: a failing audit write does not fail the read', async () => {
    const w = await world(on);
    await w.call('GET', '/insights', { actor: 'mod_ann' });
    const rows = w.routeAudit().filter((r) => r.action === 'insights.view');
    expect(rows).toEqual([expect.objectContaining({ actor: 'mod_ann', role: 'moderator' })]);
    expect(rows[0]?.target).toBeUndefined();
    const orig = w.cw.audit.record.bind(w.cw.audit);
    w.cw.audit.record = () => {
      throw new Error('audit down');
    };
    const res = await w.call('GET', '/insights');
    w.cw.audit.record = orig;
    expect(res.status).toBe(200);
  });

  it('carries times and counts only: no subject, handle, staff id, text or note anywhere in the body', async () => {
    const w = await world(on);
    const f = await w.file('harassment');
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: 'mod_secret_ann' });
    const res = await w.call('GET', '/insights');
    const text = JSON.stringify(res.body);
    for (const needle of ['mod_secret_ann', f.target, f.reporter, 'TargetName', 'a line from the target', 'actionedBy']) expect(text, needle).not.toContain(needle);
    for (const k of keysDeep(res.body)) expect(k, k).not.toMatch(/person|subject|actor|staff|handle|text|note/i);
  });

  it('the line rate appears once lines are counted: the counter is flushed by the read', async () => {
    const w = await world(on);
    w.cw.rooms.seat('R9', 'p1', { clientKey: 'key-insights-aaaaaaaaaaaa' }, 'One');
    w.cw.chat.accept('R9', 'p1', 'hello there');
    const res = await w.call('GET', '/insights', { query: { days: '7' } });
    expect((res.body as { chat: unknown }).chat).toEqual({ delivered: 1, refused: 0, reportsPer1000: null });
  });
});
