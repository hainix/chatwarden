import { describe, expect, it } from 'vitest';
import type { AiOutcomeDetail, AiOutcomeInsert, AiGateRow, Store } from '@chatwarden/core';

// The contract of the gate query (AI levels 3 and 4, design 5.1 and 6.5, release 1): `aiGateRows` aggregates the casebook rows into one count
// set per cell (the AI's own rule and conduct level), over a window. The counting rules are written once, here, and every store must agree:
//   qualifying   the AI recommended `upheld` with `high` confidence, the row is not level 1 (agreement `none`), a person decided it (`human`) or it
//                was held back (`holdback`), and it is not bad faith. A `review` row (a person confirming an AI action) never counts.
//   clean agree  qualifying, agreement `agree`, the same rule, not a milder step than the ladder gave, and not reversed on appeal.
//   hard override qualifying and the person dismissed it (`override`), or it was later reversed by a revoke (`corrective`).
//   reduced      qualifying and reversed by a reduce (reversed, not corrective); apart from a hard override.
// One suite, run against every Store; SqliteStore is the reference.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const SINCE = NOW - 90 * DAY;
const RECENT = NOW - 30 * DAY;

type GateStore = Required<Pick<Store, 'aiGateRows' | 'insertAiOutcome' | 'loadAiOutcome' | 'markAiOutcome' | 'purgeAi'>>;
const METHODS = ['aiGateRows', 'insertAiOutcome', 'loadAiOutcome', 'markAiOutcome', 'purgeAi'] as const;
const gate = (s: Store): Store & GateStore => {
  for (const m of METHODS) if (s[m] === undefined) throw new Error(`this store has no ${m}`);
  return s as Store & GateStore;
};

const DETAIL: AiOutcomeDetail = { verdict: true, rule: true, lines: 2, outcome: 'same', oneClick: false };

let seq = 0;
/** A qualifying row in cell (rule 3, hostile) decided by `mod_a` a day ago; every field a test cares about is overridden. */
const row = (over: Partial<AiOutcomeInsert> = {}): AiOutcomeInsert => {
  seq += 1;
  return {
    reportId: `g${seq}`,
    readId: `read${seq}`,
    decidedAt: NOW - DAY,
    level: 2,
    verdict: 'upheld',
    rule: '3',
    severity: 'hostile',
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: DETAIL,
    badFaith: false,
    example: null,
    aiRule: '3',
    aiSeverity: 'hostile',
    aiConfidence: 'high',
    decidedBy: 'mod_a',
    source: 'human',
    ...over,
  };
};

const put = (s: Store & GateStore, ...rows: AiOutcomeInsert[]): void => {
  for (const r of rows) expect(s.insertAiOutcome(r)).toBe(true);
};
const rows = (s: Store & GateStore, since = SINCE, recentSince = RECENT): AiGateRow[] => s.aiGateRows(since, recentSince);
const cell = (s: Store & GateStore, rule = '3', severity = 'hostile', since = SINCE, recentSince = RECENT): AiGateRow | undefined =>
  rows(s, since, recentSince).find((r) => r.rule === rule && r.severity === severity);
const counts = (s: Store & GateStore, rule = '3', severity = 'hostile'): AiGateRow['counts'] => {
  const found = cell(s, rule, severity);
  if (found === undefined) throw new Error(`no cell ${rule}/${severity}`);
  return found.counts;
};

export function aiActContract(name: string, make: () => Store): void {
  describe(`ai act contract: ${name}`, () => {
    it('has the gate query and the outcome methods it reads', () => {
      const s = make();
      for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    });

    it('a cell with no rows is absent, and an empty store gives no rows', () => {
      const s = gate(make());
      expect(rows(s)).toEqual([]);
      put(s, row());
      expect(cell(s, '4', 'hostile')).toBeUndefined();
      expect(cell(s, '3', 'severe')).toBeUndefined();
      expect(rows(s)).toHaveLength(1);
    });

    it('counts qualifying rows per cell and window', () => {
      const s = gate(make());
      put(
        s,
        row(),
        row(),
        row({ decidedAt: NOW - 80 * DAY }),
        row({ decidedAt: SINCE - 1 }), // just before the window
        row({ aiSeverity: 'severe' }),
        row({ aiRule: '4' }),
        row({ aiRule: '4', aiSeverity: 'severe' }),
      );
      expect(counts(s, '3', 'hostile').qualifying).toBe(3);
      expect(counts(s, '3', 'severe').qualifying).toBe(1);
      expect(counts(s, '4', 'hostile').qualifying).toBe(1);
      expect(counts(s, '4', 'severe').qualifying).toBe(1);
      expect(rows(s).map((r) => `${r.rule}/${r.severity}`)).toEqual(['3/hostile', '3/severe', '4/hostile', '4/severe']);
    });

    it('the window includes its first instant and leaves out the instant before it', () => {
      const s = gate(make());
      put(s, row({ decidedAt: SINCE }), row({ decidedAt: SINCE - 1 }));
      expect(counts(s).qualifying).toBe(1);
      expect(counts(s).firstAt).toBe(SINCE);
    });

    it('orders the cells: numbered rules by number (2 before 10), then the conduct levels in order', () => {
      const s = gate(make());
      put(s, row({ aiRule: '10', aiSeverity: 'hostile' }), row({ aiRule: '2', aiSeverity: 'severe' }), row({ aiRule: '2', aiSeverity: 'hostile' }), row({ aiRule: '2', aiSeverity: 'rude' }));
      expect(rows(s).map((r) => `${r.rule}/${r.severity}`)).toEqual(['2/rude', '2/hostile', '2/severe', '10/hostile']);
    });

    it('ignores rows with source review (a person confirming an AI action cannot promote a cell), and counts human and holdback', () => {
      const s = gate(make());
      put(s, row({ source: 'review' }), row({ source: 'review' }));
      expect(rows(s)).toEqual([]);
      put(s, row({ source: 'human' }), row({ source: 'holdback' }), row({ source: 'review' }));
      expect(counts(s).qualifying).toBe(2);
    });

    it('ignores rows with source service (an integration decided: no deciding moderator), and they add no decider', () => {
      const s = gate(make());
      put(s, row({ source: 'service', decidedBy: null }), row({ source: 'service', decidedBy: 'svc_a' }));
      expect(rows(s)).toEqual([]);
      put(s, row({ source: 'human', decidedBy: 'mod_a' }), row({ source: 'service', decidedBy: 'svc_b' }));
      expect(counts(s)).toMatchObject({ qualifying: 1, deciders: 1 });
    });

    it('a service row round-trips with a null decider', () => {
      const s = gate(make());
      const r = row({ source: 'service', decidedBy: null });
      put(s, r);
      expect(s.loadAiOutcome(r.reportId)).toMatchObject({ source: 'service', decidedBy: null });
    });

    it('a level 1 row (agreement none) is not qualifying', () => {
      const s = gate(make());
      put(s, row({ agreement: 'none', aiVerdict: null, level: 1 }), row({ agreement: 'none', aiRule: '3' }));
      expect(rows(s)).toEqual([]);
    });

    it('a bad-faith row is not qualifying', () => {
      const s = gate(make());
      put(s, row({ badFaith: true, agreement: 'override', verdict: 'no_action' }));
      expect(rows(s)).toEqual([]);
      put(s, row());
      expect(counts(s)).toMatchObject({ qualifying: 1, hardOverride: 0 });
    });

    it('only an upheld, high-confidence recommendation qualifies', () => {
      const s = gate(make());
      put(
        s,
        row({ aiVerdict: 'noted' }),
        row({ aiVerdict: 'no_action', agreement: 'override' }),
        row({ aiVerdict: null }),
        row({ aiConfidence: 'medium' }),
        row({ aiConfidence: 'low' }),
        row({ aiConfidence: null }), // a suspected injection leaves the confidence out: it never earns trust
      );
      expect(rows(s)).toEqual([]);
      put(s, row());
      expect(counts(s).qualifying).toBe(1);
    });

    it('rows with NULL ai_rule or NULL ai_severity are ignored (older rows, and rows written before the gates existed)', () => {
      const s = gate(make());
      put(s, row({ aiRule: null }), row({ aiSeverity: null }), row({ aiRule: null, aiSeverity: null, aiConfidence: null, decidedBy: null }));
      expect(rows(s)).toEqual([]);
    });

    it('counts distinct deciders and the first and last decision', () => {
      const s = gate(make());
      put(
        s,
        row({ decidedBy: 'mod_a', decidedAt: NOW - 60 * DAY }),
        row({ decidedBy: 'mod_a', decidedAt: NOW - 50 * DAY }),
        row({ decidedBy: 'mod_b', decidedAt: NOW - 10 * DAY }),
        row({ decidedBy: null, decidedAt: NOW - 70 * DAY }), // no deciding moderator on record: not a decider, still a decision
      );
      expect(counts(s)).toMatchObject({ qualifying: 4, deciders: 2, firstAt: NOW - 70 * DAY, lastAt: NOW - 10 * DAY });
    });

    it('recent counts the last 30 days only, and its clean agrees with them', () => {
      const s = gate(make());
      put(
        s,
        row({ decidedAt: NOW - 29 * DAY }),
        row({ decidedAt: NOW - 1 * DAY }),
        row({ decidedAt: RECENT }), // the first instant of the recent window is in it
        row({ decidedAt: RECENT - 1 }),
        row({ decidedAt: NOW - 60 * DAY }),
        row({ decidedAt: NOW - 5 * DAY, agreement: 'override', verdict: 'no_action' }),
      );
      expect(counts(s)).toMatchObject({ qualifying: 6, recent: { n: 4, cleanAgree: 3 } });
      expect(cell(s, '3', 'hostile', SINCE, NOW - 2 * DAY)?.counts.recent).toEqual({ n: 1, cleanAgree: 1 });
      expect(cell(s, '3', 'hostile', SINCE, NOW)?.counts.recent).toEqual({ n: 0, cleanAgree: 0 });
      expect(cell(s, '3', 'hostile', SINCE, SINCE)?.counts.recent).toEqual({ n: 6, cleanAgree: 5 });
    });

    it('a clean agree needs the same rule, and not a milder step; a harsher step is still clean', () => {
      const s = gate(make());
      put(
        s,
        row(), // clean
        row({ detail: { ...DETAIL, outcome: 'harsher' } }), // clean
        row({ detail: { ...DETAIL, outcome: 'none' } }), // clean (no pre-fill to compare)
        row({ detail: { ...DETAIL, rule: false } }), // a different rule: a miss
        row({ detail: { ...DETAIL, outcome: 'milder' } }), // a milder step: a miss
      );
      expect(counts(s)).toMatchObject({ qualifying: 5, cleanAgree: 3, hardOverride: 0, reduced: 0 });
    });

    it('a dismissal of an upheld recommendation is a hard override, and not a clean agree', () => {
      const s = gate(make());
      put(s, row({ agreement: 'override', verdict: 'no_action', rule: null, severity: 'banter', detail: { ...DETAIL, verdict: false, outcome: 'none' } }), row());
      expect(counts(s)).toMatchObject({ qualifying: 2, cleanAgree: 1, hardOverride: 1 });
    });

    it('a revoke-reversed row is a hard override and a reduce-reversed row is reduced', () => {
      const s = gate(make());
      const a = row();
      const b = row();
      const c = row();
      put(s, a, b, c, row());
      expect(s.markAiOutcome(a.reportId, { reversed: true, corrective: true })).toBe(true); // a revoke on appeal
      expect(s.markAiOutcome(b.reportId, { reversed: true })).toBe(true); // a reduce on appeal
      expect(counts(s)).toMatchObject({ qualifying: 4, cleanAgree: 2, hardOverride: 1, reduced: 1 });
      // a mark on a row of another kind of source or without a cell changes nothing there
      expect(s.markAiOutcome('nobody', { reversed: true })).toBe(false);
      expect(s.loadAiOutcome(c.reportId)?.reversed).toBe(false);
    });

    it('a dismissal that was later revoked on appeal counts once, as a hard override, and never as reduced', () => {
      const s = gate(make());
      const a = row({ agreement: 'override', verdict: 'no_action' });
      put(s, a);
      s.markAiOutcome(a.reportId, { reversed: true, corrective: true });
      expect(counts(s)).toMatchObject({ qualifying: 1, hardOverride: 1, reduced: 0, cleanAgree: 0 });
    });

    it('the three classes never overlap: clean agree + hard override + reduced is at most qualifying', () => {
      const s = gate(make());
      const marks = [{}, { reversed: true as const }, { reversed: true as const, corrective: true as const }];
      for (let i = 0; i < 9; i += 1) {
        const r = row(i % 3 === 0 ? { agreement: 'override', verdict: 'no_action' } : {});
        put(s, r);
        const m = marks[i % 3];
        if (m !== undefined && Object.keys(m).length > 0) s.markAiOutcome(r.reportId, m);
      }
      const c = counts(s);
      expect(c.cleanAgree + c.hardOverride + c.reduced).toBeLessThanOrEqual(c.qualifying);
      expect(c.qualifying).toBe(9);
    });

    it('a cell is reported whatever the human filed the row under (the AI\'s own rule, not the person\'s)', () => {
      const s = gate(make());
      put(s, row({ rule: '9', severity: 'rude', aiRule: '3', aiSeverity: 'hostile' }));
      expect(counts(s, '3', 'hostile').qualifying).toBe(1);
      expect(cell(s, '9', 'rude')).toBeUndefined();
    });

    it('the reviewed counts are zero in this release (nothing acts yet), with no times', () => {
      const s = gate(make());
      put(s, row());
      expect(counts(s).reviewed).toEqual({ n: 0, confirmed: 0, hardUndo: 0, lastHardUndoAt: null, secondLastHardUndoAt: null });
    });

    it('the new columns round-trip through loadAiOutcome', () => {
      const s = gate(make());
      const r = row({ aiRule: 'uncovered', aiSeverity: 'severe', aiConfidence: 'medium', decidedBy: 'mod_zq', source: 'holdback' });
      put(s, r);
      expect(s.loadAiOutcome(r.reportId)).toMatchObject({ aiRule: 'uncovered', aiSeverity: 'severe', aiConfidence: 'medium', decidedBy: 'mod_zq', source: 'holdback' });
    });

    it('a row with no AI columns reads back as nulls and the default source human', () => {
      const s = gate(make());
      const r = row({ aiRule: null, aiSeverity: null, aiConfidence: null, decidedBy: null });
      put(s, r);
      expect(s.loadAiOutcome(r.reportId)).toMatchObject({ aiRule: null, aiSeverity: null, aiConfidence: null, decidedBy: null, source: 'human' });
    });

    it('a repeated insert for the report is refused and changes nothing', () => {
      const s = gate(make());
      const r = row();
      put(s, r);
      expect(s.insertAiOutcome({ ...r, aiRule: '4' })).toBe(false);
      expect(counts(s).qualifying).toBe(1);
      expect(cell(s, '4', 'hostile')).toBeUndefined();
    });

    it('purge removes a row from its cell (the outcomes live their own retention)', () => {
      const s = gate(make());
      put(s, row({ decidedAt: NOW - 80 * DAY }), row({ decidedAt: NOW - 1 * DAY }));
      expect(s.purgeAi(0, NOW - 40 * DAY, 0)).toMatchObject({ outcomes: 1 });
      expect(counts(s).qualifying).toBe(1);
    });

    it('is a read: asking twice gives the same answer and writes nothing', () => {
      const s = gate(make());
      put(s, row(), row({ decidedBy: 'mod_b' }));
      const first = rows(s);
      expect(rows(s)).toEqual(first);
      expect(first[0]?.counts.qualifying).toBe(2);
    });

    it('answers with copies: changing a returned row does not change the next answer', () => {
      const s = gate(make());
      put(s, row());
      const first = rows(s);
      (first[0] as AiGateRow).counts.qualifying = 999;
      (first[0] as AiGateRow).counts.recent.n = 999;
      expect(counts(s)).toMatchObject({ qualifying: 1, recent: { n: 1 } });
    });
    // "Do not automate" (design 6.4): a closed code, who set it and when, per person. Not a casebook row: it has no retention of its own.
    describe('the do-not-automate mark', () => {
      type MarkStore = Required<Pick<Store, 'setNoAutomation' | 'loadNoAutomation'>>;
      const mark = (s: Store): Store & MarkStore => {
        for (const m of ['setNoAutomation', 'loadNoAutomation'] as const) if (s[m] === undefined) throw new Error(`this store has no ${m}`);
        return s as Store & MarkStore;
      };

      it('has both methods', () => {
        const s = make();
        expect(typeof s.setNoAutomation).toBe('function');
        expect(typeof s.loadNoAutomation).toBe('function');
      });

      it('set, get and clear round-trip', () => {
        const s = mark(make());
        expect(s.loadNoAutomation('s_a')).toBeNull();
        s.setNoAutomation('s_a', { code: 'vulnerable', setBy: 'sen_ann', setAt: NOW });
        expect(s.loadNoAutomation('s_a')).toEqual({ subject: 's_a', code: 'vulnerable', setBy: 'sen_ann', setAt: NOW });
        // a second set replaces the row (one row per person)
        s.setNoAutomation('s_a', { code: 'staff', setBy: 'sen_bo', setAt: NOW + 1 });
        expect(s.loadNoAutomation('s_a')).toEqual({ subject: 's_a', code: 'staff', setBy: 'sen_bo', setAt: NOW + 1 });
        expect(s.loadNoAutomation('s_b')).toBeNull();
        s.setNoAutomation('s_a', null);
        expect(s.loadNoAutomation('s_a')).toBeNull();
        // clearing what is not there is fine
        expect(() => s.setNoAutomation('s_a', null)).not.toThrow();
        expect(() => s.setNoAutomation('s_zz', null)).not.toThrow();
      });

      it('answers with copies', () => {
        const s = mark(make());
        s.setNoAutomation('s_a', { code: 'other', setBy: 'sen_ann', setAt: NOW });
        const first = s.loadNoAutomation('s_a');
        (first as { code: string }).code = 'changed';
        expect(s.loadNoAutomation('s_a')?.code).toBe('other');
      });

      it('the mark survives purge, whatever the cutoff', () => {
        const s = mark(make());
        s.setNoAutomation('s_a', { code: 'under_review', setBy: 'sen_ann', setAt: NOW - 400 * DAY });
        const far = NOW + 10_000 * DAY;
        s.purgeAi?.(far, far, far);
        s.purgeReports(far, far);
        s.purgeSanctions(far);
        s.purgeStrikes(far);
        s.purgeMutes(far);
        s.purgeNotices(far);
        s.purgeAudit(far);
        s.purgeAppeals?.(far);
        s.purgeSignals?.(far);
        s.purgeLinks?.(far);
        expect(s.loadNoAutomation('s_a')).toMatchObject({ code: 'under_review', setAt: NOW - 400 * DAY });
      });

      it('a rolled-back transaction leaves no mark', () => {
        const s = mark(make());
        expect(() =>
          s.transaction(() => {
            s.setNoAutomation('s_a', { code: 'other', setBy: 'sen_ann', setAt: NOW });
            throw new Error('undo');
          }),
        ).toThrow('undo');
        expect(s.loadNoAutomation('s_a')).toBeNull();
      });
    });
  });
}
