import { ROOM_MODES } from './roomSettings.js';
import type { RoomMode } from './roomSettings.js';
import type { Clock } from './types.js';

// A room's mode (0.2.0): normal, locked (read-only except staff) or emergency (slower, new accounts read-only). Per process and in memory, like pace: a game with several processes sets it in
// each. Every mode that is not normal expires, so a forgotten lock cannot outlive the attack; the expiry is applied lazily on every read (the chat path reads it on each line), against the
// injected clock, and is announced once. A mode is never a sanction: it writes no strike, notice, audit row or record.

/** The shortest and the longest a lock or an emergency may be set for, in ms. */
export const MODE_MIN_MS = 60_000;
export const MODE_MAX_MS = 86_400_000;

/**
 * A room's mode as it reads now: `since` and `until` (epoch ms) are the time it was set and the time it ends, both `null` for `normal`.
 * @experimental
 */
export interface RoomModeState {
  mode: RoomMode;
  since: number | null;
  until: number | null;
}

/** What `RoomModes` announces when a mode changes or runs out. */
export interface RoomModeChange {
  roomId: string;
  mode: RoomMode;
  until: number | null;
  /** Set when the mode ended by itself, noticed on a read. */
  expired?: true;
  at: number;
}

export interface RoomModesDeps {
  clock: Clock;
  /** `rooms.defaultModeMs`, read on every `set` so a saved change applies at once. */
  defaultModeMs: () => number;
  /** Told after every change and every expiry. May throw: that is the caller's fence, not this class's. */
  changed: (change: RoomModeChange) => void;
}

interface Entry {
  mode: 'locked' | 'emergency';
  since: number;
  until: number;
}

const normal = (): RoomModeState => ({ mode: 'normal', since: null, until: null });

export class RoomModes {
  private readonly clock: Clock;
  private readonly defaultModeMs: () => number;
  private readonly changed: (change: RoomModeChange) => void;
  private readonly rooms = new Map<string, Entry>();

  constructor(deps: RoomModesDeps) {
    this.clock = deps.clock;
    this.defaultModeMs = deps.defaultModeMs;
    this.changed = deps.changed;
  }

  /**
   * Set a room's mode for `forMs` (60 000 to 86 400 000, whole milliseconds; default `rooms.defaultModeMs`). `normal` clears at once and needs no length. A second call replaces the first
   * whole and restarts the clock. `TypeError` for a room id that is not a non-empty string, `RangeError` for an unknown mode or a bad length; either changes nothing.
   */
  set(roomId: string, mode: RoomMode, opts?: { forMs?: number }): RoomModeState {
    if (typeof roomId !== 'string' || roomId === '') throw new TypeError('rooms.setMode: roomId must be a non-empty string');
    if (typeof mode !== 'string' || !(ROOM_MODES as readonly string[]).includes(mode)) throw new RangeError('rooms.setMode: mode must be normal, locked or emergency');
    const now = this.clock.now();
    // A mode set for a room id nobody reads again would stay until a `get` or `active` found it. Every write sweeps the ones that have ended, so the map holds only modes still running.
    // Validation of the length comes first: a refused write changes nothing, a sweep included.
    const asked: unknown = opts === undefined || opts === null ? undefined : opts.forMs;
    if (mode !== 'normal' && asked !== undefined && !(typeof asked === 'number' && Number.isInteger(asked) && asked >= MODE_MIN_MS && asked <= MODE_MAX_MS)) {
      throw new RangeError('rooms.setMode: forMs must be a whole number of milliseconds from 60000 to 86400000');
    }
    this.sweep(now);
    if (mode === 'normal') {
      const had = this.rooms.delete(roomId);
      if (had) this.changed({ roomId, mode: 'normal', until: null, at: now });
      return normal();
    }
    const forMs = asked === undefined ? this.defaultModeMs() : (asked as number);
    const entry: Entry = { mode, since: now, until: now + forMs };
    this.rooms.set(roomId, entry);
    this.changed({ roomId, mode, until: entry.until, at: now });
    return { mode, since: entry.since, until: entry.until };
  }

  /** Drop every mode that has ended, announcing each expiry once (the same event a read raises). Entries are removed before anything is announced. */
  private sweep(now: number): void {
    const ended: string[] = [];
    for (const [roomId, entry] of this.rooms) if (now >= entry.until) ended.push(roomId);
    for (const roomId of ended) this.rooms.delete(roomId);
    for (const roomId of ended) this.changed({ roomId, mode: 'normal', until: null, expired: true, at: now });
  }

  /** The mode in force, with the expiry applied (an expiry is announced once, then the room reads normal). A copy. */
  get(roomId: string): RoomModeState {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) return normal();
    const now = this.clock.now();
    if (now >= entry.until) {
      this.rooms.delete(roomId);
      this.changed({ roomId, mode: 'normal', until: null, expired: true, at: now });
      return normal();
    }
    return { mode: entry.mode, since: entry.since, until: entry.until };
  }

  /** Forget a room's mode without announcing anything (the room is closing). */
  clear(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** The rooms that have a mode now (expiry applied), as room id, mode and end. */
  active(): Array<{ roomId: string; mode: RoomMode; until: number }> {
    const out: Array<{ roomId: string; mode: RoomMode; until: number }> = [];
    for (const roomId of [...this.rooms.keys()]) {
      const state = this.get(roomId);
      if (state.mode !== 'normal' && state.until !== null) out.push({ roomId, mode: state.mode, until: state.until });
    }
    return out;
  }
}
