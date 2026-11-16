import { createHash, timingSafeEqual } from 'node:crypto';
import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import { decideAs } from '../admin/decideAs.js';
import { bodyObject } from '../admin/validate.js';
import { BODY_MAX_BYTES, utf8ByteLength } from '../body.js';
import { HttpError, ValidationError, withErrors } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { KitRequest, KitResponse } from '../types.js';
import type { ResolvedCoopOptions } from './options.js';
import { verifyCoopSignature } from './verify.js';
import { decisionOf, screenCallback } from './wire.js';
import type { IgnoreReason } from './wire.js';

// Inbound (K5 design 8.2 and 8.4): `POST /coop/actions`, one URL for every Coop action. Each step fails closed:
//  1. the body is present and at most 64 KiB; 2. the signature over the exact bytes verifies (RSA, public key only); 3. the optional callback header matches, in
//  constant time; 4. only then the body is parsed; 5. a callback no moderator made is ignored; 6. the report is read; 7 to 9. the decision is built on the report's own
//  target; 10. it goes through `decideAs`, the hub's own decision path, as the configured role with source `coop`; the audit row and the link row follow.
// Coop's body-only signature carries no time, so replays are made harmless by effect (the core's decision is idempotent and a closed report is acknowledged), not by freshness.

/** The longest an `item.id` or `action.id` read from a callback may be. */
const ID_MAX = 128;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v.length >= 1 && v.length <= ID_MAX ? v : undefined);
const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

export interface Inbound {
  routes: RouteTable;
  dispose(): void;
}

export function createInbound(cw: Chatwarden, o: ResolvedCoopOptions): Inbound {
  const { logger, clock } = o;
  let disposed = false;
  const fail = (op: string, err?: unknown): void => safeWarn(logger, 'chatwarden.coop_failed', { op, ...(err === undefined ? {} : { error: errorClass(err) }) });

  /** The configured callback header, compared in constant time (both sides hashed, so the lengths always match). */
  const authOk = (headers: Readonly<Record<string, string | undefined>>): boolean => {
    const wanted = o.callbackAuth;
    if (wanted === null) return true;
    let given: string | undefined;
    for (const name of Object.keys(headers)) if (name.toLowerCase() === wanted.header) given = headers[name];
    return timingSafeEqual(digest(typeof given === 'string' ? given : ''), digest(wanted.value)) && typeof given === 'string';
  };

  const ignore = (reason: IgnoreReason): KitResponse => {
    safeWarn(logger, 'chatwarden.coop_callback_ignored', { reason });
    return { status: 200, body: { ok: true, outcome: 'ignored' } };
  };

  /** A store failure: Coop retries a 5xx (up to five times) and the decision is atomic, so a retry is safe. */
  const unavailable = (op: string, err: unknown): KitResponse => {
    fail(op, err);
    return { status: 503, body: { error: 'unavailable' } };
  };

  /** After a decision that was applied (not a replay): the audit row, best effort, and the end of whoever held a claim on the person. */
  const afterApplied = (reportId: string, person: string, actor: string): void => {
    try {
      if (!cw.audit.record({ actor, role: o.role, action: 'report.decide', target: { type: 'report', ref: reportId } })) fail('audit', new Error('NotWritten'));
    } catch (err) {
      fail('audit', err);
    }
    // A Coop moderator holds no claim and is never held up by one; when the person's last open report is decided, whoever held the case is released.
    try {
      const holder = cw.cases.holder(person);
      if (holder !== null) cw.cases.releaseWhenDone(person, holder.by);
    } catch (err) {
      fail('release', err);
    }
  };

  /** The link row ends as `decided`, keeping the Coop job id when it is known. A failure is logged and never surfaced. */
  const markDecided = (reportId: string): void => {
    try {
      const existing = cw.links.get('coop-report', reportId);
      cw.links.put({ system: 'coop-report', ref: reportId, external: existing?.external ?? 'unknown', state: 'decided', at: clock.now() });
    } catch (err) {
      fail('link', err);
    }
  };

  const handler = withErrors(async (req: KitRequest): Promise<KitResponse> => {
    const raw = req.rawBody;
    if (raw === undefined) {
      // The adapter did not give the exact bytes (a body parser ran first, or none supplies rawBody): a setup error, never a pass.
      fail('no_raw_body');
      return { status: 500, body: { error: 'internal' } };
    }
    // Cheap size cap before any crypto (the byte cap the routes enforce).
    if (raw.length * 3 > BODY_MAX_BYTES && utf8ByteLength(raw) > BODY_MAX_BYTES) throw new HttpError('payload_too_large');
    // Verify BEFORE parsing. Every failure is the same 401.
    if (disposed || !verifyCoopSignature(o.webhookPublicKey, req.headers, raw) || !authOk(req.headers)) throw new HttpError('unauthorized');

    const body = bodyObject(req);
    const reportId = idOf(isObject(body['item']) ? body['item']['id'] : undefined);
    if (reportId === undefined || idOf(isObject(body['action']) ? body['action']['id'] : undefined) === undefined) throw new ValidationError();

    const screened = screenCallback(body);
    if (screened !== null) return ignore(screened);

    let report;
    try {
      report = cw.reports.get(reportId);
    } catch (err) {
      return unavailable('read', err);
    }
    if (report === null) return ignore('unknown_item');

    // A report that is not open is answered as a replay when it is the same decision again, and as `closed` otherwise: the first decision stands.
    const built = decisionOf(body, o, report, cw);
    if (!built.ok) return ignore(report.status === 'open' ? built.reason : 'closed');

    let outcome;
    try {
      outcome = await decideAs(cw, {
        reportId,
        decision: built.decision,
        actor: built.actor,
        role: o.role,
        permissions: o.permissions,
        source: 'coop',
        claims: 'ignore',
        ...(logger === undefined ? {} : { logger }),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 403) return ignore('forbidden');
        if (err.code === 'already_decided') return ignore('closed');
        if (err.status === 404) return ignore('unknown_item');
        if (err.status >= 400 && err.status < 500) return ignore(report.status === 'open' ? 'refused' : 'closed');
      }
      return unavailable('decide', err);
    }
    // The decision has committed (a replay included): what follows is best effort and never changes the answer.
    if (!outcome.replay) afterApplied(reportId, report.targetPerson, built.actor);
    markDecided(reportId);
    return { status: 200, body: { ok: true, outcome: outcome.replay ? 'replay' : 'applied' } };
  }, logger);

  return {
    routes: { 'POST /coop/actions': handler },
    dispose() {
      disposed = true;
    },
  };
}
