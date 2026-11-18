import { ALICE, HOUR, playerWorld } from './playerWorld.js';
import type { PlayerWorld, PlayerWorldOptions } from './playerWorld.js';
import type { KitResponse } from '@chatwarden/http';

// A world for the appeal landing routes: the player world with appeals on and the landing options set, a way to mint a real link for a real sanction notice, and short
// helpers that call the four landing routes the way a browser or a game server would. `identify` is a spy: the landing routes must never call it.

export const LANDING = 'https://game.example/appeal';
export const ORIGIN = 'https://game.example';
export const ID_RE = /s_[A-Za-z0-9_-]{22}/;

export interface LandingWorldOptions extends PlayerWorldOptions {
  /** The kit's `appeals` landing options (default: `{ landingUrl: LANDING, landingOrigins: [ORIGIN] }`). */
  landing?: { landingUrl?: string; landingOrigins?: string[] } | false;
  /** Options of the player routes (limits, ...). */
  routeOptions?: Record<string, unknown>;
}

export async function landingWorld(over: LandingWorldOptions = {}) {
  const identifyCalls: unknown[] = [];
  const landing = over.landing === undefined ? { landingUrl: LANDING, landingOrigins: [ORIGIN] } : over.landing;
  const w = await playerWorld({
    ...over,
    kit: { ...(landing === false ? {} : { appeals: landing }), ...(over.kit ?? {}) },
    routes: {
      identify: (req: unknown) => {
        identifyCalls.push(req);
        return {};
      },
      ...(over.routeOptions ?? {}),
      ...(over.routes ?? {}),
    },
  });

  const tokenOf = (url: string | null): string => {
    if (url === null) throw new Error('expected a link');
    return new URL(url).searchParams.get('t') as string;
  };
  /** A real link for a notice, as the token alone. */
  const tokenFor = (noticeId: string, opts?: { ttlMs?: number }): string => tokenOf(w.cw.appeals.link(noticeId, opts));
  /** Sanction a player for real and give back the sanction, its notice and a token for it. */
  const sanctioned = async (who = ALICE, o: Parameters<PlayerWorld['sanction']>[1] = {}) => {
    const s = await w.sanction(who, o);
    return { ...s, token: tokenFor(s.noticeId) };
  };

  const header = (res: KitResponse, name: string): string | undefined => res.headers?.[name];
  const page = (token: string | undefined, o: { query?: Record<string, string>; headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    w.call('GET', '/appeal', { query: { ...(token === undefined ? {} : { t: token }), ...(o.query ?? {}) }, ...(o.headers === undefined ? {} : { headers: o.headers }), ...(o.remoteAddress === undefined ? {} : { remoteAddress: o.remoteAddress }) });
  const caseJson = (token: string | undefined, o: { query?: Record<string, string>; headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    w.call('GET', '/appeal/case', { query: { ...(token === undefined ? {} : { t: token }), ...(o.query ?? {}) }, ...(o.headers === undefined ? {} : { headers: o.headers }), ...(o.remoteAddress === undefined ? {} : { remoteAddress: o.remoteAddress }) });
  const postJson = (body: unknown, o: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    w.call('POST', '/appeal/case', { body, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, ...(o.remoteAddress === undefined ? {} : { remoteAddress: o.remoteAddress }) });
  const postForm = (fields: Record<string, string>, o: { headers?: Record<string, string>; remoteAddress?: string; raw?: string } = {}) =>
    w.call('POST', '/appeal/case', {
      raw: o.raw ?? new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o.headers ?? {}) },
      ...(o.remoteAddress === undefined ? {} : { remoteAddress: o.remoteAddress }),
    });
  const options = (origin?: string, o: { remoteAddress?: string } = {}) =>
    w.call('OPTIONS', '/appeal/case', { ...(origin === undefined ? {} : { headers: { origin } }), ...(o.remoteAddress === undefined ? {} : { remoteAddress: o.remoteAddress }) });

  /** The appeal rows of the store (every status). */
  const appealRows = () => w.store.listAppeals({ status: 'all', limit: 200 });

  /** Take the clock forward. */
  const advance = (ms: number) => void (w.clock.t += ms);
  return { ...w, identifyCalls, tokenOf, tokenFor, sanctioned, header, page, caseJson, postJson, postForm, options, appealRows, advance, HOUR };
}

export type LandingWorld = Awaited<ReturnType<typeof landingWorld>>;

/** The html of a page answer (a string body). */
export const htmlOf = (res: KitResponse): string => {
  if (typeof res.body !== 'string') throw new Error('expected an html string body');
  return res.body;
};
/** The location header of a redirect answer. */
export const locationOf = (res: KitResponse): string => res.headers?.location ?? '';

/** Everything an answer carries as one comparable string: status, headers (sorted) and body. */
export const bytesOf = (res: KitResponse): string => JSON.stringify({ status: res.status, headers: Object.entries(res.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)), body: res.body });
