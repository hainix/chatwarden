import type { Chatwarden, DecisionAction, DecisionInput, SanctionKind, StaffReport } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { PermissionKey } from '../permissions.js';
import { bodyText, has, parseAction } from './validate.js';

// What a decision and a direct sanction check and do. The staff routes (`POST /reports/:id/decide`, `POST /sanctions`)
// and the signed incoming webhook (`webhookIn`) all run THESE functions, so the three cannot disagree on what is valid or
// on who may ban permanently. Each refusal is a fixed-message HttpError; nothing the client sent is echoed.

/** The most actions one decision may carry. A report involves a handful of people. */
export const MAX_ACTIONS = 20;

const VERDICTS: readonly DecisionInput['verdict'][] = ['upheld', 'noted', 'no_action', 'bad_faith'];

/** Everyone a report names, as staff refs: the target, the reporter and the people who wrote in the excerpt. */
export function peopleOf(report: StaffReport): string[] {
  return [...new Set([report.targetPerson, report.reporterPerson, ...report.people])];
}

/** A decision as the staff body carries it, checked for shape. */
export interface ParsedDecision {
  verdict: DecisionInput['verdict'];
  actions: DecisionAction[];
  reason: string;
  evidence?: string;
}

/** Check a decision body's shape (`verdict`, `actions`, `reason`, `evidence?`). Rules and limits stay with the facade. */
export function parseDecision(body: Record<string, unknown>): ParsedDecision {
  const verdict = body.verdict;
  if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) throw new ValidationError();
  if (!Array.isArray(body.actions) || body.actions.length > MAX_ACTIONS) throw new ValidationError();
  const actions = body.actions.map(parseAction);
  const reason = bodyText(body.reason);
  const evidence = has(body, 'evidence') ? bodyText(body.evidence) : undefined;
  return { verdict: verdict as DecisionInput['verdict'], actions, reason, ...(evidence === undefined ? {} : { evidence }) };
}

/** What a decision DOES needs the right to do it: `need` throws 403. Call it before anything is read or written. */
export function needForDecision(actions: readonly DecisionAction[], need: (permission: PermissionKey) => void): void {
  if (actions.length > 0) need('sanctions.apply');
  if (actions.some((a) => a.kind === 'ban' && a.durationMs === null)) need('sanctions.apply.ban_permanent');
}

/** The decision's outcome as the routes answer it. */
export interface DecisionOutcome {
  replay: boolean;
  groups: Array<{ refCode: string; kind: SanctionKind }>;
}

/**
 * Decide report `reportId` as `actor` (never from a request body): the report must exist and every action must name a
 * person on it. 404 for an unknown report, 409 `already_decided`, 400 for anything the facade refuses. A replay of the same
 * decision is `replay: true` and applies nothing.
 */
export async function applyDecision(
  cw: Chatwarden,
  reportId: string,
  decision: ParsedDecision,
  actor: string,
): Promise<DecisionOutcome> {
  const report = cw.reports.get(reportId);
  if (report === null) throw new NotFoundError();
  // The staff refs the report shows, or the ids it was filed under (the facade makes them canonical, so a ref gone
  // stale through a later merge still replays).
  const named = new Set([...peopleOf(report), report.targetSubject, report.reporterSubject]);
  if (!decision.actions.every((a) => named.has(a.subject))) throw new ValidationError();

  const result = await cw.decide({
    reportId,
    verdict: decision.verdict,
    ...(decision.evidence === undefined ? {} : { evidence: decision.evidence }),
    actions: decision.actions,
    // Never from the body: the caller is who the auth hook says (or the webhook's configured actor), always a moderator's.
    actor,
    reason: decision.reason,
    source: 'moderator',
  });
  if (!result.ok) {
    if (result.error === 'not_found') throw new NotFoundError();
    if (result.error === 'already_decided') throw new HttpError('already_decided');
    throw new ValidationError();
  }
  return { replay: result.replay, groups: result.groups.map((g) => ({ refCode: g.refCode, kind: g.kind })) };
}

/** A direct sanction as the staff body carries it, checked for shape. */
export interface ParsedSanction {
  action: DecisionAction;
  reason: string;
}

/** Check a direct-sanction body's shape. Notice excerpts (`lineIds`) belong to a decision, so they are refused here. */
export function parseSanction(body: Record<string, unknown>): ParsedSanction {
  if (has(body, 'lineIds')) throw new ValidationError();
  // The same checks as a decision's actions, so the two paths cannot disagree.
  const action = parseAction(body);
  const reason = has(body, 'reason') ? bodyText(body.reason) : '';
  return { action, reason };
}

/** A permanent ban needs the senior permission; `need` throws 403. Call it before anything is written. */
export function needForSanction(action: DecisionAction, need: (permission: PermissionKey) => void): void {
  if (action.kind === 'ban' && action.durationMs === null) need('sanctions.apply.ban_permanent');
}

/** Apply one sanction as `actor` (never from a body); the source is always `moderator`. 400 when the rule cannot be cited. */
export async function applySanction(
  cw: Chatwarden,
  sanction: ParsedSanction,
  actor: string,
): Promise<{ groupId: string; refCode: string }> {
  const { action, reason } = sanction;
  if (!cw.rules.isCitable(action.rule)) throw new ValidationError();
  const done = await cw.sanctions.apply({
    kind: action.kind,
    subject: action.subject,
    includeIp: action.includeIp ?? false,
    durationMs: action.durationMs,
    reason,
    actor,
    source: 'moderator',
    automated: false,
    rule: action.rule,
    ...(action.gapNote === undefined ? {} : { gapNote: action.gapNote }),
  });
  return { groupId: done.groupId, refCode: done.refCode };
}
