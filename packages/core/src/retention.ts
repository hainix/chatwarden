import { MUTE_TTL_MS } from './mutes.js';
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
}

export const RETENTION_DEFAULTS: Readonly<RetentionPolicy> = {
  reportsMs: 90 * DAY_MS,
  sanctionAfterEndMs: 90 * DAY_MS,
  strikesMs: 30 * DAY_MS,
  noticesMs: 90 * DAY_MS,
  badFaithMs: 30 * DAY_MS,
};

/** Rows deleted, per table. */
export interface PurgeResult {
  reports: number;
  sanctions: number;
  strikes: number;
  mutes: number;
  notices: number;
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
 *   A permanent, unrevoked sanction is never deleted, nor is one whose rule gap is still open.
 * - strikes: `at < now - strikesMs`
 * - mutes: `createdAt < now - 180 days`, the mute TTL (a mute past it is already ignored)
 * - notices: withdrawn, or a seen warning / report outcome, with `createdAt < now - noticesMs`; or
 *   `until < now - noticesMs`. A notice for a permanent or running sanction is kept while it applies (agrees with
 *   `NoticeService.record`), and an unseen warning is kept until it is seen or withdrawn.
 *
 * Every cutoff is strict: a row exactly on the line is kept. Subjects, terms and the audit trail are never
 * touched. The in-memory indexes need no update: they already ignore everything this removes.
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
  };
  if (!Number.isFinite(now)) throw new Error('purge: invalid now');
  checkWindow('reportsMs', p.reportsMs);
  checkWindow('sanctionAfterEndMs', p.sanctionAfterEndMs);
  checkWindow('strikesMs', p.strikesMs);
  checkWindow('noticesMs', p.noticesMs);
  checkWindow('badFaithMs', p.badFaithMs);
  return store.transaction(() => ({
    reports: store.purgeReports(now - p.reportsMs, now - p.badFaithMs),
    sanctions: store.purgeSanctions(now - p.sanctionAfterEndMs),
    strikes: store.purgeStrikes(now - p.strikesMs),
    mutes: store.purgeMutes(now - MUTE_TTL_MS),
    notices: store.purgeNotices(now - p.noticesMs),
  }));
}
