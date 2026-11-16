import { describe, expect, it } from 'vitest';
import { discordBot } from '../src/discord/index.js';
import type { DiscordBotOptions } from '../src/discord/index.js';
import { ReplayCache } from '../src/webhooks/sign.js';
import { APP_ID, GUILD_ID, ROLE_MOD, ROLE_OWNER, ROLE_SENIOR, newPair } from './discord-world.js';
import { world } from './world.js';

// Construction checks (K5 D3): every bad option is a RangeError that names the option and never the value.

const KEY = newPair().publicKeyHex;
const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${id}`;
const good = (): DiscordBotOptions => ({
  applicationId: APP_ID,
  publicKey: KEY,
  guildId: GUILD_ID,
  roles: { moderator: [ROLE_MOD], senior: [ROLE_SENIOR], owner: [ROLE_OWNER] },
  hubLink,
});

const SECRET_VALUE = 'zorbak-secret-value-vlemmo';

const build = async (over: Record<string, unknown>) => {
  const w = await world();
  return () => discordBot(w.cw, { ...good(), ...over } as never);
};

describe('options', () => {
  it('accepts the minimal options and the full set', async () => {
    const w = await world();
    expect(() => discordBot(w.cw, good())).not.toThrow();
    expect(() =>
      discordBot(w.cw, {
        ...good(),
        actions: { dismiss: true, suggestion: false, confirm: false },
        permissions: { 'history.read': 'senior' },
        actorOf: () => 'login',
        rateLimit: { max: 5, windowMs: 1000 },
        timestampToleranceMs: 60_000,
        respondWithinMs: 1000,
        replay: new ReplayCache(),
        fetch: (() => Promise.reject(new Error('no network'))) as never,
        clock: { now: () => 1 },
        logger: { warn: () => undefined },
      }),
    ).not.toThrow();
  });

  it.each([
    ['a missing applicationId', { applicationId: undefined }],
    ['an applicationId that is not digits', { applicationId: 'app' }],
    ['a 16 digit applicationId', { applicationId: '1'.repeat(16) }],
    ['a 21 digit applicationId', { applicationId: '1'.repeat(21) }],
    ['a numeric applicationId', { applicationId: Number('111111111111111111') }],
    ['a guildId that is not digits', { guildId: `g-${SECRET_VALUE}` }],
    ['a missing guildId', { guildId: undefined }],
    ['a publicKey of 63 hex characters', { publicKey: KEY.slice(1) }],
    ['a publicKey of 65 hex characters', { publicKey: `${KEY}0` }],
    ['a publicKey that is not hex', { publicKey: 'g'.repeat(64) }],
    ['a missing publicKey', { publicKey: undefined }],
    ['a publicKey that is not text', { publicKey: 5 }],
    ['no roles', { roles: undefined }],
    ['roles that is not an object', { roles: 'moderator' }],
    ['roles that is an array', { roles: [ROLE_MOD] }],
    ['roles with no id in it', { roles: { moderator: [] } }],
    ['an empty roles object', { roles: {} }],
    ['a role id that is not a snowflake', { roles: { moderator: [`role-${SECRET_VALUE}`] } }],
    ['a role id that is a number', { roles: { moderator: [Number(ROLE_MOD)] } }],
    ['a role list that is a string', { roles: { moderator: ROLE_MOD } }],
    ['a kit role that does not exist', { roles: { moderator: [ROLE_MOD], admin: [ROLE_OWNER] } }],
    ['a hubLink that is not a function', { hubLink: 'https://hub.example.test' }],
    ['a missing hubLink', { hubLink: undefined }],
    ['actions that is not an object', { actions: true }],
    ['actions.dismiss as a string', { actions: { dismiss: 'yes' } }],
    ['actions.suggestion as a number', { actions: { suggestion: 1 } }],
    ['actions.confirm as null', { actions: { confirm: null } }],
    ['an unknown actions key', { actions: { dismiss: true, ban: true } }],
    ['permissions that is not an object', { permissions: 'senior' }],
    ['an unknown permission', { permissions: { [`nope-${SECRET_VALUE}`]: 'senior' } }],
    ['a permission with a bad role', { permissions: { 'history.read': SECRET_VALUE } }],
    ['an actorOf that is not a function', { actorOf: 'x' }],
    ['a rateLimit with max 0', { rateLimit: { max: 0, windowMs: 1000 } }],
    ['a rateLimit that is not an object', { rateLimit: 5 }],
    ['a timestampToleranceMs of 0', { timestampToleranceMs: 0 }],
    ['a negative timestampToleranceMs', { timestampToleranceMs: -1 }],
    ['a fractional timestampToleranceMs', { timestampToleranceMs: 1.5 }],
    ['a timestampToleranceMs over an hour', { timestampToleranceMs: 3_600_001 }],
    ['a respondWithinMs of 0', { respondWithinMs: 0 }],
    ['a respondWithinMs at Discord three seconds', { respondWithinMs: 3000 }],
    ['a replay that is not a cache', { replay: {} }],
    ['a fetch that is not a function', { fetch: 'fetch' }],
    ['a clock without now', { clock: {} }],
    ['a logger without warn', { logger: {} }],
  ])('throws RangeError for %s, naming no value', async (_name, over) => {
    const make = await build(over);
    let error: unknown;
    try {
      make();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RangeError);
    const message = (error as Error).message;
    for (const secret of [SECRET_VALUE, KEY, ROLE_MOD, APP_ID, GUILD_ID]) expect(message).not.toContain(secret);
    expect(message.length).toBeGreaterThan(5);
  });

  it('throws RangeError for options that are not an object', async () => {
    const w = await world();
    expect(() => discordBot(w.cw, null as never)).toThrow(RangeError);
    expect(() => discordBot(w.cw, undefined as never)).toThrow(RangeError);
    expect(() => discordBot(w.cw, 'x' as never)).toThrow(RangeError);
  });

  it('upper-case hex is a valid public key; a role id may sit under more than one kit role', async () => {
    const w = await world();
    expect(() => discordBot(w.cw, { ...good(), publicKey: KEY.toUpperCase() })).not.toThrow();
    expect(() => discordBot(w.cw, { ...good(), roles: { moderator: [ROLE_MOD], senior: [ROLE_MOD] } })).not.toThrow();
  });

  it('the roles are copied: the adopter editing the object afterwards changes nothing (proved on a click in discord-roles.test.ts)', async () => {
    const w = await world();
    const roles = { moderator: [ROLE_MOD] as string[] };
    const options = { ...good(), roles };
    const bot = discordBot(w.cw, options);
    roles.moderator.push('555555555555555555');
    options.roles = { moderator: [] };
    expect(bot.routes['POST /discord/interactions']).toBeTypeOf('function');
  });
});
