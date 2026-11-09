import { randomBytes, randomInt } from 'node:crypto';
import type { Identifiers, SanctionKind, SanctionRow, Source, Store, SubjectId } from './types.js';
import type { RuleRef } from './rules.js';
import type { SubjectIndex } from './subjects.js';

// A sanction is written as one GROUP of rows tied by `groupId` and `refCode`: one row for the canonical
// subject (which covers every key and account the person is linked to, now and after any later merge), and
// optionally one row for the subject's latest IP. A moderator revokes "the sanction" once and every row is
// freed. The chat path never queries the store: it asks `SanctionIndex`, an in-memory copy that
// `applySanction` and `revokeSanction` keep current in the same tick as the write.

export type { SanctionKind, Source } from './types.js';

/** Every kind a sanction can have. The `kit_sanctions` CHECK constraint lists the same values. */
export const SANCTION_KINDS: readonly SanctionKind[] = ['chat', 'area', 'ban', 'warning'];

/** The longest rule-gap note, after trimming. */
export const GAP_NOTE_MAX = 500;

/**
 * A sanction input that fails validation. The message names the problem only: never a subject, a key, a rule-gap
 * note or any other value from the input.
 */
export class SanctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SanctionError';
  }
}

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
  /** Also write one IP row: the subject's most recently seen IP, capped at 24 h. Must be false for a warning. */
  includeIp: boolean;
  /** Milliseconds from now; null is permanent. Must be finite and above 0. Must be null for a warning. */
  durationMs: number | null;
  /** Private moderator note. Never returned to a player. */
  reason: string;
  actor: string;
  source: Source;
  automated: boolean;
  /**
   * The Community Rule the sanction cites: a rule number, or `'uncovered'` when none fits. Stored as TEXT. Absent
   * means `'uncovered'`.
   */
  rule?: RuleRef;
  /**
   * Private note saying what the rules did not cover. Required (non-empty, at most 500 characters after trimming)
   * when the rule is `'uncovered'` and the source is `moderator`; otherwise it must be absent. Never shown to a player.
   */
  gapNote?: string;
}

/** What `active` tells the chat path. No reason, rule, actor or identifier. */
export interface ActiveSanction {
  /** Epoch ms the restriction ends, or null for permanent. */
  until: number | null;
  automated: boolean;
  groupId: string;
  refCode: string;
  /**
   * The cited rule as stored text (`'1'`.. or `'uncovered'`), null for a row written before rules existed. Read it
   * with `parseRuleRef`. A rule number only; the private gap note is never here.
   */
  rule: string | null;
  /**
   * True when the person asked about is the one the sanction is on (a row on their canonical subject, or an IP row of
   * a group that also has such a row). False when only a shared IP row matched: a bystander. Only a person's own
   * sanction may point them at its rule or notice.
   */
  own: boolean;
}

const newId = (): string => randomBytes(16).toString('base64url');

/** `M-` plus 5 characters from an unambiguous alphabet. Uniqueness is enforced at write time, not here. */
export function refCode(): string {
  let out = 'M-';
  for (let i = 0; i < 5; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return out;
}

/** What `validate` settles: the rule as stored text, and the trimmed gap note (null when there is none). */
interface Checked {
  rule: string;
  gapNote: string | null;
}

/**
 * Check a sanction input without writing anything. Throws {@link SanctionError} exactly where `applySanction` would
 * (the same checks, run first). Lets a caller that writes several sanctions in one transaction refuse the whole
 * batch before the first write.
 */
export function validateSanctionInput(input: SanctionInput): void {
  validate(input);
}

function validate(input: SanctionInput): Checked {
  const d = input.durationMs;
  if (input.kind === 'warning') {
    // A warning has no end and no IP: it is a record, not a restriction.
    if (d !== null) throw new SanctionError('applySanction: a warning has no duration');
    if (input.includeIp) throw new SanctionError('applySanction: a warning has no IP row');
  } else if (d !== null && (!Number.isFinite(d) || d <= 0)) {
    // NaN would otherwise store NULL (a silent permanent ban); zero or less is an already-expired row.
    throw new SanctionError(`applySanction: invalid duration ${d}`);
  }
  if (!SANCTION_KINDS.includes(input.kind)) throw new SanctionError('applySanction: invalid kind');
  if (!SANCTION_SOURCES.includes(input.source)) throw new SanctionError('applySanction: invalid source');
  if (typeof input.subject !== 'string' || input.subject === '') throw new SanctionError('applySanction: missing subject');

  const ref: unknown = input.rule === undefined ? 'uncovered' : input.rule;
  const numbered = typeof ref === 'number' && Number.isSafeInteger(ref) && ref >= 1;
  if (ref !== 'uncovered' && !numbered) throw new SanctionError('applySanction: invalid rule');

  const note: unknown = input.gapNote;
  if (ref === 'uncovered' && input.source === 'moderator') {
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed === '') throw new SanctionError('applySanction: a rule-gap note is required when no rule is cited');
    if (trimmed.length > GAP_NOTE_MAX) throw new SanctionError('applySanction: the rule-gap note is too long');
    return { rule: 'uncovered', gapNote: trimmed };
  }
  if (note !== undefined) throw new SanctionError('applySanction: a rule-gap note is only for an uncovered moderator sanction');
  return { rule: String(ref), gapNote: null };
}

/** What {@link writeSanction} wrote: the group's handle and the rows, for the caller to hand to the index. */
export interface WrittenSanction {
  groupId: string;
  refCode: string;
  rows: SanctionRow[];
  /** Epoch ms the subject row ends; null = permanent. A warning ends where it starts. */
  endsAt: number | null;
}

function applyNow(
  store: Store,
  subjects: SubjectIndex,
  input: SanctionInput,
  now: number,
  pending: boolean,
): WrittenSanction {
  const { rule, gapNote } = validate(input);
  const subject = subjects.canonical(input.subject);
  // A warning has no end: it ends where it starts, so it is never "still running".
  const endsAt = input.kind === 'warning' ? now : input.durationMs === null ? null : now + input.durationMs;
  const ipEndsAt = endsAt === null ? now + IP_MAX_MS : Math.min(endsAt, now + IP_MAX_MS);
  const ip = input.includeIp ? subjects.latestIp(subject) : null;
  const groupId = newId();

  const build = (code: string): SanctionRow[] => {
    const base = {
      groupId,
      refCode: code,
      kind: input.kind,
      startsAt: now,
      reason: input.reason,
      rule,
      actor: input.actor,
      source: input.source,
      automated: input.automated,
      pending,
    };
    // The gap note lives on the subject row only: one gap per sanction group.
    const subjectRow: SanctionRow = {
      ...base,
      id: newId(),
      targetType: 'subject',
      value: subject,
      endsAt,
      gapNote,
      gapStatus: gapNote === null ? null : 'open',
    };
    const rows: SanctionRow[] = [subjectRow];
    if (ip !== null) {
      rows.push({ ...base, id: newId(), targetType: 'ip', value: ip, endsAt: ipEndsAt, gapNote: null, gapStatus: null });
    }
    return rows;
  };

  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
    const rows = build(refCode());
    const written = store.transaction(() => store.insertSanctionGroup(rows));
    if (written) return { groupId, refCode: rows[0]?.refCode ?? '', rows, endsAt };
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
    // Informational: `active()` already returns null while disabled and the row applies once it is re-enabled.
    const written = applyNow(store, subjects, input, now, index !== undefined && !index.isEnabled());
    index?.add(written.rows, now);
    return Promise.resolve({ groupId: written.groupId, refCode: written.refCode });
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Write one sanction group to the store and return its rows, WITHOUT touching any index. For a caller that writes
 * several things in one `store.transaction` and must only show the rows to the index once that transaction has
 * committed (`index.add(written.rows, now)`). Same validation and rows as {@link applySanction}; `pending` is the
 * value to record (true when enforcement is off). Synchronous; throws {@link SanctionError} on a bad input.
 */
export function writeSanction(
  store: Store,
  subjects: SubjectIndex,
  input: SanctionInput,
  now: number,
  pending: boolean,
): WrittenSanction {
  return applyNow(store, subjects, input, now, pending);
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
  rule: string | null;
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
   * `enabled()` is false. The result carries no reason, actor or
   * identifier.
   */
  active(kind: SanctionKind, ids: Identifiers, subject: SubjectId | null, now: number): ActiveSanction | null {
    if (!this.enabled()) return null;
    // A warning restricts nothing and is never indexed.
    if (kind === 'warning') return null;
    let best: IndexRow | null = null;
    const ownGroups = new Set<string>();
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
        if (this.subjects.canonical(stored) !== root) continue;
        for (const r of list) ownGroups.add(r.groupId);
        consider(list);
      }
    }
    const ip = ids.ipHash;
    if (ip !== null && ip !== '') consider(this.byIp.get(kind)?.get(ip));

    const found = best as IndexRow | null;
    return found === null
      ? null
      : {
          until: found.endsAt,
          automated: found.automated,
          groupId: found.groupId,
          refCode: found.refCode,
          rule: found.rule,
          own: ownGroups.has(found.groupId),
        };
  }

  private insert(row: SanctionRow): void {
    if (row.kind === 'warning') return;
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
      rule: row.rule,
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
