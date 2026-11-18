import { safeWarn } from '@chatwarden/core';
import type { Chatwarden, Logger, Role, Source } from '@chatwarden/core';
import { requireRole } from '../auth.js';
import { roleAtLeast } from '../permissions.js';
import type { Permissions, PermissionKey } from '../permissions.js';
import { applyDecision, checkDurationsOffered, checkScopedLimits, needForDecision } from './apply.js';
import type { ScopedLimits } from './context.js';
import type { DecisionOutcome, ParsedDecision } from './apply.js';
import { gateClaim } from './claims.js';
import type { AiEchoBody } from './validate.js';

// The shared decision path (K5 design 6.6 step 9 and 8.4 step 9): what `POST /reports/:id/decide` does, with its inputs spelled out so the
// Discord bot and the Coop callback decide through the same checks and cannot drift from the hub. The staff route calls this; so can any
// caller that already knows who the actor is and what role and permissions it acts with. It never audits (the caller does: the hub's audit
// is best-effort after the commit, a Discord preview's is required) and never reads a body: the actor, role and source are arguments.

/** What {@link decideAs} takes. */
export type DecideAsInput = DecideAsBase & TakeOverInput;

/** A takeover is only ever asked for together with the hook that audits it, so no caller can move a claim unrecorded. */
export type TakeOverInput =
  | {
      takeOver?: false;
      /** Never called when `takeOver` is not asked for. */
      onTakeOver?: (person: string) => void;
    }
  | {
      /** With `claims: 'gate'`: take the case over from another holder. Only honoured when the role holds `claims.override` (worked out here, from `role` and `permissions`). */
      takeOver: true;
      /**
       * Called with the person, BEFORE a takeover moves the claim, for the caller to write its `case.takeover` audit row in required mode. A throw
       * stops the takeover and the decision (the claim is untouched). Never called when there is nothing to take over. Required with `takeOver`.
       */
      onTakeOver: (person: string) => void;
    };

interface DecideAsBase {
  reportId: string;
  /** A decision that has been checked for shape (`parseDecision`, or built by the caller). */
  decision: ParsedDecision;
  /** Who decides. Never from a request body. */
  actor: string;
  /** The kit role the actor acts with, checked against `permissions`. */
  role: Role;
  /** The effective permission table (the staff routes' `permissions`, validated the same way). */
  permissions: Permissions;
  /** Where the decision comes from, recorded on the sanction rows. Default `moderator`. */
  source?: Source;
  /**
   * `'gate'`: another moderator's live claim on the reported person stops the decision (409 `claimed`), as in the hub. `'ignore'`: no gate
   * (a service, such as a Coop callback, is never held up by a claim and takes none).
   */
  claims: 'gate' | 'ignore';
  /** The read the moderator saw (the hub's AI echo), for the casebook. It never changes the decision. */
  echo?: AiEchoBody;
  /** For the one line logged when ending the actor's claim fails (class only). */
  logger?: Logger;
  /**
   * A scoped moderator's staff scope and limits: the report is read through the scope (out of scope is an unknown report: 404) and the actions are held to the limits (400 `invalid_sanction`),
   * after the report is found, so the refusal never tells an out-of-scope id from an unknown one. Absent for a global caller.
   */
  scoped?: { scope: readonly string[]; limits: Readonly<ScopedLimits> };
}

/**
 * Decide a report as `actor`, in the staff route's order: the permissions the decision needs (`reports.decide`, then `sanctions.apply` and,
 * for a permanent ban, `sanctions.apply.ban_permanent`), the report read, the durations offered (an open report only), the claim gate,
 * `applyDecision` and, when this was not a replay, ending the actor's own claim on the person if that was their last open report.
 * Throws the `HttpError`s the route answers with (403, 404, 400, 409 `claimed` / `already_decided`). Nothing is audited here.
 */
export async function decideAs(cw: Chatwarden, input: DecideAsInput): Promise<DecisionOutcome> {
  const { actor, role, permissions, decision } = input;
  // A takeover without the hook that audits it would move a claim unrecorded: a programming error, refused before anything is read or written.
  if (input.takeOver === true && typeof input.onTakeOver !== 'function') throw new TypeError('decideAs: takeOver needs onTakeOver');
  // Authorization for what the decision DOES, before anything is read or written.
  const need = (permission: PermissionKey): void => void requireRole({ actor, role }, permission, permissions);
  need('reports.decide');
  needForDecision(decision.actions, need);

  // A report that is no longer open is a replay or an already_decided: a claim taken since must not turn that into a 409. The lengths on offer
  // apply to a decision that would be applied now, not to a replay or an answer of `already_decided`.
  const existing = cw.reports.get(input.reportId, input.scoped === undefined ? undefined : { scope: input.scoped.scope });
  if (input.scoped !== undefined && existing !== null) checkScopedLimits(decision.actions, input.scoped.limits);
  if (existing !== null && existing.status === 'open') checkDurationsOffered(cw, decision.actions);
  const person = existing !== null && existing.status === 'open' ? existing.targetPerson : null;
  if (person !== null && input.claims === 'gate') {
    const onTakeOver = input.onTakeOver;
    // Whether the role may take a case over is worked out here, from the same table the staff routes use, never taken from the caller.
    const canOverride = roleAtLeast(role, permissions['claims.override']);
    gateClaim(cw, person, actor, input.takeOver === true, canOverride, () => onTakeOver?.(person));
  }

  const result = await applyDecision(
    cw,
    input.reportId,
    decision,
    actor,
    { ...(input.echo === undefined ? {} : { echo: input.echo }), role },
    input.source ?? 'moderator',
    input.scoped?.scope,
  );
  // Deciding the person's last open report ends the actor's own claim; while other reports about them are open the claim is kept (one case
  // per person). Not on a replay: the actor may hold a fresh claim on the person's next report.
  // A service (`claims: 'ignore'`) holds no claim to end.
  if (person !== null && !result.replay && input.claims === 'gate') {
    try {
      cw.cases.releaseWhenDone(person, actor);
    } catch {
      safeWarn(input.logger, 'chatwarden.http_release_failed');
    }
  }
  return result;
}
