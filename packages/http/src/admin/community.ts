import { errorClass, safeWarn } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import { REF_PARAM_RE } from '../router.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import type { TermListRow, TermsAdmin } from './terms.js';
import { bodyObject } from './validate.js';

// The staff routes of the shared term list (design 8.5), built only when the adopter passes `community`. This package imports no matcher
// code: the loader, the live list and the share client are described by the small structural types below, and the matcher's own objects
// fit them. Nothing here ever puts a term in a response, a log line or an audit row, except the two routes whose job is to hand one row to
// staff (`GET /terms/:id` and `POST /terms/lookup`), and the share route, which sends a word to the service and to nobody else.

/** What applying a release would change, or did, counted over terms and exceptions together. */
export interface CommunitySummary {
  added: number;
  deactivated: number;
  reactivated: number;
  changed: number;
  keptYours: number;
  skipped: number;
}

/** The loader's status (the matcher's `CorpusStatus`, as far as these routes read it). */
export interface CommunityStatus {
  state: string;
  applied: string | null;
  available: string | null;
  lastCheckedAt: number | null;
  lastError: { code: string; stage: string; at: number } | null;
  pending: CommunitySummary | null;
}

/** The verified release, as far as the status page shows it. Rows are never read from it. */
export interface CommunityRelease {
  version: string;
  manifest: {
    languages: readonly string[];
    license: { spdx: string; attribution: string };
    counts: {
      terms: Readonly<Record<string, number>>;
      exceptions: Readonly<Record<string, number>>;
      status: { accepted: number; provisional: number; disputed: number; withdrawn: number };
    };
  };
}

/** What a live list takes from a loader (`LiveTerms.syncPack` fits). */
export interface CommunitySyncTarget {
  syncPack(pack: never, options: { actor: string; dryRun?: boolean }): unknown;
}

/** The answer of the loader's `applyTo` (the matcher's `SyncResult`). */
export type CommunitySyncResult = { ok: true; summary: CommunitySummary; version: string } | { ok: false; code: string };

/** The matcher's `CorpusLoader`, as far as these routes use it. */
export interface CommunityLoader {
  refresh(): Promise<{ status: CommunityStatus; changed: boolean }>;
  status(): CommunityStatus;
  /** Apply the verified pack to the live list; null when nothing is verified. The routes pass no actor, so rows are stamped `corpus:<version>`. */
  applyTo(terms: CommunitySyncTarget, actor?: string): CommunitySyncResult | null;
  release?(): CommunityRelease | null;
}

/** What a share sends: one word, from a row of the adopter's own, and what the person chose. */
export interface CommunityShareInput {
  term: string;
  language: string;
  category: 'slur' | 'abuse' | 'sexual' | 'other';
  target?: string;
  note?: string | null;
}

/** The matcher's `CommunityShare`. Answers are read defensively: only a closed set of words ever comes out of them. */
export interface CommunityShareClient {
  share(input: CommunityShareInput): Promise<unknown>;
  status(id: string): Promise<unknown>;
  /** Report a problem with a term of the list: a term id and a closed kind. Without it the hub shows no report action. */
  report?(input: { termId: string; kind: 'innocent_sense' | 'wrong_category' | 'removal' }): Promise<unknown>;
}

/** What `adminRoutes` takes as `community`. */
export interface CommunityAdmin {
  loader: CommunityLoader;
  /** The live term list (a `LiveTerms`): read for rows, and handed to `loader.applyTo`. */
  live: TermsAdmin & CommunitySyncTarget;
  /** With it the hub shows a Share action; without it nothing is ever sent. */
  share?: CommunityShareClient;
  /** List the untouched community rows in `GET /terms` (default false: they are counted and reached one at a time). */
  exposeCommunityRows?: boolean;
}

/** A row the shared list added: `addedBy` is `corpus:<version>`. */
export const isCommunityRow = (r: TermListRow | { addedBy?: string | null }): boolean => typeof r.addedBy === 'string' && r.addedBy.startsWith('corpus:');

/**
 * A community row no person has touched. `updatedBy` is null, or a `corpus:` actor (the list itself changed it, which never makes a row
 * the adopter's); a person's edit stamps their own actor, and from then on the row is the adopter's and is listed.
 */
export const isUntouchedCommunityRow = (r: { addedBy?: string | null; updatedBy?: string | null }): boolean =>
  isCommunityRow(r) && (r.updatedBy === null || r.updatedBy === undefined || r.updatedBy.startsWith('corpus:'));

const CATEGORIES: readonly string[] = ['slur', 'abuse', 'sexual', 'other'];
const TARGETS: readonly string[] = ['ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'];
const REPORT_KINDS: readonly string[] = ['innocent_sense', 'wrong_category', 'removal'];
const SHARE_STATUSES: readonly string[] = ['received', 'in_review', 'accepted', 'declined', 'merged'];
const SHARE_REASONS: readonly string[] = ['known_innocent', 'not_a_term', 'duplicate', 'needs_context', 'other'];
const IMMEDIATE: readonly string[] = ['received', 'known', 'duplicate'];
const NOTE_MAX = 200;
const WORD_MAX = 200;
/** How many shared terms are remembered (their last answer and service id); the oldest go first. */
const REMEMBERED = 1000;
// eslint-disable-next-line no-control-regex -- a control character in a note is refused
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** A scheme, `www.`, an `@`, or a run of five digits: the note rules the service applies too. */
const NOTE_BAD_RE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|@|\d{5}/i;

/** The text of a word as the matcher reads it: accents stripped, trimmed, lowercase (the matcher's `foldTerm`). */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

const meta = (r: TermListRow) => ({
  note: r.note ?? null,
  addedBy: r.addedBy ?? null,
  addedAt: r.addedAt ?? null,
  updatedBy: r.updatedBy ?? null,
  updatedAt: r.updatedAt ?? null,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const tally = (v: unknown): Record<string, number> | null => {
  if (!isObject(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!count(n)) return null;
    out[k] = n;
  }
  return out;
};
const summary = (v: unknown): CommunitySummary | null => {
  if (!isObject(v)) return null;
  const { added, deactivated, reactivated, changed, keptYours, skipped } = v;
  if (![added, deactivated, reactivated, changed, keptYours, skipped].every(count)) return null;
  return { added, deactivated, reactivated, changed, keptYours, skipped } as CommunitySummary;
};

/** What `GET /community` says about the verified release, or nothing when there is none or it is not what was promised. */
function releaseFacts(loader: CommunityLoader): { languages: string[]; license: { spdx: string; attribution: string } | null; counts: unknown } {
  const none = { languages: [], license: null, counts: null };
  try {
    const release = loader.release?.();
    const m = isObject(release) ? release.manifest : undefined;
    if (!isObject(m)) return none;
    const languages = Array.isArray(m.languages) && m.languages.every((l) => typeof l === 'string' && /^[a-z]{2,3}$/.test(l)) ? (m.languages as string[]).slice(0, 16) : [];
    const lic = m.license;
    const license = isObject(lic) && typeof lic.spdx === 'string' && typeof lic.attribution === 'string' ? { spdx: lic.spdx, attribution: lic.attribution } : null;
    const c = m.counts;
    let counts: unknown = null;
    if (isObject(c)) {
      const terms = tally(c.terms);
      const exceptions = tally(c.exceptions);
      const status = tally(c.status);
      if (terms !== null && exceptions !== null && status !== null) counts = { terms, exceptions, status };
    }
    return { languages, license, counts };
  } catch {
    return none;
  }
}

/** The status as the hub reads it: fixed keys, the error as a code and a stage, never a time or a message. */
function statusBody(community: CommunityAdmin): Record<string, unknown> {
  const s = community.loader.status();
  const e = s.lastError;
  return {
    state: String(s.state),
    applied: s.applied ?? null,
    available: s.available ?? null,
    lastCheckedAt: s.lastCheckedAt ?? null,
    pending: summary(s.pending),
    lastError: e === null || e === undefined ? null : { code: String(e.code), stage: String(e.stage) },
    ...releaseFacts(community.loader),
    sharing: community.share !== undefined,
    reporting: typeof community.share?.report === 'function',
  };
}

/** A fixed answer for a share that did not go through; the service's own text is never read. */
function shareFailure(result: unknown): HttpError {
  const code = isObject(result) && result.ok === false ? result.code : undefined;
  if (code === 'rate_limited') return new HttpError('rate_limited');
  if (code === 'rejected' || code === 'unsupported_language') return new HttpError('share_refused');
  if (code === 'invalid' || code === 'too_large') return new ValidationError();
  return new HttpError('share_unavailable');
}

/** `{ category, target?, note? }`, checked: nothing else is accepted, so the body cannot carry a word, an id or a language. */
function shareBody(body: Record<string, unknown>): { category: CommunityShareInput['category']; target?: string; note?: string | null } {
  const keys = Object.keys(body);
  if (keys.some((k) => k !== 'category' && k !== 'target' && k !== 'note')) throw new ValidationError();
  const { category, target, note } = body;
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) throw new ValidationError();
  const out: { category: CommunityShareInput['category']; target?: string; note?: string | null } = { category: category as CommunityShareInput['category'] };
  if (target !== undefined) {
    if (typeof target !== 'string' || (target !== 'none' && !TARGETS.includes(target))) throw new ValidationError();
    out.target = target;
  }
  // A slur is aimed at someone: the reviewers need to know whom.
  if (category === 'slur' && (out.target === undefined || out.target === 'none')) throw new ValidationError();
  if (note !== undefined) {
    if (note !== null && (typeof note !== 'string' || note.length > NOTE_MAX || CONTROL_RE.test(note) || NOTE_BAD_RE.test(note))) throw new ValidationError();
    out.note = note;
  }
  return out;
}

/** `{ kind }`, checked: nothing else is accepted, so a report cannot carry text, a word or an id of the body's own. */
function reportBody(body: Record<string, unknown>): 'innocent_sense' | 'wrong_category' | 'removal' {
  if (Object.keys(body).some((k) => k !== 'kind')) throw new ValidationError();
  const { kind } = body;
  if (typeof kind !== 'string' || !REPORT_KINDS.includes(kind)) throw new ValidationError();
  return kind as 'innocent_sense' | 'wrong_category' | 'removal';
}

/**
 * The community routes, mounted when the adopter passes `community`:
 * - `GET /community` (`terms.read`): the loader's status, the release's languages, licence and counts, and whether sharing is on. No term.
 * - `POST /community/refresh` (`terms.write`): check now; the same body as the GET.
 * - `POST /community/apply` (`settings`): apply the verified pack with no staff actor (the rows are the list's, stamped `corpus:<version>`);
 *   the audit row `community.apply` (target `release:<version>`) names the staff member. 409 `nothing_to_apply`, 409 `apply_refused`.
 * - `GET /terms/:id` (`terms.read`): one row, a hidden community row too, with `community` and `blocks30d`.
 * - `POST /terms/lookup { word }` (`terms.read`): the row for an exact word (folded), or 404. The word is in the body, never the URL.
 * - with `community.share`: `POST /terms/:id/share { category, target?, note? }` (`terms.write`; audit `term.share`, target `term:<id>`; answer
 *   `{ status }` only; 409 `not_shareable` for a community row) and `GET /terms/:id/share` (`terms.read`; `{ status, reason? }`, or `{ status: null }` for a term never shared).
 * - with a `community.share` that can `report`: `POST /terms/:id/report { kind }` (`terms.write`; the row must be a community row, else 409
 *   `not_reportable`; sends the term id and the kind, never the word; audit `term.share`, target `term:<id>`; answer `{ status: 'received' }`).
 * A failed share or report is a fixed error code (`share_unavailable` 502, `share_refused` 422, `rate_limited` 429, 400), never the service's text.
 */
export function communityRoutes(ctx: AdminContext, community: CommunityAdmin): RouteTable {
  const { live, loader } = community;
  const share = community.share;
  const { cw } = ctx;
  const rows = (): readonly TermListRow[] => (live.records?.() ?? live.rows).terms;
  const find = (id: string): TermListRow | undefined => rows().find((r) => r.id === id);
  const body = (r: TermListRow): Record<string, unknown> => ({
    id: r.id,
    term: r.term,
    language: r.language,
    active: r.active,
    ...meta(r),
    community: isCommunityRow(r),
    blocks30d: cw.blocked.countsByTerm({ days: 30 })[r.id] ?? 0,
  });

  const table: RouteTable = {
    'GET /community': ctx.secure('terms.read', () => ({ status: 200, body: statusBody(community) })),

    'POST /community/refresh': ctx.secure('terms.write', async () => {
      await loader.refresh();
      return { status: 200, body: statusBody(community) };
    }),

    'POST /community/apply': ctx.secure('settings', (c) => {
      const result = loader.applyTo(live);
      if (result === null || result === undefined) throw new HttpError('nothing_to_apply');
      if (!isObject(result) || result.ok !== true) throw new HttpError('apply_refused');
      const version = String(result.version);
      // The list is changed: a failed audit write is logged, never turned into an error.
      c.audit('community.apply', { type: 'release', ref: version }, 'best-effort');
      return { status: 200, body: { ok: true, version, summary: summary(result.summary) } };
    }),

    'GET /terms/:id~ref': ctx.secure('terms.read', (c) => {
      const row = find(c.params.id as string);
      if (row === undefined) throw new NotFoundError();
      return { status: 200, body: body(row) };
    }),

    'POST /terms/lookup': ctx.secure('terms.read', (c) => {
      const b = bodyObject(c.req);
      if (Object.keys(b).some((k) => k !== 'word')) throw new ValidationError();
      const { word } = b;
      if (typeof word !== 'string' || word.trim() === '' || word.length > WORD_MAX) throw new ValidationError();
      const wanted = fold(word);
      const hits = rows().filter((r) => fold(r.term) === wanted);
      const row = hits.find((r) => r.active) ?? hits[0];
      if (row === undefined) throw new NotFoundError();
      return { status: 200, body: body(row) };
    }),
  };

  if (share !== undefined) {
    // The last answer for each term this server shared, by term id: nothing about the word, only the status and the service's id.
    const shared = new Map<string, { status: string; id: string | null }>();
    const remember = (termId: string, entry: { status: string; id: string | null }): void => {
      shared.delete(termId);
      shared.set(termId, entry);
      while (shared.size > REMEMBERED) shared.delete(shared.keys().next().value as string);
    };

    table['POST /terms/:id~ref/share'] = ctx.secure('terms.write', async (c) => {
      const id = c.params.id as string;
      const input = shareBody(bodyObject(c.req));
      const row = find(id);
      if (row === undefined) throw new NotFoundError();
      if (isCommunityRow(row)) throw new HttpError('not_shareable');
      let result: unknown;
      try {
        result = await share.share({ term: row.term, language: row.language, ...input });
      } catch (e) {
        // The error class only: its message can carry the word.
        safeWarn(ctx.logger, 'chatwarden.http_share_failed', { error: errorClass(e) });
        throw new HttpError('share_unavailable');
      }
      if (!isObject(result) || result.ok !== true || typeof result.status !== 'string' || !IMMEDIATE.includes(result.status)) throw shareFailure(result);
      remember(id, { status: result.status, id: typeof result.id === 'string' && REF_PARAM_RE.test(result.id) ? result.id : null });
      // The word has been sent: a failed audit write is logged, never turned into an error. The target is the row id, never the word.
      c.audit('term.share', { type: 'term', ref: id }, 'best-effort');
      return { status: 200, body: { status: result.status } };
    });

    if (typeof share.report === 'function') {
      const report = share.report.bind(share);
      table['POST /terms/:id~ref/report'] = ctx.secure('terms.write', async (c) => {
        const id = c.params.id as string;
        const kind = reportBody(bodyObject(c.req));
        const row = find(id);
        if (row === undefined) throw new NotFoundError();
        // The service knows the list's own ids; a row the adopter made is not on the list, so there is nothing to report.
        if (!isCommunityRow(row)) throw new HttpError('not_reportable');
        let result: unknown;
        try {
          result = await report({ termId: id, kind });
        } catch (e) {
          safeWarn(ctx.logger, 'chatwarden.http_share_failed', { error: errorClass(e) });
          throw new HttpError('share_unavailable');
        }
        if (!isObject(result) || result.ok !== true) throw shareFailure(result);
        // A report sends a term id and a kind, never the word. No new audit name exists for it: it is the same outward call as a share.
        c.audit('term.share', { type: 'term', ref: id }, 'best-effort');
        return { status: 200, body: { status: 'received' } };
      });
    }

    table['GET /terms/:id~ref/share'] = ctx.secure('terms.read', async (c) => {
      const id = c.params.id as string;
      if (find(id) === undefined) throw new NotFoundError();
      // A term that was never shared is not an error: `{ status: null }`, so a page that asks as it opens an editor logs nothing.
      const last = shared.get(id);
      if (last === undefined) return { status: 200, body: { status: null } };
      let answer: unknown = null;
      if (last.id !== null) {
        try {
          answer = await share.status(last.id);
        } catch (e) {
          safeWarn(ctx.logger, 'chatwarden.http_share_failed', { error: errorClass(e) });
        }
      }
      if (isObject(answer) && typeof answer.status === 'string' && SHARE_STATUSES.includes(answer.status)) {
        const reason = typeof answer.reason === 'string' && SHARE_REASONS.includes(answer.reason) ? { reason: answer.reason } : {};
        return { status: 200, body: { status: answer.status, ...reason } };
      }
      return { status: 200, body: { status: last.status } };
    });
  }
  return table;
}
