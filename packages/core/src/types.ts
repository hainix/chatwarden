// Core types for @chatwarden/core. Organized by section; later tasks append
// their own sections below.

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
 * and is never in the sanction index; it has no end, so `endsAt === startsAt`).
 */
export type SanctionKind = 'chat' | 'area' | 'ban' | 'warning';

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
 * How serious a piece of behaviour is, as the AI read (K3) or a moderator rates it. The escalation ladder reads it:
 * `'none'` is treated exactly like `'low'`.
 */
export type Severity = 'high' | 'medium' | 'low' | 'none';

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

/** The light projection of a report the intake rules count: who reported whom, where and when. */
export interface ReportActivity {
  reporter: SubjectId;
  target: SubjectId;
  roomId: string;
  createdAt: number;
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

  // Retention. SYNCHRONOUS on purpose: `purge` runs all four inside one `transaction`. Each deletes rows
  // strictly older than the cutoff (epoch ms) and returns how many it deleted.

  /** Delete reports with `createdAt < before`. */
  purgeReports(before: number): number;

  /**
   * Delete sanction rows that ended (`endsAt` set and `< before`) or were revoked (`revokedAt < before`).
   * A permanent, unrevoked row is never deleted.
   */
  purgeSanctions(before: number): number;

  /** Delete strikes with `at < before`. */
  purgeStrikes(before: number): number;

  /** Delete mutes with `createdAt < before`. */
  purgeMutes(before: number): number;
}

// ---------------------------------------------------------------------------
// Matcher (structural; the real one lives in @chatwarden/matcher)
// ---------------------------------------------------------------------------

/**
 * What core needs from a term matcher: given chat text, the id of the term it hit, or null.
 * Declared here so core never imports `@chatwarden/matcher`; the matcher package's own
 * `Matcher` and `LiveTerms` satisfy it structurally. The term id is for strike records only
 * and never goes to a player.
 */
export interface Matcher {
  match(text: string): { termId: string } | null;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/**
 * What the adopter game or chat server supplies. `identify` reads whatever a connection looks like in the
 * adopter stack (a request, a socket, a session) and returns who is behind it, RAW (see {@link RawWho}).
 * K2 adds an optional `notify` here for delivering notices.
 */
export interface Platform {
  identify(ctx: unknown): RawWho;
}
