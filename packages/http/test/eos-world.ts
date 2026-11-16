// The fake Epic Online Services for the adapter's tests (K5 E1): a `fetch` that is as strict as the documented Web APIs
// (https://dev.epicgames.com/docs/web-api-ref/sanctions-web-apis, .../player-reports-web-apis, .../connect-web-api, read 2026-11-16). It is written from the
// documented wire format and does NOT import the adapter's own code, so a field the adapter gets wrong is refused here. No network: nothing in this file opens a socket.
// UNVERIFIED against the real service (design section 15): that `duration: 0` is permanent on create, the batch limit for `reportedPlayerId`, rate limits, the error
// bodies, and what an unknown `referenceId` answers on a delete (this fake answers 404).

import { createHash } from 'node:crypto';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { eos } from '../src/eos/index.js';
import type { EosAdapter, EosOptions } from '../src/eos/index.js';
import { world } from './world.js';
import type { WorldOptions } from './world.js';

export const EOS_URL = 'https://api.epicgames.dev';
export const DEPLOYMENT = 'deployment0zorbak0000000000000001';
export const CLIENT_ID = 'xyzclientid0vlemmo0000000000001';
export const CLIENT_SECRET = 'fake-secret-quissel-0123456789-snerp';

export interface Call {
  method: string;
  url: string;
  path: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}

/** One scripted answer for the next request of a kind. */
export interface Scripted {
  /** Which request it answers: the token endpoint, a create, a delete, a user query or a report find. */
  on: 'token' | 'create' | 'delete' | 'user' | 'reports';
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Never answer (the attempt is aborted by its signal). */
  hang?: boolean;
  /** Reject like a network failure. */
  fail?: boolean;
  /** For a create: do it, then answer like a network failure (the answer is lost, so the sanction exists and the caller does not know). */
  lose?: boolean;
}

export interface EosSanction {
  referenceId: string;
  productUserId: string;
  action: string;
  justification: string;
  source: string;
  tags: string[];
  metadata: Record<string, string>;
  duration: number | null;
  automated: boolean;
  pending: boolean;
  status: 'Active' | 'Removed';
  createdAt: string;
}

export interface EosReport {
  time: string;
  reportingPlayerId: string;
  reportedPlayerId: string;
  reasonId: number;
  message?: string;
  context?: string;
}

export interface FakeEosOptions {
  clientId?: string;
  clientSecret?: string;
  deploymentId?: string;
  /** `expires_in` of every token (default 3599, as the docs' example). */
  expiresIn?: number;
  /** The most `reportedPlayerId` values the fake accepts in one find (the real limit is UNVERIFIED). Default 50. */
  maxReportedIds?: number;
}

const ACTION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE_RE = /^[A-Za-z0-9_-]{2,64}$/;
const TAG_RE = /^[A-Za-z0-9_-]{1,16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every way one element of a create body departs from the documented schema (empty when it is valid). */
export function sanctionProblems(el: unknown): string[] {
  const p: string[] = [];
  if (!isObj(el)) return ['element: not an object'];
  const allowed = ['productUserId', 'action', 'justification', 'source', 'duration', 'tags', 'pending', 'automated', 'metadata', 'displayName', 'identityProvider', 'accountId'];
  for (const k of Object.keys(el)) if (!allowed.includes(k)) p.push(`unexpected key ${k}`);
  if (typeof el['productUserId'] !== 'string' || el['productUserId'].length === 0) p.push('productUserId: required');
  if (typeof el['action'] !== 'string' || !ACTION_RE.test(el['action'])) p.push('action: must match [A-Za-z0-9_-]{1,64}');
  if (typeof el['justification'] !== 'string' || el['justification'].length < 1 || el['justification'].length > 2048) p.push('justification: 1..2048');
  if (typeof el['source'] !== 'string' || !SOURCE_RE.test(el['source'])) p.push('source: must match [A-Za-z0-9_-]{2,64}');
  const d = el['duration'];
  if (d !== undefined && !(typeof d === 'number' && Number.isInteger(d) && d >= 0)) p.push('duration: integer seconds, 0 or more');
  const tags = el['tags'];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) p.push('tags: not an array');
    else {
      const seen = new Set<string>();
      for (const t of tags) {
        if (typeof t !== 'string' || !TAG_RE.test(t)) p.push('tags: each must match [A-Za-z0-9_-]{1,16}');
        else if (seen.has(t.toLowerCase())) p.push('tags: items are unique, case insensitive');
        else seen.add(t.toLowerCase());
      }
    }
  }
  for (const k of ['pending', 'automated']) if (el[k] !== undefined && typeof el[k] !== 'boolean') p.push(`${k}: not a boolean`);
  const meta = el['metadata'];
  if (meta !== undefined) {
    if (!isObj(meta)) p.push('metadata: not an object');
    else {
      const keys = Object.keys(meta);
      if (keys.length > 25) p.push('metadata: at most 25 pairs');
      for (const k of keys) {
        if (k.length < 1 || k.length > 64) p.push('metadata: key 1..64');
        const v = meta[k];
        if (typeof v !== 'string' || v.length > 128) p.push('metadata: value is a string of at most 128');
      }
    }
  }
  return p;
}

/** A `fetch` that behaves like the documented EOS Web APIs. Records every call; refuses anything the docs do not allow. */
export function fakeEos(options: FakeEosOptions = {}) {
  const clientId = options.clientId ?? CLIENT_ID;
  const clientSecret = options.clientSecret ?? CLIENT_SECRET;
  const deployment = options.deploymentId ?? DEPLOYMENT;
  const expiresIn = options.expiresIn ?? 3599;
  const maxReportedIds = options.maxReportedIds ?? 50;
  const calls: Call[] = [];
  const script: Scripted[] = [];
  /** Methods or paths the docs do not have, recorded and answered 405. */
  const refused: string[] = [];
  /** Problems found in each create element (an invalid one is answered 400). */
  const schemaProblems: string[][] = [];
  const sanctions: EosSanction[] = [];
  const reports: EosReport[] = [];
  const valid = new Set<string>();
  let tokens = 0;
  let refSeq = 0;
  let tick = 0;
  /** Count of finds refused because both player filters were empty (the adapter must never cause one). */
  const state = { bothEmptyRefusals: 0, tokenRequests: 0, withoutPagination: 0 };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const empty = (status: number): Response => new Response(null, { status });

  const take = (on: Scripted['on']): Scripted | undefined => {
    const i = script.findIndex((s) => s.on === on);
    return i < 0 ? undefined : script.splice(i, 1)[0];
  };
  const scripted = (s: Scripted, signal: AbortSignal | undefined): Promise<Response> | null => {
    if (s.fail === true) return Promise.reject(new TypeError('fetch failed'));
    if (s.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    if (s.status !== undefined) return Promise.resolve(json(s.status, s.body ?? { errorCode: 'scripted' }, s.headers));
    return null;
  };

  const fn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown = init?.body;
    if (typeof init?.body === 'string' && headers['content-type']?.startsWith('application/json') === true) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const query: Array<[string, string]> = [...url.searchParams.entries()];
    calls.push({ method, url: url.toString(), path: url.pathname, query, headers, body, redirect: init?.redirect });
    const signal = init?.signal ?? undefined;
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/auth/v1/oauth/token') {
      state.tokenRequests++;
      if (method !== 'POST') return Promise.resolve(empty(405));
      const s = take('token');
      if (s !== undefined) {
        const r = scripted(s, signal);
        if (r !== null) return r;
      }
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (headers['authorization'] !== expected) return Promise.resolve(json(401, { errorCode: 'errors.com.epicgames.common.oauth.invalid_client' }));
      if (headers['content-type'] !== 'application/x-www-form-urlencoded') return Promise.resolve(json(400, { errorCode: 'content-type' }));
      const form = new URLSearchParams(typeof body === 'string' ? body : '');
      if (form.get('grant_type') !== 'client_credentials') return Promise.resolve(json(400, { errorCode: 'grant_type' }));
      if (form.get('deployment_id') !== deployment) return Promise.resolve(json(400, { errorCode: 'deployment_id' }));
      const token = `fake-access-token-${++tokens}`;
      valid.add(token);
      return Promise.resolve(json(200, { access_token: token, token_type: 'bearer', expires_in: expiresIn, deployment_id: deployment, product_id: 'product0', sandbox_id: 'sandbox0' }));
    }

    const auth = headers['authorization'];
    if (auth === undefined || !auth.startsWith('Bearer ') || !valid.has(auth.slice(7))) return Promise.resolve(json(401, { errorCode: 'errors.com.epicgames.common.authentication.token_verification_failed' }));

    const sanctionsPath = `/sanctions/v1/${deployment}/sanctions`;
    if (path === sanctionsPath && method === 'POST') {
      const s = take('create');
      if (s !== undefined && s.lose !== true) {
        const r = scripted(s, signal);
        if (r !== null) return r;
      }
      if (!Array.isArray(body) || body.length < 1) return Promise.resolve(json(400, { errorCode: 'body' }));
      const all: string[][] = body.map((el) => sanctionProblems(el));
      schemaProblems.push(...all);
      if (all.some((p) => p.length > 0)) return Promise.resolve(json(400, { errorCode: 'schema' }));
      const made: EosSanction[] = (body as Array<Record<string, unknown>>).map((el) => {
        const seq = ++refSeq;
        const duration = typeof el['duration'] === 'number' ? el['duration'] : null;
        const made: EosSanction = {
          referenceId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          productUserId: el['productUserId'] as string,
          action: el['action'] as string,
          justification: el['justification'] as string,
          source: el['source'] as string,
          tags: (el['tags'] as string[] | undefined) ?? [],
          metadata: (el['metadata'] as Record<string, string> | undefined) ?? {},
          duration,
          automated: el['automated'] === true,
          pending: el['pending'] === true,
          status: 'Active',
          createdAt: new Date(1_800_000_000_000 + ++tick * 1000).toISOString(),
        };
        sanctions.push(made);
        return made;
      });
      if (s?.lose === true) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(json(200, { elements: made.map((m) => ({ ...m, deploymentId: deployment, expirationTimestamp: null, timestamp: m.createdAt })) }));
    }
    if (path === sanctionsPath && method === 'DELETE') {
      const s = take('delete');
      if (s !== undefined) {
        const r = scripted(s, signal);
        if (r !== null) return r;
      }
      const ids = isObj(body) ? body['referenceIds'] : undefined;
      const why = isObj(body) ? body['justification'] : undefined;
      if (!Array.isArray(ids) || ids.length < 1 || ids.some((x) => typeof x !== 'string')) return Promise.resolve(json(400, { errorCode: 'referenceIds' }));
      if (why !== undefined && !(typeof why === 'string' && why.length >= 1 && why.length <= 2048)) return Promise.resolve(json(400, { errorCode: 'justification' }));
      const found = (ids as string[]).map((id) => sanctions.find((x) => x.referenceId === id));
      if (found.some((x) => x === undefined)) return Promise.resolve(json(404, { errorCode: 'not_found' }));
      for (const x of found) if (x !== undefined) x.status = 'Removed';
      return Promise.resolve(empty(204));
    }
    const userMatch = new RegExp(`^/sanctions/v1/${deployment}/users/([^/]+)$`).exec(path);
    if (userMatch !== null && method === 'GET') {
      const s = take('user');
      if (s !== undefined) {
        const r = scripted(s, signal);
        if (r !== null) return r;
      }
      const id = decodeURIComponent(userMatch[1] as string);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return Promise.resolve(json(400, { errorCode: 'paging' }));
      const mine = sanctions.filter((x) => x.productUserId === id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return Promise.resolve(
        json(200, {
          elements: mine.slice(offset, offset + limit).map((m) => ({ ...m, deploymentId: deployment })),
          paging: { total: mine.length, offset, limit },
        }),
      );
    }

    const reportsPath = `/player-reports/v1/report/${deployment}`;
    if (path === reportsPath && method === 'GET') {
      const s = take('reports');
      if (s !== undefined) {
        const r = scripted(s, signal);
        if (r !== null) return r;
      }
      const reporting = url.searchParams.getAll('reportingPlayerId');
      const reported = url.searchParams.getAll('reportedPlayerId');
      if (reporting.length === 0 && reported.length === 0) {
        state.bothEmptyRefusals++;
        return Promise.resolve(json(400, { errorCode: 'reportingPlayerId and reportedPlayerId cannot both be empty' }));
      }
      if (reported.length > maxReportedIds) return Promise.resolve(json(400, { errorCode: 'too many reportedPlayerId' }));
      const start = url.searchParams.get('startTime');
      let startMs = -Infinity;
      if (start !== null) {
        if (!ISO_RE.test(start) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(start)) return Promise.resolve(json(400, { errorCode: 'startTime' }));
        startMs = Date.parse(start.endsWith('Z') ? start : `${start}Z`);
      }
      const pagination = url.searchParams.get('pagination') === 'true';
      if (!pagination) state.withoutPagination++;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return Promise.resolve(json(400, { errorCode: 'paging' }));
      const order = url.searchParams.get('order') ?? 'time:desc';
      if (!['time:asc', 'time:desc', 'reasonId:asc', 'reasonId:desc'].includes(order)) return Promise.resolve(json(400, { errorCode: 'order' }));
      const reasons = url.searchParams.getAll('reasonId').map(Number);
      let rows = reports.filter(
        (r) =>
          (reporting.length === 0 || reporting.includes(r.reportingPlayerId)) &&
          (reported.length === 0 || reported.includes(r.reportedPlayerId)) &&
          (reasons.length === 0 || reasons.includes(r.reasonId)) &&
          Date.parse(r.time) > startMs,
      );
      const dir = order.endsWith('asc') ? 1 : -1;
      rows = [...rows].sort((a, b) => (order.startsWith('time') ? Date.parse(a.time) - Date.parse(b.time) : a.reasonId - b.reasonId) * dir);
      const page = pagination ? rows.slice(offset, offset + limit) : rows;
      const elements = page.map((r) => ({ productId: 'product0', sandboxId: 'sandbox0', deploymentId: deployment, ...r }));
      return Promise.resolve(json(200, pagination ? { elements, paging: { offset, limit, total: rows.length } } : { elements }));
    }

    refused.push(`${method} ${path}`);
    return Promise.resolve(json(405, { errorCode: 'method' }));
  }) as unknown as typeof fetch;

  return {
    fetch: fn,
    calls,
    script,
    refused,
    schemaProblems,
    sanctions,
    reports,
    state,
    /** Add a player report as a client would have written it. */
    addReport(r: Partial<EosReport> & Pick<EosReport, 'reportingPlayerId' | 'reportedPlayerId'>): EosReport {
      const full: EosReport = { time: new Date(1_800_000_000_000).toISOString(), reasonId: 4, ...r };
      reports.push(full);
      return full;
    },
    /** Make every token issued so far invalid (the next API call is a 401). */
    expireTokens: () => valid.clear(),
    tokensIssued: () => tokens,
    /** Calls to a path that ends with `suffix`. */
    callsTo: (suffix: string, m?: string) => calls.filter((c) => c.path.endsWith(suffix) && (m === undefined || c.method === m)),
  };
}
export type FakeEos = ReturnType<typeof fakeEos>;

/** A recording logger. */
export function recordingLogger() {
  const logged: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
  return { logged, logger: { warn: (event: string, detail?: Record<string, string | number | boolean>) => void logged.push([event, detail]) } };
}

// ---- a whole adapter on a real kit ----

type W = Awaited<ReturnType<typeof world>>;

export interface EosWorldOptions {
  /** Extra or replaced `sanctions` options; `false` leaves the push off. */
  sanctions?: Record<string, unknown> | false;
  /** Extra or replaced `reports` options; `false` leaves the pull off. */
  reports?: Record<string, unknown> | false;
  /** Other adapter options. */
  options?: Record<string, unknown>;
  world?: WorldOptions;
  fake?: FakeEosOptions;
  /** Wrap the kit the ADAPTER sees (a proxy that fails a call); the test still reads the real one through `cw` and `w`. */
  wrapKit?: (cw: Chatwarden) => Chatwarden;
}

/** The hex sha256 the adapter's link keys are built from. */
export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The `eos-sanction` link key for a group and a product user id (design 5.1). */
export const sanctionKey = (groupId: string, productUserId: string): string => `${groupId}#${sha(productUserId).slice(0, 16)}`;
/** The `eos-report` link key (design 5.1). */
export const reportKey = (r: { time: string; reportingPlayerId: string; reportedPlayerId: string; reasonId: number }): string => sha(`${r.time}|${r.reportingPlayerId}|${r.reportedPlayerId}|${r.reasonId}`);

/** An adapter on kit world `w` (the kit keeps its own clock), with a fake EOS, the adopter's two maps as plain tables, and a recording logger. */
export function makeEos(w: W, over: EosWorldOptions = {}) {
  const fake = fakeEos(over.fake);
  const { logged, logger } = recordingLogger();
  /** subject (any alias) -> product user ids: the adopter's own account table. */
  const accounts = new Map<string, string[]>();
  /** product user id -> seat: the adopter's session table. */
  const seats = new Map<string, { roomId: string; seatId: string } | null>();
  /** Who `reports.players()` names. */
  const players: string[] = [];
  /** Every call of productUserIdsOf, as [subject, aliases]. */
  const resolved: Array<[string, readonly string[]]> = [];
  /** Handlers the adapter subscribed, so a test can raise an event the kit does not raise by itself. */
  const subs: Array<[string, (e: KitEvent) => void]> = [];
  const base = over.wrapKit === undefined ? w.cw : over.wrapKit(w.cw);
  const kit = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'on') {
        return (type: string, fn: (e: KitEvent) => void) => {
          subs.push([type, fn]);
          return (target.on as (t: string, f: (e: KitEvent) => void) => () => void)(type, fn);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const adapter: EosAdapter = eos(kit, {
    deploymentId: DEPLOYMENT,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    baseUrl: EOS_URL,
    ...(over.sanctions === false
      ? {}
      : {
          sanctions: {
            productUserIdsOf: (subject: string, aliases: readonly string[]) => {
              resolved.push([subject, aliases]);
              return [...new Set(aliases.flatMap((a) => accounts.get(a) ?? []))];
            },
            actions: { chat: 'chatwarden-chat', area: 'chatwarden-area', ban: 'chatwarden-ban' },
            ...over.sanctions,
          },
        }),
    ...(over.reports === false
      ? {}
      : {
          reports: {
            seatOf: (id: string) => seats.get(id) ?? null,
            players: () => [...players],
            ...over.reports,
          },
        }),
    fetch: fake.fetch,
    clock: w.clock,
    random: () => 0.5,
    logger,
    ...over.options,
  } as unknown as EosOptions);
  /** Raise an event to the adapter's own subscription (the kit's `auto.restricted` needs a matcher; this is the same call). */
  const emit = (event: KitEvent): void => {
    for (const [type, fn] of subs) if (type === event.type || type === '*') fn(event);
  };
  return { w, cw: w.cw, fake, adapter, logged, accounts, seats, players, resolved, subs, emit };
}

/** A kit world with an adapter already subscribed. */
export async function eosWorld(over: EosWorldOptions = {}) {
  const w = await world(over.world);
  return makeEos(w, over);
}
export type EosWorld = Awaited<ReturnType<typeof eosWorld>>;

/** One turn of the event loop: everything already queued (promise callbacks, the fake's answers) runs first. No clock is read and no timer is set. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Wait until `check` holds by giving the event loop turns, up to a fixed number of them (a bound on how much work may be chained, not on time). Not for a test
 * with fake timers (they fake `setImmediate`): use `vi.advanceTimersByTimeAsync` there.
 */
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await turn();
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** Let the adapter run everything it is going to run on its own (a fixed number of turns), for a test that asserts something did NOT happen. */
export async function idle(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await turn();
}
