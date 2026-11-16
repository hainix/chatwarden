import { describe, expect, it } from 'vitest';
import { DAY, errorOf, world } from './world.js';

// Characterisation of `POST /reports/:id/decide` taken before its body moved into the shared `decideAs` (K5 task A3): what the route does
// about a takeover, the caller's identity and its audit rows. The route's other behaviour is pinned by admin.reports, admin.team and
// admin.quick-dismiss; these cover the gaps the extraction could have disturbed.

const warn = (person: string, over: Record<string, unknown> = {}) => ({
  verdict: 'upheld',
  actions: [{ subject: person, kind: 'chat', durationMs: DAY, rule: 2 }],
  reason: 'a decision about drakkuun',
  ...over,
});

describe('POST /reports/:id/decide, pinned before the extraction', () => {
  it('a senior takeOver audits case.takeover on the person BEFORE report.decide, and moves the claim', async () => {
    const order: Array<[string, string, string]> = [];
    const w = await world({
      wrap: (cw) =>
        Object.create(cw, {
          audit: {
            value: {
              ...cw.audit,
              record: (e: Parameters<typeof cw.audit.record>[0]) => {
                order.push([e.action, e.actor, String(e.role)]);
                return cw.audit.record(e);
              },
            },
          },
        }) as typeof cw,
    });
    const r = await w.file();
    w.cw.cases.claim(r.target, 'ann');
    order.length = 0;
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'sam', role: 'senior', body: warn(r.target, { takeOver: true }) });
    expect(res.status).toBe(200);
    expect(order).toEqual([
      ['case.takeover', 'sam', 'senior'],
      ['report.decide', 'sam', 'senior'],
    ]);
    expect(w.routeAudit().find((a) => a.action === 'case.takeover')?.target).toEqual({ type: 'person', ref: r.target });
    expect(w.cw.cases.holder(r.target)).toBeNull(); // the takeover moved it to sam, and the last open report released it
  });

  it('a moderator takeOver is 409 claimed, writes no audit row and no decision', async () => {
    const w = await world();
    const r = await w.file();
    w.cw.cases.claim(r.target, 'ann');
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'bea', role: 'moderator', body: warn(r.target, { takeOver: true }) });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('claimed');
    expect(res.body).toMatchObject({ by: 'ann' });
    expect(w.routeAudit()).toEqual([]);
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
  });

  it('a takeover whose audit row cannot be written does not happen: 500, the claim untouched, the report open', async () => {
    const w = await world({
      wrap: (cw) =>
        Object.create(cw, {
          audit: { value: { ...cw.audit, record: () => false } },
        }) as typeof cw,
    });
    const r = await w.file();
    w.cw.cases.claim(r.target, 'ann');
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'sam', role: 'senior', body: warn(r.target, { takeOver: true }) });
    expect(res.status).toBe(500);
    expect(w.cw.cases.holder(r.target)?.by).toBe('ann');
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('the actor, source and role are the caller\'s: a body actor, source or role is ignored', async () => {
    const w = await world();
    const r = await w.file();
    const res = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'ann', role: 'moderator', body: warn(r.target, { actor: 'mallory', source: 'api', role: 'owner' }) });
    expect(res.status).toBe(200);
    expect(w.cw.sanctions.forPerson(r.target)[0]).toMatchObject({ actor: 'ann', source: 'moderator', automated: false });
    expect(w.routeAudit().find((a) => a.action === 'report.decide')).toMatchObject({ actor: 'ann', role: 'moderator' });
  });

  it('a report decided by the route writes one report.decide row, a replay writes one more, a refusal writes none', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/reports/${r.id}/decide`, { body: warn(r.target) });
    await w.call('POST', `/reports/${r.id}/decide`, { body: warn(r.target) });
    expect(w.routeAudit().filter((a) => a.action === 'report.decide')).toHaveLength(2);
    const r2 = await w.file();
    const refused = await w.call('POST', `/reports/${r2.id}/decide`, { body: warn(r2.target, { actions: [{ subject: r2.target, kind: 'ban', durationMs: null, rule: 2 }] }) });
    expect(refused.status).toBe(403);
    expect(w.routeAudit().filter((a) => a.action === 'report.decide')).toHaveLength(2);
  });

  it('a decision is read for a claim only while the report is open: a claim taken after the decision does not turn a replay into 409', async () => {
    const w = await world();
    const r = await w.file();
    await w.call('POST', `/reports/${r.id}/decide`, { actor: 'ann', body: warn(r.target) });
    const other = await w.file();
    w.cw.cases.claim(other.target, 'ann');
    const replay = await w.call('POST', `/reports/${r.id}/decide`, { actor: 'bea', body: warn(r.target) });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replay: true });
  });
});
