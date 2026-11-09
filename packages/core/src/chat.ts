import type { EvidenceBuffer, RoomRoster } from './evidence.js';
import { safeWarn } from './log.js';
import type { MuteService } from './mutes.js';
import type { NoticeService } from './notices.js';
import type { Limits } from './limits.js';
import { slidingWindow } from './rateLimit.js';
import type { SlidingWindow } from './rateLimit.js';
import { parseRuleRef } from './rules.js';
import { applySanction } from './sanctions.js';
import type { SanctionIndex } from './sanctions.js';
import type { StrikeService } from './strikes.js';
import type { SubjectIndex } from './subjects.js';
import type { ProfanityConfig } from './profile.js';
import type {
  Clock,
  Identifiers,
  Logger,
  Matcher,
  ProfanityFilter,
  ReportExcerptLine,
  Store,
  SubjectId,
} from './types.js';

// The chat acceptance pipeline: one call decides whether a line is delivered, and keeps the evidence and the
// strikes that go with the decision. The order is Moxgate's `handleChat`:
//   1. trim; empty                       -> 'empty' (the caller stays silent)
//   2. the seat's occupant, then the gate hook
//   3. active restriction                -> 'restricted' (chat, ban, or the in-memory automatic one)
//   4. length > 200                      -> 'length'
//   5. rate, 3 per 5 s per room:seat     -> 'rate' (spent even when the line is then blocked)
//   6. matcher hit                       -> buffered as blocked, one strike, maybe an automatic timeout, 'blocked'
//   7. profanity, by the profile's mode  -> allow: untouched; star: masked; refuse: 'profanity' (never a strike,
//                                           never buffered, never a notice: swearing is not a rule violation)
//   8. buffer the delivered line         -> its lineId
// It never throws. Everything on this path reads in-memory state; the only store writes are the strike
// (inside StrikeService) and the automatic timeout, and a failure of either is logged and absorbed.

/** Longest line, in characters after trimming. The default of `limits.chatMaxLength`. */
export const MAX_LEN = 200;
/** Lines allowed per rate window per `roomId:seatId`. The default of `limits.chatRate.count`. */
export const RATE_LIMIT = 3;
/** Rate window, milliseconds. The default of `limits.chatRate.windowMs`. */
export const RATE_WINDOW_MS = 5_000;

const AUTO_RESTRICT_REASON = 'auto: repeated slurs';

/** The Community Rule the automatic filter and its timeout cite unless the adopter says otherwise: CR 1 (slurs). */
const DEFAULT_AUTO_RESTRICT_RULE = 1;

/** The blocked line that earned a strike, kept for the notice an automatic timeout makes. */
interface BlockedLine {
  lineId: string;
  ts: number;
  seatId: string;
  handle: string;
  raw: string;
  audience: string[] | null;
}

/**
 * The verdict on one line. A refusal carries a reason and, for `restricted`, when it ends (`null` =
 * permanent) and whether a human moderator imposed it. `rule` is the Community Rule number it cites: the
 * automatic-filter rule (`autoRestrictRule`, CR 1 by default) for `blocked`, and for `restricted` the sanction's
 * own rule (omitted when it is `'uncovered'` or unknown; the in-memory fallback cites the automatic-filter rule). `noticeId` is the player's notice that explains a restriction, when one
 * exists. Never an identifier, a rule's private note or the matched term. `'empty'` means stay silent.
 */
export type RefuseReason = 'empty' | 'length' | 'rate' | 'gate' | 'restricted' | 'blocked' | 'profanity';

export type ChatResult =
  | { deliver: { lineId: string; text: string } }
  | {
      refuse: {
        reason: RefuseReason;
        until?: number | null;
        byModerator?: boolean;
        rule?: number;
        noticeId?: string;
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
  /**
   * The profanity filter. Used for lines the matcher did not block, as the `profanityMode` says; without one,
   * swearing is never touched. A throw (or a result that is not `{ hit: boolean, text: string }`) lets the line
   * through unchanged and is logged by class only: a broken word list must not silence chat.
   */
  profanity?: ProfanityFilter;
  /**
   * What to do with a profane line: `allow` (the filter is not called), `star` (deliver the masked text) or
   * `refuse` (refuse the line with `'profanity'`). Default `star`. The facade passes `profile.profanity.mode`.
   */
  profanityMode?: ProfanityConfig['mode'];
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
  /**
   * Told once, after the stored automatic timeout has landed (and after `onAutoRestrict`), with the sanction group
   * and its ref code. Not called when the timeout is held only in memory (a speaker with no subject, or a failed
   * write): there is no stored group to name. The facade turns it into the `auto.restricted` event. Fenced.
   */
  onAutoRestricted?: (info: { groupId: string; refCode: string; second: boolean }) => void;
  /** Defaults to `console.warn`. */
  logger?: Logger;
  /**
   * Makes the player's notice for an automatic timeout, and finds the notice a refusal points at. Optional:
   * without it no notice is made and no refusal carries a `noticeId`. A failure of either is logged and never
   * changes the verdict.
   */
  notices?: NoticeService;
  /**
   * The Community Rule the automatic filter cites: on a `blocked` refusal, on the automatic timeout it earns (the
   * stored sanction, the in-memory fallback and the player's notice). Default 1. The caller checks it is an active
   * rule; the service just cites it.
   */
  autoRestrictRule?: number;
  /**
   * The chat limits, already validated (see `resolveLimits`). Default: 200 characters and 3 lines per 5 000 ms per
   * `roomId:seatId`. The service trusts the numbers; the facade validates them.
   */
  limits?: { maxLength: Limits['chatMaxLength']; rate: Limits['chatRate'] };
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

const refuse = (
  reason: RefuseReason,
  extra?: { until?: number | null; byModerator?: boolean; rule?: number; noticeId?: string },
): ChatResult => ({ refuse: extra === undefined ? { reason } : { reason, ...extra } });

interface Restriction {
  until: number | null;
  byModerator: boolean;
  /** The stored sanction's group (null for the in-memory fallback, which has none) and its rule text. */
  groupId: string | null;
  rule: string | null;
  /** The sanction is the sender's own, not a bystander matched through a shared-IP row of another person. */
  own: boolean;
}

/** Map key for a seat. NUL cannot appear in a room or seat id the way ':' can, so keys never collide. */
const memKey = (roomId: string, seatId: string): string => `${roomId}\u0000${seatId}`;

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

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
  private readonly profanity: ProfanityFilter | undefined;
  private readonly profanityMode: ProfanityConfig['mode'];
  private readonly gate: ChatServiceDeps['gate'];
  private readonly onAutoRestrict: ChatServiceDeps['onAutoRestrict'];
  private readonly onAutoRestricted: ChatServiceDeps['onAutoRestricted'];
  private readonly logger: Logger | undefined;
  private readonly notices: NoticeService | undefined;
  private readonly autoRestrictRule: number;
  private readonly maxLength: number;
  private readonly rate: SlidingWindow;

  /**
   * Automatic restrictions that could not be stored (no subject to put a row on, or the write failed), by
   * room and seat (see `memKey`), with the epoch ms they end and the person they were earned by. The entry
   * belongs to that PERSON: it applies only while the seat's occupant is still them (two guests, both with no
   * subject, count as the same). Lost on restart, like the in-memory strikes behind them.
   */
  private memRestrictions = new Map<string, { until: number; subject: SubjectId | null }>();

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
    this.profanity = deps.profanity;
    this.profanityMode = deps.profanityMode ?? 'star';
    this.gate = deps.gate;
    this.onAutoRestrict = deps.onAutoRestrict;
    this.onAutoRestricted = deps.onAutoRestricted;
    this.logger = deps.logger;
    this.notices = deps.notices;
    this.autoRestrictRule = deps.autoRestrictRule ?? DEFAULT_AUTO_RESTRICT_RULE;
    this.maxLength = deps.limits?.maxLength ?? MAX_LEN;
    this.rate = slidingWindow({
      limit: deps.limits?.rate.count ?? RATE_LIMIT,
      windowMs: deps.limits?.rate.windowMs ?? RATE_WINDOW_MS,
      clock: deps.clock,
    });
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
    const rateKey = memKey(roomId, seatId);

    const restriction = this.activeRestriction(roomId, seatId, subject, now);
    if (restriction !== null) {
      return refuse('restricted', {
        until: restriction.until,
        byModerator: restriction.byModerator,
        ...this.pointers(restriction, subject),
      });
    }

    if (trimmed.length > this.maxLength) return refuse('length');
    // Spent even when the line is then blocked, so a flood of slurs is throttled like any flood and cannot
    // probe the term list faster than ordinary chat.
    if (!this.rate.check(rateKey)) return refuse('rate');

    const audience = opts?.audience === undefined ? null : [...opts.audience];

    const hit = this.matchTerm(trimmed);
    if (hit !== null) {
      // Kept as evidence: a report must show what was typed, not only what got through.
      let lineId = '';
      try {
        lineId = this.buffer.append(roomId, {
          ts: now,
          seatId,
          handle,
          subject,
          raw: trimmed,
          delivered: null,
          blocked: true,
          audience,
        });
      } catch (err) {
        this.warn('chat.evidence_failed', { error: errName(err) });
      }
      this.strike(roomId, seatId, subject, rateKey, hit.termId, {
        lineId,
        ts: now,
        seatId,
        handle,
        raw: trimmed,
        audience,
      });
      // Explain at the point of block: cite the automatic filter's rule.
      return refuse('blocked', { rule: this.autoRestrictRule });
    }

    // Profanity is softening or a house rule, never a violation: a refusal here is not buffered as a blocked line,
    // earns no strike, note or notice, and (the rate check having passed) has spent the line's rate budget.
    const swearing = this.applyProfanity(trimmed);
    if (swearing !== null && swearing.hit && this.profanityMode === 'refuse') return refuse('profanity');
    const delivered = swearing === null || this.profanityMode !== 'star' ? trimmed : swearing.text;
    const lineId = this.buffer.append(roomId, {
      ts: now,
      seatId,
      handle,
      subject,
      raw: trimmed,
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
      // Strictly `true`: a non-boolean (a Promise from an async gate, say) must not pass.
      return this.gate(roomId, subject) === true;
    } catch (err) {
      this.warn('chat.gate_failed', { error: errName(err) });
      return false;
    }
  }

  /** The filter's verdict, or null when there is nothing to apply (mode allow, no filter) or it failed (logged). */
  private applyProfanity(trimmed: string): { hit: boolean; text: string } | null {
    if (this.profanity === undefined || this.profanityMode === 'allow') return null;
    try {
      const result: unknown = this.profanity.apply(trimmed);
      const r = result as { hit?: unknown; text?: unknown } | null | undefined;
      if (typeof r !== 'object' || r === null || typeof r.hit !== 'boolean' || typeof r.text !== 'string') {
        throw new TypeError('profanity filter returned a malformed result');
      }
      return { hit: r.hit, text: r.text };
    } catch (err) {
      this.warn('chat.profanity_failed', { error: errName(err) });
      return null;
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
      const key = memKey(roomId, seatId);
      let best: Restriction | null = null;
      const mem = this.memRestrictions.get(key);
      if (mem !== undefined) {
        if (mem.until <= now) this.memRestrictions.delete(key);
        else if (this.samePerson(mem.subject, subject)) {
          best = { until: mem.until, byModerator: false, groupId: null, rule: String(this.autoRestrictRule), own: true };
        }
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
          best = {
            until: stored.until,
            byModerator: kind === 'ban' || !stored.automated,
            groupId: stored.groupId,
            rule: stored.rule,
            own: stored.own,
          };
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
    line: BlockedLine,
  ): void {
    try {
      const { autoRestrict } = this.strikes.record(subject, rateKey, roomId, termId, line.raw);
      if (autoRestrict === null) return;
      // The kill switch: the strike is kept and the line was blocked, but nothing is enforced, so no row is
      // written (it would go live when the switch flips back), nothing is held in memory and nobody is told.
      if (!this.sanctions.isEnabled()) return;
      this.applyTimeout(roomId, seatId, subject, autoRestrict.durationMs, autoRestrict.second === true, line);
    } catch (err) {
      this.warn('chat.strike_failed', { error: errName(err) });
    }
  }

  private applyTimeout(
    roomId: string,
    seatId: string,
    subject: SubjectId | null,
    durationMs: number,
    second: boolean,
    line: BlockedLine,
  ): void {
    // Read after the strike was written, so the restriction starts at or after every strike it consumed. The
    // strike service reads the same clock, so with one instant per call (as in tests) the two are identical;
    // after a restart a strike is counted only if it is newer than this start.
    const now = this.clock.now();
    let stored = false;
    let landed: { groupId: string; refCode: string } | null = null;
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
            rule: this.autoRestrictRule,
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
        if (found !== null && stored) {
          landed = { groupId: found.groupId, refCode: found.refCode };
          this.makeNotice(subject, found, line);
        }
      } catch (err) {
        this.warn('chat.auto_restrict_failed', { error: errName(err) });
      }
    }
    if (!stored) this.holdInMemory(memKey(roomId, seatId), subject, now, durationMs);
    try {
      const told: unknown = this.onAutoRestrict?.(subject, second);
      // An async hook is type-legal against `=> void`; its rejection must not escape as an unhandled one.
      if (isThenable(told)) {
        told.then(undefined, (err: unknown) => {
          this.warn('chat.on_auto_restrict_failed', { error: errName(err) });
        });
      }
    } catch (err) {
      this.warn('chat.on_auto_restrict_failed', { error: errName(err) });
    }
    if (landed !== null) {
      try {
        const told: unknown = this.onAutoRestricted?.({ ...landed, second });
        if (isThenable(told)) {
          told.then(undefined, (err: unknown) => {
            this.warn('chat.on_auto_restrict_failed', { error: errName(err) });
          });
        }
      } catch (err) {
        this.warn('chat.on_auto_restrict_failed', { error: errName(err) });
      }
    }
  }

  /**
   * The player's notice for the automatic timeout that was just stored: kind `chat`, citing the automatic-filter rule, with the
   * blocked line that tipped it (the notice masks the matched terms before anything is stored). Its own
   * transaction, announced to the player once it has committed. A failure is logged and absorbed: the
   * restriction stands without a notice.
   */
  private makeNotice(
    subject: SubjectId,
    found: { until: number | null; groupId: string; refCode: string },
    line: BlockedLine,
  ): void {
    const notices = this.notices;
    if (notices === undefined) return;
    try {
      const excerpt: ReportExcerptLine = {
        lineId: line.lineId,
        ts: line.ts,
        seatId: line.seatId,
        handle: line.handle,
        raw: line.raw,
        delivered: null,
        blocked: true,
        audience: line.audience,
        p: 0,
      };
      notices.createForSanction(
        { groupId: found.groupId, refCode: found.refCode, kind: 'chat', until: found.until, rule: this.autoRestrictRule, subject },
        [excerpt],
        { notify: true },
      );
    } catch (err) {
      this.warn('chat.notice_failed', { error: errName(err) });
    }
  }

  /**
   * What a `restricted` refusal adds: the rule number (only a real number; not `'uncovered'`, not a row from before
   * rules, not an unreadable value) and the id of the sender's own notice for the restriction's group. Nothing at
   * all when the restriction is not the sender's own (a shared-IP row of another person). Each is left out on its
   * own failure; this never throws.
   */
  private pointers(r: Restriction, subject: SubjectId | null): { rule?: number; noticeId?: string } {
    const out: { rule?: number; noticeId?: string } = {};
    // A bystander refused through a shared-IP row of another person is told nothing about that person.
    if (!r.own) return out;
    if (r.rule !== null) {
      try {
        const rule = parseRuleRef(r.rule);
        if (typeof rule === 'number') out.rule = rule;
      } catch (err) {
        this.warn('chat.rule_unreadable', { error: errName(err) });
      }
    }
    if (r.groupId !== null && this.notices !== undefined) {
      try {
        const id = this.notices.noticeIdForGroup(r.groupId, subject);
        if (id !== null) out.noticeId = id;
      } catch (err) {
        this.warn('chat.notice_lookup_failed', { error: errName(err) });
      }
    }
    return out;
  }

  private holdInMemory(key: string, subject: SubjectId | null, now: number, durationMs: number): void {
    for (const [k, e] of this.memRestrictions) if (e.until <= now) this.memRestrictions.delete(k);
    this.memRestrictions.set(key, { until: now + durationMs, subject });
  }

  /** Same person (merges folded in); two unknown speakers count as the same. */
  private samePerson(a: SubjectId | null, b: SubjectId | null): boolean {
    if (a === null || b === null) return a === b;
    return this.subjects.canonical(a) === this.subjects.canonical(b);
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.logger, event, detail);
  }
}
