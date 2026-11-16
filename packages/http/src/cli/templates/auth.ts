// `auth.ts`: the three hooks a first run needs and a production run must replace (design 7.2): who may use the staff routes, who a player is,
// and what name the chat shows. Each is a small, named, fail-closed starter with a marker that `chatwarden init --check` lists.
import type { FileSpec } from '../types.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function authFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.framework === 'none') return [];
  // Next and a plain Web handler cannot see the socket, so they get the opt-in proxy switch; Express and Fastify read the address from the connection.
  const proxy = answers.framework === 'next' || answers.framework === 'fetch';

  const imports =
    imp(ctx, ['createHash', 'createHmac', 'timingSafeEqual'], 'node:crypto') +
    impType(ctx, ['Authz', 'KitRequest'], '@chatwarden/http') +
    impType(ctx, 'RawWho', '@chatwarden/core') +
    imp(ctx, ['BASE', 'secretFromEnv'], './kit');

  const address = proxy
    ? `/**
 * The player's address. This adapter cannot see the socket, so behind your own reverse proxy (and only then) set CHATWARDEN_TRUST_PROXY=1
 * to take the first X-Forwarded-For entry. Anywhere else a client could put any address there.
 */
function clientAddress(req${t(ctx, ': KitRequest')})${t(ctx, ': string | null')} {
  if (process.env.CHATWARDEN_TRUST_PROXY === '1') {
    const first = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    if (first !== undefined && /^[0-9A-Fa-f:.]{2,45}$/.test(first)) return first;
  }
  return req.remoteAddress ?? null;
}

`
    : '';
  const addressOf = proxy ? 'clientAddress(req)' : 'req.remoteAddress ?? null';
  const proxyNote = proxy
    ? ''
    : "  // Behind a reverse proxy this is the proxy's address, so every player would share one: read your proxy's forwarding header yourself, trusting only your own proxy.\n";

  const content = `${header(ctx, 'Who may do what: the staff sign-in, who a player is, and the name the chat shows. All three are starters.')}${imports}
// kit.ts imports this file and this file imports BASE and secretFromEnv back from it: an import cycle (a lint rule like import/no-cycle may flag it).
// It is safe because both are only read inside functions, after both modules have loaded. Keep it that way: do not use them at the top level here.
/** The cookie the sign-in form sets. It holds an HMAC of the token, never the token. */
export const STAFF_COOKIE = 'chatwarden_staff';
const MIN_TOKEN_LENGTH = 24;
const LOBBY = 'lobby';
const MAX_NAMES = 400;
let announced = false;
const numbers = new Map${t(ctx, '<string, number>')}();

/** The staff token, or undefined when it is missing or too short to protect anything. */
function staffToken()${t(ctx, ': string | undefined')} {
  const token = process.env.CHATWARDEN_ADMIN_TOKEN;
  return token !== undefined && token.length >= MIN_TOKEN_LENGTH ? token : undefined;
}

/** Equal text without leaking where it differs: both sides are hashed to the same length first. */
function sameText(given${t(ctx, ': unknown')}, expected${t(ctx, ': string')})${t(ctx, ': boolean')} {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

/** What the cookie holds: an HMAC of the token under the secret. */
function cookieFor(token${t(ctx, ': string')})${t(ctx, ': string')} {
  return createHmac('sha256', secretFromEnv()).update(token).digest('hex');
}

/** The value of one cookie in a Cookie header, or undefined. */
function cookieValue(cookies${t(ctx, ': string | undefined')}, name${t(ctx, ': string')})${t(ctx, ': string | undefined')} {
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

function staff()${t(ctx, ': Authz')} {
  return { actor: 'admin', role: 'owner' };
}

// TODO(auth): this staff sign-in is one shared token, fine for one or two moderators. Replace it with your own session and roles before a team uses it.
export function authorize(req${t(ctx, ': KitRequest')})${t(ctx, ': Authz | null')} {
  const token = staffToken();
  if (token === undefined) return null; // no usable token: every staff route answers 401
  const given = req.headers['x-admin-token'];
  if (given !== undefined) return sameText(given, token) ? staff() : null; // a wrong header is not rescued by a cookie
  return sameText(cookieValue(req.headers.cookie, STAFF_COOKIE), cookieFor(token)) ? staff() : null;
}

/** For the sign-in form: the Set-Cookie value when the token is right, otherwise null. HttpOnly and SameSite=Strict; Secure in production. */
export function signIn(given${t(ctx, ': unknown')})${t(ctx, ': string | null')} {
  const token = staffToken();
  if (token === undefined || !sameText(given, token)) return null;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return STAFF_COOKIE + '=' + cookieFor(token) + '; HttpOnly; SameSite=Strict; Path=' + BASE + secure;
}

/** Called once at startup: in production, say that the starter sign-in is on. */
export function announce()${t(ctx, ': void')} {
  if (announced || staffToken() === undefined || process.env.NODE_ENV !== 'production') return;
  announced = true;
  console.warn('chatwarden: starter staff sign-in is on; replace authorize() with your own');
}

${address}// TODO(identity): your game's own session or account id goes here. A key the client chooses lets one person make many identities.
export function identify(req${t(ctx, ': KitRequest')})${t(ctx, ': RawWho')} {
  const key = req.headers['x-chatwarden-key'];
${proxyNote}  return { ...(key === undefined || key === '' ? {} : { clientKey: key }), ip: ${addressOf} };
}

// TODO(identity): the name other players see. It is "Player N", counted per key and never any part of it; use your players' real display names.
export function join(req${t(ctx, ': KitRequest')}, roomId${t(ctx, ': string')})${t(ctx, ': { name: string } | null')} {
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
`;
  return [{ path: `${answers.dir}/auth${ctx.scriptExt}`, content, markers: ['TODO(auth)', 'TODO(identity)'] }];
}
