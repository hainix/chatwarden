// Per-room roster (who sits in which seat) and per-room evidence buffer (recent chat
// lines, kept so a report can snapshot the conversation around the reported line).
// Both are pure in-memory: the buffer holds raw chat text, so it lives exactly as long
// as the room does and nothing here is persisted.
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
  tags: Record<string, string>;
}

/**
 * Who sits in which seat of which room, plus free-form per-room tags. The roster stores
 * whatever SubjectId the caller passes (possibly one merged away later); consumers
 * canonicalize via SubjectIndex. It is independent of {@link EvidenceBuffer}: closing a
 * room means calling `RoomRoster.close` and `EvidenceBuffer.drop` (the facade does both).
 */
export class RoomRoster {
  private readonly rooms = new Map<string, RoomState>();

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
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { seats: new Map(), tags: {} };
      this.rooms.set(roomId, room);
    }
    room.seats.set(seatId, { subject, handle });
    if (tags) Object.assign(room.tags, tags);
  }

  /** Empty a seat. A no-op when the seat or room is unknown. Room tags are kept. */
  unseat(roomId: string, seatId: string): void {
    this.rooms.get(roomId)?.seats.delete(seatId);
  }

  /** Seat ids currently held in the room, sorted; [] for an unknown room. A copy. */
  seats(roomId: string): string[] {
    return [...(this.rooms.get(roomId)?.seats.keys() ?? [])].sort();
  }

  occupant(roomId: string, seatId: string): { subject: SubjectId | null; handle: string } | null {
    const found = this.rooms.get(roomId)?.seats.get(seatId);
    return found ? { ...found } : null;
  }

  /** Tags of the room, or `{}` for an unknown room. A copy. */
  tags(roomId: string): Record<string, string> {
    return { ...this.rooms.get(roomId)?.tags };
  }

  /** Forget the room's seats and tags. */
  close(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
