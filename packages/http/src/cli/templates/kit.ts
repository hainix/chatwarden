// `kit.ts`: the one place the moderation engine is configured (design 6.2). It opens the store, builds the matcher, calls
// `createChatwarden`, and wires the room broadcaster and the Discord feed when they were asked for.
import { SECRET_COMMAND } from '../plan.js';
import type { FileSpec } from '../types.js';
import { imp, impNs, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function kitFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  const routes = answers.framework !== 'none';
  const box = answers.chat === 'box';
  const sqlite = answers.store === 'sqlite';
  const hubPage = answers.hub !== 'none';
  const discord = answers.discord;

  const imports =
    imp(ctx, 'createChatwarden', '@chatwarden/core') +
    impType(ctx, 'Chatwarden', '@chatwarden/core') +
    (sqlite ? imp(ctx, 'openStore', '@chatwarden/store-sqlite') : imp(ctx, 'createMemoryStore', '@chatwarden/store-memory')) +
    imp(ctx, 'createProfanityFilter', '@chatwarden/profanity') +
    (box ? imp(ctx, 'createRoomBroadcaster', '@chatwarden/http/chat') + impType(ctx, 'RoomBroadcaster', '@chatwarden/http/chat') : '') +
    (discord ? imp(ctx, 'discordFeed', '@chatwarden/discord') + impType(ctx, 'DiscordFeed', '@chatwarden/discord') : '') +
    impType(ctx, 'LiveTerms', '@chatwarden/matcher') +
    imp(ctx, 'loadMatcher', './terms') +
    (routes ? impNs(ctx, 'hooks', './auth') : '');

  const kitType = t(
    ctx,
    `/** What createKit() gives back: the engine, and what the routes and your own code reach it by. */
export interface Kit {
  cw: Chatwarden;
  /** The live term list: the staff term routes take it, and moderators edit it in the hub. */
  terms: LiveTerms;
${box ? '  /** The room broadcaster the chat routes use. */\n  chat: RoomBroadcaster;\n' : ''}${routes ? '  /** The starter sign-in, identity and chat-name hooks (auth). */\n  hooks: typeof hooks;\n' : ''}  /** The URL prefix everything is mounted under. */
  base: string;
  close(): Promise<void>;
}

`,
  );

  const storeLine = sqlite
    ? "const store = openStore({ path: process.env.CHATWARDEN_DB || './chatwarden.db' });"
    : 'const store = createMemoryStore(); // lost on restart: for tests and demos';

  const hubLink = hubPage
    ? "`${origin}${BASE}/mod#/${kind === 'report' ? 'reports' : 'people'}/${encodeURIComponent(id)}`"
    : "kind === 'report'\n          ? `${origin}${BASE}/admin/reports/${encodeURIComponent(id)}`\n          : `${origin}${BASE}/admin/people/${encodeURIComponent(id)}/history`";

  const feed = discord
    ? `  let feed${t(ctx, ': DiscordFeed | undefined')};
  if (process.env.DISCORD_WEBHOOK_URL) {
    const origin = (process.env.CHATWARDEN_PUBLIC_URL || 'http://localhost:3000').replace(/\\/+$/, '');
    feed = discordFeed(cw, {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      hubLink: (kind, id) =>
        ${hubLink},
      ...(process.env.DISCORD_MENTION_ROLE_ID ? { mentionRoleId: process.env.DISCORD_MENTION_ROLE_ID } : {}),
    });
  }
`
    : '';

  const cycleNote = `// auth.ts imports BASE and secretFromEnv from this file, so the two form an import cycle (a lint rule like import/no-cycle may flag it). It is safe
// because auth.ts reads them only inside functions. Keep BASE and secretFromEnv free of anything from auth.ts at load time.
`;
  const content = `${header(ctx, 'The Chatwarden kit: the one place the moderation engine is configured.')}${imports}${routes ? cycleNote : ''}
/** Every route family lives under this prefix, so it cannot collide with your own /api or /admin. */
export const BASE = '${answers.base}';

${kitType}const MAKE_ONE = ${JSON.stringify(SECRET_COMMAND)};
// A fixed secret for local development. Hashes made with it do not survive a change to a real one.
const DEVELOPMENT_SECRET = 'chatwarden-development-secret-not-for-production';
let warnedAboutSecret = false;

/**
 * The secret that keys every client-key and address hash. Production refuses to start without CHATWARDEN_SECRET (at least 32 characters);
 * anywhere else a missing one falls back to a fixed development secret and says so once.
 */
export function secretFromEnv()${t(ctx, ': string')} {
  const secret = process.env.CHATWARDEN_SECRET || '';
  if (process.env.NODE_ENV === 'production') {
    if (secret.length < 32) throw new Error('CHATWARDEN_SECRET must be set to at least 32 characters in production. Make one with: ' + MAKE_ONE);
    return secret;
  }
  if (secret !== '') return secret;
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn('chatwarden: CHATWARDEN_SECRET is not set; using a development secret (hashes will not survive a change to a real one)');
  }
  return DEVELOPMENT_SECRET;
}

/** Build the kit once at startup, and close() it on shutdown. */
export async function createKit()${t(ctx, ': Promise<Kit>')} {
  const secret = secretFromEnv();
  ${storeLine}
  const terms = await loadMatcher(${sqlite ? 'store' : ''});
${box ? `  // The broadcaster needs the engine and the engine's notify hook needs the broadcaster, so the hook reaches it through this holder.\n  const live${t(ctx, ': { chat?: RoomBroadcaster }')} = {};\n` : ''}  const cw = await createChatwarden({
    store,
    secret,
    matcher: terms,
    profile: '${answers.profile}',
    profanityPackage: { createProfanityFilter },
    // identify is used only to seat a connection; the routes read who is calling from the identify hook.
    platform: { identify: () => ({}), notify: ${box ? '(subject) => live.chat?.noticePending(subject)' : '() => {}'} },
  });
${box ? '  const chat = createRoomBroadcaster(cw);\n  live.chat = chat;\n' : ''}${feed}${routes ? '  hooks.announce();\n' : ''}  return {
    cw,
    terms,
${box ? '    chat,\n' : ''}${routes ? '    hooks,\n' : ''}    base: BASE,
    async close() {
${box ? '      chat.close();\n' : ''}${discord ? '      feed?.dispose();\n' : ''}      await cw.close();
    },
  };
}
`;
  return [{ path: `${answers.dir}/kit${ctx.scriptExt}`, content }];
}
