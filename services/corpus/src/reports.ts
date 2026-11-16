import { b64uEncode } from './b64.js';
import { LIMITS, addDays, dayOf, hit, isDay, networkKey, secondsToNextDay } from './counters.js';
import { logEvent, type AppDeps } from './deps.js';
import { internal, isJson, json, methodNotAllowed, notFound, readCapped, tooMany, unauthorized } from './http.js';
import { TOKEN_MAX, verifyTurnstile } from './turnstile.js';
import { authenticate } from './verify.js';

// Reports of a term (design 10.6): "this word has an innocent sense", "wrong category", "remove it". A report is a term id, a closed kind and a
// day. There is nowhere to put free text, so there is nothing to moderate or leak: a body with any other key is refused, and the table has no
// column for it. The reporter is an installation (a signed report, no stamp) or a person at the docs-site form (a Turnstile token). The
// answer is an acknowledgement id and nothing about the term. A report only opens a ticket; a reviewer decides (src/review.ts).

export const REPORT_SCHEMA = 'chatwarden-corpus-report/1';
const BODY_MAX_BYTES = 2048;
const KINDS = ['innocent_sense', 'wrong_category', 'removal'];
const KIT_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const TERM_ID = /^CWT-\d{4}-\d{5}$/;
const SIGNED_KEYS = new Set(['schema', 'termId', 'kind', 'day', 'kit']);
const WEB_KEYS = new Set(['schema', 'termId', 'kind', 'token']);

const invalid = (): Response => json(400, { error: 'invalid' });
const forbidden = (): Response => json(403, { error: 'forbidden' });

function readObject(bytes: Uint8Array, keys: Set<string>): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    return Object.keys(o).every((k) => keys.has(k)) ? o : null;
  } catch {
    return null;
  }
}

/** The docs site's origin is the only one answered for the web form; a signed report is server to server and gets no CORS at all. */
function corsFor(deps: AppDeps, request: Request): { allowed: boolean; headers: Record<string, string> } {
  const origin = request.headers.get('origin');
  if (origin === null) return { allowed: true, headers: {} };
  if (deps.reportsOrigin !== undefined && origin === deps.reportsOrigin) return { allowed: true, headers: { 'access-control-allow-origin': origin, vary: 'Origin' } };
  return { allowed: false, headers: {} };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

function newId(deps: AppDeps): string {
  const bytes = deps.random === undefined ? crypto.getRandomValues(new Uint8Array(16)) : deps.random(16);
  return `rep_${b64uEncode(bytes)}`;
}

/** `OPTIONS /v1/reports`: the browser's check before the docs-site form posts. Answered for the configured origin only. */
export function preflight(deps: AppDeps, request: Request): Response {
  const origin = request.headers.get('origin');
  if (deps.reportsOrigin === undefined || origin === null) return methodNotAllowed('POST');
  if (origin !== deps.reportsOrigin) return forbidden();
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
      'cache-control': 'no-store',
    },
  });
}

/** `POST /v1/reports`. */
export async function report(request: Request, deps: AppDeps): Promise<Response> {
  try {
    return await reportInner(request, deps);
  } catch {
    logEvent(deps, 'report', 'db_error');
    return internal();
  }
}

async function reportInner(request: Request, deps: AppDeps): Promise<Response> {
  const signedRequest = request.headers.has('x-cw-key') || request.headers.has('x-cw-sig');
  const cors = signedRequest ? { allowed: true, headers: {} } : corsFor(deps, request);
  if (!cors.allowed) {
    logEvent(deps, 'report', 'origin');
    return forbidden();
  }
  if (!isJson(request)) return withHeaders(invalid(), cors.headers);
  const bytes = await readCapped(request, BODY_MAX_BYTES);
  if (bytes === null) return withHeaders(invalid(), cors.headers);
  const res = signedRequest ? await signedReport(request, bytes, deps) : await webReport(request, bytes, deps);
  return withHeaders(res, cors.headers);
}

/** The shared tail: the term must exist, then one open report per term, channel and day. */
async function file(deps: AppDeps, termId: string, kind: string, channel: string, today: string): Promise<Response> {
  const term = await deps.db.prepare('SELECT 1 AS x FROM terms WHERE id = ?').bind(termId).first();
  if (term === null) {
    logEvent(deps, 'report', 'not_found');
    return notFound();
  }
  const id = newId(deps);
  const out = await deps.db
    .prepare("INSERT OR IGNORE INTO reports (id, term_id, kind, channel, status, received_day) VALUES (?, ?, ?, ?, 'received', ?)")
    .bind(id, termId, kind, channel, today)
    .run();
  if (out.meta.changes === 0) {
    logEvent(deps, 'report', 'duplicate');
    return json(200, { status: 'duplicate' });
  }
  logEvent(deps, 'report', 'received');
  return json(202, { id, status: 'received' });
}

async function signedReport(request: Request, bytes: Uint8Array, deps: AppDeps): Promise<Response> {
  const auth = await authenticate(request.headers, 'report', bytes);
  if (!auth.ok) {
    logEvent(deps, 'report', 'signature');
    return unauthorized();
  }
  const now = deps.clock.now();
  const today = dayOf(now);
  const net = (await networkKey(deps.secret, today, request.headers.get('cf-connecting-ip'))).replace(/^net:/, 'rnet:');
  if ((await hit(deps.db, net, today)) > LIMITS.reportsPerNetworkDaily || (await hit(deps.db, `rinst:${auth.installation}`, today)) > LIMITS.reportsPerInstallationDaily) {
    logEvent(deps, 'report', 'limit');
    return tooMany(secondsToNextDay(now));
  }
  const body = readObject(bytes, SIGNED_KEYS);
  if (body === null || body.schema !== REPORT_SCHEMA || typeof body.kit !== 'string' || !KIT_RE.test(body.kit) || !isDay(body.day)) return invalid();
  if (body.day < addDays(today, -1) || body.day > addDays(today, 1)) return invalid();
  if (typeof body.termId !== 'string' || !TERM_ID.test(body.termId) || typeof body.kind !== 'string' || !KINDS.includes(body.kind)) return invalid();
  return file(deps, body.termId, body.kind, `inst:${auth.installation}`, today);
}

async function webReport(request: Request, bytes: Uint8Array, deps: AppDeps): Promise<Response> {
  const body = readObject(bytes, WEB_KEYS);
  if (body === null || body.schema !== REPORT_SCHEMA) return invalid();
  if (typeof body.termId !== 'string' || !TERM_ID.test(body.termId) || typeof body.kind !== 'string' || !KINDS.includes(body.kind)) return invalid();
  const token = body.token;
  if (token !== undefined && (typeof token !== 'string' || token.length > TOKEN_MAX)) return invalid();
  if (token === undefined || token === '' || deps.turnstile === undefined) {
    logEvent(deps, 'report', 'no_token');
    return forbidden();
  }
  const now = deps.clock.now();
  const today = dayOf(now);
  // The channel and the limit are the network's keyed hash; the count is taken before Cloudflare is asked, so spam costs no siteverify call.
  const net = (await networkKey(deps.secret, today, request.headers.get('cf-connecting-ip'))).replace(/^net:/, 'web:');
  if ((await hit(deps.db, net, today)) > LIMITS.webReportsPerNetworkDaily) {
    logEvent(deps, 'report', 'limit');
    return tooMany(secondsToNextDay(now));
  }
  if (!(await verifyTurnstile(deps.turnstile, token, deps.log))) {
    logEvent(deps, 'report', 'turnstile');
    return forbidden();
  }
  return file(deps, body.termId, body.kind, net, today);
}
