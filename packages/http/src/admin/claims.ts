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
  const { cw } = ctx;
  const holder = cw.cases.holder(person);
  if (holder === null || holder.by === c.authz.actor) return;
  if (!takeOver || !canOverrideClaims(ctx, c)) throw new ClaimedError(holder);
  c.audit('case.takeover', { type: 'person', ref: cw.people.canonical(person) }, 'required');
  const moved = cw.cases.claim(person, c.authz.actor, { takeOver: true });
  if (!moved.ok && moved.error === 'claimed') throw new ClaimedError(moved.claim);
}
