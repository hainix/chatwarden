import { MemoryStore } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { StoreCapabilityError, hasUrgentMethods, missingUrgentMethods } from '../src/index.js';
import { world } from './reportingWorld.js';

// A custom store written before the urgent lane has none of its optional methods. The kit says so once at creation (the missing methods, by name), and a call that needs a missing method
// fails with a named error that is not a TypeError, so the log line and the HTTP answer can tell it from a bug.

const METHODS = ['setReportUrgent', 'setHandoff', 'countOpenUrgent'] as const;

/** A store that has every first-party method except the ones named. */
function storeLacking(...lacking: Array<(typeof METHODS)[number]>): MemoryStore {
  class Old extends MemoryStore {
    constructor() {
      super();
      for (const m of lacking) {
        // @ts-expect-error: a custom store written before the urgent lane has none of its methods
        this[m] = undefined;
      }
    }
  }
  return new Old();
}

const ACTOR = 'mod_ann';

describe('StoreCapabilityError', () => {
  it('is an Error with its own name, never a TypeError, and names what is missing', () => {
    const e = new StoreCapabilityError('cases.setUrgent', ['setReportUrgent']);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(TypeError);
    expect(e.name).toBe('StoreCapabilityError');
    expect(e.missing).toEqual(['setReportUrgent']);
    expect(e.message).toContain('cases.setUrgent');
    expect(e.message).toContain('setReportUrgent');
  });

  it('names every missing method in the message', () => {
    const e = new StoreCapabilityError('x', ['setHandoff', 'countOpenUrgent']);
    expect(e.message).toContain('setHandoff');
    expect(e.message).toContain('countOpenUrgent');
  });
});

describe('hasUrgentMethods / missingUrgentMethods', () => {
  it('a full store has all three; each missing one is named', () => {
    expect(hasUrgentMethods(new MemoryStore())).toBe(true);
    expect(missingUrgentMethods(new MemoryStore())).toEqual([]);
    for (const m of METHODS) {
      const s = storeLacking(m);
      expect(hasUrgentMethods(s), m).toBe(false);
      expect(missingUrgentMethods(s), m).toEqual([m]);
    }
    expect(missingUrgentMethods(storeLacking(...METHODS))).toEqual([...METHODS]);
  });
});

describe('createChatwarden over a store without the urgent methods', () => {
  it('warns once, naming each missing method and nothing about a person', async () => {
    for (const m of METHODS) {
      const w = await world({}, storeLacking(m));
      const lines = w.logged.filter(([event]) => event === 'chatwarden.store_no_urgent_lane');
      expect(lines, m).toHaveLength(1);
      expect(lines[0]![1], m).toEqual({ missing: m });
    }
    const all = await world({}, storeLacking(...METHODS));
    expect(all.logged.filter(([event]) => event === 'chatwarden.store_no_urgent_lane')).toEqual([['chatwarden.store_no_urgent_lane', { missing: 'setReportUrgent,setHandoff,countOpenUrgent' }]]);
  });

  it('control: a full store says nothing', async () => {
    const w = await world();
    expect(w.logged.filter(([event]) => event === 'chatwarden.store_no_urgent_lane')).toEqual([]);
  });
});

describe('cases.setUrgent and cases.handoff over a store without the methods', () => {
  it('setUrgent without setReportUrgent throws a named error that names the method', async () => {
    const w = await world({}, storeLacking('setReportUrgent'));
    const f = await w.file({ reason: 'harassment' });
    let caught: unknown;
    try {
      w.cw.cases.setUrgent(f.id, ACTOR, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StoreCapabilityError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as StoreCapabilityError).missing).toEqual(['setReportUrgent']);
    expect((caught as Error).message).toContain('setReportUrgent');
  });

  it('handoff without setHandoff throws a named error that names the method', async () => {
    const w = await world({}, storeLacking('setHandoff'));
    const f = await w.file({ reason: 'harassment' });
    let caught: unknown;
    try {
      w.cw.cases.handoff(f.id, ACTOR);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StoreCapabilityError);
    expect((caught as StoreCapabilityError).missing).toEqual(['setHandoff']);
    expect((caught as Error).message).toContain('setHandoff');
  });

  it('a store lacking only countOpenUrgent still marks and hands off, and counts 0 urgent', async () => {
    const w = await world({}, storeLacking('countOpenUrgent'));
    const f = await w.file({ reason: 'harassment' });
    expect(w.cw.cases.setUrgent(f.id, ACTOR, true)).toEqual({ ok: true });
    expect(w.cw.cases.handoff(f.id, ACTOR)).toEqual({ ok: true });
    expect(w.cw.cases.urgentCount()).toBe(0);
  });

  it('a store lacking only setHandoff still marks urgent (each call names only what it needs)', async () => {
    const w = await world({}, storeLacking('setHandoff'));
    const f = await w.file({ reason: 'harassment' });
    expect(w.cw.cases.setUrgent(f.id, ACTOR, true)).toEqual({ ok: true });
  });

  it('a bad argument is still a RangeError, not a capability error (the argument is checked first)', async () => {
    const w = await world({}, storeLacking(...METHODS));
    expect(() => w.cw.cases.setUrgent('x', 'not a staff ref!!', true)).toThrow(RangeError);
    expect(() => w.cw.cases.handoff('x', 'not a staff ref!!')).toThrow(RangeError);
  });

  it('control: a full store marks, counts and hands off', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    expect(w.cw.cases.setUrgent(f.id, ACTOR, true)).toEqual({ ok: true });
    expect(w.cw.cases.urgentCount()).toBe(1);
    expect(w.cw.cases.handoff(f.id, ACTOR)).toEqual({ ok: true });
  });
});
