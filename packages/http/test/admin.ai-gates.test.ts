import { describe, expect, it } from 'vitest';
import type { AiOutcomeInsert } from '@chatwarden/core';
import { DAY, NOW, errorOf, keysDeep, world } from './world.js';

// `GET /ai/gates` (AI levels 3 and 4, design 6.6): the gate dashboard's data, `cw.ai.gates()` as it is. Permission `policy.read`, audited `policy.view`,
// read-only. The server computes every number from the store and the clock; no id, no text and no staff ref is in the answer. Nothing here lets the AI act.

type W = Awaited<ReturnType<typeof world>>;
const aiOn = { ai: { level: 2 as const } };

let seq = 0;
/** A qualifying decision in cell (rule 2, hostile) by `by`, `ago` ms before now. */
const decision = (by: string, ago: number, over: Partial<AiOutcomeInsert> = {}): AiOutcomeInsert => {
  seq += 1;
  return {
    reportId: `g-route-${seq}`,
    readId: null,
    decidedAt: NOW - ago,
    level: 2,
    verdict: 'upheld',
    rule: '2',
    severity: 'hostile',
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
    badFaith: false,
    example: null,
    aiRule: '2',
    aiSeverity: 'hostile',
    aiConfidence: 'high',
    decidedBy: by,
    source: 'human',
    ...over,
  };
};

const gatesWorld = (over: Parameters<typeof world>[0] = {}) => world({ ...aiOn, overrides: { aiAutoAct: ['hostile', 'severe'] }, ...over });
const seed = (w: W, n: number, by = 'mod_a'): void => {
  const store = w.store as unknown as { insertAiOutcome(r: AiOutcomeInsert): boolean };
  for (let i = 0; i < n; i++) store.insertAiOutcome(decision(i % 2 === 0 ? by : 'mod_b', DAY + i * 1000));
};

describe('GET /ai/gates', () => {
  it('needs policy.read, is audited as policy.view, and returns AiGatesView with no id', async () => {
    const w = await gatesWorld();
    seed(w, 3);
    const res = await w.call('GET', '/ai/gates', { role: 'moderator', actor: 'mod_zed' });
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const view = res.body as ReturnType<typeof w.cw.ai.gates>;
    expect(view).toEqual(JSON.parse(JSON.stringify(w.cw.ai.gates())));
    expect(view).toMatchObject({ version: 1, actingAvailable: false });
    expect(view.cells.length).toBeGreaterThan(0);
    // one audit row, as policy.view, with no target
    expect(w.routeAudit().map((r) => [r.actor, r.role, r.action, r.target])).toEqual([['mod_zed', 'moderator', 'policy.view', undefined]]);
    // no id, no text, no staff ref: the decider's ref and the report ids never leave
    const text = JSON.stringify(res.body);
    for (const leak of ['mod_a', 'mod_b', 'g-route-', 'mod_zed']) expect(text).not.toContain(leak);
    expect(keysDeep(res.body)).not.toContain('decidedBy');
    expect(keysDeep(res.body)).not.toContain('reportId');
  });

  it('with decisions in the store, the cell shows its counts as the server computed them', async () => {
    const w = await gatesWorld();
    seed(w, 4);
    const res = await w.call('GET', '/ai/gates');
    const cell = (res.body as ReturnType<typeof w.cw.ai.gates>).cells.find((c) => c.rule === 2 && c.level === 'hostile');
    expect(cell?.counts).toMatchObject({ qualifying: 4, cleanAgree: 4, deciders: 2 });
    expect(cell?.open).toBe(false);
  });

  it('is 403 below the permission and 200 for a moderator by default; the permissions option can raise it', async () => {
    const w = await gatesWorld({ permissions: { 'policy.read': 'owner' } });
    for (const role of ['moderator', 'senior'] as const) {
      const res = await w.call('GET', '/ai/gates', { role });
      expect(res.status, role).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
    }
    expect((await w.call('GET', '/ai/gates', { role: 'owner' })).status).toBe(200);
    expect(w.routeAudit().map((r) => r.action)).toEqual(['policy.view']);
  });

  it('is 401 with no authz, and writes no row', async () => {
    const w = await gatesWorld();
    const res = await w.call('GET', '/ai/gates', { role: null });
    expect(res.status).toBe(401);
    expect(w.routeAudit()).toEqual([]);
  });

  it('fails closed: when the audit row cannot be written the answer is a 500, not the numbers', async () => {
    const w = await gatesWorld({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const res = await w.call('GET', '/ai/gates');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('cells');
  });

  it('with the AI off, or no adapter, it answers an empty view (200), not an error', async () => {
    const off = await world({ ai: { level: 0 } });
    expect((await off.call('GET', '/ai/gates')).body).toMatchObject({ version: 1, cells: [], actingAvailable: false });
    const none = await world();
    expect((await none.call('GET', '/ai/gates')).body).toMatchObject({ version: 1, cells: [], actingAvailable: false });
  });

  it('is read-only: asking twice gives the same numbers, writes nothing but its audit rows, and the other methods are 405', async () => {
    const w = await gatesWorld();
    seed(w, 3);
    const first = await w.call('GET', '/ai/gates');
    const second = await w.call('GET', '/ai/gates');
    expect(second.body).toEqual(first.body);
    expect(w.routeAudit().map((r) => r.action)).toEqual(['policy.view', 'policy.view']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await w.call(method, '/ai/gates', { role: 'owner', body: {} })).status, method).toBe(405);
    }
    expect(w.adapter?.callCount).toBe(0);
  });

  it('a request cannot supply a number: a query or a body with a count, a rate or a state changes nothing', async () => {
    const w = await gatesWorld();
    seed(w, 2);
    const plain = await w.call('GET', '/ai/gates');
    const spoof = await w.call('GET', '/ai/gates', { query: { qualifying: '9999', open: 'true', rule: '2', state: 'on', windowDays: '1' } });
    expect(spoof.body).toEqual(plain.body);
  });
});
