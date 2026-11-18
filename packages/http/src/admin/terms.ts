import { safeWarn } from '@chatwarden/core';
import type { AuditAction } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import { REF_PARAM_RE } from '../router.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { isUntouchedCommunityRow } from './community.js';
import { bodyObject, has } from './validate.js';

// The term routes talk to the matcher package's `LiveTerms` through the small structural interface below, so this
// package has no runtime dependency on `@chatwarden/matcher`: hand it a `LiveTerms` and it fits.

/** What the function given to {@link TermsAdmin.change} may do (the matcher's `TermEditor`, as far as these routes use it). */
export interface TermsEditor {
  /** Returns the new row id. */
  addTerm(input: { term: string; language: string; note?: string | null; matchMode?: TermMatchMode | null }): string;
  updateTerm(id: string, patch: { term?: string; language?: string; note?: string | null; matchMode?: TermMatchMode | null }): void;
  setTermActive(id: string, active: boolean): void;
  /** Returns the new row id. */
  addException(input: { phrase: string; language: string; note?: string | null }): string;
  updateException(id: string, patch: { phrase?: string; language?: string; note?: string | null }): void;
  setExceptionActive(id: string, active: boolean): void;
}

/**
 * Who changed a term or exception and when, as far as the term source knows. Every field is optional: a source that keeps
 * none of it (or a row the matcher read from a pack) reads as `null` in `GET /terms`.
 */
export interface TermMetadata {
  note?: string | null;
  addedBy?: string | null;
  addedAt?: number | null;
  updatedBy?: string | null;
  updatedAt?: number | null;
}

/** How a term is matched: `word` (a plain a-z term), `segment` (the default for a term in a script written without spaces) or `contains`. */
export type TermMatchMode = 'word' | 'segment' | 'contains';

/** A term row, with its metadata when the source has it. `matchMode` is present only on a row that has one (absent: by script). */
export interface TermListRow extends TermMetadata {
  id: string;
  term: string;
  language: string;
  active: boolean;
  matchMode?: TermMatchMode | null;
}

/** An exception row, with its metadata when the source has it. */
export interface ExceptionListRow extends TermMetadata {
  id: string;
  phrase: string;
  language: string;
  active: boolean;
}

/** The part of the matcher's `LiveTerms` the staff API uses. */
export interface TermsAdmin {
  /** The rows the live matcher was built from. */
  readonly rows: {
    readonly terms: readonly TermListRow[];
    readonly exceptions: readonly ExceptionListRow[];
  };
  /**
   * The same rows with their metadata (note, who added or changed them, and when). `GET /terms` lists these when present
   * and falls back to `rows` (metadata `null`) when not. `LiveTerms.records` is this.
   */
  records?(): {
    readonly terms: readonly TermListRow[];
    readonly exceptions: readonly ExceptionListRow[];
  };
  /**
   * The live matcher's check of one chat line: the id of the term row that blocks it, or null. Pure: `POST /terms/test` is
   * mounted only when this is present. `LiveTerms.match` is this.
   */
  match?(text: string): { termId: string } | null;
  /** The dry run: the lines this candidate would block, read in `matchMode` (and, for a term in a script written without spaces, the mode it was read in). Writes nothing. */
  check(term: string, language: string, recentLines: readonly string[], matchMode?: TermMatchMode | null): { ok: true; hits: string[]; matchMode?: 'segment' | 'contains' } | { ok: false; error: string };
  /** Run an edit atomically with the matcher reload. A refusal is `{ ok: false }`; the message is never passed on. */
  change<T>(actor: string, fn: (edit: TermsEditor) => T): Promise<{ ok: true; value: T } | { ok: false; error: string }>;
}

/** The longest term or phrase. */
const WORD_MAX = 200;
const NOTE_MAX = 500;
/** A language tag: `en`, `es`, `pt-BR`. */
const LANGUAGE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/**
 * Every `{ ok: false }` from the matcher is 400 `invalid_term`, whatever the reason (a duplicate, a malformed word, the last
 * active term, an exception that would unblock a pack line) and its message is dropped (it can name a row). That includes
 * the matcher's `'not loaded'` (a change before `load()` has seeded the store): strictly a server state rather than a bad
 * request, but the caller can only retry later, and a fixed 400 keeps one response shape and leaks nothing.
 */
const refused = (): HttpError => new HttpError('invalid_term');

const word = (v: unknown): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > WORD_MAX) throw new ValidationError();
  return v;
};
const language = (v: unknown): string => {
  if (typeof v !== 'string' || !LANGUAGE_RE.test(v)) throw new ValidationError();
  return v;
};
/**
 * A mode from a body: absent or null is none; `word`, `segment` and `contains` are the three; anything else (an unknown mode, a non-text value) is a refused term, `400 invalid_term`, like a mode that does not fit the term
 * (the matcher says that). Never echoes the value.
 */
const modeOf = (body: Record<string, unknown>): { matchMode: TermMatchMode | null } | Record<string, never> => {
  if (!has(body, 'matchMode')) return {};
  const v = body.matchMode;
  if (v === null || v === 'word' || v === 'segment' || v === 'contains') return { matchMode: v };
  throw refused();
};
const note = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > NOTE_MAX) throw new ValidationError();
  return v;
};

/**
 * The term and exception routes, built only when the adopter passes `terms` (staff only):
 * - `GET /terms`: the rows, `{ terms, exceptions, blocks30d }`, text and metadata included (`terms.read`). Each row also has
 *   `note`, `addedBy`, `addedAt`, `updatedBy` and `updatedAt` (null when unknown), and `blocks30d` maps every listed term id to
 *   the number of lines it blocked in the last 30 days. Writes no audit row.
 * - `POST /terms/check { term, language, matchMode? }`: the dry run, `{ hits }` (`terms.read`), and for a term in a script written without spaces `matchMode`, the mode it was read in (`segment`, or `contains` when asked). Writes no
 *   audit row. A `matchMode` of `word`, `segment` or `contains` (or null) is read; any other value is 400 `invalid_term`.
 * - `POST /terms/test { text }`: would the live list block this chat line? `{ verdict: 'blocked' | 'clean' | 'too_long', termId }`
 *   (`terms.read`). Side-effect free: no strike, audit row, rate charge or log. Mounted only when `terms.match` is present.
 * - `POST /terms { term, language, note?, matchMode? }`, `PATCH /terms/:id { term?, language?, note?, matchMode? }`, `POST /terms/:id/active { active }`
 *   (`terms.write`; audit `term.add`, `term.update`, `term.toggle`, each with the row id)
 * - `POST /exceptions { phrase, language, note? }`, `PATCH /exceptions/:id`, `POST /exceptions/:id/active`: the same for
 *   exceptions (audit `exception.add`, `exception.update`, `exception.toggle`)
 * The row id in `:id` uses the audit-ref charset (`A-Z a-z 0-9 _ . : -`, 1..64, never only dots), so a pack's own ids such as
 * `syn:zorbak` can be edited; a stored id outside it cannot be reached, and building the routes logs
 * `chatwarden.http_unroutable_term_ids` with a count (never an id or text) when there is one. Term pack ids should match it.
 *
 * Audit: a write leaves TWO rows. The matcher's editor (`LiveTerms.change`) writes its own row in the same transaction as the
 * edit (role null; add/edit/enable/disable read back as `term.add`/`term.update`/`term.toggle`, and the same for exceptions);
 * the route then adds its own row with the caller's role, which is the one that meets the audit contract. A no-op toggle
 * leaves only the route row (the editor writes nothing). Both rows hold the row id, never the text.
 * `matchMode` is how a term is matched: `segment` (the default for a term in Chinese, Japanese, Thai, Lao, Khmer or Burmese: it must occupy whole segments of the text) or `contains`; `word` is the only mode of a plain a-z term. `null` clears it
 * (by script). A mode that does not fit the term, the language or the length is 400 `invalid_term`, like any refused term. `GET /terms` rows carry `matchMode` only when they have one.
 * The term text appears in the `GET /terms` rows and the `check` hits only. A refused change is 400 `invalid_term` with a fixed
 * message: the matcher's reason, the term and the row ids it names are never passed on, and the text is never in an audit row.
 */
export function termRoutes(ctx: AdminContext, terms: TermsAdmin, recentLines: () => readonly string[], community?: { expose: boolean }): RouteTable {
  type Kind = 'term' | 'exception';
  // A stored id the `:id~ref` pattern would 404 can be listed but never edited: say so once, by count only.
  const unroutable = [...terms.rows.terms, ...terms.rows.exceptions].filter((r) => !REF_PARAM_RE.test(r.id)).length;
  if (unroutable > 0) safeWarn(ctx.logger, 'chatwarden.http_unroutable_term_ids', { count: unroutable });
  const { cw } = ctx;
  const table: RouteTable = {
    'GET /terms': ctx.secure('terms.read', () => {
      const all = terms.records?.() ?? terms.rows;
      // With the shared list wired, community rows no person has touched are counted, not listed (design 8.5): no bulk term data reaches
      // the browser by default. A row someone edited is the adopter's and is listed like any other.
      let rows = all;
      let hidden = 0;
      if (community !== undefined && !community.expose) {
        rows = {
          terms: all.terms.filter((t) => !isUntouchedCommunityRow(t)),
          exceptions: all.exceptions.filter((e) => !isUntouchedCommunityRow(e)),
        };
        hidden = all.terms.length - rows.terms.length + (all.exceptions.length - rows.exceptions.length);
      }
      const meta = (r: TermMetadata) => ({
        note: r.note ?? null,
        addedBy: r.addedBy ?? null,
        addedAt: r.addedAt ?? null,
        updatedBy: r.updatedBy ?? null,
        updatedAt: r.updatedAt ?? null,
      });
      // Every listed term gets a count (zero when it blocked nothing); strikes of a term that is no longer listed are left out.
      const counts = cw.blocked.countsByTerm({ days: 30 });
      // No prototype, so a term id of `__proto__` is kept as a key like any other.
      const blocks30d: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const t of rows.terms) blocks30d[t.id] = counts[t.id] ?? 0;
      return {
        status: 200,
        body: {
          // `matchMode` only on a row that has one: a list of rows with none is what it was.
          terms: rows.terms.map((t) => ({ id: t.id, term: t.term, language: t.language, active: t.active, ...(t.matchMode === null || t.matchMode === undefined ? {} : { matchMode: t.matchMode }), ...meta(t) })),
          exceptions: rows.exceptions.map((e) => ({ id: e.id, phrase: e.phrase, language: e.language, active: e.active, ...meta(e) })),
          blocks30d,
          ...(community === undefined ? {} : { community: { hidden } }),
        },
      };
    }),

    'POST /terms/check': ctx.secure('terms.read', (c) => {
      const body = bodyObject(c.req);
      const mode = modeOf(body);
      const result = terms.check(word(body.term), language(body.language), recentLines(), mode.matchMode);
      if (!result.ok) throw refused();
      // The mode a term in a script written without spaces was read in; a plain word has none and the answer is what it was.
      return { status: 200, body: { hits: result.hits, ...(result.matchMode === undefined ? {} : { matchMode: result.matchMode }) } };
    }),
  };

  const { match } = terms;
  if (typeof match === 'function') {
    table['POST /terms/test'] = ctx.secure('terms.read', (c) => {
      const body = bodyObject(c.req);
      if (typeof body.text !== 'string') throw new ValidationError();
      // The chat path's own measure and limit (after trimming), so the tester agrees with what a player can send. A long line
      // is never handed to the matcher.
      if (body.text.trim().length > cw.limits.chatMaxLength) return { status: 200, body: { verdict: 'too_long', termId: null } };
      const hit = match.call(terms, body.text.trim());
      return { status: 200, body: { verdict: hit === null ? 'clean' : 'blocked', termId: hit === null ? null : hit.termId } };
    });
  }

  const exists = (kind: Kind, id: string): boolean =>
    (kind === 'term' ? terms.rows.terms : terms.rows.exceptions).some((r) => r.id === id);

  /** The three write routes of one kind. `field` is the word's name in the body: `term` or `phrase`. */
  const writes = (kind: Kind, base: string, field: 'term' | 'phrase'): void => {
    const audit = (what: 'add' | 'update' | 'toggle'): AuditAction => `${kind}.${what}`;

    table[`POST ${base}`] = ctx.secure('terms.write', async (c) => {
      const body = bodyObject(c.req);
      const text = word(body[field]);
      const lang = language(body.language);
      const n = has(body, 'note') ? note(body.note) : undefined;
      const noteField = n === undefined ? {} : { note: n };
      // A mode belongs to a term: an exception has none (the key is ignored there, as any other unknown key is).
      const modeField = kind === 'term' ? modeOf(body) : {};
      const result = await terms.change(c.authz.actor, (edit) =>
        kind === 'term'
          ? edit.addTerm({ term: text, language: lang, ...noteField, ...modeField })
          : edit.addException({ phrase: text, language: lang, ...noteField }),
      );
      if (!result.ok) throw refused();
      // The row is written: an audit failure is logged, never turned into an error. The target is the row id, never the text.
      c.audit(audit('add'), { type: kind, ref: result.value }, 'best-effort');
      return { status: 200, body: { id: result.value } };
    });

    table[`PATCH ${base}/:id~ref`] = ctx.secure('terms.write', async (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      const word_ = has(body, field) ? word(body[field]) : undefined;
      const lang = has(body, 'language') ? language(body.language) : undefined;
      const n = has(body, 'note') ? note(body.note) : undefined;
      const modeField = kind === 'term' ? modeOf(body) : {};
      if (word_ === undefined && lang === undefined && n === undefined && !('matchMode' in modeField)) throw new ValidationError();
      if (!exists(kind, id)) throw new NotFoundError();
      const rest = { ...(lang === undefined ? {} : { language: lang }), ...(n === undefined ? {} : { note: n }) };
      const result = await terms.change(c.authz.actor, (edit) => {
        if (kind === 'term') edit.updateTerm(id, { ...rest, ...modeField, ...(word_ === undefined ? {} : { term: word_ }) });
        else edit.updateException(id, { ...rest, ...(word_ === undefined ? {} : { phrase: word_ }) });
      });
      if (!result.ok) throw refused();
      c.audit(audit('update'), { type: kind, ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    });

    table[`POST ${base}/:id~ref/active`] = ctx.secure('terms.write', async (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      const active = body.active;
      if (typeof active !== 'boolean') throw new ValidationError();
      if (!exists(kind, id)) throw new NotFoundError();
      const result = await terms.change(c.authz.actor, (edit) =>
        kind === 'term' ? edit.setTermActive(id, active) : edit.setExceptionActive(id, active),
      );
      if (!result.ok) throw refused();
      c.audit(audit('toggle'), { type: kind, ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    });
  };
  writes('term', '/terms', 'term');
  writes('exception', '/exceptions', 'phrase');
  return table;
}
