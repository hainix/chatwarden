// `createServiceClient`: a typed `fetch` client of the service API (design 3.6), for a Node game that talks to a remote service, and what the conformance tests use. One method per route; the bearer on
// every call; an `Idempotency-Key` made per call (on the three calls whose retry would be judged twice) and reused across that call's own retries; a bounded retry with backoff on a network error and a
// 5xx, never on a 4xx; a refusal is an answer, returned and not thrown; a refusal reason the client does not know is returned as `unknown`. Browser-safe: it uses the platform's `fetch` only.
import { randomHex } from '../chat/random.js';
import type { ServiceWho } from './contract.js';

export type { ServiceWho } from './contract.js';

/** What a call that did not get an answer ends as: the status (0 for a network failure), the error code the service gave and, for a 429, how long to wait. Never holds a key or a response body. */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Why a line, a phrase or a seat was refused, as this client knows them. A reason it does not know is `unknown`, with the original in `rawReason`. */
export const KNOWN_REASONS = [
  'empty', 'length', 'rate', 'gate', 'restricted', 'blocked', 'profanity', 'banned', 'slow_mode', 'flood', 'duplicate', 'probation', 'link', 'personal_info', 'filter', 'locked',
  'new_account', 'account_too_new', 'phrases_only', 'phrase_unknown', 'unknown',
] as const;
export type RefuseReason = (typeof KNOWN_REASONS)[number];

export interface Refusal {
  reason: RefuseReason;
  /** The reason as the service sent it, when this client did not know it. */
  rawReason?: string;
  until?: number | null;
  byModerator?: boolean;
  rule?: number;
  noticeId?: string;
  retryAfterMs?: number;
}

export interface Line {
  id: string;
  text: string;
  phrase?: string;
}

export type LineAnswer = { ok: true; line: Line; hiddenFor: string[] } | { ok: false; refused: Refusal };

const KNOWN_REPORT_REFUSALS = ['off', 'reason_required', 'reason_unknown', 'entity_invalid', 'not_player', 'self', 'suspended', 'rate', 'duplicate', 'unknown'] as const;
export type ReportRefusal = (typeof KNOWN_REPORT_REFUSALS)[number];

export type ReportAnswer = { ok: true; remaining: number; detailUntil?: number } | { ok: false; refused: ReportRefusal; rawRefused?: string; remaining?: number };

export interface Restriction {
  until: number | null;
  kind: string | null;
}

export interface Notice {
  id: string;
  kind: string;
  rule: number | string | null;
  ruleLabel: string | null;
  until: number | null;
  refCode: string | null;
  excerpt: Array<{ text: string; day: string }>;
  createdAt: number;
  mustAcknowledge: boolean;
  /** A signed link to the appeal page for a sanction notice that can still be appealed (0.2.1). A capability for that one notice: do not log it. */
  appealUrl?: string;
}

/** An appeal as the person sees it: its status and times, no reason, no staff ref, no group or person id. */
export interface Appeal {
  id: string;
  noticeId: string;
  status: 'open' | 'upheld' | 'reduced' | 'revoked';
  createdAt: number;
  decidedAt: number | null;
}

const KNOWN_APPEAL_REFUSALS = ['off', 'not_found', 'not_appealable', 'statement_invalid', 'already_appealed', 'rate', 'unknown'] as const;
export type AppealRefusal = (typeof KNOWN_APPEAL_REFUSALS)[number];

/** The answer to a filing: the appeal, or why not (a refusal the client does not know is `unknown`, the original in `rawRefused`; `rate` carries how long to wait). */
export type AppealFileAnswer = { ok: true; appeal: Appeal } | { ok: false; refused: AppealRefusal; rawRefused?: string; retryAfterMs?: number };

export interface Handshake {
  api: number;
  kit: string;
  mode: 'service';
  processes: 'single' | 'multiple';
  capabilities: { phrases: boolean; blocks: boolean; contexts: string[]; sharedPacing: boolean; matchModes: string[] };
  warnings: string[];
}

export interface ReportInput {
  target: string;
  lineId?: string;
  reason?: string;
  note?: string;
  entity?: { kind: string; ref: string; label: string };
}

export type DoorKind = 'join' | 'create' | 'public' | 'matchmaking';

export interface ServiceClientOptions {
  /** Where the service is, such as `https://chat.example.com` (a trailing slash is fine). The `/v1` is added. */
  baseUrl: string;
  /** A service key. Held in the client and sent as the bearer; never put in an error. */
  key: string;
  /** The platform's `fetch` by default. */
  fetch?: typeof fetch;
  /** How many times a failed call is tried again: 3 by default (so four attempts), 0 for one. */
  retries?: number;
  /** The first wait before a retry, in ms, doubled each time: 100 by default. */
  backoffMs?: number;
  /** Waits `ms`. For tests; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Makes an `Idempotency-Key`. Default 16 random hex characters. */
  idempotencyKey?: () => string;
}

const KEY_RE = /^[A-Za-z0-9_\-.~+/=]{1,512}$/;

const enc = encodeURIComponent;
const same = <T extends string>(known: readonly T[], value: unknown): T | null => (typeof value === 'string' && (known as readonly string[]).includes(value) ? (value as T) : null);

function refusalOf(raw: unknown): Refusal {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const known = same(KNOWN_REASONS, r.reason);
  const { reason: original, ...rest } = r;
  return known !== null ? ({ ...rest, reason: known } as Refusal) : ({ ...rest, reason: 'unknown', rawReason: typeof original === 'string' ? original : '' } as Refusal);
}

function lineAnswer(raw: unknown): LineAnswer {
  const a = raw as Record<string, unknown>;
  if (a.ok === true) return a as unknown as LineAnswer;
  return { ...a, ok: false, refused: refusalOf(a.refused) } as LineAnswer;
}

function reportAnswer(raw: unknown): ReportAnswer {
  const a = raw as Record<string, unknown>;
  if (a.ok === true) return a as unknown as ReportAnswer;
  const known = same(KNOWN_REPORT_REFUSALS, a.refused);
  if (known !== null) return a as unknown as ReportAnswer;
  const { refused, ...rest } = a;
  return { ...rest, ok: false, refused: 'unknown', rawRefused: typeof refused === 'string' ? refused : '' } as ReportAnswer;
}

function appealAnswer(raw: unknown): AppealFileAnswer {
  const a = raw as Record<string, unknown>;
  if (a.ok === true) return a as unknown as AppealFileAnswer;
  const known = same(KNOWN_APPEAL_REFUSALS, a.refused);
  if (known !== null) return a as unknown as AppealFileAnswer;
  const { refused, ...rest } = a;
  return { ...rest, ok: false, refused: 'unknown', rawRefused: typeof refused === 'string' ? refused : '' } as AppealFileAnswer;
}

export interface ServiceClient {
  handshake(): Promise<Handshake>;
  seat(room: string, seat: string, input: { who: ServiceWho; handle: string; tags?: Record<string, string> }): Promise<{ ok: true; restriction: Restriction | null }>;
  unseat(room: string, seat: string): Promise<{ ok: true }>;
  closeRoom(room: string): Promise<{ ok: true }>;
  line(room: string, seat: string, text: string): Promise<LineAnswer>;
  phrase(room: string, seat: string, phraseId: string): Promise<LineAnswer>;
  mutes(room: string, seat: string): Promise<{ muted: string[]; blocked: string[] }>;
  mute(room: string, seat: string, target: string, kind?: 'mute' | 'block'): Promise<{ ok: boolean; limit?: true }>;
  unmute(room: string, seat: string, target: string): Promise<{ ok: true }>;
  report(room: string, seat: string, input: ReportInput): Promise<ReportAnswer>;
  pendingNotices(who: ServiceWho): Promise<{ notices: Notice[] }>;
  ack(id: string, who: ServiceWho): Promise<{ ok: boolean }>;
  record(who: ServiceWho): Promise<{ record: Notice[] }>;
  restriction(who: ServiceWho, where?: { roomId?: string; seatId?: string }): Promise<{ restricted: boolean; until: number | null; kind: string | null }>;
  checkName(name: string, options?: { kind?: 'player' | 'entity'; who?: ServiceWho }): Promise<{ ok: true } | { ok: false; reason: string; rule: number }>;
  checkDoor(kind: DoorKind, who: ServiceWho): Promise<{ ok: true } | { ok: false; refusal: { kind: 'ban' | 'area'; until: number | null; refCode: string; noticeId?: string; appealUrl?: string } }>;
  blocksBetween(who: ServiceWho, others: ServiceWho[]): Promise<{ blocked: boolean[] }>;
  /**
   * A signed link to the appeal page for one sanction notice, or `{ url: null }` when none can be made. (Optional on the interface so a `ServiceClient` written against 0.2.0 still compiles;
   * the client `createServiceClient` returns always has it.)
   */
  appealLink?(noticeId: string): Promise<{ url: string | null }>;
  /** File an appeal for a person against one of their own sanction notices. A refusal is returned, not thrown. Optional on the interface, always on the client `createServiceClient` returns. */
  fileAppeal?(who: ServiceWho, noticeId: string, statement: string): Promise<AppealFileAnswer>;
  /** The appeals a person filed, newest first. Optional on the interface, always on the client `createServiceClient` returns. */
  appeals?(who: ServiceWho): Promise<{ appeals: Appeal[] }>;
}

/** A typed client of `/v1`. See the file's header for what it does for you; everything else (the answer shapes, the refusals) is in the API description (`SERVICE_OPENAPI`). */
export function createServiceClient(options: ServiceClientOptions): ServiceClient & Required<Pick<ServiceClient, 'appealLink' | 'fileAppeal' | 'appeals'>> {
  if (typeof options !== 'object' || options === null) throw new TypeError('createServiceClient: options must be an object');
  if (typeof options.baseUrl !== 'string' || options.baseUrl === '') throw new TypeError('createServiceClient: baseUrl is required');
  if (typeof options.key !== 'string' || !KEY_RE.test(options.key)) throw new TypeError('createServiceClient: key is required and must be a service key (no spaces)');
  const base = options.baseUrl.replace(/\/+$/, '');
  const key = options.key;
  const retries = options.retries ?? 3;
  const backoff = options.backoffMs ?? 100;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const makeKey = options.idempotencyKey ?? ((): string => randomHex(8));
  const doFetch = (url: string, init: RequestInit): Promise<Response> => (options.fetch ?? globalThis.fetch)(url, init);

  async function call<T>(method: string, path: string, body?: unknown, idempotent = false): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotent) headers['idempotency-key'] = makeKey();
    let wait = backoff;
    for (let attempt = 0; ; attempt += 1) {
      let failure: ServiceError;
      try {
        const res = await doFetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
        } catch {
          parsed = undefined;
        }
        if (res.ok && parsed !== undefined) return parsed as T;
        const error = (parsed as { error?: unknown } | undefined)?.error;
        const code = typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : 'unreadable';
        const retryAfter = Number(res.headers.get('retry-after'));
        failure = new ServiceError(res.status, code, `The service answered ${res.status} (${code}).`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      } catch {
        failure = new ServiceError(0, 'network', 'The service could not be reached.');
      }
      // A 4xx is the caller's to fix, not to repeat; a network error and a 5xx may pass.
      if ((failure.status !== 0 && failure.status < 500) || attempt >= retries) throw failure;
      await sleep(wait);
      wait *= 2;
    }
  }

  const room = (r: string): string => `/v1/rooms/${enc(r)}`;
  const seatOf = (r: string, s: string): string => `${room(r)}/seats/${enc(s)}`;

  return {
    handshake: () => call('GET', '/v1'),
    seat: (r, s, input) => call('PUT', seatOf(r, s), input),
    unseat: (r, s) => call('DELETE', seatOf(r, s)),
    closeRoom: (r) => call('DELETE', room(r)),
    line: async (r, s, text) => lineAnswer(await call('POST', `${seatOf(r, s)}/lines`, { text }, true)),
    phrase: async (r, s, phraseId) => lineAnswer(await call('POST', `${seatOf(r, s)}/phrases`, { phraseId }, true)),
    mutes: (r, s) => call('GET', `${seatOf(r, s)}/mutes`),
    mute: (r, s, target, kind) => call('PUT', `${seatOf(r, s)}/mutes/${enc(target)}`, kind === 'block' ? { kind } : undefined),
    unmute: (r, s, target) => call('DELETE', `${seatOf(r, s)}/mutes/${enc(target)}`),
    report: async (r, s, input) => reportAnswer(await call('POST', `${seatOf(r, s)}/reports`, input, true)),
    pendingNotices: (who) => call('POST', '/v1/notices/pending', { who }),
    ack: (id, who) => call('POST', `/v1/notices/${enc(id)}/ack`, { who }),
    record: (who) => call('POST', '/v1/record', { who }),
    restriction: (who, where) => call('POST', '/v1/restriction', { who, ...where }),
    checkName: (name, o) => call('POST', '/v1/names/check', { name, ...(o?.kind === undefined ? {} : { kind: o.kind }), ...(o?.who === undefined ? {} : { who: o.who }) }),
    checkDoor: (kind, who) => call('POST', '/v1/doors/check', { kind, who }),
    blocksBetween: (who, others) => call('POST', '/v1/blocks/between', { who, others }),
    appealLink: (noticeId) => call('POST', '/v1/appeals/link', { noticeId }),
    fileAppeal: async (who, noticeId, statement) => appealAnswer(await call('POST', '/v1/appeals', { who, noticeId, statement })),
    appeals: (who) => call('POST', '/v1/appeals/mine', { who }),
  };
}
