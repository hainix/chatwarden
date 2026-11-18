import { describe, expect, it } from 'vitest';
import type { ReportInput } from '@chatwarden/core';
import { world } from './world.js';

// The evidence kind on the staff routes (0.2.2, audit S10, S1, C1): the report body says what the reason's evidence is, the suggestion follows it,
// and the reason settings take and refuse a kind.

type W = Awaited<ReturnType<typeof world>>;
let seq = 0;
async function fileWith(w: W, o: Partial<ReportInput> = {}) {
  const room = `ev-room-${++seq}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `rk-${seq}`, ip: '198.51.100.31' }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: `tk-${seq}`, ip: '203.0.113.31' }, 'Tgt');
  w.cw.chat.accept(room, 'p2', 'Hello');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', ...o });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  if (report === null) throw new Error('missing');
  return { id: res.reportId, target: report.targetPerson };
}
const reportOf = async (w: W, id: string) => ((await w.call('GET', `/reports/${id}`)).body as { report: Record<string, unknown> }).report;

describe('GET /reports/:id carries the kind of evidence (evidenceKind: the existing evidence pointer keeps its key)', () => {
  it.each([
    ['afk', 'play'],
    ['cheating', 'play'],
    ['griefing', 'play'],
    ['name', 'name'],
    ['harassment', 'chat'],
    ['hate', 'chat'],
  ] as const)('a %s report is %s', async (reason, kind) => {
    const w = await world();
    const f = await fileWith(w, { reason });
    expect((await reportOf(w, f.id)).evidenceKind).toBe(kind);
  });

  it('no key at all for a neutral report: the reason other, no reason, a custom reason with none', async () => {
    const w = await world({ overrides: { reporting: { reasons: [{ id: 'zorbak', label: 'Zorbak' }, { id: 'other', label: 'Something else' }] } } });
    for (const o of [{ reason: 'other' }, {}, { reason: 'zorbak' }]) {
      const body = await reportOf(w, (await fileWith(w, o)).id);
      expect(Object.hasOwn(body, 'evidenceKind'), JSON.stringify(o)).toBe(false);
    }
  });

  it('the current setting is read, not a snapshot', async () => {
    const w = await world();
    const f = await fileWith(w, { reason: 'harassment' });
    expect((await reportOf(w, f.id)).evidenceKind).toBe('chat');
    const reasons = w.cw.profile.reporting.reasons.map((r) => (r.id === 'harassment' ? { ...r, evidence: 'play' as const } : { ...r }));
    expect(w.cw.policy.save({ reporting: { reasons } }, { version: 0, actor: 'owner_ann', reason: 'reclassify' }).ok).toBe(true);
    expect((await reportOf(w, f.id)).evidenceKind).toBe('play');
  });

  it('the old category call reads as its reason: disruption is play', async () => {
    const w = await world();
    const f = await fileWith(w, { category: 'disruption' });
    expect((await reportOf(w, f.id)).evidenceKind).toBe('play');
  });

  it('the queue rows are unchanged: no evidence key on a summary', async () => {
    const w = await world();
    await fileWith(w, { reason: 'afk' });
    const items = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items;
    expect(Object.keys(items[0] as object)).not.toContain('evidenceKind');
  });
});

describe('the suggestion follows the report', () => {
  const ask = async (w: W, id: string, body: Record<string, unknown> = {}) => (await w.call('POST', `/reports/${id}/suggest`, { role: 'moderator', body })).body as { why: string; outcome: unknown };
  it('GET /reports/:id suggest for an AFK report has no chat words and is not a chat restriction', async () => {
    const w = await world();
    const f = await fileWith(w, { reason: 'afk' });
    const res = (await w.call('GET', `/reports/${f.id}`)).body as { suggest: { why: string; outcome: unknown } };
    expect(res.suggest.why).not.toMatch(/hostile|aggressive|banter|message/i);
    expect(JSON.stringify(res.suggest.outcome)).not.toContain('"chat"');
  });
  it('POST suggest agrees: the same words, and a stated level is honoured', async () => {
    const w = await world();
    const f = await fileWith(w, { reason: 'afk' });
    expect((await ask(w, f.id)).why).toMatch(/gameplay conduct/);
    expect(JSON.stringify((await ask(w, f.id, { level: 'hostile' })).outcome)).toContain('"area"');
  });
  it('a chat report is as it was', async () => {
    const w = await world();
    const f = await fileWith(w, { reason: 'harassment' });
    expect((await ask(w, f.id)).why).toMatch(/hostile conduct/);
  });
});

describe('the reason settings take a kind', () => {
  const PUT = (layer: unknown) => ({ role: 'owner' as const, actor: 'owner_ann', body: { layer, version: 0, reason: 'try' } });
  const other = { id: 'other', label: 'Something else' };
  it('PUT saves a reason with a kind and GET reads it back', async () => {
    const w = await world();
    const res = await w.call('PUT', '/policy/profile', PUT({ reporting: { reasons: [{ id: 'zorbak', label: 'Zorbak', evidence: 'play' }, other] } }));
    expect(res.status).toBe(200);
    const eff = ((await w.call('GET', '/policy/profile')).body as { effective: { reporting: { reasons: Array<{ id: string; evidence?: string }> } } }).effective;
    expect(eff.reporting.reasons.find((r) => r.id === 'zorbak')?.evidence).toBe('play');
  });
  it('a bad kind is 400 invalid_profile at the field path and saves nothing', async () => {
    const w = await world();
    const res = await w.call('PUT', '/policy/profile', PUT({ reporting: { reasons: [{ id: 'zorbak', label: 'Zorbak', evidence: 'gameplay' }, other] } }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('reporting.reasons[0].evidence');
    expect(w.cw.profile.reporting.reasons.some((r) => r.id === 'zorbak')).toBe(false);
  });
});

describe('POST /reports/:id/decide takes the kind', () => {
  const decideAfk = async (body: Record<string, unknown>) => {
    const w = await world();
    const room = `ev-decide-${++seq}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: `dk-r-${seq}` }, 'Rep');
    w.cw.rooms.seat(room, 'p2', { clientKey: `dk-t-${seq}` }, 'Tgt');
    w.cw.chat.accept(room, 'p2', 'Hello');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', reason: 'afk' });
    if (!res.ok) throw new Error('refused');
    const report = w.cw.reports.get(res.reportId);
    if (report === null) throw new Error('missing');
    const line = (report.ownLineIds[report.targetPerson] ?? [])[0] as string;
    const out = await w.call('POST', `/reports/${res.reportId}/decide`, {
      role: 'senior',
      body: { verdict: 'upheld', reason: 'left', actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 6, lineIds: [line] }], ...body },
    });
    return { out, w, who: { clientKey: `dk-t-${seq}` } };
  };
  it('a line on an AFK report is refused, as the core refuses it, and nothing is written', async () => {
    const { out, w, who } = await decideAfk({});
    expect(out.status).toBe(400);
    expect(w.cw.notices.pending(who)).toEqual([]);
  });
  it('with evidenceKind chat the same decision is taken and the player is told it is about chat', async () => {
    const { out, w, who } = await decideAfk({ evidenceKind: 'chat' });
    expect(out.status).toBe(200);
    expect(w.cw.notices.pending(who)[0]).toMatchObject({ kind: 'warning', evidence: 'chat' });
  });
  it.each(['gameplay', 4, {}, ''])('a bad evidenceKind %j is 400 invalid_request', async (bad) => {
    const { out } = await decideAfk({ evidenceKind: bad });
    expect(out.status).toBe(400);
  });
  it('null is neutral: accepted, a line may be attached and the notice carries no kind', async () => {
    const { out, w, who } = await decideAfk({ evidenceKind: null });
    expect(out.status).toBe(200);
    const n = w.cw.notices.pending(who)[0];
    expect(n?.kind).toBe('warning');
    expect(n?.excerpt).toHaveLength(1);
    expect(Object.hasOwn(n as object, 'evidence')).toBe(false);
  });
});
