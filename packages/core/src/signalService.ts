import { randomId, sha256Hex } from './crypto.js';
import { errorClass, safeWarn, ThrottledWarn } from './log.js';
import type { SignalHit } from './ladder.js';
import { countSignals, evaluateThreshold } from './signalCounts.js';
import { BUILTIN_SIGNAL_KINDS, SIGNAL_WINDOW_DAYS_MAX } from './signals.js';
import type { ResolvedSignals, SignalCount, SignalInput, SignalKindView } from './signals.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, RawWho, Store, SubjectId } from './types.js';

// The signal service behind `cw.signals`: record (guarded), count, and the reads the feeds make. A signal never acts; this only keeps rows
// and counts them. Everything here is fenced: `record` returns false and the readers return empty, never throw. Logs carry event names and
// reason codes (and an error class), never a subject, a `by`, a room, a kind id or a label.

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
/** How far ahead of the clock a record may be dated. */
const AHEAD_MS = 5 * MIN_MS;
/** The window `counts` uses when it is not given one. */
const DEFAULT_WINDOW_DAYS = 30;
/** The most people one `boosted` call reads. */
const BOOSTED_MAX = 1000;
const ROOM_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const SUBJECT_ID_MAX = 128;
/** The longest connection detail (client key, account id, IP) a record may carry: longer is not a real one, and it would be hashed. */
const DETAIL_MAX = 512;
/** How long a player's account age is remembered, and for how many players. */
const AGE_MEMO_MS = MIN_MS;
const AGE_MEMO_MAX = 256;

/** Is this a room id a signal may carry (1 to 64 of A-Z a-z 0-9 _ . : -)? */
export const isSignalRoomId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && ROOM_ID.test(v);

/**
 * The room id a flood row carries: the id itself when the signal rules accept it, else a stable `h` plus 16 hex digits of its SHA-256 (so a
 * game whose room ids hold a space or run long still gets one source per room, and only the digest is stored). Undefined for no room.
 */
export const floodRoomId = (v: unknown): string | undefined => (typeof v !== 'string' || v === '' ? undefined : isSignalRoomId(v) ? v : `h${sha256Hex(v).slice(0, 16)}`);

export type SignalRefusal = 'undeclared' | 'malformed' | 'unknown_subject' | 'self' | 'time' | 'capped' | 'no_store' | 'store_failed';

/** Thrown inside `record` to end it with a reason; never leaves the service. */
class Refusal extends Error {
  readonly reason: SignalRefusal;
  readonly detail: string | undefined;
  constructor(reason: SignalRefusal, detail?: string) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

export interface SignalServiceDeps {
  store: Store;
  clock: Clock;
  logger: Logger | undefined;
  subjects: SubjectIndex;
  /** The person behind a player's connection details: FOUND and never created. */
  personOf: (who: RawWho) => SubjectId | null;
  /** The signal settings in force right now (kinds, guards, feeds). Read on every call. */
  settings: () => ResolvedSignals;
  /** How long signal rows are kept, ms. */
  signalsMs: () => number;
  /** How old is this player's account, in days? See `ChatwardenOptions.signals`. */
  accountAgeDays?: (accountIds: readonly string[]) => number | null | undefined;
}

/** An own, defined field of a plain object, or undefined. */
function field(o: object, key: string): unknown {
  return Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
}

function isPlainObject(v: unknown): v is object {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** What the kit asks of the signal service: the real one, or the inert one (`./signalInert.js`) for a store that cannot keep signals. */
export interface SignalRuntime {
  /** Record one signal; false for any refusal. Never throws. */
  record(input: SignalInput): boolean;
  /** The built-in `flood_triggered` for a person, with the room only when the signal rules accept its id. Never throws. */
  flood(subject: SubjectId, roomId: string): void;
  counts(subject: SubjectId, opts?: { windowDays?: number; kinds?: readonly string[] }): SignalCount[];
  kinds(): SignalKindView[];
  boosted(people: readonly SubjectId[]): Set<SubjectId>;
  forRecord(subject: SubjectId): SignalCount[];
  /** The counts the AI read may be shown (`feeds.ai`): the feed's kinds and window. `[]` when the feed is off. Never throws. */
  forAi(subject: SubjectId): SignalCount[];
  ladderHits(subject: SubjectId): SignalHit[];
}

export class SignalService implements SignalRuntime {
  private readonly deps: SignalServiceDeps;
  /** One throttle per refusal reason, so a burst of `malformed` cannot hide a `store_failed` for a minute. */
  private readonly refusedWarn = new Map<string, ThrottledWarn>();
  private readonly readWarn: ThrottledWarn;
  private readonly ageWarn: ThrottledWarn;
  private unsupportedLogged = false;
  /** The account age the game's hook gave for a player, and when (see `accountFactor`). */
  private readonly ageMemo = new Map<SubjectId, { age: unknown; at: number }>();

  constructor(deps: SignalServiceDeps) {
    this.deps = deps;
    this.readWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.ageWarn = new ThrottledWarn(deps.logger, deps.clock);
  }

  /** Does the store keep signals (the three methods)? */
  private get supported(): boolean {
    const s = this.deps.store;
    return typeof s.insertSignal === 'function' && typeof s.listSignalSources === 'function' && typeof s.purgeSignals === 'function';
  }

  /** The store cannot keep signals: said once per kit, as the AI does for its own optional methods. */
  private unsupported(): void {
    if (this.unsupportedLogged) return;
    this.unsupportedLogged = true;
    safeWarn(this.deps.logger, 'chatwarden.signals_store_unsupported');
  }

  // --- record ---------------------------------------------------------------------------------------------------

  /** Record one signal. Synchronous, fenced, never throws: false for any refusal (logged by reason code, at most once a minute). */
  record(input: SignalInput): boolean {
    return this.guarded(input, false);
  }

  /** `record`'s body. `quietCapped`: the cap refusing is the designed answer (a second flood trip the same day), so it is not logged. */
  private guarded(input: unknown, quietCapped: boolean): boolean {
    try {
      if (!this.supported) {
        this.unsupported();
        return false;
      }
      return this.recordRow(input);
    } catch (err) {
      const reason = err instanceof Refusal ? err.reason : 'malformed';
      if (quietCapped && reason === 'capped') return false;
      try {
        let throttle = this.refusedWarn.get(reason);
        if (throttle === undefined) this.refusedWarn.set(reason, (throttle = new ThrottledWarn(this.deps.logger, this.deps.clock)));
        throttle.warn('chatwarden.signal_refused', err instanceof Refusal && err.detail !== undefined ? { reason, error: err.detail } : { reason });
      } catch {
        // The log must never change the answer.
      }
      return false;
    }
  }

  flood(subject: SubjectId, roomId: string): void {
    const room = floodRoomId(roomId);
    this.guarded({ kind: 'flood_triggered', subject, ...(room === undefined ? {} : { roomId: room }) }, true);
  }

  private recordRow(input: unknown): boolean {
    if (!isPlainObject(input)) throw new Refusal('malformed');
    const { kinds, guards } = this.deps.settings();
    const kindId = field(input, 'kind');
    if (typeof kindId !== 'string') throw new Refusal('malformed');
    if (!Object.hasOwn(kinds, kindId)) throw new Refusal('undeclared');
    const spec = kinds[kindId]!;

    // null is "left out" for the optional fields a game fills from a maybe-null variable: by, roomId and at.
    const given = (key: string): unknown => field(input, key) ?? undefined;
    const roomId = given('roomId');
    if (roomId !== undefined && !isSignalRoomId(roomId)) throw new Refusal('malformed');
    const now = this.deps.clock.now();
    const givenAt = given('at');
    if (givenAt !== undefined && !(typeof givenAt === 'number' && Number.isFinite(givenAt))) throw new Refusal('malformed');
    const at = givenAt ?? now;
    if (at > now + AHEAD_MS || at < now - this.deps.signalsMs()) throw new Refusal('time');
    const givenWeight = field(input, 'weight');
    if (givenWeight !== undefined && !(typeof givenWeight === 'number' && Number.isFinite(givenWeight) && givenWeight >= 0 && givenWeight <= 10)) {
      throw new Refusal('malformed');
    }

    const subject = this.party(field(input, 'subject'));
    const rawBy = given('by');
    const by = rawBy === undefined ? null : this.party(rawBy);
    if (by !== null && by === subject) throw new Refusal('self');

    const weight = (givenWeight ?? spec.weight) * this.accountFactor(by, guards.newAccount);
    const sourceKey = by !== null ? `b:${by}` : roomId !== undefined ? `r:${roomId}` : `d:${new Date(at).toISOString().slice(0, 10)}`;
    const wrote = this.insert({
      id: randomId(16),
      kind: kindId,
      subject,
      sourceKey,
      bySubject: by,
      roomId: roomId ?? null,
      at,
      weight,
      capBucket: Math.floor(at / guards.perByWindowMs),
    });
    if (!wrote) throw new Refusal('capped');
    return true;
  }

  private insert(row: Parameters<NonNullable<Store['insertSignal']>>[0]): boolean {
    try {
      return this.deps.store.insertSignal?.(row) ?? false;
    } catch (err) {
      throw new Refusal('store_failed', errorClass(err));
    }
  }

  /** The canonical person a party names: a subject id the index knows, or a connection details object FOUND (never created). */
  private party(p: unknown): SubjectId {
    if (typeof p === 'string') {
      if (p === '' || p.length > SUBJECT_ID_MAX || !this.deps.subjects.knows(p)) throw new Refusal('unknown_subject');
      return this.deps.subjects.canonical(p);
    }
    if (!isPlainObject(p)) throw new Refusal('malformed');
    const who: RawWho = {};
    for (const key of ['clientKey', 'accountId'] as const) {
      const v = field(p, key);
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.length > DETAIL_MAX) throw new Refusal('malformed');
      who[key] = v;
    }
    const ip = field(p, 'ip');
    if (ip !== undefined && ip !== null) {
      if (typeof ip !== 'string' || ip.length > DETAIL_MAX) throw new Refusal('malformed');
      who.ip = ip;
    }
    const found = this.deps.personOf(who);
    if (found === null) throw new Refusal('unknown_subject');
    return this.deps.subjects.canonical(found);
  }

  /**
   * The new-account factor for `by`: the guard's factor only when the game supplied the hook, it returned an age for the player's
   * account ids, and the age is below `belowDays`; else 1. A hook that throws is unknown (logged by class). Computed once, at record time.
   */
  private accountFactor(by: SubjectId | null, rule: ResolvedSignals['guards']['newAccount']): number {
    const hook = this.deps.accountAgeDays;
    if (rule === null || hook === undefined || by === null) return 1;
    const accounts = this.deps.subjects.identifiersOf(by).accounts;
    if (accounts.length === 0) return 1;
    // The game's hook is often a lookup: a player recording over and over is asked once a minute, not on every record.
    const now = this.deps.clock.now();
    const known = this.ageMemo.get(by);
    let age: unknown;
    if (known !== undefined && now >= known.at && now - known.at < AGE_MEMO_MS) age = known.age;
    else {
      try {
        age = hook(accounts);
      } catch (err) {
        this.ageWarn.warn('chatwarden.signal_age_failed', { error: errorClass(err) });
        return 1;
      }
      this.ageMemo.delete(by);
      this.ageMemo.set(by, { age, at: now });
      if (this.ageMemo.size > AGE_MEMO_MAX) this.ageMemo.delete(this.ageMemo.keys().next().value!);
    }
    return typeof age === 'number' && Number.isFinite(age) && age >= 0 && age < rule.belowDays ? rule.factor : 1;
  }

  /** A read that failed (a store fault) answers empty; it is said once a minute, by the error's class only. Never throws. */
  private readFailed(err: unknown): void {
    try {
      this.readWarn.warn('chatwarden.signal_read_failed', { error: errorClass(err) });
    } catch {
      // The log must never change the answer.
    }
  }

  // --- reads ----------------------------------------------------------------------------------------------------

  /** The declared kinds, built-ins included. */
  kinds(): SignalKindView[] {
    const { kinds } = this.deps.settings();
    return Object.keys(kinds).map((kind) => {
      const k = kinds[kind]!;
      return { kind, label: k.label, polarity: k.polarity, weight: k.weight, builtin: Object.hasOwn(BUILTIN_SIGNAL_KINDS, kind) };
    });
  }

  /** The counts for a person (aliases folded): one entry per requested kind with a counted source. Never throws; a store failure reads []. */
  counts(subject: SubjectId, opts?: { windowDays?: number; kinds?: readonly string[] }): SignalCount[] {
    try {
      if (!this.supported) return [];
      const windowDays = this.windowOf(opts?.windowDays);
      const asked = opts?.kinds;
      const kinds = this.kindsFor(Array.isArray(asked) ? (asked as unknown[]) : undefined);
      return this.countFor(subject, windowDays, kinds);
    } catch (err) {
      this.readFailed(err);
      return [];
    }
  }

  private windowOf(asked: unknown): number {
    const cap = Math.max(1, Math.min(SIGNAL_WINDOW_DAYS_MAX, Math.floor(this.deps.signalsMs() / DAY_MS)));
    if (typeof asked !== 'number' || !Number.isFinite(asked) || asked < 1) return Math.min(DEFAULT_WINDOW_DAYS, cap);
    return Math.min(Math.floor(asked), cap);
  }

  /** The declared kinds (all, or those named, in declared order) as the counting context wants them. */
  private kindsFor(only: readonly unknown[] | undefined): Record<string, { label: string; polarity: 'negative' | 'positive' }> {
    const { kinds } = this.deps.settings();
    const out: Record<string, { label: string; polarity: 'negative' | 'positive' }> = {};
    for (const id of Object.keys(kinds)) {
      if (only !== undefined && !only.includes(id)) continue;
      Object.defineProperty(out, id, { value: { label: kinds[id]!.label, polarity: kinds[id]!.polarity }, enumerable: true, configurable: true, writable: true });
    }
    return out;
  }

  private countFor(subject: SubjectId, windowDays: number, kinds: Record<string, { label: string; polarity: 'negative' | 'positive' }>): SignalCount[] {
    if (typeof subject !== 'string' || subject === '') return [];
    const { subjects, store, clock } = this.deps;
    const rows = store.listSignalSources?.(subjects.aliasesOf(subject), clock.now() - windowDays * DAY_MS) ?? [];
    return countSignals(rows, { kinds, canonical: (s) => subjects.canonical(s), windowDays });
  }

  /**
   * Who of these people meets `feeds.queue`, as canonical ids: one grouped store read for all of them. Empty (and no store read) when the
   * feed is off. Never throws.
   */
  boosted(people: readonly SubjectId[]): Set<SubjectId> {
    try {
      const queue = this.deps.settings().feeds.queue;
      if (queue === undefined || !this.supported || !Array.isArray(people)) return new Set();
      const { subjects, store, clock } = this.deps;
      const canon = [...new Set((people as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '').slice(0, BOOSTED_MAX).map((p) => subjects.canonical(p)))];
      if (canon.length === 0) return new Set();
      const ofAlias = new Map<SubjectId, SubjectId>();
      for (const person of canon) for (const alias of subjects.aliasesOf(person)) ofAlias.set(alias, person);
      const rows = store.listSignalSources?.([...ofAlias.keys()], clock.now() - queue.windowDays * DAY_MS) ?? [];
      const byPerson = new Map<SubjectId, typeof rows>();
      for (const row of rows) {
        const person = ofAlias.get(row.subject);
        if (person === undefined) continue;
        const list = byPerson.get(person);
        if (list === undefined) byPerson.set(person, [row]);
        else list.push(row);
      }
      const kinds = this.kindsFor(undefined);
      const out = new Set<SubjectId>();
      for (const [person, list] of byPerson) {
        if (evaluateThreshold(list, { kinds, canonical: (s) => subjects.canonical(s) }, queue).met) out.add(person);
      }
      return out;
    } catch (err) {
      this.readFailed(err);
      return new Set();
    }
  }

  /**
   * The ladder rules (`feeds.ladder`) this person meets, for `suggest`: each as its id, effect and the sentence ("Muted by other players:
   * 5 players in 14 days"). Rows are read once per distinct window. `[]` (and no store read) when the feed is off. Never throws.
   */
  ladderHits(subject: SubjectId): SignalHit[] {
    try {
      const { feeds, kinds } = this.deps.settings();
      const rules = feeds.ladder;
      if (rules === undefined || rules.length === 0 || !this.supported || typeof subject !== 'string' || subject === '') return [];
      const { subjects, store, clock } = this.deps;
      const aliases = subjects.aliasesOf(subject);
      const ctxKinds = this.kindsFor(undefined);
      const byWindow = new Map<number, ReturnType<NonNullable<Store['listSignalSources']>>>();
      const hits: SignalHit[] = [];
      for (const rule of rules) {
        let rows = byWindow.get(rule.windowDays);
        if (rows === undefined) {
          rows = store.listSignalSources?.(aliases, clock.now() - rule.windowDays * DAY_MS) ?? [];
          byWindow.set(rule.windowDays, rows);
        }
        const res = evaluateThreshold(rows, { kinds: ctxKinds, canonical: (s) => subjects.canonical(s) }, rule);
        if (!res.met) continue;
        const labels = rule.kinds.map((k) => kinds[k]?.label ?? k).join(', ');
        const players = `${res.distinct} player${res.distinct === 1 ? '' : 's'}`;
        const days = `${rule.windowDays} day${rule.windowDays === 1 ? '' : 's'}`;
        hits.push({ id: rule.id, effect: rule.effect, text: `${labels}: ${players} in ${days}` });
      }
      return hits;
    } catch (err) {
      this.readFailed(err);
      return [];
    }
  }

  /** The lines the Person page record shows: the `feeds.record` kinds and window. `[]` (and no store read) when the feed is off. Never throws. */
  forRecord(subject: SubjectId): SignalCount[] {
    return this.forFeed(subject, this.deps.settings().feeds.record);
  }

  /** The counts the AI read may be shown: the `feeds.ai` kinds and window. `[]` (and no store read) when the feed is off. Never throws. */
  forAi(subject: SubjectId): SignalCount[] {
    return this.forFeed(subject, this.deps.settings().feeds.ai);
  }

  private forFeed(subject: SubjectId, feed: { kinds: readonly string[] | '*'; windowDays: number } | undefined): SignalCount[] {
    try {
      if (feed === undefined || !this.supported) return [];
      const kinds = this.kindsFor(feed.kinds === '*' ? undefined : feed.kinds);
      return this.countFor(subject, this.windowOf(feed.windowDays), kinds);
    } catch (err) {
      this.readFailed(err);
      return [];
    }
  }
}
