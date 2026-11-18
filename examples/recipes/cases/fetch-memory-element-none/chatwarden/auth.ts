// Who may do what: the staff sign-in, who a player is, and the name the chat shows. All three are starters.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Authz, KitRequest } from '@chatwarden/http';
import type { RawWho } from '@chatwarden/core';
import { BASE, secretFromEnv } from './kit.js';

// kit.ts imports this file and this file imports BASE and secretFromEnv back from it: an import cycle (a lint rule like import/no-cycle may flag it).
// It is safe because both are only read inside functions, after both modules have loaded. Keep it that way: do not use them at the top level here.
/** The cookie the sign-in form sets. It holds an HMAC of the token, never the token. */
export const STAFF_COOKIE = 'chatwarden_staff';
const MIN_TOKEN_LENGTH = 24;
const LOBBY = 'lobby';
const MAX_NAMES = 400;
let announced = false;
const numbers = new Map<string, number>();

/** The staff token, or undefined when it is missing or too short to protect anything. */
function staffToken(): string | undefined {
  const token = process.env.CHATWARDEN_ADMIN_TOKEN;
  return token !== undefined && token.length >= MIN_TOKEN_LENGTH ? token : undefined;
}

/** Equal text without leaking where it differs: both sides are hashed to the same length first. */
function sameText(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

/** What the cookie holds: an HMAC of the token under the secret. */
function cookieFor(token: string): string {
  return createHmac('sha256', secretFromEnv()).update(token).digest('hex');
}

/** The value of one cookie in a Cookie header, or undefined. */
function cookieValue(cookies: string | undefined, name: string): string | undefined {
  if (cookies === undefined) return undefined;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function staff(): Authz {
  return { actor: 'admin', role: 'owner' };
}

// TODO(auth): this staff sign-in is one shared token, fine for one or two moderators. Replace it with your own session and roles before a team uses it.
export function authorize(req: KitRequest): Authz | null {
  const token = staffToken();
  if (token === undefined) return null; // no usable token: every staff route answers 401
  const given = req.headers['x-admin-token'];
  if (given !== undefined) return sameText(given, token) ? staff() : null; // a wrong header is not rescued by a cookie
  return sameText(cookieValue(req.headers.cookie, STAFF_COOKIE), cookieFor(token)) ? staff() : null;
}

/** For the sign-in form: the Set-Cookie value when the token is right, otherwise null. HttpOnly, SameSite=Strict and Secure; set CHATWARDEN_INSECURE_STAFF_COOKIE=1 to drop Secure for local plain-http development only. */
export function signIn(given: unknown): string | null {
  const token = staffToken();
  if (token === undefined || !sameText(given, token)) return null;
  const secure = process.env.CHATWARDEN_INSECURE_STAFF_COOKIE === '1' ? '' : '; Secure'; // Chrome and Firefox accept Secure on http://127.0.0.1 too
  return STAFF_COOKIE + '=' + cookieFor(token) + '; HttpOnly; SameSite=Strict; Path=' + BASE + secure;
}

/** Called once at startup: in production, say that the starter sign-in is on. */
export function announce(): void {
  if (announced || staffToken() === undefined || process.env.NODE_ENV !== 'production') return;
  announced = true;
  console.warn('chatwarden: starter staff sign-in is on; replace authorize() with your own');
}

/**
 * The player's address. This adapter cannot see the socket, so behind your own reverse proxy (and only then) set CHATWARDEN_TRUST_PROXY=1
 * to take the first X-Forwarded-For entry. Anywhere else a client could put any address there.
 */
function clientAddress(req: KitRequest): string | null {
  if (process.env.CHATWARDEN_TRUST_PROXY === '1') {
    const first = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    if (first !== undefined && /^[0-9A-Fa-f:.]{2,45}$/.test(first)) return first;
  }
  return req.remoteAddress ?? null;
}

// TODO(identity): your game's own session or account id goes here. A key the client chooses lets one person make many identities.
export function identify(req: KitRequest): RawWho {
  const key = req.headers['x-chatwarden-key'];
  return { ...(key === undefined || key === '' ? {} : { clientKey: key }), ip: clientAddress(req) };
}

// TODO(identity): the name other players see. It is "Player N", counted per key and never any part of it; use your players' real display names.
export function join(req: KitRequest, roomId: string): { name: string } | null {
  if (roomId !== LOBBY) return null; // one room, so a room id from the URL does not make a room
  const key = req.headers['x-chatwarden-key'] ?? '';
  let n = numbers.get(key);
  if (n === undefined) {
    if (numbers.size >= MAX_NAMES) return null; // the table is bounded
    n = numbers.size + 1;
    numbers.set(key, n);
  }
  return { name: 'Player ' + n };
}
