import type { AppealCase } from '@chatwarden/core';
import { PlayerError } from '../client.js';

// The client of the appeal page (appeals landing): `GET <endpoint>?t=<token>` reads the case and `POST <endpoint>` files the appeal, as json `{ t, statement }`, on the game's own
// server (the `/appeal/case` route of `@chatwarden/http`). The link is the capability: no cookie, no Authorization header, no referrer and no cache are used, and this file never
// reads the page's storage, cookies or address (the page hands the token in). The token and the statement are never put in an error or logged.
//
// What `send` makes of the answer (one test pins each row):
//   200                        -> { ok: true, case }          the case the route returned (a 200 whose body is not a case is `failed`)
//   400, 413                   -> { ok: false, refused: 'invalid' }   the statement (empty, too long, or a body the route did not accept)
//   409                        -> { ok: false, refused: 'already' }
//   429                        -> { ok: false, refused: 'rate', retryAfterMs }   `retry-after` whole seconds times 1000; 60000 when missing or unreadable
//   404                        -> { ok: false, refused: 'link' }      the link no longer opens, or the decision can no longer be appealed (one answer; the page shows its invalid state)
//   any other status, a thrown fetch -> { ok: false, refused: 'failed' }
// `load` answers 404 with 'invalid'; any other failure rejects with a `PlayerError` that holds no token and no address.

export interface AppealPageClient {
  /** The case behind a link: the case, or `'invalid'` for a link that does not open. Rejects with a `PlayerError` for any other failure. */
  load(token: string): Promise<AppealCase | 'invalid'>;
  /** Files the appeal. A refusal is a value; nothing here throws. */
  send(token: string, statement: string): Promise<{ ok: true; case: AppealCase } | { ok: false; refused: 'invalid' | 'already' | 'rate' | 'link' | 'failed'; retryAfterMs?: number }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const KINDS: readonly string[] = ['warning', 'chat', 'area', 'ban'];
const STATUSES: readonly string[] = ['open', 'upheld', 'reduced', 'revoked'];
const STATES: readonly string[] = ['active', 'ended', 'lifted'];
// The fixed reasons a decision can carry (core's `APPEAL_REASONS`, written out so this entry imports no run-time value of core's index); a code this list does not hold is dropped.
const REASONS: ReadonlySet<string> = new Set([
  'rule_applies',
  'evidence_clear',
  'first_offence',
  'lighter_fits',
  'mistake',
  'not_a_violation',
  'context_considered',
]);

type Appeal = NonNullable<AppealCase['appeal']>;
type Standing = NonNullable<AppealCase['standing']>;

/** One case, keeping only the fields the kit documents for the page, each only when it has the right type; null for a body that is not a case. */
function caseOf(raw: unknown): AppealCase | null {
  if (!isObject(raw)) return null;
  const n = raw.notice;
  if (!isObject(n) || !text(n.kind) || !KINDS.includes(n.kind) || !num(n.createdAt)) return null;
  if (typeof raw.canAppeal !== 'boolean' || !num(raw.expiresAt) || !num(raw.statementMax) || raw.statementMax < 1) return null;
  const excerpt = Array.isArray(n.excerpt) ? n.excerpt.filter(isObject).filter((l) => text(l.text) && text(l.day)).map((l) => ({ text: l.text as string, day: l.day as string })) : [];
  const a = raw.appeal;
  const appeal: Appeal | null =
    isObject(a) && text(a.status) && STATUSES.includes(a.status) && num(a.createdAt) && (a.decidedAt === null || num(a.decidedAt))
      ? { status: a.status as Appeal['status'], createdAt: a.createdAt, decidedAt: a.decidedAt, reason: text(a.reason) && REASONS.has(a.reason) ? (a.reason as Appeal['reason']) : null }
      : null;
  const s = raw.standing;
  const standing: Standing | null =
    isObject(s) && text(s.kind) && KINDS.includes(s.kind) && (s.until === null || num(s.until)) && text(s.state) && STATES.includes(s.state)
      ? { kind: s.kind as Standing['kind'], until: s.until, state: s.state as Standing['state'] }
      : null;
  return {
    notice: {
      kind: n.kind as AppealCase['notice']['kind'],
      rule: num(n.rule) || n.rule === 'uncovered' ? n.rule : null,
      ruleLabel: text(n.ruleLabel) ? n.ruleLabel : null,
      until: num(n.until) ? n.until : null,
      refCode: text(n.refCode) ? n.refCode : null,
      createdAt: n.createdAt,
      excerpt,
    },
    canAppeal: raw.canAppeal,
    appeal,
    standing,
    expiresAt: raw.expiresAt,
    emailsOutcome: raw.emailsOutcome === true,
    contact: text(raw.contact) ? raw.contact : null,
    statementMax: raw.statementMax,
  };
}

/** The `t` parameter of a query string (`?t=...` or `t=...`), only when it is a token's characters and at most 512 of them; null otherwise (and for two values). */
export function readAppealToken(search: string): string | null {
  if (typeof search !== 'string') return null;
  const values = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).getAll('t');
  const [only] = values;
  return values.length === 1 && only !== undefined && /^[A-Za-z0-9_.-]{1,512}$/.test(only) ? only : null;
}

// Every request: no cookie, no referrer, no cache, and a cross-origin read (the game's page and its server may differ; the server names the origins it allows).
const SAFE: Pick<RequestInit, 'credentials' | 'referrerPolicy' | 'cache' | 'mode'> = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' };

const bodyOf = async (res: Response): Promise<unknown> => {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
};

/** Whole seconds of a `retry-after` header in milliseconds, or a minute when the header is missing or not whole seconds. */
const waitOf = (res: Response): number => {
  const raw = res.headers.get('retry-after');
  return raw !== null && /^\d{1,7}$/.test(raw) ? Number(raw) * 1000 : 60_000;
};

export function createAppealPageClient({ endpoint, fetch: custom }: { endpoint: string; fetch?: typeof fetch }): AppealPageClient {
  const call = (url: string, init: RequestInit): Promise<Response> => (custom !== undefined ? custom(url, init) : fetch(url, init));
  return {
    load: async (token) => {
      const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
      let res: Response;
      try {
        res = await call(url, { ...SAFE, method: 'GET', headers: { accept: 'application/json' } });
      } catch {
        throw new PlayerError({ status: 0, code: 'network', message: 'Could not reach the server.' });
      }
      if (res.status === 404) return 'invalid';
      if (res.status < 200 || res.status > 299) {
        const wait = res.status === 429 ? waitOf(res) / 1000 : undefined;
        throw new PlayerError({ status: res.status, code: `http_${res.status}`, message: `The server answered with status ${res.status}.`, ...(wait === undefined ? {} : { retryAfter: wait }) });
      }
      const found = caseOf(await bodyOf(res));
      if (found === null) throw new PlayerError({ status: 200, code: 'bad_response', message: 'The server sent an answer this page does not understand.' });
      return found;
    },
    send: async (token, statement) => {
      let res: Response;
      try {
        res = await call(endpoint, { ...SAFE, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ t: token, statement }) });
      } catch {
        return { ok: false, refused: 'failed' };
      }
      if (res.status === 200) {
        const found = caseOf(await bodyOf(res));
        return found === null ? { ok: false, refused: 'failed' } : { ok: true, case: found };
      }
      if (res.status === 400 || res.status === 413) return { ok: false, refused: 'invalid' };
      if (res.status === 409) return { ok: false, refused: 'already' };
      if (res.status === 429) return { ok: false, refused: 'rate', retryAfterMs: waitOf(res) };
      if (res.status === 404) return { ok: false, refused: 'link' };
      return { ok: false, refused: 'failed' };
    },
  };
}
