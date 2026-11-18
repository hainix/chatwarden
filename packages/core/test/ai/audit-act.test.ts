import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/audit.js';
import { aiWorld } from './aiWorld.js';

// The audit rows of the shadow release (AI levels 3 and 4, design 6.8): `ai.act` is the AI's own row (an `ai:` actor, no role, a report target, no detail);
// `ai.acting` and `ai.undo_all` are a person's (a role, a detail with the sections [ai] and the reason, no target). The list only grew at the end.

type Rec = Parameters<Awaited<ReturnType<typeof aiWorld>>['cw']['audit']['record']>[0];

describe('ai.act, ai.acting and ai.undo_all', () => {
  it('are appended after person.automation, once each', () => {
    const at = AUDIT_ACTIONS.indexOf('ai.act');
    expect(AUDIT_ACTIONS.slice(at, at + 3)).toEqual(['ai.act', 'ai.acting', 'ai.undo_all']);
    expect(AUDIT_ACTIONS[32]).toBe('person.automation');
    for (const a of ['ai.act', 'ai.acting', 'ai.undo_all']) expect(AUDIT_ACTIONS.filter((x) => x === a)).toHaveLength(1);
  });

  it('ai.act: only the AI actor, no role, a report target and nothing else', async () => {
    const w = await aiWorld();
    const rec = (i: Rec): boolean => w.cw.audit.record(i);
    expect(rec({ actor: 'ai:test:model', role: null, action: 'ai.act', target: { type: 'report', ref: 'r1' } })).toBe(true);
    // a person never records it, even a senior or the owner
    for (const role of ['moderator', 'senior', 'owner'] as const) expect(rec({ actor: 'ann', role, action: 'ai.act', target: { type: 'report', ref: 'r1' } }), role).toBe(false);
    // no target, another target type, a detail or a role on the AI actor are refused
    expect(rec({ actor: 'ai:test:model', role: null, action: 'ai.act' })).toBe(false);
    for (const type of ['person', 'sanction', 'term', 'appeal'] as const) expect(rec({ actor: 'ai:test:model', role: null, action: 'ai.act', target: { type, ref: 'x1' } }), type).toBe(false);
    expect(rec({ actor: 'ai:test:model', role: null, action: 'ai.act', target: { type: 'report', ref: 'r1' }, detail: { sections: ['ai'] } })).toBe(false);
    expect(rec({ actor: 'ai:test:model', role: 'owner', action: 'ai.act', target: { type: 'report', ref: 'r1' } })).toBe(false);
  });

  it('the AI actor records ai.read and ai.act and nothing else', async () => {
    const w = await aiWorld();
    for (const action of AUDIT_ACTIONS.filter((a) => a !== 'ai.read' && a !== 'ai.act')) {
      const detail = action === 'policy.update' || action === 'policy.reset' || action === 'ai.acting' || action === 'ai.undo_all' ? { detail: { sections: ['ai' as const], reason: 'x' } } : {};
      expect(w.cw.audit.record({ actor: 'ai:test:model', role: null, action, target: { type: 'report', ref: 'r1' }, ...detail }), action).toBe(false);
    }
  });

  it('ai.acting and ai.undo_all: a person with a role, the sections [ai] and a reason; no AI actor, no missing detail, no other sections', async () => {
    const w = await aiWorld();
    const rec = (i: Rec): boolean => w.cw.audit.record(i);
    for (const action of ['ai.acting', 'ai.undo_all'] as const) {
      expect(rec({ actor: 'owner_ann', role: 'owner', action, detail: { sections: ['ai'], reason: 'we are ready' } }), action).toBe(true);
      expect(rec({ actor: 'sen_bo', role: 'senior', action, detail: { sections: ['ai'], reason: 'incident' } }), action).toBe(true);
      expect(rec({ actor: 'owner_ann', role: 'owner', action }), `${action} needs a detail`).toBe(false);
      expect(rec({ actor: 'owner_ann', role: 'owner', action, detail: { sections: ['ai'], reason: '' } }), `${action} reason`).toBe(false);
      expect(rec({ actor: 'owner_ann', role: 'owner', action, detail: { sections: ['ai'], reason: 'x'.repeat(2001) } }), `${action} long`).toBe(false);
      expect(rec({ actor: 'owner_ann', role: null, action, detail: { sections: ['ai'], reason: 'x' } }), `${action} no role`).toBe(false);
      expect(rec({ actor: 'ai:test:model', role: null, action, detail: { sections: ['ai'], reason: 'x' } }), `${action} ai`).toBe(false);
      expect(rec({ actor: 'owner_ann', role: 'owner', action, detail: { sections: ['ai'], reason: 'x', extra: 1 } as never }), `${action} extra`).toBe(false);
    }
    const rows = w.cw.audit.list({ limit: 20 }).items;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => !('target' in r))).toBe(true);
    expect(rows.map((r) => r.detail)).toEqual(expect.arrayContaining([{ sections: ['ai'], reason: 'we are ready' }]));
  });
});
