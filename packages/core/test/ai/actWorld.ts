import { MemoryStore, withMemoryAi, withMemoryAppeals } from '@chatwarden/store-memory';
import type { MemoryAiStore, MemoryAppealStore } from '@chatwarden/store-memory';
import { expect } from 'vitest';
import { AiActionService } from '../../src/aiActor/service.js';
import type { AiActionDeps } from '../../src/aiActor/service.js';
import { AI_ACT_CAPS_DEFAULTS } from '../../src/ai/caps.js';
import { fakeRead } from '../../src/ai/fake.js';
import type { AIRead, AIReadInput } from '../../src/ai/types.js';
import { hmacSha256Hex } from '../../src/crypto.js';
import type { AiActionRow, AiOutcomeInsert } from '../../src/types.js';
import { aiWorld, DAY, MIN, NOW } from './aiWorld.js';
import type { AiWorld, AiWorldOptions } from './aiWorld.js';

// A kit in which the AI could act (in shadow): the strict preset (the AI may act on hostile and severe), in-kit appeals on, level 2, `maxLevel: 3` with `ai.act`, and a cell
// (rule 2, hostile) that has earned it on paper. Over the memory store with its opt-in AI and appeals methods. No network, no key.

export { DAY, MIN, NOW };
export const RULE = 2;
export const SECRET = 'reporting-secret';

export const ownRef = (input: AIReadInput): string => input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1';

/** An AI that answers every call, a read or a confirming read, with `upheld` at high confidence for rule 2 at hostile, citing the reported player's first line. */
export const upheldHigh =
  (over: Partial<AIRead> = {}) =>
  (input: AIReadInput): { output: AIRead } => ({
    output: fakeRead(input, { severity: 'hostile', rule: RULE, confidence: 'high', evidence: [ownRef(input)], recommendation: { verdict: 'upheld', severity: 'hostile', rule: RULE, evidence: [ownRef(input)] }, ...over }),
  });

let seq = 0;
/** One qualifying decision in cell (rule 2, hostile), by `by`. */
export const decision = (by: string, decidedAt: number, over: Partial<AiOutcomeInsert> = {}): AiOutcomeInsert => {
  seq += 1;
  return {
    reportId: `act-seed-${seq}`,
    readId: null,
    decidedAt,
    level: 2,
    verdict: 'upheld',
    rule: String(RULE),
    severity: 'hostile',
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
    badFaith: false,
    example: null,
    aiRule: String(RULE),
    aiSeverity: 'hostile',
    aiConfidence: 'high',
    decidedBy: by,
    source: 'human',
    ...over,
  };
};

export interface ActWorldOptions extends AiWorldOptions {
  /** Put the cell (2, hostile) on paper as earned: 120 clean decisions by two moderators over 60 days. Default true. */
  earned?: boolean;
  /** Start the owner's shadow step. Default true. */
  shadow?: boolean;
}

/** The writers of a sanction, a notice, a strike, a mute and a decision: nothing the AI does in this release may call one. */
export const FORBIDDEN_WRITERS = ['insertSanctionGroup', 'revokeSanctionGroup', 'closeReport', 'insertDecision', 'insertNotice', 'withdrawNotice', 'withdrawNoticeGroup', 'insertStrike', 'upsertMute', 'deleteMute'];

export async function actWorld(o: ActWorldOptions = {}) {
  const mem = (o.store ?? withMemoryAppeals(withMemoryAi(new MemoryStore()))) as MemoryAiStore & MemoryAppealStore;
  // The kit runs over a store that notes every call of a writer above, so a test can say "and nothing was written to a person".
  const writerCalls: string[] = [];
  const store = new Proxy(mem, {
    get: (t, k) => {
      const v: unknown = (t as unknown as Record<string | symbol, unknown>)[k];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]): unknown => {
        if (typeof k === 'string' && FORBIDDEN_WRITERS.includes(k)) writerCalls.push(k);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
  const w = await aiWorld({
    level: 2,
    script: upheldHigh(),
    ...o,
    store,
    ai: { maxLevel: 3, act: {}, ...(o.ai ?? {}) },
    over: { profile: 'strict', overrides: { ai: { level: 2, ...(o.dailyCalls === undefined ? {} : { dailyCalls: o.dailyCalls }) }, appeals: { enabled: true } } as never, ...(o.over ?? {}) },
  });
  if (o.earned !== false) for (let i = 0; i < 120; i += 1) mem.insertAiOutcome(decision(i % 2 === 0 ? 'mod_a' : 'mod_b', NOW - Math.floor((i / 119) * 60 * DAY)));
  if (o.shadow !== false) {
    const res = w.cw.ai.acting.startShadow('owner_ann', { confirm: 'ACT', reason: 'we are ready' });
    if (!res.ok) throw new Error(`shadow refused: ${res.error}`);
  }
  const rowOf = (reportId: string): AiActionRow | null => mem.loadAiAction(reportId);
  /** A new report with the AI's read and, when acting is on, its action row. */
  const file = async (texts?: string[]) => {
    const r = await w.report(texts);
    await w.idle();
    return r;
  };
  /** Files reports until one is queued (the holdback is a fixed share of ids, so some are held back). */
  const candidate = async (texts?: string[]) => {
    for (let i = 0; i < 60; i += 1) {
      const r = await file(texts);
      if (rowOf(r.id)?.state === 'queued') return r;
    }
    throw new Error('no queued candidate in 60 reports');
  };
  /** Files reports until one is held back. */
  const heldBack = async () => {
    for (let i = 0; i < 80; i += 1) {
      const r = await file();
      if (rowOf(r.id)?.state === 'held_back') return r;
    }
    throw new Error('no held-back report in 80 reports');
  };
  /** Move the clock to just after the hold of this report and run the sweeper once, with every read it asks for finished. */
  const due = async (reportId: string): Promise<void> => {
    const row = rowOf(reportId);
    if (row === null) throw new Error('no action row');
    w.clock.t = Math.max(w.clock.t, row.notBefore + 1);
    await sweep();
  };
  const sweep = async (): Promise<void> => {
    await w.cw.ai.sweep();
    await w.idle();
  };
  /** The actor, built from the public kit the way the kit builds its own: for what the sweeper cannot be made to hand it. */
  const actor = (over: Partial<AiActionDeps> = {}): AiActionService =>
    new AiActionService({
      store,
      clock: w.clock,
      profile: () => w.cw.profile,
      rules: w.cw.rules,
      suggest: (subject, level, rule, ctx) => w.cw.suggest(subject, level, rule, ctx),
      acting: () => w.cw.ai.acting.state(),
      appealsEnabled: () => w.cw.appeals.enabled(),
      gates: () => w.cw.ai.gates(),
      automationAllowed: (p) => w.cw.people.automation.get(p).allowed,
      reporter: (s) => {
        const a = w.cw.reports.reporterAccuracy([s]).get(w.cw.people.canonical(s));
        return { habitual: a?.habitual === true, badFaith: (a?.badFaith ?? 0) > 0 };
      },
      aliases: (s) => w.cw.people.aliases(s),
      adapterId: w.adapter.id,
      confirmAdapterId: w.adapter.id,
      mask: false,
      caps: AI_ACT_CAPS_DEFAULTS,
      holdback: (input) => hmacSha256Hex(SECRET, input),
      audit: (i) => w.cw.audit.record(i),
      ...over,
    });
  return { ...w, store: mem, writerCalls, rowOf, file, candidate, heldBack, due, sweep, actor };
}

export type ActWorld = Awaited<ReturnType<typeof actWorld>>;
export type { AiWorld };
export const expectShadow = (row: AiActionRow | null): void => {
  expect(row?.state).toBe('shadow');
};
