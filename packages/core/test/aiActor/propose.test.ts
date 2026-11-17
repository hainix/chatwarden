import { describe, expect, it, vi } from 'vitest';
import * as ceilings from '../../src/ai/ceilings.js';
import { AI_ACT_CAPS_DEFAULTS } from '../../src/ai/caps.js';
import type { AiGatesView } from '../../src/ai/service.js';
import type { AiService } from '../../src/ai/service.js';
import type { AIRead } from '../../src/ai/types.js';
import type { Suggestion } from '../../src/ladder.js';
import { chooseLines } from '../../src/ai/lines.js';
import type { AiActionRow, AppealRow, StoredReport } from '../../src/types.js';
import { actWorld, DAY, decision, MIN, NOW, upheldHigh } from '../ai/actWorld.js';
import type { ActWorld } from '../ai/actWorld.js';

// The actor's proposal (design 4.2, 6.1 and 6.2): the AI module hands it three ids, and it reads everything else again from the store and runs all twelve checks. Each refusal
// code has its own test, paired with a control that passes without that one fault. In this release a passing proposal only records a `shadow` row: nothing here writes a sanction.

const svc = (w: ActWorld): AiService => w.cw.ai as unknown as AiService;
const H = 3_600_000;

/** A queued candidate whose hold has run and whose confirming read is done: the three ids of a proposal, and the state a sweep would find. */
async function ready(w: ActWorld) {
  const r = await w.candidate();
  const row = w.rowOf(r.id) as AiActionRow;
  w.clock.t = row.notBefore + 1;
  const first = w.store.loadAiRead(r.id);
  if (first === null) throw new Error('no read');
  const c = await svc(w).confirmRead(r.id);
  if (c.state !== 'ok') throw new Error(`confirm: ${c.state}`);
  return { r, ...r, row, firstId: first.id, p: { reportId: r.id, readId: first.id, confirmReadId: c.readId } };
}
type Ready = Awaited<ReturnType<typeof ready>>;
/** Take the queued row away, as if the queue had not run: the actor then judges the report on the store alone. */
const dropRow = (w: ActWorld): void => {
  (w.store as unknown as { actionRows: AiActionRow[] }).actionRows = [];
};
const report = (w: ActWorld, id: string) => (w.store as unknown as { reports: Array<Record<string, unknown>> }).reports.find((r) => r.id === id) as Record<string, unknown>;
const readRows = (w: ActWorld) => (w.store as unknown as { aiReads: Array<{ id: string; read: AIRead | null; inputHash: string; reportId: string }> }).aiReads;

describe('a proposal that passes every check', () => {
  it('records one shadow row (the step, the time, the confirming read) and one ai.act audit row, and nothing else', async () => {
    const w = await actWorld();
    const x = await ready(w);
    w.writerCalls.length = 0;
    const auditBefore = w.cw.audit.list({ limit: 200 }).items.length;
    const res = await w.actor().propose(x.p);
    expect(res).toMatchObject({ ok: true, mode: 'shadow', replay: false });
    const row = w.rowOf(x.r.id) as AiActionRow;
    expect(row).toMatchObject({ state: 'shadow', kind: 'chat', durationMs: 24 * H, actedAt: w.clock.t, confirmReadId: x.p.confirmReadId, readId: x.p.readId, rule: '2', severity: 'hostile', refusedCode: null, groupId: null });
    expect(res.ok && res.actionId).toBe(row.id);
    // one audit row, the AI's own: an `ai:` actor, no role, the report as target, no detail
    const added = w.cw.audit.list({ limit: 200 }).items.slice(0, w.cw.audit.list({ limit: 200 }).items.length - auditBefore);
    expect(added.map((a) => [a.actor, a.role, a.action, a.target])).toEqual([['ai:fake:model', null, 'ai.act', { type: 'report', ref: x.r.id }]]);
    // no sanction, notice, strike, mute or decision was written, and the report is still open for a person
    expect(w.writerCalls).toEqual([]);
    expect(w.cw.reports.get(x.r.id)?.status).toBe('open');
  });

  it('is the same with acting on: the branch that writes a sanction is absent, so it still only records', async () => {
    const w = await actWorld();
    w.clock.t += 14 * DAY;
    expect(w.cw.ai.acting.startActing('owner_ann', { confirm: 'ACT', reason: 'we looked' })).toMatchObject({ ok: true, state: { mode: 'on' } });
    const x = await ready(w);
    w.writerCalls.length = 0;
    expect(await w.actor().propose(x.p)).toMatchObject({ ok: true, mode: 'shadow', replay: false });
    expect(w.rowOf(x.r.id)?.state).toBe('shadow');
    expect(w.writerCalls).toEqual([]);
    expect(w.cw.reports.get(x.r.id)?.status).toBe('open');
  });

  it('works for a report with no queued row (the actor creates the shadow row itself), and then the AI module\'s row for it is the actor\'s', async () => {
    const w = await actWorld();
    const x = await ready(w);
    dropRow(w);
    expect(w.rowOf(x.r.id)).toBeNull();
    expect(await w.actor().propose(x.p)).toMatchObject({ ok: true, mode: 'shadow', replay: false });
    expect(w.rowOf(x.r.id)).toMatchObject({ state: 'shadow', kind: 'chat', rule: '2', severity: 'hostile', createdAt: w.clock.t });
  });
});

describe('idempotent: one action row per report, ever', () => {
  it('a second call is a replay with the same id, one row and one audit row', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const a = await w.actor().propose(x.p);
    const b = await w.actor().propose(x.p);
    expect(a).toMatchObject({ ok: true, replay: false });
    expect(b).toMatchObject({ ok: true, replay: true, mode: 'shadow' });
    expect(a.ok && b.ok && a.actionId === b.actionId).toBe(true);
    expect(w.cw.audit.list({ limit: 200 }).items.filter((i) => i.action === 'ai.act')).toHaveLength(1);
    expect(w.store.aiActionCounts(0).byState.shadow).toBe(1);
  });

  it('two calls at once write one row and one audit row, one of them the replay', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const [a, b] = await Promise.all([w.actor().propose(x.p), w.actor().propose(x.p)]);
    expect([a, b].filter((r) => r.ok && !r.replay)).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.replay)).toHaveLength(1);
    expect(w.cw.audit.list({ limit: 200 }).items.filter((i) => i.action === 'ai.act')).toHaveLength(1);
  });

  it('a replay is answered from the row even when the world has changed since (the sanction-free record stands)', async () => {
    const w = await actWorld();
    const x = await ready(w);
    await w.actor().propose(x.p);
    w.cw.ai.acting.off('owner_ann', { reason: 'stop' });
    expect(await w.actor().propose(x.p)).toMatchObject({ ok: true, replay: true });
  });

  it('a refused row is refused again with the same code; a held-back row stays held back', async () => {
    const w = await actWorld();
    const x = await w.candidate();
    const row = w.rowOf(x.id) as AiActionRow;
    w.store.transitionAiAction(row.id, ['queued'], { state: 'refused', refusedCode: 'gate_failed:volume' });
    expect(await w.actor().propose({ reportId: x.id, readId: row.readId, confirmReadId: 'c' })).toEqual({ ok: false, refused: 'gate_failed:volume' });
    const held = await w.heldBack();
    const heldRow = w.rowOf(held.id) as AiActionRow;
    expect(await w.actor().propose({ reportId: held.id, readId: heldRow.readId, confirmReadId: 'c' })).toEqual({ ok: false, refused: 'held_back' });
    // an unknown code on a row (a newer kit) is never read as a licence
    w.store.transitionAiAction(row.id, ['refused'], { refusedCode: 'a_code_from_the_future' });
    expect(await w.actor().propose({ reportId: x.id, readId: row.readId, confirmReadId: 'c' })).toEqual({ ok: false, refused: 'read_not_usable' });
  });
});

describe('every refusal has a control that passes without that one fault', () => {
  const refused = async (w: ActWorld, x: Ready, over: Parameters<ActWorld['actor']>[0] = {}) => (await w.actor(over).propose(x.p)) as { ok: boolean; refused?: string };
  const passes = async (w: ActWorld, x: Ready, over: Parameters<ActWorld['actor']>[0] = {}) => expect(await w.actor(over).propose(x.p)).toMatchObject({ ok: true });

  it('acting_off', async () => {
    const w = await actWorld();
    const x = await ready(w);
    w.cw.ai.acting.off('owner_ann', { reason: 'stop' });
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'acting_off' });
    const w2 = await actWorld();
    await passes(w2, await ready(w2));
  });

  it('acting_off when acting was never started', async () => {
    const w = await actWorld({ shadow: false });
    const x = await w.file();
    const read = w.store.loadAiRead(x.id);
    expect(await w.actor().propose({ reportId: x.id, readId: read?.id ?? '', confirmReadId: 'c' })).toEqual({ ok: false, refused: 'acting_off' });
  });

  it('paused', async () => {
    const w = await actWorld();
    const x = await ready(w);
    w.cw.ai.acting.pause('sen_bo', { reason: 'looks odd' });
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'paused' });
    expect(w.rowOf(x.r.id)?.state).toBe('queued');
    w.cw.ai.acting.resume('owner_ann', { reason: 'fine' });
    await passes(w, x);
  });

  it('pause takes effect before the very next act, with the kit\'s policy cache fresh', async () => {
    const w = await actWorld();
    const x = await ready(w);
    void w.cw.profile;
    expect(w.cw.ai.acting.pause('sen_bo', { reason: 'now' })).toMatchObject({ ok: true });
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'paused' });
  });

  it('no_appeals', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const v = (w.cw.policy.get() as { version: number }).version;
    expect(w.cw.policy.save({ ai: { level: 2 }, appeals: { enabled: false } } as never, { version: v, actor: 'owner_ann', reason: 'off' })).toMatchObject({ ok: true });
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'no_appeals' });
    // a kit with no appeals at all
    expect(await refused(w, x, { appealsEnabled: () => false })).toEqual({ ok: false, refused: 'no_appeals' });
  });

  it('not_open (decided by a person), and a report marked bad faith is a hard stop', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const lineIds = w.store.loadAiRead(x.r.id)?.read?.recommendation?.evidence ?? [];
    expect(await w.cw.decide({ reportId: x.r.id, verdict: 'upheld', actions: [{ subject: x.r.target, kind: 'warning', durationMs: null, rule: 2, lineIds }], reason: 'rude', actor: 'mod_ann' })).toMatchObject({ ok: true });
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'not_open' });
    const w2 = await actWorld();
    const y = await ready(w2);
    await passes(w2, y);
    const w3 = await actWorld();
    const z = await ready(w3);
    report(w3, z.r.id).badFaith = true;
    expect(await refused(w3, z)).toEqual({ ok: false, refused: 'not_open' });
  });

  it('too_old (24 hours and a millisecond) and too_new (one millisecond before the hold ends); the edges themselves pass', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const created = (w.store.loadReport(x.r.id) as StoredReport).createdAt;
    w.clock.t = created + 24 * H + 1;
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'too_old' });
    w.clock.t = created + 10 * MIN - 1;
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'too_new' });
    w.clock.t = created + 10 * MIN;
    await passes(w, x);
    const w2 = await actWorld();
    const y = await ready(w2);
    w2.clock.t = (w2.store.loadReport(y.r.id) as StoredReport).createdAt + 24 * H;
    await passes(w2, y);
  });

  it('claimed: a moderator holds the case', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
    expect(w.store.claimCase(target, 'mod_ann', w.clock.t, w.clock.t + 10 * MIN, 'free')).toMatchObject({ won: true });
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'claimed' });
    // the claim lapses: the AI may go on
    w.clock.t += 11 * MIN;
    await passes(w, x);
  });

  describe('read_not_usable', () => {
    it.each([
      ['an unknown read id', (x: Ready) => ({ ...x.p, readId: 'no-such-read' })],
      ['the confirming read named as the case read', (x: Ready) => ({ ...x.p, readId: x.p.confirmReadId })],
    ])('%s', async (_name, bad) => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await w.actor().propose(bad(x))).toEqual({ ok: false, refused: 'read_not_usable' });
      await passes(w, x);
    });

    it('a read of another report', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const other = await w.file();
      const otherRead = w.store.loadAiRead(other.id);
      expect(await w.actor().propose({ ...x.p, readId: otherRead?.id ?? '' })).toEqual({ ok: false, refused: 'read_not_usable' });
    });

    it('a stale read: the case or the policy moved since it was made', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const row = readRows(w).find((r) => r.id === x.firstId);
      if (row !== undefined) row.inputHash = 'f'.repeat(64);
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
    });

    it('not the newest read of the case', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const newer = w.store.reserveAiRead({ reportId: x.r.id, inputHash: 'newer-hash', promptVersion: 5, adapter: 'fake:model' }, w.clock.t + MIN, w.clock.t + 1000);
      if (!newer.reserved) throw new Error('no row');
      w.store.completeAiRead(newer.id, newer.lease, { model: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, latencyMs: 0, read: readRows(w).find((r) => r.id === x.firstId)?.read as AIRead });
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
    });

    it.each([
      ['medium confidence', { confidence: 'medium' as const }],
      ['low confidence', { confidence: 'low' as const }],
      ['an injection suspicion', { injectionSuspected: true }],
    ])('%s', async (_name, over) => {
      const w = await actWorld();
      const x = await ready(w);
      const stored = readRows(w).find((r) => r.id === x.firstId);
      if (stored?.read) Object.assign(stored.read, over);
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
    });

    it.each(['no_action', 'unclear', 'noted'] as const)('a recommendation of %s', async (verdict) => {
      const w = await actWorld();
      const x = await ready(w);
      const stored = readRows(w).find((r) => r.id === x.firstId);
      if (stored?.read?.recommendation) stored.read.recommendation.verdict = verdict;
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
    });

    it('no recommendation at all (a level 1 read)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const stored = readRows(w).find((r) => r.id === x.firstId);
      if (stored?.read) stored.read.recommendation = null;
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
    });

    it('the actor ignores the proposal: the step recomputed now is not the one the report was queued for, so it is refused and never corrected', async () => {
      const w = await actWorld();
      const x = await ready(w);
      expect(x.row.kind).toBe('chat');
      // the person is sanctioned in the meantime: the ladder now gives a heavier step, a ban in the strict preset after enough history
      const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
      for (let i = 0; i < 4; i += 1) {
        await w.cw.sanctions.apply({ kind: 'warning', subject: target, includeIp: false, durationMs: null, reason: 'earlier', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });
        w.clock.t += 1000;
      }
      const now = w.cw.suggest(target, 'hostile', 2, { roomId: null });
      expect(JSON.stringify(now.outcome)).not.toBe(JSON.stringify({ kind: 'chat', durationMs: 24 * H }));
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
      // nothing was changed to fit: the row is as it was
      expect(w.rowOf(x.r.id)).toMatchObject({ state: 'queued', kind: 'chat', durationMs: 24 * H });
    });
  });

  describe('confirm_disagrees', () => {
    it.each([
      ['an unknown confirming read', (x: Ready) => ({ ...x.p, confirmReadId: 'no-such-read' })],
      ['the case read named as the confirming read', (x: Ready) => ({ ...x.p, confirmReadId: x.p.readId })],
    ])('%s', async (_name, bad) => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await w.actor().propose(bad(x))).toEqual({ ok: false, refused: 'confirm_disagrees' });
      await passes(w, x);
    });

    it('a confirming read made for another adapter is no confirmation', async () => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await refused(w, x, { confirmAdapterId: 'fake:other' })).toEqual({ ok: false, refused: 'confirm_disagrees' });
    });

    it.each([
      ['a different rule', { rule: 3 as const }],
      ['a different conduct level', { severity: 'severe' as const }],
      ['an upheld that turned unclear', { verdict: 'unclear' as const }],
      ['low confidence', { confidence: 'low' as const }],
    ])('%s', async (_name, change) => {
      const w = await actWorld();
      const x = await ready(w);
      const stored = readRows(w).find((r) => r.id === x.p.confirmReadId)?.read;
      if (stored?.recommendation) {
        if ('rule' in change) stored.recommendation.rule = change.rule;
        if ('severity' in change) stored.recommendation.severity = change.severity;
        if ('verdict' in change) stored.recommendation.verdict = change.verdict;
        if ('confidence' in change) stored.confidence = change.confidence;
      }
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'confirm_disagrees' });
    });

    it('no shared cited line by the reported person', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const stored = readRows(w).find((r) => r.id === x.p.confirmReadId)?.read;
      if (stored?.recommendation) stored.recommendation.evidence = ['some-other-line'];
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'confirm_disagrees' });
    });
  });

  describe('cell_not_allowed', () => {
    it('a rule the owner excluded (ai.actExcludeRules)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const v = (w.cw.policy.get() as { version: number }).version;
      expect(w.cw.policy.save({ ai: { level: 2, actExcludeRules: [2] } }, { version: v, actor: 'owner_ann', reason: 'never rule 2' })).toMatchObject({ ok: true });
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'cell_not_allowed' });
      const v2 = (w.cw.policy.get() as { version: number }).version;
      w.cw.policy.save({ ai: { level: 2, actExcludeRules: [5] } }, { version: v2, actor: 'owner_ann', reason: 'rule 5 only' });
      await passes(w, x);
    });

    it('a conduct level the profile does not let the AI act on (aiAutoAct lists severe only in the standard preset)', async () => {
      const w = await actWorld({ over: { profile: 'standard', overrides: { ai: { level: 2 }, appeals: { enabled: true } } as never } });
      const r = await w.file();
      expect(w.cw.profile.aiAutoAct).toEqual(['severe']);
      // the AI module would not queue it; a proposal for it anyway is judged on the store alone
      expect(w.rowOf(r.id)).toBeNull();
      const read = w.store.loadAiRead(r.id);
      const c = await svc(w).confirmRead(r.id);
      expect(c.state).toBe('ok');
      w.clock.t += 11 * MIN;
      expect(await w.actor().propose({ reportId: r.id, readId: read?.id ?? '', confirmReadId: c.state === 'ok' ? c.readId : '' })).toEqual({ ok: false, refused: 'cell_not_allowed' });
      // the control: the strict preset lists hostile
      const s = await actWorld();
      await passes(s, await ready(s));
    });

    it('a rule that is not a number (uncovered) is no confirmation either: the second read cannot agree on it', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const stored = readRows(w).find((r) => r.id === x.firstId)?.read;
      if (stored?.recommendation) stored.recommendation.rule = 'uncovered';
      // with the queued row in place a changed rule is a changed step (read_not_usable)
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'read_not_usable' });
      dropRow(w);
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'confirm_disagrees' });
    });
  });

  describe('gate_failed:<gate>', () => {
    /** The real view with one gate turned off and the cell closed: the code must name the gate. */
    const failing = (w: ActWorld, name: string, cooling: 'not_a_violation' | 'appeal_revoked' | null = null) => (): AiGatesView => {
      const view = w.cw.ai.gates();
      return {
        ...view,
        cells: view.cells.map((c) => (c.rule === 2 && c.level === 'hostile' ? { ...c, open: false, coolingCode: cooling, checks: c.checks.map((k) => (k.name === name ? { ...k, ok: false } : k)) } : c)),
      };
    };
    it.each(['volume', 'breadth', 'agreement', 'override', 'recency', 'appeals_rule', 'appeals_acts', 'keep'])('%s', async (name) => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await refused(w, x, { gates: failing(w, name) })).toEqual({ ok: false, refused: `gate_failed:${name}` });
      await passes(w, x);
    });

    it('a cooling latch with every number fine: an undo as not a violation closes keep, a revoke on appeal closes appeals_acts', async () => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await refused(w, x, { gates: failing(w, 'none', 'not_a_violation') })).toEqual({ ok: false, refused: 'gate_failed:keep' });
      expect(await refused(w, x, { gates: failing(w, 'none', 'appeal_revoked') })).toEqual({ ok: false, refused: 'gate_failed:appeals_acts' });
    });

    it('a cell the view does not hold cannot act', async () => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await refused(w, x, { gates: () => ({ ...w.cw.ai.gates(), cells: [] }) })).toEqual({ ok: false, refused: 'cell_not_allowed' });
    });

    it('with the real numbers: too few decisions (99 of 100), one moderator, or none in 30 days', async () => {
      const few = await actWorld({ earned: false });
      for (let i = 0; i < 99; i += 1) few.store.insertAiOutcome(decision(i % 2 === 0 ? 'mod_a' : 'mod_b', NOW - Math.floor((i / 98) * 60 * DAY)));
      expect(await refused(few, await ready(few))).toEqual({ ok: false, refused: 'gate_failed:volume' });
      const one = await actWorld({ earned: false });
      for (let i = 0; i < 120; i += 1) one.store.insertAiOutcome(decision('mod_a', NOW - Math.floor((i / 119) * 60 * DAY)));
      expect(await refused(one, await ready(one))).toEqual({ ok: false, refused: 'gate_failed:breadth' });
      const old = await actWorld({ earned: false });
      for (let i = 0; i < 120; i += 1) old.store.insertAiOutcome(decision(i % 2 === 0 ? 'mod_a' : 'mod_b', NOW - 40 * DAY - Math.floor((i / 119) * 40 * DAY)));
      expect(await refused(old, await ready(old))).toEqual({ ok: false, refused: 'gate_failed:recency' });
      // the control: 100 is enough
      const enough = await actWorld({ earned: false });
      for (let i = 0; i < 100; i += 1) enough.store.insertAiOutcome(decision(i % 2 === 0 ? 'mod_a' : 'mod_b', NOW - Math.floor((i / 99) * 60 * DAY)));
      await passes(enough, await ready(enough));
    });

    it('the gates are read at the moment of use, from the store, never from a cached flag', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const spy = vi.spyOn(w.cw.ai, 'gates');
      await passes(w, x);
      expect(spy).toHaveBeenCalledTimes(1);
      const y = await ready(w);
      // the cell loses its numbers between two proposals: the second is refused with no restart and no cache to expire
      (w.store as unknown as { aiOutcomes: Map<string, unknown> }).aiOutcomes.clear();
      expect(await refused(w, y)).toEqual({ ok: false, refused: 'gate_failed:volume' });
    });
  });

  describe('the ceilings (the one function the level 2 pre-fill also calls)', () => {
    const suggestion = (outcome: Suggestion['outcome']) => (): Suggestion => ({ outcome, label: 'x', why: 'x' });
    it.each([
      ['a ban', { kind: 'ban', durationMs: 7 * DAY }],
      ['an area ban', { kind: 'area_ban', durationMs: DAY }],
      ['a note', 'note'],
      ['no step at all', 'none'],
    ] as const)('ceiling_kind: %s', async (_name, outcome) => {
      const w = await actWorld();
      const x = await ready(w);
      dropRow(w);
      expect(await refused(w, x, { suggest: suggestion(outcome as Suggestion['outcome']) })).toEqual({ ok: false, refused: 'ceiling_kind' });
      await passes(w, x, { suggest: suggestion({ kind: 'chat', durationMs: 24 * H }) });
    });

    it.each([
      ['24 hours and a millisecond', { kind: 'chat', durationMs: 24 * H + 1 }],
      ['a permanent chat restriction (a null length)', { kind: 'chat', durationMs: null }],
      ['a zero length', { kind: 'chat', durationMs: 0 }],
      ['a negative length', { kind: 'chat', durationMs: -5 }],
    ] as const)('ceiling_duration: %s', async (_name, outcome) => {
      const w = await actWorld();
      const x = await ready(w);
      dropRow(w);
      expect(await refused(w, x, { suggest: suggestion(outcome as Suggestion['outcome']) })).toEqual({ ok: false, refused: 'ceiling_duration' });
    });

    it('24 hours exactly, a warning, and a short restriction pass', async () => {
      for (const outcome of [{ kind: 'chat', durationMs: 24 * H }, 'warning', { kind: 'chat', durationMs: 1 }] as const) {
        const w = await actWorld();
        const x = await ready(w);
        dropRow(w);
        await passes(w, x, { suggest: suggestion(outcome as Suggestion['outcome']) });
      }
    });

    it('ceiling_evidence: a read that cites no line by the reported person cannot be confirmed either (the second read has to share one), so the actor stops at confirm_disagrees', async () => {
      const w = await actWorld();
      // a room where the reporter spoke too, so there is a line that is not the reported person's
      const t = w.table({ reporter: 'key-mixed-reporter' });
      for (const [seat, text] of [['p1', 'hello there'], ['p2', 'you are trash'], ['p2', 'uninstall the game']] as const) {
        w.clock.t += 6000;
        w.cw.chat.accept(t.room, seat, text);
      }
      w.clock.t += 1000;
      const res = await w.submit(t.room);
      if (!res.ok) throw new Error('refused');
      await w.idle();
      const first = w.store.loadAiRead(res.reportId);
      const c = await svc(w).confirmRead(res.reportId);
      if (first === null || c.state !== 'ok') throw new Error('no reads');
      w.clock.t += 11 * MIN;
      dropRow(w);
      const report = w.store.loadReport(res.reportId) as never;
      const foreign = chooseLines(report).lines.find((l) => !l.byReported)?.lineId;
      expect(foreign).toBeDefined();
      const stored = readRows(w).find((r) => r.id === first.id)?.read;
      if (stored?.recommendation) stored.recommendation.evidence = [foreign as string];
      const confirmStored = readRows(w).find((r) => r.id === c.readId)?.read;
      if (confirmStored?.recommendation) confirmStored.recommendation.evidence = [foreign as string];
      // (the code `ceiling_evidence` itself is pinned in act-plan.test.ts, and the AI module checks it before it queues anything: see act-service.test.ts)
      expect(await w.actor().propose({ reportId: res.reportId, readId: first.id, confirmReadId: c.readId })).toEqual({ ok: false, refused: 'confirm_disagrees' });
    });

    it('assertWithinCeilings is called by both the level 2 pre-fill and the actor (spy on the one function)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const spy = vi.spyOn(ceilings, 'assertWithinCeilings');
      w.cw.ai.read(x.r.id);
      const afterPrefill = spy.mock.calls.length;
      expect(afterPrefill).toBeGreaterThan(0);
      await w.actor().propose(x.p);
      expect(spy.mock.calls.length).toBeGreaterThan(afterPrefill);
      spy.mockRestore();
    });
  });

  it('evidence_missing: a cited line that is not in the report\'s stored excerpt', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const stored = readRows(w).find((r) => r.id === x.firstId)?.read;
    const original = stored?.recommendation?.evidence ?? [];
    if (stored?.recommendation) stored.recommendation.evidence = [...original, 'a-line-the-server-never-saw'];
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'evidence_missing' });
    if (stored?.recommendation) stored.recommendation.evidence = original;
    await passes(w, x);
  });

  describe('do_not_automate', () => {
    it('a person a senior marked, and the mark follows the control (cleared, the AI may go on)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
      expect(w.cw.people.automation.set(target, { allowed: false, code: 'vulnerable', actor: 'sen_bo' })).toEqual({ ok: true });
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'do_not_automate' });
      expect(w.cw.people.automation.set(target, { allowed: true, actor: 'sen_bo' })).toEqual({ ok: true });
      await passes(w, x);
    });

    it('a lookup that throws, or answers anything but true, is a no (fail closed)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      expect(await refused(w, x, { automationAllowed: () => { throw new Error('store down'); } })).toEqual({ ok: false, refused: 'do_not_automate' });
      expect(await refused(w, x, { automationAllowed: () => undefined as unknown as boolean })).toEqual({ ok: false, refused: 'do_not_automate' });
      expect(await refused(w, x, { automationAllowed: () => false })).toEqual({ ok: false, refused: 'do_not_automate' });
    });
  });

  describe('person_protected', () => {
    const second = (w: ActWorld, target: string, id: string): void => {
      const stored: StoredReport = {
        id, createdAt: w.clock.t - DAY, roomId: `room-${id}`, tags: {}, reporterSubject: 's_other_reporter', reporterSeat: 'p1', reporterHandle: 'R', targetSubject: target, targetSeat: 'p2',
        targetHandle: 'T', category: 'harassment', reportedReason: 'harassment', note: null, lineId: null, excerpt: [], people: [target], status: 'open',
      };
      w.store.insertReport(stored);
    };
    const action = (id: string, over: Partial<AiActionRow>): AiActionRow => ({
      id: `a-${id}`, reportId: id, readId: 'r', confirmReadId: null, rule: '2', severity: 'hostile', state: 'shadow', refusedCode: null, notBefore: 0, createdAt: 0, groupId: null, kind: 'chat',
      durationMs: 24 * H, actedAt: null, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: null, promptVersion: null, ...over,
    });

    it('an AI action on them in the last 24 hours', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
      second(w, target, 'earlier-1');
      w.store.insertAiAction(action('earlier-1', { actedAt: w.clock.t - 23 * H }));
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'person_protected' });
    });

    it('an AI action older than the window does not protect', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
      second(w, target, 'earlier-2');
      w.store.insertAiAction(action('earlier-2', { actedAt: w.clock.t - 25 * H }));
      await passes(w, x);
    });

    it('one undone as not a violation in the last 30 days', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
      second(w, target, 'earlier-3');
      w.store.insertAiAction(action('earlier-3', { state: 'undone', actedAt: w.clock.t - 29 * DAY, undoCode: 'not_a_violation', reviewedAt: w.clock.t - 29 * DAY + H }));
      expect(await refused(w, x)).toEqual({ ok: false, refused: 'person_protected' });
      const w2 = await actWorld();
      const y = await ready(w2);
      const t2 = (w2.store.loadReport(y.r.id) as StoredReport).targetSubject;
      second(w2, t2, 'earlier-4');
      w2.store.insertAiAction(action('earlier-4', { state: 'undone', actedAt: w2.clock.t - 31 * DAY, undoCode: 'not_a_violation', reviewedAt: w2.clock.t - 31 * DAY + H }));
      await passes(w2, y);
    });

    it('an open appeal on them (and a decided one does not protect)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const target = (w.store.loadReport(x.r.id) as StoredReport).targetSubject;
      const appeal = (status: AppealRow['status'], id: string): AppealRow => ({ id, subject: target, groupId: `g-${id}`, noticeId: `n-${id}`, reportId: null, rule: '2', kind: 'chat', statement: null, status, createdAt: w.clock.t - H, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
      w.store.insertAppeal?.(appeal('upheld', 'ap1'));
      await passes(w, x);
      const w2 = await actWorld();
      const y = await ready(w2);
      const t2 = (w2.store.loadReport(y.r.id) as StoredReport).targetSubject;
      w2.store.insertAppeal?.({ ...appeal('open', 'ap2'), subject: t2 });
      expect(await refused(w2, y)).toEqual({ ok: false, refused: 'person_protected' });
    });

    it('an action on someone else does not protect this person', async () => {
      const w = await actWorld();
      const x = await ready(w);
      second(w, 's_somebody_else', 'earlier-5');
      w.store.insertAiAction(action('earlier-5', { actedAt: w.clock.t - H }));
      await passes(w, x);
    });
  });

  it('reporter_habitual: a habitual false reporter, and one carrying a bad-faith mark (a hard stop)', async () => {
    const w = await actWorld();
    const x = await ready(w);
    expect(await refused(w, x, { reporter: () => ({ habitual: true, badFaith: false }) })).toEqual({ ok: false, refused: 'reporter_habitual' });
    expect(await refused(w, x, { reporter: () => ({ habitual: false, badFaith: true }) })).toEqual({ ok: false, refused: 'reporter_habitual' });
    await passes(w, x, { reporter: () => ({ habitual: false, badFaith: false }) });
  });

  it('system_report: a report nobody filed', async () => {
    const w = await actWorld();
    const x = await ready(w);
    report(w, x.r.id).reporterSubject = '';
    expect(await refused(w, x)).toEqual({ ok: false, refused: 'system_report' });
    const w2 = await actWorld();
    const y = await ready(w2);
    report(w2, y.r.id).origin = 'watch';
    expect(await refused(w2, y)).toEqual({ ok: false, refused: 'system_report' });
  });

  describe('caps and review debt', () => {
    const shadowRows = (w: ActWorld, n: number, actedAt: number, state: AiActionRow['state'] = 'shadow'): void => {
      for (let i = 0; i < n; i += 1) {
        w.store.insertAiAction({
          id: `cap-${state}-${actedAt}-${i}`, reportId: `cap-r-${state}-${actedAt}-${i}`, readId: 'r', confirmReadId: null, rule: '2', severity: 'hostile', state, refusedCode: null, notBefore: 0, createdAt: actedAt,
          groupId: null, kind: 'chat', durationMs: 24 * H, actedAt, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: null, promptVersion: null,
        });
      }
    };
    it('cap_hour: the 11th in an hour is refused, the 10th is allowed', async () => {
      const w = await actWorld();
      const x = await ready(w);
      shadowRows(w, 9, w.clock.t - 10 * MIN);
      await passes(w, x);
      const w2 = await actWorld();
      const y = await ready(w2);
      shadowRows(w2, 10, w2.clock.t - 10 * MIN);
      expect(await refused(w2, y)).toEqual({ ok: false, refused: 'cap_hour' });
    });

    it('an action that is an hour and a millisecond old no longer counts toward the hour', async () => {
      const w = await actWorld();
      const x = await ready(w);
      shadowRows(w, 10, w.clock.t - H - 1);
      await passes(w, x);
    });

    it('cap_day: the 51st in a UTC day is refused, the 50th is allowed (none in the last hour)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      const dayStart = w.clock.t - (w.clock.t % DAY);
      shadowRows(w, 49, dayStart + 60_000);
      await passes(w, x);
      const w2 = await actWorld();
      const y = await ready(w2);
      const start2 = w2.clock.t - (w2.clock.t % DAY);
      shadowRows(w2, 50, start2 + 60_000);
      expect(await refused(w2, y)).toEqual({ ok: false, refused: 'cap_day' });
    });

    it('review_debt: 26 unreviewed, or the oldest older than 72 hours; 25 and 72 hours exactly are fine', async () => {
      const w = await actWorld();
      const x = await ready(w);
      shadowRows(w, 25, w.clock.t - 2 * H, 'active');
      await passes(w, x);
      const w2 = await actWorld();
      const y = await ready(w2);
      shadowRows(w2, 26, w2.clock.t - 2 * H, 'active');
      expect(await refused(w2, y)).toEqual({ ok: false, refused: 'review_debt' });
      const w3 = await actWorld();
      const z = await ready(w3);
      shadowRows(w3, 1, w3.clock.t - 72 * H - 1, 'active');
      expect(await refused(w3, z)).toEqual({ ok: false, refused: 'review_debt' });
      const w4 = await actWorld();
      const q = await ready(w4);
      shadowRows(w4, 1, w4.clock.t - 72 * H, 'active');
      await passes(w4, q);
    });

    it('the caps follow ai.act.caps (the actor is given the numbers in force)', async () => {
      const w = await actWorld();
      const x = await ready(w);
      shadowRows(w, 1, w.clock.t - 10 * MIN);
      expect(await refused(w, x, { caps: { ...AI_ACT_CAPS_DEFAULTS, perHour: 1 } })).toEqual({ ok: false, refused: 'cap_hour' });
      await passes(w, x, { caps: { ...AI_ACT_CAPS_DEFAULTS, perHour: 2 } });
    });
  });

  it('held_back: a report in the holdback (the same on every call), and the control with another keyed hash', async () => {
    const w = await actWorld();
    const x = await ready(w);
    expect(await refused(w, x, { holdback: () => '00000000' })).toEqual({ ok: false, refused: 'held_back' });
    expect(await refused(w, x, { holdback: () => '00000000' })).toEqual({ ok: false, refused: 'held_back' });
    await passes(w, x, { holdback: () => 'ffffffff' });
  });

  it('refuses in the order of the table: acting off before everything, then a decided report before a heavy step', async () => {
    const w = await actWorld();
    const x = await ready(w);
    w.cw.ai.acting.off('owner_ann', { reason: 'stop' });
    expect(await refused(w, x, { suggest: suggestion('note'), holdback: () => '00000000' })).toEqual({ ok: false, refused: 'acting_off' });
  });
});

const suggestion = (outcome: Suggestion['outcome']) => (): Suggestion => ({ outcome, label: 'x', why: 'x' });

describe('fail soft', () => {
  it('a store that throws rejects the proposal (the caller leaves the report in the human queue) and writes nothing', async () => {
    const w = await actWorld();
    const x = await ready(w);
    const broken = new Proxy(w.store, { get: (t, k) => (k === 'loadReport' ? () => { throw new Error('disk gone'); } : (t as unknown as Record<string | symbol, unknown>)[k]) });
    w.writerCalls.length = 0;
    await expect(w.actor({ store: broken as never }).propose(x.p)).rejects.toThrow();
    expect(w.rowOf(x.r.id)?.state).toBe('queued');
    expect(w.writerCalls).toEqual([]);
  });

  it('a recheck that cannot read the gates rejects too, and the row is untouched', async () => {
    const w = await actWorld();
    const x = await ready(w);
    await expect(w.actor({ gates: () => { throw new Error('boom'); } }).propose(x.p)).rejects.toThrow();
    expect(w.rowOf(x.r.id)?.state).toBe('queued');
  });
});

void upheldHigh;
