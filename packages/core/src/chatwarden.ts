import { AuditService } from './audit.js';
import type { AuditPage, AuditQuery, AuditRecordInput } from './audit.js';
import { ChatService } from './chat.js';
import { DecisionService, revokeAndWithdraw } from './decide.js';
import type { DecisionInput, DecisionResult } from './decide.js';
import type { ChatResult, RestrictedAnswer } from './chat.js';
import { bindDocuments } from './documents.js';
import type { Documents } from './documents.js';
import { DoorService } from './doors.js';
import type { DoorKind, DoorRefusal } from './doors.js';
import { EvidenceBuffer, RoomRoster } from './evidence.js';
import { EventBus } from './events.js';
import type { Subscribe } from './events.js';
import { hashWho, makeHasher } from './hasher.js';
import { safeWarn, ThrottledWarn } from './log.js';
import { historyOf, suggest } from './ladder.js';
import type { ActionRecord, Suggestion, SuggestContext } from './ladder.js';
import { resolveLimits } from './limits.js';
import type { Limits, LimitsInput } from './limits.js';
import { PolicyService } from './policy.js';
import type { PolicyPreview, PolicySaveContext, PolicySaveResult, PolicyState } from './policy.js';
import { resolveProfile } from './profile.js';
import type { ModerationProfile, PolicyLayer, PolicySection, PresetName, ProfanityConfig, ProfileInput, ProfileOverrides } from './profile.js';
import { MuteService } from './mutes.js';
import { NoticeService } from './notices.js';
import type { PlayerNotice } from './notices.js';
import { ReportService } from './reports.js';
import type { ReportCounts, ReportInput, ReportResult } from './reports.js';
import { checkRetentionFloors, purge, RETENTION_DEFAULTS } from './retention.js';
import type { PurgeResult, RetentionPolicy } from './retention.js';
import { defineRules, parseRuleRef, starterRules } from './rules.js';
import type { CommunityRules, RuleRef } from './rules.js';
import { applySanction, SanctionIndex } from './sanctions.js';
import type { SanctionInput } from './sanctions.js';
import { StrikeService } from './strikes.js';
import {
  blockedCountsByTerm,
  blockedItems,
  listSanctionGroups,
  reporterRecord,
  sanctionsOfPerson,
} from './staffViews.js';
import type {
  BlockedDays,
  BlockedItem,
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
   * `auditMs` at least 90 days (default 365), `badFaithMs` at least `limits.reports.suspendWindowMs`. Every field
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
  profile?: PresetName | ProfileInput;
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
  };
  chat: {
    accept(roomId: string, seatId: string, text: string, opts?: { audience?: string[] }): ChatResult;
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
  };
  mutes: {
    /** `viewerSeat`'s occupant mutes (`on`) or unmutes `targetSeat`'s occupant. Does nothing if either seat has no subject. */
    set(roomId: string, viewerSeat: string, targetSeat: string, on: boolean): void;
    /** The seats whose current occupant the viewer has muted. Seat ids only. */
    mutedSeats(roomId: string, viewerSeat: string): string[];
  };
  reports: {
    submit(input: ReportInput): Promise<ReportResult>;
    /**
     * The staff report queue, newest first (ties broken by id), one page at a time. Filter with `status`; pass the
     * previous page's `next` as `before` for the next page; `limit` defaults to 50 and is clamped to 1..200. Each item
     * is a {@link StaffReport}: the whole record plus the canonical staff refs and the own line ids of every person.
     * Throws `ReportQueryError` for an unknown status or a cursor that is not one of ours, and the store's own error
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
     * suspension ends (null if none), under the same rule intake uses. Folds in the person's merged aliases. Staff only:
     * never send to a player (a player is not told who reported or how often).
     */
    reporterRecord(subject: SubjectId): ReporterRecord;
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
     * Claim and return the oldest OPEN case nobody holds, optionally only cases with an open report of `category`
     * (`RangeError` for an unknown one), or null. A case is a person, ranked by their oldest open report and opened on
     * their newest. A case anyone holds is skipped without a write (held cases are read once per page of reports). `category`
     * is the only filter: the order is already oldest first. A candidate lost to a rival in between is retried like `claim`.
     */
    next(actor: string, filter?: { category?: ReportCategory }): NextCase | null;
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
     * May a player use this as a name (a handle, a table or deck name)? Reads it with the matcher's name rules
     * (`Zorbak_99` is caught, not only `zorbak`). `rule` is the Community Rule the slur filter cites
     * (`autoRestrictRule`). No matcher, and a matcher that fails (logged, class only), both let the name through.
     * Throws a TypeError for a value that is not a string.
     */
    check(text: string): { ok: true } | { ok: false; reason: 'name_not_allowed'; rule: number };
  };
  /** The registry in use (the one given, or the starter rules for the profile). Retired rules stay listed. */
  rules: CommunityRules;
  /**
   * The profile in force: the preset, the code overrides and the stored layer from `cw.policy`, validated. Deep-frozen. A
   * getter, read live: after a save (or a change another process saved, within 10 seconds) it is a new object, so never keep
   * one across calls. Everything in the kit that reads the profile reads it through this.
   */
  readonly profile: ModerationProfile;
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
  };
  /**
   * Decide a report: close it, write each sanction and its notice, and tell the people involved, in one
   * transaction. Idempotent (the same decision again is a replay). A malformed or disallowed decision resolves
   * `{ ok: false, error: 'invalid' }`; a STORE failure REJECTS with the store's own error and writes nothing, so a
   * route handler should catch it. Moderator-side: the result carries subject ids, so never forward it to a player.
   * Carries subject ids: staff channels only, never send to a player.
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
  };
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
function buildProfanityFilter(opts: ChatwardenOptions, config: ProfanityConfig): ProfanityFilter | undefined {
  if (config.mode === 'allow') return undefined;
  if (opts.profanity !== undefined) return opts.profanity;
  if (opts.profanityPackage === undefined) return undefined;
  const built = opts.profanityPackage.createProfanityFilter(config);
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
  const purgeEveryMs = everyMs ?? DEFAULT_PURGE_EVERY_MS;
  if (opts.retention !== false && (!Number.isFinite(purgeEveryMs) || purgeEveryMs <= 0)) {
    throw new Error('createChatwarden: retention.everyMs must be a positive finite number');
  }
  if (opts.retention !== false && purgeEveryMs > MAX_PURGE_EVERY_MS) {
    throw new RangeError(`retention.everyMs must be at most ${MAX_PURGE_EVERY_MS}`);
  }
  const rules = opts.rules ?? defineRules(starterRules(baseProfile.rules));
  const autoRestrictRule = opts.autoRestrictRule ?? 1;
  const autoRule = rules.get(autoRestrictRule);
  if (autoRule === undefined || autoRule.retired === true) {
    throw new RangeError('autoRestrictRule must be the number of an active rule in the registry');
  }
  if (opts.matcher === undefined) safeWarn(logger, 'chatwarden.no_matcher');
  const profanity = buildProfanityFilter(opts, baseProfile.profanity);
  if (profanity === undefined && baseProfile.profanity.mode !== 'allow') safeWarn(logger, 'chatwarden.no_profanity_filter');

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
  const policy = new PolicyService({ store, clock, logger, base: baseProfile });
  policy.load();

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

  const chat = new ChatService({
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
  });
  const reports = new ReportService({
    roster,
    buffer,
    subjects,
    store,
    clock,
    enabled,
    onReport: opts.onReport,
    logger,
    limits: limits.reports,
  });
  const doors = new DoorService({ hasher, subjects, sanctions, clock, logger, notices });
  const decisions = new DecisionService({
    store,
    subjects,
    rules,
    notices,
    clock,
    index: sanctions,
    logger,
    reporterFeedback: limits.reporterFeedback,
  });

  // The person behind a player's connection details, FOUND and never created. An IP alone finds nobody.
  const personOf = (who: RawWho): SubjectId | null => {
    const ids = hashWho(hasher, who);
    return subjects.lookup({ clientKey: ids.clientKey, accountId: ids.accountId, ipHash: null });
  };
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
        roomTags: { ...stored.tags },
      });
    } catch (err) {
      eventFailed(err);
    }
  };

  const seat: Chatwarden['rooms']['seat'] = (roomId, seatId, who, handle, tags) => {
    const subject = subjects.resolve(hashWho(hasher, who));
    roster.seat(roomId, seatId, subject, handle, tags);
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
        purge(store, clock.now(), retentionPolicy).then(undefined, failed);
      } catch (err) {
        failed(err);
      }
    }, purgeEveryMs);
    (timer as { unref?: () => void }).unref?.();
  }

  const audit = new AuditService({ store, clock, logger });
  const desk = new CaseDesk({ store, subjects, clock });
  const reasonBook = new ReasonBook(store);

  return {
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
      },
      subjectAt: (roomId, seatId) => {
        const subject = roster.occupant(roomId, seatId)?.subject ?? null;
        return subject === null ? null : subjects.canonical(subject);
      },
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
      list: (q) => listStaffReports(store, subjects, q),
      get: (id) => {
        const record = typeof id === 'string' ? store.loadReport(id) : null;
        return record === null ? null : staffReport(record, subjects);
      },
      reporterRecord: (subject) => reporterRecord(store, subjects, limits.reports, subject, clock.now()),
    },
    blocked: {
      list: (q) => blockedItems(store, subjects, q?.days, clock.now()),
      countsByTerm: (q) => blockedCountsByTerm(store, q?.days, clock.now()),
    },
    cases: {
      holder: (person) => desk.holder(person),
      holders: (people) => desk.holders(people),
      claim: (person, actor, o) => desk.claim(person, actor, o),
      release: (person, actor) => desk.release(person, actor),
      releaseWhenDone: (person, actor) => desk.releaseWhenDone(person, actor),
      next: (actor, filter) => desk.next(actor, filter),
      view: (person, actor) => desk.view(person, actor),
      viewers: (person, except) => desk.viewers(person, except),
      viewersOf: (people, except) => desk.viewersOf(people, except),
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
        const { revoked } = await revokeAndWithdraw(store, groupId, actor, reason, { notices, clock: { now: () => at }, index: sanctions });
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
    },
    on: bus.on,
    names: {
      check: (text) => {
        if (typeof text !== 'string') throw new TypeError('names.check: the name must be a string');
        const m = opts.matcher;
        if (m === undefined) return { ok: true };
        try {
          const hit = typeof m.matchName === 'function' ? m.matchName(text) : m.match(text);
          return hit === null ? { ok: true } : { ok: false, reason: 'name_not_allowed', rule: autoRestrictRule };
        } catch (err) {
          safeWarn(logger, 'chatwarden.names_matcher_failed', { error: err instanceof Error ? err.name : typeof err });
          return { ok: true };
        }
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
    },
    decide: async (input) => {
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
      }
      return result;
    },
    history: (subject) => historyOf(store, subjects, subject, clock.now()),
    suggest: (subject, level, rule, context) => {
      const now = clock.now();
      return suggest(policy.profileNow(), historyOf(store, subjects, subject, now), level, rule, now, context);
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
    },
    discordThreads: {
      get: (subject) => store.transaction(() => store.getDiscordThread(subject)),
      put: (row) => store.transaction(() => store.putDiscordThread(row)),
    },
    purge: async (policy) => {
      const merged: Partial<RetentionPolicy> = { ...retentionPolicy };
      for (const [k, v] of Object.entries(policy ?? {})) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
      checkRetentionFloors(merged, limits.reports.suspendWindowMs);
      return await purge(store, clock.now(), merged);
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
      await subjects.flush();
      store.close();
    },
  };
}
