import { MemoryStore, withMemoryAi, withMemoryAppeals } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { createFakeModerationAI } from '../../src/ai/fake.js';
import type { Store } from '../../src/types.js';
import { world as plainWorld } from '../reportingWorld.js';
import { aiWorld, DAY, OWNER } from './aiWorld.js';

// cw.ai.acting (design 3 and 6.3): the owner's switch over the kit. The pure transitions are tested in acting.test.ts; here the facts come from a real kit: the hub's level,
// the code's options, the appeals setting, the injected clock and the store.

const appealsOn = { overrides: { ai: { level: 2 as const }, appeals: { enabled: true } } as never };
const mem = () => withMemoryAppeals(withMemoryAi(new MemoryStore()));
const ready = (extra: Parameters<typeof aiWorld>[0] = {}) => aiWorld({ level: 2, ai: { maxLevel: 3, act: {} }, over: appealsOn, store: mem(), ...extra });
const OWN = { confirm: 'ACT', reason: 'we are ready' };

describe('the acting switch: off to shadow', () => {
  it('moves from off to shadow with level 2, maxLevel 3, an adapter, enabled appeals, the word ACT and a reason; the state says so', async () => {
    const w = await ready();
    expect(w.cw.ai.acting.state()).toEqual({ mode: 'off', paused: false, modeSince: null, shadowDaysDone: 0, shadowWouldHaveActed: 0, maxLevel: 3 });
    const res = w.cw.ai.acting.startShadow('owner_ann', OWN);
    expect(res).toEqual({ ok: true, state: { mode: 'shadow', paused: false, modeSince: w.clock.t, shadowDaysDone: 0, shadowWouldHaveActed: 0, maxLevel: 3 } });
    expect(w.cw.ai.acting.state().mode).toBe('shadow');
    expect(w.cw.ai.effectiveLevel()).toBe(3);
    expect(w.cw.ai.level()).toBe(2);
  });

  it('refuses a hub level below 2 (not_allowed), each of 0 and 1', async () => {
    for (const level of [0, 1] as const) {
      const w = await ready({ level, over: { overrides: { ai: { level }, appeals: { enabled: true } } as never } });
      expect(w.cw.ai.acting.startShadow('owner_ann', OWN), String(level)).toEqual({ ok: false, error: 'not_allowed' });
      expect(w.cw.ai.acting.state().mode).toBe('off');
    }
  });

  it('refuses maxLevel 2 as unsupported (acting needs a code that allows it)', async () => {
    const w = await aiWorld({ level: 2, ai: { maxLevel: 2 }, over: appealsOn, store: mem() });
    expect(w.cw.ai.acting.startShadow('owner_ann', OWN)).toEqual({ ok: false, error: 'unsupported' });
    expect(w.cw.ai.acting.state()).toMatchObject({ mode: 'off', maxLevel: 2 });
    expect(w.cw.ai.effectiveLevel()).toBe(2);
  });

  it('refuses with no AI at all (no adapter) as unsupported, and every step is refused', async () => {
    const w = await plainWorld();
    const a = w.cw.ai.acting;
    for (const r of [a.startShadow('o', OWN), a.startActing('o', OWN), a.pause('s', { reason: 'x' }), a.resume('o', { reason: 'x' }), a.off('o', { reason: 'x' })]) {
      expect(r).toEqual({ ok: false, error: 'unsupported' });
    }
    expect(a.state()).toMatchObject({ mode: 'off', paused: false });
    expect(w.cw.ai.effectiveLevel()).toBe(0);
  });

  it('refuses disabled or absent appeals as no_appeals, and starts once the owner enables them', async () => {
    const w = await aiWorld({ level: 2, ai: { maxLevel: 3, act: {} }, store: mem() });
    expect(w.cw.ai.acting.startShadow('owner_ann', OWN)).toEqual({ ok: false, error: 'no_appeals' });
    const off = await aiWorld({ level: 2, ai: { maxLevel: 3, act: {} }, over: { overrides: { ai: { level: 2 }, appeals: { enabled: false } } as never }, store: mem() });
    expect(off.cw.ai.acting.startShadow('owner_ann', OWN)).toEqual({ ok: false, error: 'no_appeals' });
    expect(w.cw.policy.save({ ai: { level: 2 }, appeals: { enabled: true } } as never, { version: 0, ...OWNER }).ok).toBe(true);
    expect(w.cw.ai.acting.startShadow('owner_ann', OWN)).toMatchObject({ ok: true });
  });

  it('refuses any word but ACT, a missing reason and a bad actor as invalid, and writes nothing', async () => {
    const w = await ready();
    for (const confirm of ['act', 'Act', 'ACT ', '', undefined]) {
      expect(w.cw.ai.acting.startShadow('owner_ann', { confirm, reason: 'x' } as never), String(confirm)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(w.cw.ai.acting.startShadow('owner_ann', { confirm: 'ACT', reason: '  ' })).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.ai.acting.startShadow('two words', OWN)).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.ai.acting.state().mode).toBe('off');
  });

  it('a second startShadow is wrong_state and keeps the first time and the first owner', async () => {
    const w = await ready();
    expect(w.cw.ai.acting.startShadow('owner_ann', OWN)).toMatchObject({ ok: true });
    const at = w.cw.ai.acting.state().modeSince;
    w.clock.t += 1000;
    expect(w.cw.ai.acting.startShadow('owner_bob', OWN)).toEqual({ ok: false, error: 'wrong_state' });
    expect(w.cw.ai.acting.state().modeSince).toBe(at);
  });
});

describe('the acting switch: shadow to on', () => {
  it('needs shadowDays elapsed on the injected clock: 13 days refuses as too_early, 14 allows', async () => {
    const w = await ready();
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    w.clock.t += 13 * DAY;
    expect(w.cw.ai.acting.state().shadowDaysDone).toBe(13);
    expect(w.cw.ai.acting.startActing('owner_ann', OWN)).toEqual({ ok: false, error: 'too_early' });
    w.clock.t += DAY - 1;
    expect(w.cw.ai.acting.startActing('owner_ann', OWN)).toEqual({ ok: false, error: 'too_early' });
    w.clock.t += 1;
    expect(w.cw.ai.acting.state().shadowDaysDone).toBe(14);
    expect(w.cw.ai.acting.startActing('owner_ann', OWN)).toMatchObject({ ok: true, state: { mode: 'on' } });
    expect(w.cw.ai.effectiveLevel()).toBe(3);
  });

  it('follows ai.act.caps.shadowDays (7 allows at 7 days, not at 6)', async () => {
    const w = await ready({ ai: { maxLevel: 3, act: { caps: { shadowDays: 7 } } } });
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    w.clock.t += 6 * DAY;
    expect(w.cw.ai.acting.startActing('owner_ann', OWN)).toEqual({ ok: false, error: 'too_early' });
    w.clock.t += DAY;
    expect(w.cw.ai.acting.startActing('owner_ann', OWN)).toMatchObject({ ok: true });
  });

  it('needs the word ACT; from off it is wrong_state', async () => {
    const w = await ready();
    expect(w.cw.ai.acting.startActing('owner_ann', OWN)).toEqual({ ok: false, error: 'wrong_state' });
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    w.clock.t += 14 * DAY;
    expect(w.cw.ai.acting.startActing('owner_ann', { confirm: 'act', reason: 'x' })).toEqual({ ok: false, error: 'invalid' });
  });

  it('on to shadow, on to off and shadow to off are allowed by the owner; each leaves the next step where it belongs', async () => {
    const w = await ready();
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    expect(w.cw.ai.acting.off('owner_ann', { reason: 'not yet' })).toMatchObject({ ok: true, state: { mode: 'off' } });
    expect(w.cw.ai.effectiveLevel()).toBe(2);
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    w.clock.t += 14 * DAY;
    w.cw.ai.acting.startActing('owner_ann', OWN);
    expect(w.cw.ai.acting.startShadow('owner_ann', { reason: 'back to shadow' })).toMatchObject({ ok: true, state: { mode: 'shadow', shadowDaysDone: 0 } });
    w.clock.t += 14 * DAY;
    w.cw.ai.acting.startActing('owner_ann', OWN);
    expect(w.cw.ai.acting.off('owner_ann', { reason: 'incident' })).toMatchObject({ ok: true, state: { mode: 'off', paused: false } });
    expect(w.cw.ai.acting.off('owner_ann', { reason: 'again' })).toEqual({ ok: false, error: 'wrong_state' });
  });
});

describe('the acting switch: pause and resume', () => {
  it('pause takes effect at once and is read fresh: the state says paused before anything else runs, and resume clears it', async () => {
    const w = await ready();
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    expect(w.cw.ai.acting.pause('sen_bo', { reason: 'looks odd' })).toMatchObject({ ok: true, state: { mode: 'shadow', paused: true } });
    expect(w.cw.ai.acting.state().paused).toBe(true);
    expect(w.cw.ai.acting.pause('sen_bo', { reason: 'again' })).toEqual({ ok: false, error: 'wrong_state' });
    expect(w.cw.ai.acting.resume('owner_ann', { reason: 'fine' })).toMatchObject({ ok: true, state: { paused: false } });
    expect(w.cw.ai.acting.resume('owner_ann', { reason: 'again' })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('pause with acting off is wrong_state and a reason is needed', async () => {
    const w = await ready();
    expect(w.cw.ai.acting.pause('sen_bo', { reason: 'x' })).toEqual({ ok: false, error: 'wrong_state' });
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    expect(w.cw.ai.acting.pause('sen_bo', { reason: '' })).toEqual({ ok: false, error: 'invalid' });
  });

  it('the state carries no staff ref, only numbers, words and booleans', async () => {
    const w = await ready();
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    w.cw.ai.acting.pause('sen_bo', { reason: 'x' });
    const text = JSON.stringify(w.cw.ai.acting.state());
    expect(text).not.toContain('owner_ann');
    expect(text).not.toContain('sen_bo');
    expect(Object.keys(w.cw.ai.acting.state()).sort()).toEqual(['maxLevel', 'mode', 'modeSince', 'paused', 'shadowDaysDone', 'shadowWouldHaveActed']);
  });
});

describe('two processes', () => {
  type Row = ReturnType<NonNullable<Store['aiActingState']>>;
  /** A store that shows a kit the state as it was before another kit moved it (it read an older state a moment ago), and passes every write through. */
  const stale = (inner: Store, patch: (now: Row) => Row): Store =>
    new Proxy(inner, {
      get: (t, k, r) => (k === 'aiActingState' ? () => patch((t.aiActingState as NonNullable<Store['aiActingState']>).call(t)) : (Reflect.get(t, k, r) as unknown)),
    });
  const staleOff = (inner: Store): Store => stale(inner, () => ({ mode: 'off', modeSince: null, modeBy: null, paused: false, pausedSince: null, pausedBy: null }));

  it('a second start while the first is in flight changes nothing and answers wrong_state', async () => {
    const store = mem();
    const a = await ready({ store });
    const b = await ready({ store: staleOff(store) });
    expect(a.cw.ai.acting.startShadow('owner_ann', OWN)).toMatchObject({ ok: true });
    const first = store.aiActingState();
    expect(b.cw.ai.acting.startShadow('owner_bob', OWN)).toEqual({ ok: false, error: 'wrong_state' });
    expect(store.aiActingState()).toEqual(first);
    expect(first.modeBy).toBe('owner_ann');
  });

  it('a pause racing a pause: only the one that matches the stored state moves it', async () => {
    const store = mem();
    const a = await ready({ store });
    a.cw.ai.acting.startShadow('owner_ann', OWN);
    a.cw.ai.acting.pause('sen_bo', { reason: 'x' });
    const late = await ready({ store: stale(store, (s) => ({ ...s, paused: false, pausedSince: null, pausedBy: null })) });
    expect(late.cw.ai.acting.pause('sen_cy', { reason: 'me too' })).toEqual({ ok: false, error: 'wrong_state' });
    expect(store.aiActingState().pausedBy).toBe('sen_bo');
  });
});

describe('the code-side options', () => {
  const adapter = createFakeModerationAI([]);
  const make = (ai: Record<string, unknown>) => aiWorld({ level: 2, ai: ai as never });

  it('maxLevel 3 without act throws at createChatwarden, with act it does not', async () => {
    await expect(make({ maxLevel: 3 })).rejects.toThrow(/ai\.act/);
    await expect(make({ maxLevel: 3, act: {} })).resolves.toBeDefined();
  });

  it('maxLevel 4 without watch throws; without act too; with both it is accepted (and reaches no further than 3 in this release)', async () => {
    await expect(make({ maxLevel: 4, act: {} })).rejects.toThrow(/watch/);
    await expect(make({ maxLevel: 4, watch: { disclosed: true } })).rejects.toThrow(/ai\.act/);
    await expect(make({ maxLevel: 4, act: {}, watch: { disclosed: false } })).rejects.toThrow(/watch/);
    const w = await make({ maxLevel: 4, act: {}, watch: { disclosed: true } });
    expect(w.cw.ai.status().maxLevel).toBe(4);
    expect(w.cw.ai.effectiveLevel()).toBe(2);
  });

  it('maxLevel outside 1 to 4 throws', async () => {
    for (const maxLevel of [0, 5, 2.5, '3', -1]) await expect(make({ maxLevel }), String(maxLevel)).rejects.toThrow(/maxLevel/);
  });

  it('a bad act option throws and names the field, never the value', async () => {
    await expect(make({ maxLevel: 3, act: 'yes' })).rejects.toThrow(/ai\.act must be an object/);
    await expect(make({ maxLevel: 3, act: { enabled: 'no' } })).rejects.toThrow(/ai\.act\.enabled/);
    await expect(make({ maxLevel: 3, act: { confirmAdapter: {} } })).rejects.toThrow(/confirmAdapter/);
    await expect(make({ maxLevel: 3, act: { unknown: 1 } })).rejects.toThrow(/ai\.act\.unknown/);
    await expect(make({ maxLevel: 3, act: { gates: { agreementLower: 0.5 } } })).rejects.toThrow(/agreementLower/);
    await expect(make({ maxLevel: 3, act: { caps: { holdbackShare: 0.9 } } })).rejects.toThrow(/holdbackShare/);
    const err = await make({ maxLevel: 3, act: { caps: { perHour: 9999 } } }).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain('9999');
  });

  it('accepts gates and caps at their band edges and a second adapter for the confirming read', async () => {
    const w = await make({ maxLevel: 3, act: { confirmAdapter: adapter, gates: { volume: 50, agreementLower: 0.99 }, caps: { perHour: 60, holdbackShare: 0.5, holdMs: 300_000, shadowDays: 60 } } });
    expect(w.cw.ai.gates().windowDays).toBe(90);
  });

  it('act.enabled false pins the state to off whatever the store says, and every step is unsupported', async () => {
    const store = mem();
    const on = await ready({ store });
    on.cw.ai.acting.startShadow('owner_ann', OWN);
    expect(store.aiActingState().mode).toBe('shadow');
    const pinned = await aiWorld({ level: 2, store, ai: { maxLevel: 3, act: { enabled: false } }, over: appealsOn });
    expect(pinned.cw.ai.acting.state()).toMatchObject({ mode: 'off', paused: false, modeSince: null });
    expect(pinned.cw.ai.effectiveLevel()).toBe(2);
    const a = pinned.cw.ai.acting;
    for (const r of [a.startShadow('o', OWN), a.startActing('o', OWN), a.pause('s', { reason: 'x' }), a.resume('o', { reason: 'x' }), a.off('o', { reason: 'x' })]) {
      expect(r).toEqual({ ok: false, error: 'unsupported' });
    }
    // a pinned kit has nothing to start or lower; the stored row is not touched
    expect(store.aiActingState().mode).toBe('shadow');
  });

  it('a store without the acting methods leaves acting unsupported and the AI working', async () => {
    const base = mem();
    const bare = new Proxy(base, { get: (t, k, r) => (k === 'aiActingState' || k === 'setAiActingState' ? undefined : (Reflect.get(t, k, r) as unknown)) });
    const w = await ready({ store: bare as unknown as Store });
    expect(w.cw.ai.acting.startShadow('owner_ann', OWN)).toEqual({ ok: false, error: 'unsupported' });
    expect(w.cw.ai.acting.state().mode).toBe('off');
    expect(w.cw.ai.status().available).toBe(true);
  });
});

describe('effectiveLevel and level', () => {
  it('level() stays 0 to 2 and effectiveLevel() is 0 to 4 for display: 3 only with level 2, maxLevel 3 or more and acting shadow or on', async () => {
    for (const level of [0, 1] as const) {
      const w = await ready({ level, over: { overrides: { ai: { level }, appeals: { enabled: true } } as never } });
      expect([w.cw.ai.level(), w.cw.ai.effectiveLevel()]).toEqual([level, level]);
    }
    const w = await ready();
    expect([w.cw.ai.level(), w.cw.ai.effectiveLevel()]).toEqual([2, 2]);
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    expect([w.cw.ai.level(), w.cw.ai.effectiveLevel()]).toEqual([2, 3]);
    // pausing is not lowering what the hub shows
    w.cw.ai.acting.pause('sen_bo', { reason: 'x' });
    expect(w.cw.ai.effectiveLevel()).toBe(3);
    w.cw.ai.acting.off('owner_ann', { reason: 'x' });
    expect([w.cw.ai.level(), w.cw.ai.effectiveLevel()]).toEqual([2, 2]);
  });

  it('lowering the hub level below 2 drops the effective level with it, and the stored state stays', async () => {
    const w = await ready();
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    expect(w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(w.cw.ai.effectiveLevel()).toBe(1);
    expect(w.cw.ai.acting.state().mode).toBe('shadow');
  });

  it('a save of the generic policy layer cannot change the acting state', async () => {
    const w = await ready();
    w.cw.ai.acting.startShadow('owner_ann', OWN);
    const before = w.cw.ai.acting.state();
    expect(w.cw.policy.save({ ai: { level: 2, learn: false } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(w.cw.policy.save({ ai: { mode: 'on' } } as never, { version: 1, ...OWNER })).toMatchObject({ ok: false, error: 'invalid' });
    expect(w.cw.ai.acting.state()).toEqual(before);
  });
});
