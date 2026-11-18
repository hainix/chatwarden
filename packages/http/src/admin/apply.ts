import { isEvidenceKind, validateSanctionInput } from '@chatwarden/core';
import type { Chatwarden, DecisionAction, DecisionInput, EvidenceKind, Role, SanctionInput, SanctionKind, Source, StaffReport } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { PermissionKey } from '../permissions.js';
import type { ScopedLimits } from './context.js';
import { bodyText, has, parseAction } from './validate.js';
import type { AiEchoBody } from './validate.js';

// What a decision and a direct sanction check and do. The staff routes (`POST /reports/:id/decide`, `POST /sanctions`)
// and the signed incoming webhook (`webhookIn`) all run THESE functions, so the three cannot disagree on what is valid or
// on who may ban permanently. Each refusal is a fixed-message HttpError; nothing the client sent is echoed.

/** The most actions one decision may carry. A report involves a handful of people. */
export const MAX_ACTIONS = 20;

const VERDICTS: readonly DecisionInput['verdict'][] = ['upheld', 'noted', 'no_action', 'bad_faith'];

/** Everyone a report names, as staff refs: the target, the reporter and the people who wrote in the excerpt. */
export function peopleOf(report: StaffReport): string[] {
  // A report nobody filed (a chat filter's flag) has no reporter.
  return [...new Set([report.targetPerson, ...(report.reporterPerson === null ? [] : [report.reporterPerson]), ...report.people])];
}

/**
 * The ids a decision or a suggestion may name for a report: the people it shows and the ids it was filed under (a stale ref after a merge
 * still replays). A report nobody filed has a reporter value (`filter:<id>`) that is not a person: it is never named.
 */
export function namedIn(report: StaffReport): Set<string> {
  return new Set([...peopleOf(report), report.targetSubject, ...((report.origin ?? null) === null ? [report.reporterSubject] : [])]);
}

/** A decision as the staff body carries it, checked for shape. */
export interface ParsedDecision {
  verdict: DecisionInput['verdict'];
  actions: DecisionAction[];
  /** Absent when the body has none: the core stores the standard reason, and only for a `no_action` with no actions. */
  reason?: string;
  evidence?: string;
  /** What the decision is about (0.2.2), the moderator's own choice over the report's: `null` is neutral. Absent: the report's reason says. */
  evidenceKind?: EvidenceKind | null;
}

/**
 * Check a decision body's shape (`verdict`, `actions`, `reason?`, `evidence?`). A `reason` that is given must be a string of a sane
 * length; whether one is REQUIRED (every verdict but a `no_action` with no actions) is the facade's rule, so the staff route, the
 * incoming webhook and every other caller cannot disagree. Rules and limits stay with the facade. A `rename` key is refused (400): only the
 * staff decide route asks for one, and it strips it first.
 */
export function parseDecision(body: Record<string, unknown>): ParsedDecision {
  // A rename rides on the staff route only (`POST /reports/:id/decide` takes it out before this); the webhook and `decideAs` callers send none.
  if (has(body, 'rename')) throw new ValidationError();
  const verdict = body.verdict;
  if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) throw new ValidationError();
  if (!Array.isArray(body.actions) || body.actions.length > MAX_ACTIONS) throw new ValidationError();
  const actions = body.actions.map(parseAction);
  const reason = has(body, 'reason') ? bodyText(body.reason) : undefined;
  const evidence = has(body, 'evidence') ? bodyText(body.evidence) : undefined;
  const kind = body.evidenceKind;
  if (has(body, 'evidenceKind') && kind !== null && !isEvidenceKind(kind)) throw new ValidationError();
  return {
    verdict: verdict as DecisionInput['verdict'],
    actions,
    ...(reason === undefined ? {} : { reason }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(has(body, 'evidenceKind') ? { evidenceKind: kind as EvidenceKind | null } : {}),
  };
}

/**
 * The lengths the profile itself names: every ladder cell, and the first-offense and repeat outcomes. A moderator who accepts
 * the suggestion must be able to apply it, so these are always allowed, whether or not they are in `durations`.
 */
function ownLengths(profile: Chatwarden['profile']): Set<number> {
  const own = new Set<number>();
  for (const row of profile.ladder) {
    for (const cell of [row.lowMedium, row.high]) if (cell.durationMs !== null) own.add(cell.durationMs);
  }
  for (const o of [...Object.values(profile.firstOffense), profile.repeat.outcome]) {
    if (typeof o === 'object' && o.durationMs !== null) own.add(o.durationMs);
  }
  return own;
}

/**
 * With `customDuration` off, a restriction or ban may only be for a length the profile offers (`durations`), the profile's own
 * lengths (the ladder, the first offences, the repeat rule), or permanent. Anything else is 400 `duration_not_offered`. With it on
 * (the default) any valid length passes, as before. The profile is read live, once, so a saved change applies to the next
 * request. Warnings and notes have no length (the facade refuses one that has). The staff routes call this after authorizing.
 */
export function checkDurationsOffered(cw: Chatwarden, actions: readonly DecisionAction[]): void {
  const profile = cw.profile;
  if (profile.customDuration) return;
  const lengths = actions.filter((a) => a.durationMs !== null && a.kind !== 'warning' && a.kind !== 'note');
  if (lengths.length === 0) return;
  const offered = new Set<number>([...profile.durations, ...ownLengths(profile)]);
  if (lengths.some((a) => !offered.has(a.durationMs as number))) throw new HttpError('duration_not_offered');
}

/**
 * What a scoped moderator may apply: only the kinds of `limits.kinds`, and a restriction or ban only for a length of at most `limits.maxDurationMs` (a permanent one, `durationMs: null`, never).
 * A warning or a note has no length. Never `includeIp: true`: an IP row lands on every account behind that address, in every scope, which is more than the report's person. 400 `invalid_sanction`
 * otherwise. Called after the report is known to be in scope, so an out-of-scope id is still the 404 of an unknown id.
 */
export function checkScopedLimits(actions: readonly DecisionAction[], limits: Readonly<ScopedLimits>): void {
  for (const a of actions) {
    if (a.includeIp === true) throw new HttpError('invalid_sanction');
    if (!(limits.kinds as readonly string[]).includes(a.kind)) throw new HttpError('invalid_sanction');
    if (a.kind === 'warning' || a.kind === 'note') continue;
    if (a.durationMs === null || a.durationMs > limits.maxDurationMs) throw new HttpError('invalid_sanction');
  }
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
 * decision is `replay: true` and applies nothing. `source` is who the decision is on behalf of, `moderator` unless the caller is another
 * system (the Coop callback passes `coop`); like the actor it is never from a request body.
 */
export async function applyDecision(
  cw: Chatwarden,
  reportId: string,
  decision: ParsedDecision,
  actor: string,
  ai?: { echo?: AiEchoBody; role: Role },
  source: Source = 'moderator',
  scope?: readonly string[],
): Promise<DecisionOutcome> {
  // With a staff scope an out-of-scope report is exactly an unknown one.
  const report = cw.reports.get(reportId, scope === undefined ? undefined : { scope });
  if (report === null) throw new NotFoundError();
  // The staff refs the report shows, or the ids it was filed under (the facade makes them canonical, so a ref gone
  // stale through a later merge still replays).
  const named = namedIn(report);
  if (!decision.actions.every((a) => named.has(a.subject))) throw new ValidationError();

  const result = await cw.decide({
    reportId,
    verdict: decision.verdict,
    ...(decision.evidence === undefined ? {} : { evidence: decision.evidence }),
    ...(decision.evidenceKind === undefined ? {} : { evidenceKind: decision.evidenceKind }),
    actions: decision.actions,
    // Never from the body: the caller is who the auth hook says (or the webhook's configured actor), always a moderator's.
    actor,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    source,
    // The read the moderator saw, with the caller's role for the audit row. It never changes the decision or what is answered.
    ...(ai === undefined
      ? {}
      : {
          ai: {
            role: ai.role,
            ...(ai.echo === undefined ? {} : { readId: ai.echo.readId, accepted: ai.echo.accepted }),
            ...(ai.echo?.severity === undefined ? {} : { severity: ai.echo.severity }),
          },
        }),
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

/** The facade's input for a parsed sanction: `actor` is never from a body, the source is always `moderator`. */
function sanctionInput(sanction: ParsedSanction, actor: string): SanctionInput {
  const { action, reason } = sanction;
  return {
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
  };
}

/**
 * Every refusal that needs no store, run without writing anything: the rule must be citable (400) and the core's own
 * sanction checks must pass (`SanctionError`, 400: a warning has no duration, an uncovered rule needs a gap note, ...).
 * A caller that reserves something before applying (the webhook's idempotency key) calls this first, so a request that
 * cannot succeed never takes it.
 */
export function checkSanction(cw: Chatwarden, sanction: ParsedSanction, actor: string): void {
  if (!cw.rules.isCitable(sanction.action.rule)) throw new ValidationError();
  validateSanctionInput(sanctionInput(sanction, actor));
}

/** Apply one sanction as `actor` (never from a body); the source is always `moderator`. 400 when the rule cannot be cited. */
export async function applySanction(
  cw: Chatwarden,
  sanction: ParsedSanction,
  actor: string,
  forReport?: string,
): Promise<{ groupId: string; refCode: string }> {
  checkSanction(cw, sanction, actor);
  const done = await cw.sanctions.apply(sanctionInput(sanction, actor), forReport === undefined ? undefined : { forReport });
  return { groupId: done.groupId, refCode: done.refCode };
}
