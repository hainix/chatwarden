import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, AuditService, roomAuditRef } from '../src/audit.js';
import { EventBus, KIT_EVENT_TYPES } from '../src/events.js';
import type { InsightsDigest, KitEventOf } from '../src/events.js';
import { makeHasher } from '../src/hasher.js';
import { ROOM_MODES } from '../src/roomSettings.js';
import type { RoomMode } from '../src/roomSettings.js';
import { MemoryStore } from '@chatwarden/store-memory';

// The vocabulary the urgent lane, the desk and the rooms add: eight audit actions and one target type appended last, five events, and the
// room audit ref. Order locks are by set membership plus "mine are contiguous, in order, after the earlier ones".

const EIGHT = ['report.urgent', 'report.handoff', 'report.comment', 'report.comment_remove', 'report.escalate', 'room.mode', 'room.retract', 'insights.view'] as const;
const FIVE = ['report.handoff', 'case.escalated', 'room.mode', 'line.retracted', 'insights.digest'] as const;

const audit = () => {
  const store = new MemoryStore();
  return { store, audit: new AuditService({ store, clock: { now: () => 1 } }) };
};
const rec = (a: AuditService, action: string, target?: { type: string; ref: string }, extra: Record<string, unknown> = {}) =>
  a.record({ actor: 'mod_ann', role: 'moderator', action: action as never, ...(target === undefined ? {} : { target: target as never }), ...extra });

describe('the eight audit actions', () => {
  it('are appended in order, once each, after every earlier action, and the earlier ones are all still there', () => {
    for (const a of EIGHT) expect(AUDIT_ACTIONS.filter((x) => x === a).length, a).toBe(1);
    const at = AUDIT_ACTIONS.indexOf('report.urgent');
    expect(AUDIT_ACTIONS.slice(at, at + 8)).toEqual([...EIGHT]);
    for (const old of ['report.view', 'report.decide', 'report.dismiss_reporter', 'ai.undo_all', 'legal.bundle', 'policy.update']) {
      expect(AUDIT_ACTIONS).toContain(old);
      expect(AUDIT_ACTIONS.indexOf(old as never)).toBeLessThan(at);
    }
  });

  it('report.* actions need a report target; room.* a room target; insights.view none and takes none', () => {
    const { audit: a } = audit();
    for (const action of EIGHT.filter((x) => x.startsWith('report.'))) {
      expect(rec(a, action), `${action} without`).toBe(false);
      expect(rec(a, action, { type: 'room', ref: 'lobby' }), `${action} room`).toBe(false);
      expect(rec(a, action, { type: 'person', ref: 's_a' }), `${action} person`).toBe(false);
      expect(rec(a, action, { type: 'report', ref: 'r1' }), `${action} report`).toBe(true);
    }
    for (const action of ['room.mode', 'room.retract']) {
      expect(rec(a, action), `${action} without`).toBe(false);
      expect(rec(a, action, { type: 'report', ref: 'r1' }), `${action} report`).toBe(false);
      expect(rec(a, action, { type: 'room', ref: 'lobby' }), `${action} room`).toBe(true);
    }
    expect(rec(a, 'insights.view')).toBe(true);
    expect(rec(a, 'insights.view', { type: 'report', ref: 'r1' })).toBe(false);
    expect(rec(a, 'insights.view', { type: 'room', ref: 'lobby' })).toBe(false);
  });

  it('no detail is allowed on any of the eight', () => {
    const { audit: a } = audit();
    for (const action of EIGHT) {
      const target = action === 'insights.view' ? undefined : action.startsWith('room.') ? { type: 'room', ref: 'lobby' } : { type: 'report', ref: 'r1' };
      expect(rec(a, action, target, { detail: { sections: ['desk'], reason: 'why' } }), action).toBe(false);
      expect(rec(a, action, target, { detail: {} }), action).toBe(false);
    }
  });

  it('an existing action keeps its rules: report.view still takes any target type, report.dismiss_reporter still needs none', () => {
    const { audit: a } = audit();
    expect(rec(a, 'report.view')).toBe(true);
    expect(rec(a, 'report.dismiss_reporter')).toBe(true);
    expect(rec(a, 'report.decide', { type: 'person', ref: 's_a' })).toBe(true);
  });

  it('the rows are stored and read back with their action and target', () => {
    const { audit: a, store } = audit();
    rec(a, 'room.retract', { type: 'room', ref: 'lobby' });
    rec(a, 'insights.view');
    rec(a, 'report.comment_remove', { type: 'report', ref: 'r9' });
    const rows = a.list({ limit: 10 }).items;
    expect(rows.map((r) => r.action).sort()).toEqual(['insights.view', 'report.comment_remove', 'room.retract']);
    expect(rows.find((r) => r.action === 'room.retract')?.target).toEqual({ type: 'room', ref: 'lobby' });
    expect(store.listAudit({ limit: 10, action: 'room.retract' })).toHaveLength(1);
    expect(a.list({ limit: 10, action: 'room.mode' }).items).toEqual([]);
  });
});

describe('the room target type and its audit ref', () => {
  it('AUDIT_TARGET_TYPES ends with room, after the earlier types', () => {
    expect(AUDIT_TARGET_TYPES.at(-1)).toBe('room');
    expect(AUDIT_TARGET_TYPES.filter((t) => t === 'room').length).toBe(1);
    for (const t of ['report', 'sanction', 'person', 'term', 'exception', 'reason', 'appeal', 'release']) expect(AUDIT_TARGET_TYPES).toContain(t);
  });

  const hasher = makeHasher('room-audit-secret');
  const HASHED = /^h-[0-9a-f]{16}$/;

  it('a room id that fits the audit ref alphabet is kept as it is', () => {
    for (const id of ['lobby', 'room-7', 'eu.west:match_42', 'A'.repeat(64)]) expect(roomAuditRef(id, hasher), id).toBe(id);
  });

  it('a room id with a space, a slash, a non-ASCII letter, or 65 or 80 characters is recorded as an h- keyed hash', () => {
    for (const id of ['my room', 'a/b', 'caf\u{e9}', 'x'.repeat(65), 'x'.repeat(80), '', 'a\u{0}b', 'tab\there']) {
      expect(roomAuditRef(id, hasher), JSON.stringify(id)).toMatch(HASHED);
    }
  });

  it('the same id always maps to the same ref; different ids and different keys map apart', () => {
    expect(roomAuditRef('my room', hasher)).toBe(roomAuditRef('my room', hasher));
    expect(roomAuditRef('my room', hasher)).not.toBe(roomAuditRef('my  room', hasher));
    expect(roomAuditRef('my room', hasher)).not.toBe(roomAuditRef('my room', makeHasher('another-secret')));
  });

  it('an id that looks like a hashed ref is hashed itself, so a ref starting h- is always a hash', () => {
    const lookalike = 'h-0123456789abcdef';
    const ref = roomAuditRef(lookalike, hasher);
    expect(ref).toMatch(HASHED);
    expect(ref).not.toBe(lookalike);
    expect(roomAuditRef('h-lobby', hasher)).toBe('h-lobby');
  });

  it('the hash does not contain the id, and the result is accepted as an audit ref', () => {
    const { audit: a } = audit();
    const ref = roomAuditRef('quissel room/with slash', hasher);
    expect(ref).not.toContain('quissel');
    expect(rec(a, 'room.mode', { type: 'room', ref })).toBe(true);
    expect(rec(a, 'room.mode', { type: 'room', ref: 'quissel room/with slash' })).toBe(false);
  });
});

describe('the five new events', () => {
  it('KIT_EVENT_TYPES holds them, once each, appended after the earlier types; the earlier ones are all still there', () => {
    for (const t of FIVE) expect(KIT_EVENT_TYPES.filter((x) => x === t).length, t).toBe(1);
    const at = KIT_EVENT_TYPES.indexOf('report.handoff');
    expect(KIT_EVENT_TYPES.slice(at, at + 5)).toEqual([...FIVE]);
    for (const t of ['report.created', 'report.closed', 'sanction.applied', 'sanction.revoked', 'gap.created', 'auto.restricted', 'appeal.created', 'appeal.decided', 'rename.required', 'report.escalated']) {
      expect(KIT_EVENT_TYPES.indexOf(t as never), t).toBeGreaterThanOrEqual(0);
      expect(KIT_EVENT_TYPES.indexOf(t as never), t).toBeLessThan(at);
    }
  });

  it('case.escalated is not report.escalated: the legal hold keeps its own name', () => {
    expect(KIT_EVENT_TYPES).toContain('report.escalated');
    expect(KIT_EVENT_TYPES).toContain('case.escalated');
    expect(KIT_EVENT_TYPES).not.toContain('report.escalate');
  });

  it('cw.on accepts each, and an unknown type still throws', () => {
    const bus = new EventBus();
    for (const t of FIVE) expect(() => bus.on(t, () => {}), t).not.toThrow();
    expect(() => bus.on('room.modes' as never, () => {})).toThrow(TypeError);
    expect(() => bus.on('line.retract' as never, () => {})).toThrow(TypeError);
    expect(() => bus.on('case.escalate' as never, () => {})).toThrow(TypeError);
  });

  it('a listener hears them, and the event is frozen (the line ids list too)', () => {
    const bus = new EventBus();
    const heard: unknown[] = [];
    bus.on('line.retracted', (e) => void heard.push(e));
    bus.emit({ type: 'line.retracted', roomId: 'lobby', lineIds: ['l1', 'l2'], at: 5 });
    const e = heard[0] as KitEventOf<'line.retracted'>;
    expect(e.lineIds).toEqual(['l1', 'l2']);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.lineIds)).toBe(true);
  });

  it('report.created has urgent and a required reportedReason (type level)', () => {
    expectTypeOf<KitEventOf<'report.created'>['urgent']>().toEqualTypeOf<boolean>();
    expectTypeOf<KitEventOf<'report.created'>['reportedReason']>().toEqualTypeOf<string | null>();
  });

  it('the new event shapes hold no text, handle, note, reason, evidence ref or staff id (type level, key lists pinned)', () => {
    expectTypeOf<keyof KitEventOf<'report.created'>>().toEqualTypeOf<'type' | 'reportId' | 'createdAt' | 'category' | 'reportedReason' | 'urgent' | 'origin' | 'roomTags'>();
    expectTypeOf<keyof KitEventOf<'report.handoff'>>().toEqualTypeOf<'type' | 'reportId' | 'at'>();
    expectTypeOf<keyof KitEventOf<'case.escalated'>>().toEqualTypeOf<'type' | 'reportId' | 'to' | 'at'>();
    expectTypeOf<KitEventOf<'case.escalated'>['to']>().toEqualTypeOf<'senior' | 'owner'>();
    expectTypeOf<keyof KitEventOf<'room.mode'>>().toEqualTypeOf<'type' | 'roomId' | 'mode' | 'until' | 'expired' | 'at'>();
    expectTypeOf<KitEventOf<'room.mode'>['mode']>().toEqualTypeOf<RoomMode>();
    expectTypeOf<KitEventOf<'room.mode'>['until']>().toEqualTypeOf<number | null>();
    expectTypeOf<keyof KitEventOf<'line.retracted'>>().toEqualTypeOf<'type' | 'roomId' | 'lineIds' | 'at'>();
    expectTypeOf<keyof KitEventOf<'insights.digest'>>().toEqualTypeOf<'type' | 'at' | 'digest'>();
    // the digest is numbers and nulls: no key of it can hold a string
    expectTypeOf<InsightsDigest[keyof InsightsDigest]>().toEqualTypeOf<number | null>();
  });

  it('room modes are the three words', () => {
    expect([...ROOM_MODES]).toEqual(['normal', 'locked', 'emergency']);
  });
});
