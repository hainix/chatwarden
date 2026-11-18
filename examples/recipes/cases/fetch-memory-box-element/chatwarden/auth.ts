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
 * CHATWARDEN_TRUST_PROXY: the number of reverse proxies of your own in front of this server, from 1 to 10. Anything else (unset, 0, text) means
 * none, so a client cannot switch it on. `chatwarden serve` reads the same variable the same way.
 */
function trustedProxies(): number {
  const value = process.env.CHATWARDEN_TRUST_PROXY ?? '';
  return /^[0-9]{1,2}$/.test(value) && Number(value) <= 10 ? Number(value) : 0;
}

/** The address in one X-Forwarded-For entry, with a port (and the brackets of an IPv6 address) dropped; undefined when it is not an address. */
function addressIn(entry: string): string | undefined {
  let address = entry;
  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    const rest = address.slice(close + 1);
    if (close === -1 || !(rest === '' || /^:[0-9]{1,5}$/.test(rest))) return undefined;
    address = address.slice(1, close);
  } else if (address.split(':').length === 2) {
    const [host = '', port = ''] = address.split(':'); // an IPv4 address with a port
    if (!/^[0-9]{1,5}$/.test(port)) return undefined;
    address = host;
  }
  const v4 = /^[0-9]{1,3}([.][0-9]{1,3}){3}$/.test(address) && address.split('.').every((octet) => octet === String(Number(octet)) && Number(octet) <= 255);
  const v6 = (address.includes(':') && /^[0-9A-Fa-f:]{2,39}$/.test(address)) || /^::[Ff]{4}:[0-9]{1,3}([.][0-9]{1,3}){3}$/.test(address);
  return v4 || v6 ? address : undefined;
}

/**
 * The player's address. This adapter cannot see the socket, so behind your own reverse proxy (and only then) set CHATWARDEN_TRUST_PROXY to the
 * number of proxies of your own in front of this server (1 for one). The address is then the X-Forwarded-For entry that many places from the right:
 * each proxy appends the address it saw, so the entries to the left are whatever the client claimed and are never read. Anywhere else a client
 * could put any address there. With it unset or 0 (or no usable entry), the address is the connection's.
 */
function clientAddress(req: KitRequest): string | null {
  const hops = trustedProxies();
  if (hops > 0) {
    const entries = req.headers['x-forwarded-for']?.split(',') ?? [];
    const address = entries.length >= hops ? addressIn((entries[entries.length - hops] ?? '').trim()) : undefined;
    if (address !== undefined) return address;
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
