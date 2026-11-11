import { REPORT_CATEGORIES, isReasonId } from '@chatwarden/core';
import type { ReportCategory } from '@chatwarden/core';
import { ClaimedError, HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { canOverrideClaims } from './claims.js';
import type { AdminContext } from './context.js';
import { bodyObject, bodyTakeOver, has, optionalBody } from './validate.js';

/** A change token as a client sends it back: the short opaque string the last answer gave. */
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The team workbench routes (staff only). Cases are per person: `:ref` is a staff ref, and an alias is the surviving person.
 * - `POST /cases/:ref/claim { takeOver? }` (`reports.decide`): claim an open case, or beat your own claim (a heartbeat).
 *   200 `{ claim: { by, since, until }, tookOverFrom: string | null }`. 404 when the person has no open case. 409 `claimed`
 *   `{ by, until }` when another moderator holds it and `takeOver` is absent, or the caller lacks `claims.override`. A real
 *   takeover (a live claim of someone else moved) is audited as `case.takeover` on the person; an ordinary claim is not. The
 *   row is written before the move, so it means the takeover was attempted: if the last report closed in between, the answer
 *   is 404 and nothing moved.
 * - `POST /cases/:ref/release` (`reports.decide`): `{ released: boolean }`. Only your own live claim is released.
 * - `POST /cases/next { category?, reason? }` (`reports.decide`): claim and return the oldest open case nobody holds (a case you
 *   already hold is skipped), `{ case: { person, reportId, claim } }`, or `{ case: null }`. `reason` is a reason id (the old
 *   `disruption` finds `griefing`) or `none` for the reports that gave none; `category` still works, and both together must hold.
 *   They are the only filters: the order is already oldest first, and there is no wait filter. A malformed one is 400.
 * - `POST /cases/:ref/viewing` (`reports.read`): a heartbeat that you have the case open (30 s, in memory, never stored).
 *   `{ viewers: string[] }`, the others. 404 `not_found` when the person has no open case (nothing is tracked); one actor
 *   keeps at most 20 cases open, a newer beat dropping their oldest.
 * - `GET /changes?since=<token>` (`reports.read`): `{ token, changed }`. One read, no audit row.
 * - `GET /reasons` (`reasons.read`): `{ reasons: [{ id, label, text, active }] }`, in the order they were added.
 * - `POST /reasons { label, text }`, `PATCH /reasons/:id { label?, text? }`, `POST /reasons/:id/active { active }`
 *   (`reasons.write`): `{ reason }`. Audited `reason.add`, `reason.update`, `reason.toggle` on the reason id, after the write.
 */
export function teamRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  const reasonOr404 = <T>(row: T | null): T => {
    if (row === null) throw new NotFoundError();
    return row;
  };

  return {
    'POST /cases/next': ctx.secure('reports.decide', (c) => {
      const body = optionalBody(c.req);
      let category: ReportCategory | undefined;
      if (has(body, 'category')) {
        const v = body.category;
        if (typeof v !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(v)) throw new ValidationError();
        category = v as ReportCategory;
      }
      let reason: string | null | undefined;
      if (has(body, 'reason')) {
        const v = body.reason;
        if (typeof v !== 'string' || (v !== 'none' && !isReasonId(v))) throw new ValidationError();
        reason = v === 'none' ? null : v;
      }
      const found = cw.cases.next(c.authz.actor, { ...(category === undefined ? {} : { category }), ...(reason === undefined ? {} : { reason }) });
      return {
        status: 200,
        body: {
          case:
            found === null
              ? null
              : { person: found.person, reportId: found.reportId, claim: { by: found.claim.by, since: found.claim.since, until: found.claim.until } },
        },
      };
    }),

    'POST /cases/:ref/claim': ctx.secure('reports.decide', (c) => {
      const ref = c.params.ref as string;
      const takeOver = bodyTakeOver(optionalBody(c.req));
      const actor = c.authz.actor;
      // Only a live claim of somebody else is a takeover; it is recorded before it happens, so an unrecorded one cannot.
      let moving = false;
      if (takeOver && canOverrideClaims(ctx, c)) {
        const holder = cw.cases.holder(ref);
        if (holder !== null && holder.by !== actor) {
          c.audit('case.takeover', { type: 'person', ref: cw.people.canonical(ref) }, 'required');
          moving = true;
        }
      }
      const out = cw.cases.claim(ref, actor, { takeOver: moving });
      if (!out.ok) {
        if (out.error === 'no_case') throw new NotFoundError();
        throw new ClaimedError(out.claim);
      }
      return {
        status: 200,
        body: { claim: { by: out.claim.by, since: out.claim.since, until: out.claim.until }, tookOverFrom: out.tookOverFrom },
      };
    }),

    'POST /cases/:ref/release': ctx.secure('reports.decide', (c) => ({
      status: 200,
      body: { released: cw.cases.release(c.params.ref as string, c.authz.actor) },
    })),

    'POST /cases/:ref/viewing': ctx.secure('reports.read', (c) => {
      const ref = c.params.ref as string;
      // Only a real case is tracked: 404 for a person with no open report, so made-up refs fill nothing.
      if (!cw.cases.view(ref, c.authz.actor)) throw new NotFoundError();
      return { status: 200, body: { viewers: cw.cases.viewers(ref, c.authz.actor) } };
    }),

    'GET /changes': ctx.secure('reports.read', (c) => {
      const since = c.req.query.since;
      if (since !== undefined && !TOKEN_RE.test(since)) throw new HttpError('invalid_query');
      const token = cw.changes.token();
      return { status: 200, body: { token, changed: since !== token } };
    }),

    'GET /reasons': ctx.secure('reasons.read', () => ({ status: 200, body: { reasons: cw.reasons.list() } })),

    'POST /reasons': ctx.secure('reasons.write', (c) => {
      const body = bodyObject(c.req);
      // The facade trims and checks the limits (ReasonError -> 400), and the cap on how many there are.
      const reason = cw.reasons.add({ label: body.label as string, text: body.text as string });
      c.audit('reason.add', { type: 'reason', ref: reason.id }, 'best-effort');
      return { status: 200, body: { reason } };
    }),

    'PATCH /reasons/:id': ctx.secure('reasons.write', (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      const patch: { label?: string; text?: string } = {};
      if (has(body, 'label')) patch.label = body.label as string;
      if (has(body, 'text')) patch.text = body.text as string;
      const reason = reasonOr404(cw.reasons.update(id, patch));
      c.audit('reason.update', { type: 'reason', ref: id }, 'best-effort');
      return { status: 200, body: { reason } };
    }),

    'POST /reasons/:id/active': ctx.secure('reasons.write', (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      if (typeof body.active !== 'boolean') throw new ValidationError();
      const reason = reasonOr404(cw.reasons.setActive(id, body.active));
      c.audit('reason.toggle', { type: 'reason', ref: id }, 'best-effort');
      return { status: 200, body: { reason } };
    }),
  };
}
