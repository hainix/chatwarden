import type { LinkRow, LinkSystem, Store } from '@chatwarden/core';
import { MemoryStore, compare } from './memoryStore.js';

// The in-memory store's link methods (`cw.links`, K5 design 5.1), kept apart from `MemoryStore` so a bundle that never calls `withMemoryLinks`
// does not carry them. The state lives on the store the methods are given to, created on first use.

/** The Store methods `withMemoryLinks` adds. */
export type MemoryLinkMethods = Required<Pick<Store, 'getLink' | 'putLink' | 'listLinks' | 'purgeLinks'>>;

/** A {@link MemoryStore} with the link methods (what `withMemoryLinks` returns). */
export type MemoryLinkStore = MemoryStore & MemoryLinkMethods;

const keyOf = (system: LinkSystem, ref: string): string => `${system}|${ref}`;

/** The methods, on a class only so they can reach the store's own state. Never constructed: `withMemoryLinks` copies them onto a store. */
class MemoryLinks extends MemoryStore {
  private links?: Map<string, LinkRow>;

  // Synchronous like notices. A link is bookkeeping, not a queue item, so none of these moves the change token. Each write is journaled, so an
  // undone transaction undoes it. Rows go in and come out as copies.

  getLink(system: LinkSystem, ref: string): LinkRow | null {
    const row = this.links?.get(keyOf(system, ref));
    return row === undefined ? null : { ...row };
  }

  putLink(row: LinkRow): void {
    const rows = (this.links ??= new Map());
    const key = keyOf(row.system, row.ref);
    const had = rows.get(key);
    rows.set(key, { system: row.system, ref: row.ref, external: row.external, state: row.state, at: row.at });
    this.undoWith(() => {
      if (had === undefined) rows.delete(key);
      else rows.set(key, had);
    });
  }

  listLinks(system: LinkSystem, q: { state?: string; limit: number }): LinkRow[] {
    const n = Math.floor(q.limit);
    const size = Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1;
    return [...(this.links?.values() ?? [])]
      .filter((r) => r.system === system && (q.state === undefined || r.state === q.state))
      .sort((a, b) => a.at - b.at || compare(a.ref, b.ref))
      .slice(0, size)
      .map((r) => ({ ...r }));
  }

  purgeLinks(before: number): number {
    const rows = this.links;
    if (rows === undefined) return 0;
    // A live row is kept whatever its age: an active EOS sanction (a lift long after the push must find it) and the EOS cursor.
    const gone = [...rows.entries()].filter(([, r]) => r.at < before && r.system !== 'eos-cursor' && !(r.system === 'eos-sanction' && r.state === 'active'));
    for (const [key] of gone) rows.delete(key);
    if (gone.length > 0) {
      this.undoWith(() => {
        for (const [key, r] of gone) rows.set(key, r);
      });
    }
    return gone.length;
  }

  // Privacy (0.2.0): `MemoryStore.eraseSubjects` calls this when the wrapper is present. Not part of the Store interface.

  /**
   * Delete the Coop links that name one of these (deleted) reports, and the EOS sanction links keyed by one of these (deleted) sanction groups (`<group id>#<hash>`).
   * An EOS report link is a hash of the report's own fields and stays. Returns how many.
   */
  privacyEraseLinks(reportIds: ReadonlySet<string>, goneGroups: ReadonlySet<string>): number {
    const rows = this.links;
    if (rows === undefined) return 0;
    const eosGroup = (ref: string): string => ref.slice(0, Math.max(0, ref.indexOf('#')));
    const keep = [...rows].filter(([, r]) => !((r.system === 'coop-report' && reportIds.has(r.ref)) || (r.system === 'eos-sanction' && goneGroups.has(eosGroup(r.ref)))));
    const n = rows.size - keep.length;
    if (n === 0) return 0;
    this.links = new Map(keep);
    this.undoWith(() => {
      this.links = rows;
    });
    return n;
  }
}

/**
 * Give a {@link MemoryStore} the optional link methods (`getLink`, `putLink`, `listLinks`, `purgeLinks`), so `cw.links` is supported and the
 * Coop and EOS adapters can keep their ids. Returns the same store. `createMemoryStore()` does not carry them. A method the store already has
 * (a subclass's override) is left as it is, and calling this twice changes nothing.
 */
export function withMemoryLinks<S extends MemoryStore>(store: S): S & MemoryLinkMethods {
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(MemoryLinks.prototype)) {
    if (name === 'constructor' || typeof target[name] === 'function') continue;
    Object.defineProperty(target, name, { value: (MemoryLinks.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true, enumerable: false });
  }
  return store as S & MemoryLinkMethods;
}
