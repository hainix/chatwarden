import type { EvidenceBuffer, RoomRoster } from './evidence.js';
import type { MuteService } from './mutes.js';
import { slidingWindow } from './rateLimit.js';
import type { SlidingWindow } from './rateLimit.js';
import { applySanction } from './sanctions.js';
import type { SanctionIndex } from './sanctions.js';
import { REPEAT_RESTRICT_MS } from './strikes.js';
import type { StrikeService } from './strikes.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Identifiers, Logger, Matcher, Store, SubjectId } from './types.js';

// The chat acceptance pipeline: one call decides whether a line is delivered, and keeps the evidence and the
// strikes that go with the decision. The order is Moxgate's `handleChat`:
//   1. trim; empty                       -> 'empty' (the caller stays silent)
//   2. the seat's occupant, then the gate hook
//   3. active restriction                -> 'restricted' (chat, ban, or the in-memory automatic one)
//   4. length > 200                      -> 'length'
//   5. rate, 3 per 5 s per room:seat     -> 'rate' (spent even when the line is then blocked)
//   6. matcher hit                       -> buffered as blocked, one strike, maybe an automatic timeout, 'blocked'
//   7. starring
//   8. buffer the delivered line         -> its lineId
// It never throws. Everything on this path reads in-memory state; the only store writes are the strike
// (inside StrikeService) and the automatic timeout, and a failure of either is logged and absorbed.

/** Longest line, in characters after trimming. */
const MAX_LEN = 200;
/** Lines allowed per rate window per `roomId:seatId`. */
const RATE_LIMIT = 3;
/** Rate window, milliseconds. */
const RATE_WINDOW_MS = 5_000;

const AUTO_RESTRICT_REASON = 'auto: repeated slurs';

/** Optional profanity starring, injected. Applied to lines that were not blocked. */
export interface Starrer {
  star(text: string): string;
}

/**
 * The verdict on one line. A refusal carries a reason and, for `restricted`, when it ends (`null` =
 * permanent) and whether a human moderator imposed it. Never an identifier, a rule's private note or the
 * matched term. `'empty'` means stay silent.
 */
export type ChatResult =
  | { deliver: { lineId: string; text: string } }
  | {
      refuse: {
        reason: 'empty' | 'length' | 'rate' | 'gate' | 'restricted' | 'blocked';
        until?: number | null;
        byModerator?: boolean;
      };
    };

export interface ChatServiceDeps {
  roster: RoomRoster;
  buffer: EvidenceBuffer;
  subjects: SubjectIndex;
  sanctions: SanctionIndex;
  store: Store;
  strikes: StrikeService;
  mutes: MuteService;
  clock: Clock;
  /** Without one, nothing is ever blocked. */
  matcher?: Matcher;
  starrer?: Starrer;
  /**
   * Who may chat: false refuses the line with `'gate'`. Called with the room and the sender's subject (null
   * when the speaker is not a known person). A throw refuses too (fail closed).
   */
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
  /**
   * Told once when a blocked line earned `subject` an automatic timeout; `second` is true for the 24 h repeat
   * penalty. Not called while sanctions are switched off. A throw is logged and swallowed.
   */
  onAutoRestrict?: (subject: SubjectId | null, second: boolean) => void;
  /** Defaults to `console.warn`. */
  logger?: Logger;
}

const defaultLogger: Logger = {
  warn(event, detail) {
    if (detail === undefined) console.warn(event);
    else console.warn(event, detail);
  },
};

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

const refuse = (
  reason: 'empty' | 'length' | 'rate' | 'gate' | 'restricted' | 'blocked',
  extra?: { until: number | null; byModerator: boolean },
): ChatResult => ({ refuse: extra === undefined ? { reason } : { reason, ...extra } });

interface Restriction {
  until: number | null;
  byModerator: boolean;
}

/** `a` lasts at least as long as `b` (permanent beats timed). */
const lastsAtLeast = (a: number | null, b: number | null): boolean => {
  if (a === null) return true;
  if (b === null) return false;
  return a >= b;
};

export class ChatService {
  private readonly roster: RoomRoster;
  private readonly buffer: EvidenceBuffer;
  private readonly subjects: SubjectIndex;
  private readonly sanctions: SanctionIndex;
  private readonly store: Store;
  private readonly strikes: StrikeService;
  private readonly mutes: MuteService;
  private readonly clock: Clock;
  private readonly matcher: Matcher | undefined;
  private readonly starrer: Starrer | undefined;
  private readonly gate: ChatServiceDeps['gate'];
  private readonly onAutoRestrict: ChatServiceDeps['onAutoRestrict'];
  private readonly logger: Logger;
  private readonly rate: SlidingWindow;

  /**
   * Automatic restrictions that could not be stored (no subject to put a row on, or the write failed), by
   * `roomId:seatId`, to the epoch ms they end. Lost on restart, like the in-memory strikes behind them.
   */
  private memRestrictions = new Map<string, number>();

  constructor(deps: ChatServiceDeps) {
    this.roster = deps.roster;
    this.buffer = deps.buffer;
    this.subjects = deps.subjects;
    this.sanctions = deps.sanctions;
    this.store = deps.store;
    this.strikes = deps.strikes;
    this.mutes = deps.mutes;
    this.clock = deps.clock;
    this.matcher = deps.matcher;
    this.starrer = deps.starrer;
    this.gate = deps.gate;
    this.onAutoRestrict = deps.onAutoRestrict;
    this.logger = deps.logger ?? defaultLogger;
    this.rate = slidingWindow({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS, clock: deps.clock });
  }

  /**
   * Decide one line. Never throws: an unexpected internal failure is logged (event and error class only)
   * and the line is refused with `'gate'`, the one reason that means "you cannot chat right now".
   */
  accept(roomId: string, seatId: string, text: string, opts?: { audience?: string[] }): ChatResult {
    try {
      return this.run(roomId, seatId, text, opts);
    } catch (err) {
      this.warn('chat.accept_failed', { error: errName(err) });
      return refuse('gate');
    }
  }

  /**
   * Should `viewerSeat` be shown a line `senderSeat` sent? The sender's own seat always sees it. Otherwise the
   * line is hidden when the viewer's current occupant has muted the sender's current occupant. Any internal
   * error means visible: a broken mute store must not silence a room.
   */
  visibleTo(roomId: string, viewerSeat: string, senderSeat: string): boolean {
    if (viewerSeat === senderSeat) return true;
    try {
      const viewer = this.roster.occupant(roomId, viewerSeat);
      const sender = this.roster.occupant(roomId, senderSeat);
      if (viewer === null || sender === null) return true;
      return !this.mutes.isMuted(viewer.subject, sender.subject);
    } catch (err) {
      this.warn('chat.visibility_failed', { error: errName(err) });
      return true;
    }
  }

  // --- internals -----------------------------------------------------------

  private run(roomId: string, seatId: string, text: string, opts?: { audience?: string[] }): ChatResult {
    if (typeof text !== 'string') return refuse('empty');
    const trimmed = text.trim();
    if (trimmed.length === 0) return refuse('empty');

    // An unknown seat or an empty one has no speaker to attribute the line to: refuse it as 'gate'.
    const occupant = this.roster.occupant(roomId, seatId);
    if (occupant === null) return refuse('gate');
    const { subject, handle } = occupant;
    if (!this.gateAllows(roomId, subject)) return refuse('gate');

    const now = this.clock.now();
    const rateKey = `${roomId}:${seatId}`;

    const restriction = this.activeRestriction(roomId, seatId, subject, now);
    if (restriction !== null) {
      return refuse('restricted', { until: restriction.until, byModerator: restriction.byModerator });
    }

    if (trimmed.length > MAX_LEN) return refuse('length');
    // Spent even when the line is then blocked, so a flood of slurs is throttled like any flood and cannot
    // probe the term list faster than ordinary chat.
    if (!this.rate.check(rateKey)) return refuse('rate');

    const audience = opts?.audience === undefined ? null : [...opts.audience];

    const hit = this.matchTerm(trimmed);
    if (hit !== null) {
      // Kept as evidence: a report must show what was typed, not only what got through.
      try {
        this.buffer.append(roomId, {
          ts: now,
          seatId,
          handle,
          subject,
          raw: text,
          delivered: null,
          blocked: true,
          audience,
        });
      } catch (err) {
        this.warn('chat.evidence_failed', { error: errName(err) });
      }
      this.strike(roomId, seatId, subject, rateKey, hit.termId, text);
      return refuse('blocked');
    }

    const delivered = this.starrer === undefined ? trimmed : this.starrer.star(trimmed);
    const lineId = this.buffer.append(roomId, {
      ts: now,
      seatId,
      handle,
      subject,
      raw: text,
      delivered,
      blocked: false,
      audience,
    });
    return { deliver: { lineId, text: delivered } };
  }

  /** The gate hook; a throw is a refusal (it is access control, so it fails closed). */
  private gateAllows(roomId: string, subject: SubjectId | null): boolean {
    if (this.gate === undefined) return true;
    try {
      return this.gate(roomId, subject);
    } catch (err) {
      this.warn('chat.gate_failed', { error: errName(err) });
      return false;
    }
  }

  /** A matcher failure lets the line through (logged): a broken term list must not silence chat. */
  private matchTerm(trimmed: string): { termId: string } | null {
    if (this.matcher === undefined) return null;
    try {
      return this.matcher.match(trimmed);
    } catch (err) {
      this.warn('chat.matcher_failed', { error: errName(err) });
      return null;
    }
  }

  /**
   * The longest of the stored chat restriction, the stored full ban and the in-memory automatic one
   * (permanent beats timed; on a tie the stored one wins, as it is the one a moderator can see and revoke).
   * A ban counts because a connection opened before the ban keeps its seat. Null while sanctions are off. A
   * failure is logged and reads as "not restricted".
   */
  private activeRestriction(roomId: string, seatId: string, subject: SubjectId | null, now: number): Restriction | null {
    try {
      // The kill switch silences the in-memory restrictions too: they are sanctions, just never stored.
      if (!this.sanctions.isEnabled()) return null;
      const key = `${roomId}:${seatId}`;
      let best: Restriction | null = null;
      const memUntil = this.memRestrictions.get(key);
      if (memUntil !== undefined) {
        if (memUntil <= now) this.memRestrictions.delete(key);
        else best = { until: memUntil, byModerator: false };
      }
      // Only the latest IP of a seated person is known; an IP row speed-bumps them, never links two people.
      const ids: Identifiers = {
        clientKey: null,
        accountId: null,
        ipHash: subject === null ? null : this.subjects.latestIp(subject),
      };
      for (const kind of ['chat', 'ban'] as const) {
        const stored = this.sanctions.active(kind, ids, subject, now);
        if (stored === null) continue;
        if (best === null || lastsAtLeast(stored.until, best.until)) {
          best = { until: stored.until, byModerator: kind === 'ban' || !stored.automated };
        }
      }
      return best;
    } catch (err) {
      this.warn('chat.restriction_failed', { error: errName(err) });
      return null;
    }
  }

  /**
   * Counts a blocked line and, when it earns one, applies the automatic timeout. Never throws: the sender
   * must still get their refusal, and a broken store must not take the chat path down with it.
   */
  private strike(
    roomId: string,
    seatId: string,
    subject: SubjectId | null,
    rateKey: string,
    termId: string,
    rawLine: string,
  ): void {
    try {
      const { autoRestrict } = this.strikes.record(subject, rateKey, roomId, termId, rawLine);
      if (autoRestrict === null) return;
      // The kill switch: the strike is kept and the line was blocked, but nothing is enforced, so no row is
      // written (it would go live when the switch flips back), nothing is held in memory and nobody is told.
      if (!this.sanctions.isEnabled()) return;
      this.applyTimeout(roomId, seatId, subject, autoRestrict.durationMs);
    } catch (err) {
      this.warn('chat.strike_failed', { error: errName(err) });
    }
  }

  private applyTimeout(roomId: string, seatId: string, subject: SubjectId | null, durationMs: number): void {
    // Read after the strike was written, so the restriction starts at or after every strike it consumed. The
    // strike service reads the same clock, so with one instant per call (as in tests) the two are identical;
    // after a restart a strike is counted only if it is newer than this start.
    const now = this.clock.now();
    let stored = false;
    if (subject !== null) {
      try {
        // The store write and the index update both happen synchronously, before this returns its promise.
        applySanction(
          this.store,
          this.subjects,
          {
            kind: 'chat',
            subject,
            includeIp: false,
            durationMs,
            reason: AUTO_RESTRICT_REASON,
            actor: 'auto',
            source: 'auto_filter',
            automated: true,
          },
          now,
          this.sanctions,
        ).catch((err: unknown) => {
          this.warn('chat.auto_restrict_failed', { error: errName(err) });
        });
        // Did it land? The index now holds an automated chat row ending exactly where ours does. (A failed
        // write leaves the index untouched; an older, longer restriction cannot match by accident.)
        const none: Identifiers = { clientKey: null, accountId: null, ipHash: null };
        const found = this.sanctions.active('chat', none, subject, now);
        stored = found !== null && found.automated && found.until === now + durationMs;
      } catch (err) {
        this.warn('chat.auto_restrict_failed', { error: errName(err) });
      }
    }
    if (!stored) this.holdInMemory(`${roomId}:${seatId}`, now, durationMs);
    try {
      this.onAutoRestrict?.(subject, durationMs >= REPEAT_RESTRICT_MS);
    } catch (err) {
      this.warn('chat.on_auto_restrict_failed', { error: errName(err) });
    }
  }

  private holdInMemory(key: string, now: number, durationMs: number): void {
    for (const [k, until] of this.memRestrictions) if (until <= now) this.memRestrictions.delete(k);
    this.memRestrictions.set(key, now + durationMs);
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    try {
      this.logger.warn(event, detail);
    } catch {
      // A broken logger must not break chat.
    }
  }
}
