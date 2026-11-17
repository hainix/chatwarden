import type { BlockedNameRow, Store } from '@chatwarden/core';
import { MemoryStore } from './memoryStore.js';

// The in-memory store's blocked-name methods (offensive names), kept apart from `MemoryStore` so a bundle that never calls
// `withMemoryNames` does not carry them. The state lives on the store the methods are given to, created on first use.

/** The Store methods `withMemoryNames` adds. */
export type MemoryNameMethods = Required<Pick<Store, 'insertBlockedName' | 'listBlockedNames' | 'purgeBlockedNames'>>;

/** A {@link MemoryStore} with the blocked-name methods (what `withMemoryNames` returns). */
export type MemoryNameStore = MemoryStore & MemoryNameMethods;

/** The methods, on a class only so they can reach the store's own state. Never constructed: `withMemoryNames` copies them onto a store. */
class MemoryNames extends MemoryStore {
  /** Kept names in insertion order (stands in for SQLite's rowid). */
  private blocked?: BlockedNameRow[];

  // Synchronous like notices. A kept name is evidence, not a queue item, so none of these moves the change token. Each write is journaled, so
  // an undone transaction undoes it. Rows go in and come out as copies.

  insertBlockedName(row: BlockedNameRow): void {
    const rows = (this.blocked ??= []);
    if (rows.some((r) => r.id === row.id)) throw new Error('UNIQUE constraint failed: kit_blocked_names.id');
    rows.push(structuredClone(row));
    this.undoWith(() => {
      rows.length -= 1;
    });
  }

  listBlockedNames(since: number, limit: number): BlockedNameRow[] {
    const n = Math.floor(limit);
    const size = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 1;
    return (this.blocked ?? [])
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.at >= since)
      .sort((a, b) => b.r.at - a.r.at || b.i - a.i)
      .slice(0, size)
      .map(({ r }) => structuredClone(r));
  }

  purgeBlockedNames(before: number): number {
    const snapshot = this.blocked ?? [];
    const kept = snapshot.filter((r) => r.at >= before);
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.blocked = kept;
      this.undoWith(() => {
        this.blocked = snapshot;
      });
    }
    return n;
  }

  // Privacy (0.2.0): `MemoryStore.eraseSubjects` and `exportSubjects` call these when the wrapper is present. Not part of the Store interface.

  /** Delete the kept names of the set. Returns how many. */
  privacyEraseBlockedNames(set: ReadonlySet<string>): number {
    const snapshot = this.blocked ?? [];
    const kept = snapshot.filter((r) => r.subject === null || !set.has(r.subject));
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.blocked = kept;
      this.undoWith(() => {
        this.blocked = snapshot;
      });
    }
    return n;
  }

  /** Delete the kept names whose subject does not exist and `matches` (the store's stray rule). A name with no subject is never stray. Returns how many. */
  privacyPurgeStrayNames(_exists: (id: string) => boolean, matches: (subject: string, at: number) => boolean): number {
    const snapshot = this.blocked ?? [];
    const kept = snapshot.filter((r) => r.subject === null || !matches(r.subject, r.at));
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.blocked = kept;
      this.undoWith(() => {
        this.blocked = snapshot;
      });
    }
    return n;
  }

  /** The kept names of the set, newest first (time, then write order, descending): the export's names. */
  privacyExportBlockedNames(set: ReadonlySet<string>): BlockedNameRow[] {
    return (this.blocked ?? [])
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.subject !== null && set.has(r.subject))
      .sort((a, b) => b.r.at - a.r.at || b.i - a.i)
      .map(({ r }) => structuredClone(r));
  }
}

/**
 * Give a {@link MemoryStore} the optional blocked-name methods (`insertBlockedName`, `listBlockedNames`, `purgeBlockedNames`), so a kit with
 * `names.keepBlocked` can keep a blocked name as evidence. Returns the same store. `createMemoryStore()` does not carry them. A method the
 * store already has (a subclass's override) is left as it is, and calling this twice changes nothing.
 * @experimental
 */
export function withMemoryNames<S extends MemoryStore>(store: S): S & MemoryNameMethods {
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(MemoryNames.prototype)) {
    if (name === 'constructor' || typeof target[name] === 'function') continue;
    Object.defineProperty(target, name, { value: (MemoryNames.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true, enumerable: false });
  }
  return store as S & MemoryNameMethods;
}
