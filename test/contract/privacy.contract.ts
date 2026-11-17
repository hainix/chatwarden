import { describe, expect, it } from 'vitest';
import type { AiActionRow, AppealRow, ErasePlan, NoticeRow, SanctionRow, Store, StoredReport, StrikeRow } from '@chatwarden/core';

// The contract of the privacy methods of the Store (0.2.0, design section 5): `exportSubjects`, `eraseSubjects`, `insertErasure`, `loadPendingErasures`,
// `finishErasure` and `erasureEpoch`. One suite, run against every Store; SqliteStore is the reference. `dump` (optional) turns a whole store into one string:
// with it the suite also proves that NO id, account, handle or line of an erased person survives in ANY table.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

/** Everything that names the person under test (and must be gone after an erase), and the second person whose rows must stay. */
export const WHO = {
  ids: ['s_pp', 's_pp2'],
  accounts: ['acct-pp-1', 'acct-pp-2'],
  secrets: ['keyhash-pp', 'keyhash-pp2', 'iphash-pp'],
  handle: 'PPHandle',
  line: 'zorbak pp line one',
  line2: 'zorbak pp line two',
  noticeLine: 'quissel pp notice line',
  name: 'ppname_vlemmo',
  statement: 'pp appeal statement drakkuun',
  note: 'pp report note fenrisk',
};
export const OTHER = { id: 's_qq', account: 'acct-qq', handle: 'QQHandle', line: 'tarvo qq line' };

type Opt = Required<Pick<Store, 'insertAppeal' | 'insertBlockedName' | 'insertSignal' | 'setNoAutomation' | 'insertAiAction' | 'reserveAiRead' | 'completeAiRead' | 'insertAiOutcome' | 'putLink' | 'listLinks'>>;
const opt = (s: Store): Store & Opt => {
  for (const m of ['insertAppeal', 'insertBlockedName', 'insertSignal', 'setNoAutomation', 'insertAiAction', 'reserveAiRead', 'completeAiRead', 'insertAiOutcome', 'putLink', 'listLinks'] as const) {
    if (s[m] === undefined) throw new Error(`this store has no ${m}`);
  }
  return s as Store & Opt;
};

let seq = 0;
const sanction = (over: Partial<SanctionRow>): SanctionRow => {
  seq += 1;
  return {
    id: `san${seq}`,
    groupId: 'g?',
    refCode: 'M-?????',
    kind: 'chat',
    targetType: 'subject',
    value: 's_pp',
    startsAt: NOW - DAY,
    endsAt: NOW + DAY,
    reason: 'reason',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod_a',
    source: 'moderator',
    automated: false,
    pending: false,
    reportId: null,
    ...over,
  };
};
/** A subject row plus an address row of one group. */
const group = (groupId: string, refCode: string, value: string, ip: string, over: Partial<SanctionRow>): SanctionRow[] => [
  sanction({ groupId, refCode, value, ...over }),
  sanction({ groupId, refCode, value: ip, targetType: 'ip', ...over, gapNote: null, gapStatus: null }),
];

const notice = (id: string, subject: string, groupId: string | null, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id,
  subject,
  groupId,
  kind: groupId === null ? 'report_outcome' : 'chat',
  rule: '1',
  until: null,
  refCode: groupId === null ? null : 'M-?????',
  excerpt: [{ text: subject === 's_qq' ? 'qq notice line' : WHO.noticeLine, day: '2027-01-15' }],
  createdAt: NOW - 1000,
  ackedAt: null,
  withdrawnAt: null,
  ...over,
});

const report = (id: string, reporter: string, target: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW - 5000,
  roomId: `ROOM-${id}`,
  tags: { mode: 'ranked' },
  reporterSubject: reporter,
  reporterSeat: 'p1',
  reporterHandle: reporter === 's_pp' ? WHO.handle : OTHER.handle,
  targetSubject: target,
  targetSeat: 'p2',
  targetHandle: target === 's_pp' ? WHO.handle : OTHER.handle,
  category: 'harassment',
  reportedReason: 'harassment',
  note: reporter === 's_pp' ? WHO.note : 'plain note',
  lineId: '1',
  excerpt: [],
  people: [],
  status: 'open',
  ...over,
});

const line = (n: number, p: number | null, handle: string, raw: string) => ({
  lineId: String(n),
  ts: NOW - 6000 + n,
  seatId: p === 0 ? 'p1' : 'p2',
  handle,
  raw,
  delivered: raw,
  blocked: false,
  audience: null,
  p,
});

const appeal = (id: string, subject: string, groupId: string): AppealRow => ({
  id,
  subject,
  groupId,
  noticeId: `n-${id}`,
  reportId: null,
  rule: '1',
  kind: 'chat',
  statement: subject === 's_pp' ? WHO.statement : 'qq statement',
  status: 'open',
  createdAt: NOW - 900,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  replacementGroupId: null,
});

export interface WorldOptions {
  /** A ban in force on the person's ALIAS subject (default false: only an ended chat sanction). */
  ban?: boolean;
  /** A report about the person that is held (with its decision, sanction group, notice, appeal and AI rows). */
  held?: boolean;
}

/** Builds the person under test (`s_pp`, merged with `s_pp2`) with one row of every kind, and a second person (`s_qq`) and a third (`s_xx`) whose rows must survive. */
export async function seedWorld(s: Store, o: WorldOptions = {}): Promise<void> {
  const x = opt(s);
  const ident = (subjectId: string, kind: 'account' | 'key' | 'ip', value: string) => ({ subjectId, kind, value, firstSeen: NOW - 50 * DAY, lastSeen: NOW - DAY });
  for (const id of ['s_pp', 's_pp2', 's_qq', 's_xx']) await s.saveSubject({ id, createdAt: NOW - 100 * DAY, mergedInto: null });
  await s.markMerged('s_pp2', 's_pp');
  await s.saveIdentifier(ident('s_pp', 'account', WHO.accounts[0]!));
  await s.saveIdentifier(ident('s_pp', 'key', 'keyhash-pp'));
  await s.saveIdentifier(ident('s_pp', 'ip', 'iphash-pp'));
  await s.saveIdentifier(ident('s_pp2', 'account', WHO.accounts[1]!));
  await s.saveIdentifier(ident('s_pp2', 'key', 'keyhash-pp2'));
  await s.saveIdentifier(ident('s_qq', 'account', OTHER.account));
  await s.saveIdentifier(ident('s_qq', 'key', 'keyhash-qq'));
  await s.saveIdentifier(ident('s_qq', 'ip', 'iphash-qq'));
  await s.saveIdentifier(ident('s_xx', 'key', 'keyhash-xx'));

  // Reports. rAbout is about the person (filed by qq); rFiled is filed by the person (against qq, with a line of each); rThird is between qq and xx and holds
  // one line of the person; rFilter is a filter report about the person (reporter `filter:<id>`, never a person).
  s.insertReport(
    report('rAbout', 's_qq', 's_pp', {
      excerpt: [line(1, 0, OTHER.handle, OTHER.line), line(2, 1, WHO.handle, WHO.line)],
      people: ['s_qq', 's_pp'],
      note: 'qq says pp was rude',
    }),
  );
  s.insertReport(report('rFiled', 's_pp', 's_qq', { excerpt: [line(1, 0, WHO.handle, WHO.line2), line(2, 1, OTHER.handle, OTHER.line)], people: ['s_pp', 's_qq'] }));
  s.insertReport(report('rThird', 's_qq', 's_xx', { excerpt: [line(1, 0, OTHER.handle, OTHER.line), line(2, 1, 'XXHandle', 'plain xx line'), line(3, 2, WHO.handle, WHO.line)], people: ['s_qq', 's_xx', 's_pp'] }));
  s.insertReport(
    report('rFilter', 'filter:rFilter', 's_pp', {
      reporterSeat: '',
      reporterHandle: '',
      note: null,
      excerpt: [line(1, 0, WHO.handle, WHO.line)],
      people: ['s_pp'],
      origin: 'filter',
      originKey: 'link.unlisted',
      roomId: 'ROOM-f',
    }),
  );
  s.insertDecision('d-about', 'rAbout', NOW - 4000, '{"ok":true}');
  s.insertDecision('d-third', 'rThird', NOW - 4000, '{"ok":true}');

  // Sanctions: an ended chat sanction (cites rAbout) on the person; qq has a chat sanction in force that also cites rAbout, so a deleted report shows as NULL.
  s.insertSanctionGroup(group('gEnded', 'M-ENDED', 's_pp', 'iphash-pp', { endsAt: NOW - 2 * DAY, startsAt: NOW - 3 * DAY, reportId: 'rAbout' }));
  s.insertSanctionGroup(group('gQ', 'M-QQQQ', 's_qq', 'iphash-qq', { reportId: 'rAbout' }));
  if (o.ban === true) s.insertSanctionGroup(group('gBan', 'M-BANNN', 's_pp2', 'iphash-pp', { kind: 'ban', endsAt: null }));
  s.insertNotice(notice('n-ended', 's_pp', 'gEnded', { refCode: 'M-ENDED' }));
  s.insertNotice(notice('n-outcome', 's_pp', null));
  s.insertNotice(notice('n-q', 's_qq', 'gQ', { refCode: 'M-QQQQ' }));
  if (o.ban === true) s.insertNotice(notice('n-ban', 's_pp2', 'gBan', { kind: 'ban', refCode: 'M-BANNN' }));

  const strike = (id: string, subject: string, raw: string): StrikeRow => ({ id, at: NOW - 3 * DAY, subject, roomId: 'ROOM-s', termId: 't1', rawLine: raw });
  s.insertStrike(strike('st1', 's_pp', WHO.line));
  s.insertStrike(strike('st2', 's_pp2', WHO.line2));
  s.insertStrike(strike('st3', 's_qq', OTHER.line));
  s.upsertMute({ viewer: 's_pp', target: 's_qq', createdAt: NOW - DAY });
  s.upsertMute({ viewer: 's_qq', target: 's_pp2', createdAt: NOW - DAY });
  s.upsertMute({ viewer: 's_qq', target: 's_xx', createdAt: NOW - DAY });
  x.insertBlockedName({ id: 'bn1', subject: 's_pp', name: WHO.name, termId: null, reason: 'name_profane', at: NOW - DAY });
  x.insertBlockedName({ id: 'bn2', subject: 's_qq', name: 'qqname', termId: null, reason: 'name_profane', at: NOW - DAY });
  x.insertAppeal(appeal('ap-pp', 's_pp', 'gEnded'));
  x.insertAppeal(appeal('ap-qq', 's_qq', 'gQ'));
  const sig = (id: string, subject: string, by: string | null, kind = 'muted_by_player') => ({
    id,
    kind,
    subject,
    sourceKey: by === null ? 'd:20000' : `b:${by}`,
    bySubject: by,
    roomId: null,
    at: NOW - DAY,
    weight: 1,
    capBucket: 1,
  });
  x.insertSignal(sig('sg1', 's_pp', 's_qq'));
  x.insertSignal(sig('sg2', 's_qq', 's_pp'));
  x.insertSignal(sig('sg3', 's_xx', 's_qq'));
  x.setNoAutomation('s_pp', { code: 'streamer', setBy: 'senior_a', setAt: NOW - DAY });
  x.setNoAutomation('s_qq', { code: 'streamer', setBy: 'senior_a', setAt: NOW - DAY });
  s.claimCase('s_pp', 'mod_a', NOW - 1000, NOW + 600_000, 'claim');
  s.claimCase('s_qq', 'mod_a', NOW - 1000, NOW + 600_000, 'claim');
  s.putDiscordThread({ subject: 's_pp', threadId: '111', label: 'Case AAAAA', createdAt: NOW - DAY });
  s.putDiscordThread({ subject: 's_qq', threadId: '222', label: 'Case BBBBB', createdAt: NOW - DAY });
  x.putLink({ system: 'coop-report', ref: 'rAbout', external: 'ext-1', state: 'sent', at: NOW - DAY });
  x.putLink({ system: 'coop-report', ref: 'rThird', external: 'ext-2', state: 'sent', at: NOW - DAY });

  // AI rows: a read, an outcome and an action for rAbout (about the person) and for rThird (a report holding one of their lines).
  for (const id of ['rAbout', 'rThird']) {
    const r = x.reserveAiRead({ reportId: id, inputHash: `h-${id}`, promptVersion: 1, adapter: 'fake:one' }, NOW + 60_000, NOW - 3000);
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
        summary: `summary about ${id}`,
        evidence: ['L1'],
        confidence: 'high',
        injectionSuspected: false,
        recommendation: { verdict: 'upheld', severity: 'hostile', rule: 3, evidence: ['L1'] },
      },
    });
    x.insertAiOutcome({
      reportId: id,
      readId: r.id,
      decidedAt: NOW - 2000,
      level: 2,
      verdict: 'upheld',
      rule: '3',
      severity: 'hostile',
      aiVerdict: 'upheld',
      agreement: 'agree',
      detail: { verdict: true, rule: true, lines: 2, outcome: 'same', oneClick: true },
      badFaith: false,
      example: { rule: 3, severity: 'hostile', verdict: 'upheld', lines: [{ who: 'P1', text: WHO.line }] },
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
      state: 'queued',
      refusedCode: null,
      notBefore: NOW,
      createdAt: NOW - 1000,
      groupId: null,
      kind: null,
      durationMs: null,
      actedAt: null,
      reviewDueAt: null,
      reviewedAt: null,
      reviewedBy: null,
      undoCode: null,
      undoNote: null,
      adapter: 'fake:one',
      promptVersion: 1,
    };
    x.insertAiAction(action);
  }

  s.insertAudit({ id: 'au1', at: NOW - 900, actor: 'mod_a', role: 'moderator', action: 'history.view', target: { type: 'person', ref: 's_pp' } });
  s.insertAudit({ id: 'au2', at: NOW - 800, actor: 'mod_a', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'rAbout' } });
  s.insertAudit({ id: 'au3', at: NOW - 700, actor: 'mod_a', role: 'moderator', action: 'history.view', target: { type: 'person', ref: 's_qq' } });

  if (o.held === true) {
    s.insertReport(report('rHeld', 's_qq', 's_pp', { excerpt: [line(1, 0, OTHER.handle, OTHER.line), line(2, 1, WHO.handle, WHO.line)], people: ['s_qq', 's_pp'], roomId: 'ROOM-h' }));
    s.insertDecision('d-held', 'rHeld', NOW - 4000, '{"ok":true}');
    s.insertSanctionGroup(group('gHeld', 'M-HELDD', 's_pp', 'iphash-pp', { reportId: 'rHeld' }));
    s.insertNotice(notice('n-held', 's_pp', 'gHeld', { refCode: 'M-HELDD' }));
    x.insertAppeal(appeal('ap-held', 's_pp', 'gHeld'));
    const r = x.reserveAiRead({ reportId: 'rHeld', inputHash: 'h-rHeld', promptVersion: 1, adapter: 'fake:one' }, NOW + 60_000, NOW - 3000);
    if (!r.reserved) throw new Error('expected a reservation');
    x.insertAiOutcome({
      reportId: 'rHeld',
      readId: null,
      decidedAt: NOW - 2000,
      level: 2,
      verdict: 'upheld',
      rule: '3',
      severity: 'hostile',
      aiVerdict: null,
      agreement: 'none',
      detail: { verdict: true, rule: true, lines: 2, outcome: 'same', oneClick: true },
      badFaith: false,
      example: null,
      aiRule: null,
      aiSeverity: null,
      aiConfidence: null,
      decidedBy: 'mod_a',
      source: 'human',
    });
  }
}

const plan = (over: Partial<ErasePlan> = {}): ErasePlan => ({
  subjects: ['s_pp'],
  mode: 'none',
  heldReportIds: new Set(),
  receiptId: 'e_receipt1',
  at: NOW,
  ...over,
});

export function privacyContract(name: string, make: () => Store, dump?: (s: Store) => string): void {
  describe(`privacy contract: ${name}`, () => {
    describe('erase, keep none', () => {
      it('has the methods', () => {
        const s = make();
        for (const m of ['exportSubjects', 'eraseSubjects', 'insertErasure', 'loadPendingErasures', 'finishErasure', 'erasureEpoch'] as const) expect(typeof s[m], m).toBe('function');
      });

      it('removes every row of the person from every table and touches no one else', async () => {
        const s = make();
        await seedWorld(s);
        const others = {
          qq: s.loadSanctions(NOW).filter((r) => r.value === 's_qq' || r.value === 'iphash-qq').length,
          notices: s.loadNotices(['s_qq']).length,
          strikes: s.loadStrikes(0).filter((r) => r.subject === 's_qq').length,
        };
        const counts = s.eraseSubjects(plan());
        expect(counts.found).toBe(true);
        expect(counts.pending).toBeNull();
        expect(counts.kept).toEqual({ identifiers: false, sanctions: 0, heldReports: 0 });
        // rows of the person are gone
        expect((await s.loadSubjects()).subjects.map((r) => r.id).sort()).toEqual(['s_qq', 's_xx']);
        expect((await s.loadSubjects()).ids.map((r) => r.subjectId).sort()).toEqual(['s_qq', 's_qq', 's_qq', 's_xx']);
        expect(s.loadNotices(['s_pp', 's_pp2'])).toEqual([]);
        expect(s.loadStrikes(0).map((r) => r.subject)).toEqual(['s_qq']);
        expect(s.loadMutes(0)).toEqual([{ viewer: 's_qq', target: 's_xx', createdAt: NOW - DAY }]);
        expect(s.loadReport('rAbout')).toBeNull();
        expect(s.loadReport('rFilter')).toBeNull();
        expect(s.findDecision('d-about')).toBeNull();
        expect(s.loadClaims(['s_pp', 's_qq'], NOW).map((c) => c.person)).toEqual(['s_qq']);
        expect(s.getDiscordThread('s_pp')).toBeNull();
        expect(s.getDiscordThread('s_qq')).not.toBeNull();
        expect(s.loadAiOutcome?.('rAbout')).toBeNull();
        expect(s.loadAiAction?.('rAbout')).toBeNull();
        expect(s.loadNoAutomation?.('s_pp')).toBeNull();
        expect(s.loadNoAutomation?.('s_qq')).not.toBeNull();
        // rows of the others stay
        expect(s.loadSanctions(NOW).filter((r) => r.value === 's_qq' || r.value === 'iphash-qq').length).toBe(others.qq);
        expect(s.loadNotices(['s_qq']).length).toBe(others.notices);
        expect(s.loadStrikes(0).filter((r) => r.subject === 's_qq').length).toBe(others.strikes);
        expect(s.loadReport('rThird')).not.toBeNull();
        expect(s.loadAiOutcome?.('rThird')).not.toBeNull();
        expect(s.loadAppeal?.('ap-qq')).not.toBeNull();
        expect(s.loadAppeal?.('ap-pp')).toBeNull();
        expect(s.listBlockedNames?.(0, 100).map((r) => r.id)).toEqual(['bn2']);
        expect(s.listLinks?.('coop-report', { limit: 10 }).map((r) => r.ref)).toEqual(['rThird']);
      });

      it('no id survives: a dump of every table holds none of the person\'s ids, accounts, handles or lines', async () => {
        const s = make();
        await seedWorld(s, { ban: true });
        if (dump !== undefined) {
          for (const needle of [...WHO.ids, ...WHO.accounts, ...WHO.secrets, WHO.handle, WHO.line, WHO.line2, WHO.noticeLine, WHO.name, WHO.statement, WHO.note]) {
            expect(dump(s), `before: ${needle}`).toContain(needle);
          }
        }
        s.eraseSubjects(plan());
        if (dump === undefined) return;
        const after = dump(s);
        for (const needle of [...WHO.ids, ...WHO.accounts, ...WHO.secrets, WHO.handle, WHO.line, WHO.line2, WHO.noticeLine, WHO.name, WHO.statement, WHO.note]) {
          expect(after, needle).not.toContain(needle);
        }
        // the others are still there
        for (const keep of [OTHER.id, OTHER.account, OTHER.handle, OTHER.line, 'keyhash-qq', 'iphash-qq', 'XXHandle']) expect(after, keep).toContain(keep);
      });

      it('an erased reporter\'s report stays for its target with the reporter, seat, handle and note removed; a report about the person is deleted with its decisions, AI rows and links; sanction.report_id is NULL after', async () => {
        const s = make();
        await seedWorld(s);
        const counts = s.eraseSubjects(plan());
        const filed = s.loadReport('rFiled');
        expect(filed).not.toBeNull();
        expect(filed?.reporterSubject).toBe('erased:rFiled');
        expect(filed?.reporterSeat).toBe('');
        expect(filed?.reporterHandle).toBe('');
        expect(filed?.note).toBeNull();
        expect(filed?.targetSubject).toBe('s_qq');
        expect(filed?.people).toEqual(['s_qq']);
        expect(filed?.excerpt.map((l) => [l.p, l.raw])).toEqual([
          [null, '[erased]'],
          [0, OTHER.line],
        ]);
        expect(filed?.excerpt[0]).toMatchObject({ handle: '', seatId: '', delivered: '[erased]' });
        // a report between two other players loses only the person's line, and the marker keeps the order
        const third = s.loadReport('rThird');
        expect(third?.people).toEqual(['s_qq', 's_xx']);
        expect(third?.excerpt.map((l) => [l.p, l.raw])).toEqual([
          [0, OTHER.line],
          [1, 'plain xx line'],
          [null, '[erased]'],
        ]);
        expect(third?.reporterSubject).toBe('s_qq');
        expect(s.loadReport('rAbout')).toBeNull();
        expect(s.loadReport('rFilter')).toBeNull();
        expect(s.findDecision('d-about')).toBeNull();
        expect(s.findDecision('d-third')).not.toBeNull();
        expect(s.loadAiRead?.('rAbout')).toBeNull();
        // the AI read of the report that held one of their lines is dropped with the line; its outcome stays without the example text
        expect(s.loadAiRead?.('rThird')).toBeNull();
        expect(s.loadAiOutcome?.('rThird')?.example).toBeNull();
        expect(s.loadSanctions(NOW).find((r) => r.groupId === 'gQ')?.reportId ?? null).toBeNull();
        expect(counts.removed.reports_about).toBe(2);
        expect(counts.removed.reports_filed).toBe(1);
        expect(counts.removed.report_lines).toBe(1);
      });

      it('counts per category (rows removed), the same for a dry run, which writes nothing', async () => {
        const s = make();
        await seedWorld(s, { ban: true });
        const before = dump?.(s);
        const epoch = s.erasureEpoch();
        const preview = s.eraseSubjects(plan({ dryRun: true }));
        if (dump !== undefined) expect(dump(s)).toBe(before);
        expect(s.erasureEpoch()).toBe(epoch);
        const real = s.eraseSubjects(plan());
        expect(preview).toEqual(real);
        expect(real.removed).toEqual({
          subjects: 2,
          identifiers: 5,
          sanctions: 4,
          notices: 3,
          reports_filed: 1,
          reports_about: 2,
          report_lines: 1,
          strikes: 2,
          mutes: 2,
          blocked_names: 1,
          appeals: 1,
          signals: 2,
          ai: 6,
          workflow: 3,
          audit: 1,
        });
      });

      it('an alias passed on its own erases only itself and what is merged into it; the canonical person stays', async () => {
        const s = make();
        await seedWorld(s);
        const counts = s.eraseSubjects(plan({ subjects: ['s_pp2'] }));
        expect(counts.found).toBe(true);
        expect((await s.loadSubjects()).subjects.map((r) => r.id).sort()).toEqual(['s_pp', 's_qq', 's_xx']);
        expect(s.loadStrikes(0).map((r) => r.subject).sort()).toEqual(['s_pp', 's_qq']);
      });

      it('the audit rows that name the person read the receipt id; no other audit row is rewritten', async () => {
        const s = make();
        await seedWorld(s);
        s.eraseSubjects(plan({ receiptId: 'e_audit1' }));
        const rows = s.listAudit({ limit: 50 });
        const by = (id: string) => rows.find((r) => r.id === id);
        expect(by('au1')?.target).toEqual({ type: 'person', ref: 'e_audit1' });
        expect(by('au2')?.target).toEqual({ type: 'report', ref: 'rAbout' });
        expect(by('au3')?.target).toEqual({ type: 'person', ref: 's_qq' });
      });
    });

    describe('erase, keep safety', () => {
      it('a ban in force: keeps the subjects, identifiers, that sanction (with its address row) and notice (excerpt cleared); loses everything else', async () => {
        const s = make();
        await seedWorld(s, { ban: true });
        const counts = s.eraseSubjects(plan({ mode: 'safety' }));
        expect(counts.pending).toBe('s_pp');
        expect(counts.kept).toEqual({ identifiers: true, sanctions: 2, heldReports: 0 });
        expect(counts.removed.subjects).toBeUndefined();
        expect(counts.removed.identifiers).toBeUndefined();
        expect(counts.removed.sanctions).toBe(2);
        const rows = s.loadSanctions(NOW).filter((r) => r.groupId === 'gBan');
        expect(rows.map((r) => [r.targetType, r.value])).toEqual([
          ['subject', 's_pp2'],
          ['ip', 'iphash-pp'],
        ]);
        expect(s.loadSanctions(NOW).some((r) => r.groupId === 'gEnded')).toBe(false);
        expect((await s.loadSubjects()).subjects.map((r) => r.id).sort()).toEqual(['s_pp', 's_pp2', 's_qq', 's_xx']);
        expect((await s.loadSubjects()).ids.filter((r) => r.subjectId.startsWith('s_pp')).length).toBe(5);
        const kept = s.loadNotices(['s_pp', 's_pp2']);
        expect(kept.map((n) => n.id)).toEqual(['n-ban']);
        expect(kept[0]?.excerpt).toEqual([]);
        expect(s.loadStrikes(0).filter((r) => r.subject.startsWith('s_pp'))).toEqual([]);
        expect(s.loadReport('rAbout')).toBeNull();
        // the audit rows keep the subject ref while the remainder stands
        expect(s.listAudit({ limit: 50 }).find((r) => r.id === 'au1')?.target).toEqual({ type: 'person', ref: 's_pp' });
      });

      it('a person with only ended sanctions loses the identifiers and the subject rows too, and the receipt has no pending subject', async () => {
        const s = make();
        await seedWorld(s);
        const counts = s.eraseSubjects(plan({ mode: 'safety' }));
        expect(counts.pending).toBeNull();
        expect(counts.kept).toEqual({ identifiers: false, sanctions: 0, heldReports: 0 });
        expect((await s.loadSubjects()).subjects.map((r) => r.id).sort()).toEqual(['s_qq', 's_xx']);
      });

      it('a warning or a note in force restricts nothing, so it keeps nothing', async () => {
        const s = make();
        await s.saveSubject({ id: 's_w', createdAt: NOW, mergedInto: null });
        s.insertSanctionGroup(group('gW', 'M-WARNN', 's_w', 'iphash-w', { kind: 'warning', endsAt: NOW - DAY, startsAt: NOW - DAY }));
        s.insertSanctionGroup(group('gN', 'M-NOTEE', 's_w', 'iphash-w2', { kind: 'note', endsAt: null }));
        const counts = s.eraseSubjects(plan({ subjects: ['s_w'], mode: 'safety' }));
        expect(counts.kept.identifiers).toBe(false);
        expect(counts.removed.subjects).toBe(1);
        expect(s.loadSanctions(NOW)).toEqual([]);
      });

      it('a revoked ban and an ended ban are not in force', async () => {
        const s = make();
        await s.saveSubject({ id: 's_r', createdAt: NOW, mergedInto: null });
        s.insertSanctionGroup(group('gR', 'M-REVOKE', 's_r', 'iphash-r', { kind: 'ban', endsAt: null }));
        s.revokeSanctionGroup('gR', 'mod_a', NOW - 1, 'oops');
        s.insertSanctionGroup(group('gE', 'M-ENDEDD', 's_r', 'iphash-r2', { kind: 'ban', endsAt: NOW - 1, startsAt: NOW - DAY }));
        const counts = s.eraseSubjects(plan({ subjects: ['s_r'], mode: 'safety' }));
        expect(counts.pending).toBeNull();
        expect(counts.removed.sanctions).toBe(4);
      });
    });

    describe('held reports', () => {
      it('held report ids passed in are untouched, with their excerpt lines, decisions, sanction groups, notices, appeals and AI rows, under none', async () => {
        const s = make();
        await seedWorld(s, { held: true });
        const heldReport = s.loadReport('rHeld');
        const heldNotice = s.loadNotices(['s_pp']).find((n) => n.id === 'n-held');
        const counts = s.eraseSubjects(plan({ heldReportIds: new Set(['rHeld']) }));
        expect(counts.kept.heldReports).toBe(1);
        expect(s.loadReport('rHeld')).toEqual(heldReport);
        expect(s.findDecision('d-held')).not.toBeNull();
        expect(s.loadSanctions(NOW).filter((r) => r.groupId === 'gHeld').length).toBe(2);
        expect(s.loadNotices(['s_pp']).find((n) => n.id === 'n-held')).toEqual(heldNotice);
        expect(s.loadAppeal?.('ap-held')).not.toBeNull();
        expect(s.loadAiOutcome?.('rHeld')).not.toBeNull();
        // what is not held is gone
        expect(s.loadReport('rAbout')).toBeNull();
        expect(s.loadAppeal?.('ap-pp')).toBeNull();
        // the held rows still name the person: that is the point of a hold
        if (dump !== undefined) expect(dump(s)).toContain(WHO.line);
      });

      it('without the report in the held set the same report is erased', async () => {
        const s = make();
        await seedWorld(s, { held: true });
        s.eraseSubjects(plan());
        expect(s.loadReport('rHeld')).toBeNull();
        expect(s.loadSanctions(NOW).filter((r) => r.groupId === 'gHeld')).toEqual([]);
        expect(s.loadAppeal?.('ap-held')).toBeNull();
      });
    });

    describe('unknown subjects, repeats and the epoch', () => {
      it('an unknown subject erases nothing, writes nothing and does not move the epoch', async () => {
        const s = make();
        await seedWorld(s);
        const before = dump?.(s);
        const epoch = s.erasureEpoch();
        const counts = s.eraseSubjects(plan({ subjects: ['s_nobody'] }));
        expect(counts).toEqual({ found: false, removed: {}, kept: { identifiers: false, sanctions: 0, heldReports: 0 }, pending: null });
        expect(s.erasureEpoch()).toBe(epoch);
        if (dump !== undefined) expect(dump(s)).toBe(before);
      });

      it('erasing twice is a no-op the second time', async () => {
        const s = make();
        await seedWorld(s);
        expect(s.eraseSubjects(plan()).found).toBe(true);
        const after = dump?.(s);
        const again = s.eraseSubjects(plan({ receiptId: 'e_second' }));
        expect(again.found).toBe(false);
        expect(again.removed).toEqual({});
        if (dump !== undefined) expect(dump(s)).toBe(after);
      });

      it('erasureEpoch starts at 0, moves on every real erase and on nothing else', async () => {
        const s = make();
        expect(s.erasureEpoch()).toBe(0);
        await seedWorld(s);
        expect(s.erasureEpoch()).toBe(0);
        s.eraseSubjects(plan({ dryRun: true }));
        s.eraseSubjects(plan({ subjects: ['s_nobody'] }));
        s.insertReport(report('rEx', 's_qq', 's_xx'));
        expect(s.erasureEpoch()).toBe(0);
        s.eraseSubjects(plan());
        expect(s.erasureEpoch()).toBe(1);
        s.eraseSubjects(plan({ subjects: ['s_xx'], receiptId: 'e_two' }));
        expect(s.erasureEpoch()).toBe(2);
      });

      it('an erase inside a failing transaction is undone, the epoch included', async () => {
        const s = make();
        await seedWorld(s);
        const before = dump?.(s);
        expect(() =>
          s.transaction(() => {
            s.eraseSubjects(plan());
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.erasureEpoch()).toBe(0);
        expect(s.loadReport('rAbout')).not.toBeNull();
        if (dump !== undefined) expect(dump(s)).toBe(before);
      });
    });

    describe('receipts and the pending finish', () => {
      const row = (over: Record<string, unknown> = {}) => ({
        id: 'e_r1',
        at: NOW,
        mode: 'safety' as const,
        actor: 'owner_a',
        removed: { strikes: 2 },
        kept: { identifiers: true, sanctions: 1, heldReports: 0 },
        pendingSubject: 's_pp' as string | null,
        ...over,
      });

      it('insertErasure writes a receipt; loadPendingErasures lists only those with a pending subject, oldest first', () => {
        const s = make();
        s.insertErasure(row());
        s.insertErasure(row({ id: 'e_r0', at: NOW - 10, pendingSubject: 's_aa' }));
        s.insertErasure(row({ id: 'e_done', pendingSubject: null }));
        expect(s.loadPendingErasures().map((r) => r.id)).toEqual(['e_r0', 'e_r1']);
        expect(s.loadPendingErasures()[1]).toEqual(row());
        expect(() => s.insertErasure(row())).toThrow();
      });

      it('finishErasure waits while a sanction row remains, then deletes the identifiers and subject rows, rewrites the audit refs and clears the pending subject', async () => {
        const s = make();
        await seedWorld(s, { ban: true });
        const counts = s.eraseSubjects(plan({ mode: 'safety', receiptId: 'e_fin' }));
        s.insertErasure({ id: 'e_fin', at: NOW, mode: 'safety', actor: 'owner_a', removed: counts.removed, kept: counts.kept, pendingSubject: counts.pending });
        expect(s.finishErasure('e_fin')).toBe(false);
        expect(s.loadPendingErasures().length).toBe(1);
        s.revokeSanctionGroup('gBan', 'mod_a', NOW, 'ended');
        // a revoked row is still a row: the finish waits for the retention pass to remove it
        expect(s.finishErasure('e_fin')).toBe(false);
        s.purgeSanctions(NOW + 1000 * DAY);
        const epoch = s.erasureEpoch();
        expect(s.finishErasure('e_fin')).toBe(true);
        expect(s.erasureEpoch()).toBe(epoch + 1);
        expect(s.loadPendingErasures()).toEqual([]);
        expect((await s.loadSubjects()).subjects.map((r) => r.id).sort()).toEqual(['s_qq', 's_xx']);
        expect(s.listAudit({ limit: 50 }).find((r) => r.id === 'au1')?.target).toEqual({ type: 'person', ref: 'e_fin' });
        expect(s.finishErasure('e_fin')).toBe(false);
        expect(s.finishErasure('e_nobody')).toBe(false);
        if (dump !== undefined) for (const needle of [...WHO.ids, ...WHO.accounts, ...WHO.secrets]) expect(dump(s), needle).not.toContain(needle);
      });

      it('purgeAudit also drops finished receipts older than the cut, and never a pending one', () => {
        const s = make();
        s.insertErasure(row({ id: 'e_old', at: NOW - 400 * DAY, pendingSubject: null }));
        s.insertErasure(row({ id: 'e_oldpending', at: NOW - 400 * DAY }));
        s.insertErasure(row({ id: 'e_new', at: NOW, pendingSubject: null }));
        s.purgeAudit(NOW - 365 * DAY);
        expect(s.loadPendingErasures().map((r) => r.id)).toEqual(['e_oldpending']);
        expect(() => s.insertErasure(row({ id: 'e_old', pendingSubject: null }))).not.toThrow();
        expect(() => s.insertErasure(row({ id: 'e_new', pendingSubject: null }))).toThrow();
      });
    });

    describe('export', () => {
      it('returns the sections of the person: accounts as given, counts of keys and addresses, no hash, no other id, handle or line, no reporter identity, no staff ref', async () => {
        const s = make();
        await seedWorld(s, { held: true });
        s.insertReport(report('rFiled2', 's_pp2', 's_xx', { note: 'second note' }));
        const out = s.exportSubjects(['s_pp', 's_pp2']);
        expect(out.found).toBe(true);
        expect(out.aliases).toBe(2);
        expect(out.createdAt).toBe(NOW - 100 * DAY);
        expect(out.accounts.sort()).toEqual(['acct-pp-1', 'acct-pp-2']);
        expect(out.identifiers).toEqual({ keys: 2, addresses: 1, firstSeen: NOW - 50 * DAY, lastSeen: NOW - DAY });
        expect(out.sanctions.map((r) => r.refCode).sort()).toEqual(['M-ENDED', 'M-HELDD']);
        expect(out.sanctions[0]).toMatchObject({ byStaff: true, revoked: false });
        expect(out.notices.length).toBe(3);
        expect(out.notices.find((n) => n.kind === 'report_outcome')?.excerpt).toEqual([{ text: WHO.noticeLine, day: '2027-01-15' }]);
        expect(out.reportsFiled.map((r) => r.note).sort()).toEqual([WHO.note, 'second note']);
        expect(out.reportsAbout.length).toBe(3);
        expect(out.reportsAbout.flatMap((r) => r.lines.map((l) => l.text))).toEqual([WHO.line, WHO.line, WHO.line]);
        expect(out.reportsAbout.find((r) => r.origin === 'filter')).toBeDefined();
        expect(out.strikes.map((r) => r.line).sort()).toEqual([WHO.line, WHO.line2]);
        expect(out.blockedNames.map((r) => r.name)).toEqual([WHO.name]);
        expect(out.appeals.map((r) => r.statement)).toEqual([WHO.statement, WHO.statement]);
        expect(out.signals.map((r) => r.kind)).toEqual(['muted_by_player']);
        expect(out.mutes).toEqual({ placed: 1, received: 1 });
        expect(out.ai).toEqual({ noAutomation: 'streamer', reads: 2, outcomes: [{ verdict: 'upheld', agreement: 'agree' }, { verdict: 'upheld', agreement: 'none' }] });
        expect(out.audit).toEqual([{ at: NOW - 900, action: 'history.view' }]);
        expect(out.holds).toEqual([]);
        expect(out.truncated).toEqual([]);
        const text = JSON.stringify(out);
        for (const bad of ['keyhash', 'iphash', 's_qq', 's_xx', 's_pp', OTHER.account, OTHER.handle, OTHER.line, 'qq statement', 'mod_a', 'senior_a', 'filter:', 'plain xx line']) {
          expect(text, bad).not.toContain(bad);
        }
      });

      it('a person with no subject is not found; a person with nothing else has empty sections', async () => {
        const s = make();
        expect(s.exportSubjects(['s_nobody']).found).toBe(false);
        await s.saveSubject({ id: 's_lone', createdAt: NOW, mergedInto: null });
        const out = s.exportSubjects(['s_lone']);
        expect(out.found).toBe(true);
        expect(out.accounts).toEqual([]);
        expect(out.sanctions).toEqual([]);
        expect(out.mutes).toEqual({ placed: 0, received: 0 });
        expect(out.ai).toEqual({ noAutomation: null, reads: 0, outcomes: [] });
        expect(out.identifiers).toEqual({ keys: 0, addresses: 0, firstSeen: null, lastSeen: null });
      });

      it('caps a section at 5 000 rows and names it: 5 001 strikes give 5 000 and truncated', async () => {
        const s = make();
        await s.saveSubject({ id: 's_many', createdAt: NOW, mergedInto: null });
        s.transaction(() => {
          for (let i = 0; i < 5001; i++) s.insertStrike({ id: `many${i}`, at: NOW - i, subject: 's_many', roomId: 'R', termId: 't', rawLine: `line ${i}` });
        });
        const out = s.exportSubjects(['s_many']);
        expect(out.strikes.length).toBe(5000);
        expect(out.truncated).toEqual(['strikes']);
        expect(out.strikes[0]?.at).toBe(NOW);
      });

      it('reads only: an export writes nothing and never moves the epoch', async () => {
        const s = make();
        await seedWorld(s);
        const before = dump?.(s);
        s.exportSubjects(['s_pp', 's_pp2']);
        expect(s.erasureEpoch()).toBe(0);
        if (dump !== undefined) expect(dump(s)).toBe(before);
      });
    });
  });
}
