import type { Transport, TransportRequest, TransportResponse } from './transport.js';
import type {
  BlockedDays,
  BlockedLine,
  CloseGapInput,
  DecideInput,
  DecideResult,
  ExceptionInput,
  ExceptionPatch,
  GapRow,
  ListAuditQuery,
  ListReportsQuery,
  ListSanctionsQuery,
  Me,
  Page,
  PersonHistory,
  PolicyDocs,
  PolicyFormat,
  ReportDetail,
  ReportSummary,
  SanctionInput,
  SanctionRow,
  AuditItem,
  Changes,
  ClaimResult,
  ConductLevel,
  NextCase,
  Reason,
  ReportCategory,
  Suggestion,
  SuggestInput,
  TermInput,
  TermPatch,
  TermsList,
  TextVerdict,
} from './types.js';

/**
 * Why a call to the staff API failed. `status` is the HTTP status, or 0 when no answer arrived. `code` is the kit's error code
 * (`forbidden`, `not_found`, `already_decided`, ...), `network` for a dropped connection, `bad_response` for an answer that is
 * not the shape the hub expects, `unexpected` for anything else, and `http_<status>` when the body is not a kit error.
 * `retryAfter` is the seconds from a `retry-after` header (a 429). A `claimed` error (409: another moderator is handling the
 * case) also says who (`heldBy`) and until when (`heldUntil`, epoch ms).
 */
export class HubError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  readonly heldBy: string | undefined;
  readonly heldUntil: number | undefined;

  constructor(init: { status: number; code: string; message: string; retryAfter?: number; heldBy?: string; heldUntil?: number }) {
    super(init.message);
    this.name = 'HubError';
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.heldBy = init.heldBy;
    this.heldUntil = init.heldUntil;
  }
}

/** A `HubError` as is; anything else (a bug in the caller's code, say) becomes status 0, code `unexpected`. */
export function toHubError(e: unknown): HubError {
  if (e instanceof HubError) return e;
  return new HubError({ status: 0, code: 'unexpected', message: e instanceof Error ? e.message : 'Something went wrong.' });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function retryAfterOf(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
}

function errorOf(res: TransportResponse): HubError {
  const b = res.body;
  const retryAfter = retryAfterOf(res.headers);
  const rest = retryAfter === undefined ? {} : { retryAfter };
  if (isObject(b) && typeof b.error === 'string' && typeof b.message === 'string') {
    const held =
      b.error === 'claimed'
        ? { ...(typeof b.by === 'string' ? { heldBy: b.by } : {}), ...(typeof b.until === 'number' ? { heldUntil: b.until } : {}) }
        : {};
    return new HubError({ status: res.status, code: b.error, message: b.message, ...rest, ...held });
  }
  // A proxy's HTML page, or an empty body: say the status, never echo the body.
  return new HubError({ status: res.status, code: `http_${res.status}`, message: `The server answered with status ${res.status}.`, ...rest });
}

/** What `request` hands back for a body: JSON objects only unless the caller asks for text. */
async function send(transport: Transport, req: TransportRequest): Promise<TransportResponse> {
  let res: TransportResponse;
  try {
    res = await transport(req);
  } catch (e) {
    throw new HubError({ status: 0, code: 'network', message: e instanceof Error && e.name === 'AbortError' ? 'The request was cancelled.' : 'Could not reach the server.' });
  }
  if (res.status < 200 || res.status > 299) throw errorOf(res);
  return res;
}

/** The query without its undefined entries, so a call with no filter sends no query at all. */
const q = (query: Record<string, string | number | undefined>): Record<string, string | number> =>
  Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
const enc = encodeURIComponent;

export interface HubClient {
  // The signed-in staff member
  /** `GET /me`: who is calling and what their role may do. */
  me(): Promise<Me>;

  // Reports
  /** `GET /reports`: the queue, newest first, as summaries. */
  listReports(query?: ListReportsQuery): Promise<Page<ReportSummary>>;
  /** `GET /reports/:id`: one report with evidence, history and the ladder's suggestion. Audited. */
  getReport(id: string, options?: { level?: ConductLevel }): Promise<ReportDetail>;
  /** `POST /reports/:id/suggest`: the suggestion for another conduct level, rule or person on the report. */
  suggest(id: string, input: SuggestInput): Promise<Suggestion>;
  /** `POST /reports/:id/decide`: decide the report. A replay of the same decision applies nothing twice. */
  decide(id: string, input: DecideInput): Promise<DecideResult>;

  // People and sanctions
  /** `GET /people/:ref/history`. */
  personHistory(ref: string, options?: { limit?: number }): Promise<PersonHistory>;
  /** `GET /sanctions`: every person's sanctions, newest first. */
  listSanctions(query?: ListSanctionsQuery): Promise<Page<SanctionRow>>;
  /** `POST /sanctions`: a direct sanction. */
  applySanction(input: SanctionInput): Promise<{ groupId: string; refCode: string }>;
  /** `POST /sanctions/:groupId/revoke`. */
  revokeSanction(groupId: string, reason: string): Promise<{ ok: true }>;

  // Rule gaps
  /** `GET /gaps`. */
  listGaps(): Promise<{ items: GapRow[] }>;
  /** `POST /gaps/:groupId/close` (owner). */
  closeGap(groupId: string, input: CloseGapInput): Promise<{ ok: true }>;

  // Terms and exceptions
  /** `GET /terms`. */
  listTerms(): Promise<TermsList>;
  /** `POST /terms/check`: a dry run of a new term. */
  checkTerm(input: { term: string; language: string }): Promise<{ hits: string[] }>;
  /** `POST /terms/test`: would the live list block this line? */
  testText(text: string): Promise<{ verdict: TextVerdict; termId: string | null }>;
  /** `POST /terms`. */
  addTerm(input: TermInput): Promise<{ id: string }>;
  /** `PATCH /terms/:id`. */
  updateTerm(id: string, patch: TermPatch): Promise<{ ok: true }>;
  /** `POST /terms/:id/active`. */
  setTermActive(id: string, active: boolean): Promise<{ ok: true }>;
  /** `POST /exceptions`. */
  addException(input: ExceptionInput): Promise<{ id: string }>;
  /** `PATCH /exceptions/:id`. */
  updateException(id: string, patch: ExceptionPatch): Promise<{ ok: true }>;
  /** `POST /exceptions/:id/active`. */
  setExceptionActive(id: string, active: boolean): Promise<{ ok: true }>;

  // The team: claims, take next, viewing, the change token, saved reasons
  /** `GET /changes`: the token for the queue and claims, and whether it differs from `since`. One cheap read. */
  changes(since?: string): Promise<Changes>;
  /** `POST /cases/:ref/claim`: claim an open case, or beat your own claim (a heartbeat). A 409 `claimed` says who holds it. */
  claimCase(person: string, options?: { takeOver?: boolean }): Promise<ClaimResult>;
  /** `POST /cases/:ref/release`: release your own claim. `released` is false when there was nothing of yours to release. */
  releaseCase(person: string): Promise<{ released: boolean }>;
  /** `POST /cases/next`: claim and return the oldest open case nobody holds, or `{ case: null }`. */
  takeNext(options?: { category?: ReportCategory }): Promise<{ case: NextCase | null }>;
  /** `POST /cases/:ref/viewing`: say you have the case open (a hint for 30 seconds); answers who else has. */
  viewing(person: string): Promise<{ viewers: string[] }>;
  /** `GET /reasons`: the saved reasons, switched-off ones included. */
  listReasons(): Promise<{ reasons: Reason[] }>;
  /** `POST /reasons` (senior). */
  addReason(input: { label: string; text: string }): Promise<{ reason: Reason }>;
  /** `PATCH /reasons/:id` (senior). */
  updateReason(id: string, patch: { label?: string; text?: string }): Promise<{ reason: Reason }>;
  /** `POST /reasons/:id/active` (senior). */
  setReasonActive(id: string, active: boolean): Promise<{ reason: Reason }>;

  // Blocked lines, policy, audit
  /** `GET /blocked`: the lines the term filter refused (default the last 7 days). */
  listBlocked(options?: { days?: BlockedDays }): Promise<{ items: BlockedLine[] }>;
  /** `GET /policy`: the profile, rules and generated documents. */
  policy(options?: { format?: PolicyFormat }): Promise<PolicyDocs>;
  /** `GET /audit` (senior). */
  listAudit(query?: ListAuditQuery): Promise<Page<AuditItem>>;
}

/**
 * The hub's view of the staff API: one method per route, each resolving with the parsed answer or rejecting with a
 * {@link HubError}. It knows nothing about how the call travels: that is the {@link Transport}.
 */
export function createHubClient(transport: Transport): HubClient {
  const call = async <T>(req: TransportRequest): Promise<T> => {
    const res = await send(transport, req);
    if (!isObject(res.body)) throw new HubError({ status: res.status, code: 'bad_response', message: 'The server answered with something the hub cannot read.' });
    return res.body as T;
  };
  const get = <T>(path: string, query?: Record<string, string | number | undefined>) => call<T>({ method: 'GET', path, ...(query === undefined ? {} : { query }) });
  const post = <T>(path: string, body: unknown) => call<T>({ method: 'POST', path, body });
  const patch = <T>(path: string, body: unknown) => call<T>({ method: 'PATCH', path, body });

  return {
    me: () => get<Me>('/me'),

    listReports: (query = {}) => get<Page<ReportSummary>>('/reports', q({ status: query.status, cursor: query.cursor, limit: query.limit })),
    getReport: (id, options = {}) => get<ReportDetail>(`/reports/${enc(id)}`, q({ level: options.level })),
    suggest: (id, input) => post<Suggestion>(`/reports/${enc(id)}/suggest`, input),
    decide: (id, input) => post<DecideResult>(`/reports/${enc(id)}/decide`, input),

    personHistory: (ref, options = {}) => get<PersonHistory>(`/people/${enc(ref)}/history`, q({ limit: options.limit })),
    listSanctions: (query = {}) => get<Page<SanctionRow>>('/sanctions', q({ cursor: query.cursor, limit: query.limit, source: query.source })),
    applySanction: (input) => post<{ groupId: string; refCode: string }>('/sanctions', input),
    revokeSanction: (groupId, reason) => post<{ ok: true }>(`/sanctions/${enc(groupId)}/revoke`, { reason }),

    listGaps: () => get<{ items: GapRow[] }>('/gaps'),
    closeGap: (groupId, input) => post<{ ok: true }>(`/gaps/${enc(groupId)}/close`, input),

    listTerms: () => get<TermsList>('/terms'),
    checkTerm: (input) => post<{ hits: string[] }>('/terms/check', input),
    testText: (text) => post<{ verdict: TextVerdict; termId: string | null }>('/terms/test', { text }),
    addTerm: (input) => post<{ id: string }>('/terms', input),
    updateTerm: (id, p) => patch<{ ok: true }>(`/terms/${enc(id)}`, p),
    setTermActive: (id, active) => post<{ ok: true }>(`/terms/${enc(id)}/active`, { active }),
    addException: (input) => post<{ id: string }>('/exceptions', input),
    updateException: (id, p) => patch<{ ok: true }>(`/exceptions/${enc(id)}`, p),
    setExceptionActive: (id, active) => post<{ ok: true }>(`/exceptions/${enc(id)}/active`, { active }),

    changes: (since) => get<Changes>('/changes', q({ since })),
    claimCase: (person, options = {}) => post<ClaimResult>(`/cases/${enc(person)}/claim`, options.takeOver === true ? { takeOver: true } : undefined),
    releaseCase: (person) => post<{ released: boolean }>(`/cases/${enc(person)}/release`, undefined),
    takeNext: (options = {}) => post<{ case: NextCase | null }>('/cases/next', options.category === undefined ? undefined : { category: options.category }),
    viewing: (person) => post<{ viewers: string[] }>(`/cases/${enc(person)}/viewing`, undefined),
    listReasons: () => get<{ reasons: Reason[] }>('/reasons'),
    addReason: (input) => post<{ reason: Reason }>('/reasons', input),
    updateReason: (id, p) => patch<{ reason: Reason }>(`/reasons/${enc(id)}`, p),
    setReasonActive: (id, active) => post<{ reason: Reason }>(`/reasons/${enc(id)}/active`, { active }),

    listBlocked: (options = {}) => get<{ items: BlockedLine[] }>('/blocked', q({ days: options.days })),
    policy: (options = {}) => get<PolicyDocs>('/policy', q({ format: options.format })),
    listAudit: (query = {}) => get<Page<AuditItem>>('/audit', q({ cursor: query.cursor, limit: query.limit, actor: query.actor, action: query.action })),
  };
}

/**
 * Follows `next` until the list ends, joining the pages in order. At most `maxPages` pages (default 20); when it stops early
 * the result's `next` is where to carry on. A cursor that repeats ends the loop, so a server that never finishes cannot hold
 * the page. A failed page rejects: the caller still has what it had before.
 */
export async function fetchAll<T>(
  loadPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { maxPages?: number } = {},
): Promise<Page<T>> {
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let next: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const got = await loadPage(cursor);
    items.push(...got.items);
    next = got.next;
    if (next === null || seen.has(next)) return { items, next: next !== null && seen.has(next) ? null : next };
    seen.add(next);
    cursor = next;
  }
  return { items, next };
}
