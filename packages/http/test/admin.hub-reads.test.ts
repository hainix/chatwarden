import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEYS, PERMISSIONS } from '../src/index.js';
import type { TermsAdmin } from '../src/index.js';
import { DAY, HOUR, IP_TARGET, KEY_TARGET, NOW, errorOf, keysDeep, world } from './world.js';

// The staff read routes the moderator hub needs (K4 Task 2): sanction groups on the history page and across everyone,
// the reporter's record, blocked messages, term metadata, the message tester and the queue's target handle.

type W = Awaited<ReturnType<typeof world>>;

/** A reporter (p1) and a target (p2) in a room of their own, one report filed. */
async function file(w: W, over: { targetHandle?: string; key?: string } = {}) {
  const n = ++seq;
  const room = `hub-room-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-reporter-${n}`, ip: '198.51.100.23' }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: over.key ?? `${KEY_TARGET}-hub-${n}`, ip: IP_TARGET }, over.targetHandle ?? 'TargetName');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
  if (!res.ok) throw new Error(`report refused: ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  if (report === null) throw new Error('report missing');
  return { room, id: res.reportId, target: report.targetPerson, reporter: report.reporterPerson };
}
let seq = 0;

const sanction = (w: W, subject: string, over: Record<string, unknown> = {}) =>
  w.cw.sanctions.apply({
    kind: 'chat',
    subject,
    includeIp: false,
    durationMs: DAY,
    reason: 'private moderator reason',
    actor: 'ann',
    source: 'moderator',
    automated: false,
    rule: 2,
    ...over,
  } as Parameters<W['cw']['sanctions']['apply']>[0]);

const strike = (w: W, id: string, at: number, over: Partial<Parameters<W['store']['insertStrike']>[0]> = {}) =>
  w.store.insertStrike({ id, at, subject: 's_blocked', roomId: 'ROOM1', termId: 'syn:zorbak', rawLine: 'you zorbak', ...over });

const SANCTION_VIEW_KEYS = [
  'groupId', 'refCode', 'kind', 'rule', 'startsAt', 'endsAt', 'reason', 'actor', 'source', 'automated', 'active', 'pending',
  'revokedAt', 'revokedBy', 'revokeReason',
].sort();

const ZERO_REPORTER = { reports: 0, open: 0, actioned: 0, dismissed: 0, badFaith: 0, suspendedUntil: null };

describe('the permission table', () => {
  it('has blocked.read at moderator, and the key list includes it', () => {
    expect(PERMISSIONS['blocked.read']).toBe('moderator');
    expect(PERMISSION_KEYS).toContain('blocked.read');
  });

  it('LiveTerms satisfies the widened TermsAdmin (a compile-time check, and the tester is mounted)', async () => {
    const w = await world();
    const asAdmin: TermsAdmin = w.live;
    expect(typeof asAdmin.match).toBe('function');
    expect(typeof asAdmin.records).toBe('function');
    expect(Object.keys(w.routes)).toContain('POST /terms/test');
  });
});

describe('GET /people/:ref/history: sanctions and asReporter', () => {
  it('keeps history and reports exactly as they were and adds sanctions and asReporter after them', async () => {
    const w = await world();
    const r = await file(w);
    await sanction(w, r.target, { kind: 'warning', durationMs: null });
    const res = await w.call('GET', `/people/${r.target}/history`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['history', 'reports', 'sanctions', 'asReporter']);
    expect(body.history).toEqual(w.cw.history(r.target));
    expect(body.reports).toEqual([{ id: r.id, createdAt: expect.any(Number), category: 'harassment' }]);
  });

  it('an unknown person has no sanctions and a zero reporter record (200)', async () => {
    const w = await world();
    const res = await w.call('GET', '/people/s_nobody/history');
    expect(res.body).toEqual({ history: [], reports: [], sanctions: [], asReporter: ZERO_REPORTER });
  });

  it('lists the sanctions newest first as SanctionGroupView, never an ip row, value or id', async () => {
    const w = await world();
    const r = await file(w);
    const a = await sanction(w, r.target, { includeIp: true, reason: 'spamming the lobby', rule: 4 });
    w.clock.t += HOUR;
    const b = await sanction(w, r.target, { kind: 'warning', durationMs: null, rule: 'uncovered', gapNote: 'a private gap note' });
    const res = await w.call('GET', `/people/${r.target}/history`);
    const sanctions = (res.body as { sanctions: Array<Record<string, unknown>> }).sanctions;
    expect(sanctions.map((s) => s.groupId)).toEqual([b.groupId, a.groupId]);
    expect(sanctions[1]).toEqual({
      groupId: a.groupId, refCode: a.refCode, kind: 'chat', rule: 4, startsAt: NOW + 1000, endsAt: NOW + 1000 + DAY,
      reason: 'spamming the lobby', actor: 'ann', source: 'moderator', automated: false, active: true, pending: false,
      revokedAt: null, revokedBy: null, revokeReason: null,
    });
    expect(sanctions[0]).toMatchObject({ kind: 'warning', endsAt: null, rule: 'uncovered', active: true });
    for (const s of sanctions) expect(Object.keys(s).sort()).toEqual(SANCTION_VIEW_KEYS);
    expect(JSON.stringify(res.body)).not.toContain('a private gap note');
  });

  it('a revoke made through the route shows who, when and why', async () => {
    const w = await world();
    const r = await file(w);
    const made = await sanction(w, r.target);
    w.clock.t += 5000;
    const revoked = await w.call('POST', `/sanctions/${made.groupId}/revoke`, { actor: 'bea', body: { reason: 'wrong person' } });
    expect(revoked.status).toBe(200);
    const sanctions = ((await w.call('GET', `/people/${r.target}/history`)).body as { sanctions: Array<Record<string, unknown>> }).sanctions;
    expect(sanctions[0]).toMatchObject({ active: false, revokedAt: NOW + 1000 + 5000, revokedBy: 'bea', revokeReason: 'wrong person' });
  });

  it('is the 90 day window plus every unrevoked permanent one', async () => {
    const w = await world();
    const r = await file(w);
    const now = w.clock.t;
    w.clock.t = now - 100 * DAY;
    const oldTimed = await sanction(w, r.target, { durationMs: 7 * DAY });
    const oldPerm = await sanction(w, r.target, { kind: 'ban', durationMs: null });
    const oldRevoked = await sanction(w, r.target, { kind: 'ban', durationMs: null });
    await w.cw.sanctions.revoke(oldRevoked.groupId, 'bob', 'lifted');
    w.clock.t = now - 10 * DAY;
    const recent = await sanction(w, r.target);
    w.clock.t = now;
    const ids = ((await w.call('GET', `/people/${r.target}/history`)).body as { sanctions: Array<{ groupId: string }> }).sanctions.map((s) => s.groupId);
    expect(ids).toEqual([recent.groupId, oldPerm.groupId]);
    expect(ids).not.toContain(oldTimed.groupId);
    expect(ids).not.toContain(oldRevoked.groupId);
  });

  it("another person's sanctions are not included (control)", async () => {
    const w = await world();
    const a = await file(w);
    const b = await file(w);
    await sanction(w, b.target);
    const body = (await w.call('GET', `/people/${a.target}/history`)).body as { sanctions: unknown[] };
    expect(body.sanctions).toEqual([]);
  });

  it('asReporter counts the reports the person filed, by outcome, and ignores reports against them', async () => {
    const w = await world();
    const first = await file(w);
    const second = await file(w);
    // The same reporter person filed both? No: each room has its own reporter. Use the store to put two on one reporter.
    const reporter = first.reporter;
    w.store.insertReport({
      id: 'extra-1', createdAt: NOW, roomId: 'extra-room-1', tags: {}, reporterSubject: reporter, reporterSeat: 'p1', reporterHandle: 'Rep',
      targetSubject: second.target, targetSeat: 'p2', targetHandle: 'T', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    });
    w.store.insertReport({
      id: 'extra-2', createdAt: NOW, roomId: 'extra-room-2', tags: {}, reporterSubject: reporter, reporterSeat: 'p1', reporterHandle: 'Rep',
      targetSubject: second.target, targetSeat: 'p2', targetHandle: 'T', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    });
    w.store.closeReport('extra-1', 'actioned', false, 'mod', NOW + 1, 'ok');
    w.store.closeReport('extra-2', 'dismissed', true, 'mod', NOW + 2, 'bad faith');
    const body = (await w.call('GET', `/people/${reporter}/history`)).body as { asReporter: unknown };
    expect(body.asReporter).toEqual({ reports: 3, open: 1, actioned: 1, dismissed: 1, badFaith: 1, suspendedUntil: null });
    // Filed against: nothing as a reporter.
    expect(((await w.call('GET', `/people/${second.target}/history`)).body as { asReporter: unknown }).asReporter).toEqual(ZERO_REPORTER);
  });

  it('asReporter.suspendedUntil is set after three bad-faith dismissals inside 30 days', async () => {
    const w = await world();
    const first = await file(w);
    const reporter = first.reporter;
    const marks = [NOW - 5 * DAY, NOW - 3 * DAY, NOW - DAY];
    marks.forEach((at, i) => {
      const id = `bf-${i}`;
      w.store.insertReport({
        id, createdAt: NOW - 6 * DAY, roomId: `bf-room-${i}`, tags: {}, reporterSubject: reporter, reporterSeat: 'p1', reporterHandle: 'Rep',
        targetSubject: 's_other', targetSeat: 'p2', targetHandle: 'T', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open',
      });
      w.store.closeReport(id, 'dismissed', true, 'mod', at, 'bad faith', 'evidence');
    });
    const body = (await w.call('GET', `/people/${reporter}/history`)).body as { asReporter: Record<string, unknown> };
    expect(body.asReporter).toMatchObject({ reports: 4, badFaith: 3, suspendedUntil: marks[0]! + 30 * DAY + 1 });
  });

  it('still audits history.view and nothing else, and is gated by history.read', async () => {
    const w = await world();
    const r = await file(w);
    await w.call('GET', `/people/${r.target}/history`, { actor: 'fay' });
    expect(w.routeAudit().map((a) => [a.actor, a.action, a.target])).toEqual([['fay', 'history.view', { type: 'person', ref: r.target }]]);
    const locked = await world({ permissions: { 'history.read': 'senior' } });
    expect((await locked.call('GET', '/people/s_x/history', { role: 'moderator' })).status).toBe(403);
    expect((await locked.call('GET', '/people/s_x/history', { role: 'senior' })).status).toBe(200);
    expect((await locked.call('GET', '/people/s_x/history', { role: null })).status).toBe(401);
  });
});

describe('GET /sanctions', () => {
  it('is empty with next null when nothing was sanctioned, and writes no audit row', async () => {
    const w = await world();
    const res = await w.call('GET', '/sanctions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], next: null });
    expect(w.routeAudit()).toEqual([]);
  });

  it('lists every person newest first as SanctionGroupView plus the person', async () => {
    const w = await world();
    const a = await file(w);
    const b = await file(w);
    const first = await sanction(w, a.target, { includeIp: true });
    w.clock.t += 1000;
    const second = await sanction(w, b.target, { kind: 'ban', durationMs: null, source: 'api' });
    const res = await w.call('GET', '/sanctions');
    const body = res.body as { items: Array<Record<string, unknown>>; next: string | null };
    expect(body.items.map((i) => i.groupId)).toEqual([second.groupId, first.groupId]);
    expect(body.next).toBeNull();
    expect(body.items[0]).toEqual({
      groupId: second.groupId, refCode: second.refCode, kind: 'ban', rule: 2, startsAt: w.clock.t, endsAt: null, reason: 'private moderator reason',
      actor: 'ann', source: 'api', automated: false, active: true, pending: false, revokedAt: null, revokedBy: null, revokeReason: null, person: b.target,
      handle: 'TargetName',
    });
    expect(body.items[1]?.person).toBe(a.target);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual([...SANCTION_VIEW_KEYS, 'person', 'handle'].sort());
  });

  describe('handle: the name on the latest report against the person', () => {
    const handleOf = async (w: W, groupId: string): Promise<unknown> =>
      ((await w.call('GET', '/sanctions')).body as { items: Array<{ groupId: string; handle: unknown }> }).items.find((i) => i.groupId === groupId)?.handle;

    it('is the reported person handle, null when nobody ever reported them', async () => {
      const w = await world();
      const a = await file(w, { targetHandle: 'Zorbak' });
      const unreported = await sanction(w, 's_never_reported_0000000000');
      const named = await sanction(w, a.target);
      expect(await handleOf(w, named.groupId)).toBe('Zorbak');
      expect(await handleOf(w, unreported.groupId)).toBeNull();
    });

    it('is the handle on the LATEST report when the person was reported under two names', async () => {
      const w = await world();
      await file(w, { targetHandle: 'OldName', key: 'raw-client-key-same-person-0001' });
      w.clock.t += 5000;
      const later = await file(w, { targetHandle: 'NewName', key: 'raw-client-key-same-person-0001' });
      const s = await sanction(w, later.target);
      expect(await handleOf(w, s.groupId)).toBe('NewName');
    });

    it('is null when the latest report recorded no handle, and one person in two groups gets the same handle', async () => {
      const w = await world();
      const blank = await file(w, { targetHandle: '' });
      const one = await sanction(w, blank.target);
      expect(await handleOf(w, one.groupId)).toBeNull();
      const named = await file(w, { targetHandle: 'Vlemmo' });
      const x = await sanction(w, named.target);
      w.clock.t += 1000;
      const y = await sanction(w, named.target, { kind: 'warning', durationMs: null });
      expect([await handleOf(w, x.groupId), await handleOf(w, y.groupId)]).toEqual(['Vlemmo', 'Vlemmo']);
    });

    it('counts only reports filed against the person (a reporter has none), and an automatic sanction carries it too', async () => {
      const w = await world();
      const r = await file(w, { targetHandle: 'Quissel' });
      const asReporter = await sanction(w, r.reporter);
      const auto = await sanction(w, r.target, { source: 'auto_filter', automated: true });
      expect(await handleOf(w, asReporter.groupId)).toBeNull();
      expect(await handleOf(w, auto.groupId)).toBe('Quissel');
    });

    it('adds no audit row, and the handle is a string or null', async () => {
      const w = await world();
      const r = await file(w, { targetHandle: 'Drakkuun' });
      await sanction(w, r.target);
      const items = ((await w.call('GET', '/sanctions')).body as { items: Array<{ handle: unknown }> }).items;
      for (const i of items) expect(i.handle === null || typeof i.handle === 'string').toBe(true);
      expect(w.routeAudit()).toEqual([]);
    });
  });

  it('pages: one page, exactly one full page, the empty page after it, a cursor past the end', async () => {
    const w = await world();
    const a = await file(w);
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      w.clock.t += 1000;
      made.unshift((await sanction(w, a.target, { kind: 'warning', durationMs: null })).groupId);
    }
    const ids = (res: { body: unknown }) => (res.body as { items: Array<{ groupId: string }> }).items.map((i) => i.groupId);
    const nextOf = (res: { body: unknown }) => (res.body as { next: string | null }).next;
    const p1 = await w.call('GET', '/sanctions', { query: { limit: '2' } });
    expect(ids(p1)).toEqual(made.slice(0, 2));
    const p2 = await w.call('GET', '/sanctions', { query: { limit: '2', cursor: nextOf(p1) as string } });
    expect(ids(p2)).toEqual(made.slice(2, 4));
    const p3 = await w.call('GET', '/sanctions', { query: { limit: '2', cursor: nextOf(p2) as string } });
    expect(ids(p3)).toEqual(made.slice(4));
    expect(nextOf(p3)).toBeNull();

    const exact = await w.call('GET', '/sanctions', { query: { limit: '5' } });
    expect(ids(exact)).toEqual(made);
    const after = await w.call('GET', '/sanctions', { query: { limit: '5', cursor: nextOf(exact) as string } });
    expect(after.body).toEqual({ items: [], next: null });

    // The default page is 50.
    expect(ids(await w.call('GET', '/sanctions'))).toEqual(made);
  });

  it('limit: 0 and an oversized limit are clamped; a non-number is 400 invalid_query', async () => {
    const w = await world();
    const a = await file(w);
    for (let i = 0; i < 3; i += 1) {
      w.clock.t += 1000;
      await sanction(w, a.target, { kind: 'warning', durationMs: null });
    }
    const len = async (limit: string) => ((await w.call('GET', '/sanctions', { query: { limit } })).body as { items: unknown[] }).items.length;
    expect(await len('0')).toBe(1);
    expect(await len('999999')).toBe(3);
    for (const bad of ['abc', '1.5', '-1', '', '1234567890', ' 2']) {
      const res = await w.call('GET', '/sanctions', { query: { limit: bad } });
      expect([res.status, errorOf(res)], bad).toEqual([400, 'invalid_query']);
    }
  });

  it('a cursor we did not issue is 400 invalid_query, with a fixed message', async () => {
    const w = await world();
    for (const bad of ['!!!', 'not-a-cursor', 'abc', '%', 'bm90LWEtY3Vyc29y', '']) {
      const res = await w.call('GET', '/sanctions', { query: { cursor: bad } });
      expect([res.status, errorOf(res)], bad).toEqual([400, 'invalid_query']);
      expect(JSON.stringify(res.body)).not.toContain(bad === '' ? '\u0000' : bad);
    }
  });

  it('source filters; an unknown source is 400 invalid_query', async () => {
    const w = await world();
    const a = await file(w);
    const mod = await sanction(w, a.target);
    w.clock.t += 1000;
    const auto = await sanction(w, a.target, { source: 'auto_filter', automated: true });
    const only = async (source: string) =>
      ((await w.call('GET', '/sanctions', { query: { source } })).body as { items: Array<{ groupId: string }> }).items.map((i) => i.groupId);
    expect(await only('auto_filter')).toEqual([auto.groupId]);
    expect(await only('moderator')).toEqual([mod.groupId]);
    expect(await only('coop')).toEqual([]);
    for (const bad of ['robot', 'MODERATOR', '', 'moderator,api']) {
      const res = await w.call('GET', '/sanctions', { query: { source: bad } });
      expect([res.status, errorOf(res)], bad).toEqual([400, 'invalid_query']);
    }
  });

  it('is gated by history.read and 401 without authz; a 400 and a 403 write nothing', async () => {
    const locked = await world({ permissions: { 'history.read': 'owner' } });
    expect((await locked.call('GET', '/sanctions', { role: 'senior' })).status).toBe(403);
    expect((await locked.call('GET', '/sanctions', { role: 'owner' })).status).toBe(200);
    expect((await locked.call('GET', '/sanctions', { role: null })).status).toBe(401);
    expect(locked.routeAudit()).toEqual([]);
  });
});

describe('GET /blocked', () => {
  it('is empty when nothing was blocked, and audits blocked.view (no target) with the caller', async () => {
    const w = await world();
    const res = await w.call('GET', '/blocked', { actor: 'gus', role: 'moderator' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    expect(w.routeAudit().map((a) => [a.actor, a.role, a.action, a.target])).toEqual([['gus', 'moderator', 'blocked.view', undefined]]);
  });

  it('lists the blocked lines newest first with the term and language from the injected terms', async () => {
    const w = await world();
    strike(w, 'k1', NOW - 3 * HOUR, { rawLine: 'oldest line', termId: 'syn:zorbak', subject: 's_a' });
    strike(w, 'k2', NOW - HOUR, { rawLine: 'newest line', termId: 'syn:vlemmo', subject: 's_b', roomId: 'ROOM2' });
    const body = (await w.call('GET', '/blocked', { query: { days: '1' } })).body as { items: Array<Record<string, unknown>> };
    expect(body.items.map((i) => i.id)).toEqual(['k2', 'k1']);
    expect(body.items[0]).toEqual({
      id: 'k2', at: NOW - HOUR, roomId: 'ROOM2', termId: 'syn:vlemmo', term: 'vlemmo', language: 'en', person: 's_b', text: 'newest line',
    });
    expect(Object.keys(body.items[0]!)).toEqual(['id', 'at', 'roomId', 'termId', 'term', 'language', 'person', 'text']);
  });

  it('term and language are null when the term is no longer listed, and when no terms are mounted', async () => {
    const w = await world();
    strike(w, 'k1', NOW - HOUR, { termId: 'gone:term' });
    const first = (await w.call('GET', '/blocked')).body as { items: Array<Record<string, unknown>> };
    expect(first.items[0]).toMatchObject({ termId: 'gone:term', term: null, language: null });
    const bare = await world({ terms: false });
    strike(bare, 'k1', NOW - HOUR, { termId: 'syn:zorbak' });
    const second = (await bare.call('GET', '/blocked')).body as { items: Array<Record<string, unknown>> };
    expect(second.items[0]).toMatchObject({ termId: 'syn:zorbak', term: null, language: null });
  });

  it('term and language need terms.read as well: a caller without it gets null for both, with termId and text still there', async () => {
    const hidden = await world({ permissions: { 'terms.read': 'senior' } });
    strike(hidden, 'k1', NOW - HOUR, { termId: 'syn:zorbak', rawLine: 'you zorbak' });
    const modBody = (await hidden.call('GET', '/blocked', { role: 'moderator' })).body as { items: Array<Record<string, unknown>> };
    expect(modBody.items[0]).toMatchObject({ termId: 'syn:zorbak', term: null, language: null, text: 'you zorbak' });
    // A senior holds both permissions and sees the term.
    const seniorBody = (await hidden.call('GET', '/blocked', { role: 'senior' })).body as { items: Array<Record<string, unknown>> };
    expect(seniorBody.items[0]).toMatchObject({ term: 'zorbak', language: 'en' });
    // Control: with the default table a moderator holds both.
    const open = await world();
    strike(open, 'k1', NOW - HOUR, { termId: 'syn:zorbak' });
    const body = (await open.call('GET', '/blocked', { role: 'moderator' })).body as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ term: 'zorbak', language: 'en' });
  });

  it('terms.read decides per caller, whatever blocked.read allows', async () => {
    const w = await world({ permissions: { 'blocked.read': 'moderator', 'terms.read': 'owner' } });
    strike(w, 'k1', NOW - HOUR, { termId: 'syn:zorbak' });
    const owner = (await w.call('GET', '/blocked', { role: 'owner' })).body as { items: Array<Record<string, unknown>> };
    expect(owner.items[0]).toMatchObject({ term: 'zorbak' });
    const senior = (await w.call('GET', '/blocked', { role: 'senior' })).body as { items: Array<Record<string, unknown>> };
    expect(senior.items[0]).toMatchObject({ term: null, language: null });
  });

  it('days defaults to 7 and accepts 1, 7 and 30', async () => {
    const w = await world();
    strike(w, 'd1', NOW - HOUR);
    strike(w, 'd6', NOW - 6 * DAY);
    strike(w, 'd20', NOW - 20 * DAY);
    strike(w, 'd40', NOW - 40 * DAY);
    const ids = async (query?: Record<string, string>) =>
      ((await w.call('GET', '/blocked', { ...(query === undefined ? {} : { query }) })).body as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(await ids()).toEqual(['d1', 'd6']);
    expect(await ids({ days: '1' })).toEqual(['d1']);
    expect(await ids({ days: '7' })).toEqual(['d1', 'd6']);
    expect(await ids({ days: '30' })).toEqual(['d1', 'd6', 'd20']);
  });

  it('any other days is 400 invalid_query and leaves no audit row', async () => {
    const w = await world();
    for (const bad of ['0', '2', '31', '-1', '1.5', 'abc', '', '07', '1,7', ' 7']) {
      const res = await w.call('GET', '/blocked', { query: { days: bad } });
      expect([res.status, errorOf(res)], bad).toEqual([400, 'invalid_query']);
    }
    expect(w.routeAudit()).toEqual([]);
  });

  it('shows at most 500, the newest', async () => {
    const w = await world();
    for (let i = 0; i < 505; i += 1) strike(w, `k${String(i).padStart(4, '0')}`, NOW - 10_000 + i);
    const items = ((await w.call('GET', '/blocked', { query: { days: '1' } })).body as { items: Array<{ id: string }> }).items;
    expect(items).toHaveLength(500);
    expect(items[0]?.id).toBe('k0504');
  });

  it('is gated by blocked.read (moderator by default) and 401 without authz', async () => {
    const w = await world();
    expect((await w.call('GET', '/blocked', { role: 'moderator' })).status).toBe(200);
    expect((await w.call('GET', '/blocked', { role: null })).status).toBe(401);
    const locked = await world({ permissions: { 'blocked.read': 'senior' } });
    expect((await locked.call('GET', '/blocked', { role: 'moderator' })).status).toBe(403);
    expect((await locked.call('GET', '/blocked', { role: 'senior' })).status).toBe(200);
    expect(locked.routeAudit().map((a) => a.action)).toEqual(['blocked.view']);
    // blocked.read is its own permission: history.read does not open it.
    const apart = await world({ permissions: { 'history.read': 'moderator', 'blocked.read': 'owner' } });
    expect((await apart.call('GET', '/sanctions', { role: 'moderator' })).status).toBe(200);
    expect((await apart.call('GET', '/blocked', { role: 'moderator' })).status).toBe(403);
  });

  it('fails closed (500) when the view cannot be audited, and nothing is returned', async () => {
    const failing = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    strike(failing, 'k1', NOW - HOUR);
    const res = await failing.call('GET', '/blocked');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
  });

  it('carries no ip, hash or value key', async () => {
    const w = await world();
    strike(w, 'k1', NOW - HOUR);
    const res = await w.call('GET', '/blocked');
    const keys = keysDeep(res.body);
    for (const bad of ['value', 'ipHash', 'ip', 'clientKey', 'accountId', 'rawLine']) expect(keys.has(bad), bad).toBe(false);
  });
});

describe('GET /terms: metadata and blocks30d', () => {
  it('rows gain note, addedBy, addedAt, updatedBy and updatedAt after the old fields; the response gains blocks30d', async () => {
    const w = await world();
    const res = await w.call('GET', '/terms');
    const body = res.body as { terms: Array<Record<string, unknown>>; exceptions: Array<Record<string, unknown>>; blocks30d: Record<string, number> };
    expect(Object.keys(body)).toEqual(['terms', 'exceptions', 'blocks30d']);
    expect(Object.keys(body.terms[0]!)).toEqual(['id', 'term', 'language', 'active', 'note', 'addedBy', 'addedAt', 'updatedBy', 'updatedAt']);
    expect(Object.keys(body.exceptions[0]!)).toEqual(['id', 'phrase', 'language', 'active', 'note', 'addedBy', 'addedAt', 'updatedBy', 'updatedAt']);
    expect(body.terms[0]).toEqual({
      id: 'syn:zorbak', term: 'zorbak', language: 'en', active: true, note: null, addedBy: 'seed', addedAt: NOW, updatedBy: null, updatedAt: null,
    });
    expect(w.routeAudit()).toEqual([]);
  });

  it('shows a note, the editor and the time after an add and an edit', async () => {
    const w = await world();
    const added = await w.call('POST', '/terms', { actor: 'ann', body: { term: 'glarn', language: 'en', note: 'seen in lobby' } });
    const id = (added.body as { id: string }).id;
    w.clock.t += 5000;
    await w.call('PATCH', `/terms/${id}`, { actor: 'bea', body: { note: 'confirmed' } });
    const row = ((await w.call('GET', '/terms')).body as { terms: Array<Record<string, unknown>> }).terms.find((t) => t.id === id);
    expect(row).toEqual({
      id, term: 'glarn', language: 'en', active: true, note: 'confirmed', addedBy: 'ann', addedAt: NOW, updatedBy: 'bea', updatedAt: NOW + 5000,
    });
  });

  it('blocks30d counts the last 30 days of strikes for every listed term, zero included; exceptions have none', async () => {
    const w = await world();
    strike(w, 'a', NOW - HOUR, { termId: 'syn:zorbak' });
    strike(w, 'b', NOW - 2 * HOUR, { termId: 'syn:zorbak' });
    strike(w, 'c', NOW - 29 * DAY, { termId: 'syn:vlemmo' });
    strike(w, 'd', NOW - 31 * DAY, { termId: 'syn:vlemmo' });
    strike(w, 'e', NOW - HOUR, { termId: 'removed:term' });
    const body = (await w.call('GET', '/terms')).body as { terms: Array<{ id: string }>; blocks30d: Record<string, number> };
    expect(body.blocks30d['syn:zorbak']).toBe(2);
    expect(body.blocks30d['syn:vlemmo']).toBe(1);
    expect(body.blocks30d['syn:snerp']).toBe(0);
    expect(Object.keys(body.blocks30d).sort()).toEqual(body.terms.map((t) => t.id).sort());
  });

  it('keeps a term whose id is __proto__ in blocks30d (a null-prototype record)', async () => {
    const w = await world();
    const { adminRoutes, createRouter } = await import('../src/index.js');
    const fake: TermsAdmin = {
      rows: { terms: [{ id: '__proto__', term: 'blorft', language: 'en', active: true }, { id: 'x1', term: 'snerp', language: 'en', active: true }], exceptions: [] },
      check: () => ({ ok: true, hits: [] }),
      change: () => Promise.resolve({ ok: false, error: 'no' }),
    };
    strike(w, 'p1', NOW - HOUR, { termId: '__proto__' });
    strike(w, 'p2', NOW - HOUR, { termId: '__proto__' });
    const router = createRouter(adminRoutes(w.cw, { authorize: () => ({ actor: 'ann', role: 'moderator' }), terms: fake }));
    const res = await router({ method: 'GET', path: '/terms', query: {}, headers: {}, body: undefined });
    const counts = (res.body as { blocks30d: Record<string, number> }).blocks30d;
    expect(Object.hasOwn(counts, '__proto__')).toBe(true);
    expect(counts['__proto__']).toBe(2);
    expect(counts['x1']).toBe(0);
    expect(Object.keys(counts).sort()).toEqual(['__proto__', 'x1']);
  });

  it('is still gated by terms.read', async () => {
    const locked = await world({ permissions: { 'terms.read': 'owner' } });
    expect((await locked.call('GET', '/terms', { role: 'senior' })).status).toBe(403);
  });
});

describe('POST /terms/test', () => {
  const test = (w: W, body: unknown, over: { role?: 'moderator' | 'senior' | 'owner' | null; raw?: string } = {}) =>
    w.call('POST', '/terms/test', { ...(over.raw === undefined ? { body } : { raw: over.raw }), ...(over.role === undefined ? {} : { role: over.role }) });

  it('blocked: the verdict and the id of the term that matched', async () => {
    const w = await world();
    const res = await test(w, { text: 'you absolute zorbak' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verdict: 'blocked', termId: 'syn:zorbak' });
  });

  it('clean: null term id', async () => {
    const w = await world();
    expect((await test(w, { text: 'good game everyone' })).body).toEqual({ verdict: 'clean', termId: null });
    expect((await test(w, { text: '' })).body).toEqual({ verdict: 'clean', termId: null });
    expect((await test(w, { text: '   ' })).body).toEqual({ verdict: 'clean', termId: null });
  });

  it('an exception that allows the phrase makes it clean (the live matcher decides)', async () => {
    const w = await world();
    expect((await test(w, { text: 'a trip to tarvo lake' })).body).toEqual({ verdict: 'clean', termId: null });
  });

  it('too_long above the chat line limit (200), counted after trimming; the limit itself is fine', async () => {
    const w = await world();
    const spy = vi.spyOn(w.live, 'match');
    const exact = 'a'.repeat(200);
    expect((await test(w, { text: exact })).body).toEqual({ verdict: 'clean', termId: null });
    expect((await test(w, { text: `  ${exact}  ` })).body).toEqual({ verdict: 'clean', termId: null });
    spy.mockClear();
    const over = await test(w, { text: 'a'.repeat(201) });
    expect(over.body).toEqual({ verdict: 'too_long', termId: null });
    // A long line is never handed to the matcher, whatever it holds.
    expect((await test(w, { text: `${'a'.repeat(201)} zorbak` })).body).toEqual({ verdict: 'too_long', termId: null });
    expect(spy).not.toHaveBeenCalled();
    expect(w.cw.limits.chatMaxLength).toBe(200);
  });

  it('is side-effect free: no strike, no audit row, no term change, no log line', async () => {
    const w = await world();
    const rowsBefore = JSON.stringify(w.live.rows);
    const auditBefore = w.audit().length;
    for (let i = 0; i < 25; i += 1) await test(w, { text: 'zorbak zorbak zorbak' });
    expect(w.store.listStrikes(0, 10)).toEqual([]);
    expect(w.audit()).toHaveLength(auditBefore);
    expect(JSON.stringify(w.live.rows)).toBe(rowsBefore);
    expect(w.logged).toEqual([]);
    // Not a rate charge either: the 26th answers like the first.
    expect((await test(w, { text: 'zorbak' })).body).toEqual({ verdict: 'blocked', termId: 'syn:zorbak' });
  });

  it('answers 400 for a body that is not { text: string }', async () => {
    const w = await world();
    for (const body of [{}, { text: 5 }, { text: null }, { text: ['zorbak'] }, { text: { a: 1 } }, [], 'zorbak', null]) {
      const res = await test(w, body);
      expect([res.status, errorOf(res)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
    expect((await test(w, undefined, { raw: '{nope' })).status).toBe(400);
    expect((await test(w, undefined, { raw: '' })).status).toBe(400);
  });

  it('the answer never carries the term text or the line', async () => {
    const w = await world();
    const res = await test(w, { text: 'you zorbak' });
    expect(JSON.stringify(res.body)).not.toMatch(/"zorbak"|you/);
    expect(Object.keys(res.body as object)).toEqual(['verdict', 'termId']);
  });

  it('is gated by terms.read and 401 without authz', async () => {
    const locked = await world({ permissions: { 'terms.read': 'owner' } });
    expect((await test(locked, { text: 'x' }, { role: 'senior' })).status).toBe(403);
    expect((await test(locked, { text: 'x' }, { role: 'owner' })).status).toBe(200);
    expect((await test(locked, { text: 'x' }, { role: null })).status).toBe(401);
  });

  it('is mounted only with terms', async () => {
    const bare = await world({ terms: false });
    expect(Object.keys(bare.routes).filter((k) => k.includes('/terms'))).toEqual([]);
    // No term routes at all: 404.
    expect((await test(bare, { text: 'zorbak' })).status).toBe(404);
  });

  it('works with any terms whose match is a function (a structural TermsAdmin)', async () => {
    const w = await world();
    const { adminRoutes, createRouter } = await import('../src/index.js');
    const fake: TermsAdmin = {
      rows: { terms: [{ id: 'x1', term: 'blorft', language: 'en', active: true }], exceptions: [] },
      check: () => ({ ok: true, hits: [] }),
      change: () => Promise.resolve({ ok: false, error: 'no' }),
      match: (t) => (t.includes('blorft') ? { termId: 'x1' } : null),
    };
    const router = createRouter(adminRoutes(w.cw, { authorize: () => ({ actor: 'ann', role: 'moderator' }), terms: fake }));
    const call = (path: string, method: string, body?: unknown) =>
      router({ method, path, query: {}, headers: {}, body: undefined, ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }) });
    expect((await call('/terms/test', 'POST', { text: 'a blorft' })).body).toEqual({ verdict: 'blocked', termId: 'x1' });
    // No metadata anywhere: the list reads null for it.
    const list = (await call('/terms', 'GET')).body as { terms: Array<Record<string, unknown>> };
    expect(list.terms[0]).toEqual({ id: 'x1', term: 'blorft', language: 'en', active: true, note: null, addedBy: null, addedAt: null, updatedBy: null, updatedAt: null });
    // And without match, the tester is not mounted.
    const noMatch: TermsAdmin = { rows: fake.rows, check: fake.check, change: fake.change };
    const router2 = createRouter(adminRoutes(w.cw, { authorize: () => ({ actor: 'ann', role: 'moderator' }), terms: noMatch }));
    // Terms without `match`: the other term routes exist, so `/terms/test` reads as a term id for PATCH and the router says 405.
    expect((await router2({ method: 'POST', path: '/terms/test', query: {}, headers: {}, body: undefined, rawBody: '{"text":"x"}' })).status).toBe(405);
  });
});

describe('GET /reports: targetHandle', () => {
  it('each item gains targetHandle, the reported person handle at filing, after the old fields (then claim and viewing)', async () => {
    const w = await world();
    const r = await file(w, { targetHandle: 'SneakyPete' });
    const body = (await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>>; next: string | null };
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]!)).toEqual([
      'id', 'createdAt', 'roomId', 'tags', 'category', 'status', 'badFaith', 'targetPerson', 'reporterPerson', 'actionedAt', 'actionedBy', 'targetHandle',
      'reporterHandle', 'claim', 'viewing',
    ]);
    expect(body.items[0]).toMatchObject({ id: r.id, targetPerson: r.target, targetHandle: 'SneakyPete', reporterHandle: 'Rep' });
  });

  it('reporterHandle is the reporter handle at filing (even after the seat changes hands), null when none was recorded', async () => {
    const w = await world();
    const r = await file(w, { targetHandle: 'SneakyPete' });
    w.cw.rooms.seat(r.room, 'p1', { clientKey: 'raw-client-key-someone-else-0077' }, 'ThenSomeoneElse');
    const first = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items.find((i) => i.id === r.id);
    expect(first?.reporterHandle).toBe('Rep');

    const room = 'hub-room-blank-reporter';
    w.cw.rooms.seat(room, 'p1', { clientKey: 'raw-client-key-reporter-blank-0001', ip: '198.51.100.24' }, '');
    w.cw.rooms.seat(room, 'p2', { clientKey: 'raw-client-key-target-blank-0001', ip: IP_TARGET }, 'Tarvo');
    w.cw.chat.accept(room, 'p2', 'a line');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'spam' });
    if (!res.ok) throw new Error('refused');
    const blank = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items.find((i) => i.id === res.reportId);
    expect(blank?.reporterHandle).toBeNull();
    expect(blank?.targetHandle).toBe('Tarvo');
  });

  it('is null when no handle was recorded', async () => {
    const w = await world();
    const r = await file(w, { targetHandle: '' });
    const item = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items.find((i) => i.id === r.id);
    expect(item?.targetHandle).toBeNull();
  });

  it('follows the reported person even when the seat changed hands afterwards (the handle at filing)', async () => {
    const w = await world();
    const r = await file(w, { targetHandle: 'FirstName' });
    w.cw.rooms.seat(r.room, 'p2', { clientKey: 'raw-client-key-someone-else-0099' }, 'ThenSomeoneElse');
    const item = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items[0];
    expect(item?.targetHandle).toBe('FirstName');
  });

  it('adds no audit row beyond report.view, and no other new key', async () => {
    const w = await world();
    await file(w);
    await w.call('GET', '/reports');
    expect(w.routeAudit().map((a) => a.action)).toEqual(['report.view']);
  });

  it('GET /reports/:id is unchanged apart from nothing: the report still carries its own handle fields', async () => {
    const w = await world();
    const r = await file(w, { targetHandle: 'SneakyPete' });
    const body = (await w.call('GET', `/reports/${r.id}`)).body as { report: Record<string, unknown> };
    expect(body.report.targetHandle).toBe('SneakyPete');
  });
});

describe('no hashed ip, raw key or value field in any new response', () => {
  it('serialises every new and changed response and finds none', async () => {
    const w = await world();
    const r = await file(w);
    await sanction(w, r.target, { includeIp: true });
    await sanction(w, r.target, { kind: 'ban', durationMs: null, includeIp: true });
    strike(w, 'k1', NOW - HOUR, { subject: r.target });
    const ipHashes = (w.db.prepare("SELECT target_value AS v FROM kit_sanctions WHERE target_type = 'ip'").all() as Array<{ v: string }>).map((x) => x.v);
    expect(ipHashes.length).toBeGreaterThan(0);

    const responses = [
      await w.call('GET', `/people/${r.target}/history`),
      await w.call('GET', `/people/${r.reporter}/history`),
      await w.call('GET', '/sanctions'),
      await w.call('GET', '/sanctions', { query: { limit: '1' } }),
      await w.call('GET', '/blocked'),
      await w.call('GET', '/terms'),
      await w.call('POST', '/terms/test', { body: { text: 'zorbak' } }),
      await w.call('GET', '/reports'),
      await w.call('GET', '/me'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const h of ipHashes) expect(text).not.toContain(h);
      expect(text).not.toContain(IP_TARGET);
      expect(text).not.toContain('198.51.100.23');
      expect(text).not.toContain(KEY_TARGET);
      expect(text).not.toContain('raw-client-key');
      const keys = keysDeep(res.body);
      for (const bad of ['value', 'ipHash', 'ip', 'clientKey', 'accountId', 'targetType', 'target_value']) expect(keys.has(bad), `${bad} in ${text.slice(0, 80)}`).toBe(false);
    }
  });
});

describe('every new route answers no-store and fails closed on a bad actor', () => {
  it('sets cache-control no-store on success and on error', async () => {
    const w = await world();
    for (const [method, path, body] of [
      ['GET', '/sanctions', undefined],
      ['GET', '/blocked', undefined],
      ['POST', '/terms/test', { text: 'x' }],
    ] as const) {
      const ok = await w.call(method, path, { ...(body === undefined ? {} : { body }) });
      expect(ok.headers?.['cache-control'], path).toBe('no-store');
      const denied = await w.call(method, path, { role: null });
      expect(denied.headers?.['cache-control'], path).toBe('no-store');
    }
    const bad = await w.call('GET', '/blocked', { query: { days: '3' } });
    expect(bad.headers?.['cache-control']).toBe('no-store');
  });
});
