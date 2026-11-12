import type { PlayerNotice, PlayerReporting } from '@chatwarden/core';
import { readReporting } from './reporting.js';
import type { Transport, TransportRequest, TransportResponse } from './transport.js';

/**
 * Why a call to the player routes failed. `status` is the HTTP status, or 0 when no answer arrived. `code` is the kit's error
 * code (`not_found`, `rate_limited`, ...), `network` for a dropped connection, `bad_response` for an answer that is not the
 * shape the components expect, `unexpected` for anything else, and `http_<status>` when the body is not a kit error.
 * `retryAfter` is the seconds from a `retry-after` header (a 429).
 */
export class PlayerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;

  constructor(init: { status: number; code: string; message: string; retryAfter?: number }) {
    super(init.message);
    this.name = 'PlayerError';
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
  }
}

/** A `PlayerError` as is; anything else (a bug in the caller's code, say) becomes status 0, code `unexpected`. */
export function toPlayerError(e: unknown): PlayerError {
  if (e instanceof PlayerError) return e;
  return new PlayerError({ status: 0, code: 'unexpected', message: e instanceof Error ? e.message : 'Something went wrong.' });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';

function errorOf(res: TransportResponse): PlayerError {
  const b = res.body;
  const raw = res.headers['retry-after'];
  const rest = raw !== undefined && /^\d{1,9}$/.test(raw) ? { retryAfter: Number(raw) } : {};
  if (isObject(b) && text(b.error) && text(b.message)) return new PlayerError({ status: res.status, code: b.error, message: b.message, ...rest });
  // A proxy's HTML page, or an empty body: say the status, never echo the body.
  return new PlayerError({ status: res.status, code: `http_${res.status}`, message: `The server answered with status ${res.status}.`, ...rest });
}

/** One call through a transport: the body of a 2xx answer; a `PlayerError` for anything else. The chat transport reuses it. */
export async function send(transport: Transport, req: TransportRequest): Promise<unknown> {
  let res: TransportResponse;
  try {
    res = await transport(req);
  } catch (e) {
    throw new PlayerError({ status: 0, code: 'network', message: e instanceof Error && e.name === 'AbortError' ? 'The request was cancelled.' : 'Could not reach the server.' });
  }
  if (res.status < 200 || res.status > 299) throw errorOf(res);
  return res.body;
}

/** The error for an answer that is not the shape the components expect. */
export const bad = (): PlayerError => new PlayerError({ status: 200, code: 'bad_response', message: 'The server sent an answer these components do not understand.' });

/** One notice, keeping only the fields the kit documents for a player. Anything else the server sent never reaches the page. */
function noticeOf(raw: unknown): PlayerNotice | null {
  if (!isObject(raw) || !text(raw.id) || !text(raw.kind)) return null;
  const excerpt = Array.isArray(raw.excerpt)
    ? raw.excerpt.filter(isObject).filter((l) => text(l.text) && text(l.day)).map((l) => ({ text: l.text as string, day: l.day as string }))
    : [];
  return {
    id: raw.id,
    kind: raw.kind as PlayerNotice['kind'],
    rule: typeof raw.rule === 'number' || raw.rule === 'uncovered' ? raw.rule : null,
    ruleLabel: text(raw.ruleLabel) ? raw.ruleLabel : null,
    until: typeof raw.until === 'number' && Number.isFinite(raw.until) ? raw.until : null,
    refCode: text(raw.refCode) ? raw.refCode : null,
    excerpt,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    mustAcknowledge: raw.mustAcknowledge === true,
  };
}

function noticesOf(body: unknown, key: 'notices' | 'record'): PlayerNotice[] {
  if (!isObject(body) || !Array.isArray(body[key])) throw bad();
  return (body[key] as unknown[]).map(noticeOf).filter((n): n is PlayerNotice => n !== null);
}

/** One rule as `GET /rules` gives it. */
export interface PlayerRule {
  number: number;
  title: string;
  text: string;
}

/** `GET /rules`: the profile's one-line summary, the active rules and how reporting works here (`undefined` from an older server). */
export interface PlayerRules {
  summary: string;
  rules: PlayerRule[];
  /** The flow, the reasons a player may give and the thank-you: pass it to `ReportDialog` as `reporting`. */
  reporting?: PlayerReporting;
}

export interface PlayerClient {
  /** `GET /notices`: notices not yet acknowledged, as the kit sends them (oldest first). */
  notices(): Promise<PlayerNotice[]>;
  /** `POST /notices/:id/ack`: `true` when it was this player's live notice, `false` (still a 200) when it was not, or it is gone. */
  ack(id: string): Promise<boolean>;
  /** `GET /record`: the player's sanctions that still apply (seen or not). */
  record(): Promise<PlayerNotice[]>;
  /** `GET /rules`: the summary, the numbered rules and the reporting settings. */
  rules(): Promise<PlayerRules>;
}

export interface PlayerClientOptions {
  /** How to reach the player routes: `fetchTransport({ baseUrl: '/player' })`, or any function with the same shape. */
  transport: Transport;
}

/** A client over the kit's player routes. It resolves with typed values and rejects with a `PlayerError`. */
export function createPlayerClient({ transport }: PlayerClientOptions): PlayerClient {
  return {
    notices: async () => noticesOf(await send(transport, { method: 'GET', path: '/notices' }), 'notices'),
    record: async () => noticesOf(await send(transport, { method: 'GET', path: '/record' }), 'record'),
    ack: async (id) => {
      const body = await send(transport, { method: 'POST', path: `/notices/${encodeURIComponent(id)}/ack` });
      if (!isObject(body) || typeof body.ok !== 'boolean') throw bad();
      return body.ok;
    },
    rules: async () => {
      const body = await send(transport, { method: 'GET', path: '/rules' });
      if (!isObject(body) || !text(body.summary) || !Array.isArray(body.rules)) throw bad();
      const rules = body.rules
        .filter(isObject)
        .filter((r) => typeof r.number === 'number' && text(r.title) && text(r.text))
        .map((r) => ({ number: r.number as number, title: r.title as string, text: r.text as string }));
      const reporting = readReporting(body.reporting);
      return { summary: body.summary, rules, ...(reporting === undefined ? {} : { reporting }) };
    },
  };
}
