import { isHoldCode } from '@chatwarden/core';
import type { HoldCode } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminCall, AdminContext } from './context.js';
import { bodyObject } from './validate.js';

/** The owner's, compared in code: a `permissions` override cannot lower it. */
const requireOwner = (c: AdminCall): void => {
  if (c.authz.role !== 'owner') throw new HttpError('forbidden');
};

/** `{ code }` and nothing else, with a code on the closed list, else 400 `invalid_request`. There is no free text. */
function bodyHold(body: Record<string, unknown>): HoldCode {
  const keys = Object.keys(body);
  if (keys.length !== 1 || !isHoldCode(body.code)) throw new ValidationError();
  return body.code;
}

/**
 * The legal-hold routes (0.2.0, `@experimental`). A hold keeps one report, and what hangs on it, out of every retention purge and every erase; it is a mechanism, not
 * a legal conclusion. Every body is `no-store`.
 *
 * - `PUT /reports/:id/hold { code }` (`legal.hold`, a senior's by default, lowerable): hold the report for one of `law_enforcement_request`, `legal_proceeding`,
 *   `platform_request`, `safety_review`, `other`. No free text: 400 `invalid_request` for anything but exactly `{ code }` with a code on the list. 200 `{ ok: true }`; 404 `not_found` for
 *   an unknown report; 409 `already_held`. Emits `report.escalated` (ids and the code, never text). Audits `legal.hold` on the report, best-effort after the write.
 * - `DELETE /reports/:id/hold` (the owner's, fixed in code): release it. 200 `{ ok: true }`; 404 `not_found` when the report is not held. Audits `legal.release`, best-effort.
 * - `GET /reports/:id/bundle?accounts=1` (the owner's, fixed in code): the report's evidence bundle as one JSON attachment (`content-disposition: attachment`), signed with the kit's
 *   `bundleSecret` when it has one (`integrity.hmacSha256` is null otherwise). Account ids only with `accounts=1`. 404 `not_found`. Audits `legal.bundle` on the report and the audit is
 *   REQUIRED: no audit, no bundle (500).
 *
 * The staff report body (`GET /reports/:id`) shows `report.hold: { code, at }` for a held report, never who held it. Not legal advice; the kit forwards nothing to anyone.
 */
export function legalRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'PUT /reports/:id/hold': ctx.secure('legal.hold', async (c) => {
      const id = c.params.id as string;
      const code = bodyHold(bodyObject(c.req));
      const res = await cw.legal.hold(id, { code, actor: c.authz.actor });
      if (!res.ok) {
        if (res.error === 'not_found') throw new NotFoundError();
        if (res.error === 'already_held') throw new HttpError('already_held');
        throw new ValidationError();
      }
      // The hold is stored: an audit failure is logged, never turned into an error.
      c.audit('legal.hold', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),

    'DELETE /reports/:id/hold': ctx.secure('policy.read', async (c) => {
      requireOwner(c);
      const id = c.params.id as string;
      const res = await cw.legal.release(id, { actor: c.authz.actor });
      if (!res.ok) throw new NotFoundError();
      c.audit('legal.release', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),

    'GET /reports/:id/bundle': ctx.secure('policy.read', async (c) => {
      requireOwner(c);
      const id = c.params.id as string;
      const out = await cw.legal.bundle(id, { actor: c.authz.actor, includeAccounts: c.req.query.accounts === '1' });
      if ('ok' in out) throw new NotFoundError();
      // Required, and before anything is sent: no audit, no bundle.
      c.audit('legal.bundle', { type: 'report', ref: id });
      return { status: 200, headers: { 'content-disposition': `attachment; filename="chatwarden-evidence-${id}.json"` }, body: out };
    }),
  };
}
