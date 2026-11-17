import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ErasePlan, Store } from '@chatwarden/core';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '@chatwarden/store-memory';
import { seedWorld } from '../../../test/contract/privacy.contract.js';
import type { WorldOptions } from '../../../test/contract/privacy.contract.js';
import { openStore } from '../src/index.js';
import * as P from '../src/privacy.js';

// SQLite is the reference store: the privacy contract (test/contract/privacy.contract.ts) runs against it from contract.test.ts. This file adds what only
// SQLite can show: the differential against the in-memory store (the same script gives the same counts and the same export), one prepared statement per
// category with the indexes the lookups need, and that a failing erase leaves the database as it was.

const NOW = 1_800_000_000_000;
const sql = (): { store: Store; db: DatabaseSync } => {
  const db = new DatabaseSync(':memory:');
  return { store: openStore({ db }), db };
};
const mem = (): Store => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));
const plan = (over: Partial<ErasePlan> = {}): ErasePlan => ({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_diff', at: NOW, ...over });

const variants: Array<[string, WorldOptions, Partial<ErasePlan>]> = [
  ['none', {}, {}],
  ['none with a ban', { ban: true }, {}],
  ['safety', {}, { mode: 'safety' }],
  ['safety with a ban in force', { ban: true }, { mode: 'safety' }],
  ['safety with a ban and a held report', { ban: true, held: true }, { mode: 'safety', heldReportIds: new Set(['rHeld']) }],
  ['none with a held report', { held: true }, { heldReportIds: new Set(['rHeld']) }],
  ['the alias only', {}, { subjects: ['s_pp2'] }],
  ['the other person', { ban: true }, { subjects: ['s_qq'] }],
  ['a dry run', { ban: true }, { dryRun: true, mode: 'safety' }],
];

describe('the differential script gives the same counts in memory and sqlite', () => {
  it.each(variants)('%s', async (_name, world, over) => {
    const a = mem();
    const b = sql().store;
    await seedWorld(a, world);
    await seedWorld(b, world);
    expect(b.exportSubjects(['s_pp'])).toEqual(a.exportSubjects(['s_pp']));
    expect(b.exportSubjects(['s_qq'])).toEqual(a.exportSubjects(['s_qq']));
    expect(b.eraseSubjects(plan(over))).toEqual(a.eraseSubjects(plan(over)));
    expect(b.erasureEpoch()).toBe(a.erasureEpoch());
    for (const id of ['rAbout', 'rFiled', 'rThird', 'rFilter', 'rHeld']) expect(b.loadReport(id), id).toEqual(a.loadReport(id));
    expect(b.loadSanctions(NOW).map((r) => [r.groupId, r.targetType, r.value, r.reportId ?? null])).toEqual(a.loadSanctions(NOW).map((r) => [r.groupId, r.targetType, r.value, r.reportId ?? null]));
    expect(b.loadNotices(['s_pp', 's_pp2', 's_qq']).map((n) => [n.id, n.excerpt])).toEqual(a.loadNotices(['s_pp', 's_pp2', 's_qq']).map((n) => [n.id, n.excerpt]));
    expect(b.listAudit({ limit: 50 })).toEqual(a.listAudit({ limit: 50 }));
    expect((await b.loadSubjects()).subjects).toEqual((await a.loadSubjects()).subjects);
    expect((await b.loadSubjects()).ids).toEqual((await a.loadSubjects()).ids);
  });
});

describe('one prepared statement per category, with the indexes the lookups need', () => {
  const names = Object.keys(P).filter((k) => k.endsWith('_SQL'));
  const plans = (): Map<string, string> => {
    const { db } = sql();
    const out = new Map<string, string>();
    for (const k of names) {
      const text = (P as unknown as Record<string, string>)[k]!;
      const n = (text.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length;
      out.set(k, db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...Array(n).fill('[]')).map((r) => String(r.detail)).join(' | '));
    }
    return out;
  };

  it('every statement prepares and, but for a short list, never scans a whole table by a person', () => {
    // A scan is allowed where no index can serve: the people list inside a report (json), the one appeal-by-report link, the foreign-key check of a deleted
    // subject (merged_into has no index), and a table of receipts (tiny).
    const scans = new Set(['REPORTS_NAMING_SQL', 'APPEALS_UNLINK_SQL', 'ERASURES_PURGE_SQL', 'ERASURE_INSERT_SQL', 'EPOCH_BUMP_SQL', 'SUBJECTS_DELETE_SQL']);
    for (const [k, detail] of plans()) {
      if (scans.has(k)) continue;
      expect(detail, `${k}: ${detail}`).not.toMatch(/\bSCAN kit_/);
    }
  });

  it('the four lookup indexes of block 5 are the ones used', () => {
    const p = plans();
    expect(p.get('MUTES_DELETE_SQL')).toContain('kit_mutes_by_target');
    expect(p.get('BLOCKED_NAMES_DELETE_SQL')).toContain('kit_blocked_names_by_subject');
    expect(p.get('SIGNALS_DELETE_SQL')).toContain('kit_signals_by_source');
    expect(p.get('SANCTIONS_UNLINK_SQL')).toContain('kit_sanctions_by_report');
    expect(p.get('ERASURES_PENDING_SQL')).toContain('kit_erasures_pending');
  });

  it('the export never walks every account or every subject sanction', () => {
    const p = plans();
    expect(p.get('EXPORT_ACCOUNTS_SQL')).not.toContain('kit_subject_ids_by_value');
    expect(p.get('EXPORT_SANCTIONS_SQL')).not.toContain('kit_sanctions_by_start');
    expect(p.get('EXPORT_SANCTIONS_SQL')).toContain('kit_sanctions_by_target');
  });
});

describe('a failing erase leaves the database as it was', () => {
  it('a store error half way (a table that is gone) rolls the whole erase back, the epoch included', async () => {
    const { store, db } = sql();
    await seedWorld(store, { ban: true });
    const rows = (t: string): number => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n);
    const before = ['kit_reports', 'kit_strikes', 'kit_sanctions', 'kit_subjects', 'kit_notices'].map(rows);
    db.exec('DROP TABLE kit_claims');
    expect(() => store.eraseSubjects(plan())).toThrow();
    expect(['kit_reports', 'kit_strikes', 'kit_sanctions', 'kit_subjects', 'kit_notices'].map(rows)).toEqual(before);
    expect(store.erasureEpoch()).toBe(0);
  });

  it('a hostile subject id (quotes, JSON, SQL) is bound, never spliced', async () => {
    const { store } = sql();
    const evil = `s_x"]'); DROP TABLE kit_subjects; --`;
    await store.saveSubject({ id: evil, createdAt: NOW, mergedInto: null });
    await store.saveSubject({ id: 's_keep', createdAt: NOW, mergedInto: null });
    expect(store.exportSubjects([evil]).found).toBe(true);
    expect(store.eraseSubjects(plan({ subjects: [evil] })).removed.subjects).toBe(1);
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual(['s_keep']);
  });
});
