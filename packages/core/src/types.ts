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
}
