import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NO_ACTION_DEFAULT_REASON, createChatwarden } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, createRouter } from '@chatwarden/http';
import type { Authz, KitRequest, KitResponse, Role } from '@chatwarden/http';
import { applyDecision, parseDecision } from '../src/admin/apply.js';

// A one-click dismissal: `no_action` with no actions may leave the reason out (core stores the standard text). The staff route
// and the signed incoming webhook share parseDecision/applyDecision, so they follow the same rule.

const NOW = 1_800_000_000_000;

async function world() {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const clock = { t: NOW, now: () => clock.t };
  const cw = await createChatwarden({
    store,
    secret: 'quick-dismiss-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    retention: false,
  });
  let n = 0;
  const file = async () => {
    const room = `room-${++n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `key-reporter-${n}` }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: `key-target-${n}` }, 'Tgt');
    cw.chat.accept(room, 'p2', 'a line from the target');
    clock.t += 1000;
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = cw.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    return { id: res.reportId, target: report.targetPerson, reporter: report.reporterPerson };
  };
  const authorize = (req: KitRequest): Authz | null => {
    const role = req.headers['x-role'];
    return role === undefined ? null : { actor: req.headers['x-actor'] ?? 'ann', role: role as Role };
  };
  const router = createRouter(adminRoutes(cw, { authorize }));
  const call = (path: string, body: unknown, o: { role?: Role; actor?: string } = {}): Promise<KitResponse> =>
    router({
      method: 'POST',
      path,
      query: {},
      headers: { 'x-role': o.role ?? 'moderator', ...(o.actor === undefined ? {} : { 'x-actor': o.actor }) },
      body: undefined,
      rawBody: JSON.stringify(body),
    });
  const audit = () => cw.audit.list({ limit: 200 }).items;
  return { cw, store, file, call, audit };
}

const errorOf = (res: KitResponse): string => (res.body as { error: string }).error;

describe('POST /reports/:id/decide: a dismissal with no reason', () => {
  it('accepts no_action with no reason key', async () => {
    const w = await world();
    const r = await w.file();
    const res = await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, replay: false, groups: [] });
    expect(w.cw.reports.get(r.id)).toMatchObject({ status: 'dismissed', badFaith: false });
    expect(w.store.loadReport(r.id)?.modNote).toBe(NO_ACTION_DEFAULT_REASON);
  });

  it.each(['', '   '])('accepts no_action with reason %j', async (reason) => {
    const w = await world();
    const r = await w.file();
    const res = await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [], reason });
    expect(res.status).toBe(200);
    expect(w.store.loadReport(r.id)?.modNote).toBe(NO_ACTION_DEFAULT_REASON);
  });

  it('keeps a typed reason as typed', async () => {
    const w = await world();
    const r = await w.file();
    expect((await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [], reason: 'just banter' })).status).toBe(200);
    expect(w.store.loadReport(r.id)?.modNote).toBe('just banter');
  });

  it.each([
    ['upheld', (t: string) => [{ subject: t, kind: 'warning', durationMs: null, rule: 2 }]],
    ['noted', (t: string) => [{ subject: t, kind: 'note', durationMs: null, rule: 2 }]],
    ['bad_faith', () => []],
  ] as const)('refuses %s with no reason (400 invalid_request)', async (verdict, actions) => {
    const w = await world();
    const r = await w.file();
    for (const extra of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await w.call(`/reports/${r.id}/decide`, {
        verdict,
        actions: actions(r.target),
        ...(verdict === 'bad_faith' ? { evidence: 'filed the same false report three times' } : {}),
        ...extra,
      });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('refuses no_action with actions and no reason (400)', async () => {
    const w = await world();
    const r = await w.file();
    const action = { subject: r.reporter, kind: 'warning', durationMs: null, rule: 2 };
    for (const extra of [{}, { reason: '' }, { reason: '  ' }]) {
      const res = await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [action], ...extra });
      expect(res.status).toBe(400);
    }
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('refuses a reason that is not a string, and one that is too long', async () => {
    const w = await world();
    const r = await w.file();
    for (const reason of [5, null, {}, [], true, 'x'.repeat(5000)]) {
      const res = await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [], reason });
      expect(res.status).toBe(400);
    }
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('writes one report.decide audit row, and a replay writes one more, as before', async () => {
    const w = await world();
    const r = await w.file();
    const rows = () => w.audit().filter((a) => a.action === 'report.decide');
    await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [] });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ actor: 'ann', target: { type: 'report', ref: r.id } });
    const again = await w.call(`/reports/${r.id}/decide`, { verdict: 'no_action', actions: [], reason: 'typed later' });
    expect(again.body).toMatchObject({ ok: true, replay: true });
    expect(rows()).toHaveLength(2);
  });
});

describe('the signed incoming webhook path', () => {
  it('takes a reasonless no_action by the same rule (applyDecision)', async () => {
    const w = await world();
    const r = await w.file();
    const parsed = parseDecision({ verdict: 'no_action', actions: [] });
    expect(parsed).toEqual({ verdict: 'no_action', actions: [] });
    expect(parsed).not.toHaveProperty('reason');
    await expect(applyDecision(w.cw, r.id, parsed, 'webhook@example.test')).resolves.toMatchObject({ replay: false, groups: [] });
    expect(w.store.loadReport(r.id)).toMatchObject({ status: 'dismissed', actionedBy: 'webhook@example.test', modNote: NO_ACTION_DEFAULT_REASON });
  });

  it('still refuses a reasonless upheld and a reasonless no_action that acts', async () => {
    const w = await world();
    const r = await w.file();
    const action = { subject: r.target, kind: 'warning' as const, durationMs: null, rule: 2 };
    await expect(applyDecision(w.cw, r.id, { verdict: 'upheld', actions: [action] }, 'webhook@example.test')).rejects.toMatchObject({ status: 400 });
    await expect(
      applyDecision(w.cw, r.id, { verdict: 'no_action', actions: [{ ...action, subject: r.reporter }] }, 'webhook@example.test'),
    ).rejects.toMatchObject({ status: 400 });
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('parseDecision still checks a given reason: non-strings and over-long text are refused', () => {
    for (const reason of [5, null, {}, 'x'.repeat(5000)]) {
      expect(() => parseDecision({ verdict: 'no_action', actions: [], reason })).toThrow();
    }
    expect(parseDecision({ verdict: 'no_action', actions: [], reason: '' })).toMatchObject({ reason: '' });
  });
});
