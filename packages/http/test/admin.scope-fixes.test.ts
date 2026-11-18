import { describe, expect, it } from 'vitest';
import type { KitResponse } from '../src/index.js';
import { SCOPED_DEFAULT_LIMITS } from '../src/index.js';
import type { ScopedLimits } from '../src/index.js';
import { DAY, HOUR, errorOf, world } from './world.js';
import type { Role } from '../src/index.js';
import type { Matcher, ProfanityFilter } from '@chatwarden/core';

// The C8+C9 fix round: what a scoped moderator may do with a sanction (includeIp, revoke, bad faith), the claim takeover audit, and what GET /me tells a scoped caller.

const matcher: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
const profanity: ProfanityFilter = { apply: (text) => ({ hit: /snerp/i.test(text), text }) };
const A = 'creator:alice';
const B = 'creator:bob';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: KitResponse): Record<string, any> => res.body as Record<string, any>;
type World = Awaited<ReturnType<typeof world>>;

const post = (w: World, over: Record<string, unknown>, o: { scope?: string[]; role?: Role } = { scope: [A] }) =>
  w.call('POST', '/sanctions', { ...o, body: { kind: 'warning', durationMs: null, rule: 1, reason: 'scoped', ...over } });
const decide = (w: World, reportId: string, verdict: string, actions: Array<Record<string, unknown>>, o: { scope?: string[]; role?: Role; actor?: string } = { scope: [A] }, extra: Record<string, unknown> = {}) =>
  w.call('POST', `/reports/${reportId}/decide`, { ...o, body: { verdict, actions: actions.map((a) => ({ rule: 1, ...a })), reason: 'x', ...extra } });
const allSanctions = async (w: World): Promise<Array<{ groupId: string; person: string; kind: string; revokedAt: number | null }>> =>
  body(await w.call('GET', '/sanctions')).items as Array<{ groupId: string; person: string; kind: string; revokedAt: number | null }>;
/** The hashed-IP rows a sanction wrote (the store's table, read directly: the HTTP views never show one). */
const ipRows = (w: World): number => (w.db.prepare("SELECT COUNT(*) AS n FROM kit_sanctions WHERE target_type = 'ip'").get() as { n: number }).n;

describe('I-1: a scoped caller may not place an IP sanction', () => {
  it('POST /sanctions with includeIp: true is 400 invalid_sanction and writes nothing, for every kind and length the limits allow', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    for (const over of [{ kind: 'warning', durationMs: null }, { kind: 'chat', durationMs: HOUR }, { kind: 'chat', durationMs: 7 * DAY }]) {
      const res = await post(w, { subject: a.target, reportId: a.id, includeIp: true, ...over });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(errorOf(res)).toBe('invalid_sanction');
    }
    expect(await allSanctions(w)).toEqual([]);
    expect(ipRows(w)).toBe(0);
  });

  it('a decision with an includeIp action is 400 invalid_sanction, leaves the report open and writes nothing; one bad action among good ones refuses the lot', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    for (const actions of [
      [{ subject: a.target, kind: 'chat', durationMs: HOUR, includeIp: true }],
      [{ subject: a.target, kind: 'warning', durationMs: null, includeIp: true }],
      [{ subject: a.target, kind: 'warning', durationMs: null }, { subject: a.target, kind: 'chat', durationMs: HOUR, includeIp: true }],
    ]) {
      const res = await decide(w, a.id, 'upheld', actions, { scope: [A], role: 'senior' });
      expect(res.status, JSON.stringify(actions)).toBe(400);
      expect(errorOf(res)).toBe('invalid_sanction');
    }
    expect(w.cw.reports.get(a.id)?.status).toBe('open');
    expect(await allSanctions(w)).toEqual([]);
    expect(ipRows(w)).toBe(0);
  });

  it('includeIp: false and an absent includeIp are allowed on both routes for a scoped caller', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(A);
    expect((await post(w, { subject: a.target, reportId: a.id, kind: 'chat', durationMs: HOUR, includeIp: false })).status).toBe(200);
    expect((await post(w, { subject: a.target, reportId: a.id, kind: 'chat', durationMs: HOUR })).status).toBe(200);
    expect((await decide(w, b.id, 'upheld', [{ subject: b.target, kind: 'chat', durationMs: HOUR, includeIp: false }])).status).toBe(200);
    expect(ipRows(w)).toBe(0);
  });

  it('control: an unscoped caller may still send includeIp: true on both routes, and an IP row is written', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const b = await w.fileIn(A);
    expect((await post(w, { subject: a.target, kind: 'chat', durationMs: HOUR, includeIp: true }, {})).status).toBe(200);
    const first = ipRows(w);
    expect(first).toBeGreaterThan(0);
    expect((await decide(w, b.id, 'upheld', [{ subject: b.target, kind: 'chat', durationMs: HOUR, includeIp: true }], {})).status).toBe(200);
    expect(ipRows(w)).toBeGreaterThan(first);
  });

  it('a scoped senior is refused too (the role does not lift it), and the refusal is the same for a widened limit set', async () => {
    const w = await world({ scopedLimits: { kinds: ['warning', 'chat', 'area', 'ban'], maxDurationMs: 30 * DAY } });
    const a = await w.fileIn(A);
    const res = await post(w, { subject: a.target, reportId: a.id, kind: 'ban', durationMs: DAY, includeIp: true }, { scope: [A], role: 'senior' });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_sanction');
    expect((await post(w, { subject: a.target, reportId: a.id, kind: 'ban', durationMs: DAY }, { scope: [A], role: 'senior' })).status).toBe(200);
  });

  it('an out-of-scope report with includeIp is still the 404 of an unknown id (the order of the refusals is unchanged)', async () => {
    const w = await world();
    const b = await w.fileIn(B);
    const res = await post(w, { subject: b.target, reportId: b.id, includeIp: true });
    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('not_found');
  });
});

describe('M-6: a scoped revoke is bounded by the scoped limits', () => {
  const revoke = (w: World, id: string, o: { scope?: string[]; role?: Role } = { scope: [A] }) => w.call('POST', `/sanctions/${id}/revoke`, { ...o, body: { reason: 'lifting it' } });
  const active = async (w: World, groupId: string): Promise<boolean> => ((await allSanctions(w)).find((g) => g.groupId === groupId)?.revokedAt ?? null) === null;
  /** A global caller (a senior) decides report `r`, and the group of the one sanction it made is returned. */
  const seniorSanction = async (w: World, r: { id: string; target: string }, action: Record<string, unknown>): Promise<string> => {
    const res = await decide(w, r.id, 'upheld', [{ subject: r.target, ...action }], { role: 'senior' });
    expect(res.status, JSON.stringify(action)).toBe(200);
    return (await allSanctions(w)).find((g) => g.person === r.target)!.groupId;
  };

  it("a senior's permanent ban from an in-scope report is refused to a scoped moderator (400 invalid_sanction) and stays in force; a global caller revokes it", async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const g = await seniorSanction(w, a, { kind: 'ban', durationMs: null });
    const res = await revoke(w, g);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_sanction');
    expect(await active(w, g)).toBe(true);
    expect(w.routeAudit().filter((r) => r.action === 'sanction.revoke')).toEqual([]);
    expect((await revoke(w, g, { role: 'senior' })).status).toBe(200);
    expect(await active(w, g)).toBe(false);
  });

  it('every sanction outside the limits is refused: another kind, a ban, a permanent chat restriction, a length over the limit, a note', async () => {
    const w = await world();
    for (const action of [
      { kind: 'area', durationMs: HOUR },
      { kind: 'ban', durationMs: HOUR },
      { kind: 'ban', durationMs: 30 * DAY },
      { kind: 'chat', durationMs: null },
      { kind: 'chat', durationMs: 8 * DAY },
      { kind: 'note', durationMs: null },
    ]) {
      const r = await w.fileIn(A);
      const g = await seniorSanction(w, r, action);
      const res = await revoke(w, g);
      expect(res.status, JSON.stringify(action)).toBe(400);
      expect(errorOf(res)).toBe('invalid_sanction');
      expect(await active(w, g), JSON.stringify(action)).toBe(true);
    }
  });

  it('a sanction inside the limits is revoked: a warning, a chat restriction of an hour, of exactly 7 days, and a short ban when the limits allow bans', async () => {
    const w = await world();
    for (const action of [{ kind: 'warning', durationMs: null }, { kind: 'chat', durationMs: HOUR }, { kind: 'chat', durationMs: 7 * DAY }]) {
      const r = await w.fileIn(A);
      const g = await seniorSanction(w, r, action);
      expect((await revoke(w, g)).status, JSON.stringify(action)).toBe(200);
      expect(await active(w, g)).toBe(false);
    }
    const wide = await world({ scopedLimits: { kinds: ['warning', 'chat', 'ban'], maxDurationMs: 30 * DAY } });
    const r = await wide.fileIn(A);
    const g = await seniorSanction(wide, r, { kind: 'ban', durationMs: 20 * DAY });
    expect((await revoke(wide, g)).status).toBe(200);
    const r2 = await wide.fileIn(A);
    const g2 = await seniorSanction(wide, r2, { kind: 'ban', durationMs: null });
    expect((await revoke(wide, g2)).status).toBe(400);
  });

  it('a sanction a scoped moderator made themselves can be revoked by them (it was inside the limits)', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    expect((await post(w, { subject: a.target, reportId: a.id, kind: 'chat', durationMs: DAY })).status).toBe(200);
    const g = (await allSanctions(w))[0]!.groupId;
    expect((await revoke(w, g)).status).toBe(200);
  });

  it('the order is unchanged: an out-of-scope or unknown group is still the 404 of an unknown group, whatever its kind', async () => {
    const w = await world();
    const b = await w.fileIn(B);
    const gb = await seniorSanction(w, b, { kind: 'ban', durationMs: null });
    const ghost = await revoke(w, 'g_unknown_000000');
    expect(ghost.status).toBe(404);
    expect(await revoke(w, gb)).toEqual(ghost);
    expect(await active(w, gb)).toBe(true);
  });

  it('control: a global caller (no scope) is not limited at all', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    const g = await seniorSanction(w, a, { kind: 'ban', durationMs: null });
    expect((await revoke(w, g, {})).status).toBe(200);
  });

  describe('a bad_faith verdict by a scoped moderator is bounded by the same limits', () => {
    it('a reporter sanction outside the limits is 400 and the report stays open; none, or one inside the limits, is allowed', async () => {
      const w = await world();
      const a = await w.fileIn(A);
      const evidence = 'reports made to get a player in trouble';
      for (const action of [{ kind: 'ban', durationMs: null }, { kind: 'ban', durationMs: HOUR }, { kind: 'chat', durationMs: 8 * DAY }, { kind: 'area', durationMs: HOUR }]) {
        const res = await decide(w, a.id, 'bad_faith', [{ subject: a.reporter, ...action }], { scope: [A], role: 'senior' }, { evidence });
        expect(res.status, JSON.stringify(action)).toBe(400);
        expect(errorOf(res)).toBe('invalid_sanction');
      }
      expect(w.cw.reports.get(a.id)?.status).toBe('open');
      const ok = await decide(w, a.id, 'bad_faith', [{ subject: a.reporter, kind: 'chat', durationMs: DAY }], { scope: [A] }, { evidence });
      expect(ok.status).toBe(200);
      expect(w.cw.reports.get(a.id)?.status).toBe('dismissed');
      const b = await w.fileIn(A);
      expect((await decide(w, b.id, 'bad_faith', [], { scope: [A] }, { evidence })).status).toBe(200);
    });

    it('control: a global caller may sanction the reporter with a ban on a bad_faith verdict', async () => {
      const w = await world();
      const a = await w.fileIn(A);
      const res = await decide(w, a.id, 'bad_faith', [{ subject: a.reporter, kind: 'ban', durationMs: null }], { role: 'senior' }, { evidence: 'deliberate abuse of the tool' });
      expect(res.status).toBe(200);
    });
  });
});

describe('M-8: a takeover that cannot happen is not audited', () => {
  const claim = (w: World, ref: string, o: { scope?: string[]; role?: Role; actor?: string }, takeOver = false) =>
    w.call('POST', `/cases/${ref}/claim`, { ...o, body: takeOver ? { takeOver: true } : {} });

  it('a scoped senior with a decided report in scope and an open one only elsewhere gets 404, and no case.takeover row, and the other claim stands', async () => {
    const w = await world();
    const key = 'one-person-claimedxxxxxxxxxxxx';
    const a = await w.fileIn(A, { targetKey: key });
    const b = await w.fileIn(B, { targetKey: key });
    expect(a.target).toBe(b.target);
    expect((await decide(w, a.id, 'no_action', [], { scope: [A], actor: 'alice_mod' })).status).toBe(200);
    // the other room's moderator holds the case
    expect((await claim(w, b.target, { scope: [B], actor: 'bea', role: 'senior' })).status).toBe(200);
    const res = await claim(w, b.target, { scope: [A], actor: 'alice_senior', role: 'senior' }, true);
    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('not_found');
    expect(w.routeAudit().filter((r) => r.action === 'case.takeover')).toEqual([]);
    expect(w.cw.cases.holder(b.target)?.by).toBe('bea');
  });

  it('the same answer without takeOver, and for a person with no report in scope at all', async () => {
    const w = await world();
    const key = 'one-person-claimedyyyyyyyyyyyy';
    const a = await w.fileIn(A, { targetKey: key });
    const b = await w.fileIn(B, { targetKey: key });
    await decide(w, a.id, 'no_action', [], { scope: [A] });
    const plain = await claim(w, b.target, { scope: [A] });
    expect(plain.status).toBe(404);
    const c = await w.fileIn(B);
    expect(await claim(w, c.target, { scope: [A], role: 'senior' }, true)).toEqual(await claim(w, 's_unknown_person', { scope: [A], role: 'senior' }, true));
    expect(w.routeAudit().filter((r) => r.action === 'case.takeover')).toEqual([]);
  });

  it('controls: a takeover with an open report in scope is audited and moves the claim; a global takeover too', async () => {
    const w = await world();
    const a = await w.fileIn(A);
    expect((await claim(w, a.target, { scope: [A], actor: 'first' })).status).toBe(200);
    const res = await claim(w, a.target, { scope: [A], actor: 'second_senior', role: 'senior' }, true);
    expect(res.status).toBe(200);
    expect(w.routeAudit().filter((r) => r.action === 'case.takeover')).toHaveLength(1);
    expect(w.cw.cases.holder(a.target)?.by).toBe('second_senior');
    const g = await w.fileIn(null);
    await claim(w, g.target, { actor: 'one' });
    expect((await claim(w, g.target, { actor: 'two_senior', role: 'senior' }, true)).status).toBe(200);
    expect(w.routeAudit().filter((r) => r.action === 'case.takeover')).toHaveLength(2);
  });
});

describe('M-2: GET /me for a scoped caller', () => {
  const me = async (w: World, o: { scope?: string[]; role?: Role } = {}) => body(await w.call('GET', '/me', o));

  it('carries the limits that apply (kinds, maxDurationMs) for a scoped caller, and none for a global one', async () => {
    const w = await world();
    const scoped = await me(w, { scope: [A], role: 'senior' });
    expect(scoped.scopedLimits).toEqual({ kinds: ['warning', 'chat'], maxDurationMs: 7 * DAY });
    expect((await me(w, { role: 'senior' })).scopedLimits).toBeUndefined();
    expect(Object.keys(await me(w, { role: 'senior' })).sort()).toEqual(['actor', 'can', 'features', 'role']);
    expect(Object.keys(scoped).sort()).toEqual(['actor', 'can', 'features', 'role', 'scope', 'scopedLimits']);
  });

  it('follows scopedLimits given to adminRoutes, and the answer is a copy (nothing a caller does changes the limits)', async () => {
    const limits: ScopedLimits = { kinds: ['warning', 'chat', 'area'], maxDurationMs: 30 * DAY };
    const w = await world({ scopedLimits: limits });
    const first = await me(w, { scope: [A] });
    expect(first.scopedLimits).toEqual({ kinds: ['warning', 'chat', 'area'], maxDurationMs: 30 * DAY });
    first.scopedLimits.kinds.push('ban');
    expect((await me(w, { scope: [A] })).scopedLimits.kinds).toEqual(['warning', 'chat', 'area']);
  });

  it('features for a scoped caller: renames is false even when renames are on (the decision would be refused), the rest as for everyone', async () => {
    const w = await world({ matcher, profanity, overrides: { names: { renames: true } } });
    const global = await me(w, { role: 'senior' });
    const scoped = await me(w, { role: 'senior', scope: [A] });
    expect(global.features.renames).toBe(true);
    expect(scoped.features.renames).toBe(false);
    for (const k of ['appeals', 'keepBlocked', 'rooms', 'workflow', 'insights']) expect(scoped.features[k], k).toBe(global.features[k]);
  });

  it('SCOPED_DEFAULT_LIMITS is what a scoped caller is told by default', async () => {
    const w = await world();
    const scoped = await me(w, { scope: [A] });
    expect(scoped.scopedLimits).toEqual({ kinds: [...SCOPED_DEFAULT_LIMITS.kinds], maxDurationMs: SCOPED_DEFAULT_LIMITS.maxDurationMs });
  });
});

describe('M-1: SCOPED_DEFAULT_LIMITS and ScopedLimits are public', () => {
  it('both entries export the same frozen default, and an adopter can spread it into adminRoutes', async () => {
    const admin = await import('../src/admin-entry.js');
    const root = await import('../src/index.js');
    expect(root.SCOPED_DEFAULT_LIMITS).toBe(admin.SCOPED_DEFAULT_LIMITS);
    expect(Object.isFrozen(root.SCOPED_DEFAULT_LIMITS)).toBe(true);
    expect(root.SCOPED_DEFAULT_LIMITS).toEqual({ kinds: ['warning', 'chat'], maxDurationMs: 7 * DAY });
    // "the default plus one more kind", the thing an adopter could not write before
    const limits: ScopedLimits = { kinds: [...root.SCOPED_DEFAULT_LIMITS.kinds, 'area'], maxDurationMs: root.SCOPED_DEFAULT_LIMITS.maxDurationMs };
    const w = await world({ scopedLimits: limits });
    const a = await w.fileIn(A);
    expect((await post(w, { subject: a.target, reportId: a.id, kind: 'area', durationMs: HOUR })).status).toBe(200);
  });

  it('both entry files name the type, and the README names the default and the type', async () => {
    const { readFileSync } = await import('node:fs');
    for (const entry of ['../src/index.ts', '../src/admin-entry.ts']) {
      const text = readFileSync(new URL(entry, import.meta.url), 'utf8');
      expect(text, entry).toMatch(/\bSCOPED_DEFAULT_LIMITS\b/);
      expect(text, entry).toMatch(/export type \{[^}]*\bScopedLimits\b[^}]*\}/);
    }
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('SCOPED_DEFAULT_LIMITS');
    expect(readme).toContain('ScopedLimits');
  });
});
