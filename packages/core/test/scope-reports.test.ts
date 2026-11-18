import { describe, expect, it } from 'vitest';
import { HOUR, MIN, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// M2: staff scope in the core. A report stamps the room's `scope` tag; every staff read takes an optional scope list that is applied in the store
// query (never after it); a report with no scope is invisible to a scoped caller; a caller with no scope sees everything as before.

const MOD = 'mod_ann';
const A = 'creator:alice';
const B = 'creator:bob';
const C = 'creator:carol';

let n = 0;
/** File one open report in a new room tagged with `scope` (null: no tag). `target` is a raw client key, so two reports can name one person. */
async function fileIn(w: World, scope: string | null, o: { target?: string } = {}) {
  n += 1;
  const room = `room-scope-${n}`;
  const tags = scope === null ? undefined : { scope };
  w.cw.rooms.seat(room, 'p1', { clientKey: `rep-key-${n}-aaaaaaaa` }, 'Rep', tags);
  w.cw.rooms.seat(room, 'p2', { clientKey: o.target ?? `tgt-key-${n}-aaaaaaaa` }, 'Tgt');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.clock.t += 1000;
  const res = await w.submit(room, {});
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const rec = w.cw.reports.get(res.reportId);
  if (rec === null) throw new Error('missing');
  return { id: res.reportId, room, target: rec.targetPerson, reporter: rec.reporterPerson! };
}
const warn = (subject: string) => ({ subject, kind: 'warning' as const, durationMs: null, rule: 1, lineIds: [] });
const ids = (w: World, scope?: readonly string[]) => w.cw.reports.list({ limit: 200, ...(scope === undefined ? {} : { scope }) } as never).items.map((r) => r.id);

describe('stamping', () => {
  it('a report filed in a room tagged scope stores it; a room with none stores null; the tag stays in tags', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const none = await fileIn(w, null);
    expect(w.store.loadReport(a.id)).toMatchObject({ scope: A, tags: { scope: A } });
    expect(w.store.loadReport(none.id)).toMatchObject({ scope: null, tags: {} });
  });

  it('the stamp is the room tag at filing: a room tagged with a context and a scope keeps both, other tags never become the scope', async () => {
    const w = await world({ overrides: { contexts: { kids: {} } } });
    w.cw.rooms.seat('RX', 'p1', { clientKey: 'rep-aaaaaaaaaaaa' }, 'Rep', { context: 'kids', scope: B, mode: 'ranked' });
    w.cw.rooms.seat('RX', 'p2', { clientKey: 'tgt-aaaaaaaaaaaa' }, 'Tgt');
    const res = await w.submit('RX', {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(w.store.loadReport(res.reportId)).toMatchObject({ scope: B, tags: { context: 'kids', scope: B, mode: 'ranked' } });
    w.cw.rooms.seat('RY', 'p1', { clientKey: 'rep2-aaaaaaaaaaaa' }, 'Rep', { region: 'creator:alice' });
    w.cw.rooms.seat('RY', 'p2', { clientKey: 'tgt2-aaaaaaaaaaaa' }, 'Tgt');
    const res2 = await w.submit('RY', {});
    if (res2.ok) expect(w.store.loadReport(res2.reportId)?.scope).toBeNull();
  });

  it('a report a filter files (no reporter) is stamped too', async () => {
    const w = await world();
    w.cw.rooms.seat('RF', 'p2', { clientKey: 'tgt-filter-aaaaaaa' }, 'Tgt', { scope: A });
    const subject = w.cw.rooms.subjectAt('RF', 'p2')!;
    w.cw.chat.accept('RF', 'p2', 'x');
    expect(await w.cw.reports.fileSystem({ origin: 'filter', originKey: 'link.unlisted', roomId: 'RF', target: subject, lineId: '1', reportedReason: 'spam' })).toBe('filed');
    const filed = w.store.listReports({ limit: 10 });
    expect(filed).toHaveLength(1);
    expect(filed[0]?.scope).toBe(A);
  });
});

describe('cw.reports.list with a scope', () => {
  it('returns only matching rows; two scopes OR together; an empty list returns nothing; none is everything; a null scope is invisible', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const b = await fileIn(w, B);
    const c = await fileIn(w, C);
    const none = await fileIn(w, null);
    expect(ids(w, [A])).toEqual([a.id]);
    expect(ids(w, [A, B]).sort()).toEqual([a.id, b.id].sort());
    expect(ids(w, [])).toEqual([]);
    expect(ids(w, ['creator:nobody'])).toEqual([]);
    expect(ids(w).sort()).toEqual([a.id, b.id, c.id, none.id].sort());
    expect(ids(w, [A, B, C])).not.toContain(none.id);
  });

  it('pages in the same order and with the same cursor as unscoped', async () => {
    const w = await world();
    const mine: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      mine.push((await fileIn(w, A)).id);
      await fileIn(w, B);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = w.cw.reports.list({ limit: 2, scope: [A], ...(cursor === null ? {} : { before: cursor }) });
      seen.push(...res.items.map((r) => r.id));
      cursor = res.next;
      if (cursor === null) break;
    }
    expect(seen).toEqual([...mine].reverse());
    const unscoped = w.cw.reports.list({ limit: 200 }).items.map((r) => r.id).filter((id) => mine.includes(id));
    expect(seen).toEqual(unscoped);
  });

  it('status, reason and urgent filters combine with the scope', async () => {
    const w = await world();
    const a1 = await fileIn(w, A);
    const a2 = await fileIn(w, A);
    const b1 = await fileIn(w, B);
    await w.cw.decide({ reportId: a1.id, verdict: 'no_action', actions: [], actor: MOD });
    w.cw.cases.setUrgent(a2.id, MOD, true);
    w.cw.cases.setUrgent(b1.id, MOD, true);
    expect(w.cw.reports.list({ scope: [A], status: 'open' }).items.map((r) => r.id)).toEqual([a2.id]);
    expect(w.cw.reports.list({ scope: [A], status: 'dismissed' }).items.map((r) => r.id)).toEqual([a1.id]);
    expect(w.cw.reports.list({ scope: [A], urgent: true }).items.map((r) => r.id)).toEqual([a2.id]);
    expect(w.cw.reports.list({ scope: [B], urgent: true }).items.map((r) => r.id)).toEqual([b1.id]);
    expect(w.cw.reports.list({ scope: [C], urgent: true }).items).toEqual([]);
  });

  it('the person query takes the scope too, and a scoped person query never shows another scope\'s report against the same person', async () => {
    const w = await world();
    const a = await fileIn(w, A, { target: 'shared-target-aaaaaaa' });
    const b = await fileIn(w, B, { target: 'shared-target-aaaaaaa' });
    expect(a.target).toBe(b.target);
    expect(w.cw.reports.list({ person: a.target, scope: [A] }).items.map((r) => r.id)).toEqual([a.id]);
    expect(w.cw.reports.list({ person: a.target, scope: [B] }).items.map((r) => r.id)).toEqual([b.id]);
    expect(w.cw.reports.list({ person: a.target, scope: [] }).items).toEqual([]);
    expect(w.cw.reports.list({ person: a.target }).items).toHaveLength(2);
  });

  it('a malformed scope is refused, never read as everything', async () => {
    const w = await world();
    await fileIn(w, A);
    for (const scope of ['creator:alice', 5, null, {}, [5], [''], ['a b']]) {
      expect(() => w.cw.reports.list({ scope } as never), String(scope)).toThrow();
    }
  });
});

describe('cw.reports.get with a scope', () => {
  it('is null for a report out of scope or with no scope, whole for one in scope, and unchanged without a scope', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const none = await fileIn(w, null);
    expect(w.cw.reports.get(a.id, { scope: [A] })?.id).toBe(a.id);
    expect(w.cw.reports.get(a.id, { scope: [B] })).toBeNull();
    expect(w.cw.reports.get(a.id, { scope: [] })).toBeNull();
    expect(w.cw.reports.get(none.id, { scope: [A, B] })).toBeNull();
    expect(w.cw.reports.get(a.id)?.id).toBe(a.id);
    expect(w.cw.reports.get(none.id)?.id).toBe(none.id);
    expect(w.cw.reports.get('nope', { scope: [A] })).toBeNull();
  });

  it('a scoped read leaves out the surge hint, which counts other scopes\' reports', async () => {
    const w = await world({ overrides: { desk: { surge: { enabled: true, reports: 3, windowMinutes: 60, newAccountDays: 7 } } } });
    const a = await fileIn(w, A, { target: 'surge-target-aaaaaaaa' });
    await fileIn(w, B, { target: 'surge-target-aaaaaaaa' });
    await fileIn(w, B, { target: 'surge-target-aaaaaaaa' });
    expect(w.cw.reports.get(a.id)?.surge).toBeDefined();
    expect(w.cw.reports.get(a.id, { scope: [A] })?.surge).toBeUndefined();
  });
});

describe('the queue: take next, claim, release and viewing', () => {
  it('take next serves only a case with an open report in scope, and opens it on the newest report in scope', async () => {
    const w = await world();
    const a = await fileIn(w, A, { target: 'person-x-aaaaaaaaaaaa' });
    w.clock.t += MIN;
    const b = await fileIn(w, B, { target: 'person-x-aaaaaaaaaaaa' });
    const c = await fileIn(w, C);
    expect(w.cw.cases.next('m1', { scope: [A] })).toMatchObject({ person: a.target, reportId: a.id });
    expect(w.cw.cases.next('m2', { scope: [B] })).toBeNull();
    expect(w.cw.cases.next('m3', { scope: [C] })).toMatchObject({ reportId: c.id });
    expect(w.cw.cases.next('m4', { scope: [] })).toBeNull();
    // the person is held, so another scope that holds a report against them finds the case taken, never the other scope's report
    expect(b.id).not.toBe(a.id);
  });

  it('with only out-of-scope and unscoped reports open, take next answers null and claims nothing', async () => {
    const w = await world();
    await fileIn(w, B);
    await fileIn(w, null);
    expect(w.cw.cases.next('m1', { scope: [A] })).toBeNull();
    expect(w.store.loadClaims([], 0)).toEqual([]);
    expect(w.cw.cases.next('m2')).not.toBeNull();
  });

  it('the urgent pass is scoped: an urgent case in another scope is never served to this one', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const b = await fileIn(w, B);
    w.clock.t += MIN;
    const a2 = await fileIn(w, A);
    w.cw.cases.setUrgent(b.id, MOD, true);
    w.cw.cases.setUrgent(a2.id, MOD, true);
    expect(w.cw.cases.next('m1', { scope: [A] })).toMatchObject({ reportId: a2.id });
    expect(w.cw.cases.next('m2', { scope: [A] })).toMatchObject({ reportId: a.id });
    expect(w.cw.cases.next('m3', { scope: [A] })).toBeNull();
    expect(w.cw.cases.next('m4', { scope: [B] })).toMatchObject({ reportId: b.id });
  });

  it('claim is no_case for a person with no open report in scope, and works for one in scope', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const b = await fileIn(w, B);
    expect(w.cw.cases.claim(a.target, 'm1', { scope: [B] })).toEqual({ ok: false, error: 'no_case' });
    expect(w.cw.cases.claim(a.target, 'm1', { scope: [A] })).toMatchObject({ ok: true });
    expect(w.cw.cases.claim(b.target, 'm1', { scope: [A] })).toEqual({ ok: false, error: 'no_case' });
    expect(w.cw.cases.claim(b.target, 'm1')).toMatchObject({ ok: true });
  });

  it('a person decided in scope but still open elsewhere is a case only for the scope that holds the open report', async () => {
    const w = await world();
    const a = await fileIn(w, A, { target: 'both-aaaaaaaaaaaaaaa' });
    await fileIn(w, B, { target: 'both-aaaaaaaaaaaaaaa' });
    await w.cw.decide({ reportId: a.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.claim(a.target, 'm1', { scope: [A] })).toEqual({ ok: false, error: 'no_case' });
    expect(w.cw.cases.claim(a.target, 'm1', { scope: [B] })).toMatchObject({ ok: true });
  });

  it('view is false out of scope, true in scope; inScope says whether the person has any report in scope, open or decided', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    expect(w.cw.cases.view(a.target, 'm1', [B])).toBe(false);
    expect(w.cw.cases.view(a.target, 'm1', [A])).toBe(true);
    expect(w.cw.cases.view(a.target, 'm1')).toBe(true);
    expect(w.cw.cases.inScope(a.target, [A])).toBe(true);
    expect(w.cw.cases.inScope(a.target, [B])).toBe(false);
    expect(w.cw.cases.inScope(a.target, [])).toBe(false);
    await w.cw.decide({ reportId: a.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.inScope(a.target, [A])).toBe(true);
    expect(w.cw.cases.view(a.target, 'm1', [A])).toBe(false);
    expect(w.cw.cases.inScope('s_nobody', [A])).toBe(false);
  });

  it('urgentCount counts only the urgent open reports in scope', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const b = await fileIn(w, B);
    const b2 = await fileIn(w, B);
    const none = await fileIn(w, null);
    for (const r of [a, b, b2, none]) w.cw.cases.setUrgent(r.id, MOD, true);
    expect(w.cw.cases.urgentCount()).toBe(4);
    expect(w.cw.cases.urgentCount([A])).toBe(1);
    expect(w.cw.cases.urgentCount([B])).toBe(2);
    expect(w.cw.cases.urgentCount([A, B])).toBe(3);
    expect(w.cw.cases.urgentCount([C])).toBe(0);
    expect(w.cw.cases.urgentCount([])).toBe(0);
    await w.cw.decide({ reportId: b.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.urgentCount([B])).toBe(1);
  });
});

describe('the person record, scoped', () => {
  it('scopedHistory holds the reports in scope and the sanctions that came from them, and nothing else', async () => {
    const w = await world();
    const a = await fileIn(w, A, { target: 'rec-person-aaaaaaaaaa' });
    w.clock.t += MIN;
    const b = await fileIn(w, B, { target: 'rec-person-aaaaaaaaaa' });
    expect((await w.cw.decide({ reportId: a.id, verdict: 'upheld', reason: 'in scope', actions: [warn(a.target)], actor: MOD })).ok).toBe(true);
    expect((await w.cw.decide({ reportId: b.id, verdict: 'upheld', reason: 'elsewhere', actions: [{ ...warn(a.target), kind: 'chat', durationMs: HOUR }], actor: MOD })).ok).toBe(true);
    // a direct sanction (no report) and an automatic-looking one
    await w.cw.sanctions.apply({ kind: 'ban', subject: a.target, includeIp: false, durationMs: 24 * HOUR, reason: 'direct', actor: MOD, source: 'moderator', automated: false, rule: 1 });

    const inA = w.cw.scopedHistory(a.target, [A]);
    expect(inA.reports.map((r) => r.id)).toEqual([a.id]);
    expect(inA.sanctions.map((s) => s.kind)).toEqual(['warning']);
    expect(inA.history.map((h) => h.kind)).toEqual(['warning']);
    expect(inA.handle).toBe('Tgt');
    const inB = w.cw.scopedHistory(a.target, [B]);
    expect(inB.reports.map((r) => r.id)).toEqual([b.id]);
    expect(inB.sanctions.map((s) => s.kind)).toEqual(['chat']);
    const both = w.cw.scopedHistory(a.target, [A, B]);
    expect(both.sanctions.map((s) => s.kind).sort()).toEqual(['chat', 'warning']);
    expect(both.sanctions.map((s) => s.kind)).not.toContain('ban');
    const none = w.cw.scopedHistory(a.target, [C]);
    expect(none).toMatchObject({ reports: [], sanctions: [], history: [], handle: null });
    expect(w.cw.scopedHistory(a.target, [])).toMatchObject({ reports: [], sanctions: [] });
    // the whole record is unchanged for a global caller
    expect(w.cw.history(a.target).map((h) => h.kind).sort()).toEqual(['ban', 'chat', 'warning']);
  });

  it('a scoped history carries no account, signal, link or other-room field', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    await w.cw.decide({ reportId: a.id, verdict: 'upheld', reason: 'r', actions: [warn(a.target)], actor: MOD });
    const h = w.cw.scopedHistory(a.target, [A]);
    expect(Object.keys(h).sort()).toEqual(['handle', 'history', 'reports', 'sanctions']);
    expect(JSON.stringify(h)).not.toMatch(/account|signal|links|client|ip/i);
  });

  it('sanctions.list with a scope pages only the sanctions of in-scope reports; forPerson takes it too', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const b = await fileIn(w, B);
    await w.cw.decide({ reportId: a.id, verdict: 'upheld', reason: 'r', actions: [warn(a.target)], actor: MOD });
    await w.cw.decide({ reportId: b.id, verdict: 'upheld', reason: 'r', actions: [warn(b.target)], actor: MOD });
    await w.cw.sanctions.apply({ kind: 'warning', subject: a.target, includeIp: false, durationMs: null, reason: 'direct', actor: MOD, source: 'moderator', automated: false, rule: 1 });
    expect(w.cw.sanctions.list({ limit: 200 }).items).toHaveLength(3);
    expect(w.cw.sanctions.list({ limit: 200, scope: [A] }).items.map((i) => i.person)).toEqual([a.target]);
    expect(w.cw.sanctions.list({ limit: 200, scope: [B] }).items.map((i) => i.person)).toEqual([b.target]);
    expect(w.cw.sanctions.list({ limit: 200, scope: [A, B] }).items).toHaveLength(2);
    expect(w.cw.sanctions.list({ limit: 200, scope: [] }).items).toEqual([]);
    expect(w.cw.sanctions.forPerson(a.target)).toHaveLength(2);
    expect(w.cw.sanctions.forPerson(a.target, { scope: [A] })).toHaveLength(1);
    expect(w.cw.sanctions.forPerson(a.target, { scope: [B] })).toHaveLength(0);
  });

  it('revoke with a scope works only for a sanction that came from an in-scope report; a direct one and another scope\'s are not found', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const b = await fileIn(w, B);
    await w.cw.decide({ reportId: a.id, verdict: 'upheld', reason: 'r', actions: [warn(a.target)], actor: MOD });
    await w.cw.decide({ reportId: b.id, verdict: 'upheld', reason: 'r', actions: [warn(b.target)], actor: MOD });
    const direct = await w.cw.sanctions.apply({ kind: 'warning', subject: a.target, includeIp: false, durationMs: null, reason: 'direct', actor: MOD, source: 'moderator', automated: false, rule: 1 });
    const groupOf = (person: string, reportScope: string[]) => w.cw.sanctions.list({ limit: 200, scope: reportScope }).items.find((i) => i.person === person)!.groupId;
    const ga = groupOf(a.target, [A]);
    const gb = groupOf(b.target, [B]);
    expect(await w.cw.sanctions.revoke(direct.groupId, 'm1', 'why', { scope: [A] })).toBe(false);
    expect(await w.cw.sanctions.revoke(gb, 'm1', 'why', { scope: [A] })).toBe(false);
    expect(await w.cw.sanctions.revoke('g_nope', 'm1', 'why', { scope: [A] })).toBe(false);
    expect(await w.cw.sanctions.revoke(ga, 'm1', 'why', { scope: [A] })).toBe(true);
    expect(await w.cw.sanctions.revoke(ga, 'm1', 'again', { scope: [A] })).toBe(false);
    // unscoped is unchanged
    expect(await w.cw.sanctions.revoke(direct.groupId, 'm1', 'why')).toBe(true);
    expect(await w.cw.sanctions.revoke(gb, 'm1', 'why')).toBe(true);
  });

  it('apply with forReport stores the report on the sanction so the scoped reads find it; an unknown report is refused', async () => {
    const w = await world();
    const a = await fileIn(w, A);
    const done = await w.cw.sanctions.apply({ kind: 'warning', subject: a.target, includeIp: false, durationMs: null, reason: 'x', actor: MOD, source: 'moderator', automated: false, rule: 1 }, { forReport: a.id });
    expect(w.cw.sanctions.list({ limit: 50, scope: [A] }).items.map((i) => i.groupId)).toEqual([done.groupId]);
    expect(w.cw.sanctions.list({ limit: 50, scope: [B] }).items).toEqual([]);
    await expect(w.cw.sanctions.apply({ kind: 'warning', subject: a.target, includeIp: false, durationMs: null, reason: 'x', actor: MOD, source: 'moderator', automated: false, rule: 1 }, { forReport: 'r_missing' })).rejects.toThrow();
  });

  it('suggest with a scope ignores what happened in other scopes: a ban elsewhere does not raise the step, and no signals are read', async () => {
    const w = await world();
    const a = await fileIn(w, A, { target: 'sug-person-aaaaaaaaaa' });
    w.clock.t += MIN;
    const b = await fileIn(w, B, { target: 'sug-person-aaaaaaaaaa' });
    await w.cw.decide({ reportId: b.id, verdict: 'upheld', reason: 'r', actions: [{ ...warn(a.target), kind: 'ban', durationMs: 40 * 24 * HOUR }], actor: MOD });
    const global = w.cw.suggest(a.target, 'hostile', 1, { roomId: a.room });
    const scoped = w.cw.suggest(a.target, 'hostile', 1, { roomId: a.room, scope: [A] });
    const clean = w.cw.suggest('s_nobody_has_this', 'hostile', 1, { roomId: a.room });
    expect(global.outcome).not.toEqual(clean.outcome);
    expect(scoped.outcome).toEqual(clean.outcome);
    expect(scoped.signals).toBeUndefined();
    expect(w.cw.suggest(a.target, 'hostile', 1, { roomId: a.room, scope: [A, B] }).outcome).toEqual(global.outcome);
  });
});
