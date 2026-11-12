// The wire types of the chat stream, copied from `@chatwarden/http/chat` so this package stays types-only toward the kit.
// `test/chat-wire.test.ts` keeps the two copies the same type and `CHAT_WIRE_VERSION` the same number.
import type { ReportRefusal } from '@chatwarden/core';

/** The version of the frames below. A change that breaks a reader raises it. */
export const CHAT_WIRE_VERSION = 1;

/** One delivered line, as a viewer sees it. No seat, no person, no hash. */
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

/** The restriction on the viewer's own chat, or null. Same meaning as `RestrictedChatLineProps`. */
export interface WireRestriction {
  /** Epoch ms it ends, or null when it does not end on its own. */
  until: number | null;
  /** True when a moderator set it; false for the automatic filter. */
  byModerator: boolean;
}

/** A player the viewer muted, by an opaque token only the viewer can use to undo it. */
export interface WireMuted {
  ref: string;
  name: string;
}

/**
 * Why a line was not sent, for its author. `reason` is one of: `length`, `rate`, `gate`, `restricted`, `blocked`, `profanity`, `banned`,
 * `empty`, and, once pacing ships, `slow_mode`, `flood`, `duplicate`. A reader treats any other string as unknown.
 * Never carries text, a handle, an id or a moderator's note.
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
  /** The server is ending this stream. `banned` carries when the ban ends. */
  | { type: 'bye'; reason: 'banned' | 'room_closed' | 'shutdown'; until?: number | null };

export type SendResult = { ok: true; line: WireLine } | { ok: false; refused: WireRefusal };
export type MuteTarget = { lineId: string } | { ref: string };
export type ReportOutcome =
  | { ok: true; remaining: number }
  | { ok: false; refused: ReportRefusal | 'not_found'; remaining?: number };

/** A name over this is cut. */
export const MAX_NAME = 64;
/** A line's text over this is cut. */
export const MAX_TEXT = 1000;
/** A frame whose JSON text is over this many bytes is dropped. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** The longest `retryAfterMs` a refusal may carry: one hour (the server's own ceiling). */
const MAX_RETRY_AFTER_MS = 3_600_000;
/** The longest heartbeat believed (the server caps its own at 60 s). */
const MAX_HEARTBEAT_MS = 3_600_000;
/** The broadcaster's default heartbeat, for a hello that does not carry a usable one. */
export const DEFAULT_HEARTBEAT_MS = 20_000;
/** A line id over this is not an id. */
const MAX_ID = 64;

type Bag = Record<string, unknown>;

/** The object behind a value, or null for anything that is not a plain JSON object (arrays, null, functions and the rest). */
const bagOf = (v: unknown): Bag | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Bag) : null);

/** An own property only: an inherited one (a polluted prototype) is never read. */
const own = (o: Bag, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The first `max` UTF-16 units, without leaving half a surrogate pair at the cut. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = s.charCodeAt(max - 1);
  return s.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

function restrictionOf(raw: unknown): WireRestriction | null | undefined {
  if (raw === null) return null;
  const o = bagOf(raw);
  if (o === null) return undefined;
  const until = own(o, 'until');
  const byModerator = own(o, 'byModerator');
  if ((until !== null && !isNum(until)) || typeof byModerator !== 'boolean') return undefined;
  return { until, byModerator };
}

function mutedOf(raw: unknown): WireMuted[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: WireMuted[] = [];
  for (const item of raw as unknown[]) {
    const o = bagOf(item);
    if (o === null) continue;
    const ref = own(o, 'ref');
    const name = own(o, 'name');
    if (isStr(ref) && ref !== '' && isStr(name)) out.push({ ref, name: cut(name, MAX_NAME) });
  }
  return out;
}

/** One line from the wire, or null when it is not a line. The name and text are cut; unknown fields are left behind. */
export function readLine(raw: unknown): WireLine | null {
  try {
    const o = bagOf(raw);
    if (o === null) return null;
    const id = own(o, 'id');
    const at = own(o, 'at');
    const name = own(o, 'name');
    const text = own(o, 'text');
    if (!isStr(id) || id === '' || id.length > MAX_ID || !isNum(at) || !isStr(name) || !isStr(text)) return null;
    const line: WireLine = { id, at, name: cut(name, MAX_NAME), text: cut(text, MAX_TEXT) };
    if (own(o, 'mine') === true) line.mine = true;
    return line;
  } catch {
    return null;
  }
}

/** The refusal in the answer to a POST, keeping only the documented fields of the right type; null when there is no reason. */
export function readRefusal(raw: unknown): WireRefusal | null {
  try {
    const o = bagOf(raw);
    if (o === null) return null;
    const reason = own(o, 'reason');
    if (!isStr(reason) || reason === '') return null;
    const out: WireRefusal = { reason: cut(reason, MAX_ID) };
    const until = own(o, 'until');
    if (until === null || isNum(until)) out.until = until;
    const byModerator = own(o, 'byModerator');
    if (typeof byModerator === 'boolean') out.byModerator = byModerator;
    const rule = own(o, 'rule');
    if (isNum(rule) && Number.isSafeInteger(rule) && rule > 0) out.rule = rule;
    const noticeId = own(o, 'noticeId');
    if (isStr(noticeId)) out.noticeId = cut(noticeId, MAX_ID);
    const retry = own(o, 'retryAfterMs');
    if (isNum(retry) && Number.isInteger(retry) && retry >= 1 && retry <= MAX_RETRY_AFTER_MS) out.retryAfterMs = retry;
    return out;
  } catch {
    return null;
  }
}

function readHello(o: Bag): ChatFrame | null {
  const epoch = own(o, 'epoch');
  const room = own(o, 'room');
  const you = bagOf(own(o, 'you'));
  const youName = you === null ? undefined : own(you, 'name');
  const maxLength = own(o, 'maxLength');
  // An older server that does not say gets the broadcaster's default.
  const sent = own(o, 'heartbeatMs');
  const heartbeat = isNum(sent) && Number.isInteger(sent) && sent >= 1 && sent <= MAX_HEARTBEAT_MS ? sent : DEFAULT_HEARTBEAT_MS;
  const summary = own(o, 'summary');
  const restriction = restrictionOf(own(o, 'restriction'));
  const lines = own(o, 'lines');
  const muted = mutedOf(own(o, 'muted'));
  if (own(o, 'v') !== CHAT_WIRE_VERSION) return null;
  if (!isStr(epoch) || !isStr(room) || !isStr(youName) || !isStr(summary)) return null;
  if (!isNum(maxLength) || !Number.isInteger(maxLength) || maxLength < 1) return null;
  if (restriction === undefined || muted === undefined || !Array.isArray(lines)) return null;
  return {
    type: 'hello',
    v: CHAT_WIRE_VERSION,
    epoch,
    room,
    you: { name: cut(youName, MAX_NAME) },
    maxLength,
    heartbeatMs: heartbeat,
    summary,
    restriction,
    lines: (lines as unknown[]).map(readLine).filter((l): l is WireLine => l !== null),
    muted,
  };
}

/**
 * A frame from parsed JSON, or null when it is not one of the six frames or a field has the wrong type. Never throws. It builds a fresh
 * object field by field from own properties, so `__proto__` and `constructor` keys never land on the result, and unknown fields
 * are left behind. A name is cut at 64 and a text at 1 000. `jsonLength` is the length of the JSON text the value came from, in bytes;
 * a frame over 64 KiB is dropped.
 */
export function readFrame(raw: unknown, jsonLength?: number): ChatFrame | null {
  try {
    if (typeof jsonLength === 'number' && jsonLength > MAX_FRAME_BYTES) return null;
    const o = bagOf(raw);
    if (o === null) return null;
    switch (own(o, 'type')) {
      case 'hello':
        return readHello(o);
      case 'line': {
        const line = readLine(own(o, 'line'));
        return line === null ? null : { type: 'line', line };
      }
      case 'hide': {
        const ids = own(o, 'ids');
        if (!Array.isArray(ids)) return null;
        return { type: 'hide', ids: (ids as unknown[]).filter((id): id is string => isStr(id) && id !== '' && id.length <= MAX_ID) };
      }
      case 'state': {
        const restriction = restrictionOf(own(o, 'restriction'));
        const muted = mutedOf(own(o, 'muted'));
        return restriction === undefined || muted === undefined ? null : { type: 'state', restriction, muted };
      }
      case 'notices':
        return { type: 'notices' };
      case 'bye': {
        const reason = own(o, 'reason');
        if (reason !== 'banned' && reason !== 'room_closed' && reason !== 'shutdown') return null;
        const until = own(o, 'until');
        if (until !== undefined && until !== null && !isNum(until)) return null;
        return until === undefined ? { type: 'bye', reason } : { type: 'bye', reason, until };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
