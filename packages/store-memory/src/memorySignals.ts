import type { SignalRow, SignalSourceRow, Store, SubjectId } from '@chatwarden/core';
import { MemoryStore, compare } from './memoryStore.js';

// The in-memory store's signal methods (flood control and signals), kept apart from `MemoryStore` so a bundle that never calls
// `withMemorySignals` does not carry them. The state lives on the store the methods are given to, created on first use.

/** The Store methods `withMemorySignals` adds. */
export type MemorySignalMethods = Required<Pick<Store, 'insertSignal' | 'listSignalSources' | 'purgeSignals'>>;

/** A {@link MemoryStore} with the signal methods (what `withMemorySignals` returns). */
export type MemorySignalStore = MemoryStore & MemorySignalMethods;

/** Signal rows by their unique tuple (kind, subject, source, cap bucket), the ids in use, and the tuples of each subject. */
interface SignalState {
  rows: Map<string, SignalRow>;
  ids: Set<string>;
  bySubject: Map<SubjectId, Set<string>>;
}

/** The methods, on a class only so they can reach the store's own state. Never constructed: `withMemorySignals` copies them onto a store. */
class MemorySignals extends MemoryStore {
  private sig?: SignalState;

  // Synchronous like claims (see the Store interface). Not a queue change: they do not move the change token. Each write is
  // journaled, so an undone transaction undoes it. Rows go in and come out as copies.

  private signalState(): SignalState {
    return (this.sig ??= { rows: new Map(), ids: new Set(), bySubject: new Map() });
  }

  insertSignal(row: SignalRow): boolean {
    // SQLite is the reference: its CHECK (weight >= 0) and NOT NULL columns refuse these, and so does the SQLite store's own check of the numbers.
    if (!(Number.isFinite(row.weight) && row.weight >= 0)) throw new Error('insertSignal: weight must be a finite number, 0 or more');
    if (!Number.isFinite(row.at)) throw new Error('insertSignal: at must be a finite number');
    if (!Number.isSafeInteger(row.capBucket)) throw new Error('insertSignal: capBucket must be a whole number');
    const s = this.signalState();
    const key = JSON.stringify([row.kind, row.subject, row.sourceKey, row.capBucket]);
    if (s.rows.has(key) || s.ids.has(row.id)) return false;
    this.putSignal(key, structuredClone(row));
    this.undoWith(() => this.dropSignal(key));
    return true;
  }

  private putSignal(key: string, row: SignalRow): void {
    const s = this.signalState();
    s.rows.set(key, row);
    s.ids.add(row.id);
    let mine = s.bySubject.get(row.subject);
    if (mine === undefined) s.bySubject.set(row.subject, (mine = new Set()));
    mine.add(key);
  }

  /** Remove one signal row and its index entries. */
  private dropSignal(key: string): void {
    const s = this.signalState();
    const row = s.rows.get(key);
    if (row === undefined) return;
    s.rows.delete(key);
    s.ids.delete(row.id);
    const mine = s.bySubject.get(row.subject);
    mine?.delete(key);
    if (mine?.size === 0) s.bySubject.delete(row.subject);
  }

  listSignalSources(subjects: readonly SubjectId[], since: number): SignalSourceRow[] {
    const s = this.signalState();
    const groups = new Map<string, SignalSourceRow>();
    for (const subject of new Set(subjects)) {
      for (const key of s.bySubject.get(subject) ?? []) {
        const r = s.rows.get(key);
        if (r === undefined || r.at < since) continue;
        const group = JSON.stringify([r.subject, r.kind, r.sourceKey]);
        const g = groups.get(group);
        if (g === undefined) {
          groups.set(group, { subject: r.subject, kind: r.kind, sourceKey: r.sourceKey, bySubject: r.bySubject, weight: r.weight, firstAt: r.at, lastAt: r.at });
          continue;
        }
        if (r.weight > g.weight) g.weight = r.weight;
        if (r.at < g.firstAt) g.firstAt = r.at;
        if (r.at > g.lastAt) g.lastAt = r.at;
        // The smallest `by`, as SQL's MIN does; a null (a room or day source) is skipped by MIN, so it only shows when every row is null.
        if (r.bySubject !== null && (g.bySubject === null || r.bySubject < g.bySubject)) g.bySubject = r.bySubject;
      }
    }
    // Sorted by subject, kind and source, as the SQLite store answers.
    return [...groups.values()].sort((a, b) => compare(a.subject, b.subject) || compare(a.kind, b.kind) || compare(a.sourceKey, b.sourceKey));
  }

  purgeSignals(before: number): number {
    const s = this.signalState();
    let n = 0;
    for (const [key, row] of [...s.rows]) {
      if (row.at >= before) continue;
      this.dropSignal(key);
      this.undoWith(() => this.putSignal(key, row));
      n += 1;
    }
    return n;
  }

  // Privacy (0.2.0): `MemoryStore.eraseSubjects` and `exportSubjects` call these when the wrapper is present. Not part of the Store interface.

  /** Delete every row about the set or caused by it (`subject` or `bySubject` in the set). Returns how many. */
  privacyEraseSignals(set: ReadonlySet<string>): number {
    const s = this.signalState();
    const keep = [...s.rows].filter(([, row]) => !set.has(row.subject) && !(row.bySubject !== null && set.has(row.bySubject)));
    const n = s.rows.size - keep.length;
    if (n === 0) return 0;
    const next: SignalState = { rows: new Map(keep), ids: new Set(keep.map(([, r]) => r.id)), bySubject: new Map() };
    for (const [key, row] of keep) {
      let mine = next.bySubject.get(row.subject);
      if (mine === undefined) next.bySubject.set(row.subject, (mine = new Set()));
      mine.add(key);
    }
    const before = this.sig;
    this.sig = next;
    this.undoWith(() => {
      this.sig = before;
    });
    return n;
  }

  /** The rows ABOUT the set, newest first (time, then id, descending): the export's signals. */
  privacyExportSignals(set: ReadonlySet<string>): Array<{ at: number; kind: string }> {
    return [...this.signalState().rows.values()]
      .filter((r) => set.has(r.subject))
      .sort((a, b) => b.at - a.at || compare(b.id, a.id))
      .map((r) => ({ at: r.at, kind: r.kind }));
  }
}

/**
 * Give a {@link MemoryStore} the optional signal methods (`insertSignal`, `listSignalSources`, `purgeSignals`), so a kit that declares
 * signal kinds or feeds can use it, and `flood_triggered` is recorded. Returns the same store. `createMemoryStore()` does not carry them, so
 * an app that never records a signal does not bundle them. A method the store already has (a subclass's override) is left as it is, and
 * calling this twice changes nothing.
 * @experimental
 */
export function withMemorySignals<S extends MemoryStore>(store: S): S & MemorySignalMethods {
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(MemorySignals.prototype)) {
    if (name === 'constructor' || typeof target[name] === 'function') continue;
    Object.defineProperty(target, name, { value: (MemorySignals.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true, enumerable: false });
  }
  return store as S & MemorySignalMethods;
}
