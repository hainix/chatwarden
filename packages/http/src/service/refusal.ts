// What a /v1 answer says about a refusal, copied by name from what the kit returned: only the documented fields, each only when it has the right shape, so text, a seat, a subject or a
// handle that rode along on a core object can never reach the wire. Browser-safe.
import { refusalOf } from '../chat/wire.js';
import type { WireRefusal } from '../chat/wire.js';

/** The refusal of a line, a phrase or a seat (the chat wire's copier: `reason`, `until`, `byModerator`, `rule`, `noticeId`, `retryAfterMs`). Never throws; an unreadable value is `{ reason: 'unknown' }`. */
export function lineRefusal(refuse: unknown): WireRefusal {
  return refusalOf(refuse);
}

/** What a door check says about a refused person: the kind, when it ends, the code to quote to a moderator and, when there is one, the id of the notice that explains it. Nothing of the sanction behind it. */
export interface DoorAnswer {
  kind: 'ban' | 'area';
  until: number | null;
  refCode: string;
  noticeId?: string;
  /** A signed link to the appeal page for the sanction that refused them, when one can be made (0.2.1). A capability for that one notice: not to be logged. */
  appealUrl?: string;
}

/** The documented fields of a door refusal, by name. Anything else on the core object is dropped. */
export function doorRefusal(refusal: { kind: unknown; until: unknown; refCode: unknown; noticeId?: unknown; appealUrl?: unknown }): DoorAnswer {
  const out: DoorAnswer = {
    kind: refusal.kind === 'area' ? 'area' : 'ban',
    until: typeof refusal.until === 'number' && Number.isFinite(refusal.until) ? refusal.until : null,
    refCode: typeof refusal.refCode === 'string' ? refusal.refCode : '',
  };
  if (typeof refusal.noticeId === 'string' && refusal.noticeId.length > 0 && refusal.noticeId.length <= 64) out.noticeId = refusal.noticeId;
  if (typeof refusal.appealUrl === 'string' && refusal.appealUrl.length > 0 && refusal.appealUrl.length <= 2100) out.appealUrl = refusal.appealUrl;
  return out;
}
