// The wire types of the chat box (design 6.1). The client has a copy (packages/player-react/src/chat/wire.ts); a test keeps the
// two assignable. Pure types and one pure function: no state, no `node:` import, browser-safe.
import type { ReportRefusal } from '@chatwarden/core';

/**
 * The version of the frames below. A change that breaks a reader raises it.
 * @experimental
 */
export const CHAT_WIRE_VERSION = 1;

/**
 * One delivered line, as a viewer sees it. No seat, no person, no hash.
 * @experimental
 */
export interface WireLine {
  /** The room's line number (the kit's evidence line id). Unique within one `epoch`. */
  id: string;
  /** When the server accepted it, epoch ms. */
  at: number;
  /** The display name the game's `join` hook gave this player. */
  name: string;
  /** The text as delivered (after the profile's profanity mode: starred text is starred here). */
  text: string;
  /** Present and true on the viewer's own lines. */
  mine?: true;
}

/**
 * The restriction on the viewer's own chat, or null. Same meaning as `RestrictedChatLineProps`.
 * @experimental
 */
export interface WireRestriction {
  /** Epoch ms it ends, or null when it does not end on its own. */
  until: number | null;
  /**
   * True when a moderator set it; false for the automatic filter. In `hello` and `state` this is read from the kit's `restricted()`
   * answer, which says only a kind: an in-memory automatic timeout is the filter's, anything else (a stored sanction, automatic ones
   * included) reads as a moderator's. It is exact in a refusal (`WireRefusal.byModerator`), which comes from the sanction itself.
   */
  byModerator: boolean;
}

/**
 * A player the viewer muted, by an opaque token only the viewer can use to undo it.
 * @experimental
 */
export interface WireMuted {
  ref: string;
  name: string;
}

/**
 * Why a line was not sent, for its author. `reason` is one of: `length`, `rate`, `gate`, `restricted`, `blocked`, `profanity`, `banned`,
 * `empty`, and, when pacing is on (`profile.pace`, a stored layer or `cw.rooms.setPace`), `slow_mode`, `flood`, `duplicate` (these carry `retryAfterMs`). A reader treats any other string as unknown.
 * Never carries text, a handle, an id or a moderator's note.
 * @experimental
 */
export interface WireRefusal {
  reason: string;
  /** `restricted` and `banned`: epoch ms it ends, or null. */
  until?: number | null;
  byModerator?: boolean;
  /** The Community Rule number to show as "Community Rule N". */
  rule?: number;
  /** The player's own notice that explains it (look it up with the player routes). */
  noticeId?: string;
  /** `slow_mode`, `flood`, `duplicate`: when to try again, ms from the answer (a whole number, 1 or more). */
  retryAfterMs?: number;
}

/** @experimental */
export type ChatFrame =
  | {
      type: 'hello';
      v: typeof CHAT_WIRE_VERSION;
      /** Changes when the server restarts or the room is closed and reopened. */
      epoch: string;
      room: string;
      you: { name: string };
      /** The line length limit (`cw.limits.chatMaxLength`), for the input. */
      maxLength: number;
      /** How often the server sends a heartbeat comment while a stream is idle (the broadcaster's `heartbeatMs`), so a client can size its liveness watchdog from it. */
      heartbeatMs: number;
      /** `cw.summary`: the profile's one-line standard. */
      summary: string;
      /** The server's clock when this hello was written, epoch ms, so a client can read `restriction.until` (the server's time) against it whatever its own clock says. Absent from an older server. */
      now?: number;
      restriction: WireRestriction | null;
      /** Recent lines the viewer may see, oldest first. */
      lines: WireLine[];
      muted: WireMuted[];
    }
  | { type: 'line'; line: WireLine }
  /** Lines to remove from view (the viewer muted their author). */
  | { type: 'hide'; ids: string[] }
  /** The viewer's own state changed (a sanction landed, a mute was made from another tab). */
  | { type: 'state'; restriction: WireRestriction | null; muted: WireMuted[] }
  /** A notice is waiting for this player: ask the player routes for it. Carries nothing else. */
  | { type: 'notices' }
  /**
   * The server is ending this stream. `banned` carries when the ban ends. `replaced`: this player opened more streams than `maxStreamsPerMember`
   * allows and this was the oldest, so a client treats it as closed and does not reconnect by itself (a flap loop between tabs otherwise).
   */
  | { type: 'bye'; reason: 'banned' | 'room_closed' | 'shutdown' | 'replaced'; until?: number | null };

/** @experimental */
export type SendResult = { ok: true; line: WireLine } | { ok: false; refused: WireRefusal };
/** @experimental */
export type MuteTarget = { lineId: string } | { ref: string };
/**
 * The answer to a mute. `ok`: the kit holds the mute (or the unmute) now. `hiddenIds`: when it muted, the ids of the muted player's lines that are
 * still in the room's history, oldest first (the same ids as the `hide` frame), so a client can hide exactly those without waiting for the
 * stream; empty for an unmute and for anything that did nothing. At most the history size.
 * @experimental
 */
export type MuteResult = { ok: boolean; hiddenIds: string[] };
/** @experimental */
export type ReportOutcome =
  | { ok: true; remaining: number }
  | { ok: false; refused: ReportRefusal | 'not_found'; remaining?: number };

/** The longest `retryAfterMs` a refusal may carry: one hour. */
const RETRY_AFTER_MAX_MS = 3_600_000;
/** The longest `noticeId` a refusal may carry. */
const NOTICE_ID_MAX = 64;
/** The longest `reason` a refusal may carry: the most a client reads. A longer one is not a reason, so it is `unknown`. */
const REASON_MAX = 64;

/** An own, readable property of `source`, or `undefined`. A getter or a proxy that throws reads as absent. */
function ownField(source: object, key: string): unknown {
  try {
    return Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The refusal a player may be told, built from whatever the check returned. Copies `reason`, `until`, `byModerator`, `rule`, `noticeId`
 * and `retryAfterMs` by name, each only when it has the right shape; every other key is dropped, so text, a seat, a subject or a handle
 * that rode along on the core refusal can never reach the wire. Never throws: anything that is not an object, or a field that cannot be
 * read, is simply absent, and a missing, non-string or over-long (more than 64 characters) `reason` is `"unknown"`.
 * @experimental
 */
export function refusalOf(refuse: unknown): WireRefusal {
  if (typeof refuse !== 'object' || refuse === null) return { reason: 'unknown' };
  const reason = ownField(refuse, 'reason');
  const out: WireRefusal = { reason: typeof reason === 'string' && reason.length <= REASON_MAX ? reason : 'unknown' };
  const until = ownField(refuse, 'until');
  if (until === null || (typeof until === 'number' && Number.isFinite(until))) out.until = until;
  const byModerator = ownField(refuse, 'byModerator');
  if (typeof byModerator === 'boolean') out.byModerator = byModerator;
  const rule = ownField(refuse, 'rule');
  if (typeof rule === 'number' && Number.isSafeInteger(rule) && rule > 0) out.rule = rule;
  const noticeId = ownField(refuse, 'noticeId');
  if (typeof noticeId === 'string' && noticeId.length <= NOTICE_ID_MAX) out.noticeId = noticeId;
  const retryAfterMs = ownField(refuse, 'retryAfterMs');
  if (typeof retryAfterMs === 'number' && Number.isInteger(retryAfterMs) && retryAfterMs >= 1 && retryAfterMs <= RETRY_AFTER_MAX_MS) {
    out.retryAfterMs = retryAfterMs;
  }
  return out;
}
