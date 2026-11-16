import { ROLES } from '@chatwarden/core';
import type { Clock, Logger, Role } from '@chatwarden/core';
import { checkLimit } from '../limiter.js';
import type { NamesRateLimit } from '../limiter.js';
import { resolvePermissions } from '../permissions.js';
import type { PermissionKey, Permissions } from '../permissions.js';
import { ReplayCache } from '../webhooks/sign.js';
import type { DiscordRoleMap } from './types.js';
import { DEFAULT_TOLERANCE_MS, publicKeyOf } from './verify.js';

/** What the adopter gives `discordBot`. */
export interface DiscordBotOptions {
  /** The Discord application id (a snowflake: 17 to 20 digits). */
  applicationId: string;
  /** The application's Ed25519 public key: 64 hex characters, from the Developer Portal (it is not a secret). */
  publicKey: string;
  /** The one server this kit serves; an interaction from any other is refused. A snowflake. */
  guildId: string;
  /** The Discord role ids behind each kit role. At least one id overall, each a snowflake. A member's kit role is the highest one they hold an id of. */
  roles: Partial<Record<Role, readonly string[]>>;
  /** Where staff land: a URL in your moderator hub for a report or a person. A throw or a value that is not an http(s) URL drops that link only. */
  hubLink: (kind: 'report' | 'person', id: string) => string;
  /**
   * "Act from Discord". Omit it and the bot answers `/chatwarden lookup` only. With it, a report post gets the buttons (through `bot.components`):
   * `dismiss` (default true) and `suggestion` (default true) say which; `confirm` (default true) puts a confirm step before the decision.
   */
  actions?: { dismiss?: boolean; suggestion?: boolean; confirm?: boolean };
  /** Overrides of the default minimum roles, validated as for the staff routes (`RangeError`). */
  permissions?: Partial<Record<PermissionKey, Role | undefined>>;
  /** Map a Discord user id to a hub login, so a moderator's own claim does not block them. An invalid answer or a throw falls back to `discord:<id>`. */
  actorOf?: (discordUserId: string) => string | undefined;
  /** Per Discord user. Default `{ max: 20, windowMs: 60_000 }`. */
  rateLimit?: NamesRateLimit;
  /** How far a signed timestamp may be from the clock, either way. Default 300 000 (5 minutes). */
  timestampToleranceMs?: number;
  /** How long work may take before the bot answers "deferred" (Discord's deadline is 3 000 ms). Default 2 500. */
  respondWithinMs?: number;
  /** The replay memory. Default a new `ReplayCache`. */
  replay?: ReplayCache;
  /** The `fetch` for the one deferred follow-up. Default the global one. */
  fetch?: typeof fetch;
  /** The time source. Default `Date.now`. */
  clock?: Clock;
  /** Where failures are logged (event names and error classes only). Defaults to `console.warn`. */
  logger?: Logger;
}

/** The options after checking, copied, with every default filled in. */
export interface ResolvedBotOptions {
  applicationId: string;
  publicKey: string;
  guildId: string;
  roles: DiscordRoleMap;
  hubLink: DiscordBotOptions['hubLink'];
  actions: { dismiss: boolean; suggestion: boolean; confirm: boolean } | null;
  permissions: Permissions;
  actorOf: ((discordUserId: string) => string | undefined) | undefined;
  rateLimit: NamesRateLimit;
  timestampToleranceMs: number;
  respondWithinMs: number;
  replay: ReplayCache;
  fetch: typeof fetch | undefined;
  clock: Clock;
  logger: Logger | undefined;
}

const systemClock: Clock = { now: () => Date.now() };
const DEFAULT_RATE: NamesRateLimit = { max: 20, windowMs: 60_000 };
const DEFAULT_RESPOND_MS = 2500;
/** Discord's own deadline for the first answer. */
const DISCORD_DEADLINE_MS = 3000;
const TOLERANCE_MAX_MS = 3_600_000;
const ACTION_KEYS = ['dismiss', 'suggestion', 'confirm'] as const;

const isSnowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{17,20}$/.test(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Check the options once. Every error is a `RangeError` that names the option and never its value. */
export function resolveOptions(options: unknown): ResolvedBotOptions {
  if (!isObject(options)) throw new RangeError('discordBot: options are required');
  // Every field is read exactly once, here.
  const { applicationId, publicKey, guildId, roles, hubLink, actions, permissions, actorOf, rateLimit, timestampToleranceMs, respondWithinMs, replay, fetch, clock, logger } =
    options as unknown as Partial<DiscordBotOptions> & Record<string, unknown>;

  if (!isSnowflake(applicationId)) throw new RangeError('discordBot: applicationId must be a Discord id (17 to 20 digits)');
  if (publicKeyOf(publicKey) === null) throw new RangeError('discordBot: publicKey must be 64 hex characters');
  if (!isSnowflake(guildId)) throw new RangeError('discordBot: guildId must be a Discord id (17 to 20 digits)');

  if (!isObject(roles)) throw new RangeError('discordBot: roles must be an object of Discord role ids per kit role');
  const copied: Partial<Record<Role, readonly string[]>> = {};
  let total = 0;
  for (const key of Object.keys(roles)) {
    if (!(ROLES as readonly string[]).includes(key)) throw new RangeError(`discordBot: roles may only name the kit roles ${ROLES.join(', ')}`);
    const ids = (roles as Record<string, unknown>)[key];
    if (!Array.isArray(ids) || !ids.every(isSnowflake)) throw new RangeError('discordBot: every role id must be a Discord id (17 to 20 digits)');
    total += ids.length;
    copied[key as Role] = Object.freeze([...(ids as string[])]);
  }
  if (total < 1) throw new RangeError('discordBot: roles needs at least one Discord role id');

  if (typeof hubLink !== 'function') throw new RangeError('discordBot: hubLink must be a function');

  let acts: ResolvedBotOptions['actions'] = null;
  if (actions !== undefined) {
    if (!isObject(actions)) throw new RangeError('discordBot: actions must be an object');
    for (const key of Object.keys(actions)) if (!(ACTION_KEYS as readonly string[]).includes(key)) throw new RangeError('discordBot: actions has an unknown key');
    for (const key of ACTION_KEYS) {
      const v = actions[key];
      if (v !== undefined && typeof v !== 'boolean') throw new RangeError(`discordBot: actions.${key} must be a boolean`);
    }
    acts = { dismiss: actions.dismiss !== false, suggestion: actions.suggestion !== false, confirm: actions.confirm !== false };
  }

  let table: Permissions;
  try {
    table = resolvePermissions(permissions);
  } catch {
    throw new RangeError('discordBot: permissions is not valid');
  }

  if (actorOf !== undefined && typeof actorOf !== 'function') throw new RangeError('discordBot: actorOf must be a function');

  let limit: NamesRateLimit;
  try {
    limit = checkLimit(rateLimit, DEFAULT_RATE, 'discordBot: rateLimit');
  } catch {
    throw new RangeError('discordBot: rateLimit needs a positive whole max and windowMs');
  }

  if (timestampToleranceMs !== undefined && (!isPositiveInt(timestampToleranceMs) || timestampToleranceMs > TOLERANCE_MAX_MS)) {
    throw new RangeError('discordBot: timestampToleranceMs must be a whole number of milliseconds from 1 to 3600000');
  }
  if (respondWithinMs !== undefined && (!isPositiveInt(respondWithinMs) || respondWithinMs >= DISCORD_DEADLINE_MS)) {
    throw new RangeError('discordBot: respondWithinMs must be a whole number of milliseconds under 3000');
  }
  if (replay !== undefined && !(replay instanceof ReplayCache)) throw new RangeError('discordBot: replay must be a ReplayCache');
  if (fetch !== undefined && typeof fetch !== 'function') throw new RangeError('discordBot: fetch must be a function');
  if (clock !== undefined && (!isObject(clock) || typeof clock.now !== 'function')) throw new RangeError('discordBot: clock must have a now() function');
  if (logger !== undefined && (!isObject(logger) || typeof logger.warn !== 'function')) throw new RangeError('discordBot: logger must have a warn() function');

  return {
    applicationId,
    publicKey: publicKey as string,
    guildId,
    roles: Object.freeze(copied),
    hubLink,
    actions: acts,
    permissions: table,
    actorOf,
    rateLimit: limit,
    timestampToleranceMs: timestampToleranceMs ?? DEFAULT_TOLERANCE_MS,
    respondWithinMs: respondWithinMs ?? DEFAULT_RESPOND_MS,
    replay: replay ?? new ReplayCache(),
    fetch,
    clock: (clock as Clock | undefined) ?? systemClock,
    logger: logger as Logger | undefined,
  };
}
