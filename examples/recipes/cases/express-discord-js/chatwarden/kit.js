// The Chatwarden kit: the one place the moderation engine is configured.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { createChatwarden } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createProfanityFilter } from '@chatwarden/profanity';
import { discordFeed } from '@chatwarden/discord';
import { loadMatcher } from './terms.js';
import * as hooks from './auth.js';

/** Every route family lives under this prefix, so it cannot collide with your own /api or /admin. */
export const BASE = '/chatwarden';

const MAKE_ONE = "node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"";
// A fixed secret for local development. Hashes made with it do not survive a change to a real one.
const DEVELOPMENT_SECRET = 'chatwarden-development-secret-not-for-production';
let warnedAboutSecret = false;

/**
 * The secret that keys every client-key and address hash. Production refuses to start without CHATWARDEN_SECRET (at least 32 characters);
 * anywhere else a missing one falls back to a fixed development secret and says so once.
 */
export function secretFromEnv() {
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
export async function createKit() {
  const secret = secretFromEnv();
  const store = openStore({ path: process.env.CHATWARDEN_DB || './chatwarden.db' });
  const terms = await loadMatcher(store);
  const cw = await createChatwarden({
    store,
    secret,
    matcher: terms,
    profile: 'standard',
    profanityPackage: { createProfanityFilter },
    // identify is used only to seat a connection; the routes read who is calling from the identify hook.
    platform: { identify: () => ({}), notify: () => {} },
  });
  let feed;
  if (process.env.DISCORD_WEBHOOK_URL) {
    const origin = (process.env.CHATWARDEN_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
    feed = discordFeed(cw, {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      hubLink: (kind, id) =>
        `${origin}${BASE}/mod#/${kind === 'report' ? 'reports' : 'people'}/${encodeURIComponent(id)}`,
      ...(process.env.DISCORD_MENTION_ROLE_ID ? { mentionRoleId: process.env.DISCORD_MENTION_ROLE_ID } : {}),
    });
  }
  hooks.announce();
  return {
    cw,
    terms,
    hooks,
    base: BASE,
    async close() {
      feed?.dispose();
      await cw.close();
    },
  };
}
