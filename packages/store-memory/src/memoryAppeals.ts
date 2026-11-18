import type { AppealRow, OverturnInput, SanctionRow, Source, Store, SubjectId } from '@chatwarden/core';
import { MemoryStore, compare } from './memoryStore.js';

// The in-memory store's appeal methods (appeals inbox), kept apart from `MemoryStore` so a bundle that never calls `withMemoryAppeals` does
// not carry them. The state lives on the store the methods are given to, created on first use; the sanction rows they read are the store's own.

/** The Store methods `withMemoryAppeals` adds. */
export type MemoryAppealMethods = Required<
  Pick<
    Store,
    | 'insertAppeal'
    | 'loadAppeal'
    | 'loadAppealByGroup'
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
    | 'listAppealsBy'
    | 'recordOverturn'
    | 'latestAutoChatStart'
    | 'overturnedTermCounts'
    | 'overturnedFilterCounts'
    | 'purgeOverturns'
  >
>;

/** A {@link MemoryStore} with the appeal methods (what `withMemoryAppeals` returns). */
export type MemoryAppealStore = MemoryStore & MemoryAppealMethods;

/** Appeals by id, and the id each sanction group's appeal has (the unique group). */
interface AppealState {
  rows: Map<string, AppealRow>;
  byGroup: Map<string, string>;
  /** The overturn rows by sanction group (migration 27's `kit_overturns`): one per group, no text. */
  overturns: Map<string, OverturnRecord>;
}

/** What an overturn keeps of its input: the person's subject id, the aliases are only for the strikes. */
interface OverturnRecord {
  groupId: string;
  at: number;
  subject: SubjectId;
  source: Source;
  termId: string | null;
  filterKey: string | null;
  reportId: string | null;
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
    return (this.ap ??= { rows: new Map(), byGroup: new Map(), overturns: new Map() });
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

  loadAppealByGroup(groupId: string): AppealRow | null {
    const s = this.appealState();
    const id = s.byGroup.get(groupId);
    const row = id === undefined ? undefined : s.rows.get(id);
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

  listAppealsBy(subjects: readonly SubjectId[], limit: number): AppealRow[] {
    const wanted = new Set(subjects);
    return [...this.appealState().rows.values()]
      .filter((r) => r.status !== 'moot' && wanted.has(r.subject))
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, pageSize(limit))
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
    patch: { status: 'upheld' | 'reduced' | 'revoked'; at: number; by: string; reason: string; replacementGroupId: string | null; clearStatement?: boolean; reasonCode?: string },
  ): boolean {
    const row = this.appealState().rows.get(id);
    if (row === undefined || row.status !== 'open') return false;
    const before = { ...row };
    // `before` has no reasonCode key when there was none: restoring must remove one the decision added.
    const hadCode = Object.hasOwn(row, 'reasonCode');
    row.status = patch.status;
    row.decidedAt = patch.at;
    row.decidedBy = patch.by;
    row.decisionReason = patch.reason;
    row.replacementGroupId = patch.replacementGroupId;
    // Left out, the row keeps no code (the key stays absent, as in a row decided before 0.2.1).
    if (patch.reasonCode !== undefined) row.reasonCode = patch.reasonCode;
    if (patch.clearStatement === true) row.statement = null;
    this.undoWith(() => {
      Object.assign(row, before);
      if (!hadCode) delete row.reasonCode;
    });
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
    // The one read that carries the report id, the term id, the revocation time and the overturn time: only a row written with a report id, only a revoked
    // group and only an overturned one has the key (the term id reads null when there is none), so every other load keeps the shape it had.
    return {
      ...this.sanctionRow(row),
      ...(row.reportId == null ? {} : { reportId: row.reportId }),
      termId: row.termId ?? null,
      ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
      ...(row.overturnedAt === null ? {} : { overturnedAt: row.overturnedAt }),
    };
  }

  // Overturns (0.2.1). Synchronous; every write is journaled, so an undone transaction undoes it, and the change token moves with it.

  recordOverturn(o: OverturnInput): boolean {
    const s = this.appealState();
    if (s.overturns.has(o.groupId)) return false;
    s.overturns.set(o.groupId, { groupId: o.groupId, at: o.at, subject: o.subject, source: o.source, termId: o.termId, filterKey: o.filterKey, reportId: o.reportId });
    this.undoWith(() => {
      s.overturns.delete(o.groupId);
    });
    // Every row of the group (the address row too).
    const marked = this.sanctions.filter((r) => r.groupId === o.groupId && r.overturnedAt === null);
    for (const r of marked) r.overturnedAt = o.at;
    if (marked.length > 0) {
      this.undoWith(() => {
        for (const r of marked) r.overturnedAt = null;
      });
    }
    // The strikes of any alias inside the window (inclusive): set aside from the tally, still shown by the blocked-messages view.
    if (o.strikes !== null) {
      const { from, to } = o.strikes;
      const aliases = new Set(o.aliases);
      const flagged = this.strikes.filter((r) => aliases.has(r.subject) && r.at >= from && r.at <= to && !this.overturnedStrikes.has(r));
      for (const r of flagged) this.overturnedStrikes.add(r);
      if (flagged.length > 0) {
        this.undoWith(() => {
          for (const r of flagged) this.overturnedStrikes.delete(r);
        });
      }
    }
    if (o.reportId !== null && !this.overturnedReports.has(o.reportId) && this.reports.some((r) => r.id === o.reportId)) {
      // The first overturn of a report keeps its time; nothing on the report record itself changes (a report read carries no overturn time, as on SQLite).
      const id = o.reportId;
      this.overturnedReports.set(id, o.at);
      this.undoWith(() => {
        this.overturnedReports.delete(id);
      });
    }
    this.bump();
    return true;
  }

  latestAutoChatStart(subjects: readonly SubjectId[]): number | null {
    const wanted = new Set(subjects);
    let latest: number | null = null;
    for (const r of this.sanctions) {
      if (r.kind !== 'chat' || r.source !== 'auto_filter' || r.targetType !== 'subject' || r.overturnedAt !== null || !wanted.has(r.value)) continue;
      if (latest === null || r.startsAt > latest) latest = r.startsAt;
    }
    return latest;
  }

  overturnedTermCounts(since: number): Array<{ termId: string; overturned: number; lastAt: number }> {
    const by = new Map<string, { termId: string; overturned: number; lastAt: number }>();
    for (const r of this.appealState().overturns.values()) {
      if (r.termId === null || r.at < since) continue;
      const c = by.get(r.termId) ?? { termId: r.termId, overturned: 0, lastAt: r.at };
      c.overturned += 1;
      c.lastAt = Math.max(c.lastAt, r.at);
      by.set(r.termId, c);
    }
    return [...by.values()].sort((a, b) => compare(a.termId, b.termId));
  }

  overturnedFilterCounts(since: number): Array<{ filterKey: string; overturned: number }> {
    const by = new Map<string, number>();
    for (const r of this.appealState().overturns.values()) {
      if (r.filterKey === null || r.at < since) continue;
      by.set(r.filterKey, (by.get(r.filterKey) ?? 0) + 1);
    }
    return [...by].sort((a, b) => compare(a[0], b[0])).map(([filterKey, overturned]) => ({ filterKey, overturned }));
  }

  purgeOverturns(before: number): number {
    const s = this.appealState();
    // A group decided from a report under an open legal hold keeps its overturn, as it keeps its appeal.
    const heldGroups = this.heldGroupIds();
    const gone = [...s.overturns.values()].filter((r) => r.at < before && !heldGroups.has(r.groupId));
    if (gone.length === 0) return 0;
    this.dropOverturns(s, gone);
    this.bump();
    return gone.length;
  }

  clearAppealStatements(before: number): number {
    const cleared: Array<{ row: AppealRow; statement: string }> = [];
    const heldGroups = this.heldGroupIds();
    for (const r of this.appealState().rows.values()) {
      if (r.status === 'open' || r.decidedAt === null || r.decidedAt >= before || r.statement === null || heldGroups.has(r.groupId)) continue;
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
    const heldGroups = this.heldGroupIds();
    for (const r of s.rows.values()) {
      if (r.status === 'open' || r.decidedAt === null || r.decidedAt >= before || heldGroups.has(r.groupId)) continue;
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

  // Privacy (0.2.0): `MemoryStore.eraseSubjects` and `exportSubjects` call these when the wrapper is present. Not part of the Store interface.

  /** Delete the appeals of the set, except those on a sanction group in `keepGroups` (a hold protects it). Returns how many. */
  privacyEraseAppeals(set: ReadonlySet<string>, keepGroups: ReadonlySet<string>): number {
    if (this.ap === undefined) return 0;
    const s = this.ap;
    const keep = [...s.rows.values()].filter((r) => !set.has(r.subject) || keepGroups.has(r.groupId));
    const n = s.rows.size - keep.length;
    if (n === 0) return 0;
    const next: AppealState = { rows: new Map(keep.map((r) => [r.id, r])), byGroup: new Map(keep.map((r) => [r.groupId, r.id])), overturns: s.overturns };
    const before = this.ap;
    this.ap = next;
    this.undoWith(() => {
      this.ap = before;
    });
    return n;
  }

  /**
   * Delete the overturn records of the set, except those of a sanction group in `keepGroups` (a hold protects it). They belong to the appeals counted above, so
   * the count is not returned.
   */
  privacyEraseOverturns(set: ReadonlySet<string>, keepGroups: ReadonlySet<string>): void {
    const s = this.ap;
    if (s === undefined) return;
    const gone = [...s.overturns.values()].filter((r) => set.has(r.subject) && !keepGroups.has(r.groupId));
    if (gone.length === 0) return;
    this.dropOverturns(s, gone);
  }

  /** Delete overturn records, journaled so an undo puts the whole map back in its first order (a deleted key re-added would go to the end). */
  private dropOverturns(s: AppealState, gone: readonly OverturnRecord[]): void {
    const before = [...s.overturns];
    for (const r of gone) s.overturns.delete(r.groupId);
    this.undoWith(() => {
      s.overturns.clear();
      for (const [k, v] of before) s.overturns.set(k, v);
    });
  }

  /** An overturn record that cited a deleted report no longer does. */
  privacyUnlinkOverturnReports(reportIds: ReadonlySet<string>): void {
    for (const rec of this.ap?.overturns.values() ?? []) {
      if (rec.reportId === null || !reportIds.has(rec.reportId)) continue;
      const before = rec.reportId;
      rec.reportId = null;
      this.undoWith(() => {
        rec.reportId = before;
      });
    }
  }

  /** An appeal that cited a deleted report no longer does. */
  privacyUnlinkAppealReports(reportIds: ReadonlySet<string>): void {
    for (const row of this.ap?.rows.values() ?? []) {
      if (row.reportId === null || !reportIds.has(row.reportId)) continue;
      const before = row.reportId;
      row.reportId = null;
      this.undoWith(() => {
        row.reportId = before;
      });
    }
  }

  /** Add the ids of `wanted` that an appeal or an overturn record names (the identity age-out). */
  privacyNamedByAppeals(wanted: ReadonlySet<string>, into: Set<string>): void {
    for (const row of this.ap?.rows.values() ?? []) if (wanted.has(row.subject)) into.add(row.subject);
    for (const rec of this.ap?.overturns.values() ?? []) if (wanted.has(rec.subject)) into.add(rec.subject);
  }

  /** The appeals of the set, newest first (time, then id, descending): the export's appeals. */
  privacyExportAppeals(set: ReadonlySet<string>): Array<AppealRow & { overturnedAt: number | null }> {
    return [...(this.ap?.rows.values() ?? [])]
      .filter((r) => set.has(r.subject))
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .map((r) => ({ ...structuredClone(r), overturnedAt: this.ap?.overturns.get(r.groupId)?.at ?? null }));
  }
}

/**
 * Give a {@link MemoryStore} the optional appeal methods (`insertAppeal`, `decideAppeal`, the counts by rule and the rest), so a kit with
 * `appeals.enabled` can use it. Returns the same store. `createMemoryStore()` does not carry them, so an app that never turns appeals on
 * does not bundle them. A method the store already has (a subclass's override) is left as it is, and calling this twice changes nothing.
 */
export function withMemoryAppeals<S extends MemoryStore>(store: S): S & MemoryAppealMethods {
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(MemoryAppeals.prototype)) {
    if (name === 'constructor' || typeof target[name] === 'function') continue;
    Object.defineProperty(target, name, { value: (MemoryAppeals.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true, enumerable: false });
  }
  return store as S & MemoryAppealMethods;
}
