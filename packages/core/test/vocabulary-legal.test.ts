import { describe, expect, expectTypeOf, it } from 'vitest';
import { HOLD_CODES, isHoldCode } from '../src/legal.js';
import type { HoldCode } from '../src/legal.js';
import { KIT_EVENT_TYPES } from '../src/events.js';
import type { KitEventOf, StaffRef } from '../src/events.js';
import { EventBus } from '../src/events.js';

// The vocabulary the legal-hold feature adds: one event type, appended last, and a closed list of codes.

describe('report.escalated is the event of a hold', () => {
  it('is last in KIT_EVENT_TYPES (the list only grows at the end), appearing once', () => {
    expect(KIT_EVENT_TYPES.at(-1)).toBe('report.escalated');
    expect(KIT_EVENT_TYPES.filter((t) => t === 'report.escalated').length).toBe(1);
    // order-lock by set membership: every earlier type is still there
    for (const t of ['report.created', 'report.closed', 'sanction.applied', 'sanction.revoked', 'gap.created', 'auto.restricted', 'appeal.created', 'appeal.decided', 'rename.required']) {
      expect(KIT_EVENT_TYPES).toContain(t);
    }
  });

  it('cw.on accepts it, and an unknown type still throws', () => {
    const bus = new EventBus();
    expect(() => bus.on('report.escalated', () => {})).not.toThrow();
    expect(() => bus.on('report.escalate' as never, () => {})).toThrow(TypeError);
    expect(() => bus.on('legal.hold' as never, () => {})).toThrow(TypeError);
  });

  it('the event shape holds ids, a code and a time: no text field (a type-level check)', () => {
    expectTypeOf<KitEventOf<'report.escalated'>>().toEqualTypeOf<{ type: 'report.escalated'; reportId: string; at: number; code: HoldCode; target: StaffRef }>();
    expectTypeOf<keyof KitEventOf<'report.escalated'>>().toEqualTypeOf<'type' | 'reportId' | 'at' | 'code' | 'target'>();
  });

  it('is a different name from the desk\'s escalation: the legal event never reads as "ask a senior"', () => {
    expect(KIT_EVENT_TYPES).not.toContain('case.escalated');
    expect('report.escalated').not.toBe('case.escalated');
  });
});

describe('the hold codes are a closed list', () => {
  it('are exactly the five, in order, and isHoldCode agrees', () => {
    expect([...HOLD_CODES]).toEqual(['law_enforcement_request', 'legal_proceeding', 'platform_request', 'safety_review', 'other']);
    for (const c of HOLD_CODES) expect(isHoldCode(c)).toBe(true);
    for (const bad of ['', 'Other', 'free text', null, undefined, 3, {}, 'other ']) expect(isHoldCode(bad)).toBe(false);
  });
});
