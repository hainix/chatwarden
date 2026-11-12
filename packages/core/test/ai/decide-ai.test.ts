import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { fakeRead } from '../../src/ai/fake.js';
import type { FakeStep } from '../../src/ai/fake.js';
import type { AIReadInput } from '../../src/ai/types.js';
import type { DecisionInput } from '../../src/decide.js';
import { aiWorld } from './aiWorld.js';
import type { AiWorld } from './aiWorld.js';

// A decision made with the AI's read in front of the moderator records one outcome row in the decision's own transaction, computed on
// the server from the stored read and the decision. The client only echoes which read it saw and whether it clicked accept.

const RULE = 2;
const ownRef = (input: AIReadInput): string => input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1';
/** An AI that recommends `verdict` under rule 2 at conduct level `severity`, citing the reported player's first line. */
const recommends =
  (verdict: 'upheld' | 'noted' | 'no_action' | 'unclear', severity: 'banter' | 'rude' | 'hostile' | 'severe' = 'rude') =>
  (input: AIReadInput): FakeStep => ({
    output: fakeRead(input, {
      severity,
      rule: RULE,
      evidence: [ownRef(input)],
      recommendation: { verdict, severity, rule: RULE, evidence: verdict === 'no_action' || verdict === 'unclear' ? [] : [ownRef(input)] },
    }),
  });

const store = (w: AiWorld): MemoryStore => w.store as MemoryStore;

/** A decision by moderator `mod_ann`, with the echo of the read. */
const decision = (
  w: AiWorld,
  r: { id: string; target: string },
  over: Partial<DecisionInput> & { ai?: DecisionInput['ai'] } = {},
): DecisionInput => {
  const view = w.cw.ai.read(r.id);
  const lineIds = store(w).loadAiRead(r.id)?.read?.recommendation?.evidence ?? [];
  return {
    reportId: r.id,
    verdict: 'upheld',
    actions: [{ subject: r.target, kind: 'warning', durationMs: null, rule: RULE, lineIds }],
    reason: 'rude to a teammate',
    actor: 'mod_ann',
    ai: { readId: view?.id ?? 'none', accepted: false, role: 'moderator' },
    ...over,
  };
};

describe('the outcome row', () => {
  it('is written with the decision, from the stored read and the decision', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    const readId = w.cw.ai.read(r.id)?.id;
    const res = await w.cw.decide(decision(w, r));
    expect(res).toMatchObject({ ok: true, replay: false });
    const row = store(w).loadAiOutcome(r.id);
    expect(row).toMatchObject({
      reportId: r.id,
      readId,
      level: 2,
      verdict: 'upheld',
      rule: String(RULE),
      aiVerdict: 'upheld',
      agreement: 'agree',
      badFaith: false,
      reversed: false,
      dontTeach: false,
    });
    expect(row?.detail).toMatchObject({ verdict: true, rule: true, lines: 1, oneClick: false });
    expect(row?.decidedAt).toBe(w.clock.t);
  });

  it('the outcome row is written in the decision transaction', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    let depth = 0;
    let insertedInside = false;
    const tx = store(w).transaction.bind(store(w));
    vi.spyOn(store(w), 'transaction').mockImplementation(((fn: () => unknown) =>
      tx(() => {
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      })) as never);
    const insert = store(w).insertAiOutcome.bind(store(w));
    vi.spyOn(store(w), 'insertAiOutcome').mockImplementation(((row: Parameters<typeof insert>[0]) => {
      insertedInside = depth > 0;
      return insert(row);
    }) as never);
    await w.cw.decide(decision(w, r));
    expect(insertedInside).toBe(true);
    expect(store(w).loadAiOutcome(r.id)).not.toBeNull();
  });

  it('a failed decision writes none', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    // Refused before any write: a rule nobody can cite.
    const bad = await w.cw.decide(decision(w, r, { actions: [{ subject: r.target, kind: 'warning', durationMs: null, rule: 99 }] }));
    expect(bad).toEqual({ ok: false, error: 'invalid' });
    expect(store(w).loadAiOutcome(r.id)).toBeNull();
    // A store failure in the middle of the transaction: everything rolls back, the outcome with it.
    vi.spyOn(store(w), 'insertDecision').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(w.cw.decide(decision(w, r))).rejects.toThrow('disk full');
    expect(store(w).loadAiOutcome(r.id)).toBeNull();
    expect(store(w).loadReport(r.id)?.status).toBe('open');
  });

  it('a replayed decision writes no second row', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    const insert = vi.spyOn(store(w), 'insertAiOutcome');
    const first = await w.cw.decide(decision(w, r));
    w.clock.t += 60_000;
    const again = await w.cw.decide(decision(w, r));
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(store(w).loadAiOutcome(r.id)?.decidedAt).toBe(w.clock.t - 60_000);
    expect(w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items).toHaveLength(1);
  });

  it('a different decision on a decided report writes nothing either', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r));
    const other = await w.cw.decide(decision(w, r, { verdict: 'no_action', actions: [], ai: { readId: 'x', accepted: false, role: 'moderator' } }));
    expect(other).toEqual({ ok: false, error: 'already_decided' });
    expect(store(w).loadAiOutcome(r.id)?.verdict).toBe('upheld');
  });

  it('the decision answers the same with or without an echo', async () => {
    const withEcho = await aiWorld({ level: 2, script: recommends('upheld') });
    const a = await withEcho.report();
    await withEcho.idle();
    const without = await aiWorld({ level: 2, script: recommends('upheld') });
    const b = await without.report();
    await without.idle();
    const x = await withEcho.cw.decide(decision(withEcho, a));
    const y = await without.cw.decide({ ...decision(without, b), ai: undefined });
    const shape = (res: typeof x) => (res.ok ? { ok: true, replay: res.replay, groups: res.groups.map((g) => [g.kind, g.noticeId === null]) } : res);
    expect(shape(x)).toEqual(shape(y));
    expect(store(without).loadAiOutcome(b.id)).toBeNull();
  });
});

describe('the audit row', () => {
  it('an ai.outcome audit row is written best-effort and its failure does not fail the decision', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r));
    const rows = w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'mod_ann', role: 'moderator', action: 'ai.outcome', target: { type: 'report', ref: r.id } });
    expect(rows[0]?.detail).toBeUndefined();

    const w2 = await aiWorld({ level: 2, script: recommends('upheld') });
    const r2 = await w2.report();
    await w2.idle();
    vi.spyOn(w2.cw.audit, 'record').mockImplementation(() => {
      throw new Error('audit down');
    });
    const res = await w2.cw.decide(decision(w2, r2));
    expect(res).toMatchObject({ ok: true });
    expect(store(w2).loadAiOutcome(r2.id)).not.toBeNull();
  });

  it('no role in the echo means no audit row (the caller keeps its own trail)', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r, { ai: { readId: w.cw.ai.read(r.id)?.id ?? 'x', accepted: true } }));
    expect(store(w).loadAiOutcome(r.id)).not.toBeNull();
    expect(w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items).toHaveLength(0);
  });
});

describe('agreement is computed on the server', () => {
  it('a forged accepted flag does not change agreement', async () => {
    const w = await aiWorld({ level: 2, script: recommends('no_action', 'banter') });
    const r = await w.report();
    await w.idle();
    // The AI says no action; the human upholds; the client claims it accepted the AI's suggestion.
    await w.cw.decide(decision(w, r, { ai: { readId: w.cw.ai.read(r.id)?.id ?? 'x', accepted: true, role: 'moderator' } }));
    const row = store(w).loadAiOutcome(r.id);
    expect(row?.agreement).toBe('override');
    expect(row?.detail.oneClick).toBe(true);
  });

  it('an unknown or other-report readId falls back to the newest read', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const a = await w.report();
    const b = await w.report();
    await w.idle();
    const aRead = w.cw.ai.read(a.id)?.id;
    const bRead = w.cw.ai.read(b.id)?.id;
    await w.cw.decide(decision(w, a, { ai: { readId: 'no-such-read', accepted: false, role: 'moderator' } }));
    expect(store(w).loadAiOutcome(a.id)?.readId).toBe(aRead);
    // The id of another report's read does not let a decision borrow that read.
    await w.cw.decide(decision(w, b, { ai: { readId: aRead as string, accepted: false, role: 'moderator' } }));
    expect(store(w).loadAiOutcome(b.id)?.readId).toBe(bRead);
  });

  it('an override: the human dismisses what the AI would uphold', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r, { verdict: 'no_action', actions: [], reason: undefined }));
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ agreement: 'override', aiVerdict: 'upheld', verdict: 'no_action', rule: null });
  });

  it('a bad_faith verdict sets bad_faith and is an override', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r, { verdict: 'bad_faith', actions: [], evidence: 'filed the same report in three rooms' }));
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ agreement: 'override', badFaith: true, verdict: 'no_action', example: null });
  });

  it('the step is compared with what the ladder pre-fills for the AI conduct level', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld', 'rude') });
    const r = await w.report();
    await w.idle();
    const rec = w.cw.ai.read(r.id)?.recommendation;
    const prefill = rec?.step;
    expect(prefill).not.toBeNull();
    // A note is milder than any pre-filled warning or restriction.
    await w.cw.decide(decision(w, r, { verdict: 'noted', actions: [{ subject: r.target, kind: 'note', durationMs: null, rule: RULE }] }));
    expect(store(w).loadAiOutcome(r.id)?.detail.outcome).toBe('milder');
  });
});

describe('when there is nothing to record', () => {
  it('no echo, no outcome (a bulk dismissal or a webhook decision is not a look at the read)', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide({ ...decision(w, r), ai: undefined });
    expect(store(w).loadAiOutcome(r.id)).toBeNull();
    const second = await w.report();
    await w.idle();
    await w.cw.reports.dismissMany({ scope: { person: second.target }, actor: 'mod_ann' });
    expect(store(w).loadAiOutcome(second.id)).toBeNull();
  });

  it('a malformed echo is ignored: the decision still lands', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    for (const ai of [null, 5, 'x', {}, { readId: 5, accepted: true }, { readId: '', accepted: true }, { readId: 'a', accepted: 'yes' }, { readId: 'x'.repeat(500), accepted: true }]) {
      const r = await w.report();
      await w.idle();
      const res = await w.cw.decide(decision(w, r, { ai: ai as never }));
      expect(res).toMatchObject({ ok: true });
      expect(store(w).loadAiOutcome(r.id)).toBeNull();
    }
  });

  it('level 0 records nothing', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    const res = await w.cw.decide(decision(w, r));
    expect(res).toMatchObject({ ok: true });
    expect(store(w).loadAiOutcome(r.id)).toBeNull();
  });

  it('level 1 records a none: the recommendation was not shown', async () => {
    const w = await aiWorld({ level: 1, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r));
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ level: 1, agreement: 'none', aiVerdict: null });
  });

  it('an unclear recommendation, or no read yet, records a none', async () => {
    const w = await aiWorld({ level: 2, script: recommends('unclear') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r));
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ agreement: 'none', aiVerdict: null });

    const w2 = await aiWorld({ level: 2, script: [{ hang: true }], ai: { timeoutMs: 30 } });
    const r2 = await w2.report();
    await w2.idle();
    await w2.cw.decide(decision(w2, r2, { ai: { readId: 'whatever', accepted: false, role: 'moderator' } }));
    expect(store(w2).loadAiOutcome(r2.id)).toMatchObject({ agreement: 'none', readId: null });
  });

  it('an insertAiOutcome that throws does not fail the decision', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    vi.spyOn(store(w), 'insertAiOutcome').mockImplementation(() => {
      throw new Error('table gone');
    });
    const res = await w.cw.decide(decision(w, r));
    expect(res).toMatchObject({ ok: true, replay: false });
    expect(store(w).loadReport(r.id)?.status).toBe('actioned');
  });

  it('a store without the AI methods records nothing and decides as before', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld') });
    const r = await w.report();
    await w.idle();
    // The AI service needed them at creation; a store that loses them later (a test double) must not break a decision.
    (store(w) as unknown as Record<string, unknown>).insertAiOutcome = undefined;
    const res = await w.cw.decide(decision(w, r));
    expect(res).toMatchObject({ ok: true });
  });
});

describe('severity', () => {
  it('is the conduct level the echo names, when it is one', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld', 'rude') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r, { ai: { readId: w.cw.ai.read(r.id)?.id ?? 'x', accepted: false, role: 'moderator', severity: 'hostile' } }));
    expect(store(w).loadAiOutcome(r.id)?.severity).toBe('hostile');
  });

  it('otherwise follows the AI on an agree, is banter for a dismissal, and unknown for the rest', async () => {
    const agree = await aiWorld({ level: 2, script: recommends('upheld', 'hostile') });
    const a = await agree.report();
    await agree.idle();
    await agree.cw.decide(decision(agree, a));
    expect(store(agree).loadAiOutcome(a.id)?.severity).toBe('hostile');

    const dismiss = await aiWorld({ level: 2, script: recommends('upheld', 'hostile') });
    const b = await dismiss.report();
    await dismiss.idle();
    await dismiss.cw.decide(decision(dismiss, b, { verdict: 'no_action', actions: [], reason: undefined }));
    expect(store(dismiss).loadAiOutcome(b.id)?.severity).toBe('banter');

    const override = await aiWorld({ level: 2, script: recommends('no_action', 'banter') });
    const c = await override.report();
    await override.idle();
    await override.cw.decide(decision(override, c));
    expect(store(override).loadAiOutcome(c.id)?.severity).toBeNull();
  });

  it('an echo with a severity that is not a conduct level is treated as having none', async () => {
    const w = await aiWorld({ level: 2, script: recommends('upheld', 'rude') });
    const r = await w.report();
    await w.idle();
    await w.cw.decide(decision(w, r, { ai: { readId: w.cw.ai.read(r.id)?.id ?? 'x', accepted: false, role: 'moderator', severity: 'extreme' as never } }));
    // Falls back to the AI's level, because the decision agreed.
    expect(store(w).loadAiOutcome(r.id)?.severity).toBe('rude');
  });
});
