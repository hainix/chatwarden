import { describe, expect, it } from 'vitest';
import { HubError, createHubClient } from '../src/client.js';
import type { Transport, TransportRequest } from '../src/transport.js';
import { appealsHub } from './appealsWorld.js';
import { hubWorld } from './world.js';

// The hub client's appeal and name methods, against the real staff routes (and a fake transport for the exact wire shape).

const queryOf = (r: TransportRequest): TransportRequest['query'] | null => (r.query === undefined || Object.keys(r.query).length === 0 ? null : r.query);
const spy = (body: unknown = {}): { transport: Transport; sent: TransportRequest[] } => {
  const sent: TransportRequest[] = [];
  return { sent, transport: (req) => (sent.push(req), Promise.resolve({ status: 200, headers: {}, body })) };
};

describe('the wire shapes', () => {
  it('appeals() asks GET /appeals with the status, cursor and limit it was given, and nothing else', async () => {
    const { transport, sent } = spy({ items: [], next: null });
    const c = createHubClient(transport);
    await c.appeals();
    await c.appeals({ status: 'open' });
    await c.appeals({ status: 'decided', cursor: 'abc', limit: 20 });
    expect(sent.map((r) => [r.method, r.path, queryOf(r)])).toEqual([
      ['GET', '/appeals', null],
      ['GET', '/appeals', { status: 'open' }],
      ['GET', '/appeals', { status: 'decided', cursor: 'abc', limit: 20 }],
    ]);
  });

  it('appeal(id), appealStats and rename use their routes, with the id encoded', async () => {
    const { transport, sent } = spy({ appeal: {} });
    const c = createHubClient(transport);
    await c.appeal('a/b c');
    await c.appealStats();
    await c.appealStats({ days: 365 });
    await c.rename('s_ref', { reason: 'a name against the rules' });
    await c.rename('s_ref', { reason: 'r', rule: 2, takeOver: true });
    expect(sent.map((r) => [r.method, r.path, queryOf(r), r.body ?? null])).toEqual([
      ['GET', '/appeals/a%2Fb%20c', null, null],
      ['GET', '/appeals/stats', null, null],
      ['GET', '/appeals/stats', { days: 365 }, null],
      ['POST', '/people/s_ref/rename', null, { reason: 'a name against the rules' }],
      ['POST', '/people/s_ref/rename', null, { reason: 'r', rule: 2, takeOver: true }],
    ]);
  });

  it('decideAppeal posts the outcome, the reason and, for a reduction, where it goes; a keep sends no `to`', async () => {
    const { transport, sent } = spy({ status: 'upheld' });
    const c = createHubClient(transport);
    await c.decideAppeal('a1', { outcome: 'uphold', reason: 'it stands' });
    await c.decideAppeal('a1', { outcome: 'reduce', reason: 'too long', to: { kind: 'chat', durationMs: 3_600_000 } });
    expect(sent.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/appeals/a1/decide', { outcome: 'uphold', reason: 'it stands' }],
      ['POST', '/appeals/a1/decide', { outcome: 'reduce', reason: 'too long', to: { kind: 'chat', durationMs: 3_600_000 } }],
    ]);
  });

  it('listBlocked asks for the names only through listBlockedNames, and the chat list stays as it was', async () => {
    const { transport, sent } = spy({ items: [] });
    const c = createHubClient(transport);
    await c.listBlocked();
    await c.listBlocked({ days: 30 });
    await c.listBlockedNames();
    await c.listBlockedNames({ days: 7 });
    expect(sent.map(queryOf)).toEqual([null, { days: 30 }, { source: 'name' }, { days: 7, source: 'name' }]);
  });
});

describe('against the real routes', () => {
  it('me carries features only when appeals, renames or keepBlocked is on', async () => {
    const off = await hubWorld({ role: 'owner' });
    expect(Object.keys(await off.client.me())).not.toContain('features');
    const on = await appealsHub({ role: 'owner', names: { renames: true } });
    expect((await on.client.me()).features).toEqual({ appeals: true, renames: true, keepBlocked: false });
    const appealsOnly = await appealsHub({ role: 'owner' });
    expect((await appealsOnly.client.me()).features).toEqual({ appeals: true, renames: false, keepBlocked: false });
    const keeping = await appealsHub({ role: 'owner', names: { keepBlocked: true } });
    expect((await keeping.client.me()).features).toEqual({ appeals: true, renames: false, keepBlocked: true });
  });

  it('changes carries the number of open appeals for a caller who may read them', async () => {
    const w = await appealsHub({ role: 'senior', actor: 'bea@example.test' });
    expect((await w.client.changes()).appeals).toBe(0);
    await w.appeal();
    await w.appeal();
    expect((await w.client.changes()).appeals).toBe(2);
    const off = await hubWorld();
    expect(Object.keys(await off.client.changes())).not.toContain('appeals');
  });

  it('lists, reads and decides an appeal; a decided one leaves the open list', async () => {
    const w = await appealsHub({ role: 'senior', actor: 'bea@example.test' });
    const a = await w.appeal({ target: 'Mallory', statement: 'It was a joke.' });
    const list = await w.client.appeals({ status: 'open' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: a.appealId, status: 'open', handle: 'Mallory', sanction: { kind: 'chat', refCode: a.refCode } });
    const detail = await w.client.appeal(a.appealId);
    expect(detail.appeal).toMatchObject({ id: a.appealId, statement: 'It was a joke.', statementFlagged: false });
    const done = await w.client.decideAppeal(a.appealId, { outcome: 'revoke', reason: 'a joke between friends' });
    expect(done).toMatchObject({ status: 'revoked' });
    expect((await w.client.appeals({ status: 'open' })).items).toHaveLength(0);
    expect((await w.client.appeals({ status: 'decided' })).items).toHaveLength(1);
  });

  it('refusals come back as HubErrors with the kit codes', async () => {
    const w = await appealsHub({ role: 'senior', actor: 'bea@example.test' });
    const a = await w.appeal({ actor: 'bea@example.test' });
    const same = await w.client.decideAppeal(a.appealId, { outcome: 'uphold', reason: 'mine' }).catch((e: unknown) => e);
    expect(same).toBeInstanceOf(HubError);
    expect(same).toMatchObject({ status: 409, code: 'same_decider' });
    const b = await w.appeal();
    await w.client.decideAppeal(b.appealId, { outcome: 'uphold', reason: 'fine' });
    expect(await w.client.decideAppeal(b.appealId, { outcome: 'uphold', reason: 'again' }).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'already_decided' });
    expect(await w.client.appeal('nope').catch((e: unknown) => e)).toMatchObject({ status: 404 });
  });

  it('appealStats answers per rule', async () => {
    const w = await appealsHub({ role: 'senior', actor: 'bea@example.test' });
    await w.appeal({ rule: 2 });
    const stats = await w.client.appealStats({ days: 30 });
    expect(stats.windowDays).toBe(30);
    expect(stats.perRule.find((r) => r.rule === 2)).toMatchObject({ appealed: 1, granted: 0 });
  });

  it('rename asks a player for a new name; a second is a pending_rename refusal', async () => {
    const w = await appealsHub({ role: 'moderator', names: { renames: true } });
    const f = await w.file({ target: 'zorbakKid' });
    expect(await w.client.rename(f.person, { reason: 'a name against the rules' })).toEqual({ ok: true });
    expect(await w.client.rename(f.person, { reason: 'again' }).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'pending_rename' });
    expect((await w.client.personHistory(f.person)).renames).toEqual([{ at: expect.any(Number), pending: true }]);
  });

  it('listBlockedNames lists the kept names, and is empty when none was kept', async () => {
    const w = await appealsHub({ role: 'senior', names: { keepBlocked: true } });
    expect(await w.client.listBlockedNames()).toEqual({ items: [] });
    w.cw.names.check('zorbakKid', { who: { clientKey: 'k-bad' } });
    const names = await w.client.listBlockedNames();
    expect(names.items).toHaveLength(1);
    expect(names.items[0]).toMatchObject({ text: 'zorbakKid', reason: 'name_not_allowed', roomId: null });
  });
});
