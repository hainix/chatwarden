import { hmacSha256Hex } from './crypto.js';
import { b64urlDecode, b64urlEncode } from './staffReports.js';

// The signed appeal link: a capability for ONE sanction notice, not a login. Internal (not exported from the index); the appeal service mints and
// opens it. Nothing here may import a Node module (core is browser-safe).
//
// token = payload '.' signature
//   payload   = base64url (no padding) of the UTF-8 JSON {"v":1,"n":<noticeId>,"e":<expiresAt ms>}   (no subject, key, account or address)
//   signature = base64url (no padding) of the 32 bytes HMAC-SHA256(secret, 'chatwarden.appeal.v1.' + payload)   (the payload as sent)
// The namespace prefix keeps a MAC made for any other purpose (the holdback hash, the evidence bundle) from ever verifying here. The MAC is checked
// BEFORE the payload is parsed, so a forged token never reaches the JSON parser, and every failure is the same `{ ok: false }`.

const PREFIX = 'chatwarden.appeal.v1.';
const MAX_TOKEN = 512;
const SHAPE = /^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/;
const ID_MAX = 64;

/** The 64 lowercase hex characters of a MAC as base64url (no padding): 43 characters. */
function macSegment(secret: string, payloadSegment: string): string {
  const hex = hmacSha256Hex(secret, PREFIX + payloadSegment);
  let bin = '';
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const validNoticeId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= ID_MAX;

/** Make a token for `noticeId` that stops working at `expiresAt` (epoch ms). A notice id of 1 to 64 characters and a safe integer time, else `RangeError`. */
export function mintAppealToken(secret: string, noticeId: string, expiresAt: number): string {
  if (!validNoticeId(noticeId)) throw new RangeError('appeal link: invalid notice id');
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) throw new RangeError('appeal link: invalid expiry');
  const payload = b64urlEncode(JSON.stringify({ v: 1, n: noticeId, e: expiresAt }));
  return `${payload}.${macSegment(secret, payload)}`;
}

/** Compare two strings of the same length without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Open a token. Never throws. Order: shape, MAC (constant time), then the payload (`v` is 1, `n` a string of 1 to 64 characters, `e` a safe integer),
 * then `e > now`. Every failure is `{ ok: false }` with no detail.
 */
export function verifyAppealToken(secret: string, token: unknown, now: number): { ok: true; noticeId: string; expiresAt: number } | { ok: false } {
  const bad = { ok: false } as const;
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN || !SHAPE.test(token)) return bad;
    const dot = token.indexOf('.');
    const payloadSegment = token.slice(0, dot);
    const given = token.slice(dot + 1);
    if (!sameText(macSegment(secret, payloadSegment), given)) return bad;
    const text = b64urlDecode(payloadSegment);
    if (text === null) return bad;
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad;
    const { v, n, e } = body as Record<string, unknown>;
    if (v !== 1 || !validNoticeId(n) || typeof e !== 'number' || !Number.isSafeInteger(e)) return bad;
    if (!(e > now)) return bad;
    return { ok: true, noticeId: n, expiresAt: e };
  } catch {
    return bad;
  }
}

/** What `ChatwardenOptions.appeals` becomes: the page's address (or none) and the origins a script may read it from, frozen. */
export interface LandingOptions {
  landingUrl: string | null;
  landingOrigins: readonly string[];
}

const LANDING_URL_MAX = 2000;
const LANDING_ORIGINS_MAX = 20;
const isWebUrl = (url: URL): boolean => url.protocol === 'http:' || url.protocol === 'https:';

/**
 * Check `ChatwardenOptions.appeals` once, at creation. `RangeError` naming `appeals.landingUrl` or `appeals.landingOrigins` (or `appeals` for the object itself) and never echoing
 * a value: an unknown key; a `landingUrl` that is not a string of at most 2000 characters that parses as an http or https address with no credentials, no fragment and no query
 * string; a `landingOrigins` that is not a list of at most 20 origins, each exactly `new URL(origin).origin` (so a path, a trailing slash, `*` and `null` are refused).
 */
export function resolveLandingOptions(input: unknown): LandingOptions {
  if (input === undefined) return { landingUrl: null, landingOrigins: Object.freeze([]) };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RangeError('createChatwarden: appeals must be an object');
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'landingUrl' && key !== 'landingOrigins') throw new RangeError('createChatwarden: appeals has an option that is not known (landingUrl and landingOrigins are the two)');
  }
  const url: unknown = o.landingUrl;
  const origins: unknown = o.landingOrigins;
  let landingUrl: string | null = null;
  if (url !== undefined) {
    const fail = (): never => {
      throw new RangeError('createChatwarden: appeals.landingUrl must be an http or https address of at most 2000 characters with no credentials, no fragment and no query string');
    };
    if (typeof url !== 'string' || url.length === 0 || url.length > LANDING_URL_MAX || url.includes('#') || url.includes('?')) fail();
    let parsed: URL | null = null;
    try {
      parsed = new URL(url as string);
    } catch {
      fail();
    }
    if (parsed === null || !isWebUrl(parsed) || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || parsed.search !== '') fail();
    landingUrl = url as string;
  }
  let landingOrigins: readonly string[] = Object.freeze([]);
  if (origins !== undefined) {
    const fail = (): never => {
      throw new RangeError('createChatwarden: appeals.landingOrigins must be a list of at most 20 origins such as https://your-game.test (no path, no trailing slash)');
    };
    if (!Array.isArray(origins) || origins.length > LANDING_ORIGINS_MAX) fail();
    const list: string[] = [];
    for (const item of origins as unknown[]) {
      if (typeof item !== 'string') fail();
      let parsed: URL | null = null;
      try {
        parsed = new URL(item as string);
      } catch {
        fail();
      }
      if (parsed === null || !isWebUrl(parsed) || parsed.origin !== item) fail();
      list.push(item as string);
    }
    landingOrigins = Object.freeze(list);
  }
  return { landingUrl, landingOrigins };
}
