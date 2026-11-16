import type { AccessVerifier } from './access.js';
import { b64uEncode } from './b64.js';
import { dayOf, hit, isoSeconds } from './counters.js';
import { logEvent, type AppDeps } from './deps.js';
import type { D1Statement } from './env.js';
import { TARGETS, crossLanguageGate, isKnownInnocent, readNote } from './gates.js';
import { internal, json, methodNotAllowed, notFound, readCapped, unauthorized } from './http.js';

// The review queue and its API (design 10.3). Everything under /admin sits behind Cloudflare Access (src/access.ts); a person who gets past
// it must also be a reviewer in D1. The lists never carry a term or a note: a word is shown only by a reveal, which is counted, audited and
// reminds the reviewer to take a break every 20. The rules are enforced here, in SQL, not by trust: one approval makes a term provisional, the
// second by a different reviewer makes it accepted only when one approver is fluent, a slur needs a target, nobody reviews a submission from an
// installation key registered to them, and every action writes an audit row in the same transaction as the action.

const BODY_MAX = 4096;
const BREAK_EVERY = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SUBMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TERM_ID = /^CWT-\d{4}-\d{5}$/;
const REASONS = ['known_innocent', 'not_a_term', 'duplicate', 'needs_context', 'other'];
const SEVERITIES = ['rude', 'hostile', 'severe'];
const SUBMISSION_STATUSES = ['open', 'held', 'received', 'in_review', 'accepted', 'declined', 'merged'];
const TERM_STATUSES = ['provisional', 'accepted', 'disputed', 'withdrawn'];
const DEFAULT_SEVERITY: Record<string, string> = { slur: 'severe', abuse: 'hostile', sexual: 'hostile', other: 'rude' };

const PAGE_FILES: Record<string, { name: string; type: string }> = {
  '/admin': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/page.js': { name: 'page.js', type: 'text/javascript; charset=utf-8' },
  '/admin/page.css': { name: 'page.css', type: 'text/css; charset=utf-8' },
};

/** The page's content security policy: the page's own script and style, calls to its own origin, and nothing else. */
export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json(status, { error, ...extra });

interface Reviewer {
  email: string;
  fluent: string[];
}

interface Ctx {
  deps: AppDeps;
  reviewer: Reviewer;
  now: string;
  today: string;
}

// ---- the entry point ----

/** Handles a request under `/admin`. `verifier` is null when Access is not configured: then nothing here exists. */
export async function handleAdmin(request: Request, deps: AppDeps, verifier: AccessVerifier | null): Promise<Response> {
  if (verifier === null) return notFound();
  try {
    const auth = await verifier.verify(request.headers.get('cf-access-jwt-assertion'));
    if (!auth.ok) {
      logEvent(deps, 'review', 'token');
      return unauthorized();
    }
    const row = await deps.db.prepare('SELECT email, fluent FROM reviewers WHERE lower(email) = ? AND active = 1').bind(auth.email).first<{ email: string; fluent: string }>();
    if (row === null) {
      logEvent(deps, 'review', 'not_reviewer');
      return err(403, 'forbidden');
    }
    const now = deps.clock.now();
    const ctx: Ctx = { deps, reviewer: { email: auth.email, fluent: parseList(row.fluent) }, now: isoSeconds(now), today: dayOf(now) };
    return await route(request, ctx);
  } catch {
    logEvent(deps, 'review', 'db_error');
    return internal();
  }
}

async function route(request: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const page = PAGE_FILES[path];
  if (page !== undefined) return request.method === 'GET' ? servePage(ctx, page) : methodNotAllowed('GET');
  if (!path.startsWith('/admin/api/')) return notFound();
  const parts = path.slice('/admin/api/'.length).split('/');
  const [a, b, c] = parts;
  if (parts.length === 1 && a === 'me') return only(request, 'GET', () => json(200, { email: ctx.reviewer.email, fluent: ctx.reviewer.fluent }));
  if (parts.length === 1 && a === 'queue') return only(request, 'GET', () => listQueue(ctx, url));
  if (parts.length === 1 && a === 'terms') return only(request, 'GET', () => listTerms(ctx, url));
  if (parts.length === 1 && a === 'reports') return only(request, 'GET', () => listReports(ctx, url));
  if (parts.length === 3 && a === 'reports' && b !== undefined && SUBMISSION_ID.test(b)) {
    const id = b;
    if (c === 'confirm') return action(request, ctx, {}, () => resolveReport(ctx, id, true));
    if (c === 'decline') return action(request, ctx, {}, () => resolveReport(ctx, id, false));
  }
  if (parts.length === 3 && a === 'submissions' && b !== undefined && SUBMISSION_ID.test(b)) {
    const id = b;
    if (c === 'reveal') return action(request, ctx, {}, () => revealSubmission(ctx, id));
    if (c === 'approve') return action(request, ctx, { target: 'string', severity: 'string', overrideInnocent: 'boolean' }, (body) => approve(ctx, id, body));
    if (c === 'decline') return action(request, ctx, { reason: 'string' }, (body) => decline(ctx, id, body));
  }
  if (parts.length === 3 && a === 'terms' && b !== undefined && TERM_ID.test(b)) {
    const id = b;
    if (c === 'reveal') return action(request, ctx, {}, () => revealTerm(ctx, id));
    if (c === 'dispute') return action(request, ctx, {}, () => dispute(ctx, id));
    if (c === 'restore') return action(request, ctx, {}, () => restore(ctx, id));
    if (c === 'negative') return action(request, ctx, { line: 'any' }, (body) => addNegative(ctx, id, body));
  }
  return notFound();
}

const only = (request: Request, method: string, run: () => Response | Promise<Response>): Response | Promise<Response> => (request.method === method ? run() : methodNotAllowed(method));

async function servePage(ctx: Ctx, file: { name: string; type: string }): Promise<Response> {
  const asset = (await ctx.deps.assets?.(file.name)) ?? null;
  if (asset === null || !asset.ok) return notFound();
  return new Response(asset.body, {
    status: 200,
    headers: {
      'content-type': file.type,
      'content-security-policy': PAGE_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    },
  });
}

type Kinds = Record<string, 'string' | 'boolean' | 'any'>;

/**
 * A state-changing request. The Access cookie rides along with a request another site makes, so this refuses what a browser would send from
 * elsewhere: another origin, a cross-site fetch, and any body type a form or a simple request can carry. The body is JSON, small, an object,
 * with only the keys the action names.
 */
async function action(request: Request, ctx: Ctx, keys: Kinds, run: (body: Record<string, unknown>) => Promise<Response>): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== 'same-origin' && site !== 'none')) {
    logEvent(ctx.deps, 'review', 'csrf');
    return err(403, 'forbidden');
  }
  if (!/^application\/json\s*(;.*)?$/i.test(request.headers.get('content-type') ?? '')) return err(400, 'invalid');
  const bytes = await readCapped(request, BODY_MAX);
  if (bytes === null) return err(400, 'invalid');
  let body: Record<string, unknown> = {};
  if (bytes.length > 0) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return err(400, 'invalid');
      body = value as Record<string, unknown>;
    } catch {
      return err(400, 'invalid');
    }
  }
  for (const [k, v] of Object.entries(body)) {
    const kind = keys[k];
    if (kind === undefined || (kind !== 'any' && typeof v !== kind)) return err(400, 'invalid');
  }
  return run(body);
}

// ---- helpers ----

function parseList(text: unknown): string[] {
  try {
    const v: unknown = JSON.parse(String(text));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const audit = (ctx: Ctx, action: string, subject: string): D1Statement =>
  ctx.deps.db.prepare('INSERT INTO audit (at, actor, action, subject) VALUES (?, ?, ?, ?)').bind(ctx.now, ctx.reviewer.email, action, subject);

const q = (ctx: Ctx, sql: string): D1Statement => ctx.deps.db.prepare(sql);

interface SubmissionRow {
  id: string;
  installation: string;
  word_key: string;
  term: string;
  language: string;
  category: string;
  target: string;
  note: string | null;
  status: string;
  reason: string | null;
  term_id: string | null;
  held: string | null;
}

const loadSubmission = (ctx: Ctx, id: string): Promise<SubmissionRow | null> => q(ctx, 'SELECT * FROM submissions WHERE id = ?').bind(id).first<SubmissionRow>();

interface TermRow {
  id: string;
  word_key: string;
  term: string;
  languages: string;
  category: string;
  target: string;
  severity: string;
  status: string;
  approvals: number;
  collides_with: string;
}

const loadTerm = (ctx: Ctx, id: string): Promise<TermRow | null> => q(ctx, 'SELECT * FROM terms WHERE id = ?').bind(id).first<TermRow>();

async function ownsInstallation(ctx: Ctx, installation: string): Promise<boolean> {
  const row = await q(ctx, 'SELECT 1 AS x FROM reviewer_installations WHERE lower(reviewer) = ? AND installation = ?').bind(ctx.reviewer.email, installation).first();
  return row !== null;
}

async function reviewedBy(ctx: Ctx, kind: string, id: string): Promise<string | null> {
  const row = await q(ctx, 'SELECT verdict FROM reviews WHERE subject_kind = ? AND subject_id = ? AND reviewer = ?').bind(kind, id, ctx.reviewer.email).first<{ verdict: string }>();
  return row === null ? null : row.verdict;
}

const isUnique = (e: unknown): string | null => (e instanceof Error && /UNIQUE/i.test(e.message) ? e.message : null);

/** Counts a reveal for the reviewer today and writes its audit row. The counter is keyed by a hash of the email, never the email. */
async function countReveal(ctx: Ctx, subject: string): Promise<{ reveals: number; breakReminder: boolean }> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ctx.reviewer.email)));
  const reveals = await hit(ctx.deps.db, `rev:${b64uEncode(digest).slice(0, 22)}`, ctx.today);
  await audit(ctx, 'review.reveal', subject).run();
  return { reveals, breakReminder: reveals % BREAK_EVERY === 0 };
}

function limitOf(url: URL): number | null {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  return /^\d{1,3}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= MAX_LIMIT ? Number(raw) : null;
}

// ---- the lists (masked) ----

async function listQueue(ctx: Ctx, url: URL): Promise<Response> {
  const status = url.searchParams.get('status') ?? 'open';
  const limit = limitOf(url);
  if (!SUBMISSION_STATUSES.includes(status) || limit === null) return err(400, 'invalid');
  const where = status === 'open' ? "s.status IN ('received','in_review')" : status === 'held' ? 's.held IS NOT NULL' : 's.status = ?';
  const bound = status === 'open' || status === 'held' ? [] : [status];
  const res = await q(
    ctx,
    `SELECT s.id, s.status, s.language, s.category, s.target, s.received_day, s.held,
       (SELECT COUNT(*) FROM reviews r WHERE r.subject_kind = 'submission' AND r.subject_id = s.id AND r.verdict = 'approve') AS approvals,
       (SELECT r.verdict FROM reviews r WHERE r.subject_kind = 'submission' AND r.subject_id = s.id AND r.reviewer = ?) AS mine
     FROM submissions s WHERE ${where} ORDER BY s.rowid DESC LIMIT ?`,
  )
    .bind(ctx.reviewer.email, ...bound, limit)
    .all<{ id: string; status: string; language: string; category: string; target: string; received_day: string; held: string | null; approvals: number; mine: string | null }>();
  return json(200, {
    items: res.results.map((r) => ({ id: r.id, status: r.status, language: r.language, category: r.category, target: r.target, receivedDay: r.received_day, held: r.held, approvals: r.approvals, mine: r.mine })),
  });
}

async function listTerms(ctx: Ctx, url: URL): Promise<Response> {
  const status = url.searchParams.get('status') ?? 'disputed';
  const limit = limitOf(url);
  if (!TERM_STATUSES.includes(status) || limit === null) return err(400, 'invalid');
  const res = await q(ctx, 'SELECT id, status, languages, category, target, severity, approvals FROM terms WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
    .bind(status, limit)
    .all<{ id: string; status: string; languages: string; category: string; target: string; severity: string; approvals: number }>();
  return json(200, { items: res.results.map((r) => ({ id: r.id, status: r.status, languages: parseList(r.languages), category: r.category, target: r.target, severity: r.severity, approvals: r.approvals })) });
}

// ---- reveal ----

async function revealSubmission(ctx: Ctx, id: string): Promise<Response> {
  const s = await loadSubmission(ctx, id);
  if (s === null) return notFound();
  const gate = await crossLanguageGate({ term: s.term, languages: [s.language] }, ctx.deps.db);
  const known = await isKnownInnocent(ctx.deps.db, s.language, s.word_key);
  const seen = await countReveal(ctx, id);
  return json(200, {
    id: s.id,
    term: s.term,
    note: s.note,
    language: s.language,
    category: s.category,
    target: s.target,
    held: s.held,
    knownInnocent: known,
    collidesWith: gate.collidesWith,
    dictionary: gate.negatives,
    ...seen,
  });
}

async function revealTerm(ctx: Ctx, id: string): Promise<Response> {
  const t = await loadTerm(ctx, id);
  if (t === null) return notFound();
  const lines = await q(ctx, "SELECT line FROM term_lines WHERE term_id = ? AND kind = 'negative' AND origin = 'reviewer' ORDER BY line").bind(id).all<{ line: string }>();
  const seen = await countReveal(ctx, id);
  return json(200, {
    id: t.id,
    term: t.term,
    status: t.status,
    languages: parseList(t.languages),
    category: t.category,
    target: t.target,
    severity: t.severity,
    approvals: t.approvals,
    collidesWith: parseList(t.collides_with),
    negatives: lines.results.map((r) => r.line),
    ...seen,
  });
}

// ---- approve ----

/** The new status and approval count of a term, from the reviews of the submission(s) it came from. */
const RECOMPUTE = `UPDATE terms SET
    approvals = (SELECT COUNT(*) FROM reviews WHERE subject_kind = 'submission' AND verdict = 'approve' AND subject_id IN (SELECT id FROM submissions WHERE term_id = ?1)),
    status = CASE WHEN (SELECT COUNT(*) FROM reviews WHERE subject_kind = 'submission' AND verdict = 'approve' AND subject_id IN (SELECT id FROM submissions WHERE term_id = ?1)) >= 2
                   AND (SELECT COUNT(*) FROM reviews WHERE subject_kind = 'submission' AND verdict = 'approve' AND fluent = 1 AND subject_id IN (SELECT id FROM submissions WHERE term_id = ?1)) >= 1
                  THEN 'accepted' ELSE 'provisional' END,
    updated_at = ?2
  WHERE id = ?1 AND status IN ('provisional','accepted')`;

async function approve(ctx: Ctx, id: string, body: Record<string, unknown>): Promise<Response> {
  const target = body.target;
  const severity = body.severity;
  const override = body.overrideInnocent === true;
  if (target !== undefined && (typeof target !== 'string' || !TARGETS.includes(target))) return err(400, 'invalid');
  if (severity !== undefined && (typeof severity !== 'string' || !SEVERITIES.includes(severity))) return err(400, 'invalid');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const s = await loadSubmission(ctx, id);
    if (s === null) return notFound();
    if (await ownsInstallation(ctx, s.installation)) return err(403, 'own_submission');
    if ((await reviewedBy(ctx, 'submission', id)) !== null) return err(409, 'already_reviewed');
    if (s.status === 'accepted' || s.status === 'merged' || (s.status === 'declined' && s.reason !== 'known_innocent')) return err(409, 'closed');

    let term: TermRow | null = null;
    if (s.term_id !== null) {
      term = await loadTerm(ctx, s.term_id);
      if (term === null || (term.status !== 'provisional' && term.status !== 'accepted')) return err(409, 'closed');
    } else {
      const same = await q(ctx, 'SELECT id FROM terms WHERE word_key = ?').bind(s.word_key).first<{ id: string }>();
      if (same !== null) return err(409, 'known');
    }

    // The gate: a word that is among the most common ordinary words of its language is held, unless a reviewer says otherwise.
    let overridden = false;
    if (term === null) {
      const innocent = s.reason === 'known_innocent' || (await isKnownInnocent(ctx.deps.db, s.language, s.word_key));
      if (innocent && !override) {
        await ctx.deps.db.batch([q(ctx, 'UPDATE submissions SET held = ? WHERE id = ?').bind('known_innocent', id), audit(ctx, 'review.hold', id)]);
        return err(409, 'held', { code: 'known_innocent' });
      }
      overridden = innocent;
    }

    const aim = target ?? term?.target ?? s.target;
    if (s.category === 'slur' && aim === 'none') return err(422, 'target_required');

    const fluent = ctx.reviewer.fluent.includes(s.language) ? 1 : 0;
    const statements: D1Statement[] = [];
    let termId: string;
    if (term === null) {
      termId = await nextTermId(ctx);
      const gate = await crossLanguageGate({ term: s.term, languages: [s.language] }, ctx.deps.db);
      statements.push(
        q(ctx, `INSERT INTO terms (id, word_key, term, languages, category, target, severity, status, default_active, collides_with, since, approvals, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'provisional', 1, ?, NULL, 0, ?, ?)`).bind(
          termId,
          s.word_key,
          s.term,
          JSON.stringify([s.language]),
          s.category,
          aim,
          severity ?? DEFAULT_SEVERITY[s.category] ?? 'rude',
          JSON.stringify(gate.collidesWith),
          ctx.now,
          ctx.now,
        ),
        q(ctx, 'UPDATE submissions SET term_id = ? WHERE id = ?').bind(termId, id),
      );
    } else {
      termId = term.id;
      if (target !== undefined || severity !== undefined) {
        statements.push(q(ctx, 'UPDATE terms SET target = COALESCE(?, target), severity = COALESCE(?, severity) WHERE id = ?').bind(target ?? null, severity ?? null, termId));
      }
    }
    statements.push(
      q(ctx, 'INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES (?, ?, ?, ?, ?, ?)').bind('submission', id, ctx.reviewer.email, 'approve', fluent, ctx.now),
      q(ctx, RECOMPUTE).bind(termId, ctx.now),
      q(ctx, `UPDATE submissions SET held = NULL, reason = NULL,
                status = CASE WHEN (SELECT status FROM terms WHERE id = ?1) = 'accepted' THEN 'accepted' ELSE 'in_review' END,
                decided_at = CASE WHEN (SELECT status FROM terms WHERE id = ?1) = 'accepted' THEN ?2 ELSE NULL END
              WHERE id = ?3`).bind(termId, ctx.now, id),
    );
    if (overridden) statements.push(audit(ctx, 'review.override', id));
    statements.push(audit(ctx, 'review.approve', id));
    try {
      await ctx.deps.db.batch(statements);
    } catch (e) {
      const unique = isUnique(e);
      if (unique === null) throw e;
      if (/reviews/i.test(unique)) return err(409, 'already_reviewed');
      continue; // another reviewer made the term first: read it again and approve that one
    }
    const made = await loadTerm(ctx, termId);
    return json(200, { status: made?.status ?? 'provisional', termId, approvals: made?.approvals ?? 1 });
  }
  return err(409, 'conflict');
}

/** `CWT-<year>-<5 digits>`: the next number of the year. Ids are never reused: a withdrawn term keeps its row, so keeps its number. */
async function nextTermId(ctx: Ctx): Promise<string> {
  const year = ctx.today.slice(0, 4);
  const row = await q(ctx, 'SELECT MAX(CAST(substr(id, 10) AS INTEGER)) AS n FROM terms WHERE id LIKE ?').bind(`CWT-${year}-%`).first<{ n: number | null }>();
  return `CWT-${year}-${String((row?.n ?? 0) + 1).padStart(5, '0')}`;
}

// ---- decline ----

async function decline(ctx: Ctx, id: string, body: Record<string, unknown>): Promise<Response> {
  const reason = body.reason;
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return err(400, 'invalid');
  const s = await loadSubmission(ctx, id);
  if (s === null) return notFound();
  if (await ownsInstallation(ctx, s.installation)) return err(403, 'own_submission');
  if (s.status === 'declined' || s.status === 'accepted' || s.status === 'merged') return err(409, 'closed');
  if (s.term_id !== null) return err(409, 'has_term');
  if ((await reviewedBy(ctx, 'submission', id)) !== null) return err(409, 'already_reviewed');
  try {
    await ctx.deps.db.batch([
      q(ctx, 'INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES (?, ?, ?, ?, ?, ?)').bind('submission', id, ctx.reviewer.email, 'decline', ctx.reviewer.fluent.includes(s.language) ? 1 : 0, ctx.now),
      q(ctx, "UPDATE submissions SET status = 'declined', reason = ?, decided_at = ?, held = NULL WHERE id = ?").bind(reason, ctx.now, id),
      audit(ctx, 'review.decline', id),
    ]);
  } catch (e) {
    if (isUnique(e) !== null) return err(409, 'already_reviewed');
    throw e;
  }
  return json(200, { status: 'declined', reason });
}

// ---- dispute, restore, negative lines ----

async function dispute(ctx: Ctx, id: string): Promise<Response> {
  const t = await loadTerm(ctx, id);
  if (t === null) return notFound();
  if (t.status === 'disputed') return err(409, 'already_disputed');
  if (t.status === 'withdrawn') return err(409, 'closed');
  if ((await reviewedBy(ctx, 'term', id)) !== null) return err(409, 'already_reviewed');
  await ctx.deps.db.batch([
    q(ctx, 'INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES (?, ?, ?, ?, ?, ?)').bind('term', id, ctx.reviewer.email, 'dispute', 0, ctx.now),
    q(ctx, "UPDATE terms SET status = 'disputed', updated_at = ? WHERE id = ?").bind(ctx.now, id),
    audit(ctx, 'review.dispute', id),
  ]);
  return json(200, { status: 'disputed' });
}

/** Restoring a disputed or withdrawn term takes two reviewers; the one who disputed it, and anyone who already voted, cannot be one of them. */
async function restore(ctx: Ctx, id: string): Promise<Response> {
  const t = await loadTerm(ctx, id);
  if (t === null) return notFound();
  if (t.status !== 'disputed' && t.status !== 'withdrawn') return err(409, 'not_disputed');
  if ((await reviewedBy(ctx, 'term', id)) !== null) return err(409, 'already_reviewed');
  const before = await q(ctx, "SELECT COUNT(*) AS n FROM reviews WHERE subject_kind = 'term' AND subject_id = ? AND verdict = 'restore'").bind(id).first<{ n: number }>();
  const votes = (before?.n ?? 0) + 1;
  const vote = q(ctx, 'INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES (?, ?, ?, ?, ?, ?)').bind('term', id, ctx.reviewer.email, 'restore', 0, ctx.now);
  if (votes < 2) {
    await ctx.deps.db.batch([vote, audit(ctx, 'review.restore', id)]);
    return json(200, { status: 'disputed', votes });
  }
  // The second vote: back to what its approvals earned, and the dispute and restore votes are cleared so the term can be disputed again.
  await ctx.deps.db.batch([
    vote,
    q(
      ctx,
      `UPDATE terms SET status = CASE WHEN (SELECT COUNT(*) FROM reviews WHERE subject_kind = 'submission' AND verdict = 'approve' AND subject_id IN (SELECT id FROM submissions WHERE term_id = ?1)) >= 2
                                         AND (SELECT COUNT(*) FROM reviews WHERE subject_kind = 'submission' AND verdict = 'approve' AND fluent = 1 AND subject_id IN (SELECT id FROM submissions WHERE term_id = ?1)) >= 1
                                    THEN 'accepted' ELSE 'provisional' END, updated_at = ?2 WHERE id = ?1`,
    ).bind(id, ctx.now),
    q(ctx, "DELETE FROM reviews WHERE subject_kind = 'term' AND subject_id = ? AND verdict IN ('dispute','restore')").bind(id),
    q(ctx, "UPDATE reports SET status = 'restored' WHERE term_id = ? AND status IN ('disputed','withdrawn')").bind(id),
    audit(ctx, 'review.restore', id),
  ]);
  const after = await loadTerm(ctx, id);
  return json(200, { status: after?.status ?? 'provisional' });
}

async function addNegative(ctx: Ctx, id: string, body: Record<string, unknown>): Promise<Response> {
  const line = typeof body.line === 'string' ? readNote(body.line) : undefined;
  if (line === undefined || line === null) return err(400, 'invalid');
  const t = await loadTerm(ctx, id);
  if (t === null) return notFound();
  const out = await ctx.deps.db.batch([
    q(ctx, "INSERT OR IGNORE INTO term_lines (term_id, kind, line, origin) VALUES (?, 'negative', ?, 'reviewer')").bind(id, line),
    q(ctx, 'INSERT INTO audit (at, actor, action, subject) SELECT ?, ?, ?, ? WHERE changes() > 0').bind(ctx.now, ctx.reviewer.email, 'review.negative', id),
  ]);
  return json(200, { added: (out[0]?.meta.changes ?? 0) > 0 });
}

// ---- reports (design 10.4, 10.6) ----

const REPORT_STATUSES = ['received', 'disputed', 'withdrawn', 'restored', 'declined'];

async function listReports(ctx: Ctx, url: URL): Promise<Response> {
  const status = url.searchParams.get('status') ?? 'received';
  const limit = limitOf(url);
  if (!REPORT_STATUSES.includes(status) || limit === null) return err(400, 'invalid');
  const res = await q(
    ctx,
    `SELECT r.id, r.term_id, r.kind, r.status, r.received_day,
       (SELECT COUNT(*) FROM reviews v WHERE v.subject_kind = 'report' AND v.subject_id = r.id AND v.verdict = 'dispute') AS votes,
       (SELECT v.verdict FROM reviews v WHERE v.subject_kind = 'report' AND v.subject_id = r.id AND v.reviewer = ?) AS mine,
       CASE WHEN r.kind = 'removal' AND (SELECT category FROM terms t WHERE t.id = r.term_id) = 'slur' THEN 2 ELSE 1 END AS needed
     FROM reports r WHERE r.status = ? ORDER BY r.rowid DESC LIMIT ?`,
  )
    .bind(ctx.reviewer.email, status, limit)
    .all<{ id: string; term_id: string; kind: string; status: string; received_day: string; votes: number; needed: number; mine: string | null }>();
  return json(200, {
    items: res.results.map((r) => ({ id: r.id, termId: r.term_id, kind: r.kind, status: r.status, receivedDay: r.received_day, votes: r.votes, needed: r.needed, mine: r.mine })),
  });
}

/**
 * A reviewer confirms or declines a report. An innocent-sense or wrong-category report that is confirmed disputes the term on one reviewer's word
 * (precision first); a removal needs two reviewers when the term is a slur, one otherwise, and then withdraws it. A decline by one reviewer
 * closes the report. The reporter is never told which.
 */
async function resolveReport(ctx: Ctx, id: string, confirm: boolean): Promise<Response> {
  const r = await q(ctx, 'SELECT id, term_id, kind, channel, status FROM reports WHERE id = ?').bind(id).first<{ id: string; term_id: string; kind: string; channel: string; status: string }>();
  if (r === null) return notFound();
  if (r.channel.startsWith('inst:') && (await ownsInstallation(ctx, r.channel.slice('inst:'.length)))) return err(403, 'own_submission');
  if (r.status !== 'received') return err(409, 'closed');
  if ((await reviewedBy(ctx, 'report', id)) !== null) return err(409, 'already_reviewed');
  const vote = q(ctx, 'INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES (?, ?, ?, ?, ?, ?)').bind('report', id, ctx.reviewer.email, confirm ? 'dispute' : 'decline', 0, ctx.now);
  if (!confirm) {
    await ctx.deps.db.batch([vote, q(ctx, "UPDATE reports SET status = 'declined' WHERE id = ?").bind(id), audit(ctx, 'review.report.decline', id)]);
    return json(200, { status: 'declined' });
  }
  const term = await loadTerm(ctx, r.term_id);
  const removal = r.kind === 'removal';
  const needed = removal && term?.category === 'slur' ? 2 : 1;
  const before = await q(ctx, "SELECT COUNT(*) AS n FROM reviews WHERE subject_kind = 'report' AND subject_id = ? AND verdict = 'dispute'").bind(id).first<{ n: number }>();
  const votes = (before?.n ?? 0) + 1;
  if (votes < needed) {
    await ctx.deps.db.batch([vote, audit(ctx, 'review.report.confirm', id)]);
    return json(200, { status: 'received', votes, needed });
  }
  const outcome = removal ? 'withdrawn' : 'disputed';
  await ctx.deps.db.batch([
    vote,
    q(ctx, 'UPDATE reports SET status = ? WHERE id = ?').bind(outcome, id),
    q(ctx, "UPDATE terms SET status = ?, updated_at = ? WHERE id = ? AND status IN ('provisional','accepted','disputed')").bind(outcome, ctx.now, r.term_id),
    audit(ctx, 'review.report.confirm', id),
  ]);
  return json(200, { status: outcome, votes, needed });
}
