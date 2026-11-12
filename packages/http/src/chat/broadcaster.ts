// The room broadcaster (design 6.2, 8, 9, 11): one place that turns a player's line into `cw.chat.accept`, keeps a bounded history for late
// joiners, and writes frames to the players' open streams. It knows nothing about HTTP: it writes `ChatFrame` objects to a `ChatSink`, and
// `chatRoutes` is one adapter that turns them into Server-Sent Events. Browser-safe: no `node:` import, no `Buffer`, no `fetch`, no DOM.
//
// Every failure is contained: a sink that throws loses only its own stream, a kit call that throws is an answer, never an exception.
// Every log line is an event name and an error class (through `safeWarn`): never a line, a name, a room, a seat or a credential.
import { errorClass, EVIDENCE_MAX_AGE_MS, makeHasher, safeWarn } from '@chatwarden/core';
import type { Chatwarden, Logger, RawWho, RestrictedAnswer, SubjectId } from '@chatwarden/core';
import { createRing, HISTORY_LINES_DEFAULT, resolveHistory } from './history.js';
import type { Ring } from './history.js';
import { randomHex, randomToken } from './random.js';
import { CHAT_WIRE_VERSION, refusalOf } from './wire.js';
import type { ChatFrame, MuteResult, MuteTarget, ReportOutcome, SendResult, WireLine, WireMuted, WireRefusal, WireRestriction } from './wire.js';

/**
 * The game's description of a player in a room.
 * @experimental
 */
export interface ChatMember {
  /** The display name other players see. 1 to 32 characters; control characters are removed. Checked with `cw.names.check` (see `nameCheck`). */
  name: string;
  /** Room tags passed to `cw.rooms.seat` (for example `{ mode: 'ranked' }`). */
  tags?: Record<string, string>;
}

/**
 * Where frames go: an SSE response, a socket, a test.
 * @experimental
 */
export interface ChatSink {
  /** Deliver one frame. Return `false` when the receiver is backed up; the broadcaster drops a stream that stays backed up. */
  write(frame: ChatFrame): boolean | void;
  /**
   * Keep an idle connection alive (the SSE comment line). Called every `heartbeatMs` while the stream is open. Optional: a socket with its
   * own keep-alive leaves it out and gets no heartbeat. Same return rule as `write`.
   */
  ping?(): boolean | void;
  /**
   * Optional. The broadcaster is done with this stream and will write no more: it said `bye`, or the receiver was backed up for `maxBacklog`
   * writes, or a write threw. End the connection (the client reconnects). Not called when the caller closed the stream itself.
   */
  end?(): void;
}

/**
 * A live stream.
 * @experimental
 */
export interface ChatStream {
  /** Stop sending and release the seat reference. Safe to call twice. */
  close(): void;
}

/**
 * One player in one room. Cheap, idempotent to create; every method re-checks the player's state.
 *
 * A session holds no credential. While the player is seated it refreshes the seat's grace on every call; once the seat is released (the grace ran
 * out, the room was closed, the broadcaster closed) it has nothing to seat the player with again and answers like an unseated player: `send` is
 * refused `gate`, `open` is refused, `mute` is `false`. Make a new session from the next request (the routes do, per request).
 * @experimental
 */
export interface ChatSession {
  readonly name: string;
  /**
   * Start a stream: the `hello` frame is written before this returns, then lines as they come. At the player's `maxStreamsPerMember` their oldest
   * stream is ended (its sink gets `end()`) and this one is admitted. `{ refused: { reason: 'full' } }` when the process is at `maxStreams`, the
   * seat is gone, or the broadcaster is closed.
   */
  open(sink: ChatSink): ChatStream | { refused: WireRefusal };
  /** True when `open` would not be refused right now. For a caller (the HTTP route) that must say 429 before it has a sink. */
  canOpen(): boolean;
  /** Check a line with the kit and, if it passes, deliver it to the room. Never throws. */
  send(input: { text: string }): SendResult;
  /** Mute or unmute a player, named by one of their lines or by the token from `muted`. `false`: nothing to do. */
  mute(input: MuteTarget & { on: boolean }): boolean;
  /** `mute`, with the ids of the lines it hid from this player (see `MuteResult`). The routes answer a mute with this. */
  muteResult(input: MuteTarget & { on: boolean }): MuteResult;
  /** Report a line. The reporter is this session; the person is the line's author. Never rejects for a kit refusal. */
  report(input: { lineId: string; reason?: string; note?: string }): Promise<ReportOutcome>;
}

/** @experimental */
export interface RoomBroadcasterOptions {
  /** History kept per room for late joiners. `lines` 1 to 100 (default 50); `maxAgeMs` 1 000 to `EVIDENCE_MAX_AGE_MS` (default `EVIDENCE_MAX_AGE_MS`). */
  history?: { lines?: number; maxAgeMs?: number };
  /** Most players seated at once in one room. Default 500. A join over it is refused. */
  maxMembers?: number;
  /** Most rooms the process holds at once. Default 10 000. A join that would open one more is refused (`rooms_full`); rooms that exist still take players. */
  maxRooms?: number;
  /**
   * Most open streams for one player in one room (tabs). Default 3. At the limit the player's OLDEST stream is ended (its sink gets `end()`) and
   * the new one is admitted: a connection that died without a word (a phone changing network) must not lock the player out of their own chat.
   */
  maxStreamsPerMember?: number;
  /** Most open streams in the process. Default 5000. */
  maxStreams?: number;
  /** A comment line is written to every stream this often, so a proxy does not drop an idle one. Default 20 000, at most 60 000. The `hello` frame announces it. */
  heartbeatMs?: number;
  /** How long a seat with no stream and no request is kept before it is released. Default 120 000. */
  seatGraceMs?: number;
  /** A stream whose sink has refused this many writes in a row is closed (the client reconnects). Default 64. */
  maxBacklog?: number;
  /** Keys the seat ids. Default: random per broadcaster. Seat ids never leave the server. */
  seatSalt?: string;
  /** Check each member name with `cw.names.check`; a refused or empty name becomes `Player N`. Default true. */
  nameCheck?: boolean;
  /** Epoch-ms clock. Default `Date.now`. */
  now?: () => number;
  /** Runs `fn` once after `ms` and returns its cancel. Default: `setTimeout` (unref'd where the runtime has it). For tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Where failures are logged (event and error class only). Default `console.warn`. */
  logger?: Logger;
}

/** @experimental */
export interface RoomBroadcaster {
  /**
   * A session for this player in this room, seating them if needed. `{ refused }` when the door is shut to them (a ban: `reason`
   * `banned`), the room is full (`full`), the process holds `maxRooms` rooms (`rooms_full`), `who` has neither an account nor a client key
   * (`unauthorized`; an address alone is never a chat identity), or something failed inside (`internal`, logged by class). The routes turn
   * `unauthorized` into 401, `full` and `rooms_full` into 429 and `internal` into 500; they are not kit refusal reasons a line can get.
   * The credential is hashed at once and kept nowhere: only the seat id (a keyed hash) is held. Synchronous; never throws.
   */
  session(roomId: string, who: RawWho, member: ChatMember): ChatSession | { refused: WireRefusal };
  /**
   * Tell the open chat boxes of this person that a notice is waiting (and refresh their restriction). Call it from `platform.notify`.
   * Takes the subject id the kit gives that hook; nothing about it is sent.
   */
  noticePending(subject: SubjectId): void;
  /** End every stream in the room (`bye`, `room_closed`), drop its history, and `cw.rooms.close(roomId)`. */
  closeRoom(roomId: string): void;
  /** End every stream (`bye`, `shutdown`), stop the timers. The broadcaster is unusable afterwards. */
  close(): void;
  /** Counts for a health probe. */
  stats(): { rooms: number; members: number; streams: number };
}

// ---- defaults and bounds -------------------------------------------------------------------------------------------------------

/**
 * The values in force when an option is left out.
 * @experimental
 */
export const ROOM_BROADCASTER_DEFAULTS = {
  historyLines: HISTORY_LINES_DEFAULT,
  historyMaxAgeMs: EVIDENCE_MAX_AGE_MS,
  maxMembers: 500,
  maxRooms: 10_000,
  maxStreamsPerMember: 3,
  maxStreams: 5000,
  heartbeatMs: 20_000,
  seatGraceMs: 120_000,
  maxBacklog: 64,
} as const;
const DEFAULTS = ROOM_BROADCASTER_DEFAULTS;

const NAME_MAX = 32;
/** The `hello` is trimmed (oldest lines first) to this many bytes of JSON: a client drops any frame over 64 KiB. */
const HELLO_MAX_BYTES = 48 * 1024;
const REF_LENGTH = 8;
const LOG_THROTTLE_MS = 60_000;

/** A whole number from `min` to `max`, else a `RangeError` that names the option and never the value. */
function whole(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`createRoomBroadcaster: ${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function fn(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'function') throw new TypeError(`createRoomBroadcaster: ${name} must be a function`);
}

const hasText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Control characters, line and paragraph separators and the bidirectional overrides: none belongs in a display name. */
const NAME_STRIP = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/gu;

/** The name a player may be shown, or null when nothing usable is left (the caller falls back to `Player N`). */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(NAME_STRIP, '').trim();
  const cut = Array.from(stripped).slice(0, NAME_MAX).join('').trim();
  return cut === '' ? null : cut;
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

// ---- state ---------------------------------------------------------------------------------------------------------------------

interface StreamRec {
  readonly member: MemberRec;
  readonly sink: ChatSink;
  closed: boolean;
  /** Writes refused in a row. */
  backlog: number;
}

interface MemberRec {
  readonly seat: string;
  name: string;
  /** The join number, for `Player N`. */
  readonly n: number;
  readonly streams: Set<StreamRec>;
  cancelGrace: (() => void) | null;
  /** The opaque tokens this player was given for the players they muted (token <-> the other player's seat). */
  readonly refByTarget: Map<string, string>;
  readonly targetByRef: Map<string, string>;
}

interface RoomRec {
  readonly id: string;
  readonly epoch: string;
  readonly ring: Ring;
  readonly members: Map<string, MemberRec>;
  /** Players who left but are still muted by someone here: their kit seat is kept so the muter can still see and undo the mute. */
  readonly ghosts: Map<string, string>;
  /** target seat -> the seats of the present players who muted them. */
  readonly holders: Map<string, Set<string>>;
  joins: number;
  /** Only for a line the kit gave no id (its evidence buffer failed): the wire id still has to be unique. */
  anonymous: number;
}

const bye = (reason: 'banned' | 'room_closed' | 'shutdown'): ChatFrame => ({ type: 'bye', reason });

/**
 * Build the broadcaster. `cw` is the kit; it must have `rooms`, `chat`, `mutes`, `reports`, `doors` and `names` (the facade). Every option
 * is validated here (`RangeError`, never echoing a value), like `playerRoutes`.
 * @experimental
 */
export function createRoomBroadcaster(cw: Chatwarden, options: RoomBroadcasterOptions = {}): RoomBroadcaster {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('createRoomBroadcaster: options must be an object');
  }
  // The restriction is read by subject (the broadcaster keeps no credential to ask with), so the kit must have the method: an older core
  // would otherwise read as "not restricted" for ever. Fail at construction, where the adopter is looking.
  const kitChat = (cw as { chat?: { restrictedBySubject?: unknown } } | null | undefined)?.chat;
  if (typeof kitChat !== 'object' || kitChat === null || typeof kitChat.restrictedBySubject !== 'function') {
    throw new TypeError('createRoomBroadcaster: the kit has no chat.restrictedBySubject; use a version of @chatwarden/core that has it');
  }
  const history = resolveHistory(options.history);
  const maxMembers = whole(options.maxMembers, 'maxMembers', DEFAULTS.maxMembers, 1, 100_000);
  const maxRooms = whole(options.maxRooms, 'maxRooms', DEFAULTS.maxRooms, 1, 10_000_000);
  const maxStreamsPerMember = whole(options.maxStreamsPerMember, 'maxStreamsPerMember', DEFAULTS.maxStreamsPerMember, 1, 100);
  const maxStreams = whole(options.maxStreams, 'maxStreams', DEFAULTS.maxStreams, 1, 10_000_000);
  const heartbeatMs = whole(options.heartbeatMs, 'heartbeatMs', DEFAULTS.heartbeatMs, 1, 60_000);
  const seatGraceMs = whole(options.seatGraceMs, 'seatGraceMs', DEFAULTS.seatGraceMs, 1, 86_400_000);
  const maxBacklog = whole(options.maxBacklog, 'maxBacklog', DEFAULTS.maxBacklog, 1, 100_000);
  if (options.seatSalt !== undefined && (typeof options.seatSalt !== 'string' || options.seatSalt === '')) {
    throw new TypeError('createRoomBroadcaster: seatSalt must be a non-empty string');
  }
  if (options.nameCheck !== undefined && typeof options.nameCheck !== 'boolean') {
    throw new TypeError('createRoomBroadcaster: nameCheck must be a boolean');
  }
  fn(options.now, 'now');
  fn(options.schedule, 'schedule');
  if (options.logger !== undefined && (typeof options.logger !== 'object' || options.logger === null || typeof options.logger.warn !== 'function')) {
    throw new TypeError('createRoomBroadcaster: logger must have a warn function');
  }
  const nameCheck = options.nameCheck !== false;
  const logger = options.logger;
  const now: () => number = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const hasher = makeHasher(options.seatSalt ?? randomHex(16));
  const broadcasterId = randomHex(4);

  const rooms = new Map<string, RoomRec>();
  let streamCount = 0;
  let epochs = 0;
  let closed = false;
  let heartbeat: (() => void) | null = null;

  // ---- logging: event and error class only, at most one line a minute per event ---------------------------------------------------

  const lastLogged = new Map<string, { at: number; held: number }>();
  function warn(event: string, err: unknown): void {
    let at = 0;
    try {
      at = now();
    } catch {
      // a broken clock must not stop the log
    }
    const seen = lastLogged.get(event);
    if (seen !== undefined && at >= seen.at && at - seen.at < LOG_THROTTLE_MS) {
      seen.held += 1;
      return;
    }
    const detail: Record<string, string | number> = { error: errorClass(err) };
    if (seen !== undefined && seen.held > 0) detail.suppressed = seen.held;
    lastLogged.set(event, { at, held: 0 });
    safeWarn(logger, event, detail);
  }

  // ---- identity ----------------------------------------------------------------------------------------------------------------

  /** `s` + a keyed hash of the account id (or else the client key). The credential is hashed at once; the id leaves no trace of it. */
  function seatOf(who: unknown): string | null {
    if (typeof who !== 'object' || who === null) return null;
    const w = who as RawWho;
    if (hasText(w.accountId)) return `s${hasher.clientKey(`account\0${w.accountId}`)}`;
    if (hasText(w.clientKey)) return `s${hasher.clientKey(`key\0${w.clientKey}`)}`;
    return null;
  }

  /** A name the game chose, cleaned and checked; null when nothing usable is left. */
  function resolveName(raw: unknown): string | null {
    const name = cleanName(raw);
    if (name === null) return null;
    if (!nameCheck) return name;
    try {
      return cw.names.check(name).ok ? name : null;
    } catch (err) {
      warn('chatwarden.chat_name_check_failed', err);
      return null;
    }
  }

  // ---- delivery ----------------------------------------------------------------------------------------------------------------

  function cancelHeartbeat(): void {
    if (heartbeat !== null) {
      heartbeat();
      heartbeat = null;
    }
  }

  /** Tell a sink the broadcaster is done with it. A throw is ignored. */
  function endSink(rec: StreamRec): void {
    try {
      rec.sink.end?.();
    } catch (err) {
      warn('chatwarden.chat_stream_failed', err);
    }
  }

  /**
   * Stop one stream. `rearm`: start the seat's grace when it was the member's last one. `ended`: the broadcaster is the one stopping it
   * (not the caller), so the sink is told. Idempotent.
   */
  function dropStream(rec: StreamRec, rearm: boolean, ended = false): void {
    if (rec.closed) return;
    rec.closed = true;
    const member = rec.member;
    member.streams.delete(rec);
    streamCount -= 1;
    if (streamCount <= 0) {
      streamCount = 0;
      cancelHeartbeat();
    }
    if (rearm && member.streams.size === 0) {
      const room = roomOf(member);
      if (room !== undefined) armGrace(room, member);
    }
    if (ended) endSink(rec);
  }

  const memberRoom = new WeakMap<MemberRec, RoomRec>();
  const roomOf = (member: MemberRec): RoomRec | undefined => memberRoom.get(member);

  /** Hand one frame (or a ping) to a stream; a throw closes that stream only, `maxBacklog` refusals in a row close it too. */
  function push(rec: StreamRec, frame: ChatFrame | null): void {
    if (rec.closed) return;
    let result: boolean | void;
    try {
      result = frame === null ? rec.sink.ping?.() : rec.sink.write(frame);
    } catch (err) {
      warn('chatwarden.chat_stream_failed', err);
      dropStream(rec, true, true);
      return;
    }
    if (result === false) {
      rec.backlog += 1;
      if (rec.backlog >= maxBacklog) dropStream(rec, true, true);
    } else {
      rec.backlog = 0;
    }
  }

  /** End a stream for good with a last frame (the room closed, the process is stopping). Writes at most once; a throw is ignored. */
  function endStream(rec: StreamRec, frame: ChatFrame): void {
    if (rec.closed) return;
    try {
      rec.sink.write(frame);
    } catch (err) {
      warn('chatwarden.chat_stream_failed', err);
    }
    dropStream(rec, false, true);
  }

  function armHeartbeat(): void {
    if (heartbeat !== null || streamCount <= 0 || closed) return;
    heartbeat = schedule(tick, heartbeatMs);
  }

  function tick(): void {
    heartbeat = null;
    if (closed) return;
    for (const room of [...rooms.values()]) {
      // The idle-room sweep: a ring is pruned when it is touched, and a quiet room's is not, so the tick touches every one.
      room.ring.size();
      for (const member of [...room.members.values()]) {
        for (const rec of [...member.streams]) {
          if (rec.sink.ping !== undefined) push(rec, null);
        }
      }
    }
    armHeartbeat();
  }

  function visible(roomId: string, viewerSeat: string, senderSeat: string): boolean {
    if (viewerSeat === senderSeat) return true;
    try {
      return cw.chat.visibleTo(roomId, viewerSeat, senderSeat);
    } catch (err) {
      // A mute is a promise to the muter: what cannot be checked is not shown.
      warn('chatwarden.chat_visibility_failed', err);
      return false;
    }
  }

  function writeAll(member: MemberRec, frame: () => ChatFrame): void {
    for (const rec of [...member.streams]) push(rec, frame());
  }

  // ---- per-viewer state --------------------------------------------------------------------------------------------------------

  /**
   * The kit's answer for this seat's player, read by the SUBJECT the kit holds for the seat: the broadcaster keeps no client key, account
   * or address to ask with. `null` when it cannot be read (a seat the kit does not know, or a failure).
   */
  function restrictionAnswer(room: RoomRec, member: MemberRec): RestrictedAnswer | null {
    try {
      const subject = cw.rooms.subjectAt(room.id, member.seat);
      if (subject === null) return null;
      return cw.chat.restrictedBySubject(subject, { roomId: room.id, seatId: member.seat });
    } catch (err) {
      warn('chatwarden.chat_restriction_failed', err);
      return null;
    }
  }

  function restrictionOf(room: RoomRec, member: MemberRec): WireRestriction | null {
    const answer = restrictionAnswer(room, member);
    if (answer === null || !answer.restricted) return null;
    // The kit says who set it only through `kind`: an automatic timeout is the filter's, everything else a moderator's.
    return { until: answer.until, byModerator: answer.kind === 'chat' || answer.kind === 'ban' };
  }

  function refFor(member: MemberRec, targetSeat: string): string {
    const known = member.refByTarget.get(targetSeat);
    if (known !== undefined) return known;
    let ref = randomToken(REF_LENGTH);
    while (member.targetByRef.has(ref)) ref = randomToken(REF_LENGTH);
    member.refByTarget.set(targetSeat, ref);
    member.targetByRef.set(ref, targetSeat);
    return ref;
  }

  function mutedSeatsOf(room: RoomRec, member: MemberRec): string[] {
    try {
      return cw.mutes.mutedSeats(room.id, member.seat);
    } catch (err) {
      warn('chatwarden.chat_mutes_failed', err);
      return [];
    }
  }

  /** Note that `viewerSeat` mutes `targetSeat`, so that seat is kept for them if its player leaves. */
  function hold(room: RoomRec, viewerSeat: string, targetSeat: string): void {
    let set = room.holders.get(targetSeat);
    if (set === undefined) {
      set = new Set();
      room.holders.set(targetSeat, set);
    }
    set.add(viewerSeat);
  }

  function unseatSeat(room: RoomRec, seat: string): void {
    try {
      cw.rooms.unseat(room.id, seat);
    } catch (err) {
      warn('chatwarden.chat_unseat_failed', err);
    }
  }

  /** `viewerSeat` no longer mutes `targetSeat`: when nobody present does, a departed player's kept seat is let go. */
  function release(room: RoomRec, viewerSeat: string, targetSeat: string): void {
    const set = room.holders.get(targetSeat);
    if (set === undefined) return;
    set.delete(viewerSeat);
    if (set.size > 0) return;
    room.holders.delete(targetSeat);
    if (room.ghosts.delete(targetSeat)) unseatSeat(room, targetSeat);
  }

  function mutedOf(room: RoomRec, member: MemberRec): WireMuted[] {
    const out: WireMuted[] = [];
    for (const seat of mutedSeatsOf(room, member)) {
      const name = room.members.get(seat)?.name ?? room.ghosts.get(seat);
      if (name === undefined) continue;
      hold(room, member.seat, seat);
      out.push({ ref: refFor(member, seat), name });
    }
    return out;
  }

  function wireLine(line: { id: string; at: number; name: string; text: string }, mine: boolean): WireLine {
    const out: WireLine = { id: line.id, at: line.at, name: line.name, text: line.text };
    if (mine) out.mine = true;
    return out;
  }

  function helloFor(room: RoomRec, member: MemberRec): ChatFrame {
    const lines: WireLine[] = [];
    for (const line of room.ring.snapshot()) {
      if (!visible(room.id, member.seat, line.seat)) continue;
      lines.push(wireLine(line, line.seat === member.seat));
    }
    const frame: ChatFrame = {
      type: 'hello',
      v: CHAT_WIRE_VERSION,
      epoch: room.epoch,
      room: room.id,
      you: { name: member.name },
      maxLength: cw.limits.chatMaxLength,
      heartbeatMs,
      summary: cw.summary,
      restriction: restrictionOf(room, member),
      lines,
      muted: mutedOf(room, member),
    };
    // A client drops any frame over 64 KiB, and then never gets a hello at all. A long line limit can make a full ring that big: keep the
    // newest lines that fit, oldest dropped first.
    const encoder = new TextEncoder();
    while (lines.length > 0 && encoder.encode(JSON.stringify(frame)).length > HELLO_MAX_BYTES) lines.shift();
    return frame;
  }

  function stateFor(room: RoomRec, member: MemberRec): ChatFrame {
    return { type: 'state', restriction: restrictionOf(room, member), muted: mutedOf(room, member) };
  }

  // ---- seats -------------------------------------------------------------------------------------------------------------------

  function armGrace(room: RoomRec, member: MemberRec): void {
    member.cancelGrace?.();
    member.cancelGrace = schedule(() => {
      member.cancelGrace = null;
      expire(room, member);
    }, seatGraceMs);
  }

  /** Release a seat whose grace ran out, unless it has a stream again by now. */
  function expire(room: RoomRec, member: MemberRec): void {
    if (closed || member.streams.size > 0) return;
    if (rooms.get(room.id) !== room || room.members.get(member.seat) !== member) return;
    removeMember(room, member);
  }

  function removeMember(room: RoomRec, member: MemberRec): void {
    member.cancelGrace?.();
    member.cancelGrace = null;
    room.members.delete(member.seat);
    memberRoom.delete(member);
    // What this player was keeping for others (the seats they muted) is let go; what others keep for them decides whether their own seat stays.
    for (const target of [...room.holders.keys()]) release(room, member.seat, target);
    if (room.members.size > 0 && (room.holders.get(member.seat)?.size ?? 0) > 0) room.ghosts.set(member.seat, member.name);
    else unseatSeat(room, member.seat);
    if (room.members.size === 0) {
      for (const seat of room.ghosts.keys()) unseatSeat(room, seat);
      room.ghosts.clear();
      room.holders.clear();
      if (rooms.get(room.id) === room) rooms.delete(room.id);
    }
  }

  /**
   * Find or make the room and the member, seat them in the kit, and refresh the grace of a member with no stream. `null` when the room is
   * full. `given` is the cleaned name the game chose, or null.
   */
  function upsert(roomId: string, seat: string, who: RawWho, given: string | null, tags: Record<string, string> | undefined): { room: RoomRec; member: MemberRec } | 'full' | 'rooms_full' | 'internal' {
    let room = rooms.get(roomId);
    let member = room?.members.get(seat);
    if (room === undefined && rooms.size >= maxRooms) return 'rooms_full';
    if (member === undefined && room !== undefined && room.members.size >= maxMembers) return 'full';
    const fresh = room === undefined;
    if (room === undefined) {
      epochs += 1;
      room = {
        id: roomId,
        epoch: `${broadcasterId}${epochs.toString(36)}`,
        ring: createRing({ lines: history.lines, maxAgeMs: history.maxAgeMs, now }),
        members: new Map(),
        ghosts: new Map(),
        holders: new Map(),
        joins: 0,
        anonymous: 0,
      };
    }
    if (member === undefined) {
      room.joins += 1;
      member = {
        seat,
        name: given ?? `Player ${room.joins}`,
        n: room.joins,
        streams: new Set(),
        cancelGrace: null,
        refByTarget: new Map(),
        targetByRef: new Map(),
      };
    } else if (given !== null) {
      member.name = given;
    }
    try {
      cw.rooms.seat(roomId, seat, who, member.name, tags);
    } catch (err) {
      warn('chatwarden.chat_seat_failed', err);
      return 'internal';
    }
    // Only now is anything kept: a refused join leaves no trace.
    if (fresh) rooms.set(roomId, room);
    if (!room.members.has(seat)) {
      room.members.set(seat, member);
      memberRoom.set(member, room);
      room.ghosts.delete(seat); // a player who comes back takes their seat over from the one kept for their muters
    }
    if (member.streams.size === 0) armGrace(room, member);
    return { room, member };
  }

  // ---- sessions ----------------------------------------------------------------------------------------------------------------

  function makeSession(roomId: string, seat: string, name: string): ChatSession {
    // The session holds no credential: once the seat is released (the grace ran out, the room closed) it has nothing to seat the player with
    // again, and answers like an unseated player. The caller makes a new session from the next request.
    /** The member again, with the grace of a player who has no stream refreshed. `null` when the seat is gone. */
    const live = (): { room: RoomRec; member: MemberRec } | null => {
      if (closed) return null;
      const room = rooms.get(roomId);
      const member = room?.members.get(seat);
      if (room === undefined || member === undefined) return null;
      if (member.streams.size === 0) armGrace(room, member);
      return { room, member };
    };
    const session: ChatSession = {
      name,

      canOpen() {
        const found = live();
        return found !== null && (found.member.streams.size >= maxStreamsPerMember || streamCount < maxStreams);
      },

      open(sink) {
        const found = live();
        if (found === null) return { refused: { reason: 'full' } };
        const { room, member } = found;
        if (typeof sink !== 'object' || sink === null || typeof sink.write !== 'function') {
          throw new TypeError('session.open: sink must have a write function');
        }
        // At the player's own limit the OLDEST stream goes (newest wins): a dead connection that nothing has told the server about must not
        // lock them out. Otherwise the process-wide limit applies.
        const oldest = member.streams.size >= maxStreamsPerMember ? member.streams.values().next().value : undefined;
        if (oldest === undefined && streamCount >= maxStreams) return { refused: { reason: 'full' } };
        if (oldest !== undefined) dropStream(oldest, false, true);
        const rec: StreamRec = { member, sink, closed: false, backlog: 0 };
        member.streams.add(rec);
        streamCount += 1;
        member.cancelGrace?.();
        member.cancelGrace = null;
        armHeartbeat();
        push(rec, helloFor(room, member));
        return {
          close: () => dropStream(rec, true),
        };
      },

      send(input): SendResult {
        const text: unknown = typeof input === 'object' && input !== null ? input.text : undefined;
        if (typeof text !== 'string') return { ok: false, refused: { reason: 'empty' } };
        const found = live();
        if (found === null) return { ok: false, refused: { reason: 'gate' } };
        const { room, member } = found;
        let result: unknown;
        try {
          result = cw.chat.accept(room.id, member.seat, text);
        } catch (err) {
          warn('chatwarden.chat_accept_failed', err);
          return { ok: false, refused: { reason: 'unknown' } };
        }
        const verdict = result as { deliver?: { lineId?: unknown; text?: unknown }; refuse?: unknown } | null;
        const delivered = verdict?.deliver;
        if (typeof delivered !== 'object' || delivered === null || typeof delivered.text !== 'string') {
          // A refusal is the author's answer only: nothing is stored, written to a stream or logged.
          return { ok: false, refused: refusalOf(verdict?.refuse) };
        }
        const id = hasText(delivered.lineId) ? delivered.lineId : `x${(room.anonymous += 1)}`;
        const at = now();
        room.ring.append({ id, at, seat: member.seat, name: member.name, text: delivered.text });
        const base = { id, at, name: member.name, text: delivered.text };
        for (const other of [...room.members.values()]) {
          if (other.streams.size === 0) continue;
          const mine = other.seat === member.seat;
          if (!mine && !visible(room.id, other.seat, member.seat)) continue;
          writeAll(other, () => ({ type: 'line', line: wireLine(base, mine) }));
        }
        return { ok: true, line: { ...wireLine(base, true), mine: true } };
      },

      mute(input): boolean {
        return session.muteResult(input).ok;
      },

      muteResult(input): MuteResult {
        const none: MuteResult = { ok: false, hiddenIds: [] };
        const found = live();
        if (found === null || typeof input !== 'object' || input === null || typeof input.on !== 'boolean') return none;
        const { room, member } = found;
        const on = input.on;
        let target: string | undefined;
        if ('lineId' in input && typeof input.lineId === 'string') {
          target = room.ring.byId(input.lineId)?.seat;
        } else if ('ref' in input && typeof input.ref === 'string') {
          const named = member.targetByRef.get(input.ref);
          // A token only ever names a seat this player has muted; anything else (another player's token, a stale one) does nothing.
          target = named !== undefined && mutedSeatsOf(room, member).includes(named) ? named : undefined;
        }
        if (target === undefined || target === member.seat || !(room.members.has(target) || room.ghosts.has(target))) return none;
        const before = mutedSeatsOf(room, member).includes(target);
        try {
          cw.mutes.set(room.id, member.seat, target, on);
        } catch (err) {
          warn('chatwarden.chat_mute_failed', err);
          return none;
        }
        const after = mutedSeatsOf(room, member).includes(target);
        if (after !== on) return none; // the kit did nothing (a seat with no person, or the viewer's list is full)
        if (on) hold(room, member.seat, target);
        else release(room, member.seat, target);
        const ids = on ? room.ring.bySeat(target).map((l) => l.id) : [];
        if (before !== after) {
          if (ids.length > 0) writeAll(member, () => ({ type: 'hide', ids: [...ids] }));
          writeAll(member, () => stateFor(room, member));
        }
        return { ok: true, hiddenIds: [...ids] };
      },

      async report(input): Promise<ReportOutcome> {
        const found = live();
        const lineId: unknown = typeof input === 'object' && input !== null ? input.lineId : undefined;
        if (found === null || !hasText(lineId)) return { ok: false, refused: 'not_found' };
        const { room, member } = found;
        const line = room.ring.byId(lineId);
        // A line the reporter cannot see (its author is muted), or one that has aged out, does not exist for them.
        if (line === undefined || !visible(room.id, member.seat, line.seat)) return { ok: false, refused: 'not_found' };
        try {
          const res = await cw.reports.submit({
            roomId: room.id,
            reporterSeat: member.seat,
            targetSeat: line.seat,
            lineId,
            ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
          });
          if (res.ok) return { ok: true, remaining: res.remaining };
          return res.remaining === undefined ? { ok: false, refused: res.refused } : { ok: false, refused: res.refused, remaining: res.remaining };
        } catch (err) {
          warn('chatwarden.chat_report_failed', err);
          return { ok: false, refused: 'off' };
        }
      },
    };
    return session;
  }

  const api: RoomBroadcaster = {
    session(roomId, who, member) {
      try {
        if (closed) return { refused: { reason: 'full' } };
        const seat = seatOf(who);
        if (seat === null || !hasText(roomId)) return { refused: { reason: 'unauthorized' } };
        const door = cw.doors.check('join', who);
        if (door !== null) return { refused: refusalOf({ reason: 'banned', until: door.until, noticeId: door.noticeId }) };
        const given = resolveName(typeof member === 'object' && member !== null ? member.name : undefined);
        const tags = typeof member === 'object' && member !== null ? member.tags : undefined;
        const found = upsert(roomId, seat, who, given, tags);
        if (typeof found === 'string') return { refused: { reason: found } };
        return makeSession(roomId, seat, found.member.name);
      } catch (err) {
        warn('chatwarden.chat_session_failed', err);
        return { refused: { reason: 'internal' } };
      }
    },

    noticePending(subject) {
      if (closed) return;
      for (const room of [...rooms.values()]) {
        for (const member of [...room.members.values()]) {
          // One bad member must not stop the others hearing it.
          try {
            if (member.streams.size === 0) continue;
            if (cw.rooms.subjectAt(room.id, member.seat) !== subject) continue;
            const answer = restrictionAnswer(room, member);
            if (answer !== null && answer.restricted && answer.kind === 'ban') {
              // A ban that lands while the player is connected ends their streams: the door refuses them from here on.
              for (const rec of [...member.streams]) endStream(rec, { type: 'bye', reason: 'banned', until: answer.until });
              // Ending streams does not start the seat's grace (it is not a close by the player): do it, so the seat, the room and the ring go.
              if (member.streams.size === 0 && room.members.get(member.seat) === member) armGrace(room, member);
              continue;
            }
            writeAll(member, () => ({ type: 'notices' }));
            writeAll(member, () => stateFor(room, member));
          } catch (err) {
            warn('chatwarden.chat_notice_failed', err);
          }
        }
      }
    },

    closeRoom(roomId) {
      const room = rooms.get(roomId);
      if (room !== undefined) {
        rooms.delete(roomId);
        for (const member of [...room.members.values()]) {
          member.cancelGrace?.();
          member.cancelGrace = null;
          for (const rec of [...member.streams]) {
            endStream(rec, bye('room_closed'));
          }
          memberRoom.delete(member);
        }
        room.members.clear();
        room.ghosts.clear();
        room.holders.clear();
      }
      try {
        cw.rooms.close(roomId);
      } catch (err) {
        warn('chatwarden.chat_close_room_failed', err);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      for (const room of [...rooms.values()]) {
        for (const member of [...room.members.values()]) {
          for (const rec of [...member.streams]) {
            endStream(rec, bye('shutdown'));
          }
          removeMember(room, member);
        }
      }
      rooms.clear();
      cancelHeartbeat();
    },

    stats() {
      let members = 0;
      for (const room of rooms.values()) members += room.members.size;
      return { rooms: rooms.size, members, streams: streamCount };
    },
  };
  inspectors.set(api, () => ({ rooms, lastLogged }));
  return api;
}

const inspectors = new WeakMap<RoomBroadcaster, () => unknown>();

/**
 * What the broadcaster holds, for a test to walk (every map and set, strings included). A seam for the test that proves it keeps no credential;
 * not part of the public surface and not re-exported from the entry.
 * @internal
 */
export function inspectBroadcaster(broadcaster: RoomBroadcaster): unknown {
  return inspectors.get(broadcaster)?.();
}
