import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUDIT_ACTIONS, isValidAuditActor } from '../../src/audit.js';
import type { AuditAction, AuditRecordInput, AuditRow } from '../../src/audit.js';
import { world } from '../reportingWorld.js';

const ADAPTER_ACTOR = 'ai:anthropic:claude-haiku-5-5';
const REPORT = { type: 'report', ref: 'report_123' } as const;
const AI_ACTIONS = ['ai.read', 'ai.rerun', 'ai.outcome'] as const;

// The list as 0.1.5 shipped it. It is append-only: this prefix never changes.
const SHIPPED = [
  'report.view', 'report.decide', 'sanction.apply', 'sanction.revoke', 'gap.close', 'term.add', 'term.update', 'term.toggle',
  'exception.add', 'exception.update', 'exception.toggle', 'history.view', 'suggest', 'policy.view', 'blocked.view', 'case.takeover',
  'reason.add', 'reason.update', 'reason.toggle', 'policy.update', 'policy.reset', 'report.dismiss_case', 'report.dismiss_reporter',
];

const rec = (cw: Awaited<ReturnType<typeof world>>['cw'], over: Record<string, unknown>): boolean =>
  cw.audit.record({ actor: 'mod_ann', role: 'moderator', action: 'ai.rerun', target: REPORT, ...over } as never);

describe('the AI audit actions', () => {
  it('append after the 0.1.5 list and change nothing before it', () => {
    expect(AUDIT_ACTIONS.slice(0, SHIPPED.length)).toEqual(SHIPPED);
    expect(AUDIT_ACTIONS.slice(SHIPPED.length, SHIPPED.length + 3)).toEqual(['ai.read', 'ai.rerun', 'ai.outcome']);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('ai.read is recorded with actor ai:anthropic:claude-haiku-5-5 and role null', async () => {
    const { cw } = await world();
    expect(rec(cw, { actor: ADAPTER_ACTOR, role: null, action: 'ai.read' })).toBe(true);
    const items = cw.audit.list({ limit: 5 }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ actor: ADAPTER_ACTOR, role: null, action: 'ai.read', target: REPORT });
    expect(items[0]?.detail).toBeUndefined();
    // And the list filters by it.
    expect(cw.audit.list({ limit: 5, action: 'ai.read' }).items).toHaveLength(1);
    expect(cw.audit.list({ limit: 5, action: 'ai.rerun' }).items).toHaveLength(0);
    expect(cw.audit.list({ limit: 5, actor: ADAPTER_ACTOR }).items).toHaveLength(1);
  });

  it('ai.rerun and ai.outcome are recorded by a moderator, with their role', async () => {
    const { cw } = await world();
    expect(rec(cw, { action: 'ai.rerun' })).toBe(true);
    expect(rec(cw, { action: 'ai.outcome', actor: 'senior_bo', role: 'senior' })).toBe(true);
    const items = cw.audit.list({ limit: 5 }).items;
    expect(items.map((i) => [i.action, i.actor, i.role])).toEqual(
      expect.arrayContaining([['ai.rerun', 'mod_ann', 'moderator'], ['ai.outcome', 'senior_bo', 'senior']]),
    );
  });

  it('a null role is refused for a human actor', async () => {
    const { cw } = await world();
    for (const action of AUDIT_ACTIONS) {
      const base = action === 'policy.update' || action === 'policy.reset' ? { detail: { sections: [] } } : {};
      expect(rec(cw, { actor: 'mod_ann', role: null, action, ...base }), action).toBe(false);
    }
    expect(rec(cw, { actor: 'mod_ann', role: undefined, action: 'ai.rerun' })).toBe(false);
    expect(cw.audit.list({ limit: 5 }).items).toEqual([]);
  });

  it('a role is refused for an ai: actor, and an ai: actor may record ai.read only', async () => {
    const { cw } = await world();
    expect(rec(cw, { actor: ADAPTER_ACTOR, role: 'owner', action: 'ai.read' })).toBe(false);
    expect(rec(cw, { actor: ADAPTER_ACTOR, role: 'moderator', action: 'ai.read' })).toBe(false);
    for (const action of AUDIT_ACTIONS.filter((a) => a !== 'ai.read')) {
      const base = action === 'policy.update' || action === 'policy.reset' ? { detail: { sections: [] } } : {};
      expect(rec(cw, { actor: ADAPTER_ACTOR, role: null, action, ...base }), action).toBe(false);
    }
    expect(cw.audit.list({ limit: 5 }).items).toEqual([]);
  });

  it('ai.read cannot be recorded by a human actor', async () => {
    const { cw } = await world();
    expect(rec(cw, { actor: 'mod_ann', role: 'owner', action: 'ai.read' })).toBe(false);
    expect(cw.audit.list({ limit: 5 }).items).toEqual([]);
  });

  it('ai.rerun and ai.outcome need a report target (so does ai.read)', async () => {
    const { cw } = await world();
    for (const action of AI_ACTIONS) {
      const who = action === 'ai.read' ? { actor: ADAPTER_ACTOR, role: null } : {};
      expect(rec(cw, { ...who, action, target: undefined }), `${action} no target`).toBe(false);
      for (const type of ['sanction', 'person', 'term', 'exception', 'reason']) {
        expect(rec(cw, { ...who, action, target: { type, ref: 'x1' } }), `${action} ${type}`).toBe(false);
      }
      expect(rec(cw, { ...who, action, target: { type: 'report', ref: 'bad ref!' } }), `${action} bad ref`).toBe(false);
      expect(rec(cw, { ...who, action, target: REPORT }), `${action} ok`).toBe(true);
    }
    expect(cw.audit.list({ limit: 10 }).items).toHaveLength(3);
  });

  it('no detail is allowed on the new actions', async () => {
    const { cw } = await world();
    for (const action of AI_ACTIONS) {
      const who = action === 'ai.read' ? { actor: ADAPTER_ACTOR, role: null } : {};
      for (const detail of [{ sections: [] }, { reason: 'why' }, { summary: 'a summary of chat' }, {}, 'text', []]) {
        expect(rec(cw, { ...who, action, detail }), `${action} ${JSON.stringify(detail)}`).toBe(false);
      }
    }
    expect(cw.audit.list({ limit: 10 }).items).toEqual([]);
  });

  it('the old rows still list, with the new filter values and null roles', async () => {
    const { cw, store, clock } = await world();
    store.insertAudit({ id: 'legacy', at: clock.t - 5, actor: 'legacy_login', role: null, action: 'term.add', target: { type: 'term', ref: 't1' } });
    expect(rec(cw, { action: 'report.decide', target: REPORT })).toBe(true);
    clock.t += 1;
    expect(rec(cw, { action: 'ai.rerun' })).toBe(true);
    const items = cw.audit.list({ limit: 10 }).items;
    expect(items.map((i) => i.action)).toEqual(['ai.rerun', 'report.decide', 'term.add']);
    expect(items[2]).toMatchObject({ actor: 'legacy_login', role: null });
    expect(cw.audit.list({ limit: 10, action: 'term.add' }).items).toHaveLength(1);
  });

  it('an actor with a colon in the adapter id passes the actor pattern', () => {
    expect(isValidAuditActor('ai:anthropic:claude-haiku-5-5')).toBe(true);
    expect(isValidAuditActor('ai:openai:gpt-4.1-mini')).toBe(true);
    expect(isValidAuditActor('ai:custom_adapter+v2:model@2026')).toBe(true);
    expect(isValidAuditActor(`ai:${'x'.repeat(125)}`)).toBe(true);
    expect(isValidAuditActor(`ai:${'x'.repeat(126)}`)).toBe(false);
    expect(isValidAuditActor('ai:has space')).toBe(false);
    expect(isValidAuditActor('ai:slash/id')).toBe(false);
  });

  it('refuses an ai: actor that is only a prefix-look-alike', async () => {
    const { cw } = await world();
    // "ai" with no colon is a staff login like any other, so it needs a role.
    expect(rec(cw, { actor: 'ai', role: null, action: 'ai.read' })).toBe(false);
    expect(rec(cw, { actor: 'AI:anthropic', role: null, action: 'ai.read' })).toBe(false);
    expect(rec(cw, { actor: 'ai', role: 'moderator', action: 'ai.rerun' })).toBe(true);
  });

  it('types: the role may be null in an input, and the new actions are in AuditAction', () => {
    expectTypeOf<AuditRecordInput['role']>().toEqualTypeOf<'moderator' | 'senior' | 'owner' | null>();
    expectTypeOf<'ai.read'>().toExtend<AuditAction>();
    expectTypeOf<'ai.rerun'>().toExtend<AuditAction>();
    expectTypeOf<'ai.outcome'>().toExtend<AuditAction>();
    expectTypeOf<AuditRow['role']>().toEqualTypeOf<'moderator' | 'senior' | 'owner' | null>();
  });
});
