// Core types for @chatwarden/core. Organized by section; later tasks append
// their own sections below.

import type { AuditListQuery, AuditRow } from './audit.js';
import type { PolicyLayer } from './profile.js';
import type { RuleRef } from './rules.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Who a chat line or a sanction is attached to, in storable form.
 *
 * `clientKey` is the HASHED client key (an HMAC of the raw key; see
 * {@link Hasher}), never the raw credential. `ipHash` is the hashed IP. The
 * `accountId` is the adopter's own account id, kept as given (it is not a
 * secret and is never hashed). Any of the three is null when absent.
 *
 * None of these values may appear in anything returned to a player.
 */
export interface Identifiers {
  /** HASHED client key, or null. */
  clientKey: string | null;
  /** Raw account id as the adopter supplied it, or null. */
  accountId: string | null;
  /** HASHED IP address, or null. */
  ipHash: string | null;
}

/**
 * Who is speaking, as the adopter hands it over, before any hashing.
 *
 * `clientKey` is RAW here (the browser or client credential); `hashWho`
 * turns it into the hashed `Identifiers.clientKey`. An empty string, a missing
 * value, or an `ip` of `'unknown'` all mean "not known".
 */
export interface RawWho {
  /** RAW client key (a credential: never store or log it). */
  clientKey?: string;
  accountId?: string;
  /**
   * The REAL client address of the connection. Behind a reverse proxy, load balancer or CDN, the socket's
   * address is the proxy's, not the player's: parse `X-Forwarded-For` (or your platform's equivalent) yourself,
   * trusting only the hop you control. If you pass a proxy's address, every player appears under one IP, so
   * one IP sanction would silence them all. Hashed before it is stored; `'unknown'`, empty and null mean not
   * known.
   */
  ip?: string | null;
}

/** Stable id of a canonical subject: prefix `s_` then 22 base64url characters. */
export type SubjectId = string;

// ---------------------------------------------------------------------------
// Clock and hashing
// ---------------------------------------------------------------------------

/** Injected time source. Package code never calls `Date.now()` directly. */
export interface Clock {
  /** Current time, epoch milliseconds. */
  now(): number;
}

/** Keyed one-way hashing for client keys and IP addresses. */
export interface Hasher {
  /** Hash a RAW client key. */
  clientKey(raw: string): string;
  /** Hash a raw IP address. */
  ip(raw: string): string;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Where components report failures that must not interrupt the caller (for
 * example a background store write). Defaults to `console.warn`. A log line
 * NEVER carries an identifier, hash, subject id, chat text or term: only event
 * names, counts and error class names.
 */
export interface Logger {
  warn(event: string, detail?: Record<string, string | number | boolean>): void;
}

// ---------------------------------------------------------------------------
// Subjects (storage shapes)
// ---------------------------------------------------------------------------

/** Kind of identifier a subject was seen with. */
export type SubjectIdKind = 'account' | 'key' | 'ip';

/** A stored subject. `mergedInto` is set once another subject absorbed it. */
export interface SubjectRecord {
  id: SubjectId;
  /** Epoch ms; the older subject survives a merge. */
  createdAt: number;
  mergedInto: SubjectId | null;
}

/**
 * One identifier seen on one subject. `value` is the account id as given, the
 * HASHED client key, or the hashed IP. A key or account belongs to one
 * subject; an IP may be recorded on several (it never links them).
 */
export interface SubjectIdRecord {
  subjectId: SubjectId;
  kind: SubjectIdKind;
  value: string;
  firstSeen: number;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Sanctions (storage shapes)
// ---------------------------------------------------------------------------

/**
 * What a sanction restricts: `chat` (public chat), `area` (public areas:
 * public rooms and matchmaking), `ban` (everything), or
 * `warning` (a recorded warning: it restricts nothing, never refuses at a door
 * and is never in the sanction index; it has no end, so `endsAt === startsAt`), or
 * `note` (the Note outcome: on the record and never punishing. Stored exactly like a warning, but it also
 * tells the player nothing: no notice, no reporter feedback, and it does not move the escalation step).
 */
export type SanctionKind = 'chat' | 'area' | 'ban' | 'warning' | 'note';

/** Who or what imposed a sanction. */
export type Source = 'moderator' | 'auto_filter' | 'coop' | 'api' | 'ai';

/** A sanction row targets a canonical subject, or one hashed IP (a short speed bump). */
export type SanctionTargetType = 'subject' | 'ip';

/**
 * One stored sanction row. A sanction is a GROUP of rows sharing `groupId` and
 * `refCode`: one `subject` row, plus at most one `ip` row. `value` is a subject
 * id or a hashed IP, so a row never leaves the server. `reason` is private.
 */
export interface SanctionRow {
  id: string;
  groupId: string;
  /** `M-` plus 5 characters; the one handle a player may quote to a moderator. */
  refCode: string;
  kind: SanctionKind;
  targetType: SanctionTargetType;
  /** Subject id (target `subject`) or hashed IP (target `ip`). */
  value: string;
  startsAt: number;
  /** Epoch ms the row stops applying (it applies strictly before this); null = permanent. */
  endsAt: number | null;
  reason: string;
  /**
   * The Community Rule the sanction cites, as TEXT: the number (`'1'`..) or `'uncovered'`. Null only on a row
   * written before rules existed. `parseRuleRef` in rules.ts is the one conversion point.
   */
  rule: string | null;
  /** Private moderator note on a rule gap (a moderator sanction under `'uncovered'`); subject row only. */
  gapNote: string | null;
  /** Where that gap stands: `open` until someone makes it a rule (`ruled`) or decides it is not one. */
  gapStatus: 'open' | 'ruled' | 'not_a_rule' | null;
  /**
   * The room (game) the sanction came from, when known: a moderator decision stores the decided report's room. Null
   * for an automatic timeout, a direct `sanctions.apply` that gave none, and every row written before migration 11.
   * Private. Lets the escalation ladder count notes from distinct games.
   */
  roomId: string | null;
  actor: string;
  source: Source;
  automated: boolean;
  /** True when written while sanctions enforcement was off. Informational. */
  pending: boolean;
  /**
   * Epoch ms the group was revoked. Set only by `loadSubjectActions` (revoked rows come back there, flagged); every
   * other load leaves the property off.
   */
  revokedAt?: number | null;
  /**
   * Who revoked the group and why. Set only by `listSubjectSanctions` (null while unrevoked, and on a row revoked
   * before the actor was kept); every other load leaves the properties off.
   */
  revokedBy?: string | null;
  revokeReason?: string | null;
}

/**
 * What {@link Store.listSubjectSanctions} takes: the SUBJECT rows of sanction groups, newest first. Never an IP row.
 */
export interface SanctionListQuery {
  /** Only rows whose stored target is one of these subject ids (a person's canonical id and its aliases). Absent: everyone; empty: nobody. */
  subjects?: readonly SubjectId[];
  /** Only rows from this source. */
  source?: Source;
  /** Only rows with `startsAt >= since`. */
  since?: number;
  /**
   * Only rows in force at this instant, of any age: not revoked, and with no end or an end strictly after it. Combines
   * (AND) with the other filters.
   */
  activeAt?: number;
  /**
   * With `since`: also the rows older than `since` that are permanent (`endsAt` null) and not revoked. Ignored without
   * `since`.
   */
  alsoPermanent?: boolean;
  /** Keyset cursor: only rows older than this (`startsAt` below it, or equal with an id below `beforeId`). `beforeId` without `before` is ignored. */
  before?: number;
  beforeId?: string;
  /** Clamped to 1..200 (a fraction is floored). */
  limit: number;
}

/** What {@link Store.reporterTally} counts over the reports a person filed. `badFaith` is the number marked bad faith. */
export interface ReporterTally {
  open: number;
  actioned: number;
  dismissed: number;
  badFaith: number;
}

/**
 * One decided report a person filed that carried a reason, with what its decision did: for the reporter's accuracy. `reason` is
 * the report's stored `reportedReason`; `target` the reported subject as stored; `actions` one entry per sanction group the
 * decision wrote (its subject row: who, and the rule cited, `'uncovered'` included). A dismissal with no actions has an empty list.
 */
export interface ReporterDecision {
  reportId: string;
  status: 'actioned' | 'dismissed';
  reason: string;
  target: SubjectId;
  actions: Array<{ subject: SubjectId; rule: RuleRef }>;
}

/**
 * How serious a piece of behaviour is, as the AI read (K3) or a moderator rates it. The shared vocabulary of every
 * report, in order from mildest to worst:
 * - `banter`: trash talk, salt, profanity not aimed at a person.
 * - `rude`: a personal insult or profanity aimed at a player, isolated.
 * - `hostile`: sustained or repeated aggression.
 * - `severe`: threats, hate or slurs, sexual harassment, doxxing, serious harassment.
 *
 * The escalation ladder reads it; `banter` reads the same column as `rude` and `hostile` (the profiles added later
 * decide what each level costs). Replaces the K2 `Severity` (none / low / medium / high, mapped one to one).
 */
export type ConductLevel = 'banter' | 'rude' | 'hostile' | 'severe';

/** Every {@link ConductLevel}, ordered from mildest to worst. */
export const CONDUCT_LEVELS: readonly ConductLevel[] = Object.freeze(['banter', 'rude', 'hostile', 'severe'] as const);

// ---------------------------------------------------------------------------
// Mutes (storage shape)
// ---------------------------------------------------------------------------

/**
 * One lasting mute: `viewer` does not want to see `target`. Both are subject ids
 * exactly as the caller gave them (possibly merged away since); matching goes
 * through the canonical subject at query time. `createdAt` is epoch ms and is
 * refreshed when the viewer mutes the same person again.
 */
export interface MuteRow {
  viewer: SubjectId;
  target: SubjectId;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Strikes (storage shape)
// ---------------------------------------------------------------------------

/**
 * One slur strike: the filter blocked a line `subject` typed. `subject` is the
 * canonical subject at write time (a later merge is resolved at query time).
 * `rawLine` is the line the subject typed themselves, kept for K2's
 * automatic-timeout notice; it is private and purged after 30 days. Never keyed
 * by IP.
 */
export interface StrikeRow {
  id: string;
  /** Epoch ms. */
  at: number;
  subject: SubjectId;
  roomId: string;
  termId: string;
  rawLine: string;
}

// ---------------------------------------------------------------------------
// Reports (storage shapes)
// ---------------------------------------------------------------------------

/**
 * A Discord forum thread kept for one person by `@chatwarden/discord`. `label` is the neutral name the thread was
 * created with (`Case 7K2QX`): random, never derived from an id, hash or handle.
 *
 * Staff-only (`subject` is a subject id), and NOT purged by `purge()`: rows live as long as the table does. Subjects are not
 * purged either today; whatever starts deleting subjects must delete their rows here too.
 */
export interface DiscordThreadRow {
  subject: string;
  threadId: string;
  label: string;
  /** Epoch ms. */
  createdAt: number;
}

/**
 * What a player could report another for in 0.1.1. A report's `category` is still one of these (derived from its reason, so
 * code that reads `category` keeps working), but the reason a player picks is now `reportedReason`, an id from the profile's
 * reporting reasons. `ReportInput.category` stays accepted as an alias of `reason`.
 */
export type ReportCategory = 'harassment' | 'hate' | 'cheating' | 'spam' | 'disruption' | 'other';

/**
 * One chat line inside a report's excerpt. It carries no identity of its own: `p` is the writer's index in the
 * report's `people` list, or null when the writer had no subject.
 */
export interface ReportExcerptLine {
  lineId: string;
  /** When the line was sent, epoch ms. */
  ts: number;
  seatId: string;
  handle: string;
  raw: string;
  delivered: string | null;
  blocked: boolean;
  /** Seat ids that could see the line; null means the whole room. */
  audience: string[] | null;
  p: number | null;
}

/**
 * One stored report. `reporterSubject` and `targetSubject` are the CANONICAL subject ids at submit time (a later
 * merge is resolved at query time). `people` lists the distinct canonical subjects who wrote a line in the
 * excerpt, in first-seen order. Private: only moderation tools read it, and it never reaches a player.
 * Carries subject ids: staff channels only, never send to a player.
 */
export interface StoredReport {
  id: string;
  /** Epoch ms. */
  createdAt: number;
  roomId: string;
  /** The room's tags when the report was filed. */
  tags: Record<string, string>;
  reporterSubject: SubjectId;
  reporterSeat: string;
  reporterHandle: string;
  targetSubject: SubjectId;
  targetSeat: string;
  targetHandle: string;
  /** The 0.1.1 category this report is kept under, derived from `reportedReason` (`'other'` when none). Prefer `reportedReason`. */
  category: ReportCategory;
  /**
   * The reason the reporter gave: an id from the profile's reporting reasons, or null when they gave none. A HINT, never the
   * truth: the case is settled by the moderator's decision. Optional on a row a store is given (missing reads as null); a
   * store returns it on every record.
   */
  reportedReason?: string | null;
  note: string | null;
  lineId: string | null;
  excerpt: ReportExcerptLine[];
  people: SubjectId[];
  status: 'open';
}

/**
 * A stored report as the moderator tools see it: the intake fields plus where a decision left it. `status` is
 * `open` until `closeReport` moves it to `actioned` or `dismissed`; the `actioned*` and `modNote` fields are null
 * until then. `badFaith` marks a dismissal as the reporter's bad faith (it counts toward their suspension).
 * Private: moderator tools only.
 */
export interface ReportRecord extends Omit<StoredReport, 'status' | 'reportedReason'> {
  /** The reason the reporter gave (a reason id), or null. Rows stored before 0.1.2 carry their old category here (`disruption` as `griefing`). */
  reportedReason: string | null;
  /**
   * When the reporter added their one follow-up (`cw.reports.addDetail`), epoch ms, or null. At most one per report, and only
   * while the report is open.
   */
  detailAt: number | null;
  status: 'open' | 'actioned' | 'dismissed';
  badFaith: boolean;
  actionedAt: number | null;
  actionedBy: string | null;
  modNote: string | null;
  /**
   * The moderator's written evidence for a `bad_faith` dismissal (trimmed, 1..500 characters); null on every other
   * report. Staff only: it is never part of a notice or any other player-facing value.
   */
  badFaithEvidence: string | null;
}

/** What {@link Store.listReports} takes. */
export interface ReportListQuery {
  status?: 'open' | 'actioned' | 'dismissed';
  /** Epoch ms; only reports created before this (exclusive), or at it with an id below `beforeId`. */
  before?: number;
  beforeId?: string;
  /** Only reports whose `reportedReason` is this id; null keeps only those with none. Omit for all. */
  reason?: string | null;
  limit: number;
}

/** What {@link Store.listOpenReports} takes: the take-next scan, oldest first. */
export interface OpenReportQuery {
  /** Only reports of this category. */
  category?: ReportCategory;
  /** Keyset cursor: only reports newer than this (`createdAt` above it, or equal with an id above `afterId`). `afterId` without `after` is ignored. */
  after?: number;
  afterId?: string;
  /** Clamped to 1..200 (a fraction is floored). */
  limit: number;
}

// ---------------------------------------------------------------------------
// Team workbench (storage shapes): soft claims and saved reasons
// ---------------------------------------------------------------------------

/** How long a claim lasts after the last claim or heartbeat: 10 minutes. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * A soft claim on a person's case: `by` (a staff actor) is handling it from `since` until `until` (epoch ms). It is live
 * strictly before `until`; an expired claim reads as absent. Staff only: `person` is a subject id.
 */
export interface ClaimRow {
  person: SubjectId;
  by: string;
  since: number;
  until: number;
}

/**
 * How {@link Store.claimCase} treats a claim that someone else holds:
 * - `claim`: wins when the case is free or the caller already holds it (a heartbeat).
 * - `free`: wins only when nobody holds a live claim, the caller included (take next uses it to skip what it holds).
 * - `takeover`: wins always (a senior moving a claim to themselves).
 */
export type ClaimMode = 'claim' | 'free' | 'takeover';

/**
 * What {@link Store.claimCase} answers. A win carries the claim now in force and `from`, the other actor whose LIVE claim
 * this one replaced (null for a fresh claim, a heartbeat or an expired claim). A loss carries the live claim that stands.
 */
export type ClaimAttempt = { won: true; claim: ClaimRow; from: string | null } | { won: false; claim: ClaimRow };

/** A saved decision reason: a short label for the picker and the text it fills in. */
export interface ReasonRow {
  id: string;
  label: string;
  text: string;
  active: boolean;
}

/**
 * One recorded moderator decision, kept so the same decision sent twice is a replay and not a second action.
 * `key` is a hash of the report and the decision; `resultJson` is what the first call answered.
 */
export interface DecisionRow {
  key: string;
  reportId: string;
  /** Epoch ms. */
  at: number;
  resultJson: string;
}

/** How long an incoming-webhook idempotency key is remembered: 24 hours. */
export const WEBHOOK_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** What {@link Store.reserveWebhookKey} answers: this call took the key, or the row that already holds it. */
export type WebhookKeyReservation =
  | { reserved: true }
  | { reserved: false; state: 'pending'; resultJson: null; fingerprint: string }
  | { reserved: false; state: 'done'; resultJson: string; fingerprint: string };

/** The light projection of a report the intake rules count: who reported whom, where and when. */
export interface ReportActivity {
  reporter: SubjectId;
  target: SubjectId;
  roomId: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Notices (storage shape)
// ---------------------------------------------------------------------------

/** What a player notice is about: a sanction of that kind, or the outcome of a report the player filed. */
export type NoticeKind = 'warning' | 'chat' | 'area' | 'ban' | 'report_outcome';

/**
 * One stored player notice. `subject` is the CANONICAL subject at write time (a later merge is resolved at query
 * time). `excerpt` is already the player-safe text (own lines only, blocked terms masked, day only): the raw line is
 * never stored here. `rule` is the cited rule as TEXT (`'1'`.. or `'uncovered'`), like a sanction row. Private: the
 * only shape that reaches a player is `PlayerNotice`.
 */
export interface NoticeRow {
  /** Random, never derived. */
  id: string;
  subject: SubjectId;
  /** The sanction group this notice is about; null for a report outcome. */
  groupId: string | null;
  kind: NoticeKind;
  rule: string | null;
  /** Epoch ms the sanction ends; null = permanent (or a warning, or a report outcome). */
  until: number | null;
  refCode: string | null;
  excerpt: Array<{ text: string; day: string }>;
  /** Epoch ms. */
  createdAt: number;
  ackedAt: number | null;
  withdrawnAt: number | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persistence for the kit. An adapter package (for example
 * `@chatwarden/store-sqlite`) implements it.
 *
 * Later tasks add the domain methods (subjects, sanctions, evidence, reports,
 * mutes ...) in this interface. They are async (`Promise`) so a non-SQLite
 * adapter can be remote; the chat hot path never awaits them, it reads
 * in-memory indexes instead. Add each new group of methods under the marker
 * below and keep the lifecycle methods above it.
 */
export interface Store {
  /** Latest applied kit schema version (0 when no migration has run). */
  schemaVersion(): number;

  /**
   * Run `fn` atomically: every write inside commits together, or none does
   * if `fn` throws (the error is rethrown). Calls nest: an inner failure
   * that the outer `fn` catches rolls back only the inner part. `fn` must be
   * synchronous; a returned promise is not awaited.
   */
  transaction<T>(fn: () => T): T;

  /** Release resources the store owns. A database handed in by the host stays open. */
  close(): void;

  // --- Domain methods (async) are added below by later tasks. ---

  // Subjects

  /** Insert a subject; a subject that already exists is left unchanged. */
  saveSubject(subject: SubjectRecord): Promise<void>;

  /**
   * Upsert one identifier row (keyed by subject, kind and value): `firstSeen`
   * is kept from the first write, `lastSeen` only moves forward. The subject
   * must already exist.
   */
  saveIdentifier(record: SubjectIdRecord): Promise<void>;

  /** Mark `id` as absorbed into `into`. */
  markMerged(id: SubjectId, into: SubjectId): Promise<void>;

  /** Every subject and identifier row, for rebuilding the in-memory index. */
  loadSubjects(): Promise<{ subjects: SubjectRecord[]; ids: SubjectIdRecord[] }>;

  // Sanctions. SYNCHRONOUS on purpose (like the term store): `applySanction` must
  // write, see the outcome and update the in-memory index in one tick, so the chat
  // path sees an automatic timeout at once. They run SQL inside `transaction`.

  /**
   * Insert every row of one sanction group atomically. Returns false, having
   * written nothing, when the group's `refCode` is already taken by another
   * group; any other failure throws and also leaves nothing written.
   */
  insertSanctionGroup(rows: readonly SanctionRow[]): boolean;

  /**
   * Revoke every unrevoked row of the group; rows already revoked keep their
   * first revoker, time and reason. Returns how many rows this call revoked.
   */
  revokeSanctionGroup(groupId: string, actor: string, at: number, reason: string): number;

  /**
   * The player-quotable ref code of a sanction group, or null for an unknown group. Revoked and ended groups are
   * still found: the code never changes. For the `sanction.revoked` event.
   */
  sanctionRefCode(groupId: string): string | null;

  /**
   * The person a sanction group is about and the rule it cites, for the `sanction.revoked` event: the group's SUBJECT row
   * (its IP row is not a person) and its stored rule text (`'1'`.., `'uncovered'`, or null on a row written before rules
   * existed). Revoked and ended groups are still found. Null for an unknown group. `subject` is the id as stored; the
   * facade makes it canonical.
   */
  sanctionGroupTarget(groupId: string): { subject: SubjectId; rule: string | null } | null;

  /** Every unrevoked row that has not ended by `now`, for rebuilding the sanction index. */
  loadSanctions(now: number): SanctionRow[];

  /**
   * Every SUBJECT row (never an IP row) with `startsAt >= since`, revoked and ended ones included, oldest write first.
   * Each row carries `revokedAt` (null when unrevoked). The history behind the escalation ladder.
   */
  loadSubjectActions(since: number): SanctionRow[];

  /**
   * The SUBJECT rows of sanction groups (never an IP row), newest first (`startsAt` descending, then `id` descending, so a
   * tie is stable), revoked and ended ones included. Every row carries `revokedAt`, `revokedBy` and `revokeReason` (all
   * null while unrevoked). See {@link SanctionListQuery}.
   */
  listSubjectSanctions(q: SanctionListQuery): SanctionRow[];

  /** Every subject row that carries a rule-gap note (any status, revoked or not), newest `startsAt` first. */
  listGaps(): SanctionRow[];

  /**
   * Close an open rule gap: set its status (`ruled` with the new rule number as `ref`, or `not_a_rule` with a null
   * `ref`). Returns true when this call closed it; false for an unknown group, a group with no note, or a gap that
   * is already closed.
   */
  closeGap(groupId: string, status: 'ruled' | 'not_a_rule', ref: string | null, actor: string, at: number): boolean;

  // Mutes. SYNCHRONOUS on purpose (like sanctions): `MuteService.set` writes inside
  // `transaction`, then updates its in-memory index in the same tick.

  /** Insert the (viewer, target) mute, or set its `createdAt` when it already exists. */
  upsertMute(row: MuteRow): void;

  /** Delete the (viewer, target) mute exactly as stored. Returns whether a row was removed. */
  deleteMute(viewer: SubjectId, target: SubjectId): boolean;

  /** Every mute created at or after `since` (epoch ms): the live ones, for rebuilding the index. */
  loadMutes(since: number): MuteRow[];

  /**
   * Keep only the `keep` newest mutes of this stored viewer id (by `createdAt`; on a
   * tie the one written last survives) and delete the rest. Returns the target ids of
   * the deleted rows, oldest first.
   */
  pruneMutes(viewer: SubjectId, keep: number): SubjectId[];

  // Strikes. SYNCHRONOUS on purpose (like sanctions): `StrikeService.record` writes inside `transaction`,
  // then updates its in-memory tally in the same tick.

  /** Append one strike row. */
  insertStrike(row: StrikeRow): void;

  /** Every strike at or after `since` (epoch ms), oldest first, for rebuilding the tally. */
  loadStrikes(since: number): StrikeRow[];

  /**
   * For each subject id a `chat` sanction from source `auto_filter` was written against: the latest
   * `startsAt` of those rows, revoked or expired ones included. Subject rows only (never IP rows).
   */
  loadAutoChatStarts(): Array<{ subject: SubjectId; startsAt: number }>;

  /**
   * Strikes at or after `since` (epoch ms), newest first (`at` descending, then `id` descending), at most `limit`
   * (clamped to 1..500). The staff "blocked messages" view.
   */
  listStrikes(since: number, limit: number): StrikeRow[];

  /** For each term id, how many strikes at or after `since` it earned (terms with none are absent). Order is unspecified. */
  countStrikesByTerm(since: number): Array<{ termId: string; count: number }>;

  // Reports. SYNCHRONOUS on purpose (like sanctions): `ReportService.submit` runs these inside `transaction`.
  // Subject ids come back exactly as stored (canonical at write time, possibly merged since); the service folds
  // aliases. The table also carries `status`, `bad_faith` and `actioned_at` for K2's moderator tools.

  /**
   * Insert one report. Returns false, having written nothing, when a report by the same reporter subject
   * against the same target subject in the same room already exists (the UNIQUE backstop); any other
   * failure throws.
   */
  insertReport(row: StoredReport): boolean;

  /** One report with its decision columns, or null when there is none by that id. */
  loadReport(id: string): ReportRecord | null;

  /**
   * Reports newest first (`created_at` descending, then `id` descending, so a tie is stable), whole records. `status`
   * filters; `reason` filters on `reportedReason` (an id, or null for none; a store must apply it, so paging stays right); `before` keeps only reports older than that instant (exclusive), and with `beforeId` also the ones filed
   * AT that instant whose id sorts below it (keyset paging: pass the last row's `createdAt` and `id`). `beforeId`
   * without `before` is ignored. `limit` is clamped to 1..200 (a fraction is floored).
   */
  listReports(q: ReportListQuery): ReportRecord[];

  /**
   * Reports filed AGAINST any of the given subjects (`targetSubject` as stored: pass the person's canonical id and every
   * alias merged into it), newest first (`created_at` descending, then `id` descending), whole records. `limit` is
   * clamped to 1..200 (a fraction is floored). An empty list matches nothing.
   */
  listReportsByPerson(subjects: readonly SubjectId[], limit: number): ReportRecord[];

  /**
   * Reports that are still `open`, OLDEST first (`createdAt` ascending, then `id` ascending, so a tie is stable), whole
   * records. `category` filters; `after` keeps only reports newer than that instant (exclusive), and with `afterId` also
   * the ones filed AT that instant whose id sorts above it (keyset paging: pass the last row's `createdAt` and `id`).
   * `limit` is clamped to 1..200 (a fraction is floored). The scan behind "take next".
   */
  listOpenReports(q: OpenReportQuery): ReportRecord[];

  /**
   * The OPEN reports filed AGAINST any of the given subjects (`targetSubject` as stored: pass the person's canonical id
   * and every alias merged into it), newest first (`createdAt` descending, then `id` descending), whole records. `limit` is
   * clamped to 1..200 (a fraction is floored). An empty list matches nothing.
   */
  listOpenReportsByPerson(subjects: readonly SubjectId[], limit: number): ReportRecord[];

  /**
   * How the reports FILED BY any of the given subjects stand (`reporterSubject` as stored: pass the person's canonical id
   * and every alias merged into it): how many are still open, actioned or dismissed, and how many carry the bad-faith
   * mark. An empty list counts nothing.
   */
  reporterTally(reporters: readonly SubjectId[]): ReporterTally;

  /**
   * OPTIONAL. The DECIDED reports (`actioned` or `dismissed`) filed by any of the given subjects (`reporterSubject` as stored)
   * that carry a `reportedReason`, each with the sanction groups its decision wrote (the group's subject row: the person and
   * the rule it cited). The reporter-accuracy read behind `reasonMatched` / `reasonDecided`. A store that leaves it out
   * reports 0 and 0. An empty list matches nothing; open reports and reports with no reason are never returned.
   */
  loadReporterDecisions?(reporters: readonly SubjectId[]): ReporterDecision[];

  /**
   * OPTIONAL. Attach the reporter's one follow-up to an `open` report that has none yet: set `reportedReason` and `note` (the
   * FINAL values; the caller has merged them with what the report had) and `detailAt`, atomically. Returns true when this call
   * did it, false (nothing changed) for an unknown report, one that is no longer `open`, or one that already has a follow-up.
   * Never touches the target, the excerpt or the line. A store that leaves it out cannot take a follow-up: `addDetail` answers
   * `off`. `category` is the 0.1.1 category to keep beside the reason.
   */
  addReportDetail?(id: string, detail: { reportedReason: string | null; category: ReportCategory; note: string | null; at: number }): boolean;

  /**
   * Close a report that is still `open`: set its status, bad-faith mark, `actionedAt`, `actionedBy` and `modNote`,
   * and the bad-faith `evidence` (null or omitted when there is none). Returns true when this call closed it; false
   * (nothing changed, the first closer's evidence kept) for an unknown report or one already closed.
   */
  closeReport(
    id: string,
    status: 'actioned' | 'dismissed',
    badFaith: boolean,
    actor: string,
    at: number,
    note: string,
    evidence?: string | null,
  ): boolean;

  /** Record a decision. A `key` that is already recorded throws (nothing is written). */
  insertDecision(key: string, reportId: string, at: number, resultJson: string): void;

  /** The recorded decision for `key`, or null. */
  findDecision(key: string): DecisionRow | null;

  /** Who reported whom (light rows, no excerpt) for every report created at or after `since`, oldest first. */
  loadReportActivity(since: number): ReportActivity[];

  /** Who reported whom in one room, all time. */
  loadRoomReportPairs(roomId: string): Array<{ reporter: SubjectId; target: SubjectId }>;

  /** The reporter and `actioned_at` of every report marked bad-faith and actioned at or after `since`. */
  loadBadFaithMarks(since: number): Array<{ reporter: SubjectId; actionedAt: number }>;

  /**
   * One row per `chat` sanction GROUP from source `auto_filter` that starts at or after `since`, naming the
   * subject row's stored target (revoked and expired groups included). Never IP rows.
   */
  loadAutoChatGroups(since: number): Array<{ subject: SubjectId; groupId: string }>;

  // Team workbench (K4 Task 4b). SYNCHRONOUS on purpose (like sanctions): they run inside `transaction`.

  /**
   * The change token: an opaque string that is different after every change a moderator's queue shows, and the same
   * otherwise. It persists with the store (a restart does not rewind it) and is shared by every process on the same
   * database. An adapter must move it INSIDE the same transaction as the write, so an undone write leaves it as it was,
   * on exactly these events: `insertReport` (true), `closeReport` (true), `insertSanctionGroup` (true),
   * `revokeSanctionGroup` (more than 0), `closeGap` (true), `claimCase` (a win that changes the owner of the case, so a
   * heartbeat does not), `releaseClaim` (true), `insertReason`, and `updateReason` / `setReasonActive` when a value changes.
   * Nothing else moves it, and reading it never does.
   */
  changeToken(): string;

  /**
   * Claim a person's case for `by` at `now`, the claim ending at `until`, as ONE atomic conditional write: of two callers
   * racing for the same free case, exactly one wins, even from two processes on one database. See {@link ClaimMode} and
   * {@link ClaimAttempt}. A claim is live strictly before its `until`; an expired one is replaced as if absent. `since` is
   * kept across a heartbeat and set to `now` otherwise. The token moves when the owner of the case changes.
   */
  claimCase(person: SubjectId, by: string, now: number, until: number, mode: ClaimMode): ClaimAttempt;

  /**
   * Release `by`'s claim on the person. True only when it removed a LIVE claim held by `by`; someone else's claim, no claim
   * and an expired claim (already absent) answer false and the first two are left alone.
   */
  releaseClaim(person: SubjectId, by: string, now: number): boolean;

  /** The claims in force at `now` (not expired) among these people, ordered by person. An empty list matches nobody. */
  loadClaims(persons: readonly SubjectId[], now: number): ClaimRow[];

  /** Every saved reason (active or not), in the order they were added. */
  listReasons(): ReasonRow[];

  /** Add a reason. A duplicate `id` throws and writes nothing. */
  insertReason(row: ReasonRow): void;

  /** Change a reason's label and/or text. False for an unknown id; true otherwise (also when nothing differs). */
  updateReason(id: string, patch: { label?: string; text?: string }): boolean;

  /** Switch a reason on or off. False for an unknown id; true otherwise (also when it already was so). */
  setReasonActive(id: string, active: boolean): boolean;

  // The editable moderation profile (K4 Task 7f). OPTIONAL: a store without both methods still works, and `cw.policy.save`
  // then answers `unsupported` while the profile stays code-only. SYNCHRONOUS on purpose (like sanctions).

  /**
   * The stored policy layer and its version, or null when none was ever saved (version 0). `layer` is whatever was saved,
   * unvalidated: the kit checks it against the profile and ignores one it cannot use. A row that cannot be read at all (its text is
   * not JSON) still answers its version, with a `layer` of null, which the kit reports as unusable. Returns a copy.
   */
  loadPolicyLayer?(): { layer: PolicyLayer; version: number } | null;

  /**
   * Replace the stored layer with `layer` IF the stored version is still `expectedVersion` (0 when none is stored), as ONE
   * atomic conditional write: of two callers (two processes on one database included) that pass the same version, exactly
   * one wins. Returns the new version (`expectedVersion + 1`), or null on a version conflict, which writes nothing. Runs
   * inside `transaction`, so an undone transaction undoes it. It does not move the change token.
   */
  savePolicyLayer?(layer: PolicyLayer, expectedVersion: number): number | null;

  // Staff audit trail. SYNCHRONOUS on purpose (like sanctions). The trail also holds the rows `closeGap` and the term
  // editor write; none of these methods ever returns the json columns those carry (they may hold term text).

  /**
   * Insert one audit entry. A duplicate id throws (nothing is written). Both json columns are written NULL. A policy row
   * (`policy.update`, `policy.reset`) also carries `detail` (the sections changed and the owner's reason): a store MUST keep it
   * and return it from `listAudit`, or the trail silently loses what changed and why. A row without one has no `detail` key.
   */
  insertAudit(row: AuditRow): void;

  /**
   * Audit entries newest first (`at` descending, then `id` descending, so a tie is stable). `actor` and `action`
   * filter by equality. `before` keeps only entries older than that instant (exclusive), and with `beforeId` also the
   * ones AT that instant whose id sorts below it (keyset paging: pass the last row's `at` and `id`). `beforeId`
   * without `before` is ignored. `limit` is clamped to 1..200 (a fraction is floored).
   *
   * Rows written before roles existed read with `role: null`. A legacy term-editor row is mapped into the
   * {@link AuditRow} action union (`add` -> `term.add` or `exception.add`, `edit` -> `*.update`, `enable` / `disable` ->
   * `*.toggle`); any other action it does not recognise reads as `term.update`, and a target type outside the union
   * reads as no target. The `action` filter matches the mapped name.
   */
  listAudit(q: AuditListQuery): AuditRow[];

  /** Delete audit entries with `at < before`. Returns how many. */
  purgeAudit(before: number): number;

  // Retention. SYNCHRONOUS on purpose: `purge` runs all six inside one `transaction`. Each deletes rows
  // strictly older than the cutoff (epoch ms) and returns how many it deleted.

  /**
   * Delete reports with `createdAt < before`, except a bad-faith dismissal still inside its window
   * (`bad_faith = 1` and `actionedAt >= keepBadFaithSince`): the reporter's suspension reads it. Also deletes the
   * recorded decisions of reports that no longer exist. Returns how many reports it deleted.
   */
  purgeReports(before: number, keepBadFaithSince: number): number;

  /**
   * Delete sanction rows that ended (`endsAt` set and `< before`) or were revoked (`revokedAt < before`).
   * A permanent, unrevoked row is never deleted, and neither is a row whose rule gap is still `open`: the gap
   * is the moderators' to-do and needs its note.
   */
  purgeSanctions(before: number): number;

  /** Delete strikes with `at < before`. */
  purgeStrikes(before: number): number;

  /** Delete mutes with `createdAt < before`. */
  purgeMutes(before: number): number;

  /**
   * Delete a notice when it was withdrawn and has `createdAt < before`; or was seen, is a `warning` or
   * `report_outcome`, and has `createdAt < before`; or its end is past (`until` set and `< before`). A notice for a
   * permanent or still-running sanction is never deleted while it applies, and an unseen warning is kept until it
   * is seen or withdrawn.
   */
  purgeNotices(before: number): number;

  // Webhook idempotency keys (K3b). SYNCHRONOUS on purpose (like sanctions): they run inside `transaction`.

  /**
   * Reserve an idempotency key for an incoming webhook. A row with `createdAt < notBefore` is expired and is replaced.
   * Otherwise: no row yet inserts a `pending` one holding `fingerprint` (a hash of the request, so a key reused for a
   * different request can be told apart) and answers `{ reserved: true }`; an existing row is returned as it is, with
   * the fingerprint it was stored with (`pending` carries no result, `done` carries the stored response body). Never
   * carries chat text.
   */
  reserveWebhookKey(key: string, now: number, notBefore: number, fingerprint: string): WebhookKeyReservation;

  /** Mark a `pending` key `done` with the response body it answered. True only when this call did it. */
  completeWebhookKey(key: string, resultJson: string): boolean;

  /** Delete a key that is still `pending` (the apply failed, so a retry may proceed). A `done` key is never deleted. True when it did. */
  releaseWebhookKey(key: string): boolean;

  /** Delete idempotency keys with `createdAt < before`, done or pending. Returns how many. */
  purgeWebhookKeys(before: number): number;

  // Discord thread map (K3b). SYNCHRONOUS on purpose (like sanctions): they run inside `transaction`.

  /**
   * The forum thread the Discord feed keeps for a person, or null. `subject` is a canonical subject id, or the
   * feed's reserved shared-thread key (`__unattributed__`). Holds no chat text.
   */
  getDiscordThread(subject: string): DiscordThreadRow | null;

  /** Store (or replace, to repoint) a person's forum thread. One row per `subject`; two subjects may share a thread. */
  putDiscordThread(row: DiscordThreadRow): void;

  // Notices. SYNCHRONOUS on purpose (like sanctions): `NoticeService` runs these inside `transaction`.

  /** Insert one notice. A duplicate id throws. */
  insertNotice(row: NoticeRow): void;

  /**
   * Every notice (seen, unseen and withdrawn) stored under any of these subject ids, oldest first (`createdAt`, then
   * write order). The caller passes a person's stored ids (a canonical subject and the ones merged into it).
   */
  loadNotices(subjects: readonly SubjectId[]): NoticeRow[];

  /** Mark a notice seen at `at`. Returns true only when this call did it: not when already seen, withdrawn or unknown. */
  ackNotice(id: string, at: number): boolean;

  /** Withdraw every not-yet-withdrawn notice of the group at `at`. Returns how many this call withdrew. */
  withdrawNoticeGroup(groupId: string, at: number): number;

  /**
   * The newest notice of a sanction group that is not withdrawn (newest by `createdAt`, then write order), or null
   * when the group has none. Seen or not. `subject` is the stored (possibly since merged) subject the notice is for,
   * so a caller can check it is the asking person's own. Private: never shown to a player.
   */
  findNoticeForGroup(
    groupId: string,
  ): { id: string; subject: SubjectId; ackedAt: number | null; withdrawnAt: number | null } | null;
}

// ---------------------------------------------------------------------------
// Matcher (structural; the real one lives in @chatwarden/matcher)
// ---------------------------------------------------------------------------

/**
 * What core needs from a profanity filter: given chat text, whether it holds ordinary swearing, and the text with
 * that swearing masked. Declared here so core carries no word data and never imports `@chatwarden/profanity`,
 * whose `createProfanityFilter` returns one. `text` equals the input when there is no hit. It is never a slur
 * check (the {@link Matcher} does that) and a hit is never a rule violation.
 */
export interface ProfanityFilter {
  apply(text: string): { hit: boolean; text: string };
}

/**
 * What core needs from a term matcher: given chat text, the id of the term it hit, or null.
 * Declared here so core never imports `@chatwarden/matcher`; the matcher package's own
 * `Matcher` and `LiveTerms` satisfy it structurally. The term id is for strike records only
 * and never goes to a player.
 */
export interface Matcher {
  match(text: string): { termId: string } | null;
  /**
   * Every match as a range on the ORIGINAL text (`end` exclusive), for masking a blocked line in a player
   * notice. Optional: a matcher without it simply cannot mask, and the caller must then withhold the line.
   * Empty exactly when `match` is null.
   */
  spans?(text: string): Array<{ start: number; end: number; termId: string }>;
  /**
   * The same check for a NAME (a handle, a table or deck name) rather than a chat line: the matcher also reads the
   * name split into words (underscores, camel-case humps, digit runs), so `Zorbak_99` is caught. Optional: without
   * it `names.check` falls back to `match`.
   */
  matchName?(name: string): { termId: string } | null;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/**
 * What the adopter game or chat server supplies. `identify` reads whatever a connection looks like in the
 * adopter stack (a request, a socket, a session) and returns who is behind it, RAW (see {@link RawWho}).
 * `notify` is optional: it is how the kit tells your client that a player has notices waiting.
 */
export interface Platform {
  identify(ctx: unknown): RawWho;
  /**
   * Told after a notice is written, with the person's SUBJECT ID and how many notices are pending. The subject id is
   * an identifier: use it only to find that player's live connection on your server, then send the client the
   * notices (`notices.pending`), never the id. Map back from the subject on the server only. Fenced: a throw or a
   * rejection is logged (`notices.notify_failed`) and never reaches the caller. Called with the platform as `this`.
   */
  notify?(who: SubjectId, event: { type: 'notice_pending'; count: number }): void | PromiseLike<unknown>;
}
