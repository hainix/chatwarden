import { describe, expect, it } from 'vitest';
import { RoomModes } from '../src/roomModes.js';
import type { RoomModeChange } from '../src/roomModes.js';
import { HOUR, MIN, roomsWorld } from './roomsWorld.js';

// R1: a room's mode (normal, locked, emergency): per process, in memory, expiring, never a sanction. `setMode` validates, `mode` reads with the expiry applied, `close` clears.

const DEFAULT_MS = 30 * MIN;

describe('setMode', () => {
  it('locked and emergency with the default length and with forMs at 60 000 and 86 400 000', async () => {
    const w = await roomsWorld();
    const t = w.clock.t;
    expect(w.cw.rooms.setMode('R1', 'locked')).toEqual({ mode: 'locked', since: t, until: t + DEFAULT_MS });
    expect(w.cw.rooms.setMode('R2', 'emergency')).toEqual({ mode: 'emergency', since: t, until: t + DEFAULT_MS });
    expect(w.cw.rooms.setMode('R3', 'locked', { forMs: 60_000 }).until).toBe(t + 60_000);
    expect(w.cw.rooms.setMode('R4', 'emergency', { forMs: 86_400_000 }).until).toBe(t + 86_400_000);
    expect(w.cw.rooms.mode('R1')).toEqual({ mode: 'locked', since: t, until: t + DEFAULT_MS });
  });

  it('rooms.defaultModeMs sets the default length', async () => {
    const w = await roomsWorld({ overrides: { rooms: { defaultModeMs: 5 * MIN } } });
    expect(w.cw.rooms.setMode('R1', 'locked').until).toBe(w.clock.t + 5 * MIN);
  });

  it('59 999, 86 400 001, 2.5, NaN, Infinity, 0, a negative and a string throw RangeError and change nothing', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 10 * MIN });
    const before = w.cw.rooms.mode('R1');
    for (const bad of [59_999, 86_400_001, 2.5, NaN, Infinity, 0, -60_000, '60000', null, {}]) {
      expect(() => w.cw.rooms.setMode('R1', 'emergency', { forMs: bad as never }), String(bad)).toThrow(RangeError);
    }
    expect(w.cw.rooms.mode('R1')).toEqual(before);
    expect(w.events).toHaveLength(1);
  });

  it('an unknown mode throws and changes nothing; a bad room id throws', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked');
    for (const bad of ['lock', 'LOCKED', '', 'normalx', 5, null, undefined, '__proto__']) {
      expect(() => w.cw.rooms.setMode('R1', bad as never), String(bad)).toThrow(RangeError);
    }
    for (const bad of ['', 5, null, undefined]) expect(() => w.cw.rooms.setMode(bad as never, 'locked')).toThrow(TypeError);
    expect(w.cw.rooms.mode('R1').mode).toBe('locked');
  });

  it('normal clears at once and needs no length; a second call replaces the first whole and restarts the clock', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 10 * MIN });
    w.clock.t += 5 * MIN;
    const second = w.cw.rooms.setMode('R1', 'emergency', { forMs: 20 * MIN });
    expect(second).toEqual({ mode: 'emergency', since: w.clock.t, until: w.clock.t + 20 * MIN });
    expect(w.cw.rooms.setMode('R1', 'normal')).toEqual({ mode: 'normal', since: null, until: null });
    expect(w.cw.rooms.mode('R1')).toEqual({ mode: 'normal', since: null, until: null });
  });

  it('modes are per room', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked');
    expect(w.cw.rooms.mode('R2').mode).toBe('normal');
  });

  it('what mode returns is a copy: changing it changes nothing', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked');
    const got = w.cw.rooms.mode('R1') as { mode: string };
    got.mode = 'normal';
    expect(w.cw.rooms.mode('R1').mode).toBe('locked');
  });
});

describe('expiry', () => {
  it('a mode at until reads as normal, one millisecond before it is still on', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 60_000 });
    w.clock.t += 59_999;
    expect(w.cw.rooms.mode('R1').mode).toBe('locked');
    w.clock.t += 1;
    expect(w.cw.rooms.mode('R1')).toEqual({ mode: 'normal', since: null, until: null });
  });

  it('the expiry raises room.mode once with expired true, however often it is read after', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'emergency', { forMs: 60_000 });
    w.clock.t += 61_000;
    w.cw.rooms.mode('R1');
    w.cw.rooms.mode('R1');
    w.cw.rooms.pace('R1');
    expect(w.events).toHaveLength(2);
    expect(w.events[1]).toEqual({ type: 'room.mode', roomId: 'R1', mode: 'normal', until: null, expired: true, at: w.clock.t });
  });

  it('a clock that steps back after the expiry was noticed does not bring the mode back', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 60_000 });
    w.clock.t += 61_000;
    expect(w.cw.rooms.mode('R1').mode).toBe('normal');
    w.clock.t -= 30_000;
    expect(w.cw.rooms.mode('R1').mode).toBe('normal');
  });

  it('setting a mode again after it expired starts fresh', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 60_000 });
    w.clock.t += HOUR;
    expect(w.cw.rooms.setMode('R1', 'locked', { forMs: 60_000 })).toMatchObject({ mode: 'locked', until: w.clock.t + 60_000 });
  });
});

describe('close, restart and concurrency', () => {
  it('rooms.close clears the mode and the pace override', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked');
    w.cw.rooms.setPace('R1', { slowModeMs: 5000 });
    w.cw.rooms.close('R1');
    expect(w.cw.rooms.mode('R1').mode).toBe('normal');
    expect(w.cw.rooms.pace('R1').slowModeMs).toBeNull();
  });

  it('a restart is a fresh map', async () => {
    const a = await roomsWorld();
    a.cw.rooms.setMode('R1', 'locked');
    const b = await roomsWorld();
    expect(b.cw.rooms.mode('R1').mode).toBe('normal');
  });

  it('two setMode calls at once leave the later one and raise two events', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked');
    w.cw.rooms.setMode('R1', 'emergency');
    expect(w.cw.rooms.mode('R1').mode).toBe('emergency');
    expect(w.events.map((e) => e.type === 'room.mode' && e.mode)).toEqual(['locked', 'emergency']);
  });

  it('a listener that throws does not stop setMode or change the state', async () => {
    const w = await roomsWorld();
    w.cw.on('room.mode', () => {
      throw new Error('listener down');
    });
    expect(() => w.cw.rooms.setMode('R1', 'locked')).not.toThrow();
    expect(w.cw.rooms.mode('R1').mode).toBe('locked');
  });
});

describe('the room.mode event', () => {
  it('holds the room id, mode, until and a time; expired only on an expiry; nothing else', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 120_000 });
    w.cw.rooms.setMode('R1', 'normal');
    expect(w.events).toEqual([
      { type: 'room.mode', roomId: 'R1', mode: 'locked', until: w.clock.t + 120_000, at: w.clock.t },
      { type: 'room.mode', roomId: 'R1', mode: 'normal', until: null, at: w.clock.t },
    ]);
  });

  it('setting normal on a room that is already normal changes nothing and raises nothing', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'normal');
    expect(w.events).toEqual([]);
  });

  it('a mode change writes no sanction, strike, notice or audit row', async () => {
    const w = await roomsWorld();
    const before = JSON.stringify([w.store.loadStrikes(0), w.cw.audit.list({ limit: 50 }).items]);
    w.cw.rooms.setMode('R1', 'emergency');
    w.cw.rooms.setMode('R1', 'normal');
    expect(JSON.stringify([w.store.loadStrikes(0), w.cw.audit.list({ limit: 50 }).items])).toBe(before);
  });
});

describe('the emergency pace', () => {
  it('rooms.pace takes the stricter of the room pace and the emergency slow mode, only while the mode is emergency', async () => {
    const w = await roomsWorld();
    expect(w.cw.rooms.pace('R1').slowModeMs).toBeNull();
    w.cw.rooms.setMode('R1', 'emergency', { forMs: 10 * MIN });
    expect(w.cw.rooms.pace('R1').slowModeMs).toBe(30_000);
    w.cw.rooms.setPace('R1', { slowModeMs: 60_000 });
    expect(w.cw.rooms.pace('R1').slowModeMs).toBe(60_000);
    w.cw.rooms.setPace('R1', { slowModeMs: 5000 });
    expect(w.cw.rooms.pace('R1').slowModeMs).toBe(30_000);
    w.cw.rooms.setMode('R1', 'locked');
    expect(w.cw.rooms.pace('R1').slowModeMs).toBe(5000);
    w.cw.rooms.setMode('R1', 'emergency', { forMs: 60_000 });
    w.clock.t += 61_000;
    expect(w.cw.rooms.pace('R1').slowModeMs).toBe(5000);
  });

  it('emergency.slowModeMs from the profile is the length used; other pace fields are untouched', async () => {
    const w = await roomsWorld({ overrides: { rooms: { emergency: { slowModeMs: 12_000 } }, pace: { burst: { lines: 4, windowMs: 8000 } } } });
    w.cw.rooms.setMode('R1', 'emergency');
    expect(w.cw.rooms.pace('R1')).toEqual({ slowModeMs: 12_000, burst: { lines: 4, windowMs: 8000 }, duplicateWindowMs: null });
  });
});

describe('pruning on write (a mode set for a room nobody reads is not kept for ever)', () => {
  const make = () => {
    const clock = { t: 1_800_000_000_000, now: () => clock.t };
    const changes: RoomModeChange[] = [];
    const modes = new RoomModes({ clock, defaultModeMs: () => 30 * MIN, changed: (c) => void changes.push(c) });
    return { clock, changes, modes };
  };
  const expired = (changes: RoomModeChange[]) => changes.filter((c) => c.expired === true).map((c) => c.roomId).sort();

  it('a set sweeps every room whose mode has ended, announcing each expiry once, without any read or list', () => {
    const { clock, changes, modes } = make();
    for (let i = 0; i < 5; i += 1) modes.set(`gone-${i}`, 'locked', { forMs: 60_000 });
    modes.set('stays', 'locked', { forMs: 3 * HOUR });
    clock.t += HOUR;
    changes.length = 0;
    modes.set('new', 'emergency');
    expect(expired(changes)).toEqual(['gone-0', 'gone-1', 'gone-2', 'gone-3', 'gone-4']);
    // the new mode and the survivor are untouched
    expect(modes.get('new').mode).toBe('emergency');
    expect(modes.get('stays').mode).toBe('locked');
    // nothing is announced twice
    changes.length = 0;
    modes.active();
    expect(expired(changes)).toEqual([]);
  });

  it('a set of normal sweeps too, and a mode that has not ended is kept (one millisecond before until)', () => {
    const { clock, changes, modes } = make();
    modes.set('edge', 'locked', { forMs: 60_000 });
    modes.set('old', 'locked', { forMs: 60_000 });
    clock.t += 59_999;
    changes.length = 0;
    modes.set('anything', 'normal');
    expect(expired(changes)).toEqual([]);
    clock.t += 1;
    modes.set('anything', 'normal');
    expect(expired(changes)).toEqual(['edge', 'old']);
  });

  it('thousands of rooms posted by a moderator are gone after they end, by the next write', () => {
    const { clock, changes, modes } = make();
    for (let i = 0; i < 3000; i += 1) modes.set(`spam-${i}`, 'locked', { forMs: 60_000 });
    clock.t += 2 * MIN;
    changes.length = 0;
    modes.set('real', 'locked');
    expect(expired(changes)).toHaveLength(3000);
    expect(modes.active().map((a) => a.roomId)).toEqual(['real']);
  });

  it('a refused write (bad length) sweeps nothing and changes nothing', () => {
    const { clock, changes, modes } = make();
    modes.set('a', 'locked', { forMs: 60_000 });
    clock.t += HOUR;
    changes.length = 0;
    expect(() => modes.set('b', 'locked', { forMs: 5 })).toThrow(RangeError);
    expect(changes).toEqual([]);
  });
});
