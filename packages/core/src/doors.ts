import { hashWho } from './hasher.js';
import { safeWarn } from './log.js';
import type { NoticeService } from './notices.js';
import type { ActiveSanction, SanctionIndex } from './sanctions.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Hasher, Identifiers, Logger, RawWho, SanctionKind, SubjectId } from './types.js';

/** Where a person is trying to get in. */
export type DoorKind = 'join' | 'create' | 'public' | 'matchmaking';

/**
 * What a refused door tells the caller. `until` is the end in epoch ms, or null when permanent. `refCode`
 * is the one handle the person may quote to a moderator. `noticeId` is the notice that explains the refusal, when
 * there is one (the id the client passes to its notice view). No reason, identifier, hash or subject id.
 */
export interface DoorRefusal {
  kind: 'ban' | 'area';
  until: number | null;
  refCode: string;
  noticeId?: string;
}

export interface DoorServiceDeps {
  hasher: Hasher;
  subjects: SubjectIndex;
  sanctions: SanctionIndex;
  clock: Clock;
  logger?: Logger;
  /**
   * Looks up the notice that explains a refusal. Optional: without it a refusal never carries a `noticeId`. A
   * failed lookup is logged and the extra field is left out; the door still refuses.
   */
  notices?: NoticeService;
}

/** Joining or creating a private room: only a full ban closes these. Public rooms and matchmaking add area bans. */
const KINDS_FOR: Record<DoorKind, readonly SanctionKind[]> = {
  join: ['ban'],
  create: ['ban'],
  public: ['area', 'ban'],
  matchmaking: ['area', 'ban'],
};

interface Found {
  kind: 'ban' | 'area';
  active: ActiveSanction;
  subject: SubjectId | null;
}

/** Permanent beats timed, otherwise the later end; on a tie the ban (the stronger kind) is reported. */
function outlasts(a: Found, b: Found): boolean {
  const x = a.active.until;
  const y = b.active.until;
  if (x === null || y === null) {
    if (x === y) return a.kind === 'ban' && b.kind !== 'ban';
    return x === null;
  }
  if (x !== y) return x > y;
  return a.kind === 'ban' && b.kind !== 'ban';
}

/**
 * The checks at the doors: joining or creating a room, public rooms, matchmaking.
 *
 * A check reads the live {@link SanctionIndex}; it never touches the store. It resolves the caller with
 * {@link SubjectIndex.lookup}, which neither creates a subject nor links or merges identities (linking
 * happens when the adopter seats the person). A key and an account that are not linked yet are each
 * checked, so a sanction on either still applies; the address is matched only by the short-lived IP
 * row of a sanction. Any internal failure lets the caller through: a broken moderation layer must never
 * lock people out of the game. The failure is logged (event and error class only) and never thrown.
 */
export class DoorService {
  private readonly hasher: Hasher;
  private readonly subjects: SubjectIndex;
  private readonly sanctions: SanctionIndex;
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly notices: NoticeService | undefined;

  constructor(deps: DoorServiceDeps) {
    this.hasher = deps.hasher;
    this.subjects = deps.subjects;
    this.sanctions = deps.sanctions;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.notices = deps.notices;
  }

  /**
   * Null lets the caller through. `join` and `create` refuse a ban only; `public` and `matchmaking` refuse
   * an area ban or a ban, the longest winning. Never throws and never returns an identifier.
   */
  check(kind: DoorKind, who: RawWho): DoorRefusal | null {
    try {
      const kinds = KINDS_FOR[kind] as readonly SanctionKind[] | undefined;
      if (kinds === undefined) throw new Error('doors: unknown door');
      const ids = hashWho(this.hasher, who);
      const now = this.clock.now();

      const subjects = new Set<SubjectId>();
      for (const part of [
        { clientKey: ids.clientKey, accountId: null, ipHash: null },
        { clientKey: null, accountId: ids.accountId, ipHash: null },
      ] satisfies Identifiers[]) {
        const s = this.subjects.lookup(part);
        if (s !== null) subjects.add(s);
      }

      let best: Found | null = null;
      for (const subject of subjects.size > 0 ? subjects : [null]) {
        for (const k of kinds) {
          const active = this.sanctions.active(k, ids, subject, now);
          if (active === null) continue;
          const found: Found = { kind: k === 'ban' ? 'ban' : 'area', active, subject };
          if (best === null || outlasts(found, best)) best = found;
        }
      }
      const hit = best as Found | null;
      if (hit === null) return null;
      const refusal: DoorRefusal = { kind: hit.kind, until: hit.active.until, refCode: hit.active.refCode };
      const noticeId = this.noticeId(hit.active.groupId, hit.subject);
      if (noticeId !== null) refusal.noticeId = noticeId;
      return refusal;
    } catch (err) {
      this.logFailure(err);
      return null;
    }
  }

  /** The notice that explains a refusal, or null. Never throws: a broken lookup only drops the extra field. */
  private noticeId(groupId: string, subject: SubjectId | null): string | null {
    if (this.notices === undefined) return null;
    try {
      return this.notices.noticeIdForGroup(groupId, subject);
    } catch (err) {
      safeWarn(this.logger, 'doors.notice_lookup_failed', { error: err instanceof Error ? err.name : typeof err });
      return null;
    }
  }

  private logFailure(err: unknown): void {
    safeWarn(this.logger, 'doors.check_failed', { error: err instanceof Error ? err.name : typeof err });
  }
}
