import { discardBody, readBoundedText } from '../internal/boundedText.js';
import type { Attempt } from '../internal/deliveryQueue.js';
import { TokenError, retryAfterOf } from './token.js';
import type { TokenSource } from './token.js';

// A small typed client over `fetch` for the EOS Web API endpoints the adapter uses (K5 design 9). Hosts are fixed at construction; redirects are never followed. A 401
// refreshes the token once and retries once. Every answer, a token failure included, is an {@link EosReply}; only a network failure or an abort rejects, and the delivery
// queue retries that by class. Nothing here logs: the callers decide what is worth a line, and the token source logs its own failures.

/** What came back. `status` 0 means no HTTP answer was had (the token could not be got). `json` is set only for a 2xx whose body is JSON and fits the cap. */
export interface EosReply {
  status: number;
  json?: unknown;
  /** A 429's `retry-after` in milliseconds. */
  retryAfterMs?: number;
}

export interface RequestOptions {
  query?: ReadonlyArray<readonly [string, string]>;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

export interface EosClient {
  request(method: 'GET' | 'POST' | 'DELETE', path: string, o?: RequestOptions): Promise<EosReply>;
  /** `POST /sanctions/v1/{deployment}/sanctions`: a list of sanctions to create. */
  createSanctions(body: readonly unknown[], signal?: AbortSignal): Promise<EosReply>;
  /** `GET /sanctions/v1/{deployment}/users/{productUserId}`: every sanction of one user, newest first, paged. */
  userSanctions(productUserId: string, page: { limit: number; offset: number; signal?: AbortSignal }): Promise<EosReply>;
  /** `DELETE /sanctions/v1/{deployment}/sanctions`: remove by reference id (204). */
  deleteSanctions(referenceIds: readonly string[], justification: string, signal?: AbortSignal): Promise<EosReply>;
  /** `GET /player-reports/v1/report/{deployment}`: reports about these players since `startTime`, oldest first. */
  findReports(q: { reportedPlayerIds: readonly string[]; startTime: string; offset: number; limit: number; signal?: AbortSignal }): Promise<EosReply>;
}

export interface EosClientOptions {
  tokens: TokenSource;
  /** No trailing slash. */
  baseUrl: string;
  deploymentId: string;
  fetch: typeof fetch;
}

/** The most of an answer that is read (a page of 100 sanctions with metadata is well under this). */
const ANSWER_MAX = 2_000_000;

/** How a reply is handled by the delivery queue: 2xx is done; a 429, a 5xx and no answer are retried; any other status is final. */
export function attemptOf(reply: EosReply): Attempt {
  const { status } = reply;
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 429 || status >= 500 || status === 0) {
    return { kind: 'retry', ...(status === 0 ? {} : { status }), ...(reply.retryAfterMs === undefined ? {} : { afterMs: reply.retryAfterMs }) };
  }
  return { kind: 'final', status };
}

/** Make the client. */
export function createEosClient(o: EosClientOptions): EosClient {
  const dep = encodeURIComponent(o.deploymentId);

  const once = (token: string, method: string, path: string, opts: RequestOptions): Promise<Response> => {
    const query = opts.query === undefined || opts.query.length === 0 ? '' : `?${new URLSearchParams(opts.query as Array<[string, string]>).toString()}`;
    const hasBody = opts.body !== undefined;
    return o.fetch(`${o.baseUrl}${path}${query}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      // A redirect would send the token somewhere the adopter did not name.
      redirect: 'manual',
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  };

  const request: EosClient['request'] = async (method, path, opts = {}) => {
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await o.tokens.get();
      } catch (err) {
        if (err instanceof TokenError) return { status: err.status ?? 0, ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }) };
        throw err;
      }
      const res = await once(token, method, path, opts);
      if (res.status === 401 && attempt === 0) {
        discardBody(res);
        o.tokens.invalidate();
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        const text = await readBoundedText(res, ANSWER_MAX);
        if (text === null || text === '') return { status: res.status };
        try {
          return { status: res.status, json: JSON.parse(text) as unknown };
        } catch {
          return { status: res.status };
        }
      }
      // An error body is never read: it is not used, and never logged.
      discardBody(res);
      const after = res.status === 429 ? retryAfterOf(res) : undefined;
      return { status: res.status, ...(after === undefined ? {} : { retryAfterMs: after }) };
    }
  };

  return {
    request,
    createSanctions: (body, signal) => request('POST', `/sanctions/v1/${dep}/sanctions`, { body, signal }),
    userSanctions: (id, page) =>
      request('GET', `/sanctions/v1/${dep}/users/${encodeURIComponent(id)}`, {
        query: [
          ['limit', String(page.limit)],
          ['offset', String(page.offset)],
        ],
        signal: page.signal,
      }),
    deleteSanctions: (ids, justification, signal) => request('DELETE', `/sanctions/v1/${dep}/sanctions`, { body: { referenceIds: ids, justification }, signal }),
    findReports: (q) =>
      request('GET', `/player-reports/v1/report/${dep}`, {
        query: [
          ...q.reportedPlayerIds.map((id) => ['reportedPlayerId', id] as const),
          ['startTime', q.startTime],
          ['pagination', 'true'],
          ['offset', String(q.offset)],
          ['limit', String(q.limit)],
          ['order', 'time:asc'],
        ],
        signal: q.signal,
      }),
  };
}
