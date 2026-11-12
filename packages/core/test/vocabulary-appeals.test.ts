import { describe, expect, expectTypeOf, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { APPEAL_OUTCOMES } from '../src/appeals.js';
import type { AppealOutcome, AppealStatus } from '../src/appeals.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '../src/audit.js';
import type { AuditAction, AuditTargetType } from '../src/audit.js';
import { createChatwarden } from '../src/chatwarden.js';
import { KIT_EVENT_TYPES } from '../src/events.js';
import type { KitEvent, KitEventOf, StaffRef } from '../src/events.js';
import type { RuleRef } from '../src/rules.js';
import type { Platform, RawWho, SanctionKind } from '../src/types.js';

// The vocabulary of the appeals and names release: the audit actions and target type, the three events, and the appeal enums they use.

const NOW = 1_800_000_000_000;

async function kit() {
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'vocab-secret', platform, clock: { now: () => NOW }, retention: false });
  return cw;
}

const rec = (cw: Awaited<ReturnType<typeof kit>>, over: Record<string, unknown>): boolean =>
  cw.audit.record({ actor: 'alice', role: 'senior', action: 'report.view', ...over } as never);

describe('audit actions', () => {
  it('the three actions are last in AUDIT_ACTIONS and the order-lock test allows the append', () => {
    expect(AUDIT_ACTIONS.slice(-3)).toEqual(['appeal.view', 'appeal.decide', 'name.rename_required']);
    // nothing before them moved: the 0.1.7 list is a prefix
    expect(AUDIT_ACTIONS.slice(23, 26)).toEqual(['ai.read', 'ai.rerun', 'ai.outcome']);
    expect(AUDIT_ACTIONS).toHaveLength(29);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expectTypeOf<'appeal.view'>().toExtend<AuditAction>();
    expectTypeOf<'appeal.decide'>().toExtend<AuditAction>();
    expectTypeOf<'name.rename_required'>().toExtend<AuditAction>();
  });

  it('AUDIT_TARGET_TYPES ends with appeal; old rows still list', async () => {
    expect(AUDIT_TARGET_TYPES.slice(-1)).toEqual(['appeal']);
    expect([...AUDIT_TARGET_TYPES].slice(0, 6)).toEqual(['report', 'sanction', 'person', 'term', 'exception', 'reason']);
    expectTypeOf<'appeal'>().toExtend<AuditTargetType>();
    const cw = await kit();
    // a row of an old target type, then one of the new
    expect(rec(cw, { action: 'sanction.apply', target: { type: 'person', ref: 's_abc' } })).toBe(true);
    expect(rec(cw, { action: 'appeal.view', target: { type: 'appeal', ref: 'ap_1' } })).toBe(true);
    const items = cw.audit.list({ limit: 10 }).items;
    expect(items.map((i) => i.target?.type).sort()).toEqual(['appeal', 'person']);
  });

  it('appeal.* needs an appeal target and name.rename_required a person target', async () => {
    const cw = await kit();
    // appeal.decide: an appeal target, always
    expect(rec(cw, { action: 'appeal.decide', target: { type: 'appeal', ref: 'ap_1' } })).toBe(true);
    expect(rec(cw, { action: 'appeal.decide' })).toBe(false);
    for (const type of ['report', 'sanction', 'person', 'term', 'exception', 'reason']) {
      expect(rec(cw, { action: 'appeal.decide', target: { type, ref: 'x1' } }), type).toBe(false);
      expect(rec(cw, { action: 'appeal.view', target: { type, ref: 'x1' } }), type).toBe(false);
    }
    // appeal.view: an appeal target, or none (the list and the numbers)
    expect(rec(cw, { action: 'appeal.view', target: { type: 'appeal', ref: 'ap_1' } })).toBe(true);
    expect(rec(cw, { action: 'appeal.view' })).toBe(true);
    // name.rename_required: a person target, always
    expect(rec(cw, { action: 'name.rename_required', target: { type: 'person', ref: 's_abc123' } })).toBe(true);
    expect(rec(cw, { action: 'name.rename_required' })).toBe(false);
    for (const type of ['report', 'sanction', 'term', 'exception', 'reason', 'appeal']) {
      expect(rec(cw, { action: 'name.rename_required', target: { type, ref: 'x1' } }), type).toBe(false);
    }
    // an id only: a target ref still has to look like an id
    expect(rec(cw, { action: 'appeal.decide', target: { type: 'appeal', ref: 'not an id' } })).toBe(false);
    expect(rec(cw, { action: 'appeal.decide', target: { type: 'appeal', ref: '' } })).toBe(false);
  });

  it('a moderator may record each action (the role is the staff member\'s own, never a check on the action)', async () => {
    const cw = await kit();
    for (const role of ['moderator', 'senior', 'owner']) {
      expect(rec(cw, { role, action: 'appeal.view' })).toBe(true);
    }
    expect(rec(cw, { role: null, action: 'appeal.view' })).toBe(false);
  });

  it('no detail is allowed on appeal.view, appeal.decide or name.rename_required', async () => {
    const cw = await kit();
    const target = { type: 'appeal', ref: 'ap_1' };
    for (const detail of [{ sections: [] }, { sections: ['appeals'] }, { reason: 'because' }, {}, null, 'x']) {
      expect(rec(cw, { action: 'appeal.view', target, detail }), JSON.stringify(detail)).toBe(false);
      expect(rec(cw, { action: 'appeal.decide', target, detail }), JSON.stringify(detail)).toBe(false);
      expect(rec(cw, { action: 'name.rename_required', target: { type: 'person', ref: 's_a' }, detail }), JSON.stringify(detail)).toBe(false);
    }
    expect(cw.audit.list({ limit: 10 }).items).toEqual([]);
  });

  it('a refused record writes nothing and logs the same refusal event as any other', async () => {
    const warned: string[] = [];
    const platform: Platform = { identify: (ctx) => ctx as RawWho };
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 's', platform, clock: { now: () => NOW }, retention: false, logger: { warn: (e) => void warned.push(e) } });
    warned.length = 0;
    expect(cw.audit.record({ actor: 'alice', role: 'senior', action: 'appeal.decide' })).toBe(false);
    expect(warned).toEqual(['chatwarden.audit_refused']);
  });

  it('list filters by the new actions, and an unknown action is still refused', async () => {
    const cw = await kit();
    rec(cw, { action: 'appeal.decide', target: { type: 'appeal', ref: 'ap_1' } });
    rec(cw, { action: 'appeal.view' });
    rec(cw, { action: 'policy.view' });
    expect(cw.audit.list({ limit: 10, action: 'appeal.decide' }).items).toHaveLength(1);
    expect(cw.audit.list({ limit: 10, action: 'appeal.view' }).items).toHaveLength(1);
    expect(() => cw.audit.list({ limit: 10, action: 'appeal.decided' as never })).toThrow();
  });
});

describe('events', () => {
  it('KIT_EVENT_TYPES ends with the three new types; cw.on accepts them; an unknown type still throws', async () => {
    expect(KIT_EVENT_TYPES.slice(-3)).toEqual(['appeal.created', 'appeal.decided', 'rename.required']);
    expect(KIT_EVENT_TYPES.slice(0, 6)).toEqual(['report.created', 'report.closed', 'sanction.applied', 'sanction.revoked', 'gap.created', 'auto.restricted']);
    const cw = await kit();
    for (const type of ['appeal.created', 'appeal.decided', 'rename.required'] as const) {
      const off = cw.on(type, () => undefined);
      expect(typeof off).toBe('function');
      off();
    }
    expect(() => cw.on('appeal.moot' as never, () => undefined)).toThrow(TypeError);
    expect(() => cw.on('appeal.create' as never, () => undefined)).toThrow(TypeError);
  });

  it('the new event shapes hold no statement, reason or handle', () => {
    expectTypeOf<KitEventOf<'appeal.created'>>().toEqualTypeOf<{
      type: 'appeal.created';
      appealId: string;
      createdAt: number;
      target: StaffRef;
      kind: SanctionKind;
      rule: RuleRef | null;
    }>();
    expectTypeOf<KitEventOf<'appeal.decided'>>().toEqualTypeOf<{
      type: 'appeal.decided';
      appealId: string;
      at: number;
      target: StaffRef;
      outcome: AppealOutcome;
      rule: RuleRef | null;
    }>();
    expectTypeOf<KitEventOf<'rename.required'>>().toEqualTypeOf<{ type: 'rename.required'; at: number; target: StaffRef; rule: RuleRef | null }>();
    // no field of any of them is free text of a player or a moderator
    type Keys = keyof KitEventOf<'appeal.created'> | keyof KitEventOf<'appeal.decided'> | keyof KitEventOf<'rename.required'>;
    expectTypeOf<Extract<Keys, 'statement' | 'reason' | 'decisionReason' | 'handle' | 'name' | 'note' | 'accounts'>>().toEqualTypeOf<never>();
    expectTypeOf<KitEventOf<'appeal.decided'>['outcome']>().toEqualTypeOf<'uphold' | 'reduce' | 'revoke'>();
    // and they are members of the union, so cw.on('*') hears them
    expectTypeOf<KitEvent['type']>().toExtend<string>();
    expectTypeOf<'appeal.created' | 'appeal.decided' | 'rename.required'>().toExtend<KitEvent['type']>();
  });
});

describe('the appeal enums', () => {
  it('APPEAL_OUTCOMES is uphold, reduce, revoke, in that order', () => {
    expect([...APPEAL_OUTCOMES]).toEqual(['uphold', 'reduce', 'revoke']);
    expectTypeOf<AppealOutcome>().toEqualTypeOf<'uphold' | 'reduce' | 'revoke'>();
  });

  it('AppealStatus is open, upheld, reduced, revoked or moot', () => {
    expectTypeOf<AppealStatus>().toEqualTypeOf<'open' | 'upheld' | 'reduced' | 'revoked' | 'moot'>();
  });
});
