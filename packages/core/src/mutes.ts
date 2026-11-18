import type { RoomRoster } from './evidence.js';
import { safeWarn } from './log.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, Store, SubjectId } from './types.js';

// Lasting chat mutes and blocks: a viewer's mute of a person, kept for 180 days, or their block of one, kept until it is undone. A block is a mute that is also two-way: the blocked person's lines
// are hidden from the blocker (as a mute does) and the blocker's from them. Mute and block share one row per pair: the latest action wins, a mute never downgrades a block, an unmute or unblock
// deletes the row. Both are between two CANONICAL subjects (one person across browsers and accounts), never an IP and never oneself. The rows are stored under the subject ids as the caller gave
// them and compared through `SubjectIndex.canonical` at query time, so a mute or a block survives a merge on either side. The chat path asks `isMuted` and `isBlocked` (once per message per
// recipient) and `mutedSeats` / `blockedSeats` (to tell a client which seats it muted or blocked); all read memory only. `set` writes through to the store, synchronously.

/** A mute lasts this long from its last (re)creation: 180 days. A block has no end. */
export const MUTE_TTL_MS = 180 * 24 * 3_600_000;

/** One person keeps at most this many mutes and blocks together; the oldest MUTE is dropped for the next, never a block. */
export const MAX_MUTES_PER_VIEWER = 500;

/** What {@link MuteService.set} did: `ok` (applied, or already so), `limit` (the viewer's list is full of blocks: nothing was written) or `none` (nothing to do: an empty id, oneself, or a failed write). */
export type MuteOutcome = 'ok' | 'limit' | 'none';

interface Entry {
  at: number;
  block: boolean;
}

/** A stored row whose viewer id or target id has been merged away since it was written, found by the canonical pair it now means. */
interface StaleRow {
  viewer: SubjectId;
  target: SubjectId;
  entry: Entry;
}

type Op = { put: true; viewer: SubjectId; target: SubjectId; createdAt: number; block: boolean } | { put: false; viewer: SubjectId; target: SubjectId };

const present = (id: SubjectId | null): id is SubjectId => typeof id === 'string' && id !== '';

export class MuteService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly subjects: SubjectIndex;
  private readonly logger: Logger | undefined;

  /**
   * Stored viewer id -> stored target id -> the row. Either id may have been merged away since the row
   * was written; every lookup canonicalises. `set` re-files a person's rows under their canonical viewer id.
   */
  private byViewer = new Map<SubjectId, Map<SubjectId, Entry>>();

  /**
   * The rows stored under an id that was merged away, found by the canonical viewer and the canonical target they mean now; with `absorbed` (the stored viewer ids that are no longer canonical, by
   * their canonical viewer) it is what lets a lookup be two map reads instead of a scan of every viewer. Rows written by `set` sit under canonical ids and are never in it. It is rebuilt, lazily
   * and in one pass, when the subject index says a merge happened (`mergeVersion`), and after a change to the rows while it holds anything. Empty (the usual case) it costs nothing.
   */
  private stale = new Map<SubjectId, Map<SubjectId, StaleRow[]>>();
  private absorbed = new Map<SubjectId, SubjectId[]>();
  private staleAt = -1;

  constructor(store: Store, clock: Clock, subjects: SubjectIndex, opts?: { logger?: Logger }) {
    this.store = store;
    this.clock = clock;
    this.subjects = subjects;
    this.logger = opts?.logger;
  }

  /** Replace the in-memory index with the store's live mutes (those within the TTL) and every block. Call once at start up. */
  load(): Promise<void> {
    try {
      const rows = this.store.loadMutes(this.clock.now() - MUTE_TTL_MS);
      const next = new Map<SubjectId, Map<SubjectId, Entry>>();
      for (const row of rows) {
        let bucket = next.get(row.viewer);
        if (bucket === undefined) next.set(row.viewer, (bucket = new Map()));
        bucket.set(row.target, { at: row.createdAt, block: row.block === true });
      }
      this.byViewer = next;
      this.staleAt = -1;
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Mute or block (`on`) or unmute or unblock `target` for `viewer`; `kind` says which when `on` (default a mute). Synchronous: the store write and the memory update both
   * happen before this returns, so the next `isMuted` sees it. A repeat mute refreshes `createdAt` (the TTL restarts); a block over a mute makes the row a block; a mute over a
   * block changes nothing. Turning `on` off deletes the row whichever kind it is. Oneself and an empty id do nothing (`none`). With the viewer's list full of blocks a new
   * pair is refused (`limit`, nothing written); otherwise the oldest mute is dropped for it. A store failure is logged (never with an identifier) and leaves memory and store as
   * they were; it never throws, because a mute must not break chat.
   */
  set(viewer: SubjectId, target: SubjectId, on: boolean, kind: 'mute' | 'block' = 'mute'): MuteOutcome {
    if (!present(viewer) || !present(target)) return 'none';
    const cv = this.subjects.canonical(viewer);
    const ct = this.subjects.canonical(target);
    if (cv === ct) return 'none';
    try {
      if (on) return this.put(cv, ct, kind === 'block');
      this.unmute(cv, ct);
      return 'ok';
    } catch (err) {
      safeWarn(this.logger, 'mutes.write_failed', {
        op: on ? kind : kind === 'block' ? 'unblock' : 'unmute',
        error: err instanceof Error ? err.name : typeof err,
      });
      return 'none';
    }
  }

  /**
   * Has `viewer` muted or blocked `target` (as one person each)? A mute lasts 180 days (one exactly that old still applies, one millisecond older does not); a block lasts until it is
   * undone. False when either is null or they are one person.
   */
  isMuted(viewer: SubjectId | null, target: SubjectId | null): boolean {
    return this.find(viewer, target) !== null;
  }

  /** Has `viewer` BLOCKED `target`? One direction; {@link blockedBetween} reads both. */
  isBlocked(viewer: SubjectId | null, target: SubjectId | null): boolean {
    return this.find(viewer, target)?.block === true;
  }

  /** Has either of the two blocked the other? */
  blockedBetween(a: SubjectId | null, b: SubjectId | null): boolean {
    return this.isBlocked(a, b) || this.isBlocked(b, a);
  }

  /**
   * The seats in the room, other than `viewerSeat`, whose CURRENT occupant the viewer has muted or blocked, sorted by
   * seat id. Empty when the viewer's seat is empty or holds no subject, or the room is unknown. Seats with no
   * subject (AI, unknown) and seats held by the viewer's own person are never listed. Seat ids only: no
   * identifier leaves this call.
   */
  mutedSeats(roomId: string, viewerSeat: string, roster: RoomRoster): string[] {
    return this.seatsWhere(roomId, viewerSeat, roster, (v, t) => this.isMuted(v, t));
  }

  /** {@link mutedSeats}, only the seats the viewer BLOCKED. */
  blockedSeats(roomId: string, viewerSeat: string, roster: RoomRoster): string[] {
    return this.seatsWhere(roomId, viewerSeat, roster, (v, t) => this.isBlocked(v, t));
  }

  // --- internals -----------------------------------------------------------

  private seatsWhere(roomId: string, viewerSeat: string, roster: RoomRoster, test: (viewer: SubjectId, target: SubjectId | null) => boolean): string[] {
    const viewer = roster.occupant(roomId, viewerSeat)?.subject ?? null;
    if (viewer === null) return [];
    const out: string[] = [];
    for (const seat of roster.seats(roomId)) {
      if (seat === viewerSeat) continue;
      if (test(viewer, roster.occupant(roomId, seat)?.subject ?? null)) out.push(seat);
    }
    return out;
  }

  /** The live row for this pair, a block winning over a mute where several rows (older ids) name it; null when there is none. */
  private find(viewer: SubjectId | null, target: SubjectId | null): Entry | null {
    if (!present(viewer) || !present(target)) return null;
    const cv = this.subjects.canonical(viewer);
    const ct = this.subjects.canonical(target);
    if (cv === ct) return null;
    const cutoff = this.clock.now() - MUTE_TTL_MS;
    let any = false;
    let at = 0;
    let block = false;
    const take = (e: Entry): void => {
      if (!e.block && e.at < cutoff) return;
      any = true;
      if (e.at > at) at = e.at;
      if (e.block) block = true;
    };
    // Rows written by `set` sit under canonical ids: one direct read.
    const direct = this.byViewer.get(cv)?.get(ct);
    if (direct !== undefined) take(direct);
    // Rows filed under an id that was merged away since: the index of those, again two reads.
    if (!block) {
      this.refreshStale();
      for (const row of this.stale.get(cv)?.get(ct) ?? []) take(row.entry);
    }
    return any ? { at, block } : null;
  }

  private put(cv: SubjectId, ct: SubjectId, block: boolean): MuteOutcome {
    // A mute over a block (under any id of either person) changes nothing: a mute never downgrades a block.
    if (!block && this.isBlockedStored(cv, ct)) return 'ok';
    const now = this.clock.now();
    const ops: Op[] = [];
    const absorbed: SubjectId[] = [];
    // The person's rows as they will be once re-filed under the canonical viewer id.
    const bucket = new Map(this.byViewer.get(cv) ?? []);

    // 1. Rows filed under viewer ids that were merged into this person move to the canonical id; where both
    //    held the same target, the newer time wins and a block wins over a mute.
    this.refreshStale();
    for (const sv of this.absorbed.get(cv) ?? []) {
      const targets = this.byViewer.get(sv);
      if (targets === undefined) continue;
      absorbed.push(sv);
      for (const [st, e] of targets) {
        const current = bucket.get(st);
        if (current === undefined || e.at > current.at || (e.block && !current.block)) {
          const merged: Entry = { at: Math.max(e.at, current?.at ?? 0), block: e.block || current?.block === true };
          bucket.set(st, merged);
          ops.push({ put: true, viewer: cv, target: st, createdAt: merged.at, block: merged.block });
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
    // 3. The mute or the block itself.
    bucket.set(ct, { at: now, block });
    ops.push({ put: true, viewer: cv, target: ct, createdAt: now, block });

    // A full list drops its oldest MUTE for a new pair; with only blocks left there is nothing to drop and the new pair is refused before anything is written.
    if (bucket.size > MAX_MUTES_PER_VIEWER && ![...bucket].some(([st, e]) => st !== ct && !e.block)) return 'limit';

    const evicted = this.store.transaction(() => {
      for (const op of ops) {
        if (op.put) this.store.upsertMute({ viewer: op.viewer, target: op.target, createdAt: op.createdAt, block: op.block });
        else this.store.deleteMute(op.viewer, op.target);
      }
      return this.store.pruneMutes(cv, MAX_MUTES_PER_VIEWER);
    });

    for (const target of evicted) bucket.delete(target);
    for (const sv of absorbed) this.byViewer.delete(sv);
    this.byViewer.set(cv, bucket);
    this.touched();
    return 'ok';
  }

  /** Is there a stored block for this canonical pair, under any id of either person (age does not matter)? */
  private isBlockedStored(cv: SubjectId, ct: SubjectId): boolean {
    this.refreshStale();
    return this.byViewer.get(cv)?.get(ct)?.block === true || (this.stale.get(cv)?.get(ct) ?? []).some((r) => r.entry.block);
  }

  private unmute(cv: SubjectId, ct: SubjectId): void {
    const ops: Array<{ viewer: SubjectId; target: SubjectId }> = [];
    this.refreshStale();
    if (this.byViewer.get(cv)?.has(ct) === true) ops.push({ viewer: cv, target: ct });
    for (const row of this.stale.get(cv)?.get(ct) ?? []) ops.push({ viewer: row.viewer, target: row.target });
    if (ops.length === 0) return;
    this.store.transaction(() => {
      for (const op of ops) this.store.deleteMute(op.viewer, op.target);
    });
    for (const op of ops) {
      const bucket = this.byViewer.get(op.viewer);
      bucket?.delete(op.target);
      if (bucket?.size === 0) this.byViewer.delete(op.viewer);
    }
    this.touched();
  }

  /** Bring the stale-row index up to date with the subject index: nothing to do unless a merge (or a change of rows while it held something) happened since it was built. */
  private refreshStale(): void {
    const version = this.subjects.mergeVersion;
    if (version === this.staleAt) return;
    const stale = new Map<SubjectId, Map<SubjectId, StaleRow[]>>();
    const absorbed = new Map<SubjectId, SubjectId[]>();
    for (const [sv, targets] of this.byViewer) {
      const cv = this.subjects.canonical(sv);
      if (cv !== sv) {
        const list = absorbed.get(cv);
        if (list === undefined) absorbed.set(cv, [sv]);
        else list.push(sv);
      }
      for (const [st, entry] of targets) {
        const ct = this.subjects.canonical(st);
        if ((cv === sv && ct === st) || cv === ct) continue;
        let byTarget = stale.get(cv);
        if (byTarget === undefined) stale.set(cv, (byTarget = new Map()));
        const rows = byTarget.get(ct);
        if (rows === undefined) byTarget.set(ct, [{ viewer: sv, target: st, entry }]);
        else rows.push({ viewer: sv, target: st, entry });
      }
    }
    this.stale = stale;
    this.absorbed = absorbed;
    this.staleAt = version;
  }

  /** The rows changed: an index that holds anything is rebuilt at the next lookup (one that holds nothing stays right, since `set` writes canonical ids only). */
  private touched(): void {
    if (this.stale.size > 0 || this.absorbed.size > 0) this.staleAt = -1;
  }
}
