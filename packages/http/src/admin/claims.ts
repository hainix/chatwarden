import type { Chatwarden } from '@chatwarden/core';
import { ClaimedError } from '../errors.js';
import { roleAtLeast } from '../permissions.js';
import type { AdminCall, AdminContext } from './context.js';

// What a decision or a direct sanction does about another moderator's claim on the person. A claim is a soft lock: it
// stops a second moderator acting by accident, and a senior can take the case over, on the record.

/** True when this caller's role holds `claims.override` under the effective permission table. */
export const canOverrideClaims = (ctx: AdminContext, c: AdminCall): boolean =>
  roleAtLeast(c.authz.role, ctx.permissions['claims.override']);

/**
 * Let the caller act on `person`, or refuse with 409 `claimed` (`{ by, until }`). Passes when nobody holds a live claim,
 * the caller does, or `takeOver` is asked for and the caller holds `claims.override`: then the claim moves to the caller
 * and the takeover is audited as `case.takeover` on the person. The audit row is written FIRST and in `required` mode, so
 * a takeover that cannot be recorded does not happen (500, the claim untouched). A takeover that finds no open case left
 * (the last report closed meanwhile) has nothing to move and simply goes on.
 */
export function gateCase(ctx: AdminContext, c: AdminCall, person: string, takeOver: boolean): void {
  gateClaim(ctx.cw, person, c.authz.actor, takeOver, canOverrideClaims(ctx, c), () =>
    c.audit('case.takeover', { type: 'person', ref: ctx.cw.people.canonical(person) }, 'required'),
  );
}

/**
 * The claim gate with its inputs spelled out, for a caller that has no admin call (`decideAs`, which the Discord bot and the Coop callback
 * share with the staff route): the same rule as {@link gateCase}. `canOverride` is whether the actor's role holds `claims.override`;
 * `auditTakeover` is called, and must not return if the row could not be recorded (it throws), BEFORE the claim moves.
 */
export function gateClaim(
  cw: Chatwarden,
  person: string,
  actor: string,
  takeOver: boolean,
  canOverride: boolean,
  auditTakeover: () => void,
): void {
  const holder = cw.cases.holder(person);
  if (holder === null || holder.by === actor) return;
  if (!takeOver || !canOverride) throw new ClaimedError(holder);
  auditTakeover();
  const moved = cw.cases.claim(person, actor, { takeOver: true });
  if (!moved.ok && moved.error === 'claimed') throw new ClaimedError(moved.claim);
}
