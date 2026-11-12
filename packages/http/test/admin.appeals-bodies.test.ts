import { describe, expect, it } from 'vitest';
import type { Role } from '@chatwarden/http';
import { appealsWorld } from './appealsWorld.js';
import { keysDeep } from './world.js';

// The existing staff bodies that learn about appeals and renames: GET /me (`features`), GET /changes (`appeals`, the open count) and
// GET /people/:ref/history (`appeals` and `renames`). Each key is present only when it has something to say.

type World = Awaited<ReturnType<typeof appealsWorld>>;
type Features = { appeals: boolean; renames: boolean };
const me = async (w: World, role: Role = 'moderator') => (await w.call('GET', '/me', { role })).body as { features?: Features; can: Record<string, boolean> };
const changes = async (w: World, role: Role = 'moderator') => (await w.call('GET', '/changes', { role })).body as { token: string; changed: boolean; appeals?: number };
const history = async (w: World, ref: string, role: Role = 'moderator') =>
  (await w.call('GET', `/people/${ref}/history`, { role })).body as { appeals?: Array<Record<string, unknown>>; renames?: Array<{ at: number; pending: boolean }> } & Record<string, unknown>;

describe('GET /me has features only when on; GET /changes has appeals only for a caller with appeals.read', () => {
  it('features is { appeals, renames } when either is on, for every role, and absent when both are off', async () => {
    const off = await appealsWorld({ appeals: { enabled: false } });
    for (const role of ['moderator', 'senior', 'owner'] as const) expect(Object.keys(await me(off, role)).sort(), role).toEqual(['actor', 'can', 'role']);
    const appealsOnly = await appealsWorld();
    expect((await me(appealsOnly)).features).toEqual({ appeals: true, renames: false });
    const renamesOnly = await appealsWorld({ appeals: { enabled: false }, names: { renames: true } });
    expect((await me(renamesOnly)).features).toEqual({ appeals: false, renames: true });
    const both = await appealsWorld({ names: { renames: true } });
    for (const role of ['moderator', 'senior', 'owner'] as const) expect((await me(both, role)).features, role).toEqual({ appeals: true, renames: true });
  });

  it('renames count as on only when names.renames is true AND the store can withdraw a notice, so the hub never offers a rename that always 404s', async () => {
    const w = await appealsWorld({ appeals: { enabled: false }, names: { renames: true } });
    expect((await me(w)).features).toEqual({ appeals: false, renames: true });
    // A store that cannot release a rename: the setting is on and the capability is not.
    (w.store as unknown as { withdrawNotice?: unknown }).withdrawNotice = undefined;
    expect(Object.keys(await me(w))).not.toContain('features');
    const withAppeals = await appealsWorld({ names: { renames: true } });
    (withAppeals.store as unknown as { withdrawNotice?: unknown }).withdrawNotice = undefined;
    expect((await me(withAppeals)).features).toEqual({ appeals: true, renames: false });
  });

  it('features is read live: turning a setting on or off in the policy changes the next answer', async () => {
    const w = await appealsWorld({ appeals: { enabled: false } });
    expect(Object.keys(await me(w))).not.toContain('features');
    w.cw.policy.save({ names: { renames: true } }, { version: 0, actor: 'owner', reason: 'on' });
    expect((await me(w)).features).toEqual({ appeals: false, renames: true });
    w.cw.policy.save({ names: { renames: false } }, { version: 1, actor: 'owner', reason: 'off' });
    expect(Object.keys(await me(w))).not.toContain('features');
  });

  it('GET /me still lists every permission in can, holds no id or text, and writes no audit row', async () => {
    const w = await appealsWorld({ names: { renames: true } });
    const body = await me(w);
    expect(Object.keys(body.can)).toContain('appeals.read');
    expect(keysDeep(body).size).toBeLessThan(40);
    expect(w.routeAudit()).toEqual([]);
  });

  it('GET /changes carries the open count when appeals are on and the caller can read them', async () => {
    const w = await appealsWorld();
    expect((await changes(w)).appeals).toBe(0);
    const a = await w.appeal();
    await w.appeal();
    const res = await changes(w);
    expect(res.appeals).toBe(2);
    expect(Object.keys(res).sort()).toEqual(['appeals', 'changed', 'token']);
    for (const role of ['senior', 'owner'] as const) expect((await changes(w, role)).appeals, role).toBe(2);
    await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'senior', actor: 'senior_bea', body: { outcome: 'uphold', reason: 'r' } });
    expect((await changes(w)).appeals).toBe(1);
  });

  it('GET /changes has no appeals key for a caller without appeals.read, and none with appeals off', async () => {
    const closed = await appealsWorld({ permissions: { 'appeals.read': 'senior' } });
    await closed.appeal();
    expect(Object.keys(await changes(closed, 'moderator')).sort()).toEqual(['changed', 'token']);
    expect((await changes(closed, 'senior')).appeals).toBe(1);
    const off = await appealsWorld({ appeals: { enabled: false } });
    expect(Object.keys(await changes(off, 'owner')).sort()).toEqual(['changed', 'token']);
  });

  it('GET /changes: the token moves when an appeal is filed and when it is decided', async () => {
    const w = await appealsWorld();
    const t0 = (await changes(w)).token;
    const a = await w.appeal();
    const t1 = (await changes(w)).token;
    expect(t1).not.toBe(t0);
    await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'senior', actor: 'senior_bea', body: { outcome: 'uphold', reason: 'r' } });
    expect((await changes(w)).token).not.toBe(t1);
  });
});

describe('history carries appeals and renames entries with dates and outcomes and no statement text', () => {
  it('appeals: the person\'s appeals as summaries (status and dates), no statement, and nobody else\'s', async () => {
    const w = await appealsWorld();
    const a = await w.appeal({ statement: 'a distinctive statement sentence' });
    const other = await w.appeal();
    await w.call('POST', `/appeals/${a.appealId}/decide`, { role: 'senior', actor: 'senior_bea', body: { outcome: 'uphold', reason: 'private deciding reason' } });
    const h = await history(w, a.subject);
    expect(h.appeals).toHaveLength(1);
    expect(h.appeals?.[0]).toMatchObject({ id: a.appealId, status: 'upheld', createdAt: expect.any(Number), sanction: { groupId: a.groupId, kind: 'chat', rule: 2 } });
    const text = JSON.stringify(h);
    expect(text).not.toContain('distinctive statement');
    expect(text).not.toContain('private deciding reason');
    expect(keysDeep(h).has('statement')).toBe(false);
    expect(text).not.toContain(other.appealId);
  });

  it('appeals: present and empty for a person with none while appeals are on; absent while off; absent for a caller without appeals.read', async () => {
    const w = await appealsWorld();
    const f = await w.file();
    expect((await history(w, f.target)).appeals).toEqual([]);
    const off = await appealsWorld({ appeals: { enabled: false } });
    const g = await off.file();
    expect(Object.keys(await history(off, g.target)).sort()).toEqual(['asReporter', 'handle', 'history', 'reports', 'sanctions']);
    const closed = await appealsWorld({ permissions: { 'appeals.read': 'senior' } });
    const c = await closed.appeal();
    expect(Object.keys(await history(closed, c.subject, 'moderator'))).not.toContain('appeals');
    expect((await history(closed, c.subject, 'senior')).appeals).toHaveLength(1);
  });

  it('renames: { at, pending } per request, pending until the game says the player renamed; present and empty while on; absent while off', async () => {
    const w = await appealsWorld({ appeals: { enabled: false }, names: { renames: true } });
    const f = await w.file();
    expect((await history(w, f.target)).renames).toEqual([]);
    const t = w.clock.now();
    expect(w.cw.names.requireRename({ subject: f.target, actor: 'mod_ann', reason: 'private reason for the rename' })).toMatchObject({ ok: true });
    let h = await history(w, f.target);
    expect(h.renames).toEqual([{ at: t, pending: true }]);
    expect(JSON.stringify(h)).not.toContain('private reason for the rename');
    expect(w.cw.names.renamed({ clientKey: f.key })).toBe(true);
    h = await history(w, f.target);
    expect(h.renames).toEqual([{ at: t, pending: false }]);
    // Appeals are off: no appeals key even though renames is present.
    expect(Object.keys(h)).not.toContain('appeals');
    // Switched off later, the history that exists is still shown.
    w.cw.policy.save({ names: { renames: false } }, { version: 0, actor: 'owner', reason: 'off' });
    expect((await history(w, f.target)).renames).toEqual([{ at: t, pending: false }]);
    const g = await w.file();
    expect(Object.keys(await history(w, g.target))).not.toContain('renames');
  });

  it('renames: absent with the capability missing and nothing recorded', async () => {
    const w = await appealsWorld({ appeals: { enabled: false }, names: { renames: true } });
    (w.store as unknown as { withdrawNotice?: unknown }).withdrawNotice = undefined;
    const f = await w.file();
    expect(Object.keys(await history(w, f.target))).not.toContain('renames');
  });

  it('the history audit row is unchanged: history.view with the person as target', async () => {
    const w = await appealsWorld({ names: { renames: true } });
    const a = await w.appeal();
    await history(w, a.subject);
    expect(w.routeAudit().map((r) => [r.action, r.target])).toEqual([['history.view', { type: 'person', ref: a.subject }]]);
  });
});
