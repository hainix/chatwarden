import type { Clock, Logger } from '@chatwarden/core';
import {
  buildMatcher,
  MatcherBuildError,
  type ExceptionRow,
  type Matcher,
  type Span,
  type TermRow,
} from './matcher.js';
import { collapseLikePreset, foldPhrase, foldTerm } from './normalise.js';
import { matchName } from './names.js';
import type { TermPack } from './termPack.js';
import type { ExceptionRecord, TermRecord, TermStore } from './termStore.js';

/** The rows a matcher is built from. */
interface Rows {
  terms: TermRow[];
  exceptions: ExceptionRow[];
}

/** What the function given to {@link LiveTerms.change} may do. Every method is synchronous and writes one
 *  audit row (a no-op toggle or an empty patch writes nothing). `hits` is the dry-run result
 *  ({@link LiveTerms.check}) the moderator went ahead despite; it is kept in the audit row.
 *
 *  WARNING: `hits` are chat lines, and they are PERSISTED into the audit log (kept until the audit
 *  retention purges them: `retention.auditMs`, 365 days by default). Pass counts or a few capped, trimmed lines rather than everything `check` returned,
 *  and remember that players typed them. */
export interface TermEditor {
  /** Returns the new row id. */
  addTerm(input: { term: string; language: string; note?: string | null }, hits?: string[]): string;
  updateTerm(id: string, patch: { term?: string; language?: string; note?: string | null }, hits?: string[]): void;
  setTermActive(id: string, active: boolean): void;
  /** Returns the new row id. */
  addException(input: { phrase: string; language: string; note?: string | null }, hits?: string[]): string;
  updateException(id: string, patch: { phrase?: string; language?: string; note?: string | null }, hits?: string[]): void;
  setExceptionActive(id: string, active: boolean): void;
}

/**
 * Why {@link LiveTerms.change} refused, for a caller that branches on it instead of reading the message:
 * - `duplicate`: the word reads as the same as another row (terms and exceptions, any language, active or not).
 * - `unblocks_known`: an exception would unblock a line the pack requires blocked (a term's `positive` line or a
 *   `positiveCorpus` line that the terms alone block).
 * - `invalid`: a term or exception is malformed (blank, more than one word, too short), or no active term would remain.
 * - `not_found`: the edit named a term or exception id the store does not have.
 * - `not_loaded`: a pack is configured and `load()` / `loadSync()` has not built from the store yet.
 * - `build_failed`: the store failed while the edit was being checked and committed (the matcher rebuild reads it);
 *   nothing was changed and the error class was logged as `terms.change_failed`. A throw from the edit function itself is
 *   not a refusal: it rejects (or, in `changeSync`, throws).
 */
export type ChangeRefusalCode = 'duplicate' | 'unblocks_known' | 'invalid' | 'not_found' | 'not_loaded' | 'build_failed';

/** `error` is a message safe to show a moderator (it never quotes a term or a line); `code` is the same refusal as data. */
export type ChangeResult<T> = { ok: true; value: T } | { ok: false; error: string; code: ChangeRefusalCode };
export type CheckResult = { ok: true; hits: string[] } | { ok: false; error: string };

/** A change the rules refuse. The message is safe to hand back to a moderator (it never quotes a term). */
class Refusal extends Error {
  readonly code: ChangeRefusalCode;
  constructor(code: ChangeRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Local on purpose: core's randomId is internal, and this package must still link against core 0.1.0 (peer ^0.1.0).
 *  16 random bytes as 22 unpadded base64url characters. Web Crypto (`globalThis.crypto`, present in Node and every browser),
 *  never a `node:` import, so the matcher bundles for a browser. */
function newId(): string {
  const raw = new Uint8Array(16);
  (globalThis as { crypto: { getRandomValues(a: Uint8Array): unknown } }).crypto.getRandomValues(raw);
  let out = '';
  for (let i = 0; i < 15; i += 3) {
    const n = (raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!;
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const last = raw[15]! << 16;
  return out + B64URL[last >> 18]! + B64URL[(last >> 12) & 63]!;
}
const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** Describes a build failure without quoting the term, which MatcherBuildError's message does. */
function describeBuildError(err: MatcherBuildError, withRow: boolean): string {
  const where = withRow && err.rowId ? `row ${err.rowId}` : 'term';
  return `malformed ${where}: ${err.reason ?? 'invalid'}`;
}

/** A term row with who added or last changed it and when. `null` metadata means it is not known (the pack stands in for the store). */
export interface TermListRow extends TermRow {
  note: string | null;
  addedBy: string | null;
  addedAt: number | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** An exception row with who added or last changed it and when. `null` metadata means it is not known. */
export interface ExceptionListRow extends ExceptionRow {
  note: string | null;
  addedBy: string | null;
  addedAt: number | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

const plainTerm = (r: TermRecord): TermRow => ({ id: r.id, term: r.term, language: r.language, active: r.active });
const plainException = (r: ExceptionRecord): ExceptionRow => ({
  id: r.id,
  phrase: r.phrase,
  language: r.language,
  active: r.active,
});

const isThenable = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

const NEVER: Matcher = { match: () => null, spans: () => [], matchName: () => null };

/** Terms and exceptions share a shape apart from the word column, so one set of edit internals serves both. */
interface Kind {
  subject: 'term' | 'exception';
  /** The stored form of the word. */
  fold(word: string): string;
  /** What the matcher compares: two words with the same key are the same word. */
  key(word: string): string;
  words(): { id: string; word: string }[];
  get(id: string): TermRecord | ExceptionRecord | undefined;
  insert(id: string, word: string, language: string, note: string | null, actor: string, at: number): void;
  patch(id: string, p: { word?: string; language?: string; note?: string | null }, actor: string, at: number): void;
  setActive(id: string, active: boolean, actor: string, at: number): void;
}

/**
 * The matcher an app holds. The store is the source of truth once a pack has seeded it; moderators edit it
 * through {@link change}, which makes the write, its audit rows and the live matcher swap succeed or fail
 * together. It fails open: if the store cannot be read, the pack (or, with no pack, nothing) is used, and
 * that is logged, never thrown.
 */
export class LiveTerms implements Matcher {
  private readonly store: TermStore;
  private readonly pack: TermPack | null;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private current: Matcher = NEVER;
  private loaded: Rows = { terms: [], exceptions: [] };
  private fromPack = false;
  /** True once a matcher built from the store is in place; a later failed reload keeps it. */
  private storeLoaded = false;

  constructor(opts: { store: TermStore; pack: TermPack | null; clock: Clock; logger?: Logger }) {
    this.store = opts.store;
    this.pack = opts.pack;
    this.clock = opts.clock;
    this.logger = opts.logger ?? { warn: (event, detail) => console.warn(event, detail) };
    this.useFallback();
  }

  /** True while the matcher runs on the pack because the store could not be used. */
  get usingPack(): boolean {
    return this.fromPack;
  }

  /** The rows the current matcher was built from. */
  get rows(): Rows {
    return this.loaded;
  }

  /**
   * The rows with their metadata (note, who added them, who last changed them, and when), for a staff list. Read from the
   * store, so it is current after a {@link change}. Same ids and order as {@link rows}. If the store cannot be read (or the
   * pack stands in for it) it falls back to the matcher rows with null metadata, logging `terms.records_failed` (error
   * class only) for a read that failed: it never throws. Copies; nothing here can edit a row.
   */
  records(): { terms: TermListRow[]; exceptions: ExceptionListRow[] } {
    if (!this.fromPack) {
      try {
        return {
          terms: this.store.listTerms().map((r) => ({
            id: r.id, term: r.term, language: r.language, active: r.active,
            note: r.note, addedBy: r.addedBy, addedAt: r.addedAt, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
          })),
          exceptions: this.store.listExceptions().map((r) => ({
            id: r.id, phrase: r.phrase, language: r.language, active: r.active,
            note: r.note, addedBy: r.addedBy, addedAt: r.addedAt, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
          })),
        };
      } catch (err) {
        this.logger.warn('terms.records_failed', { error: errName(err) });
      }
    }
    const unknown = { note: null, addedBy: null, addedAt: null, updatedBy: null, updatedAt: null };
    return {
      terms: this.loaded.terms.map((t) => ({ ...t, ...unknown })),
      exceptions: this.loaded.exceptions.map((e) => ({ ...e, ...unknown })),
    };
  }

  match(text: string): { termId: string } | null {
    return this.current.match(text);
  }

  /** {@link match} for a name (a handle, a table or deck name): also reads the name split into words. */
  matchName(name: string): { termId: string } | null {
    return matchName(this.current, name);
  }

  /** Every match as a range on the original text (end exclusive), for masking. Same rules as {@link match}. */
  spans(text: string): Span[] {
    return this.current.spans?.(text) ?? [];
  }

  /** Copies the pack into the store the first time this pack id is seen, then builds the matcher from the
   *  store. On failure it logs and keeps the previous store matcher, or falls back to the pack.
   *
   *  A thin async wrapper over {@link loadSync}. A synchronous host (a relay boot, a constructor) calls `loadSync`. */
  async load(): Promise<void> {
    this.loadSync();
  }

  /** {@link load} without a promise: the same seed and build, done by the time it returns. It never throws (it fails
   *  open, as `load` does). Use it where the host cannot await, such as a synchronous relay boot. */
  loadSync(): void {
    try {
      this.seed();
      this.install(this.readRows());
    } catch (err) {
      this.logger.warn('terms.load_failed', { error: errName(err) });
      if (!this.storeLoaded) this.useFallback();
    }
  }

  /**
   * The "would have blocked" dry run for a candidate term: what it would block among the pack's negative
   * corpus and `recentLines`, minus the known losses. Existing exceptions apply; the candidate is matched
   * alone, so the answer is about this term, not the rest of the list. Writes nothing.
   */
  check(term: string, language: string, recentLines: readonly string[]): CheckResult {
    let matcher: Matcher;
    try {
      // A blank exception is the stored list's problem, not the candidate's: skip it.
      const usable = this.loaded.exceptions.filter((e) => foldPhrase(e.phrase).length > 0);
      matcher = buildMatcher([{ id: 'candidate', term, language, active: true }], usable);
    } catch (err) {
      if (err instanceof MatcherBuildError) return { ok: false, error: describeBuildError(err, false) };
      throw err;
    }
    const losses = new Set(this.pack?.knownLosses ?? []);
    const lines = new Set([...(this.pack?.negativeCorpus ?? []), ...recentLines].filter((l) => !losses.has(l)));
    return { ok: true, hits: [...lines].filter((l) => matcher.match(l) !== null) };
  }

  /**
   * Runs `fn` (which edits through the {@link TermEditor}) atomically with the matcher reload. The change
   * is refused, with nothing written, when no active term would remain, a term or exception is malformed,
   * a word duplicates another, or an exception would unblock a pack `positive` line that the terms alone
   * block (a term's `positive` line, or a line of the pack's flat `positiveCorpus`). A throw from `fn` itself
   * rolls back and rejects with that error. `fn` must be synchronous. A refusal carries a `code`
   * ({@link ChangeRefusalCode}) next to the message.
   *
   * A thin async wrapper over {@link changeSync}. A synchronous host (a relay boot, a handler that cannot await)
   * calls `changeSync` and gets the same result without a promise.
   */
  async change<T>(actor: string, fn: (edit: TermEditor) => T): Promise<ChangeResult<T>> {
    return this.changeSync(actor, fn);
  }

  /** {@link change} without a promise: the same atomic edit and refusals, with the result returned directly.
   *  A throw from `fn` is thrown (where `change` rejects). That includes a store error thrown by an editor call
   *  inside `fn`, which is rethrown with nothing written, where the same failure while the change is checked or
   *  committed is a `build_failed` result. `fn` must be synchronous: an async `fn` throws a `TypeError` and is
   *  rolled back (a later rejection of its promise is swallowed, not reported as unhandled). */
  changeSync<T>(actor: string, fn: (edit: TermEditor) => T): ChangeResult<T> {
    // With a pack configured, the store is not the truth until `load()` has seeded it and built from it: an
    // edit before then would act on an unseeded store. Refuse, writing nothing and never calling `fn`.
    if (this.pack !== null && !this.storeLoaded) return { ok: false, error: 'not loaded', code: 'not_loaded' };
    // Everything up to the swap is synchronous, so two changes never interleave.
    const state: { fnError?: { err: unknown }; built?: { matcher: Matcher; rows: Rows } } = {};
    try {
      const value = this.store.transaction(() => {
        let result: T;
        try {
          result = fn(this.editor(actor));
          if (isThenable(result)) {
            // Refused, but the caller's promise is still live: a later rejection must not become an unhandled one.
            try {
              (result as PromiseLike<unknown>).then(undefined, () => {});
            } catch {
              // A thenable whose `then` throws is still refused with the TypeError below.
            }
            throw new TypeError('the change function must be synchronous');
          }
        } catch (err) {
          if (!(err instanceof Refusal)) state.fnError = { err };
          throw err;
        }
        state.built = this.validate();
        return result;
      });
      const { matcher, rows } = state.built!;
      this.current = matcher;
      this.loaded = rows;
      this.fromPack = false;
      this.storeLoaded = true;
      return { ok: true, value };
    } catch (err) {
      this.resync();
      if (state.fnError) throw state.fnError.err;
      if (err instanceof Refusal) return { ok: false, error: err.message, code: err.code };
      this.logger.warn('terms.change_failed', { error: errName(err) });
      return { ok: false, error: 'the term store failed; no change was made', code: 'build_failed' };
    }
  }

  // --- loading ---

  private readRows(): Rows {
    return {
      terms: this.store.listTerms().map(plainTerm),
      exceptions: this.store.listExceptions().map(plainException),
    };
  }

  /** Builds and swaps in a matcher from store rows. An empty list would silently stop all moderation, so
   *  with a pack to fall back on it counts as a failed load. */
  private install(rows: Rows): void {
    if (this.pack && !rows.terms.some((t) => t.active)) {
      const err = new Error('no active term in the store');
      err.name = 'NoActiveTermError';
      throw err;
    }
    this.current = buildMatcher(rows.terms, rows.exceptions);
    this.loaded = rows;
    this.fromPack = false;
    this.storeLoaded = true;
  }

  /** After a failed change: make the matcher mirror the (rolled-back) store. Best effort. */
  private resync(): void {
    try {
      this.install(this.readRows());
    } catch {
      /* the previous matcher stays */
    }
  }

  private useFallback(): void {
    if (this.pack) {
      try {
        const rows: Rows = {
          terms: this.pack.terms.map((t) => ({ id: t.id, term: t.term, language: t.language, active: t.active })),
          exceptions: this.pack.exceptions.map((e) => ({ ...e })),
        };
        this.current = buildMatcher(rows.terms, rows.exceptions);
        this.loaded = rows;
        this.fromPack = true;
        return;
      } catch (err) {
        this.logger.warn('terms.pack_unusable', { error: errName(err) });
      }
    }
    this.current = NEVER;
    this.loaded = { terms: [], exceptions: [] };
    this.fromPack = false;
  }

  /** Once per pack id: copies the pack's rows into the store and records the marker, all in one transaction.
   *  A word the store already has (from another pack or an adopter) is not added twice. */
  private seed(): void {
    const pack = this.pack;
    if (!pack) return;
    const store = this.store;
    store.transaction(() => {
      if (store.isSeeded(pack.id)) return;
      const at = this.clock.now();
      const taken = new Set(store.listTerms().flatMap((t) => [`id:${t.id}`, `w:${termKey(t.term)}`]));
      for (const t of pack.terms) {
        const key = termKey(t.term);
        if (taken.has(`id:${t.id}`) || taken.has(`w:${key}`)) continue;
        store.insertTerm({
          id: t.id, term: t.term, language: t.language, active: t.active,
          note: null, addedBy: 'seed', addedAt: at, updatedBy: null, updatedAt: null,
        });
        taken.add(`id:${t.id}`);
        taken.add(`w:${key}`);
      }
      const takenEx = new Set(store.listExceptions().flatMap((e) => [`id:${e.id}`, `w:${foldPhrase(e.phrase)}`]));
      for (const e of pack.exceptions) {
        const key = foldPhrase(e.phrase);
        if (takenEx.has(`id:${e.id}`) || takenEx.has(`w:${key}`)) continue;
        store.insertException({
          id: e.id, phrase: e.phrase, language: e.language, active: e.active,
          note: null, addedBy: 'seed', addedAt: at, updatedBy: null, updatedAt: null,
        });
        takenEx.add(`id:${e.id}`);
        takenEx.add(`w:${key}`);
      }
      store.markSeeded(pack.id, at);
    });
  }

  // --- changing ---

  /** Reads the store as it now stands (inside the change's transaction) and checks every rule. Throws a
   *  Refusal for a refused change; a store error propagates. */
  private validate(): { matcher: Matcher; rows: Rows } {
    const rows = this.readRows();
    if (!rows.terms.some((t) => t.active)) {
      throw new Refusal('invalid', 'no active term would remain: at least one term must stay enabled');
    }
    let matcher: Matcher;
    try {
      matcher = buildMatcher(rows.terms, rows.exceptions);
    } catch (err) {
      if (err instanceof MatcherBuildError) throw new Refusal('invalid', describeBuildError(err, true));
      throw err;
    }
    // Canary: every positive line the active terms block on their own must still be blocked once the
    // exceptions apply. The error names the term row and the line's index, not the line (it is a slur).
    // Two lists, one rule: each term's own `positive` lines, then the pack's flat `positiveCorpus`.
    if (this.pack) {
      const termsOnly = buildMatcher(rows.terms, []);
      const unblocked = (line: string): boolean => termsOnly.match(line) !== null && matcher.match(line) === null;
      for (const t of this.pack.terms) {
        for (const [i, line] of t.positive.entries()) {
          if (unblocked(line)) throw new Refusal('unblocks_known', `exception would unblock positive line ${i} of term ${t.id}`);
        }
      }
      for (const [i, line] of (this.pack.positiveCorpus ?? []).entries()) {
        if (unblocked(line)) throw new Refusal('unblocks_known', `exception would unblock positive corpus line ${i}`);
      }
    }
    return { matcher, rows };
  }

  private termKind(): Kind {
    const store = this.store;
    return {
      subject: 'term',
      fold: foldTerm,
      key: termKey,
      words: () => store.listTerms().map((r) => ({ id: r.id, word: r.term })),
      get: (id) => store.listTerms().find((r) => r.id === id),
      insert: (id, word, language, note, actor, at) =>
        store.insertTerm({
          id, term: word, language, active: true, note, addedBy: actor, addedAt: at, updatedBy: null, updatedAt: null,
        }),
      patch: (id, p, actor, at) =>
        store.updateTerm(id, { term: p.word, language: p.language, note: p.note, updatedBy: actor, updatedAt: at }),
      setActive: (id, active, actor, at) => store.setTermActive(id, active, actor, at),
    };
  }

  private exceptionKind(): Kind {
    const store = this.store;
    return {
      subject: 'exception',
      fold: foldPhrase,
      key: foldPhrase,
      words: () => store.listExceptions().map((r) => ({ id: r.id, word: r.phrase })),
      get: (id) => store.listExceptions().find((r) => r.id === id),
      insert: (id, word, language, note, actor, at) =>
        store.insertException({
          id, phrase: word, language, active: true, note, addedBy: actor, addedAt: at, updatedBy: null, updatedAt: null,
        }),
      patch: (id, p, actor, at) =>
        store.updateException(id, { phrase: p.word, language: p.language, note: p.note, updatedBy: actor, updatedAt: at }),
      setActive: (id, active, actor, at) => store.setExceptionActive(id, active, actor, at),
    };
  }

  private editor(actor: string): TermEditor {
    const term = this.termKind();
    const exception = this.exceptionKind();
    return {
      addTerm: (input, hits) => this.add(term, actor, input.term, input.language, input.note, hits),
      updateTerm: (id, p, hits) => this.edit(term, actor, id, { word: p.term, language: p.language, note: p.note }, hits),
      setTermActive: (id, active) => this.toggle(term, actor, id, active),
      addException: (input, hits) => this.add(exception, actor, input.phrase, input.language, input.note, hits),
      updateException: (id, p, hits) =>
        this.edit(exception, actor, id, { word: p.phrase, language: p.language, note: p.note }, hits),
      setExceptionActive: (id, active) => this.toggle(exception, actor, id, active),
    };
  }

  /** Words the matcher reads as one are duplicates, in any language and active or not: a second row for the
   *  same word would keep blocking after the first was disabled. An empty key is left to validation to refuse. */
  private assertNotDuplicate(kind: Kind, word: string, selfId?: string): void {
    const key = kind.key(word);
    if (key === '') return;
    for (const r of kind.words()) {
      if (r.id !== selfId && kind.key(r.word) === key) {
        throw new Refusal('duplicate', `duplicate ${kind.subject}: matches existing row ${r.id}`);
      }
    }
  }

  private snapshot(kind: Kind, id: string): Record<string, unknown> {
    const row = kind.get(id);
    if (!row) throw new Refusal('not_found', `${kind.subject} not found: ${id}`);
    return { ...row };
  }

  private audit(
    kind: Kind,
    actor: string,
    op: 'add' | 'update' | 'toggle',
    id: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    hits?: string[],
  ): void {
    this.store.writeAudit({
      at: this.clock.now(),
      actor,
      action: `${kind.subject}.${op}`,
      subjectType: kind.subject,
      subjectRef: id,
      beforeJson: before === null ? null : JSON.stringify(before),
      afterJson: JSON.stringify(hits === undefined ? after : { ...after, hits }),
    });
  }

  private add(kind: Kind, actor: string, word: string, language: string, note: string | null | undefined, hits?: string[]): string {
    this.assertNotDuplicate(kind, word);
    const id = newId();
    kind.insert(id, kind.fold(word), language, note ?? null, actor, this.clock.now());
    this.audit(kind, actor, 'add', id, null, this.snapshot(kind, id), hits);
    return id;
  }

  private edit(
    kind: Kind,
    actor: string,
    id: string,
    patch: { word?: string; language?: string; note?: string | null },
    hits?: string[],
  ): void {
    const before = this.snapshot(kind, id);
    if (patch.word === undefined && patch.language === undefined && patch.note === undefined) return;
    if (patch.word !== undefined) this.assertNotDuplicate(kind, patch.word, id);
    kind.patch(
      id,
      { word: patch.word === undefined ? undefined : kind.fold(patch.word), language: patch.language, note: patch.note },
      actor,
      this.clock.now(),
    );
    this.audit(kind, actor, 'update', id, before, this.snapshot(kind, id), hits);
  }

  /** A toggle to the state the row is already in writes nothing, so the audit trail only records real changes. */
  private toggle(kind: Kind, actor: string, id: string, active: boolean): void {
    const before = this.snapshot(kind, id);
    if (before.active === active) return;
    kind.setActive(id, active, actor, this.clock.now());
    this.audit(kind, actor, 'toggle', id, before, this.snapshot(kind, id));
  }
}

/** What the matcher compares for a term: two terms with the same key are the same word. */
function termKey(term: string): string {
  return collapseLikePreset(foldTerm(term));
}
