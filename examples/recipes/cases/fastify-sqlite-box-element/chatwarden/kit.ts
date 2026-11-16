// The Chatwarden kit: the one place the moderation engine is configured.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createProfanityFilter } from '@chatwarden/profanity';
import { createRoomBroadcaster } from '@chatwarden/http/chat';
import type { RoomBroadcaster } from '@chatwarden/http/chat';
import type { LiveTerms } from '@chatwarden/matcher';
import { loadMatcher } from './terms.js';
import * as hooks from './auth.js';
// auth.ts imports BASE and secretFromEnv from this file, so the two form an import cycle (a lint rule like import/no-cycle may flag it). It is safe
// because auth.ts reads them only inside functions. Keep BASE and secretFromEnv free of anything from auth.ts at load time.

/** Every route family lives under this prefix, so it cannot collide with your own /api or /admin. */
export const BASE = '/chatwarden';

/** What createKit() gives back: the engine, and what the routes and your own code reach it by. */
export interface Kit {
  cw: Chatwarden;
  /** The live term list: the staff term routes take it, and moderators edit it in the hub. */
  terms: LiveTerms;
  /** The room broadcaster the chat routes use. */
  chat: RoomBroadcaster;
  /** The starter sign-in, identity and chat-name hooks (auth). */
  hooks: typeof hooks;
  /** The URL prefix everything is mounted under. */
  base: string;
  close(): Promise<void>;
}

const MAKE_ONE = "node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"";
// A fixed secret for local development. Hashes made with it do not survive a change to a real one.
const DEVELOPMENT_SECRET = 'chatwarden-development-secret-not-for-production';
let warnedAboutSecret = false;

/**
 * The secret that keys every client-key and address hash. Production refuses to start without CHATWARDEN_SECRET (at least 32 characters);
 * anywhere else a missing one falls back to a fixed development secret and says so once.
 */
export function secretFromEnv(): string {
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
export async function createKit(): Promise<Kit> {
  const secret = secretFromEnv();
  const store = openStore({ path: process.env.CHATWARDEN_DB || './chatwarden.db' });
  const terms = await loadMatcher(store);
  // The broadcaster needs the engine and the engine's notify hook needs the broadcaster, so the hook reaches it through this holder.
  const live: { chat?: RoomBroadcaster } = {};
  const cw = await createChatwarden({
    store,
    secret,
    matcher: terms,
    profile: 'standard',
    profanityPackage: { createProfanityFilter },
    // identify is used only to seat a connection; the routes read who is calling from the identify hook.
    platform: { identify: () => ({}), notify: (subject) => live.chat?.noticePending(subject) },
  });
  const chat = createRoomBroadcaster(cw);
  live.chat = chat;
  hooks.announce();
  return {
    cw,
    terms,
    chat,
    hooks,
    base: BASE,
    async close() {
      chat.close();
      await cw.close();
    },
  };
}
