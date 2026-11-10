import { safeWarn } from '@chatwarden/core';
import type { AuditAction } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import { REF_PARAM_RE } from '../router.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyObject, has } from './validate.js';

// The term routes talk to the matcher package's `LiveTerms` through the small structural interface below, so this
// package has no runtime dependency on `@chatwarden/matcher`: hand it a `LiveTerms` and it fits.

/** What the function given to {@link TermsAdmin.change} may do (the matcher's `TermEditor`, as far as these routes use it). */
export interface TermsEditor {
  /** Returns the new row id. */
  addTerm(input: { term: string; language: string; note?: string | null }): string;
  updateTerm(id: string, patch: { term?: string; language?: string; note?: string | null }): void;
  setTermActive(id: string, active: boolean): void;
  /** Returns the new row id. */
  addException(input: { phrase: string; language: string; note?: string | null }): string;
  updateException(id: string, patch: { phrase?: string; language?: string; note?: string | null }): void;
  setExceptionActive(id: string, active: boolean): void;
}

/** The part of the matcher's `LiveTerms` the staff API uses. */
export interface TermsAdmin {
  /** The rows the live matcher was built from. */
  readonly rows: {
    readonly terms: readonly { id: string; term: string; language: string; active: boolean }[];
    readonly exceptions: readonly { id: string; phrase: string; language: string; active: boolean }[];
  };
  /** The dry run: the lines this candidate would block. Writes nothing. */
  check(term: string, language: string, recentLines: readonly string[]): { ok: true; hits: string[] } | { ok: false; error: string };
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
const note = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > NOTE_MAX) throw new ValidationError();
  return v;
};

/**
 * The term and exception routes, built only when the adopter passes `terms` (staff only):
 * - `GET /terms`: the rows, `{ terms, exceptions }`, text included (`terms.read`). Writes no audit row.
 * - `POST /terms/check { term, language }`: the dry run, `{ hits }` (`terms.read`). Writes no audit row.
 * - `POST /terms { term, language, note? }`, `PATCH /terms/:id { term?, language?, note? }`, `POST /terms/:id/active { active }`
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
 * The term text appears in the `GET /terms` rows and the `check` hits only. A refused change is 400 `invalid_term` with a fixed
 * message: the matcher's reason, the term and the row ids it names are never passed on, and the text is never in an audit row.
 */
export function termRoutes(ctx: AdminContext, terms: TermsAdmin, recentLines: () => readonly string[]): RouteTable {
  type Kind = 'term' | 'exception';
  // A stored id the `:id~ref` pattern would 404 can be listed but never edited: say so once, by count only.
  const unroutable = [...terms.rows.terms, ...terms.rows.exceptions].filter((r) => !REF_PARAM_RE.test(r.id)).length;
  if (unroutable > 0) safeWarn(ctx.logger, 'chatwarden.http_unroutable_term_ids', { count: unroutable });
  const table: RouteTable = {
    'GET /terms': ctx.secure('terms.read', () => {
      const { rows } = terms;
      return {
        status: 200,
        body: {
          terms: rows.terms.map((t) => ({ id: t.id, term: t.term, language: t.language, active: t.active })),
          exceptions: rows.exceptions.map((e) => ({ id: e.id, phrase: e.phrase, language: e.language, active: e.active })),
        },
      };
    }),

    'POST /terms/check': ctx.secure('terms.read', (c) => {
      const body = bodyObject(c.req);
      const result = terms.check(word(body.term), language(body.language), recentLines());
      if (!result.ok) throw refused();
      return { status: 200, body: { hits: result.hits } };
    }),
  };

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
      const result = await terms.change(c.authz.actor, (edit) =>
        kind === 'term'
          ? edit.addTerm({ term: text, language: lang, ...noteField })
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
      if (word_ === undefined && lang === undefined && n === undefined) throw new ValidationError();
      if (!exists(kind, id)) throw new NotFoundError();
      const rest = { ...(lang === undefined ? {} : { language: lang }), ...(n === undefined ? {} : { note: n }) };
      const result = await terms.change(c.authz.actor, (edit) => {
        if (kind === 'term') edit.updateTerm(id, { ...rest, ...(word_ === undefined ? {} : { term: word_ }) });
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
