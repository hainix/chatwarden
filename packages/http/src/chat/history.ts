// The history ring of a chat room (design 9): the last few delivered lines, never older than the kit's evidence window. Pure and
// clocked: no `node:` import, no timer (the ring is pruned on every write and every read, so a quiet room's ring still empties).
import { EVIDENCE_MAX_AGE_MS } from '@chatwarden/core';

/** The lines a ring holds when the adopter does not say: 50. @experimental */
export const HISTORY_LINES_DEFAULT = 50;
/** The most lines a ring may hold: the evidence buffer's 100. @experimental */
export const HISTORY_LINES_MAX = 100;
/** The shortest window a ring may keep lines for: one second. */
const HISTORY_MAX_AGE_MIN_MS = 1000;

/**
 * One delivered line in a room's ring. The seat stays on the server: it is how a line is resolved to its author for a mute or a report.
 * @experimental
 */
export interface RingLine {
  id: string;
  /** When the server accepted it, epoch ms. */
  at: number;
  seat: string;
  name: string;
  text: string;
}

/** @experimental */
export interface Ring {
  /** Add a line (a copy is kept), then drop what is over the count or the age. */
  append(line: RingLine): void;
  /** The lines still held, oldest first, as copies. */
  snapshot(): RingLine[];
  /** One line by id, as a copy. */
  byId(id: string): RingLine | undefined;
  /** Every line still held by a seat, oldest first, as copies. */
  bySeat(seat: string): RingLine[];
  size(): number;
}

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

const copyOf = (line: RingLine): RingLine => ({ id: line.id, at: line.at, seat: line.seat, name: line.name, text: line.text });

/**
 * A ring of at most `lines` lines, none older than `maxAgeMs` (a line is expired when `now() - at > maxAgeMs`, so one exactly
 * `maxAgeMs` old is kept: the evidence buffer's rule). Pruned on every `append` and every read. A clock that steps backwards makes
 * a line look younger, never older, so nothing is dropped early. `RangeError` (never echoing a value) for options out of range.
 * @experimental
 */
export function createRing(opts: { lines: number; maxAgeMs: number; now: () => number }): Ring {
  if (!isWhole(opts.lines) || opts.lines < 1) throw new RangeError('createRing: lines must be a whole number of at least 1');
  if (!isWhole(opts.maxAgeMs) || opts.maxAgeMs < 1) throw new RangeError('createRing: maxAgeMs must be a whole number of at least 1');
  if (typeof opts.now !== 'function') throw new TypeError('createRing: now must be a function');
  const { lines: capacity, maxAgeMs, now } = opts;
  let held: RingLine[] = [];

  const prune = (): void => {
    const at = now();
    // Lines arrive in order, but a stepped clock can leave the stamps out of order, so every line is checked, not only the oldest.
    if (held.some((line) => at - line.at > maxAgeMs)) held = held.filter((line) => at - line.at <= maxAgeMs);
    if (held.length > capacity) held = held.slice(held.length - capacity);
  };

  return {
    append(line) {
      held.push(copyOf(line));
      prune();
    },
    snapshot() {
      prune();
      return held.map(copyOf);
    },
    byId(id) {
      prune();
      for (let i = held.length - 1; i >= 0; i -= 1) {
        const line = held[i] as RingLine;
        if (line.id === id) return copyOf(line);
      }
      return undefined;
    },
    bySeat(seat) {
      prune();
      return held.filter((line) => line.seat === seat).map(copyOf);
    },
    size() {
      prune();
      return held.length;
    },
  };
}

/**
 * The ring's size and age from the adopter's `history` option: `lines` defaults to {@link HISTORY_LINES_DEFAULT} and may be 1 to
 * {@link HISTORY_LINES_MAX}; `maxAgeMs` defaults to the kit's evidence window (`EVIDENCE_MAX_AGE_MS`) and may be 1 000 up to it, so
 * history never shows a line the kit can no longer evidence for a report. A value out of range, a fraction, `NaN` or a string is a
 * `RangeError` whose message never carries the value.
 * @experimental
 */
export function resolveHistory(input: { lines?: number; maxAgeMs?: number } | undefined): { lines: number; maxAgeMs: number } {
  if (input !== undefined && (typeof input !== 'object' || input === null)) throw new TypeError('history must be an object');
  // `undefined` means "use the default"; `null` or anything else that is not a whole number is refused.
  const lines: unknown = input?.lines === undefined ? HISTORY_LINES_DEFAULT : input.lines;
  const maxAgeMs: unknown = input?.maxAgeMs === undefined ? EVIDENCE_MAX_AGE_MS : input.maxAgeMs;
  if (!isWhole(lines) || lines < 1 || lines > HISTORY_LINES_MAX) {
    throw new RangeError(`history.lines must be a whole number from 1 to ${HISTORY_LINES_MAX}`);
  }
  if (!isWhole(maxAgeMs) || maxAgeMs < HISTORY_MAX_AGE_MIN_MS || maxAgeMs > EVIDENCE_MAX_AGE_MS) {
    throw new RangeError(`history.maxAgeMs must be a whole number of milliseconds from ${HISTORY_MAX_AGE_MIN_MS} to ${EVIDENCE_MAX_AGE_MS}`);
  }
  return { lines, maxAgeMs };
}
