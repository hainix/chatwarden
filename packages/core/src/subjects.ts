import { randomId } from './crypto.js';
import { safeWarn } from './log.js';
import type {
  Clock,
  Identifiers,
  Logger,
  Store,
  SubjectId,
  SubjectIdKind,
  SubjectIdRecord,
} from './types.js';

/** `last_seen` of an identifier is written to the store at most this often. */
const LAST_SEEN_THROTTLE_MS = 3_600_000;

interface Owned {
  accounts: Set<string>;
  keys: Set<string>;
  ips: Set<string>;
}

interface Seen {
  firstSeen: number;
  lastSeen: number;
}

function present(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

function rowKey(subjectId: SubjectId, kind: SubjectIdKind, value: string): string {
  return `${subjectId}\u0000${kind}\u0000${value}`;
}

function newSubjectId(): SubjectId {
  // 16 random bytes -> 22 base64url characters. Never derived from an identifier.
  return `s_${randomId(16)}`;
}

function emptyOwned(): Owned {
  return { accounts: new Set(), keys: new Set(), ips: new Set() };
}

/**
 * One person across browsers and accounts.
 *
 * A client key or an account id finds or creates a subject. A key and an
 * account seen together are linked; if they belong to two subjects, those
 * merge: the older `created_at` survives (on a tie the smaller id), the other
 * gets `merged_into`. An IP is recorded on the subject it was seen with but is
 * NEVER used to find or merge one: `resolve` of an IP-only call returns null
 * and creates nothing, and two keys behind one household IP stay two people.
 *
 * Everything the hot path needs is in memory. `resolve` is synchronous and
 * queues its store writes in order; a failed write is logged (see
 * {@link Logger}) and never thrown to the caller. Call `load()` once at start
 * up; call `flush()` before shutting down (or in tests) to wait for queued
 * writes.
 *
 * Identifiers stay attached to the subject they were first seen on, even after
 * that subject is merged away; `canonical` resolves the alias and
 * `identifiersOf` gathers every identifier of every subject merged into a root.
 */
export class SubjectIndex {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;

  /** Subject id -> created_at, for every known subject (merged ones too). */
  private created = new Map<SubjectId, number>();
  /** Absorbed subject -> the subject it was merged into (compressed lazily). */
  private parent = new Map<SubjectId, SubjectId>();
  /** Key / account value -> the (stored) subject it belongs to. */
  private keyOwner = new Map<string, SubjectId>();
  private accountOwner = new Map<string, SubjectId>();
  /** Identifiers recorded on each stored subject. */
  private owned = new Map<SubjectId, Owned>();
  /** Root -> every subject that canonicalises to it, itself included. */
  private members = new Map<SubjectId, Set<SubjectId>>();
  /** First/last seen of each stored identifier row, for the last_seen throttle. */
  private seen = new Map<string, Seen>();
  /**
   * Exact last time each IP row was seen by `resolve` in this process. The
   * stored `lastSeen` is throttled to once an hour; this is not, so `latestIp`
   * can tell which of two addresses seen minutes apart is the newer.
   */
  private ipSeenAt = new Map<string, number>();

  private tail: Promise<void> = Promise.resolve();

  constructor(store: Store, clock: Clock, opts?: { logger?: Logger }) {
    this.store = store;
    this.clock = clock;
    this.logger = opts?.logger;
  }

  /** Rebuild the in-memory index from the store. Call once before `resolve`. */
  async load(): Promise<void> {
    const { subjects, ids } = await this.store.loadSubjects();
    this.created = new Map();
    this.parent = new Map();
    this.keyOwner = new Map();
    this.accountOwner = new Map();
    this.owned = new Map();
    this.members = new Map();
    this.seen = new Map();
    this.ipSeenAt = new Map();

    for (const s of subjects) {
      this.created.set(s.id, s.createdAt);
      this.owned.set(s.id, emptyOwned());
      if (s.mergedInto !== null && s.mergedInto !== s.id) this.parent.set(s.id, s.mergedInto);
    }
    for (const r of ids) {
      const owned = this.owned.get(r.subjectId);
      if (owned === undefined) continue; // orphan row
      if (r.kind === 'key') {
        owned.keys.add(r.value);
        if (!this.keyOwner.has(r.value)) this.keyOwner.set(r.value, r.subjectId);
      } else if (r.kind === 'account') {
        owned.accounts.add(r.value);
        if (!this.accountOwner.has(r.value)) this.accountOwner.set(r.value, r.subjectId);
      } else {
        owned.ips.add(r.value);
      }
      this.seen.set(rowKey(r.subjectId, r.kind, r.value), { firstSeen: r.firstSeen, lastSeen: r.lastSeen });
    }
    for (const s of subjects) {
      const root = this.canonical(s.id);
      let set = this.members.get(root);
      if (set === undefined) {
        set = new Set();
        this.members.set(root, set);
      }
      set.add(s.id);
    }
  }

  /**
   * The subject for these identifiers, creating or merging as the rules say;
   * null when there is neither a client key nor an account (an IP alone never
   * finds a subject). The result is always a canonical (surviving) subject.
   */
  resolve(ids: Identifiers): SubjectId | null {
    const key = present(ids.clientKey);
    const account = present(ids.accountId);
    const ip = present(ids.ipHash);
    if (key === null && account === null) return null;

    const now = this.clock.now();
    const keyOwner = key === null ? undefined : this.keyOwner.get(key);
    const accountOwner = account === null ? undefined : this.accountOwner.get(account);
    const keyRoot = keyOwner === undefined ? undefined : this.canonical(keyOwner);
    const accountRoot = accountOwner === undefined ? undefined : this.canonical(accountOwner);

    let root: SubjectId;
    if (keyRoot !== undefined && accountRoot !== undefined) {
      root = keyRoot === accountRoot ? keyRoot : this.merge(keyRoot, accountRoot);
    } else if (keyRoot !== undefined) {
      root = keyRoot;
    } else if (accountRoot !== undefined) {
      root = accountRoot;
    } else {
      root = this.create(now);
    }

    if (key !== null) {
      if (keyOwner === undefined) this.attach(root, 'key', key, now);
      else this.touch(keyOwner, 'key', key, now);
    }
    if (account !== null) {
      if (accountOwner === undefined) this.attach(root, 'account', account, now);
      else this.touch(accountOwner, 'account', account, now);
    }
    if (ip !== null) {
      if (this.owned.get(root)?.ips.has(ip) === true) this.touch(root, 'ip', ip, now);
      else this.attach(root, 'ip', ip, now);
      this.ipSeenAt.set(rowKey(root, 'ip', ip), now);
    }
    return root;
  }

  /**
   * The existing subject for these identifiers, or null. Read-only: it never creates a subject, records
   * an identifier, links or merges, and queues no store write, so a door check cannot mint people or
   * join two identities. An IP alone finds nothing. When the key and the account belong to two
   * different subjects (not yet linked), the one a merge would keep (the older) is returned.
   */
  lookup(ids: Identifiers): SubjectId | null {
    const key = present(ids.clientKey);
    const account = present(ids.accountId);
    const keyOwner = key === null ? undefined : this.keyOwner.get(key);
    const accountOwner = account === null ? undefined : this.accountOwner.get(account);
    const keyRoot = keyOwner === undefined ? undefined : this.canonical(keyOwner);
    const accountRoot = accountOwner === undefined ? undefined : this.canonical(accountOwner);
    if (keyRoot === undefined) return accountRoot ?? null;
    if (accountRoot === undefined || accountRoot === keyRoot) return keyRoot;
    const ck = this.created.get(keyRoot) ?? 0;
    const ca = this.created.get(accountRoot) ?? 0;
    const keyWins = ck !== ca ? ck < ca : keyRoot < accountRoot;
    return keyWins ? keyRoot : accountRoot;
  }

  /**
   * The surviving subject `id` was merged into, following the chain to the
   * root. An id the index has never seen is returned unchanged.
   */
  canonical(id: SubjectId): SubjectId {
    let cur = id;
    const path: SubjectId[] = [];
    for (;;) {
      const next = this.parent.get(cur);
      if (next === undefined) break;
      path.push(cur);
      cur = next;
      if (path.length > this.parent.size) break; // damaged cycle: stop
    }
    for (const p of path) if (p !== cur) this.parent.set(p, cur);
    return cur;
  }

  /**
   * The surviving subject for `id` and every subject merged into it (itself included), sorted. An id the index has
   * never seen is its own and only member. Use it to read rows stored under any of a person's ids.
   */
  aliasesOf(id: SubjectId): SubjectId[] {
    const root = this.canonical(id);
    return [...(this.members.get(root) ?? [root])].sort();
  }

  /**
   * Every identifier of the subject and of every subject merged into it
   * (sorted copies). An unknown id has none.
   */
  identifiersOf(id: SubjectId): { accounts: string[]; keys: string[]; ips: string[] } {
    const accounts = new Set<string>();
    const keys = new Set<string>();
    const ips = new Set<string>();
    for (const member of this.members.get(this.canonical(id)) ?? []) {
      const o = this.owned.get(member);
      if (o === undefined) continue;
      for (const v of o.accounts) accounts.add(v);
      for (const v of o.keys) keys.add(v);
      for (const v of o.ips) ips.add(v);
    }
    return { accounts: [...accounts].sort(), keys: [...keys].sort(), ips: [...ips].sort() };
  }

  /**
   * The hashed IP most recently seen with the subject or any subject merged
   * into it, or null when none was seen. On a tie the smaller value wins.
   * An IP is never used to find a subject; this only reads what was recorded.
   */
  latestIp(id: SubjectId): string | null {
    let best: string | null = null;
    let bestAt = -Infinity;
    for (const member of this.members.get(this.canonical(id)) ?? []) {
      for (const ip of this.owned.get(member)?.ips ?? []) {
        const key = rowKey(member, 'ip', ip);
        const at = this.ipSeenAt.get(key) ?? this.seen.get(key)?.lastSeen ?? -Infinity;
        if (at > bestAt || (at === bestAt && best !== null && ip < best)) {
          best = ip;
          bestAt = at;
        }
      }
    }
    return best;
  }

  /** Resolves once every store write queued so far has been attempted. Never rejects. */
  async flush(): Promise<void> {
    let t: Promise<void>;
    do {
      t = this.tail;
      await t;
    } while (t !== this.tail);
  }

  // --- internals -----------------------------------------------------------

  private create(now: number): SubjectId {
    const id = newSubjectId();
    this.created.set(id, now);
    this.owned.set(id, emptyOwned());
    this.members.set(id, new Set([id]));
    this.enqueue(() => this.store.saveSubject({ id, createdAt: now, mergedInto: null }));
    return id;
  }

  /** Merge two distinct roots. The older survives; on a tie the smaller id. Returns the survivor. */
  private merge(a: SubjectId, b: SubjectId): SubjectId {
    const ca = this.created.get(a) ?? 0;
    const cb = this.created.get(b) ?? 0;
    const aWins = ca !== cb ? ca < cb : a < b;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;

    this.parent.set(loser, winner);
    const winners = this.members.get(winner) ?? new Set([winner]);
    for (const m of this.members.get(loser) ?? [loser]) winners.add(m);
    this.members.set(winner, winners);
    this.members.delete(loser);

    this.enqueue(() => this.store.markMerged(loser, winner));
    return winner;
  }

  /** Record an identifier seen for the first time on `subject`. */
  private attach(subject: SubjectId, kind: SubjectIdKind, value: string, now: number): void {
    const owned = this.owned.get(subject);
    if (owned === undefined) return;
    if (kind === 'key') {
      owned.keys.add(value);
      this.keyOwner.set(value, subject);
    } else if (kind === 'account') {
      owned.accounts.add(value);
      this.accountOwner.set(value, subject);
    } else {
      owned.ips.add(value);
    }
    const seen = { firstSeen: now, lastSeen: now };
    this.seen.set(rowKey(subject, kind, value), seen);
    this.enqueue(() => this.store.saveIdentifier({ subjectId: subject, kind, value, ...seen }));
  }

  /** An identifier seen again: bump `last_seen`, writing at most once per throttle window. */
  private touch(subject: SubjectId, kind: SubjectIdKind, value: string, now: number): void {
    const seen = this.seen.get(rowKey(subject, kind, value));
    if (seen === undefined) return; // cannot happen: every owned identifier has a row
    if (now - seen.lastSeen < LAST_SEEN_THROTTLE_MS) return;
    seen.lastSeen = now;
    const record: SubjectIdRecord = { subjectId: subject, kind, value, firstSeen: seen.firstSeen, lastSeen: now };
    this.enqueue(() => this.store.saveIdentifier(record));
  }

  /** Queue a store write behind the earlier ones. A failure is logged, never thrown. */
  private enqueue(op: () => Promise<void>): void {
    this.tail = this.tail.then(async () => {
      try {
        await op();
      } catch (err) {
        this.logFailure(err);
      }
    });
  }

  private logFailure(err: unknown): void {
    safeWarn(this.logger, 'subjects.write_failed', { error: err instanceof Error ? err.name : typeof err });
  }
}
