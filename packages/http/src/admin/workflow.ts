import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyObject, optionalBody } from './validate.js';

/** `{ text }` and nothing else: a string (the core cleans and counts it), else 400 `invalid_request`. */
function bodyComment(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'text' || typeof body.text !== 'string') throw new ValidationError();
  return body.text;
}

/** `{ to: 'senior' | 'owner', note? }` and nothing else, else 400 `invalid_request`. */
function bodyEscalate(body: Record<string, unknown>): { to: 'senior' | 'owner'; note?: string } {
  for (const key of Object.keys(body)) if (key !== 'to' && key !== 'note') throw new ValidationError();
  if (body.to !== 'senior' && body.to !== 'owner') throw new ValidationError();
  if (Object.hasOwn(body, 'note') && typeof body.note !== 'string') throw new ValidationError();
  return { to: body.to, ...(typeof body.note === 'string' ? { note: body.note } : {}) };
}

/**
 * The staff workflow routes (0.2.0, `@experimental`): a comment thread on a report, a second look and escalation. All of them are behind `desk.workflow`: with it off every one is 404 and
 * `GET /reports/:id` carries no `comments` or `escalation` key, `GET /changes` no `asked`. Comments and escalation are never claim-gated. Every body is `no-store`; the text of a comment or a
 * note is in the report body's thread and nowhere else (never an audit row, an event or a log).
 *
 * - `POST /reports/:id/comments { text }` (`reports.comment`, a moderator's by default): add a comment (1 to 500 characters after cleaning, at most 50 entries a report). 200
 *   `{ comment: { id, at, author, role, kind, text } }`; 400 `invalid_request`; 404 `not_found`; 409 `comment_limit`. Audited `report.comment` on the report, best-effort after the write.
 * - `DELETE /reports/:id/comments/:cid` (`reports.comment`): remove one: its author, or a senior or the owner. Another moderator's and an unknown id are the same 404. 200 `{ ok: true }`.
 *   Audited `report.comment_remove`, best-effort.
 * - `POST /reports/:id/escalate { to, note? }` (`reports.escalate`): ask a senior or the owner for a second look (`to` is `senior` or `owner`; an owner asks no one: 403 `forbidden`). Adds an
 *   `ask` or `escalate` entry (with the note) to the thread and raises `case.escalated`. 200 `{ ok: true }`; 400; 404; 409 `already_decided`. Audited `report.escalate`, best-effort.
 * - `DELETE /reports/:id/escalate` (`reports.escalate`): "Looked at": the asker, or anyone at or above the role asked (else 403 `forbidden`). 200 `{ ok: true }`, also when there was none.
 *   Audited `report.escalate`, best-effort.
 */
export function workflowRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  /** Off is a 404 like any route that is not there. */
  const needWorkflow = (): void => {
    if (!cw.desk.workflowEnabled()) throw new NotFoundError();
  };

  return {
    'POST /reports/:id/comments': ctx.secure('reports.comment', (c) => {
      needWorkflow();
      const id = c.params.id as string;
      const text = bodyComment(bodyObject(c.req));
      const res = cw.comments.add(id, c.authz.actor, c.authz.role, text);
      if (!res.ok) {
        if (res.refused === 'invalid') throw new ValidationError();
        if (res.refused === 'full') throw new HttpError('comment_limit');
        throw new NotFoundError();
      }
      c.audit('report.comment', { type: 'report', ref: id }, 'best-effort');
      const { id: commentId, at, author, role, kind, text: stored } = res.comment;
      return { status: 200, body: { comment: { id: commentId, at, author, role, kind, text: stored } } };
    }),

    'DELETE /reports/:id/comments/:cid': ctx.secure('reports.comment', (c) => {
      needWorkflow();
      const id = c.params.id as string;
      const res = cw.comments.remove(id, c.params.cid as string, c.authz.actor, c.authz.role);
      if (!res.ok) throw new NotFoundError();
      c.audit('report.comment_remove', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),

    'POST /reports/:id/escalate': ctx.secure('reports.escalate', (c) => {
      needWorkflow();
      const id = c.params.id as string;
      const input = bodyEscalate(bodyObject(c.req));
      const res = cw.cases.escalate(id, c.authz.actor, c.authz.role, input);
      if (!res.ok) {
        if (res.refused === 'invalid') throw new ValidationError();
        if (res.refused === 'not_allowed') throw new HttpError('forbidden');
        if (res.refused === 'closed') throw new HttpError('already_decided');
        throw new NotFoundError();
      }
      c.audit('report.escalate', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),

    'DELETE /reports/:id/escalate': ctx.secure('reports.escalate', (c) => {
      needWorkflow();
      const id = c.params.id as string;
      // A DELETE carries no body; one with a key is refused like any other malformed request.
      if (Object.keys(optionalBody(c.req)).length > 0) throw new ValidationError();
      const res = cw.cases.clearEscalation(id, c.authz.actor, c.authz.role);
      if (!res.ok) {
        if (res.refused === 'not_allowed') throw new HttpError('forbidden');
        if (res.refused === 'closed') throw new HttpError('already_decided');
        throw new NotFoundError();
      }
      c.audit('report.escalate', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),
  };
}
