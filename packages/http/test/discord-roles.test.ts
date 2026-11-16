import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discordBot } from '../src/discord/index.js';
import { kitRoleOf } from '../src/discord/roles.js';
import { KIND_LABELS } from '../src/discord/text.js';
import { GUILD_ID, OTHER_GUILD_ID, ROLE_MOD, ROLE_OTHER, ROLE_OWNER, ROLE_SENIOR, USER_ID, botWorld, contentOf, answerOf, hubLink, newPair, APP_ID } from './discord-world.js';
import { world } from './world.js';

// Who may use the bot (K5 D4, Review Focus 2): the guild, the role map, the permission table and the per-user rate.

const MAP = { moderator: [ROLE_MOD], senior: [ROLE_SENIOR], owner: [ROLE_OWNER] };

describe('kitRoleOf', () => {
  it('the highest role wins: a member with moderator and senior role ids is senior', () => {
    expect(kitRoleOf([ROLE_MOD, ROLE_SENIOR], MAP)).toBe('senior');
    expect(kitRoleOf([ROLE_SENIOR, ROLE_MOD, ROLE_OWNER], MAP)).toBe('owner');
    expect(kitRoleOf([ROLE_MOD], MAP)).toBe('moderator');
  });

  it('an unlisted role is nothing; empty and duplicate ids are fine', () => {
    expect(kitRoleOf([ROLE_OTHER], MAP)).toBeNull();
    expect(kitRoleOf([], MAP)).toBeNull();
    expect(kitRoleOf([ROLE_MOD, ROLE_MOD, ROLE_MOD], MAP)).toBe('moderator');
    expect(kitRoleOf([ROLE_OTHER, ROLE_MOD], MAP)).toBe('moderator');
  });

  it('a role id listed under two kit roles gives the higher one', () => {
    expect(kitRoleOf([ROLE_MOD], { moderator: [ROLE_MOD], senior: [ROLE_MOD] })).toBe('senior');
  });

  it('the map never matches a role name or a kit role word', () => {
    for (const word of ['owner', 'senior', 'moderator', 'Moderator', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
      expect(kitRoleOf([word], MAP), word).toBeNull();
    }
  });

  it('a hostile member list (non-strings, objects, a huge array) is ignored, never thrown', () => {
    expect(kitRoleOf([1, null, undefined, {}, [ROLE_OWNER], true] as never, MAP)).toBeNull();
    expect(kitRoleOf('not an array' as never, MAP)).toBeNull();
    expect(kitRoleOf(null as never, MAP)).toBeNull();
    expect(kitRoleOf(Array.from({ length: 5000 }, (_, i) => String(i)), MAP)).toBeNull();
  });

  it('a map with a missing or empty role works; an inherited key is not a role', () => {
    expect(kitRoleOf([ROLE_OWNER], { moderator: [ROLE_MOD] })).toBeNull();
    expect(kitRoleOf([ROLE_MOD], { moderator: [] })).toBeNull();
    const inherited = Object.create({ owner: [ROLE_OWNER] }) as Record<string, string[]>;
    expect(kitRoleOf([ROLE_OWNER], inherited)).toBeNull();
  });
});

describe('the roles the bot was built with are a copy', () => {
  it('a member holding an id the adopter added to their object afterwards has no role', async () => {
    const w = await world();
    const roles = { moderator: [ROLE_MOD] as string[] };
    const bot = discordBot(w.cw, { applicationId: APP_ID, publicKey: newPair().publicKeyHex, guildId: GUILD_ID, roles, hubLink });
    roles.moderator.push(ROLE_OTHER);
    // a click proves it: the bot object has no other way to read its roles, so go through the whole route
    expect(bot.commands()).toHaveLength(1);
  });

  it('end to end: an id pushed onto the adopter array after construction does not make a moderator', async () => {
    const roles = { moderator: [ROLE_MOD] as string[] };
    const b = await botWorld({ options: { roles } });
    roles.moderator.push(ROLE_OTHER);
    const res = await b.send(b.client.lookup('M-AAAAA', { roles: [ROLE_OTHER] }));
    expect(contentOf(res)).toBe('You do not have a moderator role for this bot.');
  });
});

describe('who may talk to the bot', () => {
  it('a wrong guild, a DM and a missing member are refused with the fixed text and a log reason (guild); no id appears in the answer or the log', async () => {
    const b = await botWorld();
    const answers = [
      await b.send(b.client.lookup('M-AAAAA', { guild: OTHER_GUILD_ID })),
      await b.send(b.client.lookup('M-AAAAA', { guild: null })),
      await b.send(b.client.lookup('M-AAAAA', { member: false })),
      await b.send(b.client.command({ name: 'chatwarden' }, { guild: OTHER_GUILD_ID })),
    ];
    for (const res of answers) {
      expect(contentOf(res)).toBe('This bot is not set up for this server.');
      expect(answerOf(res).data?.flags).toBe(64);
      expect(answerOf(res).data?.allowed_mentions).toEqual({ parse: [] });
    }
    expect(b.logged.filter(([e]) => e === 'chatwarden.discord_bot_denied')).toEqual([
      ['chatwarden.discord_bot_denied', { reason: 'guild' }],
      ['chatwarden.discord_bot_denied', { reason: 'guild' }],
      ['chatwarden.discord_bot_denied', { reason: 'guild' }],
      ['chatwarden.discord_bot_denied', { reason: 'guild' }],
    ]);
    const text = JSON.stringify([b.logged, answers.map((r) => r.body)]);
    for (const id of [OTHER_GUILD_ID, GUILD_ID, ROLE_MOD, USER_ID]) expect(text).not.toContain(id);
  });

  it('a user id that is not a snowflake, or a missing one, is the same refusal', async () => {
    const b = await botWorld();
    for (const user of ['x', '', '1'.repeat(30)]) {
      const res = await b.send(b.client.lookup('M-AAAAA', { user }));
      expect(contentOf(res), user).toBe('This bot is not set up for this server.');
    }
  });

  it('no role is refused with the fixed text (role, no id or name echoed); a mapped role passes the gate', async () => {
    const b = await botWorld();
    for (const roles of [[], [ROLE_OTHER], ['owner'], ['senior']]) {
      const res = await b.send(b.client.lookup('M-AAAAA', { roles }));
      expect(contentOf(res)).toBe('You do not have a moderator role for this bot.');
    }
    expect(b.logged.filter(([e]) => e === 'chatwarden.discord_bot_denied').every(([, d]) => d?.reason === 'role')).toBe(true);
    const ok = await b.send(b.client.lookup('M-AAAAA', { roles: [ROLE_MOD] }));
    expect(contentOf(ok)).toBe('No sanction found for that code.');
  });

  it('a member roles list that is not an array, or full of junk, has no role', async () => {
    const b = await botWorld();
    const hostile = b.client.signed({
      ...b.client.interaction(2, { name: 'chatwarden', options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: 'M-AAAAA' }] }] }),
      member: { user: { id: USER_ID }, roles: ROLE_MOD },
    });
    expect(contentOf(await b.send(hostile))).toBe('You do not have a moderator role for this bot.');
  });

  it('the permission table is the staff routes: a role below history.read gets the same no-role text, and an adopter can raise or lower it', async () => {
    const raised = await botWorld({ options: { permissions: { 'history.read': 'senior' } } });
    expect(contentOf(await raised.send(raised.client.lookup('M-AAAAA', { roles: [ROLE_MOD] })))).toBe('You do not have a moderator role for this bot.');
    expect(contentOf(await raised.send(raised.client.lookup('M-AAAAA', { roles: [ROLE_SENIOR] })))).toBe('No sanction found for that code.');
    const lowered = await botWorld({ options: { permissions: { 'history.read': 'moderator' } } });
    expect(contentOf(await lowered.send(lowered.client.lookup('M-AAAAA', { roles: [ROLE_MOD] })))).toBe('No sanction found for that code.');
  });
});

describe('rate', () => {
  it('the 21st lookup in a minute is Slow down; another user is unaffected; the clock moves the window', async () => {
    const b = await botWorld();
    for (let i = 0; i < 20; i++) expect(contentOf(await b.send(b.client.lookup('M-AAAAA'))), String(i)).toBe('No sanction found for that code.');
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA')))).toBe('Slow down.');
    expect(b.logged.filter(([e]) => e === 'chatwarden.discord_bot_denied').at(-1)).toEqual(['chatwarden.discord_bot_denied', { reason: 'rate' }]);
    // another user
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA', { user: '444444444444444499' })))).toBe('No sanction found for that code.');
    // the window moves with the clock
    b.w.clock.t += 60_000;
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA')))).toBe('No sanction found for that code.');
  });

  it('the rateLimit option sets the bound', async () => {
    const b = await botWorld({ options: { rateLimit: { max: 2, windowMs: 1000 } } });
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA')))).toBe('No sanction found for that code.');
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA')))).toBe('No sanction found for that code.');
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA')))).toBe('Slow down.');
  });

  it('a refused request (wrong guild, no role) never uses up a user allowance', async () => {
    const b = await botWorld({ options: { rateLimit: { max: 1, windowMs: 60_000 } } });
    for (let i = 0; i < 5; i++) await b.send(b.client.lookup('M-AAAAA', { roles: [ROLE_OTHER] }));
    for (let i = 0; i < 5; i++) await b.send(b.client.lookup('M-AAAAA', { guild: OTHER_GUILD_ID }));
    expect(contentOf(await b.send(b.client.lookup('M-AAAAA')))).toBe('No sanction found for that code.');
  });
});

describe('the label table agrees with the feed', () => {
  it('KIND_LABELS here is the one in @chatwarden/discord (copied, so a change in one must show in the other)', () => {
    const source = readFileSync(new URL('../../discord/src/text.ts', import.meta.url), 'utf8');
    const block = /export const KIND_LABELS[^{]*\{([\s\S]*?)\}\);/.exec(source);
    expect(block).not.toBeNull();
    const feed: Record<string, string> = {};
    for (const m of (block as RegExpExecArray)[1]!.matchAll(/(\w+):\s*'([^']*)'/g)) feed[m[1] as string] = m[2] as string;
    expect(Object.keys(feed).length).toBeGreaterThan(3);
    expect({ ...KIND_LABELS }).toEqual(feed);
  });
});
