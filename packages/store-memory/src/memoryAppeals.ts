import type { AppealRow, SanctionRow, Store, SubjectId } from '@chatwarden/core';
import { MemoryStore, compare } from './memoryStore.js';

// The in-memory store's appeal methods (appeals inbox), kept apart from `MemoryStore` so a bundle that never calls `withMemoryAppeals` does
// not carry them. The state lives on the store the methods are given to, created on first use; the sanction rows they read are the store's own.

/** The Store methods `withMemoryAppeals` adds. */
export type MemoryAppealMethods = Required<
  Pick<
    Store,
    | 'insertAppeal'
    | 'loadAppeal'
    | 'listAppeals'
    | 'countAppealsBy'
    | 'countOpenAppeals'
    | 'decideAppeal'
    | 'closeAppealsForGroup'
    | 'appealCountsByRule'
    | 'countSanctionsByRule'
    | 'loadSanctionSubjectRow'
    | 'clearAppealStatements'
    | 'purgeAppeals'
    | 'closeOrphanAppeals'
  >
>;

/** A {@link MemoryStore} with the appeal methods (what `withMemoryAppeals` returns). */
export type MemoryAppealStore = MemoryStore & MemoryAppealMethods;

/** Appeals by id, and the id each sanction group's appeal has (the unique group). */
interface AppealState {
  rows: Map<string, AppealRow>;
  byGroup: Map<string, string>;
}

/** `'uncovered'` and a null rule are one rule: the one the kit could not place. */
const ruleOf = (rule: string | null): string | null => (rule === 'uncovered' ? null : rule);

const pageSize = (limit: number): number => {
  const n = Math.floor(limit);
  return Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 1;
};

/** The methods, on a class only so they can reach the store's own state. Never constructed: `withMemoryAppeals` copies them onto a store. */
class MemoryAppeals extends MemoryStore {
  private ap?: AppealState;

  // Synchronous like claims (see the Store interface). A write that changes something moves the change token (the queue shows appeals) and
  // is journaled, so an undone transaction undoes it. Rows go in and come out as copies.

  private appealState(): AppealState {
    return (this.ap ??= { rows: new Map(), byGroup: new Map() });
  }

  insertAppeal(row: AppealRow): boolean {
    const s = this.appealState();
    if (s.rows.has(row.id) || s.byGroup.has(row.groupId)) return false;
    const copy = structuredClone(row);
    s.rows.set(copy.id, copy);
    s.byGroup.set(copy.groupId, copy.id);
    this.undoWith(() => {
      s.rows.delete(copy.id);
      s.byGroup.delete(copy.groupId);
    });
    this.bump();
    return true;
  }

  loadAppeal(id: string): AppealRow | null {
    const row = this.appealState().rows.get(id);
    return row === undefined ? null : structuredClone(row);
  }

  listAppeals(q: { status?: 'open' | 'decided' | 'all'; limit: number; after?: { createdAt: number; id: string } }): AppealRow[] {
    const status = q.status ?? 'all';
    const after = q.after;
    return [...this.appealState().rows.values()]
      .filter((r) => {
        if (r.status === 'moot') return false;
        if (status === 'open' ? r.status !== 'open' : status === 'decided' ? r.status === 'open' : false) return false;
        if (after === undefined) return true;
        return r.createdAt > after.createdAt || (r.createdAt === after.createdAt && compare(r.id, after.id) > 0);
      })
      .sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id))
      .slice(0, pageSize(q.limit))
      .map((r) => structuredClone(r));
  }

  countAppealsBy(subjects: readonly SubjectId[], since: number): { count: number; oldestAt: number | null } {
    const wanted = new Set(subjects);
    let count = 0;
    let oldestAt: number | null = null;
    for (const r of this.appealState().rows.values()) {
      if (!wanted.has(r.subject) || r.createdAt < since) continue;
      count += 1;
      if (oldestAt === null || r.createdAt < oldestAt) oldestAt = r.createdAt;
    }
    return { count, oldestAt };
  }

  countOpenAppeals(): number {
    let n = 0;
    for (const r of this.appealState().rows.values()) if (r.status === 'open') n += 1;
    return n;
  }

  decideAppeal(
    id: string,
    patch: { status: 'upheld' | 'reduced' | 'revoked'; at: number; by: string; reason: string; replacementGroupId: string | null; clearStatement?: boolean },
  ): boolean {
    const row = this.appealState().rows.get(id);
    if (row === undefined || row.status !== 'open') return false;
    const before = { ...row };
    row.status = patch.status;
    row.decidedAt = patch.at;
    row.decidedBy = patch.by;
    row.decisionReason = patch.reason;
    row.replacementGroupId = patch.replacementGroupId;
    if (patch.clearStatement === true) row.statement = null;
    this.undoWith(() => Object.assign(row, before));
    this.bump();
    return true;
  }

  closeAppealsForGroup(groupId: string, by: string, at: number, clearStatement?: boolean): number {
    const s = this.appealState();
    const id = s.byGroup.get(groupId);
    const row = id === undefined ? undefined : s.rows.get(id);
    if (row === undefined || row.status !== 'open') return 0;
    this.moot(row, by, at, clearStatement === true);
    return 1;
  }

  /** Move one open appeal to moot, journaled, and move the change token. */
  private moot(row: AppealRow, by: string, at: number, clearStatement: boolean): void {
    const before = { ...row };
    row.status = 'moot';
    row.decidedAt = at;
    row.decidedBy = by;
    if (clearStatement) row.statement = null;
    this.undoWith(() => Object.assign(row, before));
    this.bump();
  }

  closeOrphanAppeals(by: string, at: number, clearStatement?: boolean): number {
    const held = new Set<string>();
    for (const r of this.sanctions) if (r.targetType === 'subject') held.add(r.groupId);
    let n = 0;
    for (const row of this.appealState().rows.values()) {
      if (row.status !== 'open' || held.has(row.groupId)) continue;
      this.moot(row, by, at, clearStatement === true);
      n += 1;
    }
    return n;
  }

  appealCountsByRule(since: number): Array<{ rule: string | null; appealed: number; granted: number; lightened: number }> {
    const out = new Map<string | null, { rule: string | null; appealed: number; granted: number; lightened: number }>();
    for (const r of this.appealState().rows.values()) {
      if (r.createdAt < since) continue;
      const rule = ruleOf(r.rule);
      let c = out.get(rule);
      if (c === undefined) out.set(rule, (c = { rule, appealed: 0, granted: 0, lightened: 0 }));
      c.appealed += 1;
      if (r.status === 'revoked') c.granted += 1;
      else if (r.status === 'reduced') c.lightened += 1;
    }
    return [...out.values()];
  }

  countSanctionsByRule(since: number): Array<{ rule: string | null; count: number }> {
    const replacements = new Set<string>();
    for (const r of this.appealState().rows.values()) if (r.replacementGroupId !== null) replacements.add(r.replacementGroupId);
    const seen = new Set<string>();
    const out = new Map<string | null, { rule: string | null; count: number }>();
    for (const r of this.sanctions) {
      if (r.targetType !== 'subject' || r.kind === 'note' || r.startsAt < since || seen.has(r.groupId) || replacements.has(r.groupId)) continue;
      seen.add(r.groupId);
      const rule = ruleOf(r.rule);
      let c = out.get(rule);
      if (c === undefined) out.set(rule, (c = { rule, count: 0 }));
      c.count += 1;
    }
    return [...out.values()];
  }

  loadSanctionSubjectRow(groupId: string): SanctionRow | null {
    const row = this.sanctions.find((r) => r.groupId === groupId && r.targetType === 'subject');
    if (row === undefined) return null;
    // The one read that carries the report id: only a row written with one has the key, so every other load keeps the shape it had.
    return { ...this.sanctionRow(row), ...(row.reportId == null ? {} : { reportId: row.reportId }) };
  }

  clearAppealStatements(before: number): number {
    const cleared: Array<{ row: AppealRow; statement: string }> = [];
    for (const r of this.appealState().rows.values()) {
      if (r.status === 'open' || r.decidedAt === null || r.decidedAt >= before || r.statement === null) continue;
      cleared.push({ row: r, statement: r.statement });
      r.statement = null;
    }
    if (cleared.length > 0) {
      this.undoWith(() => {
        for (const c of cleared) c.row.statement = c.statement;
      });
    }
    return cleared.length;
  }

  purgeAppeals(before: number): number {
    const s = this.appealState();
    const gone: AppealRow[] = [];
    for (const r of s.rows.values()) {
      if (r.status === 'open' || r.decidedAt === null || r.decidedAt >= before) continue;
      // A decided appeal on a sanction still in force stays (no end, or an end after the cutoff): it is what stops a second appeal against it.
      const held = this.sanctions.find((x) => x.groupId === r.groupId && x.targetType === 'subject');
      if (held !== undefined && held.kind !== 'warning' && held.kind !== 'note' && held.revokedAt === null && (held.endsAt === null || held.endsAt > before)) continue;
      gone.push(r);
    }
    for (const r of gone) {
      s.rows.delete(r.id);
      s.byGroup.delete(r.groupId);
    }
    if (gone.length > 0) {
      this.undoWith(() => {
        for (const r of gone) {
          s.rows.set(r.id, r);
          s.byGroup.set(r.groupId, r.id);
        }
      });
    }
    return gone.length;
  }
}

/**
 * Give a {@link MemoryStore} the optional appeal methods (`insertAppeal`, `decideAppeal`, the counts by rule and the rest), so a kit with
 * `appeals.enabled` can use it. Returns the same store. `createMemoryStore()` does not carry them, so an app that never turns appeals on
 * does not bundle them. A method the store already has (a subclass's override) is left as it is, and calling this twice changes nothing.
 * @experimental
 */
export function withMemoryAppeals<S extends MemoryStore>(store: S): S & MemoryAppealMethods {
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(MemoryAppeals.prototype)) {
    if (name === 'constructor' || typeof target[name] === 'function') continue;
    Object.defineProperty(target, name, { value: (MemoryAppeals.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true, enumerable: false });
  }
  return store as S & MemoryAppealMethods;
}
