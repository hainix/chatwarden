import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { CATEGORY_TO_RULE, REPORT_CATEGORIES } from '../src/index.js';
import type {
  ModerationProfile,
  ReportCategory,
  ReportInput,
  ReportRecord,
  ReportRefusal,
  ReportResult,
  ReporterRecord,
  StaffReport,
  Store,
  StoredReport,
} from '../src/index.js';
import { createChatwarden } from '../src/chatwarden.js';
import { PRESETS } from '../src/profile.js';
import { defaultReporting } from '../src/reporting.js';
import { world } from './reportingWorld.js';

// Compatibility: this ships as a 0.1.x patch. Code written against 0.1.1 must keep compiling and keep working. This file is compiled
// by `tsc -b packages/core/tsconfig.test.json`, so the type-level checks below are real: an old shape that stops compiling fails the
// build, and each `@ts-expect-error` is a control that something is still refused.

describe('types written against 0.1.1 still compile', () => {
  it('ReportCategory is still the union of the six old ids, and still indexes a Record of them', () => {
    const c: ReportCategory = 'disruption';
    const all: ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];
    const counts: Record<ReportCategory, number> = { harassment: 0, hate: 0, cheating: 0, spam: 0, disruption: 0, other: 0 };
    for (const k of all) counts[k] += 1;
    expect(c).toBe('disruption');
    expect(Object.values(counts)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(REPORT_CATEGORIES).toEqual(all);
    expect(CATEGORY_TO_RULE[c]).toBe(6);
    // @ts-expect-error control: it is still a closed union, so a new reason id is not a ReportCategory
    const notOne: ReportCategory = 'threat';
    expect(notOne).toBeDefined();
  });

  it('a ReportInput with a required-looking `category` still compiles; `reason` is the new way; both are optional', () => {
    const old: ReportInput = { roomId: 'r', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' };
    const oldTyped: ReportInput = { roomId: 'r', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' as ReportCategory, note: 'n', lineId: '3' };
    const next: ReportInput = { roomId: 'r', reporterSeat: 'p1', targetSeat: 'p2', reason: 'afk' };
    const bare: ReportInput = { roomId: 'r', reporterSeat: 'p1', targetSeat: 'p2' };
    const nulled: ReportInput = { roomId: 'r', reporterSeat: 'p1', targetSeat: 'p2', reason: null, category: null };
    expect([old, oldTyped, next, bare, nulled]).toHaveLength(5);
    // @ts-expect-error control: a reason is text
    const bad: ReportInput = { roomId: 'r', reporterSeat: 'p1', targetSeat: 'p2', reason: 5 };
    expect(bad).toBeDefined();
  });

  it('a StoredReport literal written for 0.1.1 (no reportedReason) is still a StoredReport and still inserts', () => {
    const legacy: StoredReport = {
      id: 'r1', createdAt: 1, roomId: 'x', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b', targetSeat: 'p2',
      targetHandle: 'B', category: 'cheating', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    };
    const store = new MemoryStore();
    expect(store.insertReport(legacy)).toBe(true);
    expect(store.loadReport('r1')).toMatchObject({ category: 'cheating', reportedReason: null, detailAt: null });
  });

  it('code reading a stored report keeps reading `category` as a ReportCategory', () => {
    const read = (r: StaffReport): number | string => CATEGORY_TO_RULE[r.category];
    const sample = { category: 'spam' } as StaffReport;
    expect(read(sample)).toBe(4);
  });

  it('a custom Store written for 0.1.1 (without the new optional methods) is still a Store', () => {
    const legacy: Omit<Store, 'addReportDetail' | 'loadReporterDecisions'> = new MemoryStore();
    const asStore: Store = legacy;
    expect(asStore).toBeDefined();
  });

  it('a custom Store whose loadReport returns a 0.1.1-shaped record (no reportedReason, no detailAt) still compiles and reads', async () => {
    // Written for 0.1.1: a ReportRecord literal with none of the new fields.
    const old: ReportRecord = {
      id: 'old', createdAt: 1, roomId: 'x', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b', targetSeat: 'p2',
      targetHandle: 'B', category: 'disruption', note: null, lineId: null, excerpt: [], people: [], status: 'open',
      badFaith: false, actionedAt: null, actionedBy: null, modNote: null, badFaithEvidence: null,
    };
    class LegacyStore extends MemoryStore {
      override loadReport(): ReportRecord | null {
        return old;
      }
    }
    const cw = await createChatwarden({ store: new LegacyStore(), secret: 'compat', platform: { identify: () => ({}) }, retention: false });
    // The staff view fills the new fields in: the category is the reason, and a StaffReport has them (required).
    const staff: StaffReport | null = cw.reports.get('old');
    expect(staff?.reportedReason).toBe('griefing');
    expect(staff?.detailAt).toBeNull();
  });

  it('a ReportResult is still handled with ok and refused; the old six refusals are still in ReportRefusal', () => {
    const old: ReportRefusal[] = ['off', 'not_player', 'self', 'suspended', 'rate', 'duplicate'];
    const describeResult = (r: ReportResult): string => (r.ok ? r.reportId : r.refused);
    expect(describeResult({ ok: false, refused: old[0]! })).toBe('off');
    expect(describeResult({ ok: true, reportId: 'x', remaining: 1 })).toBe('x');
  });

  it('a ReporterRecord reader that knew the six old fields still compiles', () => {
    const read = (r: ReporterRecord): number => r.reports + r.open + r.actioned + r.dismissed + r.badFaith;
    expect(read({ reports: 1, open: 0, actioned: 1, dismissed: 0, badFaith: 0, suspendedUntil: null, reasonMatched: 0, reasonDecided: 0 })).toBe(2);
  });

  it('a 0.1.1 profile literal (no reporting) is still a ModerationProfile and createChatwarden gives it the default reporting', async () => {
    const legacy: ModerationProfile = { ...(PRESETS.standard as ModerationProfile) };
    delete legacy.reporting;
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 'compat',
      platform: { identify: () => ({}) },
      retention: false,
      profile: legacy,
    });
    expect(cw.profile.reporting).toEqual(defaultReporting());
  });
});

describe('0.1.1 calls keep working at runtime', () => {
  it('the exact 0.1.1 report call (category only) is accepted, in a kit with no reporting settings given', async () => {
    const w = await world();
    const t = w.table();
    const res = await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'p2', category: 'disruption', note: 'throwing' });
    expect(res).toMatchObject({ ok: true, remaining: 9 });
    const staff = w.cw.reports.get((res as { reportId: string }).reportId);
    expect(staff).toMatchObject({ category: 'disruption', reportedReason: 'griefing', note: 'throwing', status: 'open' });
  });

  it('the old six refusals still come in the old order and with the old meaning', async () => {
    const w = await world();
    const t = w.table();
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'p1', category: 'spam' })).toEqual({ ok: false, refused: 'self' });
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'nobody', category: 'spam' })).toEqual({ ok: false, refused: 'not_player' });
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'p2', category: 'spam' })).toMatchObject({ ok: true });
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'p2', category: 'spam' })).toEqual({ ok: false, refused: 'duplicate' });
  });

  it('the take-next filter by category still works on the stored category', async () => {
    const w = await world();
    const a = await w.file({ reason: 'griefing' });
    const b = await w.file({ reason: 'hate' });
    expect(w.cw.cases.next('mod_1', { category: 'disruption' })?.reportId).toBe(a.id);
    expect(w.cw.cases.next('mod_2', { category: 'hate' })?.reportId).toBe(b.id);
  });
});
