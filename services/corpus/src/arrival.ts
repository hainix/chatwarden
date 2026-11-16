import { checkStamp } from '@chatwarden/matcher/corpus';
import { b64uEncode } from './b64.js';
import { DAY_MS, LIMITS, addDays, dayOf, hit, isDay, isoSeconds, networkKey, secondsToNextDay } from './counters.js';
import { logEvent, type AppDeps } from './deps.js';
import { isKnownInnocent, readFields } from './gates.js';
import { internal, isJson, json, notFound, readCapped, tooMany, unauthorized } from './http.js';
import { authenticate, idBytes } from './verify.js';

// The submission API (design 6.8, 10.1, 10.4). The order of the checks is the order of their cost, and nothing is counted, stored or logged for a
// request that has not yet paid its stamp and signed: size, content type, stamp, signature, then the limits, then the body.

export const BODY_MAX_BYTES = 2048;
const SCHEMA = 'chatwarden-corpus-submission/1';
const KEYS = new Set(['schema', 'term', 'language', 'category', 'target', 'note', 'day', 'kit']);
const KIT_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const DEFAULT_STAMP_BITS = 16;
const PENDING = ['received', 'in_review'];

const invalid = (): Response => json(400, { error: 'invalid' });

/** The JSON object of a body, or null: valid UTF-8, no byte-order mark, an object with no key outside the closed list. */
function readObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    return Object.keys(o).every((k) => KEYS.has(k)) ? o : null;
  } catch {
    return null;
  }
}

function newId(deps: AppDeps): string {
  const bytes = deps.random === undefined ? crypto.getRandomValues(new Uint8Array(16)) : deps.random(16);
  return `sub_${b64uEncode(bytes)}`;
}

/** Seconds left of an installation's lock, or 0: the last `lockStreak` decisions were all declines, the newest within `lockDays`. */
async function lockedFor(deps: AppDeps, installation: string): Promise<number> {
  const res = await deps.db
    .prepare('SELECT status, decided_at FROM submissions WHERE installation = ? AND decided_at IS NOT NULL ORDER BY decided_at DESC, rowid DESC LIMIT ?')
    .bind(installation, LIMITS.lockStreak)
    .all<{ status: string; decided_at: string }>();
  if (res.results.length < LIMITS.lockStreak || res.results.some((r) => r.status !== 'declined')) return 0;
  const newest = Date.parse((res.results[0] as { decided_at: string }).decided_at);
  if (!Number.isFinite(newest)) return 0;
  return Math.max(0, Math.ceil((newest + LIMITS.lockDays * DAY_MS - deps.clock.now()) / 1000));
}

async function submitInner(request: Request, deps: AppDeps): Promise<Response> {
  if (!isJson(request)) {
    logEvent(deps, 'arrival', 'content_type');
    return invalid();
  }
  const bytes = await readCapped(request, BODY_MAX_BYTES);
  if (bytes === null) {
    logEvent(deps, 'arrival', 'too_large');
    return json(400, { error: 'too_large' });
  }
  const stamp = request.headers.get('x-cw-stamp');
  if (stamp === null || !checkStamp(bytes, stamp, deps.stampBits ?? DEFAULT_STAMP_BITS)) {
    logEvent(deps, 'arrival', 'stamp');
    return json(400, { error: 'stamp' });
  }
  const auth = await authenticate(request.headers, 'submission', bytes);
  if (!auth.ok) {
    logEvent(deps, 'arrival', 'signature');
    return unauthorized();
  }
  const now = deps.clock.now();
  const today = dayOf(now);

  const locked = await lockedFor(deps, auth.installation);
  if (locked > 0) {
    logEvent(deps, 'arrival', 'locked');
    return tooMany(locked);
  }
  const waiting = await deps.db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE installation = ? AND status IN ('received','in_review')")
    .bind(auth.installation)
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) >= LIMITS.pending) {
    logEvent(deps, 'arrival', 'pending_cap');
    return tooMany(secondsToNextDay(now));
  }
  const net = await networkKey(deps.secret, today, request.headers.get('cf-connecting-ip'));
  if ((await hit(deps.db, net, today)) > LIMITS.perNetworkDaily) {
    logEvent(deps, 'arrival', 'net_limit');
    return tooMany(secondsToNextDay(now));
  }
  if ((await hit(deps.db, `inst:${auth.installation}`, today)) > LIMITS.perInstallationDaily) {
    logEvent(deps, 'arrival', 'inst_limit');
    return tooMany(secondsToNextDay(now));
  }

  const body = readObject(bytes);
  if (body === null || body.schema !== SCHEMA || typeof body.kit !== 'string' || !KIT_RE.test(body.kit) || !isDay(body.day)) {
    logEvent(deps, 'arrival', 'invalid');
    return invalid();
  }
  if (body.day < addDays(today, -1) || body.day > addDays(today, 1)) {
    logEvent(deps, 'arrival', 'day');
    return invalid();
  }
  const read = readFields(body);
  if (!read.ok) {
    logEvent(deps, 'arrival', read.code);
    return json(400, { error: read.code });
  }
  const fields = read.fields;
  // A common word is declined at once and the sender is told nothing different from "received": the status says what happened.
  const declined = await isKnownInnocent(deps.db, fields.language, fields.wordKey);

  const known = await deps.db.prepare('SELECT id FROM terms WHERE word_key = ?').bind(fields.wordKey).first<{ id: string }>();
  if (known !== null) {
    logEvent(deps, 'arrival', 'known');
    return json(200, { status: 'known', termId: known.id });
  }
  const pending = await deps.db
    .prepare(`SELECT id FROM submissions WHERE word_key = ? AND status IN (${PENDING.map(() => '?').join(',')}) LIMIT 1`)
    .bind(fields.wordKey, ...PENDING)
    .first<{ id: string }>();
  if (pending !== null) {
    logEvent(deps, 'arrival', 'duplicate');
    return json(200, { status: 'duplicate' });
  }
  const id = newId(deps);
  try {
    await deps.db
      .prepare(
        'INSERT INTO submissions (id, installation, word_key, term, language, category, target, note, status, reason, received_day, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        auth.installation,
        fields.wordKey,
        fields.term,
        fields.language,
        fields.category,
        fields.target,
        fields.note,
        declined ? 'declined' : 'received',
        declined ? 'known_innocent' : null,
        today,
        declined ? isoSeconds(now) : null,
      )
      .run();
  } catch (e) {
    // Two requests for one word at once: the database allows one pending row per word, so the second is a duplicate.
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      logEvent(deps, 'arrival', 'duplicate');
      return json(200, { status: 'duplicate' });
    }
    throw e;
  }
  logEvent(deps, 'arrival', declined ? 'known_innocent' : 'received');
  return json(202, { id, status: 'received' });
}

/** `POST /v1/submissions`. */
export async function submit(request: Request, deps: AppDeps): Promise<Response> {
  try {
    return await submitInner(request, deps);
  } catch {
    logEvent(deps, 'arrival', 'db_error');
    return internal();
  }
}

/** `GET /v1/submissions/:id`: the state of the key's own submission, and nothing a reviewer wrote. */
export async function status(request: Request, id: string, deps: AppDeps): Promise<Response> {
  try {
    if (!ID_RE.test(id)) return notFound();
    const auth = await authenticate(request.headers, 'submission', idBytes(id));
    if (!auth.ok) {
      logEvent(deps, 'status', 'signature');
      return unauthorized();
    }
    const now = deps.clock.now();
    const today = dayOf(now);
    const net = await networkKey(deps.secret, today, request.headers.get('cf-connecting-ip'));
    if ((await hit(deps.db, net.replace(/^net:/, 'get:'), today)) > LIMITS.statusDaily) {
      logEvent(deps, 'status', 'net_limit');
      return tooMany(secondsToNextDay(now));
    }
    const row = await deps.db.prepare('SELECT status, reason FROM submissions WHERE id = ? AND installation = ?').bind(id, auth.installation).first<{ status: string; reason: string | null }>();
    if (row === null) return notFound();
    return json(200, row.reason === null ? { status: row.status } : { status: row.status, reason: row.reason });
  } catch {
    logEvent(deps, 'status', 'db_error');
    return internal();
  }
}
