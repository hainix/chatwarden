import { deepFreeze } from './freeze.js';
import { ProfileError } from './profileError.js';
import type { RawWho, SubjectId } from './types.js';

// Signals: what a game records about a player (muted by others, kicked, left mid-game), declared in code, counted by distinct source and
// read by three feeds only because a profile rule says so. A signal never acts. This file has the declarations and their validation
// (`kinds`, `guards`, `feeds`) and the shapes the rest of the feature shares; counting is signalCounts.ts, the store is types.ts.
//
// Kind ids are the adopter's strings, so every lookup here uses OWN properties only: `constructor` and `toString` never resolve from
// the prototype. Nothing a validator throws echoes a value.

const DAY_MS = 86_400_000;

export type SignalPolarity = 'negative' | 'positive';

/**
 * One kind a game declares. The key in `kinds` is the id the game passes to `record`.
 * @experimental
 */
export interface SignalKindSpec {
  /** What staff read: "Muted by other players". Plain text, 1 to 60 characters, no markup. Also the label the AI feed sends. */
  label: string;
  polarity: SignalPolarity;
  /** Default weight of one source, 0 to 10, default 1. A record may override it per call. */
  weight?: number;
}

/** @experimental */
export interface SignalGuards {
  /** At most one row per (kind, subject, source) per this many ms. Default 86 400 000 (one day). 60 000 to 30 days. */
  perByWindowMs?: number;
  /** Used ONLY when the adopter supplies `signals.accountAgeDays` to createChatwarden. Default: not set (no weighting). */
  newAccount?: { belowDays: number; factor: number } | null;
}

/**
 * One threshold, over distinct sources, in a window.
 * @experimental
 */
export interface SignalThreshold {
  /** Declared kinds, 1 to 8. */
  kinds: string[];
  /** 1 to 50 distinct sources with weight above 0. */
  minDistinct: number;
  /** 1 to 90, and not above retention.signalsMs. */
  windowDays: number;
  /** The sum of those sources' weights must also reach this. */
  minWeight?: number;
}

/**
 * The feeds. Absent means that feed is off.
 * @experimental
 */
export interface SignalFeeds {
  /** Lines on the Person page record. `'*'` means every declared kind. */
  record?: { kinds: string[] | '*'; windowDays: number };
  /** Queue ordering: a person who meets the threshold ranks ahead of older ordinary cases, capped. Negative kinds only. */
  queue?: SignalThreshold;
  /** The ladder. `note` adds a sentence to the suggestion; `raise` moves it up one step. `raise` takes negative kinds only. */
  ladder?: Array<SignalThreshold & { id: string; effect: 'note' | 'raise' }>;
  /** The AI read's case context. */
  ai?: { kinds: string[] | '*'; windowDays: number };
}

/** @experimental */
export interface SignalSettings {
  /** Code only. */
  kinds?: Record<string, SignalKindSpec>;
  /** Code only. */
  guards?: SignalGuards;
  /** Editable in the hub. */
  feeds?: SignalFeeds;
}

/** The kind with every field filled in. */
export interface ResolvedSignalKind {
  label: string;
  polarity: SignalPolarity;
  weight: number;
}

/** The guards with every field filled in; `newAccount` is null when not set. */
export interface ResolvedSignalGuards {
  perByWindowMs: number;
  newAccount: { belowDays: number; factor: number } | null;
}

/**
 * What the kit reads: the declared kinds merged over the built-ins, the guards filled in, the feeds as given. Look kinds up with
 * {@link kindSpecOf}, never with `kinds[id]`.
 * @experimental
 */
export interface ResolvedSignals {
  kinds: Readonly<Record<string, ResolvedSignalKind>>;
  guards: ResolvedSignalGuards;
  feeds: SignalFeeds;
}

/** Who a signal is about or from: a staff-side subject id (`cw.rooms.subjectAt`), or the raw identity the game already passes to the doors. */
export type SignalParty = SubjectId | RawWho;

/** @experimental */
export interface SignalInput {
  /** A declared kind (or a built-in). */
  kind: string;
  /** Whom it is about. */
  subject: SignalParty;
  /** Who produced it (the player who muted, the player who left). Omit (or `null`) for a source the game itself is, such as a timeout. */
  by?: SignalParty | null;
  /** The game's own room id: 1 to 64 characters of A-Z a-z 0-9 _ . : - . Not player text. `null` is the same as leaving it out. */
  roomId?: string | null;
  /** When it happened, epoch ms. Default: now (also for `null`). Not more than 5 minutes ahead, not older than retention.signalsMs. */
  at?: number | null;
  /** Overrides the kind's default weight for this one record. 0 to 10. */
  weight?: number;
}

/** @experimental */
export interface SignalCount {
  kind: string;
  label: string;
  polarity: SignalPolarity;
  /** Distinct sources with weight above 0 in the window. */
  distinct: number;
  /** The sum of those sources' weights. */
  weight: number;
  windowDays: number;
  firstAt: number;
  lastAt: number;
}

/** @experimental */
export interface SignalKindView {
  kind: string;
  label: string;
  polarity: SignalPolarity;
  weight: number;
  builtin: boolean;
}

/**
 * Kinds the kit declares itself. An adopter may relabel or re-weight one by declaring the same key; the polarity must stay negative.
 * @experimental
 */
export const BUILTIN_SIGNAL_KINDS: Readonly<Record<'flood_triggered', Readonly<SignalKindSpec>>> = deepFreeze({
  flood_triggered: { label: 'Flooded the chat', polarity: 'negative' as const },
});

/** A kind id: a lower-case slug. */
export const SIGNAL_KIND_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
/** The most kinds a game may declare. */
export const SIGNAL_KINDS_MAX = 40;
/** The longest window a feed may name, in days. */
export const SIGNAL_WINDOW_DAYS_MAX = 90;

const LABEL_MAX = 60;
const WEIGHT_MAX = 10;
const THRESHOLD_KINDS_MAX = 8;
const MIN_DISTINCT_MAX = 50;
const MIN_WEIGHT_MAX = MIN_DISTINCT_MAX * WEIGHT_MAX;
const LADDER_RULES_MAX = 20;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PER_BY_MIN_MS = 60_000;
const PER_BY_MAX_MS = 30 * DAY_MS;
const PER_BY_DEFAULT_MS = DAY_MS;
const NEW_ACCOUNT_DAYS_MAX = 365;
const BUILTIN_IDS: readonly string[] = Object.keys(BUILTIN_SIGNAL_KINDS);

const KIND_KEYS: readonly string[] = ['label', 'polarity', 'weight'];
const GUARD_KEYS: readonly string[] = ['perByWindowMs', 'newAccount'];
const NEW_ACCOUNT_KEYS: readonly string[] = ['belowDays', 'factor'];
const SETTINGS_KEYS: readonly string[] = ['kinds', 'guards', 'feeds'];
/** The feeds, in the order a settings screen lists them. */
export const SIGNAL_FEED_NAMES: readonly string[] = ['record', 'queue', 'ladder', 'ai'];
const THRESHOLD_KEYS: readonly string[] = ['kinds', 'minDistinct', 'windowDays', 'minWeight'];
const RULE_KEYS: readonly string[] = ['id', 'effect', ...THRESHOLD_KEYS];
const WINDOW_FEED_KEYS: readonly string[] = ['kinds', 'windowDays'];

function fail(path: string, reason: string, code?: SignalDropReason): never {
  throw new ProfileError(path, reason, code);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own value, or undefined. A key left out and an inherited property both read as "not given". */
function given(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty, so a `__proto__` key becomes a plain own key.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'is not a known setting');
}

/**
 * The declared spec of a kind, from the kinds `resolveSignals` returned, or undefined. Reads own properties only, so `constructor`,
 * `toString` and `__proto__` are never found unless a game declared them.
 */
export function kindSpecOf(kinds: Readonly<Record<string, ResolvedSignalKind>>, id: string): ResolvedSignalKind | undefined {
  return typeof id === 'string' && Object.hasOwn(kinds, id) ? kinds[id] : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Kinds and guards

function whole(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

/** Plain text on one line: no angle brackets (markup) and no control characters. */
function plainLabel(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= LABEL_MAX && v.trim() !== '' && !/[<>\p{C}\p{Zl}\p{Zp}]/u.test(v);
}

function kindSpec(id: string, v: unknown, path: string): ResolvedSignalKind {
  if (!isPlain(v)) return fail(path, 'must be an object with a label and a polarity');
  onlyKeys(v, KIND_KEYS, path);
  const label = given(v, 'label');
  if (!plainLabel(label)) fail(`${path}.label`, `must be plain text of 1 to ${LABEL_MAX} characters, on one line, with no markup`);
  const polarity = given(v, 'polarity');
  if (polarity !== 'negative' && polarity !== 'positive') fail(`${path}.polarity`, "must be 'negative' or 'positive'");
  if (BUILTIN_IDS.includes(id) && polarity !== 'negative') fail(`${path}.polarity`, "must stay 'negative': the kit records this kind itself");
  const weight = given(v, 'weight');
  if (weight !== undefined && !(typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= WEIGHT_MAX)) {
    fail(`${path}.weight`, `must be a number from 0 to ${WEIGHT_MAX}`);
  }
  return { label, polarity, weight: weight ?? 1 };
}

function resolveKinds(v: unknown, path: string): Record<string, ResolvedSignalKind> {
  // No prototype, so a plain `kinds['constructor']` finds nothing unless a game declared it.
  const out: Record<string, ResolvedSignalKind> = Object.create(null) as Record<string, ResolvedSignalKind>;
  for (const id of BUILTIN_IDS) {
    const b = BUILTIN_SIGNAL_KINDS[id as 'flood_triggered'];
    setOwn(out, id, { label: b.label, polarity: b.polarity, weight: 1 });
  }
  if (v === undefined) return out;
  if (!isPlain(v)) return fail(path, 'must be an object of kinds');
  const ids = Object.keys(v);
  if (ids.length > SIGNAL_KINDS_MAX) fail(path, `must declare at most ${SIGNAL_KINDS_MAX} kinds`);
  for (const id of ids) {
    if (!SIGNAL_KIND_PATTERN.test(id)) fail(path, 'has a kind id that is not a lower-case slug of 1 to 40 letters, digits and _, starting with a letter');
  }
  for (const id of ids) setOwn(out, id, kindSpec(id, v[id], `${path}.${id}`));
  return out;
}

function resolveGuards(v: unknown, path: string): ResolvedSignalGuards {
  if (v === undefined) return { perByWindowMs: PER_BY_DEFAULT_MS, newAccount: null };
  if (!isPlain(v)) return fail(path, 'must be an object');
  onlyKeys(v, GUARD_KEYS, path);
  const per = given(v, 'perByWindowMs');
  if (per !== undefined && !whole(per, PER_BY_MIN_MS, PER_BY_MAX_MS)) {
    fail(`${path}.perByWindowMs`, `must be a whole number of milliseconds from ${PER_BY_MIN_MS} to ${PER_BY_MAX_MS}`);
  }
  const na = given(v, 'newAccount');
  let newAccount: ResolvedSignalGuards['newAccount'] = null;
  if (na !== undefined && na !== null) {
    const p = `${path}.newAccount`;
    if (!isPlain(na)) return fail(p, 'must be an object with belowDays and factor, or null');
    onlyKeys(na, NEW_ACCOUNT_KEYS, p);
    const belowDays = given(na, 'belowDays');
    if (!whole(belowDays, 1, NEW_ACCOUNT_DAYS_MAX)) fail(`${p}.belowDays`, `must be a whole number of days from 1 to ${NEW_ACCOUNT_DAYS_MAX}`);
    const factor = given(na, 'factor');
    if (!(typeof factor === 'number' && Number.isFinite(factor) && factor > 0 && factor <= 1)) fail(`${p}.factor`, 'must be a number above 0 and at most 1');
    newAccount = { belowDays, factor };
  }
  return { perByWindowMs: per ?? PER_BY_DEFAULT_MS, newAccount };
}

// ---------------------------------------------------------------------------------------------------------------
// Feeds

interface FeedContext {
  kinds: Readonly<Record<string, ResolvedSignalKind>>;
  signalsMs: number;
}

function windowDays(v: unknown, path: string, ctx: FeedContext): void {
  if (!whole(v, 1, SIGNAL_WINDOW_DAYS_MAX)) fail(path, `must be a whole number of days from 1 to ${SIGNAL_WINDOW_DAYS_MAX}`, 'window');
  if (v * DAY_MS > ctx.signalsMs) fail(path, 'must not be longer than retention.signalsMs: rows older than that are deleted, so the window could never be met', 'window');
}

/** A list of declared kinds: 1 to `max`, each declared, no repeats; `negativeOnly` also refuses a positive kind. */
function kindList(v: unknown, path: string, ctx: FeedContext, max: number, negativeOnly: boolean): void {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) fail(path, `must list 1 to ${max} declared kinds`);
  const seen = new Set<string>();
  v.forEach((id: unknown, i) => {
    const p = `${path}[${i}]`;
    const spec = typeof id === 'string' ? kindSpecOf(ctx.kinds, id) : undefined;
    if (spec === undefined) fail(p, 'is not a kind this game declared', 'unknown_kind');
    if (negativeOnly && spec.polarity !== 'negative') fail(p, 'is a positive kind: positive kinds may inform but never raise or boost', 'positive_kind');
    if (seen.has(id as string)) fail(p, 'is listed twice');
    seen.add(id as string);
  });
}

function windowFeed(v: unknown, path: string, ctx: FeedContext): void {
  if (!isPlain(v)) return fail(path, 'must be an object with kinds and windowDays');
  onlyKeys(v, WINDOW_FEED_KEYS, path);
  const kinds = given(v, 'kinds');
  if (kinds === undefined) fail(`${path}.kinds`, 'is required');
  if (kinds !== '*') kindList(kinds, `${path}.kinds`, ctx, SIGNAL_KINDS_MAX + 1, false);
  const days = given(v, 'windowDays');
  if (days === undefined) fail(`${path}.windowDays`, 'is required');
  windowDays(days, `${path}.windowDays`, ctx);
}

function threshold(v: Record<string, unknown>, path: string, ctx: FeedContext, negativeOnly: boolean): void {
  if (given(v, 'kinds') === undefined) fail(`${path}.kinds`, 'is required');
  kindList(v['kinds'], `${path}.kinds`, ctx, THRESHOLD_KINDS_MAX, negativeOnly);
  const minDistinct = given(v, 'minDistinct');
  if (minDistinct === undefined) fail(`${path}.minDistinct`, 'is required');
  if (!whole(minDistinct, 1, MIN_DISTINCT_MAX)) fail(`${path}.minDistinct`, `must be a whole number from 1 to ${MIN_DISTINCT_MAX}`);
  const days = given(v, 'windowDays');
  if (days === undefined) fail(`${path}.windowDays`, 'is required');
  windowDays(days, `${path}.windowDays`, ctx);
  const minWeight = given(v, 'minWeight');
  if (minWeight !== undefined && !(typeof minWeight === 'number' && Number.isFinite(minWeight) && minWeight > 0 && minWeight <= MIN_WEIGHT_MAX)) {
    fail(`${path}.minWeight`, `must be a number above 0 and at most ${MIN_WEIGHT_MAX}`);
  }
}

function queueFeed(v: unknown, path: string, ctx: FeedContext): void {
  if (!isPlain(v)) return fail(path, 'must be an object with kinds, minDistinct and windowDays');
  onlyKeys(v, THRESHOLD_KEYS, path);
  threshold(v, path, ctx, true);
}

function ladderRule(v: unknown, path: string, ctx: FeedContext): string {
  if (!isPlain(v)) return fail(path, 'must be an object with an id, an effect and a threshold');
  onlyKeys(v, RULE_KEYS, path);
  const id = given(v, 'id');
  if (typeof id !== 'string' || !RULE_ID_PATTERN.test(id)) fail(`${path}.id`, 'must be a lower-case id of 1 to 40 letters, digits, - and _');
  const effect = given(v, 'effect');
  if (effect !== 'note' && effect !== 'raise') fail(`${path}.effect`, "must be 'note' or 'raise'");
  threshold(v, path, ctx, effect === 'raise');
  return id;
}

function ladderFeed(v: unknown, path: string, ctx: FeedContext): void {
  if (!Array.isArray(v)) return fail(path, 'must be a list of rules');
  if (v.length > LADDER_RULES_MAX) fail(path, `must list at most ${LADDER_RULES_MAX} rules`);
  const ids = new Set<string>();
  v.forEach((rule: unknown, i) => {
    const id = ladderRule(rule, `${path}[${i}]`, ctx);
    if (ids.has(id)) fail(`${path}[${i}].id`, 'is used by another rule');
    ids.add(id);
  });
}

/**
 * Check the feeds against the declared `kinds` and `opts.signalsMs` (the retention of signal rows, ms), throwing {@link ProfileError}
 * whose path starts with `path` (`path.queue.kinds[0]`). A feed names declared kinds only; `queue` and a `raise` rule name negative
 * kinds only; a count and a window are in range; a window is not longer than `signalsMs` (rows older than that are gone) or 90 days.
 * @experimental
 */
export function checkSignalFeeds(
  feeds: SignalFeeds | undefined,
  kinds: Readonly<Record<string, ResolvedSignalKind>>,
  opts: { signalsMs: number },
  path: string,
): void {
  if (feeds === undefined) return;
  if (!isPlain(feeds)) return fail(path, 'must be an object');
  onlyKeys(feeds, SIGNAL_FEED_NAMES, path);
  const ctx: FeedContext = { kinds, signalsMs: opts.signalsMs };
  for (const name of SIGNAL_FEED_NAMES) {
    const feed = given(feeds, name);
    if (feed === undefined) continue;
    const p = `${path}.${name}`;
    if (name === 'record' || name === 'ai') windowFeed(feed, p, ctx);
    else if (name === 'queue') queueFeed(feed, p, ctx);
    else ladderFeed(feed, p, ctx);
  }
}

/** Why a stored feed was dropped: a code, never a value. */
export type SignalDropReason = 'unknown_feed' | 'unknown_kind' | 'positive_kind' | 'window' | 'invalid';

/** The code for a failed check: the code the check itself put on its error (never the wording of a message), else `invalid`. */
function dropReason(err: unknown): SignalDropReason {
  const code = err instanceof ProfileError ? err.code : undefined;
  return code === 'unknown_kind' || code === 'positive_kind' || code === 'window' ? code : 'invalid';
}

/**
 * The feeds minus anything that can no longer be used: a feed (or a ladder rule) naming a kind the code stopped declaring, a positive
 * kind where only negative ones are allowed, a window longer than `opts.signalsMs` or 90 days, or any other shape the checks refuse.
 * Applied to a STORED layer at start-up, so one stale feed is dropped on its own and the rest of the layer (the ladder edits too) stays
 * in force. Never throws: garbage in gives `{}`. `opts.onDrop` is told the name of each feed that lost something, once per feed, with
 * the reason code of the first thing lost (a name that is not one of the four feeds is passed as it was stored, with `unknown_feed`: do
 * not log it). The result passes {@link checkSignalFeeds}.
 * @experimental
 */
export function pruneSignalFeeds(
  feeds: unknown,
  kinds: Readonly<Record<string, ResolvedSignalKind>>,
  opts: { signalsMs: number; onDrop?: (feed: string, reason: SignalDropReason) => void },
): SignalFeeds {
  const out: Record<string, unknown> = {};
  if (!isPlain(feeds)) return out as SignalFeeds;
  const ctx = { signalsMs: opts.signalsMs };
  const drop = (name: string, reason: SignalDropReason): void => {
    try {
      opts.onDrop?.(name, reason);
    } catch {
      // A broken callback must not stop the prune.
    }
  };
  /** Null when the feed is usable, else the reason it is not. */
  const unusable = (name: string, value: unknown): SignalDropReason | null => {
    try {
      checkSignalFeeds({ [name]: value } as SignalFeeds, kinds, ctx, 'feeds');
      return null;
    } catch (err) {
      return dropReason(err);
    }
  };
  for (const name of Object.keys(feeds)) {
    const value = feeds[name];
    if (!SIGNAL_FEED_NAMES.includes(name)) {
      drop(name, 'unknown_feed');
      continue;
    }
    if (name !== 'ladder') {
      const why = unusable(name, value);
      if (why === null) setOwn(out, name, JSON.parse(JSON.stringify(value)));
      else drop(name, why);
      continue;
    }
    if (!Array.isArray(value)) {
      drop(name, 'invalid');
      continue;
    }
    const kept: unknown[] = [];
    const ids = new Set<string>();
    let lost: SignalDropReason | null = value.length > LADDER_RULES_MAX ? 'invalid' : null;
    for (const rule of value.slice(0, LADDER_RULES_MAX)) {
      const id = isPlain(rule) && typeof rule['id'] === 'string' ? rule['id'] : null;
      const why = id === null || ids.has(id) ? 'invalid' : unusable(name, [rule]);
      if (why === null) {
        ids.add(id!);
        kept.push(JSON.parse(JSON.stringify(rule)));
      } else lost ??= why;
    }
    if (lost !== null) drop(name, lost);
    if (kept.length > 0) setOwn(out, name, kept);
  }
  return out as SignalFeeds;
}

// ---------------------------------------------------------------------------------------------------------------

/** A deep copy of validated feeds (plain data: strings, numbers, arrays and objects). */
function copyFeeds(feeds: SignalFeeds): SignalFeeds {
  return JSON.parse(JSON.stringify(feeds)) as SignalFeeds;
}

/**
 * Validate the `signals` section and fill it in: the declared kinds merged over the built-ins, the guards with their defaults, the
 * feeds as given. Throws {@link ProfileError} naming the field (`signals.kinds.x.label`), never echoing the value. The feeds are
 * checked against the declared kinds and the 90 day cap here; the cross-check with `retention.signalsMs` is {@link checkSignalFeeds}'s
 * job, called where the retention is known. The result shares nothing with the input, and resolving it again gives the same value.
 * @experimental
 */
export function resolveSignals(input: SignalSettings | undefined, path = 'signals'): ResolvedSignals {
  if (input === undefined) return { kinds: resolveKinds(undefined, `${path}.kinds`), guards: resolveGuards(undefined, `${path}.guards`), feeds: {} };
  if (!isPlain(input)) return fail(path, 'must be an object');
  onlyKeys(input, SETTINGS_KEYS, path);
  const kinds = resolveKinds(given(input, 'kinds'), `${path}.kinds`);
  const guards = resolveGuards(given(input, 'guards'), `${path}.guards`);
  const feeds = given(input, 'feeds') as SignalFeeds | undefined;
  checkSignalFeeds(feeds, kinds, { signalsMs: Infinity }, `${path}.feeds`);
  return { kinds, guards, feeds: feeds === undefined ? {} : copyFeeds(feeds) };
}
