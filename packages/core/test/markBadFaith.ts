import type { MemoryStore, StoredReportRow } from '@chatwarden/store-memory';

/**
 * Test helper: mark a stored report as a bad-faith dismissal, actioned at `actionedAt` (null = never closed, a state
 * `closeReport` cannot produce). It reaches into the store's rows, so it stays in the tests and out of the shipped
 * `MemoryStore`.
 */
export function markReportBadFaith(store: MemoryStore, id: string, actionedAt: number | null): void {
  const reports = (store as unknown as { reports: StoredReportRow[] }).reports;
  const r = reports.find((x) => x.id === id);
  if (!r) throw new Error('unknown report');
  r.badFaith = true;
  r.actionedAt = actionedAt;
  r.actionedBy = 'test';
  r.status = 'dismissed';
}
