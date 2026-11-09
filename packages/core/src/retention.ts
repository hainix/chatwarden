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
}

export const RETENTION_DEFAULTS: Readonly<RetentionPolicy> = {
  reportsMs: 90 * DAY_MS,
  sanctionAfterEndMs: 90 * DAY_MS,
  strikesMs: 30 * DAY_MS,
};

/** Rows deleted, per table. */
export interface PurgeResult {
  reports: number;
  sanctions: number;
  strikes: number;
  mutes: number;
}

function checkWindow(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`purge: invalid ${name}`);
}

/**
 * Delete rows past their retention, all in one transaction (every table or none). Run it from a timer
 * or a maintenance job: it is a store call, not part of any hot path.
 *
 * - reports: `createdAt < now - reportsMs`
 * - sanctions: ended (`endsAt < now - sanctionAfterEndMs`) or revoked (`revokedAt < now - sanctionAfterEndMs`).
 *   A permanent, unrevoked sanction is never deleted.
 * - strikes: `at < now - strikesMs`
 * - mutes: `createdAt < now - 180 days`, the mute TTL (a mute past it is already ignored)
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
  };
  if (!Number.isFinite(now)) throw new Error('purge: invalid now');
  checkWindow('reportsMs', p.reportsMs);
  checkWindow('sanctionAfterEndMs', p.sanctionAfterEndMs);
  checkWindow('strikesMs', p.strikesMs);
  return store.transaction(() => ({
    reports: store.purgeReports(now - p.reportsMs),
    sanctions: store.purgeSanctions(now - p.sanctionAfterEndMs),
    strikes: store.purgeStrikes(now - p.strikesMs),
    mutes: store.purgeMutes(now - MUTE_TTL_MS),
  }));
}
