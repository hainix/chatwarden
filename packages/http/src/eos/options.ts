import { isReasonId } from '@chatwarden/core';
import type { Clock, Logger } from '@chatwarden/core';

/** The kinds of sanction that can have an EOS action name. A `note` is never pushed. */
export type EosKind = 'chat' | 'area' | 'ban' | 'warning';

/** Where a kit player stands: the room and the seat, from the adopter's own session table. */
export interface EosSeat {
  roomId: string;
  seatId: string;
}

/** What the adopter gives `eos`. @experimental */
export interface EosOptions {
  /** The EOS deployment id (Developer Portal, Product Settings). */
  deploymentId: string;
  /** The client id of the credentials the adapter uses. No colon. */
  clientId: string;
  /** The client secret. A secret: never logged, never stored, never in an error. */
  clientSecret: string;
  /** Default `https://api.epicgames.dev`. Only for tests: `https`, or `http` on `localhost` and `127.0.0.1`. No credentials, query or fragment. */
  baseUrl?: string;
  /** Push kit sanctions to EOS (design 9.3). */
  sanctions?: {
    /**
     * YOURS: the EOS product user ids of a person, from your own account table. `subject` is the person's canonical staff ref and `aliases` every subject merged into it
     * (the person's own included). The kit stores no product user id. Return one id for each account the person has; an empty list or a throw pushes nothing.
     */
    productUserIdsOf: (subject: string, aliases: readonly string[]) => readonly string[] | Promise<readonly string[]>;
    /** EOS action strings (`A-Z a-z 0-9 _ -`, 1 to 64) for the kinds you want pushed. A kind with no action is not pushed. */
    actions: Partial<Record<EosKind, string>>;
    /** `'ref'` (default) sends "Chatwarden M-7K3Q9, Rule 2" as the justification; `'reason'` sends the moderator's private reason (cut to 2048). */
    justification?: 'ref' | 'reason';
    /** Also push the automatic chat timeouts (30 minutes, noisy). Default false. Needs `actions.chat`. */
    includeAutomatic?: boolean;
  };
  /** Pull EOS player reports into kit reports (design 9.4). */
  reports?: {
    /** YOURS: where an EOS player is seated right now, from your own session table; null when they are not in a room. */
    seatOf: (productUserId: string) => EosSeat | null | Promise<EosSeat | null>;
    /** YOURS: the product user ids of the players to ask about this poll (the players in rooms now). At most 500 are used. */
    players: () => readonly string[] | Promise<readonly string[]>;
    /** EOS reason id (1 to 7) to a kit reason id, or null for "no reason". Merged over the defaults (1 and 2 cheating, 3 and 7 other, 4 harassment, 5 and 6 spam). */
    reasons?: Partial<Record<number, string | null>>;
    /** How often `start()` polls, in milliseconds. Default 60 000. */
    pollMs?: number;
    /** How many players go in one request. Default 20. */
    batch?: number;
    /** The most new reports one poll handles. Default 100. */
    maxPerPoll?: number;
  };
  /** The `fetch` for EOS. Default the global one. */
  fetch?: typeof fetch;
  /** The time source. Default `Date.now`. */
  clock?: Clock;
  /** Jitter source in [0, 1) for the retry backoff. Default `Math.random`. */
  random?: () => number;
  /** Where failures are logged (event names, operations, statuses and error classes only). Defaults to `console.warn`. */
  logger?: Logger;
}

/** The options after checking, copied, with every default filled in. */
export interface ResolvedEosOptions {
  deploymentId: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  sanctions: {
    productUserIdsOf: NonNullable<EosOptions['sanctions']>['productUserIdsOf'];
    actions: ReadonlyMap<EosKind, string>;
    justification: 'ref' | 'reason';
    includeAutomatic: boolean;
  } | null;
  reports: {
    seatOf: NonNullable<EosOptions['reports']>['seatOf'];
    players: NonNullable<EosOptions['reports']>['players'];
    reasons: ReadonlyMap<number, string | null>;
    pollMs: number;
    batch: number;
    maxPerPoll: number;
  } | null;
  fetch: typeof fetch | undefined;
  clock: Clock;
  random: () => number;
  logger: Logger | undefined;
}

const systemClock: Clock = { now: () => Date.now() };
const DEFAULT_BASE_URL = 'https://api.epicgames.dev';
const KINDS: readonly EosKind[] = ['chat', 'area', 'ban', 'warning'];
/** The reasons EOS defines (Player Reports Web APIs, "Get Report Reason Definition"), as the kit's default reason ids. */
const DEFAULT_REASONS: ReadonlyArray<readonly [number, string]> = [
  [1, 'cheating'],
  [2, 'cheating'],
  [3, 'other'],
  [4, 'harassment'],
  [5, 'spam'],
  [6, 'spam'],
  [7, 'other'],
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const inRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const VISIBLE = /^[\x21-\x7e]+$/;
const ACTION_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The base URL as the adapter uses it (no trailing slash), or null when it is not acceptable. */
function checkBaseUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The keys of an object of options, or null when it has one that is not in `allowed`. */
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

/** Check the options once. Every error is a `RangeError` that names the option and never holds its value. */
export function resolveOptions(options: unknown): ResolvedEosOptions {
  if (!isObject(options)) throw new RangeError('eos: options are required');
  // Every field is read exactly once, here.
  const { deploymentId, clientId, clientSecret, baseUrl, sanctions, reports, fetch, clock, random, logger } = options as Partial<EosOptions> & Record<string, unknown>;

  if (typeof deploymentId !== 'string' || deploymentId.length > 128 || !VISIBLE.test(deploymentId)) throw new RangeError('eos: deploymentId must be 1 to 128 visible characters with no space');
  if (typeof clientId !== 'string' || clientId.length > 256 || !VISIBLE.test(clientId) || clientId.includes(':')) throw new RangeError('eos: clientId must be 1 to 256 visible characters with no space and no colon');
  if (typeof clientSecret !== 'string' || clientSecret.length > 512 || !VISIBLE.test(clientSecret)) throw new RangeError('eos: clientSecret must be 1 to 512 visible characters with no space');
  const base = baseUrl === undefined ? DEFAULT_BASE_URL : checkBaseUrl(baseUrl);
  if (base === null) throw new RangeError('eos: baseUrl must be an https URL (or http on localhost or 127.0.0.1) with no credentials, query or fragment');

  let push: ResolvedEosOptions['sanctions'] = null;
  if (sanctions !== undefined) {
    if (!isObject(sanctions)) throw new RangeError('eos: sanctions must be an object');
    if (!onlyKeys(sanctions, ['productUserIdsOf', 'actions', 'justification', 'includeAutomatic'])) throw new RangeError('eos: sanctions has an option that does not exist');
    const { productUserIdsOf, actions, justification, includeAutomatic } = sanctions as Record<string, unknown>;
    if (typeof productUserIdsOf !== 'function') throw new RangeError('eos: sanctions.productUserIdsOf must be a function');
    if (!isObject(actions)) throw new RangeError('eos: sanctions.actions must be an object of EOS action names');
    const map = new Map<EosKind, string>();
    for (const key of Object.keys(actions)) {
      const name = actions[key];
      if (!(KINDS as readonly string[]).includes(key) || typeof name !== 'string' || !ACTION_RE.test(name)) {
        throw new RangeError('eos: sanctions.actions needs chat, area, ban or warning, each an EOS action name of A-Z a-z 0-9 _ - (1 to 64 characters)');
      }
      map.set(key as EosKind, name);
    }
    if (map.size === 0) throw new RangeError('eos: sanctions.actions must name at least one kind');
    if (justification !== undefined && justification !== 'ref' && justification !== 'reason') throw new RangeError("eos: sanctions.justification must be 'ref' or 'reason'");
    if (includeAutomatic !== undefined && typeof includeAutomatic !== 'boolean') throw new RangeError('eos: sanctions.includeAutomatic must be a boolean');
    if (includeAutomatic === true && !map.has('chat')) throw new RangeError('eos: sanctions.includeAutomatic needs sanctions.actions.chat');
    push = { productUserIdsOf: productUserIdsOf as NonNullable<EosOptions['sanctions']>['productUserIdsOf'], actions: map, justification: justification ?? 'ref', includeAutomatic: includeAutomatic ?? false };
  }

  let pull: ResolvedEosOptions['reports'] = null;
  if (reports !== undefined) {
    if (!isObject(reports)) throw new RangeError('eos: reports must be an object');
    if (!onlyKeys(reports, ['seatOf', 'players', 'reasons', 'pollMs', 'batch', 'maxPerPoll'])) throw new RangeError('eos: reports has an option that does not exist');
    const { seatOf, players, reasons, pollMs, batch, maxPerPoll } = reports as Record<string, unknown>;
    if (typeof seatOf !== 'function') throw new RangeError('eos: reports.seatOf must be a function');
    if (typeof players !== 'function') throw new RangeError('eos: reports.players must be a function');
    const map = new Map<number, string | null>(DEFAULT_REASONS);
    if (reasons !== undefined) {
      if (!isObject(reasons)) throw new RangeError('eos: reports.reasons must be an object of EOS reason ids (1 to 7)');
      for (const key of Object.keys(reasons)) {
        const value = reasons[key];
        if (!/^[1-7]$/.test(key) || !(value === null || isReasonId(value))) throw new RangeError('eos: reports.reasons needs an EOS reason id from 1 to 7 and a kit reason id (or null)');
        map.set(Number(key), value);
      }
    }
    if (pollMs !== undefined && !inRange(pollMs, 1000, 86_400_000)) throw new RangeError('eos: reports.pollMs must be a whole number of milliseconds from 1000 to one day');
    if (batch !== undefined && !inRange(batch, 1, 100)) throw new RangeError('eos: reports.batch must be a whole number from 1 to 100');
    if (maxPerPoll !== undefined && !inRange(maxPerPoll, 1, 1000)) throw new RangeError('eos: reports.maxPerPoll must be a whole number from 1 to 1000');
    pull = { seatOf: seatOf as NonNullable<EosOptions['reports']>['seatOf'], players: players as NonNullable<EosOptions['reports']>['players'], reasons: map, pollMs: pollMs ?? 60_000, batch: batch ?? 20, maxPerPoll: maxPerPoll ?? 100 };
  }
  if (push === null && pull === null) throw new RangeError('eos: configure sanctions, reports or both');

  if (fetch !== undefined && typeof fetch !== 'function') throw new RangeError('eos: fetch must be a function');
  if (clock !== undefined && (!isObject(clock) || typeof (clock as Partial<Clock>).now !== 'function')) throw new RangeError('eos: clock must have a now() function');
  if (random !== undefined && typeof random !== 'function') throw new RangeError('eos: random must be a function');
  if (logger !== undefined && (!isObject(logger) || typeof (logger as Partial<Logger>).warn !== 'function')) throw new RangeError('eos: logger must have a warn() function');

  return Object.freeze({
    deploymentId,
    clientId,
    clientSecret,
    baseUrl: base,
    sanctions: push,
    reports: pull,
    fetch,
    clock: (clock as Clock | undefined) ?? systemClock,
    random: random ?? Math.random,
    logger: logger as Logger | undefined,
  });
}
