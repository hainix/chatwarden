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

/** How often a process looks at the store's erasure epoch (on its next subject lookup): at most once in this long. */
export const EPOCH_CHECK_MS = 30_000;

/** A subject whose first save failed is saved again at most this often (on the injected clock), on the next flush or lookup after this long. */
export const SAVE_RETRY_MS = 5_000;

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
  /** Bumped whenever the answer of `canonical` can change for some id: a merge, a reload from the store, a forget. A reader that indexes by canonical id rebuilds when it moved. */
  private structure = 0;
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
   * Exact last time each IP row and each account row was seen by `resolve` in this process. The
   * stored `lastSeen` is throttled to once an hour; this is not, so `latestIp` and `latestAccount`
   * can tell which of two values seen minutes apart is the newer.
   */
  private ipSeenAt = new Map<string, number>();

  private tail: Promise<void> = Promise.resolve();

  /** Subjects made in this process whose `saveSubject` has not finished, or failed: a reload must not mistake them for erased ones. */
  private readonly unsaved = new Set<SubjectId>();
  /** The subset of `unsaved` whose save threw. They are tried again (see `retryFailed`), with the identifiers and the merge that waited behind them. */
  private readonly failedSaves = new Set<SubjectId>();
  private lastSaveAttemptAt = Number.NEGATIVE_INFINITY;
  /**
   * Called with the people a reload found the store no longer has (erased by another process), after the index dropped them. The facade forgets what else it holds
   * for them (room seats, evidence, caches), so a seat of an erased person never keeps writing under the dead id.
   */
  onGone: ((gone: ReadonlySet<SubjectId>) => void) | undefined = undefined;
  /** The store's erasure epoch when this process last looked, and when it looked (see `checkEpoch`). */
  private epochSeen: number | null = null;
  private epochCheckedAt = Number.NEGATIVE_INFINITY;

  constructor(store: Store, clock: Clock, opts?: { logger?: Logger }) {
    this.store = store;
    this.clock = clock;
    this.logger = opts?.logger;
  }

  /**
   * A counter that moves whenever `canonical` may answer differently for some id than it did before (a merge, a reload from the store, subjects forgotten). A reader that keeps
   * something keyed by canonical ids (the mute index) compares it to the value it built at, and rebuilds only when it differs. Looking an id up never moves it.
   */
  get mergeVersion(): number {
    return this.structure;
  }

  /** Rebuild the in-memory index from the store. Call once before `resolve`. */
  async load(): Promise<void> {
    const { subjects, ids } = await this.store.loadSubjects();
    this.structure += 1;
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
    this.readEpoch();
  }

  /** Remember the store's erasure epoch as the one this process has caught up with. A read that fails is logged by class and leaves the last one. */
  private readEpoch(): void {
    try {
      this.epochSeen = this.store.erasureEpoch();
    } catch (err) {
      safeWarn(this.logger, 'chatwarden.epoch_failed', { error: err instanceof Error ? err.name : typeof err });
    }
  }

  /**
   * Another process may have erased a person this one still has in memory. Look at the store's erasure epoch at most once every {@link EPOCH_CHECK_MS} (on the next
   * lookup, on the injected clock); when it moved, forget the people the store no longer has (queued behind earlier writes, so a subject made here and not yet saved is
   * kept). A write for a subject that is gone is a no-op in the store, so a stale index can never recreate a row. Never throws.
   */
  private checkEpoch(): void {
    const now = this.clock.now();
    if (now - this.epochCheckedAt < EPOCH_CHECK_MS) return;
    this.epochCheckedAt = now;
    try {
      const epoch = this.store.erasureEpoch();
      if (this.epochSeen === null) {
        this.epochSeen = epoch;
        return;
      }
      if (epoch === this.epochSeen) return;
      this.catchUp(epoch);
    } catch (err) {
      safeWarn(this.logger, 'chatwarden.epoch_failed', { error: err instanceof Error ? err.name : typeof err });
    }
  }

  /**
   * Reconcile with the store (queued behind the earlier writes) and only then call the epoch `epoch` seen. Reading the epoch BEFORE the reload means an erase that lands
   * in between is caught by the next check; a reload that fails leaves the old epoch, so the next check tries again instead of forgetting that it owes one.
   */
  private catchUp(epoch: number): void {
    this.enqueue(async () => {
      await this.reconcile();
      this.epochSeen = epoch;
    });
  }

  /**
   * Catch up with the store now: flush the queued writes, then forget the people it no longer has (see `checkEpoch`). The retention pass calls it after it finished an
   * erase, so this process stops knowing the person at once instead of within 30 seconds.
   */
  async refresh(): Promise<void> {
    await this.flush();
    let epoch: number | null = null;
    try {
      epoch = this.store.erasureEpoch();
    } catch (err) {
      safeWarn(this.logger, 'chatwarden.epoch_failed', { error: err instanceof Error ? err.name : typeof err });
    }
    await this.reconcile();
    if (epoch !== null) this.epochSeen = epoch;
  }

  /** True while a subject made here has not been written to the store (its save is in flight, or failed and waits for a retry). */
  hasUnsaved(): boolean {
    return this.unsaved.size > 0;
  }

  /** Drop every subject this index has that the store does not (and that is not waiting to be saved). */
  private async reconcile(): Promise<void> {
    const { subjects } = await this.store.loadSubjects();
    const alive = new Set(subjects.map((s) => s.id));
    const gone = new Set<SubjectId>();
    for (const id of this.created.keys()) if (!alive.has(id) && !this.unsaved.has(id)) gone.add(id);
    if (gone.size === 0) return;
    this.drop(gone);
    try {
      this.onGone?.(gone);
    } catch (err) {
      safeWarn(this.logger, 'subjects.gone_failed', { error: err instanceof Error ? err.name : typeof err });
    }
  }

  /**
   * Forget these people and everything merged into them: their ids, every key and account they held, their aliases. A key or account that returns makes a NEW,
   * unlinked subject. Memory only (the store rows go with the erase). Used by `cw.privacy.erase`. The erasing process takes the epoch as seen only when it moved by
   * exactly the one step this erase made; when it moved further, another process erased too and this one has not heard of it, so it reconciles now (a plain "take
   * the current epoch" would swallow that erase for good).
   */
  forget(subjects: Iterable<SubjectId>): void {
    const set = new Set<SubjectId>();
    for (const id of subjects) {
      set.add(id);
      for (const m of this.members.get(this.canonical(id)) ?? []) set.add(m);
    }
    this.drop(set);
    try {
      const epoch = this.store.erasureEpoch();
      if (this.epochSeen === null || epoch === this.epochSeen + 1) this.epochSeen = epoch;
      else if (epoch !== this.epochSeen) this.catchUp(epoch);
    } catch (err) {
      safeWarn(this.logger, 'chatwarden.epoch_failed', { error: err instanceof Error ? err.name : typeof err });
    }
  }

  private drop(set: ReadonlySet<SubjectId>): void {
    this.structure += 1;
    for (const id of set) {
      const owned = this.owned.get(id);
      for (const k of owned?.keys ?? []) if (this.keyOwner.get(k) === id) this.keyOwner.delete(k);
      for (const a of owned?.accounts ?? []) if (this.accountOwner.get(a) === id) this.accountOwner.delete(a);
      this.owned.delete(id);
      this.created.delete(id);
      this.parent.delete(id);
      this.members.delete(id);
      this.unsaved.delete(id);
      this.failedSaves.delete(id);
    }
    for (const [child, parent] of [...this.parent]) if (set.has(child) || set.has(parent)) this.parent.delete(child);
    for (const [root, members] of [...this.members]) {
      for (const id of set) members.delete(id);
      if (members.size === 0) this.members.delete(root);
    }
    const prefixes = [...set].map((id) => `${id}\u0000`);
    for (const key of [...this.seen.keys()]) if (prefixes.some((p) => key.startsWith(p))) this.seen.delete(key);
    for (const key of [...this.ipSeenAt.keys()]) if (prefixes.some((p) => key.startsWith(p))) this.ipSeenAt.delete(key);
  }

  /**
   * The subject for these identifiers, creating or merging as the rules say;
   * null when there is neither a client key nor an account (an IP alone never
   * finds a subject). The result is always a canonical (surviving) subject.
   */
  resolve(ids: Identifiers): SubjectId | null {
    this.checkEpoch();
    this.retryFailed();
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
      this.ipSeenAt.set(rowKey(accountOwner ?? root, 'account', account), now);
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
    this.checkEpoch();
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

  /** Has this index ever seen the subject id (a merged-away one included)? A pure read: it creates nothing. */
  knows(id: SubjectId): boolean {
    return typeof id === 'string' && this.created.has(id);
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

  /**
   * The account id (as the game gave it, raw) most recently seen with the subject or any subject merged into it, or null when none was seen. On a tie the smaller
   * value wins. A read: it creates nothing. For the delivery hook, which writes to the account a person was last seen with.
   */
  latestAccount(id: SubjectId): string | null {
    let best: string | null = null;
    let bestAt = -Infinity;
    for (const member of this.members.get(this.canonical(id)) ?? []) {
      for (const account of this.owned.get(member)?.accounts ?? []) {
        const key = rowKey(member, 'account', account);
        const at = this.ipSeenAt.get(key) ?? this.seen.get(key)?.lastSeen ?? -Infinity;
        if (at > bestAt || (at === bestAt && (best === null || account < best))) {
          best = account;
          bestAt = at;
        }
      }
    }
    return best;
  }

  /** Resolves once every store write queued so far has been attempted. Never rejects. */
  async flush(): Promise<void> {
    this.retryFailed();
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
    this.unsaved.add(id);
    this.enqueue(() => this.saveNew([id]));
    return id;
  }

  /** Queue a retry of the subjects whose save failed, at most once every {@link SAVE_RETRY_MS}. */
  private retryFailed(): void {
    if (this.failedSaves.size === 0) return;
    const now = this.clock.now();
    if (now - this.lastSaveAttemptAt < SAVE_RETRY_MS) return;
    this.lastSaveAttemptAt = now;
    const ids = [...this.failedSaves];
    this.enqueue(() => this.saveNew(ids));
  }

  /**
   * Write these subjects. A subject whose save fails stays in `unsaved` (a reload never drops it, the stray-row sweep is told) and in `failedSaves`, to be tried again.
   * A write for a subject with no row is a no-op in the store, so when a subject that had failed is finally saved its identifiers and its place in a merge, which
   * waited behind it, are written again.
   */
  private async saveNew(ids: readonly SubjectId[]): Promise<void> {
    this.lastSaveAttemptAt = this.clock.now();
    const saved: Array<{ id: SubjectId; again: boolean }> = [];
    for (const id of ids) {
      const createdAt = this.created.get(id);
      if (createdAt === undefined) {
        this.unsaved.delete(id);
        this.failedSaves.delete(id);
        continue;
      }
      try {
        await this.store.saveSubject({ id, createdAt, mergedInto: null });
        saved.push({ id, again: this.failedSaves.has(id) });
      } catch (err) {
        this.failedSaves.add(id);
        this.logFailure(err);
      }
    }
    for (const { id, again } of saved) {
      if (!again) {
        this.unsaved.delete(id);
        continue;
      }
      try {
        await this.rewrite(id);
        this.failedSaves.delete(id);
        this.unsaved.delete(id);
      } catch (err) {
        this.logFailure(err);
      }
    }
  }

  /** Write the identifiers of a subject again, and its merge into another subject. Every write is idempotent. */
  private async rewrite(id: SubjectId): Promise<void> {
    const prefix = `${id}\u0000`;
    for (const [key, seen] of [...this.seen]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = rest.indexOf('\u0000');
      const kind = rest.slice(0, cut) as SubjectIdKind;
      const value = rest.slice(cut + 1);
      await this.store.saveIdentifier({ subjectId: id, kind, value, firstSeen: seen.firstSeen, lastSeen: seen.lastSeen });
    }
    const parent = this.parent.get(id);
    if (parent !== undefined) await this.store.markMerged(id, parent);
  }

  /** Merge two distinct roots. The older survives; on a tie the smaller id. Returns the survivor. */
  private merge(a: SubjectId, b: SubjectId): SubjectId {
    const ca = this.created.get(a) ?? 0;
    const cb = this.created.get(b) ?? 0;
    const aWins = ca !== cb ? ca < cb : a < b;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;

    this.parent.set(loser, winner);
    this.structure += 1;
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
