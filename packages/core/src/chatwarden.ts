import { createInertAi } from './ai/inert.js';
import type { AiFacade, AiOptions, AiService } from './ai/service.js';
import { AuditService } from './audit.js';
import type { AuditPage, AuditQuery, AuditRecordInput, Role } from './audit.js';
import { roomAuditRef } from './audit.js';
import { ChatService } from './chat.js';
import { ChatCounter, utcDay } from './chatCounter.js';
import { AccountAges } from './accountAge.js';
import { surgeOf } from './surge.js';
import type { ReportSurge } from './surge.js';
import { RoomModes } from './roomModes.js';
import type { RoomModeState } from './roomModes.js';
import type { RoomMode } from './roomSettings.js';
import { checkInsightsDays, computeInsights, INSIGHTS_READ_DAYS, INSIGHTS_ROW_CAP } from './insights.js';
import type { InsightsDays, InsightsResult } from './insights.js';
import { DecisionService, revokeAndWithdraw } from './decide.js';
import type { DecisionInput, DecisionResult } from './decide.js';
import type { ChatResult, RestrictedAnswer, RoomChatRules } from './chat.js';
import { bindDocuments } from './documents.js';
import type { Documents } from './documents.js';
import { DoorService } from './doors.js';
import type { DoorKind, DoorRefusal } from './doors.js';
import { EvidenceBuffer, RoomRoster } from './evidence.js';
import { EventBus } from './events.js';
import type { InsightsDigest, Subscribe } from './events.js';
import { hashWho, makeHasher } from './hasher.js';
import { safeWarn, ThrottledWarn } from './log.js';
import { historyOf, suggest } from './ladder.js';
import type { ActionRecord, Suggestion, SuggestContext } from './ladder.js';
import { resolveLimits } from './limits.js';
import type { Limits, LimitsInput } from './limits.js';
import { createAutomation } from './automation.js';
import { hmacSha256Hex } from './crypto.js';
import type { AutomationFacade } from './automation.js';
import { CaseWorkflow } from './caseWorkflow.js';
import { CommentService, hasWorkflowMethods } from './commentService.js';
import { missingUrgentMethods } from './storeCapability.js';
import type { ClearEscalationResult, CommentRemoveResult, CommentResult, EscalateResult } from './commentService.js';
import type { CaseMarkResult } from './caseWorkflow.js';
import { dismissMany } from './dismissMany.js';
import type { DismissManyInput, DismissManyResult } from './dismissMany.js';
import { PolicyService } from './policy.js';
import type { PolicyPreview, PolicySaveContext, PolicySaveResult, PolicyState } from './policy.js';
import { checkFilterRules, mergeFilters, resolveFilters } from './filters.js';
import type { FilterSettings } from './filters.js';
import { FilterHits } from './filters/counters.js';
import type { FilterStats } from './filters/counters.js';
import { checkLines, createFilterEngine, shiftTestSpans, testLine } from './filters/engine.js';
import type { FilterCheckResult, FilterTestResult } from './filters/engine.js';
import { checkPace, mergePace } from './pace.js';
import { Contexts, effectiveOf } from './contexts.js';
import type { EffectiveContext } from './contexts.js';
import { AppealService, hasAppealMethods } from './appealService.js';
import { NameService } from './nameService.js';
import type { NameCheckResult } from './names.js';
import type { AppealDecideResult, AppealDecision, AppealDetail, AppealFileResult, AppealPage, AppealStats, AppealSummary, PlayerAppeal } from './appeals.js';
import { createInertSignals } from './signalInert.js';
import type { SignalRuntime } from './signalService.js';
import { BUILTIN_SIGNAL_KINDS, checkSignalFeeds } from './signals.js';
import type { SignalCount, SignalInput, SignalKindView } from './signals.js';
import type { PaceSettings, ResolvedPace } from './pace.js';
import { ProfileError, resolveProfile } from './profile.js';
import type { ModerationProfile, PolicyLayer, PolicySection, PresetName, ProfanityConfig, ProfileOverrides, ResolvedProfile } from './profile.js';
import { MuteService } from './mutes.js';
import { NoticeService } from './notices.js';
import type { PlayerNotice } from './notices.js';
import { ReportService } from './reports.js';
import { evidenceLink } from './reporting.js';
import type { ReportCounts, ReportDetailInput, ReportDetailResult, ReportInput, ReportResult, SystemReportInput, SystemReportResult } from './reports.js';
import { checkLinkRow, hasLinkMethods, isLinkSystem, isLinkValue, linkLimit } from './links.js';
import type { LinkRow, LinkSystem } from './links.js';
import { checkRetentionFloors, purge, RETENTION_DEFAULTS } from './retention.js';
import { checkBundleSecret, createLegal } from './legalService.js';
import { createPrivacy } from './privacyService.js';
import type { PrivacyService } from './privacyService.js';
import type { LegalService } from './legalService.js';
import { VERSION } from './version.js';
import type { PurgeResult, RetentionPolicy } from './retention.js';
import { defineRules, parseRuleRef, starterRules } from './rules.js';
import type { CommunityRules, RuleRef } from './rules.js';
import { applySanction, isInternalSource, normalizeRefCode, SanctionError, SanctionIndex } from './sanctions.js';
import type { SanctionInput } from './sanctions.js';
import { StrikeService } from './strikes.js';
import {
  blockedCountsByTerm,
  blockedItems,
  blockedNameItems,
  listSanctionGroups,
  reporterRecord,
  sanctionByRef,
  sanctionsOfPerson,
} from './staffViews.js';
import { reporterAccuracyFor } from './reporterAccuracy.js';
import type { ReporterAccuracy } from './reporterAccuracy.js';
import type {
  BlockedDays,
  BlockedItem,
  BlockedNameItem,
  PersonSanctionView,
  ReporterRecord,
  SanctionGroupView,
  SanctionListInput,
  SanctionPage,
} from './staffViews.js';
import { listStaffReports, staffReport } from './staffReports.js';
import type { ReportPage, ReportQuery, StaffReport } from './staffReports.js';
import { SubjectIndex } from './subjects.js';
import { CaseDesk, ReasonBook } from './team.js';
import type { CaseClaim, ClaimOutcome, NextCase } from './team.js';
import { WEBHOOK_KEY_TTL_MS } from './types.js';
import type {
  Clock,
  DiscordThreadRow,
  Logger,
  Matcher,
  Platform,
  ProfanityFilter,
  RawWho,
  ReasonRow,
  ReportCategory,
  ReportComment,
  ReportExcerptLine,
  ConductLevel,
  Store,
  StoredReport,
  SubjectId,
  WebhookKeyReservation,
} from './types.js';

/** The wall clock, used only when the adopter injects none. Tests and replays pass their own. */
const systemClock: Clock = { now: () => Date.now() };

/** How often the built-in retention purge runs unless `retention.everyMs` says otherwise: 6 hours. */
const DEFAULT_PURGE_EVERY_MS = 21_600_000;

/** The longest delay `setInterval` honours: Node clamps anything above 2^31-1 ms to 1 ms. */
const MAX_PURGE_EVERY_MS = 2_147_483_647;

/**
 * One rule gap, for the moderators' rules review. It names the sanction group and its reference code but never
 * a person: no subject id, key or hash.
 */
export interface GapRow {
  groupId: string;
  refCode: string;
  /** Epoch ms the sanction was made. */
  at: number;
  /** The moderator who cited `'uncovered'`. */
  actor: string;
  /** The moderator's private note on what the rules did not cover. Staff only: never show it to a player. */
  note: string;
  rule: 'uncovered';
  status: 'open' | 'ruled' | 'not_a_rule';
}

/** Everything {@link createChatwarden} needs. Only the store, the secret and the platform are required. */
export interface ChatwardenOptions {
  /** Where moderation state lives (for example `openStore(...)` from `@chatwarden/store-sqlite`). */
  store: Store;
  /** Secret that keys the client-key and IP hashes. Keep it stable: changing it unlinks every stored hash. */
  secret: string;
  platform: Platform;
  /** Without one, nothing is ever blocked. An adopter holding `LiveTerms` passes it here. */
  matcher?: Matcher;
  /**
   * A ready profanity filter. What it does with a profane line is the profile's call (`profile.profanity.mode`):
   * `allow` never calls it, `star` delivers its masked text, `refuse` refuses the line with `'profanity'`. Ordinary
   * swearing only: slurs go through `matcher`. Wins over `profanityPackage`.
   */
  profanity?: ProfanityFilter;
  /**
   * The optional `@chatwarden/profanity` package, `{ createProfanityFilter }`. The kit builds the filter from the
   * resolved `profile.profanity` (style, add, remove, only, languages), so core carries no word list. A config the
   * package rejects (an unknown language, say) fails creation. Not called when the mode is `allow` or when a
   * ready `profanity` filter is given.
   */
  profanityPackage?: { createProfanityFilter(config: ProfanityConfig): ProfanityFilter };
  /** Defaults to the system clock. */
  clock?: Clock;
  /** The kill switch, read per call. Drives both sanction enforcement and report intake. Defaults to always on. */
  enabled?: () => boolean;
  /** Who may chat: false refuses the line with `'gate'`. Called with the room and the sender's subject. */
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
  /**
   * Told once for each stored report. Fenced: a throw never reaches the reporter.
   *
   * The report carries SUBJECT IDS (reporter and target) and the evidence lines, so it is for staff channels
   * only (a moderator queue, a private log). Never forward it, or any part of it, to a player.
   * Carries subject ids: staff channels only, never send to a player.
   */
  onReport?: (report: StoredReport, counts: ReportCounts) => void;
  /**
   * Told once when a blocked line earned an automatic timeout; `second` is true for the 24 h repeat. The same moment
   * is also the `auto.restricted` event (`cw.on`), which names the stored group; this option keeps its shape.
   */
  onAutoRestrict?: (subject: SubjectId | null, second: boolean) => void;
  /**
   * Retention purge. On by default: the kit deletes rows past their retention (see `RETENTION_DEFAULTS`) every
   * `everyMs` (default 6 hours) on a timer that does not keep the process alive. Give a policy to change how
   * long rows are kept, `{ everyMs }` (at most 2147483647) to change how often it runs, or `false` to turn it off and run
   * `purge()` yourself. A failing purge is logged (`chatwarden.purge_failed`) and never thrown; `close()`
   * stops the timer.
   *
   * Floors, checked at creation (and on every `purge(policy)`), each a `ProfileError` naming the field:
   * `sanctionAfterEndMs` and `noticesMs` at least 90 days (the ladder and "My record" reach back that far),
   * `auditMs` at least 90 days (default 365), `appealsMs` at least 90 days (default 365), `badFaithMs` at least
   * `limits.reports.suspendWindowMs`. `appealStatementsMs` (default 90 days) and `blockedNamesMs` (default 30 days) may be 0. Every field
   * must be a finite number (Infinity and NaN are refused). Not enforced, but `strikesMs` should be at least
   * `limits.strikes.windowMs`, or strikes are deleted before the window that counts them closes. When you leave
   * `badFaithMs` out it follows a longer suspension window.
   */
  retention?: false | ({ everyMs?: number } & Partial<RetentionPolicy>);
  /**
   * The moderation profile: a preset by name (`'relaxed'`, `'standard'` or `'strict'`) or a complete profile from
   * `defineProfile` / `resolveProfile`. Default `'standard'`. It drives `suggest`, the starter rules and the
   * summary. This is the BASE profile: a moderator's stored edits (`cw.policy`) are merged on top of it, and `cw.profile` reads
   * the result.
   */
  profile?: PresetName | ModerationProfile;
  /**
   * Changes to the profile, deep-merged onto it (`{ profanity: { mode: 'allow' } }`; arrays replace). An unknown key
   * or an invalid result throws a `ProfileError` at creation.
   *
   * Overriding an outcome (`firstOffense`), the `repeat` rule or the `ladder` means overriding the `guidelines` text
   * too: the moderator guide and the AI brief repeat each guideline's `outcome` as written. Only the player code of
   * conduct derives its outcomes from those fields automatically.
   */
  overrides?: ProfileOverrides;
  /**
   * The numbers the kit enforces: chat length and rate, the slur filter's strikes and timeouts, report limits and
   * reporter feedback. Any field, groups included (`{ strikes: { count: 2 } }` keeps the other strike settings);
   * the defaults are Moxgate's. Every number must be a whole number above 0 (durations at most 365 days), else a
   * `ProfileError` is thrown at creation. Read the result back as `cw.limits`.
   */
  limits?: LimitsInput;
  /** Passed to every component. Defaults to `console.warn`. */
  logger?: Logger;
  /**
   * The numbered Community Rules, from `defineRules`. Default: `defineRules(starterRules(profile.rules))`, the
   * starter set for the profile's flavour. A decision may cite only an active rule here, and notices show the rule's
   * title.
   */
  rules?: CommunityRules;
  /**
   * The Community Rule the automatic slur filter cites: on a `blocked` refusal, on the automatic timeout it earns
   * and on the notice for it. Default 1. Must be a rule in `rules` that is not retired, else creation throws a
   * `RangeError`; set it when your registry numbers slurs differently.
   */
  autoRestrictRule?: number;
  /**
   * AI levels 1 and 2 (read, and recommend). Off unless you give an adapter; the level itself is a moderator setting
   * (`profile.ai.level`, default 0) held to at most `maxLevel`. Needs a store with the AI methods (SQLite has them; the
   * in-memory store has them through `withMemoryAi`). A store without them leaves the AI inert and logs `chatwarden.ai_store_unsupported`
   * once at creation, as with any optional Store method; a bad option still throws. The adapter runs on the server only; see `ModerationAI`.
   * @experimental
   */
  ai?: AiOptions;
  /**
   * Signals: what the game records about a player. The kinds, the guards and the feeds are in the profile (`profile.signals`); this
   * holds the one hook the profile cannot. Signals need a store with the three signal methods (SQLite has them; the in-memory store has them
   * through `withMemorySignals`): declaring kinds or feeds over a store without them is refused at creation, and the kit loads its signal
   * service only for a store that has them.
   * @experimental
   */
  signals?: {
    /**
     * How old is this player's account, in days, from the account ids the kit has for them (the strings your game gave it as
     * `RawWho.accountId`)? Return null or undefined when unknown. Called synchronously at record time for `by`, and only for a player with
     * at least one account id; a throw reads as unknown (logged by error class). Without this hook the new-account guard is not used,
     * whatever the profile says.
     */
    accountAgeDays?: (accountIds: readonly string[]) => number | null | undefined;
  };
  /**
   * The secret that signs an evidence bundle (`cw.legal.bundle`): at least 32 characters, the same rule as a webhook secret. It is read from here and nowhere else and
   * is never logged, never put in a body or an error. Without one a bundle is produced unsigned (its `hmacSha256` is null and the hub says "not signed"); the
   * SHA-256 still shows the file was not edited. A shorter secret throws at creation, naming `bundleSecret` and never its value.
   * @experimental
   */
  bundleSecret?: string;
}

/**
 * How a person is linked (`cw.people.links`): counts only, never an id, a key, a hash or an address.
 * @experimental
 */
export interface PersonLinks {
  /** Account ids the kit holds for the person, across their merged subjects. */
  accounts: number;
  /** Client keys (devices) the kit holds for them. */
  devices: number;
  /** Other subjects folded into them. */
  merged: number;
  /** Bans, area bans and chat restrictions in force that were placed on a merged subject rather than on the person's own. */
  inForceOnLinked: { ban: number; area: number; chat: number };
}

/** The moderation kit as an adopter uses it. Nothing here returns an identifier meant for a player. */
export interface Chatwarden {
  rooms: {
    /**
     * Seat a person: hash `who`, resolve them to a subject (creating or linking as needed) and put them in the
     * seat. A seat that is already held changes hands; earlier evidence keeps naming the earlier occupant.
     */
    seat(roomId: string, seatId: string, who: RawWho, handle: string, tags?: Record<string, string>): void;
    /** `seat` with `who` taken from `platform.identify(ctx)`. */
    seatConnection(roomId: string, seatId: string, ctx: unknown, handle: string, tags?: Record<string, string>): void;
    unseat(roomId: string, seatId: string): void;
    /** Forget the room's seats and tags and drop its evidence. */
    close(roomId: string): void;
    /**
     * The subject id of the seat's current occupant, or null. A server-side helper for admin tooling and
     * sanctions. It is the CANONICAL subject (a merge is folded in), the same id `platform.notify` is told and the
     * same one `history` and `decide` use. NEVER send the result to a player: a subject id is an identifier.
     * Carries subject ids: staff channels only, never send to a player.
     */
    subjectAt(roomId: string, seatId: string): SubjectId | null;
    /**
     * Pace this room differently from the defaults until it closes. Per field: absent inherits, `null` turns that check off, a value sets
     * it. `null` instead of an object removes the override (`{}` is the same: nothing to override). A second call replaces the room's earlier
     * override whole; it is not merged into it. The object is read once, so changing it afterwards changes nothing. Throws `ProfileError` for an invalid
     * value (a setup mistake, not a hot-path call), and changes nothing when it does. In memory, this process only: `rooms.close(roomId)`
     * drops it, and a game that runs several processes calls it in each process that serves the room. The override sits on top of the
     * stored layer, which sits on top of the profile in code. @experimental
     */
    setPace(roomId: string, pace: PaceSettings | null): void;
    /**
     * The pace in force for the room: the profile's (code, then the stored layer) with the room's override applied; while the room is in emergency its slow mode is the stricter of its own and
     * `rooms.emergency.slowModeMs`. Every field filled, `null` is off. @experimental
     */
    pace(roomId: string): ResolvedPace;
    /**
     * Put the room in a mode: `normal` (clears at once), `locked` (only staff may chat: `chat.accept(..., { staff: true })` or `ChatMember.staff`) or `emergency` (slow mode, and accounts younger
     * than `rooms.emergency.newAccountDays` read-only). Every mode but normal ends by itself after `opts.forMs` (60 000 to 86 400 000, whole ms) or `rooms.defaultModeMs`; there is no "until I
     * turn it off". A second call replaces the first whole and restarts the clock. Raises `room.mode`. A mode is never a sanction. In memory, this process only, like the pace: a game that runs
     * several processes calls it in each; `rooms.close` clears it. `RangeError` for an unknown mode or a bad length, `TypeError` for a bad room id; either changes nothing. @experimental
     */
    setMode(roomId: string, mode: RoomMode, opts?: { forMs?: number }): RoomModeState;
    /** The room's mode now, with the expiry applied (a mode that ran out is noticed here, announced once as `room.mode` with `expired`). A copy. @experimental */
    mode(roomId: string): RoomModeState;
    /** The rooms this process knows (seated players, or a mode set), up to 500, the most seated first: tags, seats held, mode and end. No seat id, no handle. @experimental */
    list(): Array<{ roomId: string; tags: Record<string, string>; seated: number; mode: RoomMode; until: number | null }>;
    /**
     * Whether a seat may chat in the room right now: `'ok'`, `'locked'` or `'new_account'` (an emergency and a young account). The same decision as `accept` for the seat; `opts.staff`
     * (the game's word, as for `accept`) is always `'ok'`. A pure read, for the chat box's hello. @experimental
     */
    postingState(roomId: string, seatId: string, opts?: { staff?: boolean }): 'ok' | 'locked' | 'new_account';
    /**
     * Take a delivered line back for everyone, keeping it as evidence: its text stays in the evidence buffer and in any report filed from now on (flagged `retracted`), a report already filed is
     * not rewritten, and a report on the line is still valid. `opts.allFromAuthor` also takes back every delivered line still in the buffer by the same person (the spam-wave case). It works only
     * while the line is in the evidence buffer (15 minutes, 100 lines a room), else `not_found` (also for a line already taken back, a blocked line and any bad argument). Raises `line.retracted`
     * (the room, the line ids and a time: no text, no seat). Not a sanction: no notice, no strike, nothing said to the author. @experimental
     */
    retract(roomId: string, lineId: string, opts?: { allFromAuthor?: boolean }): { ok: true; lineIds: string[] } | { ok: false; refused: 'not_found' };
    /**
     * The lines the room's evidence buffer holds now, as id, send time and whether each was taken back: for staff to see which lines of a report can still be removed. No text, no seat, no handle.
     * A pure read; empty for an unknown room. @experimental
     */
    lineStates(roomId: string): Array<{ lineId: string; ts: number; retracted: boolean }>;
  };
  /**
   * The chat filters (`profile.filters`): what they did, and a way to try them before they act. All off until an owner turns a block on.
   * @experimental
   */
  filters: {
    /**
     * What the filters did over the last 7 or 30 UTC days (today included): per counter key (`link.unlisted`, `personal_info.phone`,
     * `phrase.<id>`, `ratio.caps` ...), the counts by applied action (`count`, `flag`, `mask`, `refuse`, and `flag_capped` when the daily cap
     * turned a flag into a count). This process's held counts are written first. No person, room or text is in a count. Throws `RangeError` for
     * another number of days.
     */
    stats(q: { days: 7 | 30 }): Promise<FilterStats>;
    /**
     * Try one line under the filters in force, or under `candidate` settings that are not saved (throws `ProfileError` for invalid ones):
     * the verdict (every hit with its kind, detail, action, rule and matched ranges) and the line as it would be delivered (`null` when it
     * would be refused). Writes nothing and counts nothing. Staff only: the ranges point at the matched part of the line. A line is judged as a
     * person with no account age, so a `newAccountDays` rule does not act.
     */
    test(text: string, candidate?: FilterSettings): FilterTestResult;
    /**
     * Run `candidate` settings over `lines` (the adopter's recent lines): per counter key, how many lines it would hit and up to 20 sample lines
     * with their ranges, and how many lines it would refuse or mask. Writes nothing and counts nothing. At most 5 000 lines are read. Staff only.
     */
    check(candidate: FilterSettings, lines: readonly string[]): FilterCheckResult;
  };
  chat: {
    accept(roomId: string, seatId: string, text: string, opts?: { audience?: string[]; staff?: boolean }): ChatResult;
    /** Should `viewerSeat` be shown a line `senderSeat` sent (mutes applied)? */
    visibleTo(roomId: string, viewerSeat: string, senderSeat: string): boolean;
    /**
     * Is this person chat-restricted right now (a chat restriction, a ban or an automatic timeout)? For a typing
     * indicator: show none while `restricted` is true. It runs the same decision as `accept`, and equals what
     * `accept` would answer for the seat when you pass BOTH `roomId` and `seatId`. Without them, an automatic
     * timeout that was only kept in memory (it could not be stored, or a guest with no identity earned it) is looked
     * up by person, over `roomId` or over every room, and a guest with no key and no account is never found: one
     * guest cannot be told from another. The `gate` option is not consulted; a gate refusal is not a restriction.
     * Synchronous and a pure read: no rate budget spent, no evidence, strike, event or notice written. Only a
     * failure is logged (event and error class), at most once a minute with a count of those held back; a failure
     * reads as `restricted: false`.
     *
     * Call it after `cw.rooms.seat`: the address checked is the one `seat` last recorded for the person, as in
     * `accept`, not `who.ip`. Take `who` from your platform's `identify` on the server, never from what the client
     * sends: a client-supplied key or account would let a caller look up another person's restriction.
     *
     * Safe to answer a player about THEMSELVES from their own client, because it reveals nothing about others:
     * `until` (epoch ms, `null` = permanent) and `kind` (`'chat'`, `'ban'` or `'auto'`) are only given for the
     * person's own sanction. When the restriction reaches them only through an address shared with someone else's
     * sanction, the answer is `{ restricted: true, until: null, kind: null }`. `who` is found by key or account (an
     * address alone finds nobody). An empty `roomId` or `seatId` counts as not given. Never carries an identifier.
     */
    restricted(who: RawWho, opts?: { roomId?: string | null; seatId?: string | null }): RestrictedAnswer;
    /**
     * `restricted` for a person you already hold as a subject id (`cw.rooms.subjectAt`), so a server that keeps a seated player's
     * connection open can ask again without keeping their raw client key, account or address in memory. The same answer, the same
     * rules (a merge is followed, a failure reads as not restricted and is logged once a minute), the same shape; `opts` as in
     * `restricted`. A value that is not a subject id, or a subject nobody holds, reads `{ restricted: false, until: null, kind: null }`.
     * A subject id is an identifier: pass it from server code, never from what a client sent, and never send it to a player.
     * @experimental
     */
    restrictedBySubject(subject: SubjectId, opts?: { roomId?: string | null; seatId?: string | null }): RestrictedAnswer;
  };
  /**
   * Room contexts (`profile.contexts`): rules per room, selected by the room's `context` tag at `rooms.seat`. Read-only lookups.
   */
  contexts: {
    /** The declared context names, in declaration order. Empty when the profile declares none. */
    names(): string[];
    /** The room's context tag when it is well formed, else null (no tag, or an unknown room). The name need not be declared. */
    of(roomId: string): string | null;
    /**
     * What a room in the context runs with, over the profile in force (code, then the stored layer, then the context): profanity, pace, chat (`phrases`,
     * `minAccountAgeDays`) and filters, every value filled in. `null` is the base. A pure lookup: the values are frozen copies that share nothing with the profile
     * (a `cw.rooms.setPace` override on a room is not part of it). Throws `ProfileError` for a name the profile does not declare.
     */
    effective(name: string | null): EffectiveContext;
  };
  mutes: {
    /** `viewerSeat`'s occupant mutes (`on`) or unmutes `targetSeat`'s occupant. Does nothing if either seat has no subject. */
    set(roomId: string, viewerSeat: string, targetSeat: string, on: boolean): void;
    /** The seats whose current occupant the viewer has muted. Seat ids only. */
    mutedSeats(roomId: string, viewerSeat: string): string[];
  };
  reports: {
    /**
     * File a report. `input.reason` (or the 0.1.1 alias `category`) is optional: with the default `one_tap` flow a report with
     * no reason is taken; with `reason_required` it is refused `reason_required`; an unknown or switched-off reason is
     * `reason_unknown` in every flow. The reason is stored as `reportedReason`: a hint for the moderator, never the truth.
     * See {@link ReportInput} and {@link ReportRefusal}. The kit has no player report route: your game's own route calls this.
     */
    submit(input: ReportInput): Promise<ReportResult>;
    /**
     * File the report of a chat filter's `flag` (and, later, of the AI watch): a report with no reporter, `origin: 'filter'`, the room's evidence as its
     * excerpt, for a person to decide. Nothing happens to the speaker until one does. The chat filters call this themselves when a rule's action is
     * `flag`; it is public for a game that runs its own rules. Never rejects: `filed`, `open_exists` (one is already open for this person and room),
     * `capped` (`flagCapPerDay` filter reports filed today across the instance), `no_subject` (a guest), or `off`. See {@link SystemReportInput}.
     * A report it files is announced like any other (`report.created` with `origin`, `onReport`). Staff views show its reporter as null.
     * @experimental
     */
    fileSystem(input: SystemReportInput): Promise<SystemReportResult>;
    /**
     * The reporter's one optional follow-up after a report: `{ reason?, note? }` attached to the same report. Only the original
     * reporter (the same seat, still in the report's room), once, within ten minutes, and while the report is open; it never
     * changes the target or the excerpt. Refusals: `off`, `not_found`, `not_reporter`, `too_late`, `already_added`,
     * `reason_unknown`. Never rejects. The kit has no player report route: expose this from your own, the way you expose
     * `submit`, with the seat taken from your own session and never from the request body.
     */
    addDetail(reportId: string, reporterSeat: string, detail: ReportDetailInput): Promise<ReportDetailResult>;
    /**
     * The staff report queue, newest first (ties broken by id), one page at a time. Filter with `status`; pass the
     * previous page's `next` as `before` for the next page; `limit` defaults to 50 and is clamped to 1..200. Each item
     * is a {@link StaffReport}: the whole record plus the canonical staff refs and the own line ids of every person.
     * `reason` keeps only the reports filed under that reported reason (`null`: none given). Throws `ReportQueryError` for an
     * unknown status, a malformed reason or a cursor that is not one of ours, and the store's own error
     * if it fails, so a route handler should catch both.
     * Carries subject ids: staff channels only, never send to a player.
     */
    list(q?: ReportQuery): ReportPage;
    /**
     * One report as a {@link StaffReport}, or null for an unknown id. Throws the store's own error if it fails.
     * Carries subject ids: staff channels only, never send to a player.
     */
    get(id: string): StaffReport | null;
    /**
     * How the reports this person FILED stand (total, open, actioned, dismissed, bad faith) and when their reporting
     * suspension ends (null if none), under the same rule intake uses, and how often their reported reason was borne out
     * (`reasonMatched` of `reasonDecided`). Folds in the person's merged aliases. Staff only:
     * never send to a player (a player is not told who reported or how often).
     */
    reporterRecord(subject: SubjectId): ReporterRecord;
    /**
     * How each person's reports filed in the last 30 days turned out, keyed by canonical person (merged aliases folded in): one
     * grouped store read for up to `REPORTER_ACCURACY_BATCH_MAX` (200) people, more is a `RangeError`. A person with no decided
     * report in the window is absent; a store without `reporterOutcomes` gives an empty map. `falseRate` is null below
     * `REPORTER_ACCURACY_MIN_DECIDED` decided reports. A ranking hint and a line on the case: it never refuses a report and never
     * counts toward a suspension. Staff only: never send to a player.
     * @experimental
     */
    reporterAccuracy(people: readonly SubjectId[]): Map<SubjectId, ReporterAccuracy>;
    /**
     * Dismiss ("nothing wrong here") every open report about one person (their case, merged aliases included) or filed by one
     * reporter, in one call: at most `BULK_DISMISS_MAX` (200) reports, `more: true` when there are more. Each report is closed by the
     * same path as `decide` (a `no_action` decision with no actions and the standard reason, source `moderator`, its own transaction,
     * its own `report.closed` event), so a bulk never marks bad faith and never counts toward a suspension. A case another moderator
     * holds is skipped and counted (`skipped.claimed`) unless `ignoreClaims` (for the staff layer, after it has checked who may take
     * a case over). `dryRun` counts and writes nothing. Invalid input resolves `{ ok: false, error: 'invalid' }` with nothing written;
     * a bad `actor` is a `RangeError`; a STORE failure rejects, the reports closed before it stay closed, and running it again
     * finishes the rest. Writes no audit row: the staff layer records the sweep. Carries subject ids: staff channels only, never send
     * to a player.
     * @experimental
     */
    dismissMany(input: DismissManyInput): Promise<DismissManyResult>;
  };
  /**
   * Blocked chat lines, from the slur filter's strikes (purged after 30 days). Staff only: the lines are raw chat text
   * and `person` is a subject id; never send either to a player.
   */
  blocked: {
    /** The last `days` days (1, 7 or 30, else `RangeError`), newest first, at most 500. */
    list(q: { days: BlockedDays }): BlockedItem[];
    /** Strikes per term id over the same window; a term with none is absent. */
    countsByTerm(q: { days: BlockedDays }): Record<string, number>;
    /**
     * The blocked NAMES kept as evidence (`names.keepBlocked`) over the last `days` days (1, 7 or 30, else `RangeError`), newest first, at most
     * 200: `{ id, at, person, name, termId, reason }`, the person a staff ref or null. Empty when none was kept, or the store keeps none. A name
     * is a player's text and `person` a subject id: staff channels only, never send either to a player.
     * @experimental
     */
    names(q: { days: BlockedDays }): BlockedNameItem[];
  };
  /**
   * The team workbench: soft claims on a person's case, take next, and who has a case open. Staff only; every `person` is
   * a staff ref (an alias is folded into the surviving person) and every `actor` a staff ref the audit trail accepts
   * (`RangeError` otherwise). Claims live in the store and last 10 minutes from the last beat (`CLAIM_TTL_MS`), on the
   * injected clock; an expired claim reads as absent everywhere. They are a courtesy, not a security boundary: nothing
   * in the core refuses a decision because of one (`@chatwarden/http` does, with a 409 `claimed`).
   * Carries subject ids: staff channels only, never send to a player.
   */
  cases: {
    /** The live claim on the person's case, or null. */
    holder(person: SubjectId): CaseClaim | null;
    /** The live claims among these people in one read, keyed by their canonical person. */
    holders(people: readonly SubjectId[]): Map<SubjectId, CaseClaim>;
    /**
     * Claim the person's case, or beat the claim `actor` already holds (the claim then lasts 10 minutes from now; `since`
     * is kept). Needs an open report against the person (`no_case` otherwise). Somebody else's live claim answers
     * `claimed` with it, unless `takeOver` is true, which moves it to `actor` (`tookOverFrom` names the previous holder).
     * `takeOver` is not permission-checked here: the caller decides who may use it. The write is one atomic conditional
     * statement, so two moderators racing for one case never both win, even from two processes on one database. A
     * process that loses the database lock race in between (SQLite BUSY) is retried up to `CLAIM_BUSY_TRIES` times with
     * a fresh read, so it answers `claimed` with the winner, not an error.
     */
    claim(person: SubjectId, actor: string, opts?: { takeOver?: boolean }): ClaimOutcome;
    /** End `actor`'s own claim. True only when it ended a live one; never touches another moderator's. */
    release(person: SubjectId, actor: string): boolean;
    /**
     * What a decision does to the claim: end `actor`'s own claim only when the person has no other open report (one case per
     * person: deciding one report of several keeps the claim, and the last one releases it). While reports remain the claim is
     * not touched at all. True only when it ended a live claim.
     */
    releaseWhenDone(person: SubjectId, actor: string): boolean;
    /**
     * With an urgent report open, the oldest free case that has one is served first, under the same `category` and `reason` filters, ignoring `rankDownHabitual` and `signalBoost`
     * for that pass; a case another moderator holds is skipped (urgent never overrides a claim), and when none is free the ordinary scan below runs unchanged. With no urgent report open
     * this is exactly what it was.
     *
     * Claim and return the oldest OPEN case nobody holds, optionally only cases with an open report of `category`
     * or that gave `reason` (an id, the old `disruption` reading as `griefing`; `null`: none given; `RangeError` for an unknown category or a
     * malformed id), or null. A case is a person, ranked by their oldest open report and opened on
     * their newest. A case anyone holds is skipped without a write (held cases are read once per page of reports). `category` and
     * `reason` are the only filters: the order is already oldest first. A candidate lost to a rival in between is retried like `claim`.
     *
     * With `rankDownHabitual` (default false: behaviour unchanged), a case whose open reports ALL come from habitual false reporters
     * (see `cw.reports.reporterAccuracy`) and none of which has waited 24 hours (`REPORTER_RANK_LAPSE_MS`) is served after the ordinary
     * ones, oldest first; it is never skipped, so a queue holding only such cases still serves them. One ordinary reporter, or no
     * accuracy data (a store without `reporterOutcomes`), keeps a case normal. A non-boolean value is a `RangeError`.
     *
     * With `signalBoost` (default false: behaviour unchanged; use it when the queue signal feed, `feeds.queue`, is on), the scan stays oldest
     * first but a case is claimed only when it is overdue (its oldest open report has waited 24 hours) or boosted (the person meets the
     * feed's threshold); the first such case wins. If the queue, or the first 200 people, hold neither, the oldest free case is claimed as
     * usual, so nothing is ever left out. A boosted case is never ranked down. A non-boolean value is a `RangeError`.
     * @experimental (the `rankDownHabitual` and `signalBoost` filters)
     */
    next(actor: string, filter?: { category?: ReportCategory; reason?: string | null; rankDownHabitual?: boolean; signalBoost?: boolean }): NextCase | null;
    /**
     * Mark an open report urgent or not urgent (any moderator, both directions; the staff layer audits it). `ok: true` also for a repeat; `closed` for a decided report, `not_found` for
     * an unknown id. Urgent is a stored snapshot (a reason's flag sets it at filing, see `reporting.reasons[].urgent`); this is the one other way it changes. Moves the change token,
     * announces nothing, touches no claim and nothing about a person. `RangeError` for a malformed actor or a non-boolean flag; `TypeError` for a store without the urgent lane.
     * @experimental
     */
    setUrgent(reportId: string, actor: string, on: boolean): CaseMarkResult;
    /**
     * Mark that `actor` passed the case to the game's safety team: who and when, once (the first call wins; a repeat answers `ok: true` and changes nothing). Allowed on an urgent or an
     * ordinary open report. Emits `report.handoff` (the report id and the time only) after the write commits, fenced. It contacts no one and writes nothing to the person.
     * @experimental
     */
    handoff(reportId: string, actor: string): CaseMarkResult;
    /**
     * Ask a senior or the owner for a second look at an open report (`desk.workflow` on; `off` otherwise). A moderator or a senior may ask a senior or the owner; an owner no one
     * (`not_allowed`). Sets the report's escalation, adds an `ask` or `escalate` entry (with the optional note) to its staff thread and emits `case.escalated` after the commit. It never
     * touches the claim, never blocks a decision, never reorders the queue; deciding the report clears it. `RangeError` for a malformed actor or role.
     * @experimental
     */
    escalate(reportId: string, actor: string, role: Role, input: { to: 'senior' | 'owner'; note?: string }): EscalateResult;
    /**
     * End a second look ("Looked at"): the asker, or anyone at or above the role asked. A report with none answers ok and changes nothing.
     * @experimental
     */
    clearEscalation(reportId: string, actor: string, role: Role): ClearEscalationResult;
    /** How many open reports are asked of each role (zeros with the workflow off). @experimental */
    askedCount(): { senior: number; owner: number };
    /** How many open reports are urgent (0 for a store without the urgent lane). @experimental */
    urgentCount(): number;
    /**
     * `actor` has the person's case open now. A hint for 30 seconds (`VIEWING_TTL_MS`), in this process's memory only.
     * Only a person with an open report is tracked (false otherwise, nothing recorded); one actor keeps at most 20 cases
     * (`VIEWING_PER_ACTOR_MAX`), a newer beat dropping their oldest. True when the beat was recorded.
     */
    view(person: SubjectId, actor: string): boolean;
    /** Who has the person's case open now (sorted), leaving `except` out. In this process's memory: other processes are not seen. */
    viewers(person: SubjectId, except?: string): string[];
    /** `viewers` for several people at once; people nobody is viewing are absent. */
    viewersOf(people: readonly SubjectId[], except?: string): Map<SubjectId, string[]>;
  };
  /**
   * The staff thread on a report (`desk.workflow` on; `off` and an empty list otherwise): comments of 1 to 500 characters, at most 50 entries a report, deleted with the report, never
   * claim-gated, never in an event, a webhook, a post, an audit row, a notice, an AI input or a log. `RangeError` for a malformed actor or role. Staff only.
   * @experimental
   */
  comments: {
    /** Add a comment (cleaned like an appeal statement: control, bidi and zero-width characters removed; counted in code points). A decided report still takes one. */
    add(reportId: string, actor: string, role: Role, text: string): CommentResult;
    /** The thread, oldest first. Includes the entries an ask, an escalation and a "looked at" wrote. */
    list(reportId: string): ReportComment[];
    /** Remove an entry: its author, or a senior or the owner. Another moderator's, an unknown id and another report's all answer `not_found`. */
    remove(reportId: string, commentId: string, actor: string, role: Role): CommentRemoveResult;
  };
  /**
   * The desk's own switches. @experimental
   */
  desk: {
    /** Whether `desk.workflow` is on in the profile in force (and the store can keep the thread). */
    workflowEnabled(): boolean;
  };
  /**
   * Insights (`desk.insights`, off by default): how the team is doing, from rows the kit already holds plus a daily line counter. Counts and times only: never a person, a handle, text or
   * a staff member, and no per-person number. @experimental
   */
  insights: {
    /** `desk.insights` is on in the profile in force and the store can read the rows. */
    enabled(): boolean;
    /**
     * One window: `days` 7, 30 (default) or 90 (`RangeError` for anything else). `null` while Insights is off. Flushes this process's line counter first. Reads at most 20 000 reports
     * (`partial` says when it hit that).
     */
    read(days?: InsightsDays): InsightsResult | null;
    /** The compact numbers of a window (default 7 days), or `null` while off: counts and times, for a message or a webhook. */
    digest(days?: InsightsDays): InsightsDigest | null;
    /** Raise `insights.digest` once with `digest(days)` and return it; nothing is raised (and `null` returned) while off. The kit has no scheduler: call it from your own timer. */
    emitDigest(days?: InsightsDays): InsightsDigest | null;
    /** Write the line counts held in memory to the store now (also done when the minute changes and at `close()`). */
    flush(): void;
  };
  /** A cheap "did anything change?" for the moderator queue. */
  changes: {
    /**
     * An opaque token, persisted in the store (the in-memory store starts again at "0" when the process restarts), that is different after any report filed or decided, sanction applied or
     * revoked, rule gap closed, claim taken, taken over or released, or saved reason changed, and the same otherwise
     * (a claim heartbeat, a refused claim, viewing and every read leave it alone). A claim that merely expires does not
     * move it. Compare it for equality only; one read of one row, no audit, no other reads.
     */
    token(): string;
  };
  /**
   * Saved decision reasons (label up to 40 characters, text up to 500, at most 200 of them), shared by the team and
   * kept in the store. Text is staff-written and may be quoted into a decision; it is not player-facing by itself.
   * `ReasonError` for a label, text or id outside its limits, or when the list is full.
   */
  reasons: {
    /** Every reason, active or not, in the order they were added. */
    list(): ReasonRow[];
    /** Add an active reason (trimmed). */
    add(input: { label: string; text: string }): ReasonRow;
    /** Change the label and/or text (at least one). Null for an unknown id. */
    update(id: string, patch: { label?: string; text?: string }): ReasonRow | null;
    /** Switch a reason on or off. Null for an unknown id. */
    setActive(id: string, active: boolean): ReasonRow | null;
  };
  doors: { check(kind: DoorKind, who: RawWho): DoorRefusal | null };
  sanctions: {
    /**
     * Write one sanction group and make it live at once. Resolves with the group id and the player-quotable ref
     * code. This writes no player notice: `decide` is the path that does.
     */
    apply(input: SanctionInput): Promise<{ groupId: string; refCode: string }>;
    /**
     * Revoke a whole group and withdraw its player notice in the same transaction: an unseen notice is never shown,
     * a seen one leaves "My record". Resolves true when this call revoked something.
     */
    revoke(groupId: string, actor: string, reason: string): Promise<boolean>;
    /**
     * A person's sanctions as staff see them, newest first: the last 90 days plus every unrevoked permanent one, across
     * the aliases merged into them, at most 200. Each is a {@link SanctionGroupView} built from the group's subject row
     * (never an IP row, never a hashed identifier). Carries staff-only text (reason, actor): never send to a player.
     */
    forPerson(subject: SubjectId): SanctionGroupView[];
    /**
     * Every person's sanctions, newest first, one page at a time (`limit` default 50, clamped to 1..200; `cursor` is the
     * previous `next`; `source` filters). Not windowed. Throws {@link SanctionQueryError} for a cursor that is not ours or an
     * unknown source. Carries subject ids and staff-only text: never send to a player.
     */
    list(q?: SanctionListInput): SanctionPage;
    /**
     * One group's staff view, with its canonical `person`, by the player-quotable reference code (`M-` plus five characters; case and
     * surrounding spaces are ignored, and a bare five characters is read as `M-` plus them). Null for a code nobody holds, a malformed one
     * or one with an ambiguous letter (never throws for a string; a non-string is a `TypeError`). Revoked and ended groups are found: the
     * code never changes. Built from the group's subject row only (never an IP row). Synchronous. Carries staff-only text (reason, actor):
     * never send to a player. A store without `sanctionGroupByRef` is read through its newest 1 000 groups.
     * @experimental
     */
    byRef(refCode: string): PersonSanctionView | null;
  };
  /**
   * Subscribe to what happens in the kit: `'report.created'`, `'report.closed'`, `'sanction.applied'`,
   * `'sanction.revoked'`, `'gap.created'`, `'auto.restricted'`, or `'*'` for all. Returns the unsubscribe function.
   *
   * Events are announced after the operation has committed, once each, and never for a refused or failed one (a
   * replayed decision announces nothing). A listener may be async; it is fenced: a throw or a rejection is logged
   * (`chatwarden.listener_failed`, error class only) and never reaches the operation. Staff only: a `sanction.applied`
   * event carries the target's subject id. They hold no chat text, reason, evidence or gap note.
   * Carries subject ids: staff channels only, never send to a player.
   *
   * Listeners run synchronously, in the call that raised the event. `auto.restricted` is raised inside
   * `chat.accept`, on the chat hot path: keep a listener cheap, or hand the work off (queue it, or return a promise
   * after a quick synchronous start) so it never delays a chat line.
   */
  on: Subscribe;
  names: {
    /**
     * May a player use this as a name (a handle, a table or deck name)? Synchronous, never echoes the name, never throws for a string (a
     * non-string is still a TypeError). Reads it with the matcher's name rules (`Zorbak_99` is caught, not only `zorbak`); with
     * `names.profanity` it also runs the profanity filter on the name and on the name with underscores and digits turned into spaces, and a
     * hit is `name_profane` (a matcher hit wins). `rule` is the Community Rule the slur filter cites (`autoRestrictRule`) for both. No
     * matcher, a matcher that fails (logged, class only) and a filter that fails (`chatwarden.names_filter_failed`) all let the name through.
     *
     * `opts.who` is the caller, as the doors take it. It is used ONLY to tie kept evidence to a person (found, never created); it never
     * changes the answer. A blocked name is kept (`kit_blocked_names`) only when `names.keepBlocked` is on: at most 5 an hour per person
     * (per `who`, or per name when there is none) and 200 an hour overall, in memory per process; past that the check still answers and
     * nothing more is stored. An allowed name is never stored, and a name is never logged.
     */
    check(text: string, opts?: { who?: RawWho }): NameCheckResult;
    /**
     * Would the matcher refuse this as a name? The evidence-free read for staff screens and routes (a list of handles): the matcher only,
     * no profanity pass, nothing stored whatever `names.keepBlocked` says, no person looked up. False for no matcher, for a non-string and
     * when the matcher throws (logged once a minute, class only). Never throws.
     */
    flagged(text: string): boolean;
    /**
     * Ask a player to choose a new name. Writes one notice of kind `rename_required` (it names no name, no excerpt, no reason) and, after
     * the write, tells the player's client and emits `rename.required`. Staff only. `{ ok: false, error: 'off' }` while `names.renames` is
     * false (or the store cannot release a rename); `invalid` for a reason that is not 1 to 500 characters or a rule that is missing or is not an
     * active integer rule; `not_found` for a person the kit does not hold; `pending` while a request is already waiting. `rule` is required (a rename always cites a
     * Community Rule; there is no default) and is shown to the player as a rule label. A store failure is logged (class only) and thrown.
     * @experimental
     */
    requireRename(input: { subject: SubjectId; actor: string; reason: string; rule: number }): { ok: true; noticeId: string } | { ok: false; error: 'off' | 'not_found' | 'pending' | 'invalid' };
    /** True while the person has a rename request they have not been released from. For the game, to hold a player at a rename screen. Never creates a person. @experimental */
    pendingRename(who: RawWho): boolean;
    /** The game calls this once the player has a new name. Withdraws their pending rename notices. True when it withdrew one. The kit never learns the name. @experimental */
    renamed(who: RawWho): boolean;
    /**
     * Whether `requireRename` can work right now: `names.renames` is on AND the store can release a rename (the test `requireRename` applies
     * first). A live read. For a staff screen, so it never offers a rename that always answers `off`.
     * @experimental
     */
    renamesEnabled(): boolean;
    /** A person's rename requests, newest first, at most 20: `{ at, pending }` each. No reason, actor, rule or name. Staff only: never send to a player. @experimental */
    renamesOf(subject: SubjectId): Array<{ at: number; pending: boolean }>;
  };
  /**
   * "This kit id is that outside id": a small table the Coop and EOS adapters keep their links in (a report sent to Coop, a sanction pushed
   * to EOS, an EOS report already filed, a polling cursor). Rows are ids and one short state word, never text. Purged with `retention.reportsMs`.
   * @experimental
   */
  links: {
    /** True when the store implements the link methods. An adapter that needs links throws `RangeError` at construction when false. */
    readonly supported: boolean;
    /** The row for `(system, ref)`, a copy, or null (also for a value `put` would refuse, and for a store without links). Never throws. */
    get(system: LinkSystem, ref: string): LinkRow | null;
    /**
     * Insert or replace the row for `(system, ref)`. Throws `RangeError` for a value outside the shapes (the message names the field, never the
     * value) and a plain `Error` for a store without links. Only the five fields are stored.
     */
    put(row: LinkRow): void;
    /** The system's rows, oldest `at` first and then `ref`, only this state when given, at most `limit` (1..500, default 100). Empty for a store without links. */
    list(system: LinkSystem, q?: { state?: string; limit?: number }): LinkRow[];
  };
  /**
   * The AI read and recommend service. Always present: without an `ai` option (or at level 0) it answers as if there were no AI. A
   * read is made after the report is stored and never delays the player's ack; a failing, slow or refusing provider changes nothing
   * for players or moderators. Staff only: a read describes chat lines.
   * @experimental
   */
  ai: AiFacade;
  /**
   * Signals: what the game records about a player (muted by others, kicked, left mid-game), counted by distinct source. A signal never
   * acts: it is read only where a profile rule says so (the Person page record, the ladder suggestion, the AI read, the queue order).
   * Staff-side data: never send any of this to a player.
   * @experimental
   */
  signals: {
    /**
     * Record one signal. Synchronous, fenced, never throws: it returns false (and logs `chatwarden.signal_refused` with a reason code,
     * at most once a minute) for an undeclared or malformed kind, a party it cannot resolve (an unknown subject id, or a `RawWho` the kit
     * has never seen: nobody is created), `subject` equal to `by` (also across a merge), a time out of range, the per-source cap, a
     * store without signals, or a store failure. True means a row was written. One small write: record events, not every chat line.
     */
    record(input: SignalInput): boolean;
    /**
     * The counts for a person now: one entry per declared kind that has at least one source in the window (default 30 days, held to
     * the retention and to 90), aliases folded. Never throws; a store failure reads []. Never send to a player.
     */
    counts(subject: SubjectId, opts?: { windowDays?: number; kinds?: readonly string[] }): SignalCount[];
    /** The declared kinds, built-ins included, for building a form. */
    kinds(): SignalKindView[];
    /**
     * Which of these people meet the queue feed (`feeds.queue`), as canonical ids, from one grouped read. Empty, with no store read,
     * when the feed is off. Never throws.
     */
    boosted(people: readonly SubjectId[]): Set<SubjectId>;
    /** The lines the Person page record shows (`feeds.record`: its kinds and window). `[]` when the feed is off. Never throws. */
    forRecord(subject: SubjectId): SignalCount[];
  };
  /** The registry in use (the one given, or the starter rules for the profile). Retired rules stay listed. */
  rules: CommunityRules;
  /**
   * The profile in force: the preset, the code overrides and the stored layer from `cw.policy`, validated. Deep-frozen. A
   * getter, read live: after a save (or a change another process saved, within 10 seconds) it is a new object, so never keep
   * one across calls. Everything in the kit that reads the profile reads it through this.
   */
  readonly profile: ResolvedProfile;
  /**
   * The editable profile. The profile from code is the base; a moderator's edits to the durations offered, the ladder, the first
   * offences, the repeat rule, the area and severe rules and the guideline outcome texts are stored in your store as a
   * versioned layer. Needs a store with `loadPolicyLayer` and `savePolicyLayer` (the memory and SQLite stores have them);
   * without them `save` and `reset` answer `{ ok: false, error: 'unsupported' }` and everything else works from code.
   */
  policy: {
    /** `{ effective, base, layer, version, canSave }`, plus `layerError` when the stored layer cannot be used (it is then ignored). */
    get(): PolicyState;
    /**
     * Replace the stored layer (the whole layer: a section left out goes back to the base) if `version` is still the stored
     * one. `{ ok: true, version, changed }`, or `{ ok: false, error: 'conflict' | 'unsupported' }`, or `{ ok: false, error:
     * 'invalid', path }` for a layer that touches anything outside the editable sections (profanity stays in code) or would
     * make the profile invalid. `actor` and `reason` are checked (path `actor` / `reason`); the staff routes write them to
     * the audit trail. Takes effect at once here, and within 10 seconds in other processes on the same store.
     */
    save(layer: PolicyLayer, ctx: PolicySaveContext): PolicySaveResult;
    /**
     * What `layer` would suggest for four sample records (`clean`, `oneWarning`, `chat24h`, `ban7d`) and each conduct level,
     * without saving. Pass `rule` to see an area or severe rule take effect.
     */
    preview(layer: PolicyLayer, rule?: RuleRef): PolicyPreview;
    /** Put one section (or all of them) back to the base. Stores the layer without it; a no-op when nothing is stored for it. */
    reset(section?: PolicySection, o?: { version?: number }): PolicySaveResult;
    /** Look at the store now, instead of waiting for the 10 second interval. */
    refresh(): void;
  };
  /** The limits in force, defaults filled in. Deep-frozen. */
  limits: Limits;
  /** The profile's one-line summary, for the report dialog and the rules page. Same as `profile.summary`. A getter, read live. */
  readonly summary: string;
  /**
   * Generated policy documents, bound to the profile and rules in force: a player code of conduct, a moderator guide,
   * an agent brief and the policy as JSON. Each call is generated from the effective profile at that moment, so a save shows
   * in the very next call.
   */
  documents: Documents;
  /**
   * Player-facing notices and "My record". Each takes the same `RawWho` as the doors, hashes it and FINDS the person
   * (never creates one): an unknown person gets empty lists and `false`. An IP alone finds nobody. A failure in the
   * store is logged (`chatwarden.notices_failed`) and reads as empty or `false`. The values are `PlayerNotice`s:
   * no subject, key, hash, moderator or reason.
   */
  notices: {
    /** Notices not yet seen, oldest first. A pending warning must be shown and acked before the next game starts. */
    pending(who: RawWho): PlayerNotice[];
    /** Mark one of this person's notices seen. False for another person's, an unknown id or a withdrawn notice. */
    ack(who: RawWho, id: string): boolean;
    /** "My record": the person's sanction notices that still apply, seen or not. */
    record(who: RawWho): PlayerNotice[];
    /** True while the person has a warning they have not acknowledged. */
    pendingWarning(who: RawWho): boolean;
    /**
     * Staff side: the text a player is shown for one report excerpt line, the same text a sanction notice stores for it. A delivered line is its
     * delivered form; a blocked line (or one with no delivered form) has only its matched terms starred, or is all stars when the matcher cannot
     * say where they are. Never the raw text of a blocked line. Throws for a line with no raw text. Never send a raw line to a player.
     * @experimental
     */
    lineText(line: ReportExcerptLine): string;
  };
  /**
   * Appeals (0.1.9, `profile.appeals`, off until turned on). The player side takes the same `RawWho` as `notices` and FINDS the person
   * (never creates one); every answer is a reason or a rule number, never an identifier, a staff ref or a reason a moderator gave.
   * @experimental
   */
  appeals: {
    /** Whether appeals are on right now: the profile in force says so (a live read) and the store can keep them. */
    enabled(): boolean;
    /**
     * File an appeal from one of the caller's own sanction notices, with a statement of at most `APPEAL_STATEMENT_MAX` (1000) characters.
     * Checks in this order: off, not_found, not_appealable, statement_invalid, already_appealed, rate. One store transaction; a refusal
     * writes nothing. The statement is cleaned first (`normalizeStatement`) and refused, not cut, over the cap. Never throws for a bad
     * input; a store failure is logged (`chatwarden.appeal_failed`, the error class only) and answers `not_found`. `appeal.created` is
     * emitted after the commit.
     */
    file(who: RawWho, input: { noticeId: string; statement: string }): AppealFileResult;
    /** The caller's own appeals, newest first, at most 50, without any that was made moot. Empty for an unknown person or with appeals off. */
    mine(who: RawWho): PlayerAppeal[];
    /**
     * Decide an open appeal: `uphold` (the sanction stands), `reduce` (to a lighter kind, or the same kind and shorter, keeping the original
     * start so the ladder does not restart, never ending later than the original) or `revoke`. A moderator may not decide an appeal of
     * their own decision unless `appeals.allowSelfReview` is on (`same_decider`); an automatic sanction has no such decider. `reason` is
     * private (1 to 500 characters). One transaction; the player is told through a notice; `appeal.decided` is emitted after the commit.
     * Staff-side: the permission and the audit row belong to the route. A store failure rejects and writes nothing.
     */
    decide(input: AppealDecision): Promise<AppealDecideResult>;
    /**
     * The inbox, oldest first: `open` (default), `decided` or `all`; `limit` 1 to 200 (default 50); an opaque `cursor`. A summary carries a
     * staff ref and never the statement (`statementFlagged` says whether it trips the term filter). `RangeError` for a bad query. Empty with
     * appeals off. Carries subject ids: staff channels only, never send to a player.
     */
    list(q: { status?: 'open' | 'decided' | 'all'; limit?: number; cursor?: string | null }): AppealPage;
    /** One appeal in full, the statement included (null once purged), or null for an unknown id. The route audits this read. Staff only. */
    get(id: string): AppealDetail | null;
    /** How many appeals are waiting. */
    openCount(): number;
    /**
     * The per-rule counts over the last 30, 90 (default) or 365 days. The rate is revoked appeals over sanctions given, null below 10
     * sanctions; a reduction is `lightened`, shown beside the rate and never in it. `RangeError` for another window.
     */
    stats(q?: { days?: 30 | 90 | 365 }): AppealStats;
    /**
     * One person's appeals (across their merged subjects) as summaries, newest first, at most 50; a moot appeal is left out. For the person's
     * page. Still listed after appeals are switched off (what was filed stays visible until retention removes it); empty for a store that cannot keep
     * appeals or a person the kit does not hold. Carries a staff ref and never the statement: staff channels only.
     * @experimental
     */
    forPerson(subject: SubjectId): AppealSummary[];
  };
  /**
   * Decide a report: close it, write each sanction and its notice, and tell the people involved, in one
   * transaction. Idempotent (the same decision again is a replay). A malformed or disallowed decision resolves
   * `{ ok: false, error: 'invalid' }`; a STORE failure REJECTS with the store's own error and writes nothing, so a
   * route handler should catch it. Moderator-side: the result carries subject ids, so never forward it to a player.
   * Carries subject ids: staff channels only, never send to a player.
   *
   * `reason` is required, except for a `no_action` decision with no actions (a one-click "nothing wrong here"): an absent or
   * blank reason is then stored as `NO_ACTION_DEFAULT_REASON`. A `no_action` that acts on someone, and every other verdict,
   * still needs a real reason.
   */
  decide(input: DecisionInput): Promise<DecisionResult>;
  /**
   * The person's counted actions in the last 90 days. Server-side: for the moderator's view only. Keyed
   * by a subject id. Carries subject ids: staff channels only, never send to a player.
   */
  history(subject: SubjectId): ActionRecord[];
  /**
   * What the moderation profile suggests for this person: the outcome, a short label, and a plain sentence on why.
   * It selects nothing; show it as one line. `context.roomId` is the room of the incident being judged: the repeat
   * rule counts it as one more note, and with `distinctGames` it must differ from the earlier notes' rooms (a
   * missing room never pairs with an earlier note). When the profile's `repeat.distinctGames` is true (`relaxed`),
   * the caller MUST pass the incident's `roomId` (the report's room), or note escalation never fires. Keyed by a subject id. Carries subject ids: staff channels
   * only, never send to a player (the returned `label` and `why` themselves hold no identifier).
   */
  suggest(subject: SubjectId, level: ConductLevel | null, rule: RuleRef, context?: SuggestContext): Suggestion;
  /** Rule gaps: sanctions a moderator filed under `'uncovered'`, for the periodic rules review. Staff only. */
  gaps: {
    list(): GapRow[];
    /** Close an open gap as `ruled` (with the new rule number as `ref`) or `not_a_rule` (`ref` null). True when this call closed it. */
    close(groupId: string, status: 'ruled' | 'not_a_rule', ref: string | null, actor: string): boolean;
  };
  /**
   * The staff audit trail: who (actor and role) did what to which id, and when. Staff only. Stores ids and the action
   * name, never chat text or a note (a `policy.update` / `policy.reset` row also holds the sections changed and the owner's reason). Rows from the term editor and from `gaps.close` read here too (role
   * null). Kept `retention.auditMs` (default 365 days, at least 90).
   */
  audit: {
    /**
     * Write one entry, stamped with the clock. Synchronous and fenced: it never throws; it returns false, and logs
     * (`chatwarden.audit_refused` / `chatwarden.audit_failed`, the error class only), when the input is outside the
     * closed lists or the store fails.
     */
    record(input: AuditRecordInput): boolean;
    /**
     * One page, newest first. `limit` is an integer 1..200 (`RangeError` otherwise); a bad `before`, `actor` or
     * `action` throws `AuditQueryError`. Never carries the json the term editor kept.
     */
    list(q: AuditQuery): AuditPage;
    /**
     * The audit ref of a room, for the `room.mode` and `room.retract` rows: the room id itself when it fits the ref alphabet (1 to 64 of `A-Z a-z 0-9 _ . : -`), else `h-` and 16 hex characters of a keyed
     * hash (the kit's own secret, so the same id gives the same ref across restarts and the id never reaches the trail). @experimental
     */
    roomRef(roomId: string): string;
  };
  /**
   * Idempotency keys for incoming webhooks (`@chatwarden/http`'s `webhookIn`), on the kit's clock. A key is remembered
   * for 24 hours and holds the response body of the first call only (never chat text). Each call is one store
   * transaction and throws the store's own error if it fails.
   */
  webhookKeys: {
    /**
     * Take the key (`{ reserved: true }`), or answer the row that holds it: `pending`, or `done` with its stored body,
     * and the `fingerprint` it was reserved with. `fingerprint` is a hash of the request (never text).
     */
    reserve(key: string, fingerprint: string): WebhookKeyReservation;
    /** Mark a pending key done with the response body. True only when this call did it. */
    complete(key: string, resultJson: string): boolean;
    /** Free a pending key (the apply failed, so a retry may run). A done key is never freed. */
    release(key: string): boolean;
  };
  /**
   * Who is who, for staff tools such as the Discord feed. `canonical` is the surviving subject a staff ref resolves to
   * (an id nobody merged is its own); `aliases` is that survivor and every subject merged into it, sorted. Both read the
   * in-memory index and never throw. Carries subject ids: staff channels only, never send to a player.
   */
  people: {
    canonical(subject: SubjectId): SubjectId;
    aliases(subject: SubjectId): SubjectId[];
    /**
     * The account ids the kit holds for this person across their merged aliases, sorted: exactly the strings the game passed as
     * `RawWho.accountId` (no client key, no IP, no hash). A guest has none; so does an unknown id. For the game to find the player to rename
     * after `rename.required`. Server side only: never send to a player.
     * @experimental
     */
    accountIds(subject: SubjectId): string[];
    /**
     * The "do not automate" mark (AI levels 3 and 4, design 6.4): a senior marks a person so the AI never acts on them. Staff only (`automation.write` in
     * the HTTP layer). Reads and drafts are still produced for a marked person. Follows a merge. A store without the methods answers `unsupported`.
     * @experimental
     */
    automation: AutomationFacade;
    /**
     * How a person is linked, as counts only: `accounts` (account ids the kit holds for them) and `devices` (client keys), `merged` (other subjects folded into them), and `inForceOnLinked`, how many
     * bans, area bans and chat restrictions in force were placed on a merged subject rather than on the person's own. Never an id, a key, a hash or an address; the IP rows are not read; a guest and an
     * unknown subject read zeros. A hint (a shared device can link two different people), not proof. A pure read. Staff only: it says who is linked to a person. @experimental
     */
    links(subject: SubjectId): PersonLinks;
  };
  /**
   * Privacy requests (0.2.0): find a person by an account id or a client key, export what the kit holds about them, and erase it (a receipt, a stated safety remainder
   * that keeps a ban in force until retention removes it, a dry run). The adopter verifies the requester first; the kit never does, never tells the player and never
   * judges a request. Owner-only in the HTTP layer and on no player route. Erase leaves the staff audit trail (its person refs read the receipt id) and any report held
   * for legal reasons.
   * @experimental
   */
  privacy: PrivacyService;
  /**
   * Legal hold (0.2.0): hold a report so no retention purge and no erase reaches it or what hangs on it, release it, and produce its signed evidence bundle. A senior
   * holds and the owner releases and downloads in the HTTP layer; `hold` emits `report.escalated` (ids and a code, never text). The kit judges nothing and forwards
   * nothing: it keeps what it held.
   * @experimental
   */
  legal: LegalService;
  /**
   * The Discord feed's thread map (`@chatwarden/discord`): the forum thread kept per person (`kit_discord_threads`). A
   * thin facade over the store, which throws its own error if it fails. Holds no chat text.
   */
  discordThreads: {
    get(subject: string): DiscordThreadRow | null;
    put(row: DiscordThreadRow): void;
  };
  /**
   * Delete rows past retention now. The built-in timer already does this (unless `retention: false`); the
   * policy given at creation is the default here, and `policy` overrides it field by field.
   */
  purge(policy?: Partial<RetentionPolicy>): Promise<PurgeResult>;
  /**
   * Is the store answering? True when `schemaVersion()` returns; false (logged `chatwarden.ready_failed`, error class
   * only) when it throws, which the SQLite store does once closed (`close()`). A store whose `schemaVersion()` never throws, such
   * as the in-memory test double, always reads ready. Synchronous, never throws, reads nothing else. For a readiness probe.
   */
  ready(): boolean;
  /** Wait for background store writes (identity linking) to land. */
  flush(): Promise<void>;
  /** Flush, then close the store (a database handed in by the host stays open). */
  close(): Promise<void>;
}

/**
 * The profanity filter for the profile, or undefined. Mode `allow` builds nothing; a ready filter wins over the
 * package; a package that throws fails creation and one that returns a non-filter is a TypeError.
 */
/** Does the store keep signals (all three optional methods)? */
const storeKeepsSignals = (s: Store): boolean => typeof s.insertSignal === 'function' && typeof s.listSignalSources === 'function' && typeof s.purgeSignals === 'function';

function buildProfanityFilter(opts: ChatwardenOptions, config: ProfanityConfig): ProfanityFilter | undefined {
  if (config.mode === 'allow') return undefined;
  if (opts.profanity !== undefined) return opts.profanity;
  if (opts.profanityPackage === undefined) return undefined;
  return buildPackageFilter(opts.profanityPackage, config);
}

/** The filter a profanity package builds from the resolved config; a non-filter is a TypeError. */
function buildPackageFilter(pkg: NonNullable<ChatwardenOptions['profanityPackage']>, config: ProfanityConfig): ProfanityFilter {
  const built = pkg.createProfanityFilter(config);
  if (typeof built !== 'object' || built === null || typeof built.apply !== 'function') {
    throw new TypeError('profanityPackage.createProfanityFilter must return a filter with an apply(text) method');
  }
  return built;
}

/**
 * Wire every component and return the kit. This is the recommended entry point: the component classes stay
 * exported for adapters and advanced use, but an adopter needs only this.
 *
 * Every index is loaded from the store before this resolves, so the first chat line already sees stored
 * sanctions, mutes and strikes. The facade has no term list: an adopter that edits terms holds `LiveTerms`
 * from `@chatwarden/matcher` itself and passes it as `matcher`.
 */
export async function createChatwarden(opts: ChatwardenOptions): Promise<Chatwarden> {
  const { store, platform } = opts;
  const clock = opts.clock ?? systemClock;
  const enabled = opts.enabled ?? ((): boolean => true);
  const logger = opts.logger;
  const hasher = makeHasher(opts.secret);

  // Everything an adopter configures is checked before the store is touched or a timer started.
  // The BASE profile: the preset and the code overrides. What is in force is `policy.profileNow()` (the base with the stored layer
  // on top); never keep that in a closure. The base itself is read here only for what a layer cannot edit: the rules flavour
  // and the profanity handling, which are code-only.
  const baseProfile = resolveProfile(opts.profile ?? 'standard', opts.overrides);
  const limits = resolveLimits(opts.limits);

  const { everyMs, ...givenRetention } = opts.retention === false ? {} : (opts.retention ?? {});
  /** The policy in force: what was given, with `badFaithMs` following a longer suspension window than its default. */
  const retentionPolicy: Partial<RetentionPolicy> = {
    ...givenRetention,
    badFaithMs: givenRetention.badFaithMs ?? Math.max(RETENTION_DEFAULTS.badFaithMs, limits.reports.suspendWindowMs),
  };
  checkRetentionFloors(retentionPolicy, limits.reports.suspendWindowMs);
  // A feed window longer than the signal retention could never be met (rows older than that are deleted): refuse it in code too.
  checkSignalFeeds(baseProfile.signals.feeds, baseProfile.signals.kinds, { signalsMs: retentionPolicy.signalsMs ?? RETENTION_DEFAULTS.signalsMs }, 'profile.signals.feeds');
  // Declaring kinds or feeds is an explicit opt-in that a store without the signal methods would silently turn into nothing: refuse it.
  // (Only the built-in `flood_triggered` and pacing: nothing declared, so the kit starts and skips that record, logged once.)
  const declaresSignals =
    Object.keys(baseProfile.signals.feeds).length > 0 ||
    Object.keys(baseProfile.signals.kinds).some((id) => {
      const k = baseProfile.signals.kinds[id]!;
      const builtin = Object.hasOwn(BUILTIN_SIGNAL_KINDS, id) ? BUILTIN_SIGNAL_KINDS[id as 'flood_triggered'] : undefined;
      return builtin === undefined || builtin.label !== k.label || k.weight !== 1;
    });
  if (declaresSignals && !storeKeepsSignals(opts.store)) {
    throw new Error(
      'createChatwarden: the profile declares signal kinds or feeds, but the store has no signal methods (insertSignal, listSignalSources, purgeSignals); use the memory or SQLite store, or leave "signals" out of the profile',
    );
  }
  if (opts.signals?.accountAgeDays !== undefined && typeof opts.signals.accountAgeDays !== 'function') {
    throw new TypeError('createChatwarden: signals.accountAgeDays must be a function');
  }
  // The signal service (and the counting under it) is loaded only for a store that can keep signals, so a bundler can leave it out of a build
  // that never has one (the in-memory store has the methods only through `withMemorySignals`). Without it `cw.signals` is inert.
  const signalModule = storeKeepsSignals(opts.store) ? await import('./signalService.js') : undefined;
  const purgeEveryMs = everyMs ?? DEFAULT_PURGE_EVERY_MS;
  if (opts.retention !== false && (!Number.isFinite(purgeEveryMs) || purgeEveryMs <= 0)) {
    throw new Error('createChatwarden: retention.everyMs must be a positive finite number');
  }
  if (opts.retention !== false && purgeEveryMs > MAX_PURGE_EVERY_MS) {
    throw new RangeError(`retention.everyMs must be at most ${MAX_PURGE_EVERY_MS}`);
  }
  // The AI service is loaded only when an adapter is given, so a bundler can leave it (about 40 KB minified) out of a build that never passes one.
  const aiModule = opts.ai === undefined ? undefined : await import('./ai/service.js');
  // The actor (design 6.1) is loaded only when the code asks for acting (`ai.act`): the only module that may ever write what the AI does to a person. In this release it only records.
  const actorModule = opts.ai?.act === undefined ? undefined : await import('./aiActor/service.js');
  // A bad option throws here. A store without the AI methods (the in-memory store has them only through `withMemoryAi`) does not: the AI stays
  // inert and the kit says so once, like any optional Store method it cannot use.
  const aiMissing = opts.ai !== undefined && aiModule !== undefined ? aiModule.checkAiSetup(store, opts.ai) : [];
  if (aiMissing.length > 0) safeWarn(logger, 'chatwarden.ai_store_unsupported', { missing: aiMissing.join(',') });
  const rules = opts.rules ?? defineRules(starterRules(baseProfile.rules));
  const autoRestrictRule = opts.autoRestrictRule ?? 1;
  const autoRule = rules.get(autoRestrictRule);
  if (autoRule === undefined || autoRule.retired === true) {
    throw new RangeError('autoRestrictRule must be the number of an active rule in the registry');
  }
  const isActiveRule = (n: number): boolean => {
    const r = rules.get(n);
    return r !== undefined && r.retired !== true;
  };
  // The filters may cite only an active Community Rule (a code profile fails here, a layer when it is saved).
  checkFilterRules(baseProfile.filters, isActiveRule, 'profile.filters');
  // The staff workflow keeps a thread per report in the store: a code profile that asks for it over a store that cannot is refused here, plainly.
  if (baseProfile.desk.workflow && !hasWorkflowMethods(store)) {
    throw new Error('desk.workflow needs a store that keeps staff comments and escalation (insertComment, listComments, deleteComment, countComments, setEscalation, countOpenEscalated); this store lacks them');
  }
  // The urgent lane's store methods are optional: a store without them still runs, but a report's urgent flag is lost, take next has no urgent pass and marking or handing off a case fails with a
  // named error. Say so once, by method name.
  const noUrgent = missingUrgentMethods(store);
  if (noUrgent.length > 0) safeWarn(logger, 'chatwarden.store_no_urgent_lane', { missing: noUrgent.join(',') });
  if (opts.matcher === undefined) safeWarn(logger, 'chatwarden.no_matcher');
  const profanity = buildProfanityFilter(opts, baseProfile.profanity);
  if (profanity === undefined && baseProfile.profanity.mode !== 'allow') safeWarn(logger, 'chatwarden.no_profanity_filter');

  // At least 32 characters or absent; checked here, with the other options, before anything starts.
  const bundleSecret = checkBundleSecret(opts.bundleSecret);
  const bus = new EventBus(logger);
  const subjects = new SubjectIndex(store, clock, { logger });
  const sanctions = new SanctionIndex({ enabled, subjects });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const mutes = new MuteService(store, clock, subjects, { logger });
  const strikes = new StrikeService(store, clock, subjects, { logger, limits: limits.strikes });

  await subjects.load();
  await sanctions.load(store, clock.now());
  await mutes.load();
  await strikes.load();
  // The stored edits to the profile. Read last, so a store that fails here has not left anything half built.
  const policy = new PolicyService({ store, clock, logger, base: baseProfile, isActiveRule: isActiveRule, signalsMs: () => retentionPolicy.signalsMs ?? RETENTION_DEFAULTS.signalsMs, chatRate: limits.chatRate, appealsKept: hasAppealMethods(store), workflowKept: hasWorkflowMethods(store), accountAge: typeof opts.signals?.accountAgeDays === 'function' });
  policy.load();

  // Room contexts: the lookup over the profile in force and the room's tag. The profanity handling of each context is built once, here: it is code-only, so a stored layer never
  // changes it. A context that sets no `profanity` or `chat` key runs the base path exactly (null rules).
  for (const [name, ctx] of Object.entries(baseProfile.contexts)) {
    if (ctx.filters !== undefined) checkFilterRules(mergeFilters(baseProfile.filters, ctx.filters, `profile.contexts.${name}.filters`), isActiveRule, `profile.contexts.${name}.filters`);
  }
  const contexts = new Contexts({ profile: () => policy.profileNow(), tag: (roomId) => roster.tag(roomId, 'context') });
  const contextRules = new Map<string, RoomChatRules | null>();
  for (const [name, ctx] of Object.entries(baseProfile.contexts)) {
    if (ctx.profanity === undefined && (ctx.chat === undefined || ctx.chat.minAccountAgeDays === undefined)) {
      contextRules.set(name, null);
      continue;
    }
    const eff = effectiveOf(baseProfile, name);
    const sameLists = (['add', 'remove', 'only', 'languages'] as const).every((k) => JSON.stringify(eff.profanity[k]) === JSON.stringify(baseProfile.profanity[k]));
    // The base filter is reused when the context changes neither the word lists nor the style; a context with its own word lists gets its own filter.
    const filter = eff.profanity.mode === 'allow' ? undefined : sameLists && ctx.profanity?.style === undefined && profanity !== undefined ? profanity : buildProfanityFilter(opts, eff.profanity);
    if (filter === undefined && eff.profanity.mode !== 'allow') safeWarn(logger, 'chatwarden.no_profanity_filter');
    contextRules.set(name, { profanityMode: eff.profanity.mode, profanity: filter, minAccountAgeDays: eff.chat.minAccountAgeDays });
  }

  // ONE notice service for the whole kit: chat (the automatic timeout), the doors (the refusal's pointer) and
  // decisions all write to and read from it, and `platform.notify` hears of every new notice through it.
  const platformNotify = platform.notify;
  const notices = new NoticeService({
    store,
    subjects,
    rules,
    clock,
    matcher: opts.matcher,
    logger,
    notify: typeof platformNotify === 'function' ? (who, event) => platformNotify.call(platform, who, event) : undefined,
  });

  /** The signal service, set once `personOf` exists (the chat path above it only calls it later, never during creation). */
  const signalRef: { service?: SignalRuntime } = {};

  // Room overrides of the pace: this process only, dropped by `rooms.close`. Each is the validated sparse override as given (a field
  // left out inherits), kept as a frozen copy so the caller's object cannot change it later.
  const paceOverrides = new Map<string, Readonly<PaceSettings>>();
  /** The merged pace of a room with an override, with the profile pace it was merged onto: valid while that object is the one in force. */
  const paceMerged = new Map<string, { base: ResolvedPace; merged: ResolvedPace }>();
  /**
   * The pace in force for a room: the override over the room's context over the profile's (the layer over the code). A room without an override gets the
   * profile's own object (or its context's merged one); one with an override is merged once per change of the profile's pace (it is a new object on every layer
   * change), not once per line.
   */
  const profilePaceOf = (roomId: string): ResolvedPace => {
    const base = contexts.paceOf(roomId);
    const over = paceOverrides.get(roomId);
    if (over === undefined) return base;
    const cached = paceMerged.get(roomId);
    if (cached !== undefined && cached.base === base) return cached.merged;
    const merged = mergePace(base, over);
    paceMerged.set(roomId, { base, merged });
    return merged;
  };

  // Room modes: this process only, in memory, expiring (roomModes.ts). A change and an expiry are announced as `room.mode`.
  const roomModes = new RoomModes({
    clock,
    defaultModeMs: () => policy.profileNow().rooms.defaultModeMs,
    changed: (change) => bus.emit({ type: 'room.mode', roomId: change.roomId, mode: change.mode, until: change.until, ...(change.expired === true ? { expired: true as const } : {}), at: change.at }),
  });
  /** The emergency pace of a room: the room's merged pace with the slow mode raised to the emergency one, kept while both inputs are the same objects and the same length. */
  const emergencyPace = new Map<string, { base: ResolvedPace; slowModeMs: number; merged: ResolvedPace }>();
  /**
   * The pace in force for a room: the override over the profile's (the layer over the code), and, while the room is in emergency, a slow mode that is the stricter of the room's and
   * `rooms.emergency.slowModeMs`. A room with no override and no emergency gets the profile's own object.
   */
  const paceOf = (roomId: string): ResolvedPace => {
    const base = profilePaceOf(roomId);
    if (roomModes.get(roomId).mode !== 'emergency') {
      emergencyPace.delete(roomId);
      return base;
    }
    const slowModeMs = Math.max(base.slowModeMs ?? 0, policy.profileNow().rooms.emergency.slowModeMs);
    const cached = emergencyPace.get(roomId);
    if (cached !== undefined && cached.base === base && cached.slowModeMs === slowModeMs) return cached.merged;
    const merged: ResolvedPace = { ...base, slowModeMs };
    emergencyPace.set(roomId, { base, slowModeMs, merged });
    return merged;
  };
  // How old a player's account is (the adopter's hook, cached ten minutes): for an emergency's read-only rule and, later, probation.
  const accountAges = new AccountAges({
    hook: opts.signals?.accountAgeDays,
    accountIds: (subject) => subjects.identifiersOf(subject).accounts,
    canonical: (subject) => subjects.canonical(subject),
    clock,
    logger,
  });

  // The chat filters: the engine (the per-room settings getter and the account-age lookup) and the hit counters, held in memory, written to the
  // store every 30 seconds and on close (a crash loses at most 30 seconds of counts). Nothing is built per line while every block is off.
  const filterEngine = createFilterEngine({
    settings: () => policy.profileNow().filters,
    accountAgeDays: opts.signals?.accountAgeDays,
    accountIds: (subject) => subjects.identifiersOf(subject).accounts,
    canonical: (subject) => subjects.canonical(subject),
    clock,
    logger,
  });
  const filterHits = new FilterHits({
    clock,
    logger,
    sink: { add: (rows) => store.addFilterHits(rows), list: (from, to) => store.listFilterHits(from, to) },
  });

  // The daily line counter behind Insights' report rate: counts only while `desk.insights` is on, writes at most once a minute.
  const chatCounter = new ChatCounter({ clock, store, logger, enabled: () => policy.profileNow().desk.insights });
  const chat = new ChatService({
    counter: chatCounter,
    rooms: { state: (roomId) => roomModes.get(roomId), settings: () => policy.profileNow().rooms, accountAge: (subject) => accountAges.ageOf(subject) },
    contexts: {
      rules: (roomId) => {
        const name = contexts.resolveTag(roomId);
        return name === 'unknown' ? 'unknown' : name === null ? null : (contextRules.get(name) ?? null);
      },
    },
    roster,
    buffer,
    subjects,
    sanctions,
    store,
    strikes,
    mutes,
    clock,
    matcher: opts.matcher,
    profanity,
    profanityMode: baseProfile.profanity.mode,
    gate: opts.gate,
    onAutoRestrict: opts.onAutoRestrict,
    onAutoRestricted: ({ groupId, refCode, second, subject }) => {
      bus.emit({ type: 'auto.restricted', groupId, refCode, second, subject: subjects.canonical(subject) });
    },
    logger,
    notices,
    autoRestrictRule,
    limits: { maxLength: limits.chatMaxLength, rate: limits.chatRate },
    filters: {
      settings: (roomId) => contexts.filtersOf(roomId),
      accountIsNew: (subject, days) => filterEngine.accountIsNew(subject, days),
      count: (hit) => filterHits.count(hit),
    },
    // A `flag` files a report with no reporter (see `reports.fileSystem`) and counts by what came of it: `flag` when one was filed, `flag_capped`
    // when the daily cap stopped it, `count` when one was already open, the speaker is a guest or anything went wrong. The chat path never waits:
    // the verdict is already decided, so the report (a snapshot, a cap count and an insert in one store transaction) is filed on a microtask,
    // after `accept` has returned, not inside it.
    onFilterFlag: ({ roomId, subject, lineId, hit }) => {
      queueMicrotask(() => {
        void (async () => {
          let outcome: Awaited<ReturnType<typeof reports.fileSystem>> = 'off';
          try {
            outcome = await reports.fileSystem({
              origin: 'filter',
              originKey: hit.key,
              roomId,
              target: subject,
              lineId,
              reportedReason: hit.kind === 'personal_info' ? 'personal_info' : 'spam',
            });
          } catch {
            // fileSystem never rejects; a failure to even ask counts as a plain count
          }
          filterHits.count({ key: hit.key, action: outcome === 'filed' ? 'flag' : outcome === 'capped' ? 'flag_capped' : 'count' });
        })();
      });
    },
    pace: {
      settings: paceOf,
      floorMax: () => (policy.profileNow().rooms.probation.enabled ? policy.profileNow().rooms.probation.slowModeMs : 0),
      canonical: (subject) => subjects.canonical(subject),
      // A flood trip records the built-in kind, deferred so the verdict is returned first. `flood` never throws and logs its own
      // refusals; a room id the signal rules do not accept is left out (the trip is then a day source, not dropped).
      onFlood: ({ roomId, subject }) => {
        queueMicrotask(() => {
          try {
            signalRef.service?.flood(subject, roomId);
          } catch (err) {
            safeWarn(logger, 'chatwarden.pace_failed', { error: err instanceof Error ? err.name : typeof err });
          }
        });
      },
    },
  });
  const reports = new ReportService({
    roster,
    buffer,
    subjects,
    store,
    clock,
    enabled,
    reporting: () => policy.profileNow().reporting,
    onReport: opts.onReport,
    logger,
    limits: limits.reports,
    flagCap: () => policy.profileNow().filters.flagCapPerDay,
    // A report a filter filed is announced like any other: `report.created` with its origin.
    onSystemReport: (reportId) => announceReport(reportId),
  });
  const doors = new DoorService({ hasher, subjects, sanctions, clock, logger, notices });
  // The AI service is built after the audit trail it writes to; a decision reaches it through this late binding.
  const aiRef: { service?: AiService } = {};
  // The "do not automate" mark (design 6.4): kept under the canonical person; `cw.people.automation` is this same facade.
  const automation = createAutomation({ store, subjects, clock, logger });
  const aiSuggest = (subject: SubjectId, level: ConductLevel | null, rule: RuleRef, context: { roomId: string | null }): Suggestion =>
    suggest(policy.profileNow(), historyOf(store, subjects, subject, clock.now()), level, rule, clock.now(), context);
  // Whether the store can keep the mark at all: a store that cannot is a store that cannot say, and the AI never acts on a person it could not check.
  const automationKept = typeof store.loadNoAutomation === 'function' && typeof store.setNoAutomation === 'function';
  const actionRowsKept =
    typeof store.insertAiAction === 'function' &&
    typeof store.loadAiAction === 'function' &&
    typeof store.transitionAiAction === 'function' &&
    typeof store.dueAiActions === 'function' &&
    typeof store.aiActedCount === 'function' &&
    typeof store.aiActionsOnSubjects === 'function' &&
    typeof store.aiUnreviewed === 'function' &&
    typeof store.aiActingState === 'function' &&
    typeof store.setAiActingState === 'function';
  const actor =
    opts.ai === undefined || opts.ai.act === undefined || actorModule === undefined || aiMissing.length > 0 || !actionRowsKept
      ? undefined
      : new actorModule.AiActionService({
          store,
          clock,
          logger,
          profile: () => policy.profileNow(),
          rules,
          suggest: aiSuggest,
          acting: () => aiRef.service?.acting.state() ?? { mode: 'off', paused: false },
          appealsEnabled: () => appealService.enabled(),
          // Computed from the store at the moment of use, never cached (design 3 ruling 5).
          gates: () => aiRef.service?.gates() ?? createInertAi().gates(),
          automationAllowed: (person) => automationKept && automation.get(person).allowed,
          reporter: (subject) => {
            const accuracy = reporterAccuracyFor(store, subjects, [subject], clock.now()).get(subjects.canonical(subject));
            return { habitual: accuracy?.habitual === true, badFaith: (accuracy?.badFaith ?? 0) > 0 };
          },
          aliases: (subject) => subjects.aliasesOf(subject),
          adapterId: opts.ai.adapter.id,
          confirmAdapterId: (opts.ai.act.confirmAdapter ?? opts.ai.adapter).id,
          mask: opts.ai.blockedLines === 'mask',
          caps: actorModule.checkActCaps(opts.ai.act.caps),
          holdback: (input) => hmacSha256Hex(opts.secret, input),
          audit: (input) => audit.record(input),
        });
  const decisions = new DecisionService({
    store,
    subjects,
    rules,
    notices,
    clock,
    index: sanctions,
    logger,
    reporterFeedback: limits.reporterFeedback,
    aiOutcome: (args) => aiRef.service?.outcomeOf(args) ?? null,
  });

  // The person behind a player's connection details, FOUND and never created. An IP alone finds nobody.
  const personOf = (who: RawWho): SubjectId | null => {
    const ids = hashWho(hasher, who);
    return subjects.lookup({ clientKey: ids.clientKey, accountId: ids.accountId, ipHash: null });
  };
  // Appeals. Turning them on in code (the profile or its overrides) over a store that cannot keep them is a plain mistake, refused here
  // before anything is started. A stored layer that does it is data, not code: the policy keeps appeals off and warns (see PolicyService).
  if (baseProfile.appeals.enabled && !hasAppealMethods(store)) {
    throw new Error('createChatwarden: appeals are enabled, but this store has no appeal methods (SqliteStore has them from schema 22; the in-memory store needs its opt-in appeals wrapper)');
  }
  /** The one answer to "does a moot or a decision clear the statement at once": the retention the kit was created with. */
  const clearAppealStatements = (): boolean => (retentionPolicy.appealStatementsMs ?? RETENTION_DEFAULTS.appealStatementsMs) === 0;
  signalRef.service = signalModule === undefined ? createInertSignals(logger, () => policy.profileNow().signals) : new signalModule.SignalService({
    store,
    clock,
    logger,
    subjects,
    personOf,
    settings: () => policy.profileNow().signals,
    signalsMs: () => retentionPolicy.signalsMs ?? RETENTION_DEFAULTS.signalsMs,
    ...(opts.signals?.accountAgeDays === undefined ? {} : { accountAgeDays: opts.signals.accountAgeDays }),
  });
  const signals = signalRef.service;
  /** A player-facing read: a store failure is logged (class only) and reads as `fallback`. */
  const forPlayer = <T>(who: RawWho, fallback: T, read: (subject: SubjectId) => T): T => {
    try {
      const subject = personOf(who);
      return subject === null ? fallback : read(subject);
    } catch (err) {
      safeWarn(logger, 'chatwarden.notices_failed', { error: err instanceof Error ? err.name : typeof err });
      return fallback;
    }
  };

  /** The typing lookup runs at keystroke rate: a failing store logs once a minute, not once a keystroke. */
  const restrictedWarn = new ThrottledWarn(logger, clock);
  const eventFailed = (err: unknown): void => {
    safeWarn(logger, 'chatwarden.event_failed', { error: err instanceof Error ? err.name : typeof err });
  };
  /** `report.created` for a stored report: read back from the store, so the event states what was stored. */
  const announceReport = (reportId: string): void => {
    try {
      const stored = store.loadReport(reportId);
      if (stored === null) return;
      bus.emit({
        type: 'report.created',
        reportId: stored.id,
        createdAt: stored.createdAt,
        category: stored.category,
        reportedReason: stored.reportedReason ?? null,
        urgent: stored.urgent === true,
        ...(stored.origin === null || stored.origin === undefined ? {} : { origin: stored.origin }),
        roomTags: { ...stored.tags },
      });
    } catch (err) {
      eventFailed(err);
    }
  };

  const seat: Chatwarden['rooms']['seat'] = (roomId, seatId, who, handle, tags) => {
    // The tags are checked first, so a malformed or changed context seats nobody and creates no person.
    roster.checkTags(roomId, tags);
    const subject = subjects.resolve(hashWho(hasher, who));
    roster.seat(roomId, seatId, subject, handle, tags);
  };

  /**
   * One retention pass. When it finished an erase that had kept a remainder, this process forgets that person at once (the subject index catches up with the store).
   * The timer and `cw.purge()` both run it.
   */
  const runPurge = async (policyNow: Partial<RetentionPolicy>): Promise<PurgeResult> => {
    // A person made in this process whose save to the store failed has rows that look like strays: write them first (the index retries on a flush), and when one is
    // still unsaved leave the sweep for the next pass rather than delete the rows of a person who is playing right now.
    await subjects.flush();
    const result = await purge(store, clock.now(), policyNow, { sweepStrays: !subjects.hasUnsaved() });
    // The sweep is visible: a count and nothing else (no id, no line), so an integration that writes rows for people it never saved shows up in the log.
    if (result.strayRows > 0) safeWarn(logger, 'chatwarden.stray_rows_swept', { count: result.strayRows });
    if (result.erasuresFinished > 0 || result.strayRows > 0) await subjects.refresh();
    return result;
  };

  // The retention timer. `setInterval` is not a clock read, so Date.now() stays out of it; `unref` so it never
  // keeps a process alive.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.retention !== false) {
    // The whole callback is fenced, `clock.now()` included, and so is the logging: nothing here may ever become
    // an unhandled rejection or an uncaught exception from a timer, which would crash the process.
    const failed = (err: unknown): void => {
      safeWarn(logger, 'chatwarden.purge_failed', { error: err instanceof Error ? err.name : typeof err });
    };
    timer = setInterval(() => {
      try {
        runPurge(retentionPolicy).then(undefined, failed);
      } catch (err) {
        failed(err);
      }
    }, purgeEveryMs);
    (timer as { unref?: () => void }).unref?.();
  }

  // The one place a decision is made AND announced: `decide` and `dismissMany` both go through it, so a report closed by a bulk
  // emits exactly the events a single decision does.
  const decideAnnounced: Chatwarden['decide'] = async (input) => {
    const { result, committed } = await decisions.decideDetailed(input);
    if (committed !== null) {
      try {
        bus.emit({ type: 'report.closed', reportId: committed.reportId, verdict: committed.verdict, at: committed.at });
        for (const g of committed.applied) {
          bus.emit({
            type: 'sanction.applied',
            groupId: g.groupId,
            refCode: g.refCode,
            kind: g.kind,
            until: g.until,
            rule: g.rule,
            source: g.source,
            automated: false,
            target: g.target,
          });
        }
        for (const g of committed.applied) {
          if (g.gap) bus.emit({ type: 'gap.created', groupId: g.groupId, refCode: g.refCode, at: committed.at, subject: subjects.canonical(g.target) });
        }
      } catch (err) {
        eventFailed(err);
      }
      // A decision recorded against an AI read leaves one audit row, written by the moderator (best effort: it never fails the decision).
      const recorded = committed.aiOutcome;
      if (recorded !== null && recorded.role !== null) {
        try {
          audit.record({ actor: recorded.actor, role: recorded.role, action: 'ai.outcome', target: { type: 'report', ref: committed.reportId } });
        } catch (err) {
          eventFailed(err);
        }
      }
    }
    return result;
  };

  const audit = new AuditService({ store, clock, logger });
  const desk = new CaseDesk({
    store,
    subjects,
    clock,
    reasons: () => policy.profileNow().reporting.reasons,
    accuracy: (people) => reporterAccuracyFor(store, subjects, people, clock.now()),
    boosted: (people) => signals.boosted(people),
  });
  const reasonBook = new ReasonBook(store);
  const caseWorkflow = new CaseWorkflow({ store, clock, emit: (event) => bus.emit(event) });
  const commentService = new CommentService({ store, clock, enabled: () => policy.profileNow().desk.workflow, emit: (event) => bus.emit(event) });

  // The case read (`reports.get`): the staff report plus the evidence pointer with its link and, when `desk.surge` is on and the person is over its threshold, the surge hint. Neither is stored, raised or
  // used by anything else; a failure of the surge read leaves the case without the hint.
  const caseOf = (report: StaffReport): StaffReport => {
    const profile = policy.profileNow();
    const evidence = report.evidenceRef === null ? null : { ref: report.evidenceRef, url: evidenceLink(profile.reporting, report.evidenceRef) };
    let surge: ReportSurge | null = null;
    try {
      surge = surgeOf(report.targetPerson, clock.now(), profile.desk.surge, {
        listReportsByPerson: (people, limit) => store.listReportsByPerson(people, limit),
        aliasesOf: (subject) => subjects.aliasesOf(subject),
        canonical: (subject) => subjects.canonical(subject),
        ...(accountAges.enabled ? { ageOf: (subject: SubjectId) => accountAges.ageOf(subject) } : {}),
      });
    } catch (err) {
      safeWarn(logger, 'chatwarden.surge_failed', { error: err instanceof Error ? err.name : typeof err });
    }
    return { ...report, evidence, ...(surge === null ? {} : { surge }) };
  };
  /** How a person is linked: counts only (see `people.links`). */
  const personLinks = (subject: SubjectId): PersonLinks => {
    const out: PersonLinks = { accounts: 0, devices: 0, merged: 0, inForceOnLinked: { ban: 0, area: 0, chat: 0 } };
    if (typeof subject !== 'string' || subject === '') return out;
    const root = subjects.canonical(subject);
    const ids = subjects.identifiersOf(root);
    const aliases = subjects.aliasesOf(root);
    out.accounts = ids.accounts.length;
    out.devices = ids.keys.length;
    out.merged = Math.max(0, aliases.length - 1);
    if (out.merged > 0) {
      // Subject rows only (an address row is never listed), in force now, on a subject that is not the person's own.
      for (const row of store.listSubjectSanctions({ subjects: aliases, activeAt: clock.now(), limit: 200 })) {
        if (row.value === root) continue;
        if (row.kind === 'ban' || row.kind === 'area' || row.kind === 'chat') out.inForceOnLinked[row.kind] += 1;
      }
    }
    return out;
  };

  // Insights: on with `desk.insights` and a store that can read the rows.
  const insightsOn = (): boolean => policy.profileNow().desk.insights && typeof store.insightRows === 'function';
  /** One window of Insights, or null when it is off. The rows go back 90 days whatever the window, so an old open report still shows in the wait; the window is cut in `computeInsights`. `RangeError` for a bad `days`, off or on. */
  const readInsights = (days: number): InsightsResult | null => {
    const window: InsightsDays = checkInsightsDays(days);
    if (!insightsOn()) return null;
    // What this process has counted this minute counts too.
    chatCounter.flush();
    const now = clock.now();
    const from = now - window * 86_400_000;
    const rows = store.insightRows?.(now - INSIGHTS_READ_DAYS * 86_400_000, INSIGHTS_ROW_CAP) ?? [];
    // The oldest open report in the whole store (oldest first): one that the 90 day read or the row cap left out still sets the longest wait, and makes the result partial.
    const oldestOpenAt = store.listOpenReports({ limit: 1 })[0]?.createdAt ?? null;
    const counts = store.chatCounts?.(utcDay(from), utcDay(now)) ?? [];
    // `null`, not `[]`, when the store cannot count them: the page says "not available", not "none".
    const rules = store.countSanctionsByRule?.(from) ?? null;
    const labels = new Map(policy.profileNow().reporting.reasons.map((r) => [r.id, r.label] as const));
    return computeInsights(rows, counts, rules, now, window, (id) => labels.get(id), { oldestOpenAt });
  };
  const digestOf = (days: number): InsightsDigest | null => {
    const r = readInsights(days);
    if (r === null) return null;
    return {
      days: r.days,
      from: r.from,
      to: r.to,
      filed: r.reports.filed,
      decided: r.reports.decided,
      open: r.reports.open,
      urgentFiled: r.urgent.filed,
      urgentOpen: store.countOpenUrgent?.() ?? 0,
      medianMs: r.decision.medianMs,
      p90Ms: r.decision.p90Ms,
      longestOpenMs: r.wait.longestOpenMs,
    };
  };

  // The AI read service. It listens for new reports and only enqueues; with no adapter it is a facade that is always off.
  const aiService =
    opts.ai === undefined || aiModule === undefined || aiMissing.length > 0
      ? undefined
      : new aiModule.AiService({
          options: opts.ai,
          store,
          clock,
          logger,
          profile: () => policy.profileNow(),
          rules,
          suggest: aiSuggest,
          subscribe: bus.on,
          audit: (input) => audit.record(input),
          exampleRetentionMs: () => retentionPolicy.aiExamplesMs ?? RETENTION_DEFAULTS.aiExamplesMs,
          // The counts about the reported person the feed allows (`feeds.ai`), as label, polarity, distinct and window: nothing else leaves.
          // The rules cautioned for by the appeals the moderators lost (revokes only), as bands and rule numbers: never a rate, a count or a person.
          cautions: () => appealService.cautions(),
          // Acting cannot start without in-kit appeals (design 3, ruling 16): read live, never kept.
          appealsEnabled: () => appealService.enabled(),
          // The actor and what the AI module's own cheap checks need (design 6.1): ids go to `propose`, and the lookups below are the ones every act call site passes.
          ...(actor === undefined ? {} : { propose: actor.propose }),
          automationAllowed: (person) => automationKept && automation.get(person).allowed,
          reporter: (subject) => {
            const accuracy = reporterAccuracyFor(store, subjects, [subject], clock.now()).get(subjects.canonical(subject));
            return { habitual: accuracy?.habitual === true, badFaith: (accuracy?.badFaith ?? 0) > 0 };
          },
          aliases: (subject) => subjects.aliasesOf(subject),
          holdbackHash: (input) => hmacSha256Hex(opts.secret, input),
          // The appeals side of the gate dashboard (revokes only; a reduce is carried apart and never counts). Read live from the appeals service, never from
          // the AI: with appeals absent or disabled every cell reads "not available". Nothing yet records an AI action, so no revoke of one is known.
          appealFacts: (cells) => {
            if (!appealService.enabled()) return cells.map(() => ({ available: false, ruleSanctions: 0, ruleRevokes: 0, ruleReduces: 0, actRevokeAt: null }));
            const byRule = new Map(appealService.stats({ days: 90 }).perRule.flatMap((r) => (typeof r.rule === 'number' ? [[r.rule, r] as const] : [])));
            return cells.map((c) => {
              const r = byRule.get(c.rule);
              return { available: true, ruleSanctions: r?.sanctions ?? 0, ruleRevokes: r?.granted ?? 0, ruleReduces: r?.lightened ?? 0, actRevokeAt: null };
            });
          },
          signals: (subject) => signals.forAi(subject).map((c) => ({ label: c.label, polarity: c.polarity, distinct: c.distinct, windowDays: c.windowDays })),
        });
  aiRef.service = aiService;
  const ai: AiFacade = aiService ?? createInertAi();
  const appealService = new AppealService({
    store,
    subjects,
    notices,
    clock,
    logger,
    settings: () => policy.profileNow().appeals,
    personOf,
    emit: (event) => bus.emit(event),
    matcher: opts.matcher,
    index: sanctions,
    clearStatements: clearAppealStatements,
    // A granted appeal marks the original decision reversed in the casebook; with no AI this is the inert facade and does nothing.
    // A REVOKE teaches the opposite sign and counts as a false positive; a REDUCE only keeps the decision from teaching (the rule applied).
    onGranted: (appeal, outcome) => void (outcome === 'revoke' ? ai.markReversed(appeal.reportId as string, { corrective: true }) : ai.markReversed(appeal.reportId as string)),
  });

  // Names. The profanity filter for a name is the kit's own when the profile has one; otherwise (a profile that allows swearing in chat) it is
  // built from the package on first use, so `names.profanity` works whatever the chat profile does with swearing. A package that cannot build
  // one fails once and is remembered: the name check lets names through and logs the class.
  let nameFilter: { filter: ProfanityFilter | undefined } | { error: unknown } | undefined;
  const filterForNames = (): ProfanityFilter | undefined => {
    if (profanity !== undefined) return profanity;
    if (nameFilter === undefined) {
      try {
        nameFilter = { filter: opts.profanity ?? (opts.profanityPackage === undefined ? undefined : buildPackageFilter(opts.profanityPackage, baseProfile.profanity)) };
      } catch (error) {
        nameFilter = { error };
      }
    }
    if ('error' in nameFilter) throw nameFilter.error;
    return nameFilter.filter;
  };
  const nameService = new NameService({
    store,
    clock,
    logger,
    hasher,
    rule: autoRestrictRule,
    matcher: opts.matcher,
    settings: () => policy.profileNow().names,
    filter: filterForNames,
    personOf,
    notices,
    subjects,
    rules,
    emit: (event) => bus.emit(event),
  });

  // What the kit holds in memory about erased people (not the subject index itself): evidence lines, caches, pacing, claims and the sanction and mute indexes, and with
  // `whole` the room seats. The store rows are the store's.
  const forgetInMemory = (people: ReadonlySet<SubjectId>, whole: boolean): void => {
    const reloaded = (what: string) => (err: unknown) => safeWarn(logger, 'chatwarden.privacy_failed', { error: err instanceof Error ? err.name : typeof err, what });
    buffer.scrub(people);
    chat.forgetPeople(people);
    accountAges.forget(people);
    strikes.forgetPeople(people);
    notices.forgetPeople(people);
    signals.forgetPeople?.(people);
    desk.forgetPeople(people);
    // The sanction and mute indexes are read back from the store: a sanction the remainder keeps still applies, one that went stops at once.
    sanctions.load(store, clock.now()).catch(reloaded('sanctions'));
    mutes.load().catch(reloaded('mutes'));
    if (whole) roster.forget(people);
  };

  // Privacy requests. `forget` is what the kit holds in memory about an erased person; the store rows are the store's (see `PrivacyDeps.forget`).
  const privacy = createPrivacy({
    store,
    clock,
    subjects,
    hasher,
    logger,
    audit: (input) => audit.record(input),
    retention: () => retentionPolicy,
    forget: (people, whole) => {
      forgetInMemory(people, whole);
      if (whole) subjects.forget(people);
    },
  });
  // The same fix-up for people the subject index learns are gone because ANOTHER process erased them (a reload after the epoch moved): their room seats become
  // guests and every cache lets go, so a seat of an erased person never keeps writing rows under the dead id.
  subjects.onGone = (gone) => forgetInMemory(gone, true);

  return {
    ai,
    signals: {
      record: (input) => signals.record(input),
      counts: (subject, o) => signals.counts(subject, o),
      kinds: () => signals.kinds(),
      boosted: (people) => signals.boosted(people),
      forRecord: (subject) => signals.forRecord(subject),
    },
    rooms: {
      seat,
      seatConnection: (roomId, seatId, ctx, handle, tags) => {
        seat(roomId, seatId, platform.identify(ctx), handle, tags);
      },
      unseat: (roomId, seatId) => {
        roster.unseat(roomId, seatId);
      },
      close: (roomId) => {
        roster.close(roomId);
        buffer.drop(roomId);
        paceOverrides.delete(roomId);
        paceMerged.delete(roomId);
        emergencyPace.delete(roomId);
        roomModes.clear(roomId);
        chat.dropPaceRoom(roomId);
      },
      subjectAt: (roomId, seatId) => {
        const subject = roster.occupant(roomId, seatId)?.subject ?? null;
        return subject === null ? null : subjects.canonical(subject);
      },
      setPace: (roomId, pace) => {
        if (typeof roomId !== 'string' || roomId === '') throw new ProfileError('roomId', 'must be a non-empty string');
        paceMerged.delete(roomId);
        if (pace === null) {
          paceOverrides.delete(roomId);
          return;
        }
        // The caller's object is read once, into a validated snapshot of the fields it gave (a field left out inherits); that
        // snapshot is what is kept, so nothing about it can change after the check.
        const kept = checkPace(pace);
        if (kept.burst !== undefined && kept.burst !== null) Object.freeze(kept.burst);
        if (Object.keys(kept).length === 0) paceOverrides.delete(roomId);
        else paceOverrides.set(roomId, Object.freeze(kept));
      },
      pace: (roomId) => paceOf(roomId),
      setMode: (roomId, mode, o) => roomModes.set(roomId, mode, o),
      mode: (roomId) => roomModes.get(roomId),
      list: () => {
        const modes = new Map(roomModes.active().map((m) => [m.roomId, m] as const));
        const seen = new Set<string>();
        const rows: Array<{ roomId: string; tags: Record<string, string>; seated: number; mode: RoomMode; until: number | null }> = [];
        for (const room of roster.rooms()) {
          seen.add(room.roomId);
          const m = modes.get(room.roomId);
          rows.push({ roomId: room.roomId, tags: room.tags, seated: room.seated, mode: m?.mode ?? 'normal', until: m?.until ?? null });
        }
        for (const m of modes.values()) if (!seen.has(m.roomId)) rows.push({ roomId: m.roomId, tags: {}, seated: 0, mode: m.mode, until: m.until });
        // A room that is empty and has no mode is not worth a row; the most seated first, then by room id so the order is stable.
        return rows
          .filter((r) => r.seated > 0 || r.mode !== 'normal')
          .sort((a, b) => b.seated - a.seated || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0))
          .slice(0, 500);
      },
      retract: (roomId, lineId, o) => {
        if (typeof roomId !== 'string' || roomId === '' || typeof lineId !== 'string' || lineId === '') return { ok: false, refused: 'not_found' };
        const lineIds = buffer.retract(roomId, lineId, { allFromAuthor: o?.allFromAuthor === true, canonical: (subject) => subjects.canonical(subject) });
        if (lineIds.length === 0) return { ok: false, refused: 'not_found' };
        bus.emit({ type: 'line.retracted', roomId, lineIds, at: clock.now() });
        return { ok: true, lineIds: [...lineIds] };
      },
      lineStates: (roomId) => (typeof roomId === 'string' ? buffer.snapshot(roomId).map((l) => ({ lineId: l.lineId, ts: l.ts, retracted: l.retracted === true })) : []),
      postingState: (roomId, seatId, o) => {
        const subject = roster.occupant(roomId, seatId)?.subject ?? null;
        return chat.modeRefusal(roomId, subject, o?.staff === true)?.reason ?? 'ok';
      },
    },
    contexts: {
      names: () => contexts.names(),
      of: (roomId) => (typeof roomId === 'string' ? contexts.of(roomId) : null),
      effective: (name) => contexts.effective(name),
    },
    filters: {
      stats: (q) => {
        if (q === null || typeof q !== 'object' || (q.days !== 7 && q.days !== 30)) return Promise.reject(new RangeError('filters.stats: days must be 7 or 30'));
        return filterHits.stats(q.days);
      },
      test: (text, candidate) => {
        if (typeof text !== 'string') throw new TypeError('filters.test: text must be a string');
        const settings = candidate === undefined ? policy.profileNow().filters : resolveFilters(candidate, 'candidate');
        // The line is read as chat reads it (trimmed), but the ranges are given on the text as it was handed in, so a screen that shows the text as
        // typed marks the right characters. `delivered` is the trimmed line, as it would be sent.
        const line = text.trim();
        const result = testLine(filterEngine.evaluateWith(settings, line, { subject: null }), line);
        return line.length === 0 || line.length === text.length ? result : shiftTestSpans(result, text.length - text.trimStart().length);
      },
      check: (candidate, lines) => checkLines(filterEngine, resolveFilters(candidate, 'candidate'), lines),
    },
    chat: {
      accept: (roomId, seatId, text, o) => chat.accept(roomId, seatId, text, o),
      visibleTo: (roomId, viewerSeat, senderSeat) => chat.visibleTo(roomId, viewerSeat, senderSeat),
      restricted: (who, o) => {
        try {
          return chat.restricted(personOf(who), o?.roomId, o?.seatId);
        } catch (err) {
          restrictedWarn.warn('chatwarden.restricted_failed', { error: err instanceof Error ? err.name : typeof err });
          return { restricted: false, until: null, kind: null };
        }
      },
      restrictedBySubject: (subject, o) => {
        if (typeof subject !== 'string' || subject === '') return { restricted: false, until: null, kind: null };
        try {
          return chat.restricted(subject, o?.roomId, o?.seatId);
        } catch (err) {
          restrictedWarn.warn('chatwarden.restricted_failed', { error: err instanceof Error ? err.name : typeof err });
          return { restricted: false, until: null, kind: null };
        }
      },
    },
    mutes: {
      set: (roomId, viewerSeat, targetSeat, on) => {
        const viewer = roster.occupant(roomId, viewerSeat)?.subject ?? null;
        const target = roster.occupant(roomId, targetSeat)?.subject ?? null;
        if (viewer === null || target === null) return;
        mutes.set(viewer, target, on);
      },
      mutedSeats: (roomId, viewerSeat) => mutes.mutedSeats(roomId, viewerSeat, roster),
    },
    reports: {
      submit: async (input) => {
        const res = await reports.submit(input);
        if (res.ok) announceReport(res.reportId);
        return res;
      },
      fileSystem: (input) => reports.fileSystem(input),
      addDetail: async (reportId, reporterSeat, detail) => {
        const res = await reports.addDetail(reportId, reporterSeat, detail);
        // The follow-up changes what the AI would read: queue one new read (it only enqueues; the reporter's ack never waits).
        if (res.ok) aiService?.caseChanged(reportId);
        return res;
      },
      list: (q) => listStaffReports(store, subjects, q, policy.profileNow().reporting.reasons),
      get: (id) => {
        const record = typeof id === 'string' ? store.loadReport(id) : null;
        return record === null ? null : caseOf(staffReport(record, subjects));
      },
      reporterRecord: (subject) => reporterRecord(store, subjects, limits.reports, subject, clock.now(), policy.profileNow().reporting.reasons),
      reporterAccuracy: (people) => reporterAccuracyFor(store, subjects, people, clock.now()),
      dismissMany: (input) => dismissMany({ store, subjects, holders: (people) => desk.holders(people), decide: decideAnnounced }, input),
    },
    blocked: {
      list: (q) => blockedItems(store, subjects, q?.days, clock.now()),
      countsByTerm: (q) => blockedCountsByTerm(store, q?.days, clock.now()),
      names: (q) => blockedNameItems(store, subjects, q?.days, clock.now()),
    },
    cases: {
      holder: (person) => desk.holder(person),
      holders: (people) => desk.holders(people),
      claim: (person, actor, o) => desk.claim(person, actor, o),
      release: (person, actor) => desk.release(person, actor),
      releaseWhenDone: (person, actor) => desk.releaseWhenDone(person, actor),
      next: (actor, filter) => desk.next(actor, filter),
      setUrgent: (reportId, actor, on) => caseWorkflow.setUrgent(reportId, actor, on),
      handoff: (reportId, actor) => caseWorkflow.handoff(reportId, actor),
      escalate: (reportId, actor, role, input) => commentService.escalate(reportId, actor, role, input),
      clearEscalation: (reportId, actor, role) => commentService.clearEscalation(reportId, actor, role),
      askedCount: () => commentService.askedCount(),
      urgentCount: () => caseWorkflow.urgentCount(),
      view: (person, actor) => desk.view(person, actor),
      viewers: (person, except) => desk.viewers(person, except),
      viewersOf: (people, except) => desk.viewersOf(people, except),
    },
    comments: {
      add: (reportId, actor, role, text) => commentService.add(reportId, actor, role, text),
      list: (reportId) => commentService.list(reportId),
      remove: (reportId, commentId, actor, role) => commentService.remove(reportId, commentId, actor, role),
    },
    desk: { workflowEnabled: () => policy.profileNow().desk.workflow },
    insights: {
      enabled: () => insightsOn(),
      read: (days = 30) => readInsights(days),
      digest: (days = 7) => digestOf(days),
      emitDigest: (days = 7) => {
        const digest = digestOf(days);
        if (digest !== null) bus.emit({ type: 'insights.digest', at: clock.now(), digest: { ...digest } });
        return digest;
      },
      flush: () => chatCounter.flush(),
    },
    changes: { token: () => store.changeToken() },
    reasons: {
      list: () => reasonBook.list(),
      add: (input) => reasonBook.add(input),
      update: (id, patch) => reasonBook.update(id, patch),
      setActive: (id, active) => reasonBook.setActive(id, active),
    },
    doors: { check: (kind, who) => doors.check(kind, who) },
    sanctions: {
      apply: async (input) => {
        // The AI's own source is not for a caller (design 6.1): refused before the clock, the store or the index is touched.
        if (isInternalSource(input.source)) throw new SanctionError('applySanction: invalid source');
        const now = clock.now();
        const done = await applySanction(store, subjects, input, now, sanctions);
        try {
          const rule: RuleRef = input.rule === undefined ? 'uncovered' : input.rule;
          const noEnd = input.kind === 'warning' || input.kind === 'note' || input.durationMs === null;
          bus.emit({
            type: 'sanction.applied',
            groupId: done.groupId,
            refCode: done.refCode,
            kind: input.kind,
            until: noEnd ? null : now + (input.durationMs ?? 0),
            rule,
            source: input.source,
            automated: input.automated,
            target: subjects.canonical(input.subject),
          });
          // A gap row exists only for a moderator's uncovered rule (the sanction check requires its note).
          if (rule === 'uncovered' && input.source === 'moderator') {
            bus.emit({ type: 'gap.created', groupId: done.groupId, refCode: done.refCode, at: now, subject: subjects.canonical(input.subject) });
          }
        } catch (err) {
          eventFailed(err);
        }
        return done;
      },
      revoke: async (groupId, actor, reason) => {
        // One instant for the stored revokedAt and the event, so a consumer correlating the two sees the same time.
        const at = clock.now();
        const { revoked } = await revokeAndWithdraw(store, groupId, actor, reason, {
          notices,
          clock: { now: () => at },
          index: sanctions,
          clearAppealStatements,
        });
        if (revoked) {
          try {
            const code = store.sanctionRefCode(groupId);
            const target = store.sanctionGroupTarget(groupId);
            if (code !== null && target !== null) {
              // A stored rule the reader cannot parse is `rule: null`, never a throw: the revoke happened, and the event still goes out.
              let rule: ReturnType<typeof parseRuleRef> | null = null;
              try {
                rule = parseRuleRef(target.rule ?? 'uncovered');
              } catch {
                rule = null;
              }
              bus.emit({
                type: 'sanction.revoked',
                groupId,
                refCode: code,
                at,
                subject: subjects.canonical(target.subject),
                rule: typeof rule === 'number' ? rule : null,
              });
            }
          } catch (err) {
            eventFailed(err);
          }
        }
        return revoked;
      },
      forPerson: (subject) => sanctionsOfPerson(store, subjects, subject, clock.now()),
      list: (q) => listSanctionGroups(store, subjects, q ?? {}, clock.now()),
      byRef: (refCode) => {
        const code = normalizeRefCode(refCode);
        return code === null ? null : sanctionByRef(store, subjects, code, clock.now());
      },
    },
    on: bus.on,
    names: {
      check: (text, o) => nameService.check(text, o),
      flagged: (text) => nameService.flagged(text),
      requireRename: (input) => nameService.requireRename(input),
      pendingRename: (who) => nameService.pendingRename(who),
      renamed: (who) => nameService.renamed(who),
      renamesEnabled: () => nameService.renamesEnabled(),
      renamesOf: (subject) => nameService.renamesOf(subject),
    },
    links: {
      supported: hasLinkMethods(store),
      get: (system, ref) => {
        if (!hasLinkMethods(store) || !isLinkSystem(system) || !isLinkValue(ref)) return null;
        return store.getLink?.(system, ref) ?? null;
      },
      put: (row) => {
        checkLinkRow(row);
        if (!hasLinkMethods(store)) throw new Error('chatwarden: links are not supported by this store');
        const { system, ref, external, state, at } = row;
        store.putLink?.({ system, ref, external, state, at });
      },
      list: (system, q) => {
        if (!hasLinkMethods(store) || !isLinkSystem(system)) return [];
        const state = q?.state;
        return store.listLinks?.(system, { ...(typeof state === 'string' ? { state } : {}), limit: linkLimit(q?.limit) }) ?? [];
      },
    },
    rules,
    get profile() {
      return policy.profileNow();
    },
    policy: {
      get: () => policy.get(),
      save: (layer, ctx) => policy.save(layer, ctx),
      preview: (layer, rule) => policy.preview(layer, rule),
      reset: (section, o) => policy.reset(section, o),
      refresh: () => policy.refresh(),
    },
    limits,
    get summary() {
      return policy.profileNow().summary;
    },
    documents: bindDocuments({
      get profile() {
        return policy.profileNow();
      },
      rules,
    }),
    notices: {
      pending: (who) => forPlayer<PlayerNotice[]>(who, [], (s) => notices.pending(s)),
      ack: (who, id) => forPlayer(who, false, (s) => notices.ack(s, id)),
      record: (who) => forPlayer<PlayerNotice[]>(who, [], (s) => notices.record(s)),
      pendingWarning: (who) => forPlayer(who, false, (s) => notices.pendingWarning(s)),
      lineText: (line) => notices.lineText(line),
    },
    appeals: {
      enabled: () => appealService.enabled(),
      file: (who, input) => appealService.file(who, input),
      mine: (who) => appealService.mine(who),
      decide: (input) => appealService.decide(input),
      list: (q) => appealService.list(q),
      get: (id) => appealService.get(id),
      openCount: () => appealService.openCount(),
      stats: (q) => appealService.stats(q),
      forPerson: (subject) => appealService.forPerson(subject),
    },
    decide: (input) => decideAnnounced(input),
    history: (subject) => historyOf(store, subjects, subject, clock.now()),
    suggest: (subject, level, rule, context) => {
      const now = clock.now();
      // The signal hits are the kit's to compute: a list the caller passes is dropped, the real one set when a ladder rule is met.
      const { signals: _ignored, ...given } = (context ?? {}) as SuggestContext;
      void _ignored;
      const hits = signals.ladderHits(subject);
      return suggest(policy.profileNow(), historyOf(store, subjects, subject, now), level, rule, now, hits.length === 0 ? given : { ...given, signals: hits });
    },
    gaps: {
      list: () =>
        store.listGaps().map(
          (r): GapRow => ({
            groupId: r.groupId,
            refCode: r.refCode,
            at: r.startsAt,
            actor: r.actor,
            note: r.gapNote ?? '',
            rule: 'uncovered',
            status: r.gapStatus ?? 'open',
          }),
        ),
      close: (groupId, status, ref, actor) => store.transaction(() => store.closeGap(groupId, status, ref, actor, clock.now())),
    },
    audit: {
      record: (input) => audit.record(input),
      list: (q) => audit.list(q),
      roomRef: (roomId) => roomAuditRef(roomId, hasher),
    },
    webhookKeys: {
      reserve: (key, fingerprint) => {
        const now = clock.now();
        return store.transaction(() => store.reserveWebhookKey(key, now, now - WEBHOOK_KEY_TTL_MS, fingerprint));
      },
      complete: (key, resultJson) => store.transaction(() => store.completeWebhookKey(key, resultJson)),
      release: (key) => store.transaction(() => store.releaseWebhookKey(key)),
    },
    people: {
      canonical: (subject) => subjects.canonical(subject),
      aliases: (subject) => subjects.aliasesOf(subject),
      accountIds: (subject) => (typeof subject === 'string' ? subjects.identifiersOf(subject).accounts : []),
      automation,
      links: (subject) => personLinks(subject),
    },
    privacy,
    legal: createLegal({
      store,
      clock,
      emit: (event) => bus.emit(event),
      canonical: (subject) => subjects.canonical(subject),
      accountIds: (subject) => subjects.identifiersOf(subject).accounts,
      bundleSecret,
      kitVersion: VERSION,
    }),
    discordThreads: {
      get: (subject) => store.transaction(() => store.getDiscordThread(subject)),
      put: (row) => store.transaction(() => store.putDiscordThread(row)),
    },
    purge: async (override) => {
      const merged: Partial<RetentionPolicy> = { ...retentionPolicy };
      for (const [k, v] of Object.entries(override ?? {})) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
      checkRetentionFloors(merged, limits.reports.suspendWindowMs);
      // A feed window longer than the signal retention could never be met: refuse the purge that would make it so, deleting nothing.
      const { kinds, feeds } = policy.profileNow().signals;
      checkSignalFeeds(feeds, kinds, { signalsMs: merged.signalsMs ?? RETENTION_DEFAULTS.signalsMs }, 'profile.signals.feeds');
      return await runPurge(merged);
    },
    ready: () => {
      try {
        store.schemaVersion();
        return true;
      } catch (err) {
        safeWarn(logger, 'chatwarden.ready_failed', { error: err instanceof Error ? err.name : typeof err });
        return false;
      }
    },
    flush: () => subjects.flush(),
    close: async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      // Stop reading and abort calls in flight, and let them end before the store goes.
      ai.close();
      await ai.idle();
      chatCounter.flush();
      await filterHits.close();
      await subjects.flush();
      store.close();
    },
  };
}
