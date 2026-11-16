import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import { bodyObject } from '../admin/validate.js';
import { BODY_MAX_BYTES, utf8ByteLength } from '../body.js';
import { HttpError, withErrors } from '../errors.js';
import type { KitRequest, KitResponse } from '../types.js';
import { TEXT, ephemeral, respond } from './answers.js';
import type { InteractionAnswer } from './answers.js';
import { resolveOptions } from './options.js';
import type { DiscordBotOptions } from './options.js';
import type { DiscordBot, DiscordCommand } from './types.js';
import { verifyInteraction } from './verify.js';

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

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

  /** What a verified interaction gets. Commands and buttons are added by later tasks; until then they are a fixed refusal. */
  const handle = async (body: Record<string, unknown>): Promise<InteractionAnswer | { type: number }> => {
    if (body.type === PING) return { type: 1 };
    if (body.type === APPLICATION_COMMAND || body.type === MESSAGE_COMPONENT) return ephemeral(TEXT.unsupported);
    return ephemeral(TEXT.unsupported);
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
    try {
      return respond(await handle(body));
    } catch (err) {
      // A bug or a store failure answers the person who clicked with a fixed text; the kit's own operation is never touched.
      fail('handle', err);
      return respond(ephemeral(TEXT.failed));
    }
  }, logger);

  return {
    routes: { 'POST /discord/interactions': route },
    components: () => undefined,
    commands: () => JSON.parse(JSON.stringify(COMMANDS)) as DiscordCommand[],
    dispose() {
      disposed = true;
    },
  };
}
