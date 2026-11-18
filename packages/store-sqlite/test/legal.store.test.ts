import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { HoldRow } from '@chatwarden/core';
import { AI_ACTION_NOTES_SQL, AI_ACTION_PURGE_SQL } from '../src/sqliteStore.js';
import { openStore } from '../src/index.js';
import * as P from '../src/privacy.js';

// The legal-hold contract (test/contract/legal.contract.ts) runs against SqliteStore from contract.test.ts. This file adds what only SQLite can show: the
// statements read the open-hold index, the purge statements keep their own indexes, a hold is a row the CHECK guards, and a purge cannot be told to forget one.

const NOW = 1_800_000_000_000;
const hold = (reportId: string, over: Partial<HoldRow> = {}): HoldRow => ({ reportId, code: 'legal_proceeding', heldBy: 'senior_a', heldAt: NOW, releasedBy: null, releasedAt: null, ...over });

const plan = (db: DatabaseSync, sql: string): string => {
  const n = (sql.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length;
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(1)).map((r) => String(r.detail)).join(' | ');
};

describe('EXPLAIN QUERY PLAN: purge uses the held index; the purge statements still use their own indexes', () => {
  const db = new DatabaseSync(':memory:');
  openStore({ db });
  const H = P.HELD_REPORT_IDS;
  const G = P.HELD_GROUP_IDS;

  it('every purge statement finds the open holds through kit_legal_holds_open', () => {
    const statements: Record<string, string> = {
      reports: `DELETE FROM kit_reports WHERE created_at < ? AND NOT (bad_faith = 1 AND actioned_at IS NOT NULL AND actioned_at >= ?) AND id NOT IN ${H}`,
      sanctions: `DELETE FROM kit_sanctions WHERE ((ends_at IS NOT NULL AND ends_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)) AND group_id NOT IN ${G}`,
      audit: `DELETE FROM kit_audit WHERE at < ? AND NOT (subject_type = 'report' AND subject_ref IN ${H}) AND NOT (subject_type = 'sanction' AND subject_ref IN ${G})`,
      outcomes: `DELETE FROM kit_ai_outcomes WHERE decided_at < ? AND report_id NOT IN ${H}`,
      actions: AI_ACTION_PURGE_SQL,
      notes: AI_ACTION_NOTES_SQL,
      list: P.HOLD_LIST_SQL,
      groups: P.HELD_SET_GROUPS_SQL,
    };
    for (const [k, sql] of Object.entries(statements)) expect(plan(db, sql), k).toContain('kit_legal_holds_open');
  });

  it('the group subselect reads the sanctions by report (the block 5 index), not a scan', () => {
    expect(plan(db, P.HELD_SET_GROUPS_SQL)).toContain('kit_sanctions_by_report');
  });

  it('the report, AI action and audit purges keep their own range indexes', () => {
    expect(plan(db, `DELETE FROM kit_reports WHERE created_at < ? AND NOT (bad_faith = 1 AND actioned_at IS NOT NULL AND actioned_at >= ?) AND id NOT IN ${H}`)).toContain('kit_reports_by_created');
    expect(plan(db, AI_ACTION_PURGE_SQL)).toContain('kit_ai_actions_by_created');
    expect(plan(db, `DELETE FROM kit_audit WHERE at < ? AND NOT (subject_type = 'report' AND subject_ref IN ${H})`)).toContain('kit_audit_by_at');
  });
});

describe('a hold is a row', () => {
  it('only a code of the closed list is accepted by the table (no free text can be stored)', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const ins = db.prepare("INSERT INTO kit_legal_holds (report_id, code, held_by, held_at) VALUES (?, ?, 'senior_a', 1)");
    for (const code of ['law_enforcement_request', 'legal_proceeding', 'platform_request', 'safety_review', 'other']) ins.run(`r-${code}`, code);
    expect(() => ins.run('r-bad', 'because I said so')).toThrow();
  });

  it('placing, releasing and re-placing are single statements with exactly the placeholders they bind', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.placeHold(hold('r1'))).toBe(true);
    expect(store.placeHold(hold('r1'))).toBe(false);
    expect(store.releaseHold('r1', 'owner_a', NOW + 1)).toBe(true);
    expect(store.releaseHold('r1', 'owner_a', NOW + 2)).toBe(false);
    expect(store.placeHold(hold('r1', { code: 'other', heldAt: NOW + 3 }))).toBe(true);
    expect(store.loadHold('r1')).toEqual(hold('r1', { code: 'other', heldAt: NOW + 3 }));
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM kit_legal_holds').get()?.n)).toBe(1);
  });

  it('a purge cannot be told to forget a hold: a late cut still keeps the held report, and the open-hold subselect is part of every statement', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertReport({
      id: 'rA', createdAt: 1, roomId: 'R', tags: {}, reporterSubject: 's_r', reporterSeat: 'p1', reporterHandle: 'R', targetSubject: 's_t', targetSeat: 'p2', targetHandle: 'T',
      category: 'harassment', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    });
    store.placeHold(hold('rA'));
    expect(store.purgeReports(Number.MAX_SAFE_INTEGER, 0)).toBe(0);
    expect(store.loadReport('rA')).not.toBeNull();
    store.releaseHold('rA', 'o', NOW);
    expect(store.purgeReports(Number.MAX_SAFE_INTEGER, 0)).toBe(1);
  });
});

// The same bundle bytes from both stores: the canonical text of a bundle built over SQLite equals the one built over the in-memory store from the same rows.
describe('the bundle is byte-identical in memory and in sqlite', () => {
  it('the same rows give the same canonical bytes and the same signature', async () => {
    const { createChatwarden, canonicalJson, verifyBundle } = await import('@chatwarden/core');
    const { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } = await import('@chatwarden/store-memory');
    const SECRET = 'parity-secret-parity-secret-parity-32';
    const T = NOW - 86_400_000;
    const build = async (store: ReturnType<typeof openStore>) => {
      for (const id of ['s_rep', 's_tgt']) await store.saveSubject({ id, createdAt: T - 1000, mergedInto: null });
      await store.saveIdentifier({ subjectId: 's_tgt', kind: 'account', value: 'acct-tgt', firstSeen: T, lastSeen: T });
      store.insertReport({
        id: 'r1', createdAt: T, roomId: 'R1', tags: { mode: 'ranked' }, reporterSubject: 's_rep', reporterSeat: 'p1', reporterHandle: 'Rep', targetSubject: 's_tgt', targetSeat: 'p2', targetHandle: 'Tgt',
        category: 'harassment', reportedReason: 'harassment', note: 'a note', lineId: '1',
        excerpt: [{ lineId: '1', ts: T - 5, seatId: 'p2', handle: 'Tgt', raw: 'zorbak line', delivered: 'zorbak line', blocked: false, audience: null, p: 1 }],
        people: ['s_rep', 's_tgt'], status: 'open',
      });
      store.closeReport('r1', 'actioned', false, 'mod_a', T + 100, 'private');
      store.insertSanctionGroup([
        { id: 'a', groupId: 'g1', refCode: 'M-AAAAA', kind: 'chat', targetType: 'subject', value: 's_tgt', startsAt: T + 100, endsAt: T + 5000, reason: 'why', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod_a', source: 'moderator', automated: false, pending: false, reportId: 'r1' },
        { id: 'b', groupId: 'g1', refCode: 'M-AAAAA', kind: 'chat', targetType: 'ip', value: 'iphash', startsAt: T + 100, endsAt: T + 5000, reason: 'why', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod_a', source: 'moderator', automated: false, pending: false, reportId: 'r1' },
      ]);
      store.insertNotice({ id: 'n1', subject: 's_tgt', groupId: 'g1', kind: 'chat', rule: '1', until: T + 5000, refCode: 'M-AAAAA', excerpt: [], createdAt: T + 101, ackedAt: null, withdrawnAt: null });
      store.insertAppeal?.({ id: 'ap1', subject: 's_tgt', groupId: 'g1', noticeId: 'n1', reportId: 'r1', rule: '1', kind: 'chat', statement: 'stmt', status: 'open', createdAt: T + 200, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
      store.insertAudit({ id: 'au1', at: T + 50, actor: 'mod_a', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'r1' } });
      store.insertAudit({ id: 'au2', at: T + 300, actor: 'mod_b', role: 'senior', action: 'sanction.revoke', target: { type: 'sanction', ref: 'g1' } });
    };
    const bundleOver = async (store: ReturnType<typeof openStore>) => {
      await build(store);
      const clock = { now: () => NOW };
      const cw = await createChatwarden({ store, secret: 's', platform: { identify: () => ({}) }, clock, retention: false, bundleSecret: SECRET });
      await cw.legal.hold('r1', { code: 'other', actor: 'senior_a' });
      const b = await cw.legal.bundle('r1', { actor: 'owner_a', includeAccounts: true });
      await cw.close();
      return b;
    };
    const a = await bundleOver(withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore()))))) as never);
    const b = await bundleOver(openStore({ db: new DatabaseSync(':memory:') }));
    if ('ok' in a || 'ok' in b) throw new Error('expected bundles');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(verifyBundle(b, SECRET)).toEqual({ sha256: true, hmac: true });
    expect(b.sanctions.length).toBe(1);
    expect(b.appeals.length).toBe(1);
    expect(b.audit.length).toBe(2);
  });
});
