import { MUTE_TTL_MS } from './mutes.js';
import { ProfileError } from './profile.js';
import { WEBHOOK_KEY_TTL_MS } from './types.js';
import type { Store } from './types.js';

const DAY_MS = 86_400_000;

/** How long each kind of row is kept. */
export interface RetentionPolicy {
  /** A report is deleted once it is older than this. */
  reportsMs: number;
  /** An ended or revoked sanction row is deleted this long after it ended or was revoked. */
  sanctionAfterEndMs: number;
  /** A strike (and the raw line kept with it) is deleted once it is older than this. */
  strikesMs: number;
  /**
   * A withdrawn notice, and a seen warning or report outcome, is deleted once it is older than this; so is any
   * notice whose end is this far past. A notice for a permanent or running sanction is kept while it applies.
   */
  noticesMs: number;
  /**
   * A report dismissed as bad faith is kept this long after it was actioned, even once it is past `reportsMs`: the
   * reporter's suspension counts it (see `SUSPEND_WINDOW_MS`).
   */
  badFaithMs: number;
  /** A staff audit entry is deleted once it is older than this. */
  auditMs: number;
  /**
   * An AI outcome row (the agree-or-override record: ids and counts, no chat text) is kept this long. At least 90 days. A read
   * itself goes with its report (`reportsMs`).
   */
  aiOutcomesMs: number;
  /**
   * The pseudonymised example text kept with an AI outcome is deleted once it is older than this. It is the only chat text that
   * outlives a report, so it is the shortest of the three; 0 keeps no text at all.
   */
  aiExamplesMs: number;
}

export const RETENTION_DEFAULTS: Readonly<RetentionPolicy> = {
  reportsMs: 90 * DAY_MS,
  sanctionAfterEndMs: 90 * DAY_MS,
  strikesMs: 30 * DAY_MS,
  noticesMs: 90 * DAY_MS,
  badFaithMs: 30 * DAY_MS,
  auditMs: 365 * DAY_MS,
  aiOutcomesMs: 365 * DAY_MS,
  aiExamplesMs: 180 * DAY_MS,
};

/** The ladder looks back 90 days and "My record" shows 90 days, so the rows behind them must outlive that. */
const RECORD_FLOOR_MS = 90 * DAY_MS;

const FIELDS = ['reportsMs', 'sanctionAfterEndMs', 'strikesMs', 'noticesMs', 'badFaithMs', 'auditMs', 'aiOutcomesMs', 'aiExamplesMs'] as const;

/**
 * Refuse a retention policy that would delete rows the kit still reads. Only the fields present are checked (an
 * absent one takes a default, and the defaults satisfy every floor):
 * - `sanctionAfterEndMs` at least 90 days: the ladder reads that far back
 * - `noticesMs` at least 90 days: "My record" shows that far back
 * - `badFaithMs` at least `suspendWindowMs`: a bad-faith dismissal weighs against its reporter for that long
 * - `auditMs` at least 90 days: the staff trail is how a community answers "who did that"
 * - `aiOutcomesMs` at least 90 days: the agree-or-override record is the data the AI's later gates read
 * - `aiExamplesMs` at least 0 (0 keeps no example text at all)
 *
 * Every field present must also be a finite number (`reportsMs` and `strikesMs` have no floor, only this).
 *
 * Throws {@link ProfileError} naming the field and why. Anything that is not a number at least the floor fails,
 * NaN included.
 */
export function checkRetentionFloors(policy: Partial<RetentionPolicy>, suspendWindowMs: number): void {
  // Every field present must be a finite number, whatever its floor: Infinity or NaN would make every later purge
  // throw (and so delete nothing from any table).
  for (const field of FIELDS) {
    const v: unknown = policy[field];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new ProfileError(`retention.${field}`, 'must be a finite number of milliseconds');
    }
  }
  const below = (v: unknown, floor: number): boolean => v !== undefined && !(typeof v === 'number' && v >= floor);
  if (below(policy.sanctionAfterEndMs, RECORD_FLOOR_MS)) {
    throw new ProfileError(
      'retention.sanctionAfterEndMs',
      "must be at least 90 days: the ladder looks back that far at a person's earlier actions",
    );
  }
  if (below(policy.noticesMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.noticesMs', "must be at least 90 days: players' records reach back that far");
  }
  if (below(policy.auditMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.auditMs', 'must be at least 90 days: the audit trail answers who did what, and when');
  }
  if (below(policy.aiOutcomesMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.aiOutcomesMs', 'must be at least 90 days: it is the record of how often the AI and the moderators agreed');
  }
  if (below(policy.aiExamplesMs, 0)) {
    throw new ProfileError('retention.aiExamplesMs', 'must be 0 or more: 0 keeps no example text at all');
  }
  if (below(policy.badFaithMs, suspendWindowMs)) {
    throw new ProfileError(
      'retention.badFaithMs',
      `must be at least limits.reports.suspendWindowMs (${Math.round((suspendWindowMs / DAY_MS) * 100) / 100} days): ` +
        "a report dismissed as bad faith counts toward its reporter's suspension for that long",
    );
  }
}

/** Rows deleted, per table. */
export interface PurgeResult {
  reports: number;
  sanctions: number;
  strikes: number;
  mutes: number;
  notices: number;
  audit: number;
  webhookKeys: number;
}

function checkWindow(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`purge: invalid ${name}`);
}

/**
 * Delete rows past their retention, all in one transaction (every table or none). Run it from a timer
 * or a maintenance job: it is a store call, not part of any hot path.
 *
 * - reports: `createdAt < now - reportsMs`, except a bad-faith dismissal actioned at or after `now - badFaithMs`
 *   (it still counts toward its reporter's suspension). The recorded decisions of deleted reports go with them.
 * - sanctions: ended (`endsAt < now - sanctionAfterEndMs`) or revoked (`revokedAt < now - sanctionAfterEndMs`).
 *   A warning or a note ends where it starts, so it goes `sanctionAfterEndMs` (90 days by default) after its start.
 *   A permanent, unrevoked sanction is never deleted, nor is one whose rule gap is still open.
 * - strikes: `at < now - strikesMs`
 * - audit: `at < now - auditMs` (365 days by default, never less than 90): every staff audit entry, including the
 *   term-editor rows written before the trail existed
 * - webhook keys: `createdAt < now - 24 h` (incoming-webhook idempotency keys, pending or done)
 * - mutes: `createdAt < now - 180 days`, the mute TTL (a mute past it is already ignored)
 * - notices: withdrawn, or a seen warning / report outcome, with `createdAt < now - noticesMs`; or
 *   `until < now - noticesMs`. A notice for a permanent or running sanction is kept while it applies (agrees with
 *   `NoticeService.record`), and an unseen warning is kept until it is seen or withdrawn.
 *
 * Every cutoff is strict: a row exactly on the line is kept. Subjects and terms are never touched. The in-memory
 * indexes need no update: they already ignore everything this removes.
 */
export async function purge(
  store: Store,
  now: number,
  policy: Partial<RetentionPolicy> = {},
): Promise<PurgeResult> {
  const p: RetentionPolicy = {
    reportsMs: policy.reportsMs ?? RETENTION_DEFAULTS.reportsMs,
    sanctionAfterEndMs: policy.sanctionAfterEndMs ?? RETENTION_DEFAULTS.sanctionAfterEndMs,
    strikesMs: policy.strikesMs ?? RETENTION_DEFAULTS.strikesMs,
    noticesMs: policy.noticesMs ?? RETENTION_DEFAULTS.noticesMs,
    badFaithMs: policy.badFaithMs ?? RETENTION_DEFAULTS.badFaithMs,
    auditMs: policy.auditMs ?? RETENTION_DEFAULTS.auditMs,
    aiOutcomesMs: policy.aiOutcomesMs ?? RETENTION_DEFAULTS.aiOutcomesMs,
    aiExamplesMs: policy.aiExamplesMs ?? RETENTION_DEFAULTS.aiExamplesMs,
  };
  if (!Number.isFinite(now)) throw new Error('purge: invalid now');
  checkWindow('reportsMs', p.reportsMs);
  checkWindow('sanctionAfterEndMs', p.sanctionAfterEndMs);
  checkWindow('strikesMs', p.strikesMs);
  checkWindow('noticesMs', p.noticesMs);
  checkWindow('badFaithMs', p.badFaithMs);
  checkWindow('auditMs', p.auditMs);
  checkWindow('aiOutcomesMs', p.aiOutcomesMs);
  checkWindow('aiExamplesMs', p.aiExamplesMs);
  return store.transaction(() => ({
    reports: store.purgeReports(now - p.reportsMs, now - p.badFaithMs),
    sanctions: store.purgeSanctions(now - p.sanctionAfterEndMs),
    strikes: store.purgeStrikes(now - p.strikesMs),
    mutes: store.purgeMutes(now - MUTE_TTL_MS),
    notices: store.purgeNotices(now - p.noticesMs),
    audit: store.purgeAudit(now - p.auditMs),
    webhookKeys: store.purgeWebhookKeys(now - WEBHOOK_KEY_TTL_MS),
  }));
}
