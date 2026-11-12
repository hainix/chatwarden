import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { gateCase } from './claims.js';
import type { AdminContext } from './context.js';
import { bodyObject, bodyRename } from './validate.js';

/**
 * `POST /people/:ref/rename { reason, rule?, takeOver? }` (`sanctions.apply`): ask a player to choose a new name. It is not a sanction (no
 * length, no appeal, nothing on "My record"): the player gets a notice that names no name, and the game hears `rename.required` and renames.
 * `reason` is private (1 to 500 characters, never echoed) and `rule` an active whole-number rule (default: the slur filter's). 200 `{ ok: true }`.
 * - 404 `not_found` while renames are off (`names.renames`), or when the store cannot release a rename (the same test `GET /me`'s
 *   `features.renames` applies, so a hub never offers a rename that always 404s), or for a person the kit does not hold. Checked before the body.
 * - 409 `pending_rename` while an earlier request is still waiting for the game to release the player.
 * - 400 for a reason that is missing, blank or over 500 characters, a rule that is not an active whole-number rule, or a malformed body.
 * - 409 `claimed` and `takeOver` work as for `POST /sanctions` (`gateCase`): another moderator's live claim on the person stops the request unless
 *   `takeOver: true` and the caller holds `claims.override`, which is audited as `case.takeover` first.
 * The actor is the authenticated caller, never the body. Audits `name.rename_required` with the person as target, best-effort, after the write (the
 * notice holds neither the reason nor the actor, so the trail is where they are recorded; it keeps no reason either).
 */
export function nameRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'POST /people/:ref/rename': ctx.secure('sanctions.apply', (c) => {
      // The same capability GET /me reports; checked before anything about the request is looked at.
      if (!cw.names.renamesEnabled()) throw new NotFoundError();
      const ref = c.params.ref as string;
      const ask = bodyRename(bodyObject(c.req));
      gateCase(ctx, c, ref, ask.takeOver);
      const res = cw.names.requireRename({ subject: ref, actor: c.authz.actor, reason: ask.reason, ...(ask.rule === undefined ? {} : { rule: ask.rule }) });
      if (!res.ok) {
        if (res.error === 'pending') throw new HttpError('pending_rename');
        if (res.error === 'invalid') throw new ValidationError();
        // off (turned off since the check above) and not_found are both "there is nothing here to ask".
        throw new NotFoundError();
      }
      // The request is written: an audit failure is logged, never turned into an error.
      c.audit('name.rename_required', { type: 'person', ref: cw.people.canonical(ref) }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),
  };
}
