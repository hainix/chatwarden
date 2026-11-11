import type { QueueGroup } from './queue.js';
import type { Claim } from './types.js';

// Who holds a case, and what that makes of a team. Pure: the clock comes in as an argument.

/** A claim lasts this long without a heartbeat (the kit's 10 minutes). */
export const CLAIM_TTL_MS = 10 * 60_000;

/**
 * The claim if it has not lapsed. The kit's rule: a claim is live strictly before `until`. A lapse moves no change token, so the
 * screen reads `until` itself.
 * @experimental
 */
export function liveClaim(claim: Claim | null | undefined, now: number): Claim | null {
  return claim !== null && claim !== undefined && claim.until > now ? claim : null;
}

/** @experimental */
export type Holder = { kind: 'none' } | { kind: 'you'; by: string } | { kind: 'other'; by: string };

/**
 * Whether a case is free, yours, or somebody else's. Actors are compared whole and exactly.
 * @experimental
 */
export function holderOf(claim: Claim | null | undefined, me: string, now: number): Holder {
  const live = liveClaim(claim, now);
  if (live === null) return { kind: 'none' };
  return live.by === me ? { kind: 'you', by: live.by } : { kind: 'other', by: live.by };
}

/**
 * How a staff actor is shown: an email as the part before the `@`, anything else as written.
 * @experimental
 */
export function actorName(actor: string): string {
  const trimmed = actor.trim();
  const at = trimmed.indexOf('@');
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/**
 * The one character for an avatar: the first letter of the shown name, upper-cased.
 * @experimental
 */
export function actorInitial(actor: string): string {
  const first = Array.from(actorName(actor))[0];
  return first === undefined ? '?' : first.toLocaleUpperCase();
}

/**
 * One person on shift: what they hold, and how many cases they have open.
 * @experimental
 */
export interface TeamMember {
  actor: string;
  you: boolean;
  handling: number;
  viewing: number;
}

/**
 * Who is on, from what the queue shows: anyone holding or viewing a case, and you. Load, not speed: the list is ordered you
 * first, then by how much each holds, then by name, and carries no count of decisions.
 * @experimental
 */
export function teamOf(groups: readonly QueueGroup[], me: string, now: number): TeamMember[] {
  const byActor = new Map<string, TeamMember>();
  const member = (actor: string): TeamMember => {
    let m = byActor.get(actor);
    if (m === undefined) {
      m = { actor, you: actor === me, handling: 0, viewing: 0 };
      byActor.set(actor, m);
    }
    return m;
  };
  member(me);
  for (const g of groups) {
    const claim = liveClaim(g.claim, now);
    if (claim !== null) member(claim.by).handling += 1;
    for (const v of new Set(g.viewing)) member(v).viewing += 1;
  }
  return [...byActor.values()].sort(
    (a, b) => Number(b.you) - Number(a.you) || b.handling - a.handling || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0),
  );
}
