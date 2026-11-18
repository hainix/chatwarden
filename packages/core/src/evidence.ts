// Per-room roster (who sits in which seat) and per-room evidence buffer (recent chat
// lines, kept so a report can snapshot the conversation around the reported line).
// Both are pure in-memory: the buffer holds raw chat text, so it lives exactly as long
// as the room does and nothing here is persisted.
import { checkRoomTags, MAX_ROOM_TAGS, ROOM_TAG_KEYS } from './contexts.js';
import type { Clock, SubjectId } from './types.js';

/** Production window: the last 100 lines or 15 minutes, whichever is smaller. */
export const EVIDENCE_MAX_LINES = 100;
export const EVIDENCE_MAX_AGE_MS = 900_000;

/** One chat line kept as evidence. */
export interface EvidenceLine {
  /** Per-room counter as a string ("1", "2", ...). Never repeats within a room until `drop`. */
  lineId: string;
  /** When the line was sent, epoch ms. Compared against the buffer's clock. */
  ts: number;
  seatId: string;
  handle: string;
  /**
   * The subject who held the seat when the line was written, exactly as the caller
   * passed it (it may have been merged away since; consumers canonicalize via
   * SubjectIndex). Null when the speaker was not known.
   */
  subject: SubjectId | null;
  raw: string;
  /** Null when the line was blocked. It stays in the buffer anyway: a report must show what was typed. */
  delivered: string | null;
  blocked: boolean;
  /** Seat ids that could see the line; null means the whole room. */
  audience: string[] | null;
  /**
   * A moderator took the line back for everyone (`cw.rooms.retract`). It stays here as evidence with its text; a report filed from now on carries the flag on its excerpt line. Absent until then.
   */
  retracted?: true;
}

export interface EvidenceBufferOptions {
  /** Defaults to {@link EVIDENCE_MAX_LINES}. */
  maxLines?: number;
  /** Defaults to {@link EVIDENCE_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Compared against `line.ts`, so the caller's `ts` and this clock must share a time base. */
  clock: Clock;
}

interface RoomBuffer {
  // Lives as long as the room's buffer does, so ids never repeat within a room. Only
  // drop() resets it, and a dropped room has no evidence left to collide with.
  nextId: number;
  lines: EvidenceLine[];
}

// Every value that enters or leaves the buffer is copied, so evidence cannot change
// because a caller mutated an object it handed in or got back.
function copyLine(line: EvidenceLine): EvidenceLine {
  return { ...line, audience: line.audience === null ? null : [...line.audience] };
}

/** What stands in for an erased person's line (privacy.ts has the same constant; this module imports nothing from it to stay a leaf). */
const ERASED_TEXT = '[erased]';

export class EvidenceBuffer {
  private readonly maxLines: number;
  private readonly maxAgeMs: number;
  private readonly clock: Clock;
  private readonly rooms = new Map<string, RoomBuffer>();

  constructor(opts: EvidenceBufferOptions) {
    this.maxLines = opts.maxLines ?? EVIDENCE_MAX_LINES;
    this.maxAgeMs = opts.maxAgeMs ?? EVIDENCE_MAX_AGE_MS;
    this.clock = opts.clock;
  }

  append(roomId: string, line: Omit<EvidenceLine, 'lineId'>): string {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { nextId: 1, lines: [] };
      this.rooms.set(roomId, room);
    }
    const lineId = String(room.nextId++);
    room.lines.push(copyLine({ ...line, lineId }));
    // The count cap is applied on write, so a room nobody reads stays bounded too.
    const excess = room.lines.length - this.maxLines;
    if (excess > 0) room.lines.splice(0, excess);
    return lineId;
  }

  get(roomId: string, lineId: string): EvidenceLine | undefined {
    const room = this.prune(roomId);
    const found = room?.lines.find((l) => l.lineId === lineId);
    return found ? copyLine(found) : undefined;
  }

  snapshot(roomId: string): EvidenceLine[] {
    const room = this.prune(roomId);
    return room ? room.lines.map(copyLine) : [];
  }

  drop(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /**
   * Take a delivered line back for everyone: flag it `retracted` and keep its text as evidence. `allFromAuthor` flags every other delivered line still in the buffer by the same author (the same
   * person, so a seat that changed hands follows the occupant at the time of each line, and the same person in another seat counts; a guest is known by seat). `canonical` folds a merged subject into the person.
   * A blocked line was never delivered and is never flagged. Returns the ids it flagged, oldest first; `[]` for an unknown room or line, a line already flagged, or one that has left the window
   * (older than the window, or past the line cap).
   */
  retract(roomId: string, lineId: string, opts: { allFromAuthor?: boolean; canonical?: (subject: SubjectId) => SubjectId } = {}): string[] {
    const room = this.prune(roomId);
    const target = room?.lines.find((l) => l.lineId === lineId);
    if (room === undefined || target === undefined || target.blocked) return [];
    const canon = opts.canonical ?? ((s: SubjectId): SubjectId => s);
    const author = target.subject === null ? null : canon(target.subject);
    const sameAuthor = (l: EvidenceLine): boolean => (author === null ? l.subject === null && l.seatId === target.seatId : l.subject !== null && canon(l.subject) === author);
    const changed: string[] = [];
    for (const l of room.lines) {
      if (l.blocked || l.retracted === true) continue;
      if (l === target || (opts.allFromAuthor === true && sameAuthor(l))) {
        l.retracted = true;
        changed.push(l.lineId);
      }
    }
    return changed;
  }

  /**
   * Erase the lines of these people (their whole alias set) from every room's buffer: a line keeps its place and id, and loses its text, the handle and the subject
   * (a blocked line, which has no delivered text, keeps that null). Used by `cw.privacy.erase`.
   */
  scrub(subjects: ReadonlySet<SubjectId>): void {
    if (subjects.size === 0) return;
    for (const room of this.rooms.values()) {
      room.lines = room.lines.map((l) =>
        l.subject !== null && subjects.has(l.subject) ? { ...l, subject: null, handle: '', raw: ERASED_TEXT, delivered: l.delivered === null ? null : ERASED_TEXT } : l,
      );
    }
  }

  // Removes lines older than the window and returns the room (undefined when the room has
  // no buffer). Runs on every read, so evidence past the window is never handed out.
  // A line is expired when now - ts > maxAgeMs, so exactly maxAgeMs old is still kept.
  private prune(roomId: string): RoomBuffer | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const cutoff = this.clock.now() - this.maxAgeMs;
    room.lines = room.lines.filter((l) => l.ts >= cutoff);
    return room;
  }
}

interface RoomState {
  seats: Map<string, { subject: SubjectId | null; handle: string }>;
  /** The inverse of `seats`: the stored subject id to the seats it holds (guest seats are under nobody). */
  bySubject: Map<SubjectId, Set<string>>;
  tags: Record<string, string>;
}

function unindex(room: RoomState, seatId: string, subject: SubjectId | null): void {
  if (subject === null) return;
  const held = room.bySubject.get(subject);
  if (held === undefined) return;
  held.delete(seatId);
  if (held.size === 0) room.bySubject.delete(subject);
}

/**
 * Who sits in which seat of which room, plus free-form per-room tags. The roster stores
 * whatever SubjectId the caller passes (possibly one merged away later); consumers
 * canonicalize via SubjectIndex. It is independent of {@link EvidenceBuffer}: closing a
 * room means calling `RoomRoster.close` and `EvidenceBuffer.drop` (the facade does both).
 */
export class RoomRoster {
  private readonly byRoom = new Map<string, RoomState>();

  /**
   * Put a subject in a seat. An occupied seat is replaced (the seat changed hands). `tags`
   * are merged over the room's existing tags when given.
   */
  seat(
    roomId: string,
    seatId: string,
    subject: SubjectId | null,
    handle: string,
    tags?: Record<string, string>,
  ): void {
    this.checkTags(roomId, tags);
    let room = this.byRoom.get(roomId);
    if (!room) {
      room = { seats: new Map(), bySubject: new Map(), tags: {} };
      this.byRoom.set(roomId, room);
    }
    const before = room.seats.get(seatId);
    if (before !== undefined) unindex(room, seatId, before.subject);
    room.seats.set(seatId, { subject, handle });
    if (subject !== null) {
      const held = room.bySubject.get(subject);
      if (held === undefined) room.bySubject.set(subject, new Set([seatId]));
      else held.add(seatId);
    }
    if (tags) Object.assign(room.tags, tags);
  }

  /**
   * Check `tags` as {@link checkRoomTags} does and against the room's own: the merged room may carry at most 8 tags, and a room's `context`
   * and `scope` cannot change once set (a room does not switch rules or owners mid-conversation: close it and open it again). Throws
   * RangeError and changes nothing.
   */
  checkTags(roomId: string, tags?: Record<string, string>): void {
    if (tags === undefined) return;
    checkRoomTags(tags);
    const room = this.byRoom.get(roomId);
    if (room === undefined) return;
    for (const key of ROOM_TAG_KEYS) {
      const next = Object.hasOwn(tags, key) ? tags[key] : undefined;
      if (next !== undefined && Object.hasOwn(room.tags, key) && room.tags[key] !== next) {
        throw new RangeError(`a room's ${key} tag cannot change while it is open`);
      }
    }
    const keys = new Set([...Object.keys(room.tags), ...Object.keys(tags)]);
    if (keys.size > MAX_ROOM_TAGS) throw new RangeError(`a room may carry at most ${MAX_ROOM_TAGS} tags`);
  }

  /** One tag of the room, or undefined (an unknown room or a tag it does not have). */
  tag(roomId: string, key: string): string | undefined {
    const room = this.byRoom.get(roomId);
    return room !== undefined && Object.hasOwn(room.tags, key) ? room.tags[key] : undefined;
  }

  /** Empty a seat. A no-op when the seat or room is unknown. Room tags are kept. */
  unseat(roomId: string, seatId: string): void {
    const room = this.byRoom.get(roomId);
    if (room === undefined) return;
    const before = room.seats.get(seatId);
    if (before !== undefined) unindex(room, seatId, before.subject);
    room.seats.delete(seatId);
  }

  /** The seats of the room whose stored occupant is exactly `subject` (a stored id: ask for each alias of a person). Unsorted; [] for an unknown room or subject. O(seats held by that person). */
  seatsOf(roomId: string, subject: SubjectId): string[] {
    return [...(this.byRoom.get(roomId)?.bySubject.get(subject) ?? [])];
  }

  /** How many rooms the roster holds. */
  roomCount(): number {
    return this.byRoom.size;
  }

  /** How many seats the room holds now; 0 for an unknown room. */
  seatCount(roomId: string): number {
    return this.byRoom.get(roomId)?.seats.size ?? 0;
  }

  /** Seat ids currently held in the room, sorted; [] for an unknown room. A copy. */
  seats(roomId: string): string[] {
    return [...(this.byRoom.get(roomId)?.seats.keys() ?? [])].sort();
  }

  occupant(roomId: string, seatId: string): { subject: SubjectId | null; handle: string } | null {
    const found = this.byRoom.get(roomId)?.seats.get(seatId);
    return found ? { ...found } : null;
  }

  /** Every room the roster knows, with its tags and how many seats are held now. Copies; in no promised order. Holds no seat id or handle. */
  rooms(): Array<{ roomId: string; tags: Record<string, string>; seated: number }> {
    return [...this.byRoom.entries()].map(([roomId, room]) => ({ roomId, tags: { ...room.tags }, seated: room.seats.size }));
  }

  /** Tags of the room, or `{}` for an unknown room. A copy. */
  tags(roomId: string): Record<string, string> {
    return { ...this.byRoom.get(roomId)?.tags };
  }

  /** Forget the room's seats and tags. */
  close(roomId: string): void {
    this.byRoom.delete(roomId);
  }

  /** Turn the seats these people hold (their whole alias set) into guests: the seat and its handle stay, the person goes. Used by `cw.privacy.erase`. */
  forget(subjects: ReadonlySet<SubjectId>): void {
    if (subjects.size === 0) return;
    for (const room of this.byRoom.values()) {
      for (const [seatId, seat] of room.seats) {
        if (seat.subject === null || !subjects.has(seat.subject)) continue;
        unindex(room, seatId, seat.subject);
        seat.subject = null;
      }
    }
  }
}
