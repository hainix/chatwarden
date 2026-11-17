import { isValidAuditActor, ROLES } from './audit.js';
import type { Role } from './audit.js';
import { normalizeStatement, statementLength } from './appeals.js';
import { randomId } from './crypto.js';
import type { KitEvent } from './events.js';
import type { Clock, CommentRow, ReportComment, Store } from './types.js';

// The staff workflow (spec section 6): a comment thread on a report, a second look asked of a senior or the owner, and the owner's escalation. All behind `desk.workflow`. Staff
// text only: nothing here is read by a player, the AI, an event, a webhook, a Discord post, a notice, the audit trail or a log. The staff layer writes the audit rows around it.

/** The longest comment, a note and an entry of the thread, in code points after cleaning. */
export const COMMENT_MAX = 500;

/** `add` and `escalate`'s notes: why a comment was not taken. `full` is the 50-entry cap. @experimental */
export type CommentResult = { ok: true; comment: ReportComment } | { ok: false; refused: 'off' | 'not_found' | 'invalid' | 'full' };

/** `remove`'s answer: `not_found` is one answer for an unknown comment and someone else's, so ids cannot be probed. @experimental */
export type CommentRemoveResult = { ok: true } | { ok: false; refused: 'off' | 'not_found' };

/** `escalate`'s answer. `not_allowed` is the role order (an owner has no one above to ask); `closed` a decided report. @experimental */
export type EscalateResult = { ok: true } | { ok: false; refused: 'off' | 'not_found' | 'closed' | 'invalid' | 'not_allowed' };

/** `clearEscalation`'s answer: ok also when there was nothing to clear. @experimental */
export type ClearEscalationResult = { ok: true } | { ok: false; refused: 'off' | 'not_found' | 'closed' | 'not_allowed' };

export interface CommentServiceDeps {
  store: Store;
  clock: Clock;
  /** Whether `desk.workflow` is on and the store can keep the thread: read per call, so an edit applies at once. */
  enabled: () => boolean;
  /** The facade's bus: fenced, never throws; called after the write has committed. */
  emit: (event: KitEvent) => void;
}

/** True when the store has every method the workflow needs. */
export function hasWorkflowMethods(store: Store): boolean {
  const s = store as unknown as Record<string, unknown>;
  return ['insertComment', 'listComments', 'deleteComment', 'countComments', 'setEscalation', 'countOpenEscalated'].every((m) => typeof s[m] === 'function');
}

const needActor = (actor: unknown): string => {
  if (!isValidAuditActor(actor)) throw new RangeError('comments: the actor is not a valid staff ref');
  return actor;
};
const needRole = (role: unknown): Role => {
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) throw new RangeError('comments: the role must be moderator, senior or owner');
  return role as Role;
};

/**
 * Clean a comment or a note with the appeal statement's cleaner (control, bidirectional and zero-width characters, NUL and lone surrogates removed, paragraph breaks kept) and count it
 * in code points. `null` when it is not text or is blank after cleaning; `'too_long'` over {@link COMMENT_MAX}.
 */
function clean(text: unknown): string | null | 'too_long' {
  if (typeof text !== 'string') return null;
  const cleaned = normalizeStatement(text);
  if (cleaned === '') return text.length > 0 && text.length > COMMENT_MAX * 20 ? 'too_long' : null;
  return statementLength(cleaned) > COMMENT_MAX ? 'too_long' : cleaned;
}

const view = (r: CommentRow): ReportComment => ({ id: r.id, reportId: r.reportId, at: r.at, author: r.actor, role: r.role, kind: r.kind, text: r.text });

/** `cw.comments` and the escalation half of `cw.cases`. */
export class CommentService {
  private readonly d: CommentServiceDeps;

  constructor(deps: CommentServiceDeps) {
    this.d = deps;
  }

  /**
   * Add a comment to a report's thread: 1 to 500 code points after cleaning, at most 50 entries a report. A decided report keeps its thread and still takes one. Never claim-gated.
   * `RangeError` for a malformed actor or role. Moves the change token. Announces nothing.
   */
  add(reportId: string, actor: string, role: Role, text: string): CommentResult {
    needActor(actor);
    needRole(role);
    if (!this.d.enabled()) return { ok: false, refused: 'off' };
    const cleaned = clean(text);
    if (cleaned === null || cleaned === 'too_long') return { ok: false, refused: 'invalid' };
    return this.d.store.transaction((): CommentResult => {
      if (typeof reportId !== 'string' || reportId === '' || this.d.store.loadReport(reportId) === null) return { ok: false, refused: 'not_found' };
      const row: CommentRow = { id: randomId(16), reportId, at: this.d.clock.now(), actor, role, kind: 'comment', text: cleaned };
      if (this.d.store.insertComment?.(row) !== true) return { ok: false, refused: 'full' };
      return { ok: true, comment: view(row) };
    });
  }

  /** How many open reports are asked of each role (the Overview's "waiting for a senior look"). Zeros when the workflow is off or the store cannot count. */
  askedCount(): { senior: number; owner: number } {
    if (!this.d.enabled()) return { senior: 0, owner: 0 };
    return this.d.store.countOpenEscalated?.() ?? { senior: 0, owner: 0 };
  }

  /** A report's thread, oldest first. Empty when the workflow is off. */
  list(reportId: string): ReportComment[] {
    if (!this.d.enabled() || typeof reportId !== 'string') return [];
    return (this.d.store.listComments?.(reportId) ?? []).map(view);
  }

  /**
   * Remove an entry of a report's thread: its author (a moderator) or a senior or the owner. Another moderator's, an unknown id and an entry of another report all answer `not_found`.
   * No editing exists.
   */
  remove(reportId: string, commentId: string, actor: string, role: Role): CommentRemoveResult {
    needActor(actor);
    const r = needRole(role);
    if (!this.d.enabled()) return { ok: false, refused: 'off' };
    return this.d.store.transaction((): CommentRemoveResult => {
      const row = typeof reportId === 'string' && typeof commentId === 'string' ? this.d.store.listComments?.(reportId).find((c) => c.id === commentId) : undefined;
      if (row === undefined) return { ok: false, refused: 'not_found' };
      if (row.actor !== actor && r === 'moderator') return { ok: false, refused: 'not_found' };
      return this.d.store.deleteComment?.(commentId) === true ? { ok: true } : { ok: false, refused: 'not_found' };
    });
  }

  /**
   * Ask a senior or the owner for a second look at an open report. A moderator may ask a senior or the owner; a senior the same; an owner no one (`not_allowed`). Sets the report's
   * escalation (a later ask replaces it), adds an `ask` (for a senior) or `escalate` (for the owner) entry with the optional note (same rules as a comment; a note that cannot be
   * taken refuses the whole ask), and emits `case.escalated` (ids, the role asked and a time) after the commit. A full thread does not stop the ask: the entry is skipped. It never
   * touches the claim and never blocks a decision. `RangeError` for a malformed actor or role.
   */
  escalate(reportId: string, actor: string, role: Role, input: { to: 'senior' | 'owner'; note?: string }): EscalateResult {
    needActor(actor);
    const r = needRole(role);
    if (!this.d.enabled()) return { ok: false, refused: 'off' };
    const to: unknown = typeof input === 'object' && input !== null ? input.to : undefined;
    if (to !== 'senior' && to !== 'owner') return { ok: false, refused: 'invalid' };
    let note: string | null = null;
    const given: unknown = input.note;
    if (given !== undefined && given !== null) {
      if (typeof given !== 'string') return { ok: false, refused: 'invalid' };
      const cleaned = clean(given);
      if (cleaned === 'too_long') return { ok: false, refused: 'invalid' };
      note = cleaned;
    }
    if (r === 'owner') return { ok: false, refused: 'not_allowed' };
    const now = this.d.clock.now();
    const done = this.d.store.transaction((): EscalateResult => {
      const report = typeof reportId === 'string' && reportId !== '' ? this.d.store.loadReport(reportId) : null;
      if (report === null) return { ok: false, refused: 'not_found' };
      if (report.status !== 'open') return { ok: false, refused: 'closed' };
      this.d.store.setEscalation?.(reportId, { to, by: actor, at: now });
      // The entry is the thread's record of who asked and why; a full thread keeps the columns and loses only the entry.
      this.d.store.insertComment?.({ id: randomId(16), reportId, at: now, actor, role, kind: to === 'senior' ? 'ask' : 'escalate', text: note });
      return { ok: true };
    });
    if (done.ok) this.d.emit({ type: 'case.escalated', reportId, to, at: now });
    return done;
  }

  /**
   * End a second look ("Looked at"): the asker, or anyone at or above the role asked. Writes a `clear` entry and clears the report's escalation. A report with none answers ok and changes
   * nothing (a second clear is a no-op); a decided report is `closed` (deciding already cleared it).
   */
  clearEscalation(reportId: string, actor: string, role: Role): ClearEscalationResult {
    needActor(actor);
    const r = needRole(role);
    if (!this.d.enabled()) return { ok: false, refused: 'off' };
    const now = this.d.clock.now();
    return this.d.store.transaction((): ClearEscalationResult => {
      const report = typeof reportId === 'string' && reportId !== '' ? this.d.store.loadReport(reportId) : null;
      if (report === null) return { ok: false, refused: 'not_found' };
      if (report.status !== 'open') return { ok: false, refused: 'closed' };
      if (report.escalatedTo === null) return { ok: true };
      const above = ROLES.indexOf(r) >= ROLES.indexOf(report.escalatedTo);
      if (report.escalatedBy !== actor && !above) return { ok: false, refused: 'not_allowed' };
      this.d.store.setEscalation?.(reportId, null);
      this.d.store.insertComment?.({ id: randomId(16), reportId, at: now, actor, role, kind: 'clear', text: null });
      return { ok: true };
    });
  }
}
