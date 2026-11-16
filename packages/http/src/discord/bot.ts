import { errorClass, isValidAuditActor, safeWarn } from '@chatwarden/core';
import type { Chatwarden, Role } from '@chatwarden/core';
import { bodyObject } from '../admin/validate.js';
import { BODY_MAX_BYTES, utf8ByteLength } from '../body.js';
import { HttpError, withErrors } from '../errors.js';
import { Limiter } from '../limiter.js';
import type { PermissionKey } from '../permissions.js';
import { roleAtLeast } from '../permissions.js';
import type { KitRequest, KitResponse } from '../types.js';
import { ActFlow, buttonsFor } from './act.js';
import { TEXT, ephemeral, respond, updateMessage } from './answers.js';
import type { InteractionAnswer } from './answers.js';
import { parseCustomId } from './customId.js';
import { parseInteraction, lookupRef } from './interaction.js';
import type { ParsedInteraction } from './interaction.js';
import { lookupAnswer } from './lookup.js';
import { Deferral, deferred } from './respond.js';
import { resolveOptions } from './options.js';
import type { DiscordBotOptions } from './options.js';
import { kitRoleOf } from './roles.js';
import type { DiscordBot, DiscordCommand } from './types.js';
import { verifyInteraction } from './verify.js';

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
/** A Discord interaction token lives 15 minutes: a redelivery of the same interaction id inside that window gets the same answer. */
const SEEN_WINDOW_MS = 15 * 60_000;
const SEEN_MAX = 10_000;

/** The `/chatwarden` command, as registered (K5 design 6.5). `1099511627776` is `1 << 40`, MODERATE_MEMBERS: a default visibility, not the control (the role map is). */
const COMMANDS: readonly DiscordCommand[] = Object.freeze([
  {
    name: 'chatwarden',
    description: 'Chatwarden moderation',
    type: 1,
    default_member_permissions: '1099511627776',
    options: [
      {
        type: 1,
        name: 'lookup',
        description: 'Look up a reference code',
        options: [{ type: 3, name: 'ref', description: 'The code a player quoted, like M-7K3Q9', required: true, min_length: 5, max_length: 12 }],
      },
    ],
  },
]);

/**
 * The Discord bot: a signed interactions endpoint (`POST /discord/interactions`), `/chatwarden lookup <ref>`, and, when `actions` is set, the buttons on a
 * report post with a preview and a confirm step. Mount `bot.routes` with the rest of the kit's routes, through an adapter that supplies `rawBody` (the
 * signature covers the exact bytes); give `bot.components` to `discordFeed({ components })`.
 *
 * Order of checks, every failure before the last is the same `401 { error: 'unauthorized' }` and nothing is read or acted on until it passes: the exact body
 * is present (500 and a log if not) and at most 64 KiB (413), the signature headers have the right shape and the timestamp is within the tolerance of the
 * clock, the Ed25519 signature over `timestamp + rawBody` verifies, the signature has not been accepted before; only then is the body parsed.
 *
 * @experimental
 */
export function discordBot(cw: Chatwarden, options: DiscordBotOptions): DiscordBot {
  const o = resolveOptions(options);
  const { logger, clock } = o;
  let disposed = false;

  const fail = (op: string, err: unknown): void => safeWarn(logger, 'chatwarden.discord_bot_failed', { op, error: errorClass(err) });

  const limiter = new Limiter(o.rateLimit);
  /** The answers given to interactions in the last 15 minutes, by interaction id (bounded): a redelivery is answered, not acted on twice. */
  const seen = new Map<string, { at: number; answer: Promise<InteractionAnswer> }>();

  const denied = (reason: 'guild' | 'role' | 'rate' | 'off' | 'claimed'): void => safeWarn(logger, 'chatwarden.discord_bot_denied', { reason });

  /** The audit actor of a Discord user: the adopter's mapping when it gives a valid one, else `discord:<id>` (a mapping that throws or answers junk falls back). */
  const actorFor = (userId: string): string => {
    if (o.actorOf !== undefined) {
      try {
        const mapped = o.actorOf(userId);
        if (isValidAuditActor(mapped)) return mapped;
      } catch {
        // fall through
      }
    }
    return `discord:${userId}`;
  };

  /** What the bot needs to know about someone it will act for. */
  interface Who {
    userId: string;
    actor: string;
    role: Role;
  }

  /** Steps 1 to 3 of the click (K5 design 6.6): the guild and the person, the role and its permission, the rate. A refusal is a fixed ephemeral answer and a log reason. */
  const gate = (i: ParsedInteraction, need: PermissionKey, lackText: string = TEXT.noRole): { who: Who } | { answer: InteractionAnswer } => {
    if (i.guildId !== o.guildId || i.userId === null) {
      denied('guild');
      return { answer: ephemeral(TEXT.notSetUp) };
    }
    const role = kitRoleOf(i.roles, o.roles);
    if (role === null || !roleAtLeast(role, o.permissions[need])) {
      denied('role');
      return { answer: ephemeral(role === null ? TEXT.noRole : lackText) };
    }
    if (limiter.hit(i.userId, clock.now()) > 0) {
      denied('rate');
      return { answer: ephemeral(TEXT.slowDown) };
    }
    return { who: { userId: i.userId, actor: actorFor(i.userId), role } };
  };

  const command = (i: ParsedInteraction): InteractionAnswer => {
    const ref = i.commandName === 'chatwarden' ? lookupRef(i.options) : undefined;
    if (ref === undefined) {
      // Not a command this bot has: the guild check still comes first, so a stranger learns nothing either way.
      if (i.guildId !== o.guildId || i.userId === null) {
        denied('guild');
        return ephemeral(TEXT.notSetUp);
      }
      return ephemeral(TEXT.unsupported);
    }
    const g = gate(i, 'history.read');
    if ('answer' in g) return g.answer;
    return lookupAnswer({ cw, hubLink: o.hubLink, now: () => clock.now(), who: g.who }, ref);
  };

  const act = new ActFlow({ cw, o, denied });

  const component = async (i: ParsedInteraction): Promise<InteractionAnswer> => {
    if (i.guildId !== o.guildId || i.userId === null) {
      denied('guild');
      return ephemeral(TEXT.notSetUp);
    }
    const parsed = parseCustomId(i.customId);
    if (parsed === null) return ephemeral(TEXT.unsupported);
    if (parsed.verb === 'x') {
      const g = gate(i, 'reports.read');
      return 'answer' in g ? g.answer : updateMessage(TEXT.cancelled);
    }
    const need = act.needs(parsed);
    const g = gate(i, need, need === 'reports.decide' ? TEXT.noPermission : TEXT.noRole);
    if ('answer' in g) return g.answer;
    return act.click(parsed, g.who);
  };

  const deferral = new Deferral({
    applicationId: o.applicationId,
    withinMs: o.respondWithinMs,
    schedule: o.schedule,
    fetch: o.fetch,
    logger,
    fail,
  });

  /**
   * What to answer first when the work is slow. A command, and a click on a button of the report post (a public message), get a loading message only the
   * clicker sees (type 5, ephemeral): an update there would rewrite the post for everyone. A click on a button of the ephemeral message (Confirm, Cancel)
   * is acknowledged as an update (type 6) of that ephemeral message, which the follow-up then edits.
   */
  const deferredFor = (i: ParsedInteraction): { type: number; data?: { flags: number } } => {
    if (i.type !== MESSAGE_COMPONENT) return deferred('message');
    const verb = parseCustomId(i.customId)?.verb;
    return deferred(verb === 'ok' || verb === 'x' ? 'update' : 'message');
  };

  /** What a verified interaction gets. */
  const handle = async (body: Record<string, unknown>): Promise<InteractionAnswer | { type: number }> => {
    const i = parseInteraction(body);
    if (i.type === PING) return { type: 1 };
    if (i.type !== APPLICATION_COMMAND && i.type !== MESSAGE_COMPONENT) return ephemeral(TEXT.unsupported);
    return deferral.settle(remembered(i), deferredFor(i), body.token);
  };

  /**
   * Answer a command or a click once per interaction id: a redelivery inside the window (even one that arrives while the first is still being worked on)
   * gets the first answer and writes nothing.
   */
  const remembered = (i: ParsedInteraction): Promise<InteractionAnswer> => {
    const now = clock.now();
    const held = i.id === null ? undefined : seen.get(i.id);
    if (held !== undefined && now - held.at < SEEN_WINDOW_MS) return held.answer;
    const answer = (async () => (i.type === APPLICATION_COMMAND ? command(i) : await component(i)))();
    const id = i.id;
    if (id !== null) {
      seen.delete(id);
      if (seen.size >= SEEN_MAX) {
        const oldest = seen.keys().next();
        if (oldest.done !== true) seen.delete(oldest.value);
      }
      seen.set(id, { at: now, answer });
      // A failure is not kept: the redelivery may try again.
      answer.catch(() => {
        if (seen.get(id)?.answer === answer) seen.delete(id);
      });
    }
    return answer;
  };

  const route = withErrors(async (req: KitRequest): Promise<KitResponse> => {
    const raw = req.rawBody;
    if (raw === undefined) {
      // The adapter did not give the exact bytes (a body parser ran first, or none supplies rawBody): a setup error, never a pass.
      safeWarn(logger, 'chatwarden.discord_bot_failed', { op: 'no_raw_body' });
      return { status: 500, body: { error: 'internal' } };
    }
    // Cheap size cap before any crypto (the byte cap the routes enforce).
    if (raw.length * 3 > BODY_MAX_BYTES && utf8ByteLength(raw) > BODY_MAX_BYTES) throw new HttpError('payload_too_large');
    // Verify BEFORE parsing. Every failure is the same 401.
    if (disposed || !verifyInteraction(o.publicKey, req.headers, raw, clock.now(), o.timestampToleranceMs, o.replay)) throw new HttpError('unauthorized');
    const body = bodyObject(req);
    // The work's own failures are answered with a fixed text inside `deferral.settle`; the kit's own operation is never touched.
    return respond(await handle(body));
  }, logger);

  return {
    routes: { 'POST /discord/interactions': route },
    components: (post) => buttonsFor(o, post),
    commands: () => JSON.parse(JSON.stringify(COMMANDS)) as DiscordCommand[],
    dispose() {
      disposed = true;
      deferral.dispose();
      seen.clear();
    },
  };
}
