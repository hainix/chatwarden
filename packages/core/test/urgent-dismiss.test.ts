import { describe, expect, it } from 'vitest';
import { MIN, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// U4: a bulk dismissal never closes an urgent report: it leaves it open and counts it in skipped.urgent. A single dismissal is a person reading the report, and is allowed.

const MOD = 'mod_ann';

/** Reports against ONE person from separate reporters, with the given reasons. */
async function against(w: World, target: string, reasons: Array<string | undefined>) {
  const ids: string[] = [];
  let person = '';
  for (const [i, reason] of reasons.entries()) {
    w.clock.t += MIN;
    const f = await w.file(reason === undefined ? {} : { reason }, { reporter: `rk-${target}-${i}`, target });
    ids.push(f.id);
    person = f.target;
  }
  return { ids, person };
}

describe('dismissMany and urgent reports', () => {
  it('by person: urgent open reports stay open and are counted in skipped.urgent; the ordinary ones are dismissed', async () => {
    const w = await world();
    const { ids, person } = await against(w, 'tk', ['harassment', 'threat', 'spam', 'threat']);
    const res = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD });
    expect(res).toMatchObject({ ok: true, dryRun: false, open: 2, dismissed: 2, replayed: 0, skipped: { claimed: 0, decided: 0, urgent: 2 } });
    if (!res.ok) throw new Error('expected ok');
    expect(res.reportIds.sort()).toEqual([ids[0], ids[2]].sort());
    expect(w.store.loadReport(ids[1] as string)?.status).toBe('open');
    expect(w.store.loadReport(ids[3] as string)?.status).toBe('open');
    expect(w.store.loadReport(ids[0] as string)?.status).toBe('dismissed');
  });

  it('by reporter: the same', async () => {
    const w = await world();
    const reporter = 'serial';
    const ids: string[] = [];
    let who = '';
    for (const [i, reason] of (['threat', 'harassment', 'threat', 'spam'] as const).entries()) {
      w.clock.t += 2 * 3_600_000;
      const f = await w.file({ reason }, { reporter, target: `tk-${i}` });
      ids.push(f.id);
      who = f.reporter;
    }
    const res = await w.cw.reports.dismissMany({ scope: { reporter: who }, actor: MOD });
    expect(res).toMatchObject({ ok: true, dismissed: 2, skipped: { claimed: 0, decided: 0, urgent: 2 } });
    expect(ids.map((id) => w.store.loadReport(id)?.status)).toEqual(['open', 'dismissed', 'open', 'dismissed']);
  });

  it('a dry run counts them and writes nothing', async () => {
    const w = await world();
    const { ids, person } = await against(w, 'tk', ['threat', 'harassment', 'threat']);
    const res = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD, dryRun: true });
    expect(res).toMatchObject({ ok: true, dryRun: true, open: 1, dismissed: 0, skipped: { claimed: 0, decided: 0, urgent: 2 } });
    expect(ids.map((id) => w.store.loadReport(id)?.status)).toEqual(['open', 'open', 'open']);
  });

  it('a person with only urgent reports: nothing is dismissed, nothing replayed, every one counted', async () => {
    const w = await world();
    const { person } = await against(w, 'tk', ['threat', 'threat']);
    const res = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD });
    expect(res).toMatchObject({ ok: true, open: 0, dismissed: 0, replayed: 0, skipped: { claimed: 0, decided: 0, urgent: 2 }, more: false, reportIds: [], targets: [] });
  });

  it('with no urgent report the answer has urgent 0 and behaves as before', async () => {
    const w = await world();
    const { person } = await against(w, 'tk', ['harassment', 'spam']);
    const res = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD });
    expect(res).toMatchObject({ ok: true, dismissed: 2, skipped: { claimed: 0, decided: 0, urgent: 0 } });
  });

  it('a report a moderator marked urgent is skipped the same way, and one marked not urgent again is dismissed', async () => {
    const w = await world();
    const { ids, person } = await against(w, 'tk', ['harassment', 'harassment']);
    w.store.setReportUrgent?.(ids[0] as string, true);
    const first = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD, dryRun: true });
    expect(first).toMatchObject({ open: 1, skipped: { urgent: 1 } });
    w.store.setReportUrgent?.(ids[0] as string, false);
    const second = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD });
    expect(second).toMatchObject({ dismissed: 2, skipped: { urgent: 0 } });
  });

  it('a held urgent case counts as urgent, not claimed, and the ordinary reports of a held case count as claimed', async () => {
    const w = await world();
    const { person } = await against(w, 'tk', ['threat', 'harassment']);
    expect(w.cw.cases.claim(person, 'mod_bea')).toMatchObject({ ok: true });
    const res = await w.cw.reports.dismissMany({ scope: { person }, actor: MOD });
    expect(res).toMatchObject({ ok: true, open: 0, dismissed: 0, skipped: { claimed: 1, decided: 0, urgent: 1 } });
  });

  it('the single dismissal of an urgent report is allowed', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    expect(await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD })).toMatchObject({ ok: true });
    expect(w.store.loadReport(f.id)?.status).toBe('dismissed');
  });

  it('skipped urgent reports do not appear in onClosed', async () => {
    const w = await world();
    const { ids, person } = await against(w, 'tk', ['threat', 'harassment']);
    const closed: string[] = [];
    await w.cw.reports.dismissMany({ scope: { person }, actor: MOD, onClosed: (id) => void closed.push(id) });
    expect(closed).toEqual([ids[1]]);
  });
});
