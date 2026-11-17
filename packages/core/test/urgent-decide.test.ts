import { describe, expect, it } from 'vitest';
import { defaultReporting } from '../src/reporting.js';
import { HOUR, MIN, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// U4: a welfare report is never a reporter's false report. `bad_faith` is refused on it, it is left out of the reporter's accuracy and of the habitual ranking, and it
// closes without a rule and never writes a rule-gap row.

const MOD = 'mod_ann';
const EVIDENCE = 'filed the same false report against three players in one evening';
const welfareOn = () => ({ reporting: { reasons: defaultReporting().reasons.map((r) => (r.id === 'welfare' ? { ...r, enabled: true } : r)) } });
const mk = () => world({ overrides: welfareOn() });

describe('deciding a welfare report', () => {
  it('bad_faith is invalid and the report stays open', async () => {
    const w = await mk();
    const f = await w.file({ reason: 'welfare' });
    expect(await w.cw.decide({ reportId: f.id, verdict: 'bad_faith', evidence: EVIDENCE, reason: 'abuse', actions: [], actor: MOD })).toEqual({ ok: false, error: 'invalid' });
    expect(w.store.loadReport(f.id)).toMatchObject({ status: 'open', badFaith: false });
    // the reporter is not counted against
    expect(w.store.loadBadFaithMarks(0)).toEqual([]);
  });

  it('bad_faith on any other report still works (control)', async () => {
    const w = await mk();
    const f = await w.file({ reason: 'harassment' });
    expect(await w.cw.decide({ reportId: f.id, verdict: 'bad_faith', evidence: EVIDENCE, reason: 'abuse', actions: [], actor: MOD })).toMatchObject({ ok: true });
    expect(w.store.loadReport(f.id)).toMatchObject({ status: 'dismissed', badFaith: true });
  });

  it('upheld is invalid on a welfare report: the verdict is noted or no_action', async () => {
    const w = await mk();
    const f = await w.file({ reason: 'welfare' });
    const action = { subject: f.target, kind: 'warning', durationMs: null, rule: 2, lineIds: [] };
    expect(await w.cw.decide({ reportId: f.id, verdict: 'upheld', reason: 'x', actions: [action], actor: MOD } as never)).toEqual({ ok: false, error: 'invalid' });
    expect(w.store.loadReport(f.id)?.status).toBe('open');
  });

  it('no_action closes it with no sanction, no notice and no rule-gap row', async () => {
    const w = await mk();
    const f = await w.file({ reason: 'welfare' });
    expect(await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD })).toMatchObject({ ok: true, replay: false, groups: [] });
    expect(w.store.loadReport(f.id)).toMatchObject({ status: 'dismissed', badFaith: false });
    expect(w.cw.gaps.list()).toEqual([]);
    expect(w.cw.notices.pending({ clientKey: 'key-reporter' })).toEqual([]);
  });

  it('noted (a private record on a real rule) closes it; a note under an uncovered rule, which would write a gap row, is invalid', async () => {
    const w = await mk();
    const f = await w.file({ reason: 'welfare' });
    const g = await w.file({ reason: 'welfare' });
    const note = (subject: string, rule: number | 'uncovered', extra: Record<string, unknown> = {}) => ({ subject, kind: 'note', durationMs: null, rule, lineIds: [], ...extra });
    expect(await w.cw.decide({ reportId: f.id, verdict: 'noted', reason: 'kept a record', actions: [note(f.target, 'uncovered', { gapNote: 'a gap' })], actor: MOD } as never)).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.gaps.list()).toEqual([]);
    expect(await w.cw.decide({ reportId: g.id, verdict: 'noted', reason: 'kept a record', actions: [note(g.target, 2)], actor: MOD } as never)).toMatchObject({ ok: true });
    expect(w.cw.gaps.list()).toEqual([]);
    expect(w.store.loadReport(g.id)?.status).toBe('actioned');
  });

  it('a decision of a welfare report writes no gap row even through the facade path of an uncovered no_action', async () => {
    const w = await mk();
    const f = await w.file({ reason: 'welfare' });
    // an action under an uncovered rule is refused whatever the verdict
    const res = await w.cw.decide({ reportId: f.id, verdict: 'no_action', reason: 'x', actions: [{ subject: f.reporter, kind: 'warning', durationMs: null, rule: 'uncovered', gapNote: 'n', lineIds: [] }], actor: MOD } as never);
    expect(res).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.gaps.list()).toEqual([]);
  });
});

describe('a decided welfare report and the reporter', () => {
  /** A reporter's decided reports: `n` dismissals with the given reason. */
  async function dismissed(w: World, reporter: string, reason: string, n: number) {
    for (let i = 0; i < n; i++) {
      // five hours apart: a reporter may file ten in a day, and these tests file more than that
      w.clock.t += 5 * HOUR;
      const f = await w.file({ reason }, { reporter, target: `t-${reporter}-${reason}-${i}` });
      expect(await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD })).toMatchObject({ ok: true });
    }
    return w.cw.reports.list({ status: 'dismissed', limit: 200 }).items.find((r) => r.reporterSeat === 'p1' && r.reportedReason === reason)?.reporterPerson ?? null;
  }

  it('is not in the reporter\'s accuracy numbers', async () => {
    const w = await mk();
    const person = await dismissed(w, 'rep', 'welfare', 6);
    if (person === null) throw new Error('no reporter');
    expect(w.cw.reports.reporterAccuracy([person]).get(person)).toBeUndefined();
    // an ordinary dismissal counts
    await dismissed(w, 'rep', 'harassment', 1);
    expect(w.cw.reports.reporterAccuracy([person]).get(person)).toMatchObject({ decided: 1, noAction: 1, unfounded: 1 });
  });

  it('does not make a habitual reporter, whatever the count', async () => {
    const w = await mk();
    const person = await dismissed(w, 'rep', 'welfare', 8);
    if (person === null) throw new Error('no reporter');
    expect(w.cw.reports.reporterAccuracy([person]).get(person)?.habitual ?? false).toBe(false);
    // with five ordinary dismissals the reporter IS habitual, and the welfare ones still do not move the rate
    await dismissed(w, 'rep', 'spam', 5);
    const acc = w.cw.reports.reporterAccuracy([person]).get(person);
    expect(acc).toMatchObject({ decided: 5, unfounded: 5, habitual: true });
  });

  it('a welfare report from a habitual reporter is not ranked down by take next with rankDownHabitual (it is urgent in any case)', async () => {
    const w = await mk();
    const person = await dismissed(w, 'rep', 'spam', 5);
    expect(w.cw.reports.reporterAccuracy([person ?? ''])).toBeDefined();
    w.clock.t += MIN;
    const normal = await w.file({ reason: 'harassment' }, { reporter: 'other', target: 't-normal' });
    w.clock.t += MIN;
    const welfare = await w.file({ reason: 'welfare' }, { reporter: 'rep', target: 't-welfare' });
    expect(w.cw.cases.next(MOD, { rankDownHabitual: true })?.reportId).toBe(welfare.id);
    expect(w.cw.cases.next(MOD, { rankDownHabitual: true })?.reportId).toBe(normal.id);
  });
});
