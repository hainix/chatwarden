import { randomBytes, randomInt } from 'node:crypto';
import type { Identifiers, SanctionKind, SanctionRow, Source, Store, SubjectId } from './types.js';
import type { SubjectIndex } from './subjects.js';

// A sanction is written as one GROUP of rows tied by `groupId` and `refCode`: one row for the canonical
// subject (which covers every key and account the person is linked to, now and after any later merge), and
// optionally one row for the subject's latest IP. A moderator revokes "the sanction" once and every row is
// freed. The chat path never queries the store: it asks `SanctionIndex`, an in-memory copy that
// `applySanction` and `revokeSanction` keep current in the same tick as the write.

export type { SanctionKind, Source } from './types.js';

/** Every kind a sanction can have. The `kit_sanctions` CHECK constraint lists the same values. */
export const SANCTION_KINDS: readonly SanctionKind[] = ['chat', 'area', 'ban'];

/** Every source a sanction can come from. */
export const SANCTION_SOURCES: readonly Source[] = ['moderator', 'auto_filter', 'coop', 'api', 'ai'];

/** An IP row never outlives 24 h: addresses are shared (NAT, cafes) and rotate. */
const IP_MAX_MS = 24 * 3_600_000;

/** A ref-code collision is retried this many times in all before giving up. */
const REF_ATTEMPTS = 5;

/** No I, L, O, 0 or 1: a player reads the code aloud or types it from a screenshot. */
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface SanctionInput {
  kind: SanctionKind;
  /** The person to sanction; stored as its canonical (surviving) subject. */
  subject: SubjectId;
  /** Also write one IP row: the subject's most recently seen IP, capped at 24 h. */
  includeIp: boolean;
  /** Milliseconds from now; null is permanent. Must be finite and above 0. */
  durationMs: number | null;
  /** Private moderator note. Never returned to a player. */
  reason: string;
  actor: string;
  source: Source;
  automated: boolean;
  /** Rule number the sanction cites (the rules layer fills it). */
  rule?: string;
}

/** What `active` tells the chat path. No reason, rule, actor or identifier. */
export interface ActiveSanction {
  /** Epoch ms the restriction ends, or null for permanent. */
  until: number | null;
  automated: boolean;
  groupId: string;
  refCode: string;
}

const newId = (): string => randomBytes(16).toString('base64url');

/** `M-` plus 5 characters from an unambiguous alphabet. Uniqueness is enforced at write time, not here. */
export function refCode(): string {
  let out = 'M-';
  for (let i = 0; i < 5; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return out;
}

function validate(input: SanctionInput): void {
  const d = input.durationMs;
  if (d !== null && (!Number.isFinite(d) || d <= 0)) {
    // NaN would otherwise store NULL (a silent permanent ban); zero or less is an already-expired row.
    throw new Error(`applySanction: invalid duration ${d}`);
  }
  if (!SANCTION_KINDS.includes(input.kind)) throw new Error('applySanction: invalid kind');
  if (!SANCTION_SOURCES.includes(input.source)) throw new Error('applySanction: invalid source');
  if (typeof input.subject !== 'string' || input.subject === '') throw new Error('applySanction: missing subject');
}

function applyNow(
  store: Store,
  subjects: SubjectIndex,
  input: SanctionInput,
  now: number,
  index: SanctionIndex | undefined,
): { groupId: string; refCode: string } {
  validate(input);
  const subject = subjects.canonical(input.subject);
  const endsAt = input.durationMs === null ? null : now + input.durationMs;
  const ipEndsAt = endsAt === null ? now + IP_MAX_MS : Math.min(endsAt, now + IP_MAX_MS);
  const ip = input.includeIp ? subjects.latestIp(subject) : null;
  const groupId = newId();
  // Informational: `active()` already returns null while disabled and the row applies once it is re-enabled.
  const pending = index !== undefined && !index.isEnabled();

  const build = (code: string): SanctionRow[] => {
    const base = {
      groupId,
      refCode: code,
      kind: input.kind,
      startsAt: now,
      reason: input.reason,
      rule: input.rule ?? null,
      actor: input.actor,
      source: input.source,
      automated: input.automated,
      pending,
    };
    const rows: SanctionRow[] = [{ ...base, id: newId(), targetType: 'subject', value: subject, endsAt }];
    if (ip !== null) rows.push({ ...base, id: newId(), targetType: 'ip', value: ip, endsAt: ipEndsAt });
    return rows;
  };

  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
    const rows = build(refCode());
    const written = store.transaction(() => store.insertSanctionGroup(rows));
    if (written) {
      index?.add(rows, now);
      return { groupId, refCode: rows[0]?.refCode ?? '' };
    }
  }
  throw new Error('applySanction: could not allocate a unique ref code');
}

/**
 * Write one sanction group and, when `index` is given, add it to the index.
 *
 * The write and the index update both happen SYNCHRONOUSLY, before this
 * returns its promise, so the chat path can apply an automatic timeout and see
 * it on the very next message. A failure rejects and leaves the index
 * untouched (the group is all-or-nothing in the store). Throws on a
 * non-finite or non-positive duration. `pending` is recorded when the index's
 * `enabled()` is false.
 */
export function applySanction(
  store: Store,
  subjects: SubjectIndex,
  input: SanctionInput,
  now: number,
  index?: SanctionIndex,
): Promise<{ groupId: string; refCode: string }> {
  try {
    return Promise.resolve(applyNow(store, subjects, input, now, index));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Revoke every row of the group; the first revoke wins (a second keeps the first
 * revoker, time and reason). Synchronous like `applySanction`: the store and,
 * when given, the index are updated before the promise is returned. Resolves
 * true when this call revoked something, false for an unknown or already
 * revoked group.
 */
export function revokeSanction(
  store: Store,
  groupId: string,
  actor: string,
  now: number,
  reason: string,
  index?: SanctionIndex,
): Promise<boolean> {
  try {
    const n = store.transaction(() => store.revokeSanctionGroup(groupId, actor, now, reason));
    index?.remove(groupId);
    return Promise.resolve(n > 0);
  } catch (err) {
    return Promise.reject(err);
  }
}

interface IndexRow {
  startsAt: number;
  endsAt: number | null;
  automated: boolean;
  groupId: string;
  refCode: string;
}

/** Sweep expired rows out of the index after this many `add` calls. */
const SWEEP_EVERY = 64;

/**
 * In-memory view of the live sanctions, so the chat path never touches the
 * store. A row matches a person by CANONICAL subject (so a sanction follows a
 * merge in either direction) and, for IP rows only, by `ipHash`. Expiry is
 * judged at query time: a row whose end is at or before `now` is inactive.
 */
export class SanctionIndex {
  private readonly enabled: () => boolean;
  private readonly subjects: SubjectIndex;
  /** kind -> stored subject id -> rows. The stored id may have been merged away since; `active` canonicalises. */
  private bySubject = new Map<SanctionKind, Map<SubjectId, IndexRow[]>>();
  /** kind -> hashed IP -> rows. */
  private byIp = new Map<SanctionKind, Map<string, IndexRow[]>>();
  private adds = 0;

  constructor(opts: { enabled: () => boolean; subjects: SubjectIndex }) {
    this.enabled = opts.enabled;
    this.subjects = opts.subjects;
  }

  /** Whether sanctions are enforced right now (read per call, so a kill switch works live). */
  isEnabled(): boolean {
    return this.enabled();
  }

  /** Replace the set with every unrevoked row that has not yet ended. For boot and resync. */
  load(store: Store, now: number): Promise<void> {
    try {
      const found = store.loadSanctions(now);
      this.bySubject = new Map();
      this.byIp = new Map();
      this.adds = 0;
      for (const row of found) this.insert(row);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Add freshly written rows. `applySanction` calls this; so can a host that writes rows itself. */
  add(rows: readonly SanctionRow[], now: number): void {
    for (const row of rows) this.insert(row);
    if (++this.adds % SWEEP_EVERY === 0) this.sweep(now);
  }

  /** Drop every row of a group (it was revoked). */
  remove(groupId: string): void {
    this.prune((r) => r.groupId !== groupId);
  }

  /**
   * The strongest active sanction of `kind` for this person: rows that name
   * their canonical subject, plus IP rows for `ids.ipHash`. Permanent beats
   * timed, otherwise the later end wins. Null when none apply or when
   * `enabled()` is false. The result carries no reason, rule, actor or
   * identifier.
   */
  active(kind: SanctionKind, ids: Identifiers, subject: SubjectId | null, now: number): ActiveSanction | null {
    if (!this.enabled()) return null;
    let best: IndexRow | null = null;
    const consider = (list: readonly IndexRow[] | undefined): void => {
      for (const r of list ?? []) {
        if (r.startsAt > now || (r.endsAt !== null && r.endsAt <= now)) continue;
        if (best === null || outlasts(r, best)) best = r;
      }
    };

    const subjectRows = this.bySubject.get(kind);
    if (subject !== null && subjectRows !== undefined) {
      const root = this.subjects.canonical(subject);
      for (const [stored, list] of subjectRows) {
        if (this.subjects.canonical(stored) === root) consider(list);
      }
    }
    const ip = ids.ipHash;
    if (ip !== null && ip !== '') consider(this.byIp.get(kind)?.get(ip));

    const found = best as IndexRow | null;
    return found === null
      ? null
      : { until: found.endsAt, automated: found.automated, groupId: found.groupId, refCode: found.refCode };
  }

  private insert(row: SanctionRow): void {
    const table = row.targetType === 'subject' ? this.bySubject : this.byIp;
    let byValue = table.get(row.kind);
    if (byValue === undefined) table.set(row.kind, (byValue = new Map()));
    let list = byValue.get(row.value);
    if (list === undefined) byValue.set(row.value, (list = []));
    list.push({
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      automated: row.automated,
      groupId: row.groupId,
      refCode: row.refCode,
    });
  }

  private sweep(now: number): void {
    this.prune((r) => r.endsAt === null || r.endsAt > now);
  }

  /** Keep only the rows `keep` accepts; empty lists and kinds are dropped. */
  private prune(keep: (row: IndexRow) => boolean): void {
    for (const table of [this.bySubject, this.byIp] as Map<SanctionKind, Map<string, IndexRow[]>>[]) {
      for (const [kind, byValue] of table) {
        for (const [value, list] of byValue) {
          const kept = list.filter(keep);
          if (kept.length === 0) byValue.delete(value);
          else if (kept.length !== list.length) byValue.set(value, kept);
        }
        if (byValue.size === 0) table.delete(kind);
      }
    }
  }
}

function outlasts(a: IndexRow, b: IndexRow): boolean {
  if (a.endsAt === null) return b.endsAt !== null;
  if (b.endsAt === null) return false;
  return a.endsAt > b.endsAt;
}
