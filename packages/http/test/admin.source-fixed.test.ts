import { describe, expect, it } from 'vitest';
import { DAY, HOUR, world } from './world.js';

// The staff routes fix `source: 'moderator'` and take the actor from the authz hook, whatever the body says (design 6.1). A body that names the AI as
// the source, with or without `automated`, never reaches the writer as one: the row is a moderator's, by the signed-in actor, not automated.

describe('the staff HTTP routes fix source moderator whatever the body says', () => {
  it.each([
    ['ai', true],
    ['ai', false],
    ['api', true],
    ['auto_filter', true],
    ['coop', false],
  ] as const)('POST /sanctions with body source %s and automated %s writes a moderator row', async (source, automated) => {
    const { call, person, store, clock } = await world();
    const res = await call('POST', '/sanctions', {
      actor: 'bob',
      body: { subject: person(), kind: 'chat', durationMs: HOUR, rule: 2, reason: 'about glarn', source, automated, actor: 'ai:fake' },
    });
    expect(res.status).toBe(200);
    const row = store.loadSanctions(clock.t).find((r) => r.groupId === (res.body as { groupId: string }).groupId);
    expect(row).toMatchObject({ actor: 'bob', source: 'moderator', automated: false });
    expect(store.listSubjectSanctions({ source: 'ai', limit: 10 })).toEqual([]);
  });

  it('POST /reports/:id/decide with body source ai writes a moderator decision and no ai row', async () => {
    const { call, file, store, cw } = await world();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, {
      actor: 'sam',
      role: 'senior',
      body: { verdict: 'upheld', actions: [{ subject: r.target, kind: 'chat', durationMs: DAY, rule: 2 }], reason: 'about snerp', source: 'ai', automated: true, actor: 'ai:fake' },
    });
    expect(res.status).toBe(200);
    expect(cw.reports.get(r.id)?.status).toBe('actioned');
    const rows = store.listSubjectSanctions({ limit: 10 });
    expect(rows.map((s) => [s.source, s.automated, s.actor])).toEqual([['moderator', false, 'sam']]);
    expect(store.listSubjectSanctions({ source: 'ai', limit: 10 })).toEqual([]);
  });
});
