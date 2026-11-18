// Who may do what: the staff sign-in, who a player is, and the name the chat shows. All three are starters.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BASE, secretFromEnv } from './kit.js';

// kit.ts imports this file and this file imports BASE and secretFromEnv back from it: an import cycle (a lint rule like import/no-cycle may flag it).
// It is safe because both are only read inside functions, after both modules have loaded. Keep it that way: do not use them at the top level here.
/** The cookie the sign-in form sets. It holds an HMAC of the token, never the token. */
export const STAFF_COOKIE = 'chatwarden_staff';
const MIN_TOKEN_LENGTH = 24;
const LOBBY = 'lobby';
const MAX_NAMES = 400;
let announced = false;
const numbers = new Map();

/** The staff token, or undefined when it is missing or too short to protect anything. */
function staffToken() {
  const token = process.env.CHATWARDEN_ADMIN_TOKEN;
  return token !== undefined && token.length >= MIN_TOKEN_LENGTH ? token : undefined;
}

/** Equal text without leaking where it differs: both sides are hashed to the same length first. */
function sameText(given, expected) {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

/** What the cookie holds: an HMAC of the token under the secret. */
function cookieFor(token) {
  return createHmac('sha256', secretFromEnv()).update(token).digest('hex');
}

/** The value of one cookie in a Cookie header, or undefined. */
function cookieValue(cookies, name) {
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

function staff() {
  return { actor: 'admin', role: 'owner' };
}

// TODO(auth): this staff sign-in is one shared token, fine for one or two moderators. Replace it with your own session and roles before a team uses it.
export function authorize(req) {
  const token = staffToken();
  if (token === undefined) return null; // no usable token: every staff route answers 401
  const given = req.headers['x-admin-token'];
  if (given !== undefined) return sameText(given, token) ? staff() : null; // a wrong header is not rescued by a cookie
  return sameText(cookieValue(req.headers.cookie, STAFF_COOKIE), cookieFor(token)) ? staff() : null;
}

/** For the sign-in form: the Set-Cookie value when the token is right, otherwise null. HttpOnly, SameSite=Strict and Secure; set CHATWARDEN_INSECURE_STAFF_COOKIE=1 to drop Secure for local plain-http development only. */
export function signIn(given) {
  const token = staffToken();
  if (token === undefined || !sameText(given, token)) return null;
  const secure = process.env.CHATWARDEN_INSECURE_STAFF_COOKIE === '1' ? '' : '; Secure'; // Chrome and Firefox accept Secure on http://127.0.0.1 too
  return STAFF_COOKIE + '=' + cookieFor(token) + '; HttpOnly; SameSite=Strict; Path=' + BASE + secure;
}

/** Called once at startup: in production, say that the starter sign-in is on. */
export function announce() {
  if (announced || staffToken() === undefined || process.env.NODE_ENV !== 'production') return;
  announced = true;
  console.warn('chatwarden: starter staff sign-in is on; replace authorize() with your own');
}

// TODO(identity): your game's own session or account id goes here. A key the client chooses lets one person make many identities.
export function identify(req) {
  const key = req.headers['x-chatwarden-key'];
  // Behind a reverse proxy this is the proxy's address, so every player would share one: read your proxy's forwarding header yourself, trusting only your own proxy.
  return { ...(key === undefined || key === '' ? {} : { clientKey: key }), ip: req.remoteAddress ?? null };
}

// TODO(identity): the name other players see. It is "Player N", counted per key and never any part of it; use your players' real display names.
export function join(req, roomId) {
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
