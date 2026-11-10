import { isValidAuditActor, ROLES, safeWarn } from '@chatwarden/core';
import type { AuditAction, AuditTarget, Chatwarden, Clock, Logger, Role } from '@chatwarden/core';
import {
  applyDecision,
  applySanction,
  needForDecision,
  needForSanction,
  parseDecision,
  parseSanction,
} from '../admin/apply.js';
import { asObject, bodyId, bodyObject, has } from '../admin/validate.js';
import { requireRole } from '../auth.js';
import { BODY_MAX_BYTES } from '../body.js';
import { HttpError, ValidationError, withErrors } from '../errors.js';
import { resolvePermissions } from '../permissions.js';
import type { PermissionKey } from '../permissions.js';
import type { RouteTable } from '../router.js';
import type { KitRequest, KitResponse } from '../types.js';
import { checkSecret, ReplayCache, verify } from './sign.js';

/** What the adopter gives the incoming webhook. */
export interface WebhookInOptions {
  /** Signs every request (HMAC-SHA256, see `sign`). At least 32 characters (`RangeError` otherwise). Never logged. */
  secret: string;
  /**
   * The staff ref every webhook action is done and audited as: 1..128 characters of `A-Z a-z 0-9 _ . : @ + -`
   * (`RangeError` otherwise). A request can never choose its own actor.
   */
  actor: string;
  /**
   * The role the webhook acts with, checked against the same permissions as the staff routes. Default `moderator`: a
   * webhook at that role can decide reports and apply sanctions, but not ban permanently
   * (`sanctions.apply.ban_permanent` needs `senior` unless `permissions` says otherwise).
   */
  role?: Role;
  /** Overrides of the default minimum roles, as for the staff routes. Validated once (`RangeError`). */
  permissions?: Partial<Record<PermissionKey, Role | undefined>>;
  /** The replay memory. Default: a new `ReplayCache` (10000 signatures). Share one across several routes if they share a secret. */
  replay?: ReplayCache;
  /** The time source for the 5 minute window. Default: `Date.now`. */
  clock?: Clock;
  /** Where failures are logged (event and error class only). Defaults to `console.warn`. */
  logger?: Logger;
}

const systemClock: Clock = { now: () => Date.now() };
const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The idempotency key: 1..64 characters of `A-Z a-z 0-9 _ . : -`, else 400 `invalid_idempotency_key`. */
function idempotencyKey(v: unknown): string {
  if (typeof v !== 'string' || !KEY_RE.test(v)) throw new HttpError('invalid_idempotency_key');
  return v;
}

/**
 * The signed incoming webhook: one route, `POST /webhooks/in/action`. Mount it with `toExpress` (which supplies the
 * exact `rawBody` the signature covers) or any adapter that does.
 *
 * Send `x-chatwarden-timestamp` and `x-chatwarden-signature` as `webhooksOut` does (see `sign`) and a JSON body of
 * - `{ action: 'decide', input: { reportId, verdict, actions, reason, evidence? } }`: decide a report, exactly as
 *   `POST /reports/:id/decide`. A decision is idempotent in the core, so a repeat is a replay and applies nothing more.
 *   An `idempotencyKey` is optional for it (validated if present, and not used).
 * - `{ action: 'sanction', input: { subject, kind, durationMs, rule, reason?, gapNote?, includeIp?, idempotencyKey } }`:
 *   apply one sanction, exactly as `POST /sanctions`. `idempotencyKey` is REQUIRED: 1..64 characters of
 *   `A-Z a-z 0-9 _ . : -`. The same key within 24 hours returns the first result (`{ groupId, refCode }`) and applies
 *   nothing more, whatever else the request says. A key whose first request is still running in another process is
 *   409 `in_progress`; retry later.
 *
 * Order of checks: body size (413), signature, then the body. The signature is verified over `rawBody` BEFORE it is
 * parsed. ANY verification failure (a missing or malformed header, a timestamp more than 5 minutes off, a wrong
 * signature or a replay) is the same 401 `unauthorized`. An absent `rawBody` is 500 (the adapter did not supply it).
 * A signature is accepted once: sign every attempt afresh, with a new timestamp, including a retry of a request that
 * failed. Then the SAME validation and permission checks as the staff routes, at the configured `role`.
 *
 * The actor is always `options.actor` and the source always `moderator`; an `actor`, `source` or `role` in the body is
 * ignored. The audit trail records `report.decide` / `sanction.apply` with that actor and role.
 *
 * A sanction that failed (a 400 or a 500) frees its key, so the retry can run. If the sanction is live but its result
 * could not be saved, the key stays pending (`chatwarden.webhook_key_failed`): a retry is 409, never a second sanction.
 */
export function webhookIn(cw: Chatwarden, options: WebhookInOptions): RouteTable {
  checkSecret(options?.secret, 'webhookIn: secret');
  const { secret, actor, logger } = options;
  if (!isValidAuditActor(actor)) throw new RangeError('webhookIn: actor must be 1..128 characters of A-Z a-z 0-9 _ . : @ + -');
  const role = options.role ?? 'moderator';
  if (!(ROLES as readonly unknown[]).includes(role)) throw new RangeError(`webhookIn: role must be one of ${ROLES.join(', ')}`);
  const permissions = resolvePermissions(options.permissions);
  const replay = options.replay ?? new ReplayCache();
  const clock = options.clock ?? systemClock;
  const authz = { actor, role };
  const may = (permission: PermissionKey): void => void requireRole(authz, permission, permissions);
  /** The shared attempt of each key being applied in this process, so a duplicate request awaits it. */
  const inFlight = new Map<string, Promise<{ groupId: string; refCode: string }>>();

  const audit = (action: AuditAction, target: AuditTarget): void => {
    let written: boolean;
    try {
      written = cw.audit.record({ actor, role, action, target });
    } catch {
      written = false;
    }
    if (!written) safeWarn(logger, 'chatwarden.http_audit_failed');
  };

  const decide = async (input: Record<string, unknown>): Promise<KitResponse> => {
    may('reports.decide');
    if (has(input, 'idempotencyKey')) idempotencyKey(input.idempotencyKey);
    const reportId = bodyId(input.reportId);
    const decision = parseDecision(input);
    needForDecision(decision.actions, may);
    const result = await applyDecision(cw, reportId, decision, actor);
    // The decision has committed (a replay included): an audit failure is logged, never turned into an error.
    audit('report.decide', { type: 'report', ref: reportId });
    return { status: 200, body: { ok: true, replay: result.replay, groups: result.groups } };
  };

  const sanction = async (input: Record<string, unknown>): Promise<KitResponse> => {
    may('sanctions.apply');
    const key = idempotencyKey(input.idempotencyKey);
    const parsed = parseSanction(input);
    needForSanction(parsed.action, may);

    // Reserve before applying. Everything that can be refused was refused above, so a bad request never takes a key.
    const reservation = cw.webhookKeys.reserve(key);
    if (reservation.reserved) {
      const work = (async () => {
        let done: { groupId: string; refCode: string };
        try {
          done = await applySanction(cw, parsed, actor);
        } catch (err) {
          // Nothing was applied: free the key so a retry can proceed.
          try {
            cw.webhookKeys.release(key);
          } catch {
            safeWarn(logger, 'chatwarden.webhook_key_failed');
          }
          throw err;
        }
        try {
          cw.webhookKeys.complete(key, JSON.stringify(done));
        } catch {
          // The sanction is live. Leave the key pending: a retry is 409, never a second sanction.
          safeWarn(logger, 'chatwarden.webhook_key_failed');
        }
        audit('sanction.apply', { type: 'sanction', ref: done.groupId });
        return done;
      })();
      inFlight.set(key, work);
      try {
        return { status: 200, body: await work };
      } finally {
        inFlight.delete(key);
      }
    }
    if (reservation.state === 'done') return { status: 200, body: JSON.parse(reservation.resultJson) as unknown };
    // Pending: ours (a duplicate arrived while the first is applying), or another process's.
    const shared = inFlight.get(key);
    if (shared !== undefined) return { status: 200, body: await shared };
    throw new HttpError('in_progress');
  };

  const handler = withErrors(async (req: KitRequest): Promise<KitResponse> => {
    const raw = req.rawBody;
    if (raw === undefined) {
      // The adapter did not give the exact bytes (a body parser ran first, or none supplies rawBody): a setup error.
      safeWarn(logger, 'chatwarden.webhook_no_raw_body');
      return { status: 500, body: { error: 'internal' } };
    }
    // Cheap size cap before any HMAC work (the byte cap the routes enforce).
    if (raw.length * 3 > BODY_MAX_BYTES && Buffer.byteLength(raw, 'utf8') > BODY_MAX_BYTES) throw new HttpError('payload_too_large');
    // Verify BEFORE parsing. Every failure is the same 401.
    if (!verify(secret, req.headers, raw, clock.now(), replay)) throw new HttpError('unauthorized');

    const body = bodyObject(req);
    const input = asObject(body.input);
    if (input === undefined) throw new ValidationError();
    if (body.action === 'decide') return decide(input);
    if (body.action === 'sanction') return sanction(input);
    throw new ValidationError();
  }, logger);

  return { 'POST /webhooks/in/action': handler };
}
