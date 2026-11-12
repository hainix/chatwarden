import { APPEAL_OUTCOMES, CONDUCT_LEVELS, MAX_SANCTION_DURATION_MS, SANCTION_KIND_ORDER, SANCTION_KINDS } from '@chatwarden/core';
import type { AppealDecision, AppealOutcome, ConductLevel, DecisionAction, RuleRef, SanctionKind } from '@chatwarden/core';
import { parseJson } from '../body.js';
import { HttpError, ValidationError } from '../errors.js';
import type { KitRequest } from '../types.js';

// Shared by the staff routes. Every refusal is a fixed-message HttpError: nothing the client sent is echoed.

/** An id as the router accepts it in a path: the same charset and length. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The JSON body as a plain object. No body, bad JSON, an array, a string or `null` are 400 (the body cap is 413). */
export function bodyObject(req: KitRequest): Record<string, unknown> {
  const value = parseJson(req.rawBody);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError();
  return value as Record<string, unknown>;
}

/** The JSON body as a plain object, or an empty one when the request has no body. Bad JSON, an array, a string or `null` are 400. */
export function optionalBody(req: KitRequest): Record<string, unknown> {
  const value = parseJson(req.rawBody);
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError();
  return value as Record<string, unknown>;
}

/** A body `takeOver`: absent is false; otherwise it must be a boolean, else 400. */
export function bodyTakeOver(body: Record<string, unknown>): boolean {
  if (!Object.hasOwn(body, 'takeOver')) return false;
  if (typeof body.takeOver !== 'boolean') throw new ValidationError();
  return body.takeOver;
}

/** What `POST /reports/dismiss-open` takes, checked for shape. */
export interface DismissOpenBody {
  scope: 'person' | 'reporter';
  ref: string;
  takeOver: boolean;
  dryRun: boolean;
}

/**
 * The body of a bulk dismissal: `{ scope: 'person' | 'reporter', ref, takeOver?, dryRun? }`. `takeOver` exists for the person
 * scope only (a sweep over a reporter's cases never takes a case over). A sweep always carries the standard reason, so there is
 * no `reason`. Any other key is 400 `forbidden_key`; any other shape is 400 `invalid_request`. The scope is checked first, so a
 * body with a bad scope is `invalid_request` whatever else it holds.
 */
export function bodyDismissOpen(body: Record<string, unknown>): DismissOpenBody {
  const scope = body.scope;
  if (scope !== 'person' && scope !== 'reporter') throw new ValidationError();
  const allowed = scope === 'person' ? ['scope', 'ref', 'takeOver', 'dryRun'] : ['scope', 'ref', 'dryRun'];
  if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError('forbidden_key');
  const ref = bodyId(body.ref);
  const takeOver = scope === 'person' ? bodyTakeOver(body) : false;
  let dryRun = false;
  if (has(body, 'dryRun')) {
    if (typeof body.dryRun !== 'boolean') throw new ValidationError();
    dryRun = body.dryRun;
  }
  return { scope, ref, takeOver, dryRun };
}

/** True when the object has this key of its own (a JSON body has no `undefined`, so a present key has a value). */
export const has = (o: Record<string, unknown>, key: string): boolean => Object.hasOwn(o, key);

/** A plain object (not an array, not null), or undefined. */
export const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A query `limit`: absent is `undefined`; otherwise a whole number of at most nine digits, else 400 `invalid_query`. */
export function queryLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new HttpError('invalid_query');
  return Number(raw);
}

const isLevel = (v: unknown): v is ConductLevel => typeof v === 'string' && (CONDUCT_LEVELS as readonly string[]).includes(v);

/** A query `level`: absent is null; otherwise a conduct level, else 400 `invalid_query`. */
export function queryLevel(raw: string | undefined): ConductLevel | null {
  if (raw === undefined) return null;
  if (!isLevel(raw)) throw new HttpError('invalid_query');
  return raw;
}

/** A body `level`: absent or null is null; otherwise a conduct level, else 400. */
export function bodyLevel(v: unknown): ConductLevel | null {
  if (v === undefined || v === null) return null;
  if (!isLevel(v)) throw new ValidationError();
  return v;
}

/** A Community Rule reference: a whole number from 1, or `'uncovered'`. Anything else is 400. */
export function bodyRule(v: unknown): RuleRef {
  if (v === 'uncovered') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return v;
  throw new ValidationError();
}

/** A staff ref or other id: 1..64 characters of `A-Z a-z 0-9 _ -`, else 400. */
export function bodyId(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ValidationError();
  return v;
}

/** What a decision body's `ai` echo carries: the read the moderator saw, whether they accepted its pre-fill in one click, and the form's conduct level. */
export interface AiEchoBody {
  readId: string;
  accepted: boolean;
  severity?: ConductLevel;
}

/**
 * The `ai` of a decision body: exactly `{ readId, accepted }` and optionally `severity` (a conduct level). `readId` is an id
 * (1..64 characters of `A-Z a-z 0-9 _ -`); an id that names no read is not an error here (the facade ignores it). Anything else
 * malformed, or any other key, is 400.
 */
export function bodyAiEcho(v: unknown): AiEchoBody {
  const o = asObject(v);
  if (o === undefined) throw new ValidationError();
  if (Object.keys(o).some((k) => k !== 'readId' && k !== 'accepted' && k !== 'severity')) throw new ValidationError();
  const readId = bodyId(o.readId);
  if (typeof o.accepted !== 'boolean') throw new ValidationError();
  if (!has(o, 'severity')) return { readId, accepted: o.accepted };
  if (!isLevel(o.severity)) throw new ValidationError();
  return { readId, accepted: o.accepted, severity: o.severity };
}

/** The longest free text a staff request may carry (a reason, an evidence note, a gap note before the core's own cap). */
export const MAX_TEXT = 2000;
/** The most excerpt lines a notice may quote per action (the facade's own cap). */
const MAX_LINE_IDS = 5;

/** A string of at most `max` characters, else 400. */
export const bodyText = (v: unknown, max = MAX_TEXT): string => {
  if (typeof v !== 'string' || v.length > max) throw new ValidationError();
  return v;
};

/**
 * One sanction action, checked for shape and cut down to the fields the facade reads. Rules and limits stay with the facade.
 * Shared by a decision's actions and by `POST /sanctions`, so the two cannot disagree on a duration or a permanent ban.
 */
export function parseAction(raw: unknown): DecisionAction {
  const a = asObject(raw);
  if (a === undefined) throw new ValidationError();
  const subject = bodyId(a.subject);
  const kind = a.kind;
  if (typeof kind !== 'string' || !(SANCTION_KINDS as readonly string[]).includes(kind)) throw new ValidationError();
  // Required, not defaulted: leaving a duration out must never turn a chat restriction or a ban into a permanent one.
  // Capped (as the facade caps it) so that `null` is the only permanent value and the ban_permanent check cannot be
  // sidestepped with a huge number.
  const durationMs = a.durationMs;
  if (
    durationMs !== null &&
    !(typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= MAX_SANCTION_DURATION_MS)
  ) {
    throw new ValidationError();
  }
  const action: DecisionAction = { subject, kind: kind as SanctionKind, durationMs, rule: bodyRule(a.rule) };
  if (has(a, 'gapNote')) action.gapNote = bodyText(a.gapNote);
  if (has(a, 'includeIp')) {
    if (typeof a.includeIp !== 'boolean') throw new ValidationError();
    action.includeIp = a.includeIp;
  }
  if (has(a, 'lineIds')) {
    const ids = a.lineIds;
    if (!Array.isArray(ids) || ids.length > MAX_LINE_IDS) throw new ValidationError();
    action.lineIds = ids.map((id) => bodyText(id, 64));
  }
  return action;
}

/** A query `status` of the appeals inbox: absent is `undefined` (the core's default, open); otherwise `open`, `decided` or `all`, else 400 `invalid_query`. */
export function queryAppealStatus(raw: string | undefined): 'open' | 'decided' | 'all' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'open' && raw !== 'decided' && raw !== 'all') throw new HttpError('invalid_query');
  return raw;
}

/** A query `days` of the appeals numbers: absent is `undefined` (the core's default, 90); otherwise exactly `30`, `90` or `365`, else 400 `invalid_query`. */
export function queryAppealDays(raw: string | undefined): 30 | 90 | 365 | undefined {
  if (raw === undefined) return undefined;
  if (raw === '30') return 30;
  if (raw === '90') return 90;
  if (raw === '365') return 365;
  throw new HttpError('invalid_query');
}

/** The ruling a staff body carries: the outcome, the private reason and, for `reduce` only, the lighter outcome. */
export type AppealDecisionBody = Pick<AppealDecision, 'outcome' | 'reason' | 'to'>;

/**
 * The body of `POST /appeals/:id/decide`: `{ outcome, reason, to? }`. `outcome` is `uphold`, `reduce` or `revoke`; `reason` is text that is not
 * blank (the core keeps it to 500 characters); `to` is `{ kind, durationMs }` and is required for `reduce` and refused for the others.
 * Anything else is 400. The actor is never from the body. Whether `to` is lighter than the sanction is the core's to say.
 */
export function bodyAppealDecision(body: Record<string, unknown>): AppealDecisionBody {
  const outcome = body.outcome;
  if (typeof outcome !== 'string' || !(APPEAL_OUTCOMES as readonly string[]).includes(outcome)) throw new ValidationError();
  const reason = bodyText(body.reason);
  if (reason.trim() === '') throw new ValidationError();
  if (outcome !== 'reduce') {
    if (has(body, 'to')) throw new ValidationError();
    return { outcome: outcome as AppealOutcome, reason };
  }
  const to = asObject(body.to);
  if (to === undefined) throw new ValidationError();
  const { kind, durationMs } = to;
  if (typeof kind !== 'string' || !(SANCTION_KIND_ORDER as readonly string[]).includes(kind)) throw new ValidationError();
  if (durationMs !== null && !(typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= MAX_SANCTION_DURATION_MS)) {
    throw new ValidationError();
  }
  return { outcome: 'reduce', reason, to: { kind: kind as 'warning' | 'chat' | 'area' | 'ban', durationMs } };
}
