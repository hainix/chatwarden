import type { EvidenceBuffer, RoomRoster } from './evidence.js';
import { filtersActive } from './filters.js';
import type { ResolvedFilters } from './filters.js';
import { evaluateFilters } from './filters/engine.js';
import type { FilterHit, FilterVerdict } from './filters/engine.js';
import { maskSpans } from './mask.js';
import { errorClass, safeWarn, ThrottledWarn } from './log.js';
import type { MuteService } from './mutes.js';
import type { NoticeService } from './notices.js';
import type { PaceReason, ResolvedPace } from './pace.js';
import type { Phrase } from './phrases.js';
import { createPacer } from './pacing.js';
import type { PaceKey, Pacer } from './pacing.js';
import type { Limits } from './limits.js';
import { slidingWindow } from './rateLimit.js';
import type { RoomModeState } from './roomModes.js';
import type { ResolvedRooms } from './roomSettings.js';
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
//   2. the seat's occupant, then the gate hook, then the room's context (a tag the profile does not declare -> 'gate', fail closed)
//   2b. phrase rooms (a context with `chat.phrases`): text -> 'phrases_only'; `acceptPhrase` in any other room -> 'gate', an id the book lacks -> 'phrase_unknown'
//       (a pause, never a sanction: no strike, not kept, spends nothing). A phrase line then takes steps 3, 4b, 4c, 5, 6, 7 and 11 only: no length check, no matcher, no filters, no profanity (the book is trusted text).
//   3. active restriction                -> 'restricted' (chat, ban, or the in-memory automatic one)
//   4. length > 200                      -> 'length'
//   4b. the room's mode (staff exempt)   -> 'locked' | 'new_account' (a pause for the room, never a sanction: no strike, not kept, spends nothing; before pacing and the matcher)
//   4c. the context's minAccountAgeDays  -> 'account_too_new' (a young, unknown or guest account; staff exempt; no strike, spends nothing)
//   5. pacing, when configured           -> 'slow_mode' | 'flood' | 'duplicate' (read only: a refusal writes nothing and
//                                           spends nothing; it carries `retryAfterMs`)
//   6. rate, 3 per 5 s per room:seat     -> 'rate' (spent even when the line is then blocked)
//   7. pacing commit                     -- only now does the line count toward the next pacing check
//   8. matcher hit                       -> buffered as blocked, one strike, maybe an automatic timeout, 'blocked'
//   9. filters, when any block is on     -> refuse: 'link' | 'personal_info' | 'filter' (never a strike, never buffered, never
//                                           a notice); mask: the covered text becomes `*`; flag and count only report. Fail open.
//  10. profanity, by the profile's mode  -> allow: untouched; star: masked; refuse: 'profanity' (never a strike,
//                                           never buffered, never a notice: swearing is not a rule violation)
//  11. buffer the delivered line         -> its lineId, then a `flag` hands the line to `onFilterFlag`
// It never throws. Everything on this path reads in-memory state; the only store writes are the strike
// (inside StrikeService) and the automatic timeout, and a failure of either is logged and absorbed.

/** The most rooms whose unknown context is remembered as logged; past it the memory is cleared, so a flood of typos cannot grow it. */
const UNKNOWN_LOGGED_MAX = 10_000;

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
 *
 * `'slow_mode'`, `'flood'` and `'duplicate'` are pacing refusals and only ever appear once pacing is configured (`profile.pace`, a
 * stored layer or `cw.rooms.setPace`). They carry `retryAfterMs` and nothing else: a pause, not a sanction, so no rule, notice or end
 * time, and never the line.
 *
 * `'phrases_only'` and `'phrase_unknown'` belong to phrase-only rooms (a context with `chat.phrases`): typed text there is `phrases_only`, and an id the room's book lacks (or any `acceptPhrase` in a room that is not phrase-only is `'gate'`) is
 * `phrase_unknown`. Both are pauses: no strike, nothing kept, nothing spent. `'account_too_new'` is a context's least account age.
 *
 * `'link'`, `'personal_info'` and `'filter'` are chat-filter refusals (`profile.filters`) and only ever appear once a filter rule says `refuse`.
 * They carry the Community Rule the rule cites (`rule`) and nothing else: never the matched part, the rule's id or a counter. `'filter'` is what a
 * phrase rule or a ratio rule (caps, repeats, emoji, mentions) answers. The line was not delivered, not kept and earned no strike.
 *
 * `'locked'` and `'new_account'` are a room's mode (`cw.rooms.setMode`): a locked room takes lines from staff only, and an emergency room is read-only for an account younger than
 * `rooms.emergency.newAccountDays`. Both carry `until`, when the mode ends, and nothing else. They are checked after the person's own restriction and the length, and before pacing, the rate
 * budget and the matcher: a line refused for the mode is never matched, earns no strike, is not kept and spends nothing.
 */
export type RefuseReason = 'empty' | 'length' | 'rate' | 'gate' | 'restricted' | 'blocked' | 'profanity' | PaceReason | 'link' | 'personal_info' | 'filter' | 'locked' | 'new_account' | 'account_too_new' | 'phrases_only' | 'phrase_unknown';

export type ChatResult =
  | {
      deliver: {
        lineId: string;
        text: string;
        /** The phrase's id, for a line sent with `acceptPhrase`: `text` is then the phrase's canonical text. Absent on a typed line. */
        phrase?: string;
      };
    }
  | {
      refuse: {
        reason: RefuseReason;
        until?: number | null;
        byModerator?: boolean;
        rule?: number;
        noticeId?: string;
        /** Present for `slow_mode`, `flood` and `duplicate`: when the same player may try again, in ms from now (a whole number, at least 1). */
        retryAfterMs?: number;
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
  onAutoRestricted?: (info: { groupId: string; refCode: string; second: boolean; subject: SubjectId }) => void;
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
  /**
   * Pacing: slow mode, a burst limit and repeat refusal. `settings` is read on every line (so a saved change applies at once) and
   * answers every check off for a room that is not paced: such a line builds no key and makes no `canonical` call, and keeps no state.
   * `canonical` folds a merged subject into the person the state is kept under. `onFlood` is told once per burst window when a known person trips the burst
   * limit; a throw from it is logged by class and absorbed. Without `pace` nothing is paced.
   */
  pace?: {
    settings: (roomId: string) => ResolvedPace;
    /** The longest probation floor in force (0 when probation is off), so the pacer keeps a probationer's state that long. */
    floorMax?: () => number;
    /** The pacer to use (the shared pacer, with its state in the store). Without one the in-memory pacer is built. */
    pacer?: Pacer;
    canonical: (subject: SubjectId) => SubjectId;
    onFlood?: (info: { roomId: string; subject: SubjectId }) => void;
  };
  /**
   * The chat filters. `settings` is read on every line (so a saved change applies at once) and answers every block off for a room that is
   * not filtered: such a line builds nothing and calls nothing else. `accountIsNew(subject, days)` says whether the speaker's account is younger
   * than `days` (called only for an unlisted link, and only when `newAccountDays` is set; a throw or anything but `true` reads as not new).
   * `count` is told of every hit, whatever happens to the line. Every hook is fenced: a throw is logged by class (at most once a minute) and
   * the line goes on, unfiltered when the engine itself failed. Without `filters` nothing is filtered.
   */
  filters?: {
    settings: (roomId: string) => ResolvedFilters;
    accountIsNew?: (subject: SubjectId | null, days: number) => boolean;
    count: (hit: FilterHit) => void;
  };
  /**
   * Told once, after a delivered line has been kept, when a filter rule says `flag`: the first flagging hit in the fixed order, the line's id
   * and the speaker. Never called for a guest (no subject), for a refused line or for a line with no flag. A throw or a rejection is logged
   * by class and dropped.
   */
  onFilterFlag?: (info: { roomId: string; seatId: string; subject: SubjectId; lineId: string; hit: FilterHit }) => void;
  /**
   * The daily line counter (`desk.insights`): told once per `accept` result, after the verdict is made, with `delivered` or `refused` (an empty line is not a line and is not told).
   * A throw is logged by class and dropped; the answer never waits for it and never changes.
   */
  counter?: { delivered(): void; refused(): void };
  /**
   * Room modes (`cw.rooms.setMode`). `state` is the mode in force for a room with its expiry applied (read on every line), `settings` the `rooms` section in force and `accountAge` the age in
   * days of a person's account, or null when unknown (a guest, no hook, a throw). Without `rooms` no room has a mode.
   */
  rooms?: {
    state: (roomId: string) => RoomModeState;
    settings: () => ResolvedRooms;
    accountAge: (subject: SubjectId | null) => number | null;
  };
  /**
   * Room contexts (`profile.contexts`). `rules` is read on every line: `null` for a room that runs on the base (no `context` tag, or a context
   * that sets no chat-time rule), the room's own rules, or `'unknown'` for a tag the profile does not declare, which refuses every line `gate`
   * (fail closed) and logs `chatwarden.context_unknown` once per room. A throw refuses `gate` too. The room's pace and filters come from the
   * `pace.settings` and `filters.settings` getters, which take the room. Without `contexts` every room is the base.
   */
  contexts?: {
    rules: (roomId: string) => RoomChatRules | 'unknown' | null;
  };
}

/** What a room's context decides on the chat path itself: the profanity handling and the least account age. */
export interface RoomChatRules {
  /** The profanity mode in force for the room. */
  profanityMode: ProfanityConfig['mode'];
  /** The filter for that mode (the context's own word lists), or undefined for none. */
  profanity: ProfanityFilter | undefined;
  /** A player whose account is younger, or whose age is not known, is refused `account_too_new`. `null`: no rule. */
  minAccountAgeDays: number | null;
  /** The room's phrase book, by phrase id: the room is phrase-only. `null`: free text. */
  phrases: ReadonlyMap<string, Phrase> | null;
}

/** What pacing says about a line: a refusal, or the key to commit under; neither when nothing is paced. */
interface Paced {
  refusal: ChatResult | null;
  key: PaceKey | null;
  /** The probation floor this line was checked with, to commit under the same one. */
  floor?: number;
}
const NOT_PACED: Paced = Object.freeze({ refusal: null, key: null });

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

const refuse = (
  reason: RefuseReason,
  extra?: { until?: number | null; byModerator?: boolean; rule?: number; noticeId?: string; retryAfterMs?: number },
): ChatResult => ({ refuse: extra === undefined ? { reason } : { reason, ...extra } });

interface Restriction {
  until: number | null;
  byModerator: boolean;
  /** The stored sanction's group (null for the in-memory fallback, which has none) and its rule text. */
  groupId: string | null;
  rule: string | null;
  /** The sanction is the sender's own, not a bystander matched through a shared-IP row of another person. */
  own: boolean;
  /** A full ban, a moderator's chat restriction, or an automatic one (stored or in memory). */
  kind: 'chat' | 'ban' | 'auto';
}

/**
 * What {@link ChatService.restricted} answers. `until` is the epoch ms the restriction ends (`null` = permanent, or
 * unknown), `kind` what it is. Both are `null` when the restriction is not the person's own (a shared-IP row of
 * someone else's sanction): they are restricted, and are told nothing about the other person.
 */
export interface RestrictedAnswer {
  restricted: boolean;
  until: number | null;
  kind: 'chat' | 'ban' | 'auto' | null;
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
  /** The typing lookup runs at keystroke rate: its failure line is limited to one a minute. */
  private readonly typingWarn: ThrottledWarn;
  /** Pacing runs on every line: a failure of it is limited to one log line a minute. */
  private readonly paceWarn: ThrottledWarn;
  private readonly pacer: Pacer | undefined;
  private readonly pace: ChatServiceDeps['pace'];
  private readonly filters: ChatServiceDeps['filters'];
  private readonly onFilterFlag: ChatServiceDeps['onFilterFlag'];
  private readonly counter: ChatServiceDeps['counter'];
  private readonly rooms: ChatServiceDeps['rooms'];
  private readonly contexts: ChatServiceDeps['contexts'];
  /** Rooms whose unknown context has been logged: one line per room, not per line. */
  private readonly unknownLogged = new Set<string>();
  /** The filters run on every line: a failure of them is limited to one log line a minute. */
  private readonly filterWarn: ThrottledWarn;

  /**
   * Automatic restrictions that could not be stored (no subject to put a row on, or the write failed), by
   * room and seat (see `memKey`), with the epoch ms they end and the person they were earned by. The entry
   * belongs to that PERSON: it applies only while the seat's occupant is still them (two guests, both with no
   * subject, count as the same). Lost on restart, like the in-memory strikes behind them.
   */
  private memRestrictions = new Map<string, { until: number; subject: SubjectId | null }>();

  /** Forget what this service holds about these people (their whole alias set): pacing state and automatic restrictions kept only in memory. Used when a person is erased. */
  forgetPeople(people: ReadonlySet<SubjectId>): void {
    this.pacer?.forgetPeople(people);
    for (const [key, entry] of [...this.memRestrictions]) if (entry.subject !== null && people.has(entry.subject)) this.memRestrictions.delete(key);
  }

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
    this.typingWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.paceWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.pace = deps.pace;
    this.filters = deps.filters;
    this.onFilterFlag = deps.onFilterFlag;
    this.counter = deps.counter;
    this.rooms = deps.rooms;
    this.contexts = deps.contexts;
    this.filterWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.pacer = deps.pace === undefined ? undefined : (deps.pace.pacer ?? createPacer({ clock: deps.clock, settings: deps.pace.settings, ...(deps.pace.floorMax === undefined ? {} : { floorMax: deps.pace.floorMax }) }));
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
  accept(roomId: string, seatId: string, text: string, opts?: { audience?: string[]; staff?: boolean }): ChatResult {
    return this.decide(roomId, seatId, { text }, opts);
  }

  /**
   * Decide one phrase from the room's book (a phrase-only room, `chat.phrases`): the same pipeline as {@link accept} without the text steps (no length check, no matcher, no filters, no profanity: the book is trusted text, checked
   * when the kit started). The line is kept as evidence with `raw` equal to the phrase's canonical text and delivered as that text with `phrase` set. In a room that is not phrase-only the answer is `gate`; an id the book lacks (or
   * that is not a string) is `phrase_unknown`, spending nothing. Never throws.
   */
  acceptPhrase(roomId: string, seatId: string, phraseId: string, opts?: { audience?: string[]; staff?: boolean }): ChatResult {
    return this.decide(roomId, seatId, { phrase: phraseId }, opts);
  }

  private decide(roomId: string, seatId: string, input: { text: unknown } | { phrase: unknown }, opts?: { audience?: string[]; staff?: boolean }): ChatResult {
    let result: ChatResult;
    try {
      result = this.run(roomId, seatId, input, opts);
    } catch (err) {
      this.warn('chat.accept_failed', { error: errName(err) });
      result = refuse('gate');
    }
    this.count(result);
    return result;
  }

  /** Tell the line counter, once, what became of a line. Never throws. */
  private count(result: ChatResult): void {
    if (this.counter === undefined) return;
    try {
      if ('deliver' in result) this.counter.delivered();
      else if (result.refuse.reason !== 'empty') this.counter.refused();
    } catch (err) {
      this.warn('chat.counter_failed', { error: errName(err) });
    }
  }

  /**
   * Should `viewerSeat` be shown a line `senderSeat` sent? The sender's own seat always sees it. Otherwise the
   * line is hidden when the viewer's current occupant has muted or blocked the sender's current occupant, or the sender has blocked the viewer
   * (a block is two-way). Any internal error means visible: a broken mute store must not silence a room.
   */
  visibleTo(roomId: string, viewerSeat: string, senderSeat: string): boolean {
    if (viewerSeat === senderSeat) return true;
    try {
      const viewer = this.roster.occupant(roomId, viewerSeat);
      const sender = this.roster.occupant(roomId, senderSeat);
      if (viewer === null || sender === null) return true;
      return !this.mutes.isMuted(viewer.subject, sender.subject) && !this.mutes.isBlocked(sender.subject, viewer.subject);
    } catch (err) {
      this.warn('chat.visibility_failed', { error: errName(err) });
      return true;
    }
  }

  /**
   * The seats of the room that must NOT be shown a line `senderSeat` sent: exactly the other seats `visibleTo` would hide it from, sorted. It costs the people who muted or blocked the sender (and those the sender
   * blocked), not the seats in the room. An unknown room, an empty seat or a seat with no person (a guest) gives []. If the mute index cannot be read it falls back to asking `visibleTo` of every seat (which is
   * slower and, like it, fails open). Never throws.
   */
  hiddenFor(roomId: string, senderSeat: string): string[] {
    try {
      const sender = this.roster.occupant(roomId, senderSeat);
      if (sender === null || sender.subject === null) return [];
      const seats = new Set<string>();
      for (const viewer of this.mutes.unseenBy(sender.subject)) {
        for (const alias of this.subjects.aliasesOf(viewer)) for (const seat of this.roster.seatsOf(roomId, alias)) if (seat !== senderSeat) seats.add(seat);
      }
      return [...seats].sort();
    } catch (err) {
      this.warn('chat.visibility_failed', { error: errName(err) });
      return this.roster
        .seats(roomId)
        .filter((viewer) => viewer !== senderSeat && !this.visibleTo(roomId, viewer, senderSeat))
        .sort();
    }
  }

  /**
   * Is this person chat-restricted right now? For a typing indicator: show none while `restricted` is true. It runs
   * the same decision as `accept` (`resolveRestriction`), and equals what `accept` would answer for the seat when
   * `roomId` and `seatId` are both given. Without them the in-memory automatic timeout (the one that could not be
   * stored, and every one earned by a guest with no identity) is looked up by person, over `roomId` or over every
   * room, and a guest (no subject) cannot be found at all, since one guest cannot be told from another. The `gate`
   * hook is not consulted: a gate refusal is not a restriction.
   *
   * Safe for a player's own client: it reveals nothing about others. A restriction that only reaches the person
   * through a shared address of someone else's sanction reads `{ restricted: true, until: null, kind: null }`.
   * Call it after the person is seated, with an identity from the platform and never one sent by the client; the
   * address checked is the one the person last had recorded, as in `accept`.
   *
   * Synchronous and a pure read: no rate budget, nothing written, no event, no strike. It logs only a failure (event
   * and error class), at most once a minute with a count of those held back; a failure reads as not restricted.
   * An empty `roomId` or `seatId` counts as not given.
   */
  restricted(subject: SubjectId | null, roomId?: string | null, seatId?: string | null): RestrictedAnswer {
    try {
      const now = this.clock.now();
      const room = roomId === undefined || roomId === null || roomId === '' ? null : roomId;
      const seat = seatId === undefined || seatId === null || seatId === '' ? null : seatId;
      const memory =
        room !== null && seat !== null
          ? () => this.memoryHeldAt(room, seat, subject, now, false)
          : () => this.memoryHeldBy(subject, room, now);
      const found = this.resolveRestriction(subject, now, memory, (err) =>
        this.typingWarn.warn('chat.restriction_failed', { error: errName(err) }),
      );
      if (found === null) return { restricted: false, until: null, kind: null };
      // Someone else's row reaching this person through a shared address: restricted, nothing more.
      if (!found.own) return { restricted: true, until: null, kind: null };
      return { restricted: true, until: found.until, kind: found.kind };
    } catch (err) {
      this.typingWarn.warn('chat.restriction_failed', { error: errName(err) });
      return { restricted: false, until: null, kind: null };
    }
  }

  /**
   * What a room's mode says to this person right now: `null` to let the line on, or the refusal (`locked`, or `new_account` in an emergency for an account younger than
   * `rooms.emergency.newAccountDays`, an unknown age following `rooms.unknownAge`) with when the mode ends. Staff is never refused. A pure read except that a mode that has run out is
   * noticed (and announced once). `accept` makes the same decision; the chat box's hello reads it through `cw.rooms.postingState`.
   */
  modeRefusal(roomId: string, subject: SubjectId | null, staff: boolean): { reason: 'locked' | 'new_account'; until: number | null } | null {
    if (this.rooms === undefined || staff) return null;
    const state = this.rooms.state(roomId);
    if (state.mode === 'normal') return null;
    if (state.mode === 'locked') return { reason: 'locked', until: state.until };
    const { emergency, unknownAge } = this.rooms.settings();
    if (emergency.newAccountDays === 0) return null;
    const age = this.rooms.accountAge(subject);
    const isNew = age === null ? unknownAge === 'treat_as_new' : age < emergency.newAccountDays;
    return isNew ? { reason: 'new_account', until: state.until } : null;
  }

  /** Forget a room's pacing state (the room is closing). */
  dropPaceRoom(roomId: string): void {
    this.pacer?.dropRoom(roomId);
    this.unknownLogged.delete(roomId);
  }

  // --- internals -----------------------------------------------------------

  private run(roomId: string, seatId: string, input: { text: unknown } | { phrase: unknown }, opts?: { audience?: string[]; staff?: boolean }): ChatResult {
    let trimmed = '';
    if ('text' in input) {
      if (typeof input.text !== 'string') return refuse('empty');
      trimmed = input.text.trim();
      if (trimmed.length === 0) return refuse('empty');
    }

    // An unknown seat or an empty one has no speaker to attribute the line to: refuse it as 'gate'.
    const occupant = this.roster.occupant(roomId, seatId);
    if (occupant === null) return refuse('gate');
    const { subject, handle } = occupant;
    if (!this.gateAllows(roomId, subject)) return refuse('gate');
    // The room's context: a tag the profile does not declare fails shut (a typo in a kids room must not fall back to the relaxed base).
    const rules = this.roomRules(roomId);
    if (rules === 'refuse') return refuse('gate');
    // Phrase rooms: text is refused, and a phrase is looked up in the room's book (its canonical text is the line). Both are pauses that cost nothing: no strike, nothing kept, no rate or pacing spent.
    const book = rules === null ? null : rules.phrases;
    let phrase: Phrase | undefined;
    if ('text' in input) {
      if (book !== null) return refuse('phrases_only');
    } else {
      if (book === null) return refuse('gate');
      phrase = typeof input.phrase === 'string' ? book.get(input.phrase) : undefined;
      if (phrase === undefined) return refuse('phrase_unknown');
      trimmed = phrase.text;
    }

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

    if (phrase === undefined && trimmed.length > this.maxLength) return refuse('length');

    // The room's mode: after the person's own restriction (they are told that first) and the length, before everything that costs or records anything. A line refused here is never
    // matched, so it earns no strike and no automatic timeout, is not kept as evidence and spends no pacing or rate budget. Only the facade's option makes a caller staff.
    const mode = this.modeRefusal(roomId, subject, opts?.staff === true);
    if (mode !== null) return refuse(mode.reason, { until: mode.until });
    // The context's least account age: a pause for a young or unknown account, never a sanction (no strike, nothing kept, nothing spent). Staff is exempt, as for the mode.
    if (rules !== null && rules.minAccountAgeDays !== null && opts?.staff !== true && !this.oldEnough(subject, rules.minAccountAgeDays)) return refuse('account_too_new');

    // Pacing asks before `rate` so the specific, retryable message wins over the blunt one; it only reads, so a refusal spends nothing.
    // With every check off it builds nothing (no key, no canonical lookup) and there is nothing to commit.
    const paced = this.pacer === undefined ? NOT_PACED : this.paceCheck(this.pacer, roomId, seatId, subject, trimmed);
    if (paced.refusal !== null) return paced.refusal;
    // Spent even when the line is then blocked, so a flood of slurs is throttled like any flood and cannot
    // probe the term list faster than ordinary chat.
    if (!this.rate.check(rateKey)) {
      // The line passed pacing but never commits: the pacer must not keep its text.
      this.paceDiscard(this.pacer);
      return refuse('rate');
    }
    // Past `rate` the line has happened as far as pacing is concerned (a blocked or profane line has spent its slot too).
    if (this.pacer !== undefined && paced.key !== null) this.paceCommit(this.pacer, paced.key, trimmed, paced.floor);

    const audience = opts?.audience === undefined ? null : [...opts.audience];

    // A phrase is trusted text: kept as evidence with its canonical text and delivered as it is, with no matcher, filter or profanity step.
    if (phrase !== undefined) {
      const lineId = this.buffer.append(roomId, { ts: now, seatId, handle, subject, raw: trimmed, delivered: trimmed, blocked: false, audience });
      return { deliver: { lineId, text: trimmed, phrase: phrase.id } };
    }

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

    // The chat filters (links, personal info, phrases, caps and repeats): after the slur matcher and before profanity. A refusal is like a
    // profanity refusal: not buffered, no strike, no notice, and the line has spent its rate and pacing budget. Every hit is counted, even
    // on a refused line. A failure of the filters lets the line through as it was typed.
    const verdict = this.filterLine(roomId, subject, trimmed);
    // The one flag that will be handed to `onFilterFlag` (a delivered line, a known speaker, a hook to hand it to) is counted by the hook, by what
    // came of it. Every other `flag` hit files nothing, so it is counted as a plain `count`: a `flag` row is a report that was filed.
    let pendingFlag: FilterHit | null = null;
    if (verdict !== null) {
      if (verdict.refuse === null && subject !== null && this.onFilterFlag !== undefined) pendingFlag = verdict.flags[0] ?? null;
      for (const hit of verdict.hits) {
        if (hit !== pendingFlag) this.countHit(hit.action === 'flag' ? { ...hit, action: 'count' } : hit);
      }
      if (verdict.refuse !== null) return refuse(verdict.refuse.reason, { rule: verdict.refuse.rule });
    }
    const filtered = verdict === null ? trimmed : (verdict.softened ?? maskSpans(trimmed, verdict.spans));

    // Profanity is softening or a house rule, never a violation: a refusal here is not buffered as a blocked line,
    // earns no strike, note or notice, and (the rate check having passed) has spent the line's rate budget. It reads the masked text.
    const profanityMode = rules === null ? this.profanityMode : rules.profanityMode;
    const swearing = this.applyProfanity(filtered, profanityMode, rules === null ? this.profanity : rules.profanity);
    if (swearing !== null && swearing.hit && profanityMode === 'refuse') {
      if (pendingFlag !== null) this.countHit({ ...pendingFlag, action: 'count' });
      return refuse('profanity');
    }
    const delivered = swearing === null || profanityMode !== 'star' ? filtered : swearing.text;
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
    // A `flag` hands the kept line over, once, after it is in the evidence buffer; a guest cannot be reported, so only a known person.
    if (pendingFlag !== null && subject !== null) this.tellFlag(roomId, seatId, this.subjects.canonical(subject), lineId, pendingFlag);
    return { deliver: { lineId, text: delivered } };
  }

  /**
   * Ask pacing about a line: a refusal to return, or the key to commit under once `rate` passes. Everything that can throw is in the
   * fence (the settings, the canonical lookup, the pacer), and it fails open: a broken pacer must not silence chat, so the line goes on
   * with nothing to commit and the class is logged (at most once a minute).
   */
  private paceCheck(pacer: Pacer, roomId: string, seatId: string, subject: SubjectId | null, text: string): Paced {
    try {
      // A probation floor (a new account's least gap between lines) paces a player even in a room whose own pace is off; it asks the account-age hook only while probation is on.
      const floor = this.probationFloor(subject);
      if (floor === undefined && !pacer.active(roomId)) return NOT_PACED;
      const key: PaceKey = { roomId, who: subject === null ? `seat:${seatId}` : (this.pace?.canonical(subject) ?? subject) };
      const verdict = pacer.check(key, text, floor);
      if (verdict.ok) return floor === undefined ? { refusal: null, key } : { refusal: null, key, floor };
      if (verdict.reason === 'flood' && verdict.signalFlood && subject !== null) this.tellFlood(roomId, key.who);
      return { refusal: refuse(verdict.reason, { retryAfterMs: verdict.retryAfterMs }), key: null };
    } catch (err) {
      this.paceWarn.warn('chatwarden.pace_failed', { error: errorClass(err) });
      return NOT_PACED;
    }
  }

  private paceDiscard(pacer: Pacer | undefined): void {
    try {
      pacer?.discard();
    } catch (err) {
      this.paceWarn.warn('chatwarden.pace_failed', { error: errorClass(err) });
    }
  }

  /** A new account's probation pace: `rooms.probation.slowModeMs` while probation is on and the account is younger than `ageDays` (an unknown age follows `rooms.unknownAge`); else undefined. */
  private probationFloor(subject: SubjectId | null): number | undefined {
    if (this.rooms === undefined) return undefined;
    const { probation, unknownAge } = this.rooms.settings();
    if (!probation.enabled) return undefined;
    const age = this.rooms.accountAge(subject);
    const isNew = age === null ? unknownAge === 'treat_as_new' : age < probation.ageDays;
    return isNew ? probation.slowModeMs : undefined;
  }

  private paceCommit(pacer: Pacer, key: PaceKey, text: string, floor?: number): void {
    try {
      pacer.commit(key, text, floor);
    } catch (err) {
      this.paceWarn.warn('chatwarden.pace_failed', { error: errorClass(err) });
    }
  }

  /**
   * The filters' verdict on a line, or null when nothing applies (no filters, every block off) or they failed: a throw anywhere in them
   * (the settings getter, the engine) is logged by class, at most once a minute, and the line goes on unfiltered. Filters are a
   * safeguard, not access control, so they fail open (the `gate` hook fails closed).
   */
  private filterLine(roomId: string, subject: SubjectId | null, text: string): FilterVerdict | null {
    const f = this.filters;
    if (f === undefined) return null;
    try {
      const settings = f.settings(roomId);
      if (typeof settings !== 'object' || settings === null) throw new TypeError('the filter settings are not an object');
      if (!filtersActive(settings)) return null;
      return evaluateFilters(settings, text, { accountIsNew: (days) => this.ageIsNew(subject, days) });
    } catch (err) {
      this.filterWarn.warn('chatwarden.filter_failed', { error: errorClass(err) });
      return null;
    }
  }

  /** The account-age hook, fenced: anything but a plain `true` (a throw, a promise, null) reads as not new. */
  private ageIsNew(subject: SubjectId | null, days: number): boolean {
    const hook = this.filters?.accountIsNew;
    if (hook === undefined) return false;
    try {
      return hook(subject, days) === true;
    } catch (err) {
      this.filterWarn.warn('chatwarden.filter_failed', { error: errorClass(err) });
      return false;
    }
  }

  private countHit(hit: FilterHit): void {
    try {
      this.filters?.count(hit);
    } catch (err) {
      this.filterWarn.warn('chatwarden.filter_failed', { error: errorClass(err) });
    }
  }

  /** Hand a flagged line to the facade. Never changes the verdict: a throw or a rejection is logged by class and dropped. */
  private tellFlag(roomId: string, seatId: string, subject: SubjectId, lineId: string, hit: FilterHit): void {
    const hook = this.onFilterFlag;
    if (hook === undefined) return;
    try {
      const out: unknown = hook({ roomId, seatId, subject, lineId, hit });
      if (isThenable(out)) out.then(undefined, (err: unknown) => this.filterWarn.warn('chatwarden.filter_failed', { error: errorClass(err) }));
    } catch (err) {
      this.filterWarn.warn('chatwarden.filter_failed', { error: errorClass(err) });
    }
  }

  /** Tell the facade a known person tripped the burst limit. Never changes the verdict: a throw or a rejection is logged by class and dropped. */
  private tellFlood(roomId: string, subject: SubjectId): void {
    const onFlood = this.pace?.onFlood;
    if (onFlood === undefined) return;
    try {
      const out: unknown = onFlood({ roomId, subject });
      if (isThenable(out)) out.then(undefined, (err: unknown) => this.paceWarn.warn('chatwarden.pace_failed', { error: errorClass(err) }));
    } catch (err) {
      this.paceWarn.warn('chatwarden.pace_failed', { error: errorClass(err) });
    }
  }

  /**
   * The room's chat rules: `null` for the base, the context's rules, or `'refuse'` for a room whose context the profile does not declare (one log line per room)
   * or a lookup that threw (logged by class): both fail closed.
   */
  private roomRules(roomId: string): RoomChatRules | null | 'refuse' {
    if (this.contexts === undefined) return null;
    try {
      const rules = this.contexts.rules(roomId);
      if (rules !== 'unknown') return rules;
      if (!this.unknownLogged.has(roomId)) {
        if (this.unknownLogged.size >= UNKNOWN_LOGGED_MAX) this.unknownLogged.clear();
        this.unknownLogged.add(roomId);
        this.warn('chatwarden.context_unknown', {});
      }
      return 'refuse';
    } catch (err) {
      this.warn('chat.context_failed', { error: errName(err) });
      return 'refuse';
    }
  }

  /** Is the speaker's account at least `days` old? A guest, an unknown age and a failing lookup all say no (fail closed). */
  private oldEnough(subject: SubjectId | null, days: number): boolean {
    try {
      const age = this.rooms?.accountAge(subject) ?? null;
      return age !== null && age >= days;
    } catch (err) {
      this.warn('chat.context_failed', { error: errName(err) });
      return false;
    }
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
  private applyProfanity(trimmed: string, mode: ProfanityConfig['mode'], filter: ProfanityFilter | undefined): { hit: boolean; text: string } | null {
    if (filter === undefined || mode === 'allow') return null;
    try {
      const result: unknown = filter.apply(trimmed);
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
    return this.resolveRestriction(subject, now, () => this.memoryHeldAt(roomId, seatId, subject, now, true));
  }

  /**
   * The in-memory automatic timeout on one seat: its end, or null when there is none, it is over, or the seat now holds a
   * different person (two guests count as the same). The one lookup `accept` and a seat-aware `restricted` share; `sweep`
   * drops an expired entry (`accept` does, a read-only lookup does not).
   */
  private memoryHeldAt(roomId: string, seatId: string, subject: SubjectId | null, now: number, sweep: boolean): number | null {
    const key = memKey(roomId, seatId);
    const mem = this.memRestrictions.get(key);
    if (mem === undefined) return null;
    if (mem.until <= now) {
      if (sweep) this.memRestrictions.delete(key);
      return null;
    }
    return this.samePerson(mem.subject, subject) ? mem.until : null;
  }

  /**
   * The in-memory automatic timeout held by a known person, found without a seat (the longest, over `roomId` or over
   * every room). A guest (no subject) is never matched: with no seat there is no telling one guest from another.
   * Read only: an expired entry is skipped, not swept.
   */
  private memoryHeldBy(subject: SubjectId | null, roomId: string | null, now: number): number | null {
    if (subject === null) return null;
    const prefix = roomId === null ? null : memKey(roomId, '');
    let best: number | null = null;
    for (const [key, mem] of this.memRestrictions) {
      if (mem.until <= now || mem.subject === null) continue;
      if (prefix !== null && !key.startsWith(prefix)) continue;
      if (best !== null && mem.until <= best) continue;
      if (this.samePerson(mem.subject, subject)) best = mem.until;
    }
    return best;
  }

  /**
   * THE restriction decision, shared by `accept` (a seat) and `restricted` (a person): the longest of the stored chat
   * restriction, the stored full ban and the in-memory automatic one, whose end `memory` reports (null = none).
   * Permanent beats timed; on a tie the stored one wins.
   */
  private resolveRestriction(
    subject: SubjectId | null,
    now: number,
    memory: () => number | null,
    failed: (err: unknown) => void = (err) => this.warn('chat.restriction_failed', { error: errName(err) }),
  ): Restriction | null {
    try {
      // The kill switch silences the in-memory restrictions too: they are sanctions, just never stored.
      if (!this.sanctions.isEnabled()) return null;
      let best: Restriction | null = null;
      const memUntil = memory();
      if (memUntil !== null) {
        best = { until: memUntil, byModerator: false, groupId: null, rule: String(this.autoRestrictRule), own: true, kind: 'auto' };
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
            kind: kind === 'ban' ? 'ban' : stored.automated ? 'auto' : 'chat',
          };
        }
      }
      return best;
    } catch (err) {
      failed(err);
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
    let landed: { groupId: string; refCode: string; subject: SubjectId } | null = null;
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
          landed = { groupId: found.groupId, refCode: found.refCode, subject };
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
