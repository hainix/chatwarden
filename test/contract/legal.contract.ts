import { describe, expect, it } from 'vitest';
import type { AiActionRow, AppealRow, HoldRow, NoticeRow, SanctionRow, Store, StoredReport } from '@chatwarden/core';

// The contract of legal hold on the Store (0.2.0, design section 6): `placeHold`, `releaseHold`, `loadHold`, `listHolds`, `heldSet`, and that an open hold keeps its
// rows out of EVERY purge and out of an erase, at any retention age, with or without the caller naming the report. One suite, run against every Store.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OLD = NOW - 400 * DAY;

const hold = (reportId: string, over: Partial<HoldRow> = {}): HoldRow => ({ reportId, code: 'legal_proceeding', heldBy: 'senior_a', heldAt: NOW - DAY, releasedBy: null, releasedAt: null, ...over });

const report = (id: string, target: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: OLD,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: 's_reporter',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: target,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  reportedReason: 'harassment',
  note: null,
  lineId: '1',
  excerpt: [
    { lineId: '1', ts: OLD, seatId: 'p1', handle: 'Rep', raw: 'tarvo reporter line', delivered: 'x', blocked: false, audience: null, p: 0 },
    { lineId: '2', ts: OLD, seatId: 'p2', handle: 'Tgt', raw: 'zorbak target line', delivered: 'x', blocked: false, audience: null, p: 1 },
  ],
  people: ['s_reporter', target],
  status: 'open',
  ...over,
});

const sanction = (groupId: string, refCode: string, value: string, targetType: 'subject' | 'ip', reportId: string | null): SanctionRow => ({
  id: `${groupId}-${targetType}`,
  groupId,
  refCode,
  kind: 'chat',
  targetType,
  value,
  startsAt: OLD,
  endsAt: OLD + DAY,
  reason: 'r',
  rule: '1',
  gapNote: null,
  gapStatus: null,
  roomId: null,
  actor: 'mod_a',
  source: 'moderator',
  automated: false,
  pending: false,
  reportId,
});

const notice = (id: string, subject: string, groupId: string): NoticeRow => ({
  id,
  subject,
  groupId,
  kind: 'chat',
  rule: '1',
  until: OLD + DAY,
  refCode: 'M-XXXXX',
  excerpt: [{ text: 'zorbak notice line', day: '2026-01-01' }],
  createdAt: OLD,
  ackedAt: OLD,
  withdrawnAt: OLD + 1,
});

const appeal = (id: string, subject: string, groupId: string, reportId: string): AppealRow => ({
  id,
  subject,
  groupId,
  noticeId: `n-${id}`,
  reportId,
  rule: '1',
  kind: 'chat',
  statement: 'vlemmo appeal statement',
  status: 'upheld',
  createdAt: OLD,
  decidedAt: OLD + 5,
  decidedBy: 'mod_a',
  decisionReason: null,
  replacementGroupId: null,
});

/** One report with everything that can hang on it: a decision, a sanction group (subject and address rows), a notice, an appeal, an AI read, outcome and action, and audit rows. */
async function build(s: Store, id: string, target: string): Promise<void> {
  const x = s as Required<Store>;
  await s.saveSubject({ id: target, createdAt: OLD, mergedInto: null });
  s.insertReport(report(id, target));
  s.insertDecision(`d-${id}`, id, OLD, '{"ok":true}');
  s.insertSanctionGroup([sanction(`g-${id}`, `M-${id.toUpperCase().padEnd(5, 'X').slice(0, 5)}`, target, 'subject', id), sanction(`g-${id}`, `M-${id.toUpperCase().padEnd(5, 'X').slice(0, 5)}`, `iphash-${id}`, 'ip', id)]);
  s.insertNotice(notice(`n-${id}`, target, `g-${id}`));
  x.insertAppeal(appeal(`ap-${id}`, target, `g-${id}`, id));
  const r = x.reserveAiRead({ reportId: id, inputHash: `h-${id}`, promptVersion: 1, adapter: 'fake:one' }, NOW + 60_000, OLD);
  if (!r.reserved) throw new Error('expected a reservation');
  x.completeAiRead(r.id, r.lease, {
    model: 'fake',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 1,
    latencyMs: 1,
    read: {
      severity: 'hostile',
      rule: 3,
      summary: 'a summary',
      evidence: ['L1'],
      confidence: 'high',
      injectionSuspected: false,
      recommendation: { verdict: 'upheld', severity: 'hostile', rule: 3, evidence: ['L1'] },
    },
  });
  x.insertAiOutcome({
    reportId: id,
    readId: r.id,
    decidedAt: OLD,
    level: 2,
    verdict: 'upheld',
    rule: '3',
    severity: 'hostile',
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: { verdict: true, rule: true, lines: 2, outcome: 'same', oneClick: true },
    badFaith: false,
    example: { rule: 3, severity: 'hostile', verdict: 'upheld', lines: [{ who: 'P1', text: 'zorbak example line' }] },
    aiRule: '3',
    aiSeverity: 'hostile',
    aiConfidence: 'high',
    decidedBy: 'mod_a',
    source: 'human',
  });
  const action: AiActionRow = {
    id: `act-${id}`,
    reportId: id,
    readId: r.id,
    confirmReadId: null,
    rule: '3',
    severity: 'hostile',
    state: 'shadow',
    refusedCode: null,
    notBefore: OLD,
    createdAt: OLD,
    groupId: null,
    kind: null,
    durationMs: null,
    actedAt: OLD,
    reviewDueAt: null,
    reviewedAt: null,
    reviewedBy: null,
    undoCode: null,
    undoNote: 'private undo note',
    adapter: 'fake:one',
    promptVersion: 1,
  };
  x.insertAiAction(action);
  s.insertAudit({ id: `au-r-${id}`, at: OLD, actor: 'mod_a', role: 'moderator', action: 'report.view', target: { type: 'report', ref: id } });
  s.insertAudit({ id: `au-g-${id}`, at: OLD, actor: 'mod_a', role: 'moderator', action: 'sanction.revoke', target: { type: 'sanction', ref: `g-${id}` } });
}

/** Every purge, with a cut so late that everything built by `build` is past every clock. */
function purgeEverything(s: Store): void {
  const x = s as Required<Store>;
  const late = NOW + 1000 * DAY;
  s.purgeReports(late, 0);
  s.purgeSanctions(late);
  s.purgeNotices(late, { appealBefore: late, renameBefore: late });
  x.clearAppealStatements(late);
  x.purgeAppeals(late);
  x.purgeAi(late, late, late);
  x.purgeAiActions(late, late);
  s.purgeAudit(late);
}

const state = (s: Store, id: string) => {
  const x = s as Required<Store>;
  return {
    report: s.loadReport(id) !== null,
    decision: s.findDecision(`d-${id}`) !== null,
    sanctionRows: s.loadSubjectActions(0).filter((r) => r.groupId === `g-${id}`).length + s.loadSanctions(0).filter((r) => r.groupId === `g-${id}` && r.targetType === 'ip').length,
    notice: s.findNoticeForGroup(`g-${id}`) !== null || s.loadNotices([id === 'rA' ? 's_a' : 's_b']).length > 0,
    appeal: x.loadAppeal(`ap-${id}`) !== null,
    read: x.loadAiRead(id) !== null,
    outcome: x.loadAiOutcome(id) !== null,
    action: x.loadAiAction(id) !== null,
    audit: s.listAudit({ limit: 50 }).filter((r) => r.id.endsWith(`-${id}`)).length,
  };
};

export function legalContract(name: string, make: () => Store): void {
  describe(`legal contract: ${name}`, () => {
    describe('the hold rows', () => {
      it('placeHold places one hold per report; a second is refused; the first is kept as it was', () => {
        const s = make();
        expect(s.placeHold(hold('r1'))).toBe(true);
        expect(s.placeHold(hold('r1', { code: 'other', heldBy: 'senior_b', heldAt: NOW }))).toBe(false);
        expect(s.loadHold('r1')).toEqual(hold('r1'));
        expect(s.loadHold('nope')).toBeNull();
      });

      it('releaseHold releases an open hold once, by whoever asks; the row stays with its release', () => {
        const s = make();
        s.placeHold(hold('r1'));
        expect(s.releaseHold('r1', 'owner_a', NOW)).toBe(true);
        expect(s.loadHold('r1')).toEqual(hold('r1', { releasedBy: 'owner_a', releasedAt: NOW }));
        expect(s.releaseHold('r1', 'owner_b', NOW + 1)).toBe(false);
        expect(s.loadHold('r1')?.releasedBy).toBe('owner_a');
        expect(s.releaseHold('nope', 'owner_a', NOW)).toBe(false);
      });

      it('a released report can be held again: the released row is replaced by the new hold', () => {
        const s = make();
        s.placeHold(hold('r1'));
        s.releaseHold('r1', 'owner_a', NOW);
        expect(s.placeHold(hold('r1', { code: 'safety_review', heldBy: 'senior_b', heldAt: NOW + 5 }))).toBe(true);
        expect(s.loadHold('r1')).toEqual(hold('r1', { code: 'safety_review', heldBy: 'senior_b', heldAt: NOW + 5 }));
        expect(s.listHolds().map((h) => h.reportId)).toEqual(['r1']);
      });

      it('listHolds lists the open holds oldest first and not the released ones; loads are copies', () => {
        const s = make();
        s.placeHold(hold('r2', { heldAt: NOW }));
        s.placeHold(hold('r1', { heldAt: NOW }));
        s.placeHold(hold('r0', { heldAt: NOW - 5 }));
        s.placeHold(hold('r9', { heldAt: NOW - 9 }));
        s.releaseHold('r9', 'o', NOW);
        expect(s.listHolds().map((h) => h.reportId)).toEqual(['r0', 'r1', 'r2']);
        const copy = s.loadHold('r1');
        if (copy !== null) copy.code = 'other';
        expect(s.loadHold('r1')?.code).toBe('legal_proceeding');
      });

      it('a hold is journaled: a failing transaction undoes the place and the release', () => {
        const s = make();
        expect(() =>
          s.transaction(() => {
            s.placeHold(hold('r1'));
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadHold('r1')).toBeNull();
        s.placeHold(hold('r1'));
        expect(() =>
          s.transaction(() => {
            s.releaseHold('r1', 'o', NOW);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadHold('r1')?.releasedAt).toBeNull();
      });

      it('heldSet names the held reports and the sanction groups decided from them, and nothing of a released hold', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        await build(s, 'rB', 's_b');
        s.insertSanctionGroup([sanction('g-other', 'M-OTHER', 's_a', 'subject', null)]);
        expect(s.heldSet()).toEqual({ reportIds: [], groupIds: [] });
        s.placeHold(hold('rA'));
        expect(s.heldSet()).toEqual({ reportIds: ['rA'], groupIds: ['g-rA'] });
        s.placeHold(hold('rB'));
        expect(s.heldSet().reportIds.sort()).toEqual(['rA', 'rB']);
        s.releaseHold('rB', 'o', NOW);
        expect(s.heldSet()).toEqual({ reportIds: ['rA'], groupIds: ['g-rA'] });
      });
    });

    describe('purge skips the held set', () => {
      it('every purge leaves a held report, its decision, sanction group (all rows, address row included), notice, appeal, AI read, outcome and action, and its audit rows, and removes the same rows of an unheld report', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        await build(s, 'rB', 's_b');
        const full = { report: true, decision: true, sanctionRows: 2, notice: true, appeal: true, read: true, outcome: true, action: true, audit: 2 };
        expect(state(s, 'rA')).toEqual(full);
        expect(state(s, 'rB')).toEqual(full);
        s.placeHold(hold('rA'));
        purgeEverything(s);
        expect(state(s, 'rA')).toEqual(full);
        expect(state(s, 'rB')).toEqual({ report: false, decision: false, sanctionRows: 0, notice: false, appeal: false, read: false, outcome: false, action: false, audit: 0 });
      });

      it('the held rows keep their text: the excerpt lines of another player, the notice line, the appeal statement, the example, the undo note', async () => {
        const s = make();
        const x = s as Required<Store>;
        await build(s, 'rA', 's_a');
        s.placeHold(hold('rA'));
        purgeEverything(s);
        expect(s.loadReport('rA')?.excerpt.map((l) => l.raw)).toEqual(['tarvo reporter line', 'zorbak target line']);
        expect(s.loadNotices(['s_a'])[0]?.excerpt).toEqual([{ text: 'zorbak notice line', day: '2026-01-01' }]);
        expect(x.loadAppeal('ap-rA')?.statement).toBe('vlemmo appeal statement');
        expect(x.loadAiOutcome('rA')?.example).not.toBeNull();
        expect(x.loadAiAction('rA')?.undoNote).toBe('private undo note');
      });

      it('at every age: a purge with the cut of "now" keeps a young held report too, and a held report is never reached by a bad-faith window', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        s.placeHold(hold('rA'));
        for (const cut of [NOW, NOW + DAY, NOW + 10_000 * DAY]) {
          s.purgeReports(cut, 0);
          s.purgeSanctions(cut);
          s.purgeAudit(cut);
        }
        expect(state(s, 'rA').report).toBe(true);
        expect(state(s, 'rA').sanctionRows).toBe(2);
        expect(state(s, 'rA').audit).toBe(2);
      });

      it('after release the next purge removes what is past retention', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        s.placeHold(hold('rA'));
        purgeEverything(s);
        expect(state(s, 'rA').report).toBe(true);
        s.releaseHold('rA', 'owner_a', NOW);
        purgeEverything(s);
        expect(state(s, 'rA')).toEqual({ report: false, decision: false, sanctionRows: 0, notice: false, appeal: false, read: false, outcome: false, action: false, audit: 0 });
      });

      it('a hold protects only its own report: another report of the same person goes', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        s.insertReport(report('rA2', 's_a'));
        s.placeHold(hold('rA'));
        purgeEverything(s);
        expect(s.loadReport('rA')).not.toBeNull();
        expect(s.loadReport('rA2')).toBeNull();
      });

      it('the purge counts are the rows actually removed (a held row is not counted)', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        await build(s, 'rB', 's_b');
        s.placeHold(hold('rA'));
        const late = NOW + 1000 * DAY;
        expect(s.purgeReports(late, 0)).toBe(1);
        expect(s.purgeSanctions(late)).toBe(2);
        expect(s.purgeAudit(late)).toBe(2);
      });
    });

    describe('erase skips the held set', () => {
      const plan = (over: Record<string, unknown> = {}) => ({ subjects: ['s_a'], mode: 'none' as const, heldReportIds: new Set<string>(), receiptId: 'e_h', at: NOW, ...over });

      it('a held report about the person survives an erase that does not name it: the store consults its own holds', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        s.placeHold(hold('rA'));
        const counts = s.eraseSubjects(plan());
        expect(counts.kept.heldReports).toBe(1);
        expect(state(s, 'rA')).toEqual({ report: true, decision: true, sanctionRows: 2, notice: true, appeal: true, read: true, outcome: true, action: true, audit: 2 });
        expect(s.loadReport('rA')?.excerpt.map((l) => l.raw)).toEqual(['tarvo reporter line', 'zorbak target line']);
      });

      it('after release an erase removes it', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        s.placeHold(hold('rA'));
        s.releaseHold('rA', 'o', NOW);
        s.eraseSubjects(plan());
        expect(s.loadReport('rA')).toBeNull();
      });

      it('a hold on a report that only holds a line of the person (a third party report) keeps the line', async () => {
        const s = make();
        await s.saveSubject({ id: 's_a', createdAt: OLD, mergedInto: null });
        s.insertReport(report('rT', 's_t', { people: ['s_reporter', 's_t', 's_a'], excerpt: [{ lineId: '1', ts: OLD, seatId: 'p3', handle: 'Aaa', raw: 'zorbak a line', delivered: 'x', blocked: false, audience: null, p: 2 }] }));
        s.placeHold(hold('rT'));
        s.eraseSubjects(plan());
        expect(s.loadReport('rT')?.excerpt[0]?.raw).toBe('zorbak a line');
        expect(s.loadReport('rT')?.people).toEqual(['s_reporter', 's_t', 's_a']);
      });
    });

    describe('what a bundle reads: the groups a report wrote and the audit rows that point at it', () => {
      it('sanctionGroupsOfReport lists the groups whose rows cite the report, oldest first, and nothing for an unknown report', async () => {
        const s = make();
        s.insertSanctionGroup([sanction('g2', 'M-BBBBB', 's_a', 'subject', 'rA'), sanction('g2', 'M-BBBBB', 'iphash-2', 'ip', 'rA')]);
        s.insertSanctionGroup([sanction('g1', 'M-AAAAA', 's_a', 'subject', 'rA')]);
        s.insertSanctionGroup([sanction('g3', 'M-CCCCC', 's_a', 'subject', 'rOther')]);
        s.insertSanctionGroup([sanction('g4', 'M-DDDDD', 's_a', 'subject', null)]);
        expect(s.sanctionGroupsOfReport('rA')).toEqual(['g2', 'g1']);
        expect(s.sanctionGroupsOfReport('nope')).toEqual([]);
      });

      it('listAudit takes targets: only the rows that point at one of them; an empty list matches nothing; it combines with the other filters', () => {
        const s = make();
        const row = (id: string, at: number, action: 'report.view' | 'sanction.revoke', type: 'report' | 'sanction' | 'person', ref: string, actor = 'mod_a') =>
          s.insertAudit({ id, at, actor, role: 'moderator', action, target: { type, ref } });
        row('a1', 1, 'report.view', 'report', 'rA');
        row('a2', 2, 'sanction.revoke', 'sanction', 'gA');
        row('a3', 3, 'report.view', 'report', 'rB');
        row('a4', 4, 'report.view', 'person', 'rA');
        row('a5', 5, 'report.view', 'report', 'rA', 'mod_b');
        const targets = [
          { type: 'report' as const, ref: 'rA' },
          { type: 'sanction' as const, ref: 'gA' },
        ];
        expect(s.listAudit({ limit: 50, targets }).map((r) => r.id)).toEqual(['a5', 'a2', 'a1']);
        expect(s.listAudit({ limit: 50, targets: [] })).toEqual([]);
        expect(s.listAudit({ limit: 50, targets, actor: 'mod_a' }).map((r) => r.id)).toEqual(['a2', 'a1']);
        expect(s.listAudit({ limit: 50, targets, action: 'sanction.revoke' }).map((r) => r.id)).toEqual(['a2']);
        expect(s.listAudit({ limit: 50, targets, before: 5 }).map((r) => r.id)).toEqual(['a2', 'a1']);
        expect(s.listAudit({ limit: 1, targets }).map((r) => r.id)).toEqual(['a5']);
        expect(s.listAudit({ limit: 50 }).length).toBe(5);
      });
    });

    describe('export counts the holds of the person (and says nothing else about them)', () => {
      it('a held report about or by the person is counted, with no id, time or code; a released one is not', async () => {
        const s = make();
        await build(s, 'rA', 's_a');
        await build(s, 'rB', 's_b');
        s.placeHold(hold('rA', { code: 'safety_review', heldAt: NOW - 7 }));
        s.placeHold(hold('rB'));
        expect(s.exportSubjects(['s_a']).holds).toEqual({ reports: 1 });
        expect(JSON.stringify(s.exportSubjects(['s_a']).holds)).not.toContain('safety_review');
        s.releaseHold('rA', 'o', NOW);
        expect(s.exportSubjects(['s_a']).holds).toEqual({ reports: 0 });
        const filed = make();
        await filed.saveSubject({ id: 's_rep', createdAt: OLD, mergedInto: null });
        filed.insertReport(report('rF', 's_x', { reporterSubject: 's_rep' }));
        filed.placeHold(hold('rF'));
        expect(filed.exportSubjects(['s_rep']).holds).toEqual({ reports: 1 });
      });
    });
  });
}
