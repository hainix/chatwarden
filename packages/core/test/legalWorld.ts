import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '@chatwarden/store-memory';
import type { AppealRow, NoticeRow, SanctionRow, StoredReport } from '../src/types.js';
import { NOW, world } from './reportingWorld.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';

// A kit over a full in-memory store (every wrapper) with rows written straight to the store under FIXED ids, so a bundle is byte-stable and a test can name every
// person. Used by the legal-hold, bundle, purge and privacy tests.

export { NOW, DAY } from './reportingWorld.js';

export const fullStore = () => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));

/** The people of the fixed world. The `key` and `ip` values are what the kit stores for them: they must never appear in a bundle or an export. */
export const P = {
  rep: { id: 's_gold_rep', handle: 'RepHandle', account: 'acct-rep-1', key: 'keyhash-rep-0001', ip: 'iphash-rep-0001' },
  tgt: { id: 's_gold_tgt', handle: 'TgtHandle', account: 'acct-tgt-1', key: 'keyhash-tgt-0001', ip: 'iphash-tgt-0001' },
  bys: { id: 's_gold_bys', handle: 'BysHandle', account: 'acct-bys-1', key: 'keyhash-bys-0001', ip: 'iphash-bys-0001' },
};

export async function legalWorld(over: Partial<ChatwardenOptions> = {}) {
  const store = fullStore();
  // The people exist before the kit starts, as in a restarted process: the kit loads them (and their identifiers) from the store.
  for (const p of Object.values(P)) {
    await store.saveSubject({ id: p.id, createdAt: NOW - 1000, mergedInto: null });
    await store.saveIdentifier({ subjectId: p.id, kind: 'account', value: p.account, firstSeen: NOW - 900, lastSeen: NOW - 900 });
    await store.saveIdentifier({ subjectId: p.id, kind: 'key', value: p.key, firstSeen: NOW - 900, lastSeen: NOW - 900 });
    await store.saveIdentifier({ subjectId: p.id, kind: 'ip', value: p.ip, firstSeen: NOW - 900, lastSeen: NOW - 900 });
  }
  const w = await world({ ...over }, store);
  return { ...w, store, P };
}
export type LegalWorld = Awaited<ReturnType<typeof legalWorld>>;

const line = (n: number, p: number | null, handle: string, raw: string, ts: number) => ({
  lineId: String(n),
  ts,
  seatId: p === 0 ? 'p1' : p === 1 ? 'p2' : 'p3',
  handle,
  raw,
  delivered: raw,
  blocked: false,
  audience: null,
  p,
});

/** A report by `rep` about `tgt` with three lines (one by a bystander) filed at `createdAt`. */
export function storedReport(id: string, createdAt: number, over: Partial<StoredReport> = {}): StoredReport {
  return {
    id,
    createdAt,
    roomId: `ROOM-${id}`,
    tags: { mode: 'ranked' },
    reporterSubject: P.rep.id,
    reporterSeat: 'p1',
    reporterHandle: P.rep.handle,
    targetSubject: P.tgt.id,
    targetSeat: 'p2',
    targetHandle: P.tgt.handle,
    category: 'harassment',
    reportedReason: 'harassment',
    note: 'tarvo said it twice',
    lineId: '2',
    excerpt: [
      line(1, 0, P.rep.handle, 'tarvo please stop', createdAt - 30),
      line(2, 1, P.tgt.handle, 'zorbak you vlemmo', createdAt - 20),
      line(3, 2, P.bys.handle, 'quissel not again', createdAt - 10),
    ],
    people: [P.rep.id, P.tgt.id, P.bys.id],
    status: 'open',
    ...over,
  };
}

export const sanctionRows = (groupId: string, refCode: string, reportId: string | null, at: number, over: Partial<SanctionRow> = {}): SanctionRow[] => [
  {
    id: `${groupId}-s`,
    groupId,
    refCode,
    kind: 'chat',
    targetType: 'subject',
    value: P.tgt.id,
    startsAt: at,
    endsAt: at + 3_600_000,
    reason: 'harassment of another player',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod_ann',
    source: 'moderator',
    automated: false,
    pending: false,
    reportId,
    ...over,
  },
  {
    id: `${groupId}-i`,
    groupId,
    refCode,
    kind: 'chat',
    targetType: 'ip',
    value: P.tgt.ip,
    startsAt: at,
    endsAt: at + 3_600_000,
    reason: 'harassment of another player',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod_ann',
    source: 'moderator',
    automated: false,
    pending: false,
    reportId,
    ...over,
  },
];

export const noticeRow = (id: string, groupId: string, at: number): NoticeRow => ({
  id,
  subject: P.tgt.id,
  groupId,
  kind: 'chat',
  rule: '1',
  until: at + 3_600_000,
  refCode: 'M-GOLD1',
  excerpt: [{ text: 'zorbak you vlemmo', day: '2027-01-15' }],
  createdAt: at,
  ackedAt: at + 5,
  withdrawnAt: null,
});

export const appealRow = (id: string, groupId: string, reportId: string, at: number, statement: string | null = 'drakkuun statement about the chat sanction'): AppealRow => ({
  id,
  subject: P.tgt.id,
  groupId,
  noticeId: 'n-gold',
  reportId,
  rule: '1',
  kind: 'chat',
  statement,
  status: 'upheld',
  createdAt: at + 10,
  decidedAt: at + 20,
  decidedBy: 'mod_bea',
  decisionReason: 'private decision reason fenrisk',
  replacementGroupId: null,
});

/** One report with everything a bundle reads: lines, a decision, a sanction group (with its address row), a notice, an appeal and audit rows. */
export function seedFullReport(w: LegalWorld, id: string, createdAt: number): void {
  const { store } = w;
  store.insertReport(storedReport(id, createdAt));
  store.closeReport(id, 'actioned', false, 'mod_ann', createdAt + 100, 'private moderator note glarn');
  store.insertSanctionGroup(sanctionRows(`g-${id}`, 'M-GOLD1', id, createdAt + 100));
  store.insertNotice(noticeRow(`n-${id}`, `g-${id}`, createdAt + 101));
  store.insertAppeal(appealRow(`ap-${id}`, `g-${id}`, id, createdAt + 101));
  store.insertAudit({ id: `au-r-${id}`, at: createdAt + 50, actor: 'mod_ann', role: 'moderator', action: 'report.view', target: { type: 'report', ref: id } });
  store.insertAudit({ id: `au-d-${id}`, at: createdAt + 100, actor: 'mod_ann', role: 'moderator', action: 'report.decide', target: { type: 'report', ref: id } });
  store.insertAudit({ id: `au-g-${id}`, at: createdAt + 200, actor: 'mod_bea', role: 'senior', action: 'sanction.revoke', target: { type: 'sanction', ref: `g-${id}` } });
  store.insertAudit({ id: `au-x-${id}`, at: createdAt + 300, actor: 'mod_ann', role: 'moderator', action: 'history.view', target: { type: 'person', ref: P.tgt.id } });
}
