import { NotFoundError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyAutomation, bodyObject } from './validate.js';

/**
 * `PUT /people/:id/automation { allowed, code? }` (`automation.write`, a senior's by default, `@experimental`): mark a person "do not automate", or clear the mark.
 * `allowed: false` needs one of the closed reason codes (`vulnerable`, `under_review`, `staff`, `sensitive_case`, `other`), `allowed: true` takes none; there is no
 * free text. 200 `{ ok: true }`.
 * - 400 `invalid_request` for a body that is not that shape, 400 `forbidden_key` for any other key (an actor, a note). The actor is the authenticated caller, never the body.
 * - 404 `not_found` for a person the kit does not hold, and for a store that cannot keep the mark (the same answer: there is nothing here to change).
 * The mark follows a merge (it is kept under the canonical person). It only records whom the AI must leave alone: nothing in this release lets the AI act, and reads and
 * drafts are still produced for a marked person. Audits `person.automation` with the canonical person as target, best-effort, after the write; the row carries no code.
 */
export function personRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'PUT /people/:id/automation': ctx.secure('automation.write', (c) => {
      const ref = c.params.id as string;
      const ask = bodyAutomation(bodyObject(c.req));
      const res = cw.people.automation.set(ref, { allowed: ask.allowed, ...(ask.code === undefined ? {} : { code: ask.code }), actor: c.authz.actor });
      // `invalid` after the body is checked can only be a person the kit does not hold; `unsupported` is a store without the mark.
      if (!res.ok) throw new NotFoundError();
      // The mark is written: an audit failure is logged, never turned into an error.
      c.audit('person.automation', { type: 'person', ref: cw.people.canonical(ref) }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),
  };
}
