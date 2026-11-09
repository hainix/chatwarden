// Core types for @chatwarden/core. Organized by section; later tasks append
// their own sections below.

import type { AuditListQuery, AuditRow } from './audit.js';

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

/** What a player may report another for. */
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
  category: ReportCategory;
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
export interface ReportRecord extends Omit<StoredReport, 'status'> {
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
  limit: number;
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

  /** Every unrevoked row that has not ended by `now`, for rebuilding the sanction index. */
  loadSanctions(now: number): SanctionRow[];

  /**
   * Every SUBJECT row (never an IP row) with `startsAt >= since`, revoked and ended ones included, oldest write first.
   * Each row carries `revokedAt` (null when unrevoked). The history behind the escalation ladder.
   */
  loadSubjectActions(since: number): SanctionRow[];

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
   * filters; `before` keeps only reports older than that instant (exclusive), and with `beforeId` also the ones filed
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

  // Staff audit trail. SYNCHRONOUS on purpose (like sanctions). The trail also holds the rows `closeGap` and the term
  // editor write; none of these methods ever returns the json columns those carry (they may hold term text).

  /** Insert one audit entry. A duplicate id throws (nothing is written). Both json columns are written NULL. */
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
