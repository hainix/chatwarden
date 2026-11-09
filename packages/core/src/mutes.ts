import type { RoomRoster } from './evidence.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, Store, SubjectId } from './types.js';

// Lasting chat mutes: a viewer's mute of a person, kept for 180 days. A mute is between two CANONICAL subjects
// (one person across browsers and accounts), never an IP and never oneself. The rows are stored under the subject
// ids as the caller gave them and compared through `SubjectIndex.canonical` at query time, so a mute survives a
// merge on either side. The chat path asks `isMuted` (once per message per recipient) and `mutedSeats` (to tell a
// client which seats it muted); both read memory only. `set` writes through to the store, synchronously.

/** A mute lasts this long from its last (re)creation: 180 days. */
export const MUTE_TTL_MS = 180 * 24 * 3_600_000;

/** One person keeps at most this many mutes; the oldest by `createdAt` is dropped for the next. */
export const MAX_MUTES_PER_VIEWER = 500;

const defaultLogger: Logger = {
  warn(event, detail) {
    if (detail === undefined) console.warn(event);
    else console.warn(event, detail);
  },
};

type Op = { put: true; viewer: SubjectId; target: SubjectId; createdAt: number } | { put: false; viewer: SubjectId; target: SubjectId };

const present = (id: SubjectId | null): id is SubjectId => typeof id === 'string' && id !== '';

export class MuteService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly subjects: SubjectIndex;
  private readonly logger: Logger;

  /**
   * Stored viewer id -> stored target id -> createdAt. Either id may have been merged away since the row
   * was written; every lookup canonicalises. `set` re-files a person's rows under their canonical viewer id.
   */
  private byViewer = new Map<SubjectId, Map<SubjectId, number>>();

  constructor(store: Store, clock: Clock, subjects: SubjectIndex, opts?: { logger?: Logger }) {
    this.store = store;
    this.clock = clock;
    this.subjects = subjects;
    this.logger = opts?.logger ?? defaultLogger;
  }

  /** Replace the in-memory index with the store's live mutes (those within the TTL). Call once at start up. */
  load(): Promise<void> {
    try {
      const rows = this.store.loadMutes(this.clock.now() - MUTE_TTL_MS);
      const next = new Map<SubjectId, Map<SubjectId, number>>();
      for (const row of rows) {
        let bucket = next.get(row.viewer);
        if (bucket === undefined) next.set(row.viewer, (bucket = new Map()));
        bucket.set(row.target, row.createdAt);
      }
      this.byViewer = next;
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Mute (`on`) or unmute `target` for `viewer`. Synchronous: the store write and the memory update both
   * happen before this returns, so the next `isMuted` sees it. A repeat mute refreshes `createdAt` (the TTL
   * restarts). Muting oneself (the same canonical subject) or an empty id does nothing. A store failure is
   * logged (never with an identifier) and leaves memory and store as they were; it never throws, because a mute
   * must not break chat.
   */
  set(viewer: SubjectId, target: SubjectId, on: boolean): void {
    if (!present(viewer) || !present(target)) return;
    const cv = this.subjects.canonical(viewer);
    const ct = this.subjects.canonical(target);
    if (cv === ct) return;
    try {
      if (on) this.mute(cv, ct);
      else this.unmute(cv, ct);
    } catch (err) {
      try {
        this.logger.warn('mutes.write_failed', {
          op: on ? 'mute' : 'unmute',
          error: err instanceof Error ? err.name : typeof err,
        });
      } catch {
        // A broken logger must not break chat.
      }
    }
  }

  /**
   * Has `viewer` muted `target` (as one person each) within the last 180 days? False when either is null or
   * they are one person. A mute exactly 180 days old still applies; one millisecond older does not.
   */
  isMuted(viewer: SubjectId | null, target: SubjectId | null): boolean {
    if (!present(viewer) || !present(target)) return false;
    const cv = this.subjects.canonical(viewer);
    const ct = this.subjects.canonical(target);
    if (cv === ct) return false;
    return this.live(cv, ct, this.clock.now() - MUTE_TTL_MS);
  }

  /**
   * The seats in the room, other than `viewerSeat`, whose CURRENT occupant the viewer has muted, sorted by
   * seat id. Empty when the viewer's seat is empty or holds no subject, or the room is unknown. Seats with no
   * subject (AI, unknown) and seats held by the viewer's own person are never listed. Seat ids only: no
   * identifier leaves this call.
   */
  mutedSeats(roomId: string, viewerSeat: string, roster: RoomRoster): string[] {
    const viewer = roster.occupant(roomId, viewerSeat)?.subject ?? null;
    if (viewer === null) return [];
    const out: string[] = [];
    for (const seat of roster.seats(roomId)) {
      if (seat === viewerSeat) continue;
      if (this.isMuted(viewer, roster.occupant(roomId, seat)?.subject ?? null)) out.push(seat);
    }
    return out;
  }

  // --- internals -----------------------------------------------------------

  /** Is there a stored row for this canonical pair created at or after `cutoff`? */
  private live(cv: SubjectId, ct: SubjectId, cutoff: number): boolean {
    // Fast path: rows written by `set` sit under canonical ids.
    const direct = this.byViewer.get(cv)?.get(ct);
    if (direct !== undefined && direct >= cutoff) return true;
    // Slow path: a row filed under an id that was merged away since.
    for (const [sv, targets] of this.byViewer) {
      if (sv !== cv && this.subjects.canonical(sv) !== cv) continue;
      for (const [st, at] of targets) {
        if (at >= cutoff && (st === ct || this.subjects.canonical(st) === ct)) return true;
      }
    }
    return false;
  }

  private mute(cv: SubjectId, ct: SubjectId): void {
    const now = this.clock.now();
    const ops: Op[] = [];
    const absorbed: SubjectId[] = [];
    // The person's rows as they will be once re-filed under the canonical viewer id.
    const bucket = new Map(this.byViewer.get(cv) ?? []);

    // 1. Rows filed under viewer ids that were merged into this person move to the canonical id; where both
    //    held the same target, the newer time wins.
    for (const [sv, targets] of this.byViewer) {
      if (sv === cv || this.subjects.canonical(sv) !== cv) continue;
      absorbed.push(sv);
      for (const [st, at] of targets) {
        const current = bucket.get(st);
        if (current === undefined || at > current) {
          bucket.set(st, at);
          ops.push({ put: true, viewer: cv, target: st, createdAt: at });
        }
        ops.push({ put: false, viewer: sv, target: st });
      }
    }
    // 2. Rows for the same target person under an older id of it collapse into the one new row.
    for (const st of [...bucket.keys()]) {
      if (st !== ct && this.subjects.canonical(st) === ct) {
        bucket.delete(st);
        ops.push({ put: false, viewer: cv, target: st });
      }
    }
    // 3. The mute itself.
    bucket.set(ct, now);
    ops.push({ put: true, viewer: cv, target: ct, createdAt: now });

    const evicted = this.store.transaction(() => {
      for (const op of ops) {
        if (op.put) this.store.upsertMute({ viewer: op.viewer, target: op.target, createdAt: op.createdAt });
        else this.store.deleteMute(op.viewer, op.target);
      }
      return this.store.pruneMutes(cv, MAX_MUTES_PER_VIEWER);
    });

    for (const target of evicted) bucket.delete(target);
    for (const sv of absorbed) this.byViewer.delete(sv);
    this.byViewer.set(cv, bucket);
  }

  private unmute(cv: SubjectId, ct: SubjectId): void {
    const ops: Array<{ viewer: SubjectId; target: SubjectId }> = [];
    for (const [sv, targets] of this.byViewer) {
      if (sv !== cv && this.subjects.canonical(sv) !== cv) continue;
      for (const st of targets.keys()) {
        if (st === ct || this.subjects.canonical(st) === ct) ops.push({ viewer: sv, target: st });
      }
    }
    if (ops.length === 0) return;
    this.store.transaction(() => {
      for (const op of ops) this.store.deleteMute(op.viewer, op.target);
    });
    for (const op of ops) {
      const bucket = this.byViewer.get(op.viewer);
      bucket?.delete(op.target);
      if (bucket?.size === 0) this.byViewer.delete(op.viewer);
    }
  }
}
