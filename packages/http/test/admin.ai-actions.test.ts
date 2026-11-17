import { describe, expect, it } from 'vitest';
import type { AiActionRow } from '@chatwarden/core';
import { DAY, errorOf, keysDeep, world } from './world.js';

// `GET /ai/actions` (AI levels 3 and 4, design 6.6, release 2): the list behind the hub's "would have applied" rows. Permission `ai.review` (a moderator's, lowerable), not audited on
// read (it is a queue), newest first, a page and a cursor. In this release every row is a shadow row: nothing was written to a player.

type W = Awaited<ReturnType<typeof world>>;
const aiWorld = (over: Parameters<typeof world>[0] = {}): Promise<W> =>
  world({ ai: { level: 2, options: { maxLevel: 3, act: {} } }, overrides: { appeals: { enabled: true } } as never, ...over });

let n = 0;
/** A report about a person and the action row the AI left for it, `ago` ms before now. */
function shadow(w: W, o: { state?: AiActionRow['state']; createdAgo?: number; kind?: AiActionRow['kind'] } = {}): { reportId: string; id: string; person: string } {
  n += 1;
  const person = w.person();
  const report = `ai-act-http-${n}`;
  const created = w.clock.t - (o.createdAgo ?? 0);
  const row: AiActionRow = {
    id: `act-http-${n}`, reportId: report, readId: `read-${n}`, confirmReadId: null, rule: '2', severity: 'hostile', state: o.state ?? 'shadow', refusedCode: null, notBefore: created, createdAt: created,
    groupId: null, kind: o.kind ?? 'chat', durationMs: 24 * 3_600_000, actedAt: created, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: 'fake:model', promptVersion: 5,
  };
  w.store.insertAiAction?.(row);
  w.store.insertReport({
    id: report, createdAt: created, roomId: `room-${report}`, tags: {}, reporterSubject: `s_rep_${n}`, reporterSeat: 'p1', reporterHandle: 'R', targetSubject: person, targetSeat: 'p2', targetHandle: 'T',
    category: 'harassment', reportedReason: 'harassment', note: null, lineId: null, excerpt: [], people: [person], status: 'open',
  });
  return { reportId: report, id: row.id, person };
}

describe('GET /ai/actions', () => {
  it('is ai.review (a moderator by default), 401 without authz, not audited, and lists the shadow rows newest first', async () => {
    const w = await aiWorld();
    const a = shadow(w, { createdAgo: 3 * DAY });
    const b = shadow(w, { createdAgo: 1 * DAY });
    const c = shadow(w, { createdAgo: 2 * DAY });
    const before = w.routeAudit().length;
    const res = await w.call('GET', '/ai/actions', { role: 'moderator', actor: 'mod_zed' });
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const body = res.body as { items: Array<{ reportId: string; actionId: string; state: string; kind: string; durationMs: number; person: string; level: string; rule: number }>; next: string | null };
    expect(body.items.map((i) => i.reportId)).toEqual([b.reportId, c.reportId, a.reportId]);
    expect(body.items[0]).toMatchObject({ state: 'shadow', kind: 'chat', durationMs: 24 * 3_600_000, level: 'hostile', rule: 2, person: b.person });
    expect(body.next).toBeNull();
    expect(w.routeAudit()).toHaveLength(before);
    expect((await w.call('GET', '/ai/actions', { role: null })).status).toBe(401);
  });

  it('is 403 when the permissions option raises ai.review', async () => {
    const w = await aiWorld({ permissions: { 'ai.review': 'owner' } });
    for (const role of ['moderator', 'senior'] as const) expect((await w.call('GET', '/ai/actions', { role })).status, role).toBe(403);
    expect((await w.call('GET', '/ai/actions', { role: 'owner' })).status).toBe(200);
  });

  it('pages with a limit and a cursor, and the cursor is the previous next', async () => {
    const w = await aiWorld();
    const made = [1, 2, 3, 4, 5].map((i) => shadow(w, { createdAgo: i * DAY }));
    const first = (await w.call('GET', '/ai/actions', { query: { limit: '2' } })).body as { items: Array<{ reportId: string }>; next: string | null };
    expect(first.items.map((i) => i.reportId)).toEqual([made[0], made[1]].map((m) => m?.reportId));
    expect(first.next).not.toBeNull();
    const second = (await w.call('GET', '/ai/actions', { query: { limit: '2', cursor: first.next as string } })).body as { items: Array<{ reportId: string }>; next: string | null };
    expect(second.items.map((i) => i.reportId)).toEqual([made[2], made[3]].map((m) => m?.reportId));
    const third = (await w.call('GET', '/ai/actions', { query: { limit: '2', cursor: second.next as string } })).body as { items: Array<{ reportId: string }>; next: string | null };
    expect(third.items.map((i) => i.reportId)).toEqual([made[4]?.reportId]);
    expect(third.next).toBeNull();
  });

  it('filters by state, and a queued, refused or held-back row is never in the list', async () => {
    const w = await aiWorld();
    const s = shadow(w, { state: 'shadow' });
    shadow(w, { state: 'queued' });
    shadow(w, { state: 'refused' });
    shadow(w, { state: 'held_back' });
    const all = (await w.call('GET', '/ai/actions')).body as { items: Array<{ reportId: string }> };
    expect(all.items.map((i) => i.reportId)).toEqual([s.reportId]);
    const only = (await w.call('GET', '/ai/actions', { query: { state: 'shadow' } })).body as { items: unknown[] };
    expect(only.items).toHaveLength(1);
    expect(((await w.call('GET', '/ai/actions', { query: { state: 'active' } })).body as { items: unknown[] }).items).toEqual([]);
  });

  it.each([
    [{ state: 'queued' }],
    [{ state: 'everything' }],
    [{ limit: '0' }],
    [{ limit: '-1' }],
    [{ limit: 'ten' }],
    [{ limit: '1.5' }],
    [{ cursor: 'not a cursor' }],
    [{ cursor: '!!!' }],
    [{ cursor: Buffer.from('nocolon').toString('base64url') }],
    [{ cursor: Buffer.from('abc:xyz').toString('base64url') }],
  ])('refuses %j as invalid_query', async (query) => {
    const w = await aiWorld();
    const res = await w.call('GET', '/ai/actions', { query });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_query');
  });

  it('a limit above 100 is a page of 100 at most; with no AI the list is empty', async () => {
    const w = await aiWorld();
    for (let i = 0; i < 3; i += 1) shadow(w);
    expect(((await w.call('GET', '/ai/actions', { query: { limit: '5000' } })).body as { items: unknown[] }).items).toHaveLength(3);
    const none = await world();
    expect((await none.call('GET', '/ai/actions')).body).toEqual({ items: [], next: null });
  });

  it('carries no identifier of a player and nothing of the chat: a person ref for the staff, the step and the times', async () => {
    const w = await aiWorld();
    shadow(w);
    const res = await w.call('GET', '/ai/actions');
    const keys = keysDeep(res.body);
    for (const bad of ['text', 'line', 'summary', 'note', 'excerpt', 'clientKey', 'ip', 'handle', 'seat', 'undoNote']) expect(keys, bad).not.toContain(bad);
    expect(JSON.stringify(res.body)).not.toContain('read-');
  });
});
