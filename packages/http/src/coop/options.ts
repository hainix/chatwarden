import { ROLES } from '@chatwarden/core';
import type { Chatwarden, Clock, Logger, Role, StaffReport } from '@chatwarden/core';
import { checkLimit } from '../limiter.js';
import type { NamesRateLimit } from '../limiter.js';
import { resolvePermissions } from '../permissions.js';
import type { PermissionKey, Permissions } from '../permissions.js';
import { ReplayCache } from '../webhooks/sign.js';
import { coopPublicKey } from './verify.js';

/**
 * What a Coop action id means for the kit. The adapter builds the sanction itself, on the report's own target: nothing in a callback chooses the person.
 * `upheld` with `chat`, `area` or `ban` may carry a length (`durationMs`, omitted is permanent: a permanent ban needs the `senior` role unless `permissions` says
 * otherwise); `warning` has none; `noted` records a note and does nothing to the player. @experimental
 */
export type CoopDecision =
  | { verdict: 'upheld'; kind: 'warning' }
  | { verdict: 'upheld'; kind: 'chat' | 'area' | 'ban'; durationMs?: number }
  | { verdict: 'noted' }
  | { verdict: 'no_action' }
  | { verdict: 'bad_faith' };

/** What the adopter gives `coop`. @experimental */
export interface CoopOptions {
  /** Where Coop is: `https`, or `http` on `localhost` and `127.0.0.1` for a local Coop. No credentials, query or fragment. */
  baseUrl: string;
  /** Sent as `X-API-KEY`. A secret: never logged. */
  apiKey: string;
  /** The "Webhook Signature Verification Key" (a public RSA key, PEM) from Coop's Settings, API Keys. */
  webhookPublicKey: string;
  /** Coop item type ids, created in Coop (`setup.checklist()` says how). */
  itemTypes: { user: string; line: string; report: string };
  /** REQUIRED, no default (chat text leaves the kit only where you say so): `'none'` sends the category, rule, severity and room tags only; `'excerpt'` also the report's excerpt lines. */
  evidence: 'none' | 'excerpt';
  /** Send the reporter's note (player text). Default false. */
  includeNote?: boolean;
  /** `'hidden'` (default) labels people `reporter`, `reported`, `other 1`...; `'shown'` also sends each line's handle. */
  handles?: 'hidden' | 'shown';
  /** Outbound: which Coop policy a report is filed under. A reported reason wins over the suggested rule. */
  policies?: { byReason?: Record<string, string>; byRule?: Record<string, string> };
  /** Inbound: Coop action id to the kit decision it means. An id not listed is acknowledged and ignored. */
  actions: Record<string, CoopDecision>;
  /** Inbound: Coop policy id to the Community Rule number it cites. Without one the report's suggested rule is used. */
  rules?: Record<string, number>;
  /** The kit role the callbacks act with, checked against the same permission map as the staff routes. Default `moderator`. */
  role?: Role;
  /** Overrides of the default minimum roles, as for the staff routes (`RangeError` when invalid). */
  permissions?: Partial<Record<PermissionKey, Role | undefined>>;
  /** Coop can send a header you configure on every callback; when set, a callback without it is refused (the same 401). Compared in constant time. */
  callbackAuth?: { header: string; value: string };
  /** `sweep()` looks back this far (milliseconds). Default 24 hours; at most 30 days. */
  catchUpMs?: number;
  /** The kit's AI severity for a report, 0 to 100, riding in the item. A throw or a value that is not a number from 0 to 100 drops the field, never the report. */
  aiSeverity?: (report: StaffReport) => number | undefined | Promise<number | undefined>;
  /** Adds `POST /coop/signal` (design 8.7). `read` is yours: the lines in, a severity from 0 to 100 out. `rateLimit` default 60 a minute. */
  signal?: { secret: string; read: (lines: ReadonlyArray<{ label: string; text: string }>) => number | Promise<number>; rateLimit?: NamesRateLimit; replay?: ReplayCache };
  /** Runs `run` once after `ms` and returns its cancel. Default `setTimeout`, unref'd. For tests (the signal's 8 second limit). */
  schedule?: (run: () => void, ms: number) => () => void;
  /** The `fetch` for Coop. Default the global one. */
  fetch?: typeof fetch;
  /** The time source. Default `Date.now`. */
  clock?: Clock;
  /** Jitter source in [0, 1) for the retry backoff. Default `Math.random`. */
  random?: () => number;
  /** Where failures are logged (event names and error classes only). Defaults to `console.warn`. */
  logger?: Logger;
}

/** The options after checking, copied, with every default filled in. */
export interface ResolvedCoopOptions {
  baseUrl: string;
  apiKey: string;
  webhookPublicKey: string;
  itemTypes: Readonly<{ user: string; line: string; report: string }>;
  evidence: 'none' | 'excerpt';
  includeNote: boolean;
  handles: 'hidden' | 'shown';
  policyByReason: ReadonlyMap<string, string>;
  policyByRule: ReadonlyMap<number, string>;
  actions: ReadonlyMap<string, CoopDecision>;
  rules: ReadonlyMap<string, number>;
  role: Role;
  permissions: Permissions;
  callbackAuth: { header: string; value: string } | null;
  catchUpMs: number;
  aiSeverity: CoopOptions['aiSeverity'];
  signal: { secret: string; read: NonNullable<CoopOptions['signal']>['read']; rateLimit: NamesRateLimit; replay: ReplayCache } | null;
  schedule: (run: () => void, ms: number) => () => void;
  fetch: typeof fetch | undefined;
  clock: Clock;
  random: () => number;
  logger: Logger | undefined;
}

const systemClock: Clock = { now: () => Date.now() };
const DAY_MS = 86_400_000;
const CATCH_UP_MAX_MS = 30 * DAY_MS;
const DEFAULT_SIGNAL_RATE: NamesRateLimit = { max: 60, windowMs: 60_000 };
const MIN_SIGNAL_SECRET = 32;

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
/** An id from Coop or the adopter: 1..128 visible characters, no space. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v);
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const API_KEY_RE = /^[\x21-\x7e]{8,512}$/;
const REASON_RE = /^[\x21-\x7e]{1,64}$/;

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

/** An action's meaning, copied, or null when it is not one of the {@link CoopDecision} shapes (extra keys included). */
function checkDecision(v: unknown): CoopDecision | null {
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  const only = (allowed: readonly string[]): boolean => keys.every((k) => allowed.includes(k));
  switch (v['verdict']) {
    case 'no_action':
    case 'bad_faith':
    case 'noted':
      return only(['verdict']) ? { verdict: v['verdict'] } : null;
    case 'upheld': {
      const kind = v['kind'];
      if (kind === 'warning') return only(['verdict', 'kind']) ? { verdict: 'upheld', kind } : null;
      if (kind !== 'chat' && kind !== 'area' && kind !== 'ban') return null;
      if (!only(['verdict', 'kind', 'durationMs'])) return null;
      const d = v['durationMs'];
      if (d === undefined) return { verdict: 'upheld', kind };
      return isPositiveInt(d) ? { verdict: 'upheld', kind, durationMs: d } : null;
    }
    default:
      return null;
  }
}

/** Check the options once. Every error is a `RangeError` that names the option and never holds its value. */
export function resolveOptions(options: unknown): ResolvedCoopOptions {
  if (!isObject(options)) throw new RangeError('coop: options are required');
  // Every field is read exactly once, here.
  const o = options as Partial<CoopOptions> & Record<string, unknown>;
  const { baseUrl, apiKey, webhookPublicKey, itemTypes, evidence, includeNote, handles, policies, actions, rules, role, permissions, callbackAuth, catchUpMs, aiSeverity, signal, schedule, fetch, clock, random, logger } = o;

  const base = checkBaseUrl(baseUrl);
  if (base === null) throw new RangeError('coop: baseUrl must be an https URL (or http on localhost or 127.0.0.1) with no credentials, query or fragment');
  if (typeof apiKey !== 'string' || !API_KEY_RE.test(apiKey)) throw new RangeError('coop: apiKey must be 8 to 512 visible characters with no space');
  if (coopPublicKey(webhookPublicKey) === null) throw new RangeError('coop: webhookPublicKey must be a public RSA key in PEM form');

  if (!isObject(itemTypes) || !isId(itemTypes['user']) || !isId(itemTypes['line']) || !isId(itemTypes['report'])) {
    throw new RangeError('coop: itemTypes needs the ids user, line and report (1 to 128 visible characters)');
  }
  if (evidence !== 'none' && evidence !== 'excerpt') throw new RangeError("coop: evidence is required and must be 'none' or 'excerpt'");
  if (includeNote !== undefined && typeof includeNote !== 'boolean') throw new RangeError('coop: includeNote must be a boolean');
  if (handles !== undefined && handles !== 'hidden' && handles !== 'shown') throw new RangeError("coop: handles must be 'hidden' or 'shown'");

  const byReason = new Map<string, string>();
  const byRule = new Map<number, string>();
  if (policies !== undefined) {
    if (!isObject(policies) || !Object.keys(policies).every((k) => k === 'byReason' || k === 'byRule')) throw new RangeError('coop: policies may only have byReason and byRule');
    const reasons = policies['byReason'];
    if (reasons !== undefined) {
      if (!isObject(reasons)) throw new RangeError('coop: policies.byReason must be an object of policy ids');
      for (const key of Object.keys(reasons)) {
        const id = reasons[key];
        if (!REASON_RE.test(key) || !isId(id)) throw new RangeError('coop: policies.byReason needs a reason id and a policy id');
        byReason.set(key, id);
      }
    }
    const ruleKeys = policies['byRule'];
    if (ruleKeys !== undefined) {
      if (!isObject(ruleKeys)) throw new RangeError('coop: policies.byRule must be an object of policy ids');
      for (const key of Object.keys(ruleKeys)) {
        const n = Number(key);
        const id = ruleKeys[key];
        if (!/^\d{1,6}$/.test(key) || !isPositiveInt(n) || !isId(id)) throw new RangeError('coop: policies.byRule needs a rule number and a policy id');
        byRule.set(n, id);
      }
    }
  }

  if (!isObject(actions)) throw new RangeError('coop: actions must be an object of Coop action ids');
  const actionMap = new Map<string, CoopDecision>();
  for (const key of Object.keys(actions)) {
    const decision = checkDecision(actions[key]);
    if (!isId(key) || decision === null) throw new RangeError('coop: actions needs a Coop action id and a decision of a known shape');
    actionMap.set(key, decision);
  }

  const ruleMap = new Map<string, number>();
  if (rules !== undefined) {
    if (!isObject(rules)) throw new RangeError('coop: rules must be an object of Community Rule numbers');
    for (const key of Object.keys(rules)) {
      const n = rules[key];
      if (!isId(key) || !isPositiveInt(n)) throw new RangeError('coop: rules needs a Coop policy id and a positive whole rule number');
      ruleMap.set(key, n);
    }
  }

  if (role !== undefined && !(ROLES as readonly unknown[]).includes(role)) throw new RangeError(`coop: role must be one of ${ROLES.join(', ')}`);
  let table: Permissions;
  try {
    table = resolvePermissions(permissions);
  } catch {
    throw new RangeError('coop: permissions is not valid');
  }

  let auth: ResolvedCoopOptions['callbackAuth'] = null;
  if (callbackAuth !== undefined) {
    const h = isObject(callbackAuth) ? callbackAuth['header'] : undefined;
    const v = isObject(callbackAuth) ? callbackAuth['value'] : undefined;
    if (typeof h !== 'string' || !HEADER_RE.test(h) || h.toLowerCase() === 'coop-signature' || typeof v !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(v)) {
      throw new RangeError('coop: callbackAuth needs a header name and a value');
    }
    auth = { header: h.toLowerCase(), value: v };
  }

  if (catchUpMs !== undefined && (!isPositiveInt(catchUpMs) || catchUpMs > CATCH_UP_MAX_MS)) throw new RangeError('coop: catchUpMs must be a whole number of milliseconds from 1 to 30 days');
  if (aiSeverity !== undefined && typeof aiSeverity !== 'function') throw new RangeError('coop: aiSeverity must be a function');

  let sig: ResolvedCoopOptions['signal'] = null;
  if (signal !== undefined) {
    if (!isObject(signal)) throw new RangeError('coop: signal must be an object with secret and read');
    const { secret, read, rateLimit, replay } = signal as NonNullable<CoopOptions['signal']>;
    if (typeof secret !== 'string' || secret.length < MIN_SIGNAL_SECRET) throw new RangeError(`coop: signal.secret must be a string of at least ${MIN_SIGNAL_SECRET} characters`);
    if (typeof read !== 'function') throw new RangeError('coop: signal.read must be a function');
    if (replay !== undefined && !(replay instanceof ReplayCache)) throw new RangeError('coop: signal.replay must be a ReplayCache');
    let limit: NamesRateLimit;
    try {
      limit = checkLimit(rateLimit, DEFAULT_SIGNAL_RATE, 'coop: signal.rateLimit');
    } catch {
      throw new RangeError('coop: signal.rateLimit needs a positive whole max and windowMs');
    }
    sig = { secret, read, rateLimit: limit, replay: replay ?? new ReplayCache() };
  }

  if (schedule !== undefined && typeof schedule !== 'function') throw new RangeError('coop: schedule must be a function');
  if (fetch !== undefined && typeof fetch !== 'function') throw new RangeError('coop: fetch must be a function');
  if (clock !== undefined && (!isObject(clock) || typeof (clock as Partial<Clock>).now !== 'function')) throw new RangeError('coop: clock must have a now() function');
  if (random !== undefined && typeof random !== 'function') throw new RangeError('coop: random must be a function');
  if (logger !== undefined && (!isObject(logger) || typeof (logger as Partial<Logger>).warn !== 'function')) throw new RangeError('coop: logger must have a warn() function');

  return Object.freeze({
    baseUrl: base,
    apiKey,
    webhookPublicKey: webhookPublicKey as string,
    itemTypes: Object.freeze({ user: itemTypes['user'], line: itemTypes['line'], report: itemTypes['report'] }),
    evidence,
    includeNote: includeNote ?? false,
    handles: handles ?? 'hidden',
    policyByReason: byReason,
    policyByRule: byRule,
    actions: actionMap,
    rules: ruleMap,
    role: role ?? 'moderator',
    permissions: table,
    callbackAuth: auth,
    catchUpMs: catchUpMs ?? DAY_MS,
    aiSeverity,
    signal: sig,
    schedule: schedule ?? defaultSchedule,
    fetch,
    clock: (clock as Clock | undefined) ?? systemClock,
    random: random ?? Math.random,
    logger: logger as Logger | undefined,
  });
}

/** The kit's read-only view the pure mappers need: the rules and the profile's reasons. */
export type KitView = Pick<Chatwarden, 'rules' | 'profile'>;
