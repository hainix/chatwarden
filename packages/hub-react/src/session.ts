import type { HubClient } from './client.js';
import type { BlockedLine, PolicyDocs, Reason, ReporterRecord } from './types.js';

// What a moderator working through the queue would otherwise read again for every case. `GET /policy` builds three documents and
// is audited (`policy.view`), the saved reasons and the blocked lines change rarely, and a reporter's track record is the same
// for every case they appear in. Each is read once per session and kept: the rules for as long as the hub stays open, the rest
// for a few minutes. A failed read is never kept, so the next ask tries again. A decision does not refetch any of it.

/** How long a saved reason list, the blocked lines and a reporter's record are reused. */
export const SESSION_TTL_MS = 5 * 60_000;
/** The most reporters remembered at once. */
export const SESSION_REPORTERS_MAX = 200;

/**
 * What one screen hands the next without a URL (a link carries nothing but the screen, so no ref longer than the tag is ever in
 * an address): Blocked sends "add an exception for this line" or "show me this term" to Terms.
 */
export type Handoff = { kind: 'exception'; phrase: string; language: string } | { kind: 'term'; id: string };

export interface Session {
  /** The one thing waiting for the next screen, if anything. `peek` reads it, `clear` drops it (an unmount may read twice). */
  handoff: { set(h: Handoff): void; peek(): Handoff | null; clear(): void };
  /** The rules, the profile and the generated documents. Read once; kept until the hub closes. */
  policy(): Promise<PolicyDocs>;
  /** The saved reasons a moderator can use (switched-off ones left out). */
  reasons(): Promise<Reason[]>;
  /** How the reports a person filed stand. */
  reporter(ref: string): Promise<ReporterRecord>;
  /** The lines the term filter refused in the last 7 days. */
  blocked(): Promise<BlockedLine[]>;
}

interface Kept<T> {
  at: number;
  value: Promise<T>;
}

/** One answer kept for `ttl` ms (forever when null); a failed read is dropped, and only if it is still the kept one. */
function memo<T>(load: () => Promise<T>, ttl: number | null, now: () => number): () => Promise<T> {
  let kept: Kept<T> | null = null;
  return () => {
    if (kept !== null && (ttl === null || now() - kept.at < ttl)) return kept.value;
    const entry: Kept<T> = { at: now(), value: load() };
    kept = entry;
    entry.value.catch(() => {
      if (kept === entry) kept = null;
    });
    return entry.value;
  };
}

/** A session over one client. `now` is the hub's clock. */
export function createSession(client: HubClient, now: () => number): Session {
  const reporters = new Map<string, Kept<ReporterRecord>>();
  const policy = memo(() => client.policy({ format: 'markdown' }), null, now);
  const reasons = memo(async () => (await client.listReasons()).reasons.filter((r) => r.active), SESSION_TTL_MS, now);
  const blocked = memo(async () => (await client.listBlocked({ days: 7 })).items, SESSION_TTL_MS, now);
  let waiting: Handoff | null = null;

  return {
    handoff: {
      set: (h) => {
        waiting = h;
      },
      peek: () => waiting,
      clear: () => {
        waiting = null;
      },
    },
    policy,
    reasons,
    blocked,
    reporter(ref) {
      const slot = reporters.get(ref);
      if (slot !== undefined && now() - slot.at < SESSION_TTL_MS) return slot.value;
      const entry: Kept<ReporterRecord> = { at: now(), value: client.personHistory(ref, { limit: 1 }).then((h) => h.asReporter) };
      reporters.delete(ref);
      reporters.set(ref, entry);
      if (reporters.size > SESSION_REPORTERS_MAX) reporters.delete(reporters.keys().next().value as string);
      entry.value.catch(() => {
        if (reporters.get(ref) === entry) reporters.delete(ref);
      });
      return entry.value;
    },
  };
}
