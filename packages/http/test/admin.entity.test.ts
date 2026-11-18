import { describe, expect, it } from 'vitest';
import type { KitEvent, Matcher } from '@chatwarden/core';
import { errorOf, world } from './world.js';

// M6: the entity on a case (`GET /reports/:id` carries `entity`, and `entityLabelFlagged` when the label is a name the matcher flags) and the entity on a rename (`POST /people/:ref/rename { entity }`: no notice, an event, an
// audit row, no pending flag). Synthetic terms only: zorbak is a slur here.

const matcher: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
const ENTITY = { kind: 'clan', ref: 'clan-4711', label: 'Blue Wolves' };
const REASON = 'private reason: the clan name impersonates staff';

type W = Awaited<ReturnType<typeof world>>;
const kit = (names: Record<string, unknown> = { renames: true }) => world({ matcher, overrides: { names } });

let n = 0;
/** A report about the owner of a clan: a reporter and the owner seated in a room, the report names the entity. */
async function fileAbout(w: W, entity: unknown) {
  n += 1;
  const room = `entity-room-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-reporter-e${n}`, ip: '198.51.100.31' }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: `raw-client-key-owner-e${n}`, ip: '198.51.100.32' }, 'Owner');
  w.cw.chat.accept(room, 'p2', 'a line from the owner');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', ...(entity === undefined ? {} : { entity }) } as never);
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  return { id: res.reportId, target: report?.targetPerson as string, key: `raw-client-key-owner-e${n}` };
}
const detail = async (w: W, id: string, o: { scope?: readonly string[] } = {}) => (await w.call('GET', `/reports/${id}`, { role: 'moderator', ...o })).body as { report: Record<string, unknown> };
const rename = (w: W, ref: string, body: unknown, role: 'moderator' | 'owner' = 'moderator') => w.call('POST', `/people/${ref}/rename`, { role, actor: 'ann', body });

describe('the case', () => {
  it('shows the entity as { kind, ref, label } on the detail; a report without one has no entity key at all', async () => {
    const w = await kit();
    const a = await fileAbout(w, ENTITY);
    const b = await fileAbout(w, undefined);
    expect((await detail(w, a.id)).report.entity).toEqual(ENTITY);
    const plain = (await detail(w, b.id)).report;
    expect(Object.hasOwn(plain, 'entity')).toBe(false);
    expect(Object.hasOwn(plain, 'entityLabelFlagged')).toBe(false);
  });

  it('the queue rows are unchanged: no entity there, only on the report you open', async () => {
    const w = await kit();
    await fileAbout(w, ENTITY);
    const list = (await w.call('GET', '/reports', { role: 'moderator' })).body as { items: Array<Record<string, unknown>> };
    expect(list.items.length).toBeGreaterThan(0);
    for (const row of list.items) expect(Object.hasOwn(row, 'entity')).toBe(false);
  });

  it('a label the matcher flags is marked entityLabelFlagged: true (the hub hides it until shown); a clean one has no mark', async () => {
    const w = await kit();
    const flagged = await fileAbout(w, { ...ENTITY, label: 'Zorbak Clan' });
    const clean = await fileAbout(w, ENTITY);
    expect((await detail(w, flagged.id)).report).toMatchObject({ entity: { label: 'Zorbak Clan' }, entityLabelFlagged: true });
    expect(Object.hasOwn((await detail(w, clean.id)).report, 'entityLabelFlagged')).toBe(false);
  });

  it('with names.maskInHub off nothing is marked', async () => {
    const w = await kit({ maskInHub: false });
    const flagged = await fileAbout(w, { ...ENTITY, label: 'Zorbak Clan' });
    expect(Object.hasOwn((await detail(w, flagged.id)).report, 'entityLabelFlagged')).toBe(false);
  });

  it('a scoped moderator sees the entity of a report in their scope, and a report out of scope is the 404 of an unknown id', async () => {
    const w = await kit();
    const room = 'entity-scope-room';
    w.cw.rooms.seat(room, 'p1', { clientKey: 'raw-client-key-reporter-sc', ip: '198.51.100.41' }, 'Rep', { scope: 'creator:alice' });
    w.cw.rooms.seat(room, 'p2', { clientKey: 'raw-client-key-owner-sc', ip: '198.51.100.42' }, 'Owner');
    w.cw.chat.accept(room, 'p2', 'hello');
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', entity: ENTITY });
    if (!res.ok) throw new Error('refused');
    expect((await detail(w, res.reportId, { scope: ['creator:alice'] })).report.entity).toEqual(ENTITY);
    const other = await w.call('GET', `/reports/${res.reportId}`, { role: 'moderator', scope: ['creator:bob'] });
    expect(other.status).toBe(404);
  });

  it('the label is not in the history, the suggestion or the rule of the same answer', async () => {
    const w = await kit();
    const a = await fileAbout(w, { ...ENTITY, label: 'PRIVATE-CLAN-LABEL' });
    const res = await w.call('GET', `/reports/${a.id}`, { role: 'moderator' });
    const body = res.body as { report: unknown; history: unknown; suggest: unknown; rule: unknown };
    expect(JSON.stringify({ history: body.history, suggest: body.suggest, rule: body.rule })).not.toContain('PRIVATE-CLAN-LABEL');
  });
});

describe('POST /people/:ref/rename with an entity', () => {
  it('200 { ok: true }: no notice, no pending flag, the game hears rename.required with { kind, ref } and no label', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    const events: KitEvent[] = [];
    w.cw.on('rename.required', (e) => void events.push(e));
    const res = await rename(w, f.target, { reason: REASON, rule: 2, entity: { kind: 'clan', ref: 'clan-4711' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    expect(w.cw.notices.pending({ clientKey: f.key }).filter((x) => x.kind === 'rename_required')).toEqual([]);
    expect(events).toEqual([{ type: 'rename.required', at: expect.any(Number) as number, target: f.target, rule: expect.anything() as unknown, entity: { kind: 'clan', ref: 'clan-4711' } }]);
    expect(JSON.stringify(events)).not.toContain('Blue Wolves');
  });

  it('audits name.rename_required with the person as target, no reason, no entity in the row', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    await rename(w, f.target, { reason: REASON, rule: 2, entity: { kind: 'clan', ref: 'clan-4711' } });
    const rows = w.routeAudit();
    expect(rows.map((r) => [r.action, r.target])).toEqual([['name.rename_required', { type: 'person', ref: f.target }]]);
    expect(JSON.stringify(w.audit())).not.toMatch(/clan-4711|Blue Wolves|impersonates/);
  });

  it('an entity rename can repeat and does not stop a rename of the player, which still goes pending', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    const body = { reason: REASON, rule: 2, entity: { kind: 'clan', ref: 'clan-4711' } };
    expect((await rename(w, f.target, body)).status).toBe(200);
    expect((await rename(w, f.target, body)).status).toBe(200);
    expect((await rename(w, f.target, { reason: REASON, rule: 2 })).status).toBe(200);
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(true);
    expect((await rename(w, f.target, body)).status).toBe(200);
    expect((await rename(w, f.target, { reason: REASON, rule: 2 })).status).toBe(409);
  });

  it('400 for a bad entity: a label, a bad kind or ref, extra keys, other shapes; nothing is written', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    const bad: unknown[] = [
      { kind: 'clan', ref: 'x', label: 'Blue Wolves' },
      { kind: 'Clan', ref: 'x' },
      { kind: '', ref: 'x' },
      { kind: 'clan', ref: 'a b' },
      { kind: 'clan', ref: 'x'.repeat(65) },
      { kind: 'clan' },
      { ref: 'x' },
      { kind: 'clan', ref: 'x', extra: 1 },
      'clan',
      5,
      [],
      [{ kind: 'clan', ref: 'x' }],
    ];
    for (const entity of bad) {
      const res = await rename(w, f.target, { reason: REASON, rule: 2, entity });
      expect(res.status, JSON.stringify(entity)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    expect(w.routeAudit()).toEqual([]);
  });

  it('entity null is a rename of the player, and the route is still 404 while renames are off, before the body is read', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    expect((await rename(w, f.target, { reason: REASON, rule: 2, entity: null })).status).toBe(200);
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(true);
    const off = await kit({});
    const g = await fileAbout(off, ENTITY);
    expect((await rename(off, g.target, { reason: REASON, rule: 2, entity: { kind: 'clan', ref: 'x' } })).status).toBe(404);
    expect((await rename(off, g.target, { entity: 'junk' })).status).toBe(404);
  });

  it('still needs sanctions.apply and the reason and the rule', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    expect((await w.call('POST', `/people/${f.target}/rename`, { role: null, body: { reason: REASON, rule: 2, entity: { kind: 'clan', ref: 'x' } } })).status).toBe(401);
    expect((await rename(w, f.target, { rule: 2, entity: { kind: 'clan', ref: 'x' } })).status).toBe(400);
    expect((await rename(w, f.target, { reason: REASON, entity: { kind: 'clan', ref: 'x' } })).status).toBe(400);
  });
});

// Review m11: a rename that carries an entity is only for an entity an OPEN report about THAT person names.
describe('POST /people/:ref/rename with an entity: the entity must be on an open report about the person (review m11)', () => {
  const body = (entity: unknown) => ({ reason: REASON, rule: 2, entity });

  it('an entity no report names is refused 400 invalid_request, and nothing is written, announced or audited', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    const events: KitEvent[] = [];
    w.cw.on('rename.required', (e) => void events.push(e));
    const res = await rename(w, f.target, body({ kind: 'clan', ref: 'clan-9999' }));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_request');
    expect(events).toEqual([]);
    expect(w.routeAudit()).toEqual([]);
  });

  it('kind and ref must both match: the right ref under another kind, and the right kind with another ref, are refused', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    for (const entity of [{ kind: 'guild', ref: 'clan-4711' }, { kind: 'clan', ref: 'clan-4712' }, { kind: 'clan', ref: 'CLAN-4711' }, { kind: 'clan', ref: 'clan-471' }]) {
      expect((await rename(w, f.target, body(entity))).status, JSON.stringify(entity)).toBe(400);
    }
    expect((await rename(w, f.target, body({ kind: 'clan', ref: 'clan-4711' }))).status).toBe(200);
  });

  it('an entity that another person\'s report names is refused for this person', async () => {
    const w = await kit();
    const a = await fileAbout(w, { kind: 'clan', ref: 'clan-aaa', label: 'Alpha' });
    const b = await fileAbout(w, { kind: 'clan', ref: 'clan-bbb', label: 'Beta' });
    expect((await rename(w, a.target, body({ kind: 'clan', ref: 'clan-bbb' }))).status).toBe(400);
    expect((await rename(w, b.target, body({ kind: 'clan', ref: 'clan-aaa' }))).status).toBe(400);
    expect((await rename(w, a.target, body({ kind: 'clan', ref: 'clan-aaa' }))).status).toBe(200);
    expect((await rename(w, b.target, body({ kind: 'clan', ref: 'clan-bbb' }))).status).toBe(200);
  });

  it('a report that was decided no longer counts: once the case is closed the entity is refused', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    expect((await rename(w, f.target, body({ kind: 'clan', ref: 'clan-4711' }))).status).toBe(200);
    const done = await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: 'ann' });
    expect(done.ok).toBe(true);
    expect((await rename(w, f.target, body({ kind: 'clan', ref: 'clan-4711' }))).status).toBe(400);
  });

  it('a person with several open reports may name any entity of them, and a report with no entity names none', async () => {
    const w = await kit();
    const room = 'multi-room';
    w.cw.rooms.seat(room, 'p1', { clientKey: 'raw-client-key-rep-multi-1', ip: '198.51.100.41' }, 'Rep1');
    w.cw.rooms.seat(room, 'p2', { clientKey: 'raw-client-key-owner-multi', ip: '198.51.100.42' }, 'Owner');
    w.cw.rooms.seat(room, 'p3', { clientKey: 'raw-client-key-rep-multi-3', ip: '198.51.100.43' }, 'Rep3');
    w.cw.rooms.seat(room, 'p4', { clientKey: 'raw-client-key-rep-multi-4', ip: '198.51.100.44' }, 'Rep4');
    w.cw.chat.accept(room, 'p2', 'a line from the owner');
    w.clock.t += 1000;
    const ids: string[] = [];
    for (const [reporter, entity] of [['p1', { kind: 'clan', ref: 'clan-one', label: 'One' }], ['p3', { kind: 'guild', ref: 'guild-two', label: 'Two' }], ['p4', undefined]] as const) {
      const res = await w.cw.reports.submit({ roomId: room, reporterSeat: reporter, targetSeat: 'p2', ...(entity === undefined ? {} : { entity }) } as never);
      if (!res.ok) throw new Error(`refused: ${res.refused}`);
      ids.push(res.reportId);
      w.clock.t += 1000;
    }
    const target = w.cw.reports.get(ids[0] as string)?.targetPerson as string;
    expect((await rename(w, target, body({ kind: 'clan', ref: 'clan-one' }))).status).toBe(200);
    expect((await rename(w, target, body({ kind: 'guild', ref: 'guild-two' }))).status).toBe(200);
    expect((await rename(w, target, body({ kind: 'clan', ref: 'clan-three' }))).status).toBe(400);
  });

  it('a rename without an entity, or with entity null, needs no report at all', async () => {
    const w = await kit();
    const f = await fileAbout(w, undefined);
    expect((await rename(w, f.target, { reason: REASON, rule: 2, entity: null })).status).toBe(200);
  });

  it('the refusal comes before the claim gate: a person another moderator is handling is not taken over by a refused entity', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    const res = await rename(w, f.target, { ...body({ kind: 'clan', ref: 'nope' }), takeOver: true }, 'owner');
    expect(res.status).toBe(400);
    expect(w.routeAudit()).toEqual([]);
  });

  it('the refusal never echoes the entity it was sent', async () => {
    const w = await kit();
    const f = await fileAbout(w, ENTITY);
    const res = await rename(w, f.target, body({ kind: 'clan', ref: 'SECRET-ENTITY-REF' }));
    expect(JSON.stringify(res.body)).not.toContain('SECRET-ENTITY-REF');
  });
});
