import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminCall, AdminContext } from './context.js';
import { bodyObject } from './validate.js';

/** The owner's, compared in code: a `permissions` override cannot lower it (the routes sit behind `policy.read` only to be signed-in staff). */
const requireOwner = (c: AdminCall): void => {
  if (c.authz.role !== 'owner') throw new HttpError('forbidden');
};

/** The longest account id the kit takes: the audit trail's own limit for a ref is not relevant here; an account id is the game's string, so this only bounds the input. */
const ACCOUNT_ID_MAX = 128;

/** `{ accountId }` and nothing else, else 400 `invalid_request`. */
function bodyFind(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  const id = body.accountId;
  if (keys.length !== 1 || typeof id !== 'string' || id.length < 1 || id.length > ACCOUNT_ID_MAX) throw new ValidationError();
  return id;
}

/** `{ keep, confirm, dryRun? }` and nothing else, else 400 `invalid_request`. */
function bodyErase(body: Record<string, unknown>): { keep: 'safety' | 'none'; confirm: string; dryRun: boolean } {
  for (const k of Object.keys(body)) if (k !== 'keep' && k !== 'confirm' && k !== 'dryRun') throw new ValidationError();
  const { keep, confirm, dryRun } = body;
  if (keep !== 'safety' && keep !== 'none') throw new ValidationError();
  if (typeof confirm !== 'string') throw new ValidationError();
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new ValidationError();
  return { keep, confirm, dryRun: dryRun === true };
}

/**
 * The privacy routes (0.2.0): the owner's, fixed in code (a `permissions` option cannot lower them), on no player route. Every body is `no-store`.
 * They hold no line, handle, hash, key or secret except where an export, by its nature, returns the person's own data.
 *
 * - `POST /privacy/find { accountId }`: `{ ref }`, the person's staff ref, or `{ ref: null }`. Finds by the game's account id; creates no one. 400 `invalid_request` for a body that is
 *   not exactly `{ accountId }`. Audits `privacy.find` with no target (the account id is never recorded), best-effort.
 * - `GET /people/:ref/privacy/export`: everything the kit holds about the person (the canonical subject and every alias) as one JSON attachment (`content-disposition: attachment`),
 *   see `cw.privacy.export`. 404 `not_found` for a person the kit does not hold. Audits `privacy.export` on the person and the audit is REQUIRED: no audit, no export (500).
 * - `POST /people/:ref/privacy/erase { keep: 'safety' | 'none', confirm, dryRun? }`: erases the person, see `cw.privacy.erase`. `confirm` must equal the person's ref (the one in the path, or the canonical one when that was merged away) (400
 *   `confirm_mismatch`); 400 `invalid_request` for a bad `keep` or any other key (an actor is never read from the body); 404 `not_found` for a person the kit does not hold. With
 *   `dryRun: true` the body is what would be removed and kept (`{ dryRun: true, mode, removed, kept }`) and nothing is written, audited or counted. Otherwise the body is the receipt
 *   (`{ id, at, mode, removed, kept, auditFailed? }`: counts and words, no subject, no line, no account). Core audits `privacy.erase` after the commit (the person's ref is the receipt id
 *   once nothing keeps the person); a failed audit is `auditFailed: true` and never undoes the erase.
 * - `GET /privacy/statement`: what the kit keeps and for how long (`cw.privacy.statement()`), for the hub and the adopter's own policy text. Writes no audit row.
 *
 * Not legal advice and no claim of compliance: the adopter verifies the requester and decides what to answer; the kit never tells the player.
 */
export function privacyRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'POST /privacy/find': ctx.secure('policy.read', (c) => {
      requireOwner(c);
      const accountId = bodyFind(bodyObject(c.req));
      const ref = cw.privacy.find({ accountId });
      c.audit('privacy.find', undefined, 'best-effort');
      return { status: 200, body: { ref } };
    }),

    'GET /people/:ref/privacy/export': ctx.secure('policy.read', async (c) => {
      requireOwner(c);
      const ref = c.params.ref as string;
      const out = await cw.privacy.export(ref);
      if ('ok' in out) throw new NotFoundError();
      // Required, and before anything is sent: no audit row, no export.
      c.audit('privacy.export', { type: 'person', ref: cw.people.canonical(ref) });
      return { status: 200, headers: { 'content-disposition': 'attachment; filename="chatwarden-privacy-export.json"' }, body: out };
    }),

    'POST /people/:ref/privacy/erase': ctx.secure('policy.read', async (c) => {
      requireOwner(c);
      const ref = c.params.ref as string;
      const ask = bodyErase(bodyObject(c.req));
      // The ref in the path may be an id that was merged away (a page opened on an alias), so the person's own ref is accepted as the confirm too; nobody else's is.
      if (ask.confirm !== ref && ask.confirm !== cw.people.canonical(ref)) throw new HttpError('confirm_mismatch');
      const out = await cw.privacy.erase(ref, { keep: ask.keep, actor: c.authz.actor, ...(ask.dryRun ? { dryRun: true } : {}) });
      if ('ok' in out) {
        if (out.error === 'not_found') throw new NotFoundError();
        throw new ValidationError();
      }
      // The receipt (or the preview) and nothing else. The audit row of a real erase was written by the core, after the commit.
      return { status: 200, body: out };
    }),

    'GET /privacy/statement': ctx.secure('policy.read', (c) => {
      requireOwner(c);
      return { status: 200, body: cw.privacy.statement() };
    }),
  };
}
