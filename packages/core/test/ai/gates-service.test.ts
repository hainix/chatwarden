import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, withMemoryAi, withMemoryAppeals } from '@chatwarden/store-memory';
import type { MemoryAiStore } from '@chatwarden/store-memory';
import { createFakeModerationAI } from '../../src/ai/fake.js';
import { createInertAi } from '../../src/ai/inert.js';
import { AI_ACT_CAP_DEFAULTS, AI_GATE_DEFAULTS } from '../../src/ai/gates.js';
import { AiService } from '../../src/ai/service.js';
import type { AiGatesView } from '../../src/ai/service.js';
import type { AiAppealFacts } from '../../src/ai/gates.js';
import { suggest } from '../../src/ladder.js';
import { PRESETS } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import type { AiOutcomeInsert } from '../../src/types.js';
import { aiWorld, DAY, NOW } from './aiWorld.js';

// `cw.ai.gates()` (design 5.5 and 6.3): every cell the profile could ever act on, with each gate's value, need and verdict, and the reach preview.
// Read-only: it computes from the store and the clock and nothing else, and nothing in it lets the AI act (release 1 has no acting).

const ACTIVE_RULES = starterRules('standard').filter((r) => r.retired !== true).map((r) => r.number);

const strict = { profile: 'strict' } as const;
const appealsOn = { overrides: { ai: { level: 2 as const }, appeals: { enabled: true } } };
/** A kit with in-kit appeals on (the in-memory store needs its opt-in appeals wrapper for that). */
const appealsWorld = () => aiWorld({ level: 2, over: { profile: 'strict', ...appealsOn }, store: withMemoryAppeals(withMemoryAi(new MemoryStore())) });

let seq = 0;
/** One qualifying decision in cell (`rule`, `severity`): the AI upheld with high confidence and a person agreed, as `by`, `ago` ms before now. */
const decision = (rule: number, severity: 'hostile' | 'severe', by: string, decidedAt: number, over: Partial<AiOutcomeInsert> = {}): AiOutcomeInsert => {
  seq += 1;
  return {
    reportId: `gs${seq}`,
    readId: null,
    decidedAt,
    level: 2,
    verdict: 'upheld',
    rule: String(rule),
    severity,
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
    badFaith: false,
    example: null,
    aiRule: String(rule),
    aiSeverity: severity,
    aiConfidence: 'high',
    decidedBy: by,
    source: 'human',
    ...over,
  };
};
const seed = (w: { store: unknown }, rows: AiOutcomeInsert[]): void => {
  for (const r of rows) expect((w.store as MemoryAiStore).insertAiOutcome(r)).toBe(true);
};
/** `n` clean decisions in a cell over the last `spanDays` days, alternating two moderators; the newest `recent` of them are inside the last 30 days. */
const clean = (rule: number, severity: 'hostile' | 'severe', n: number, spanDays = 60): AiOutcomeInsert[] =>
  Array.from({ length: n }, (_, i) => decision(rule, severity, i % 2 === 0 ? 'mod_a' : 'mod_b', NOW - Math.floor((i / Math.max(1, n - 1)) * spanDays * DAY)));

/** The service on its own (no kit around it), over the strict preset, for what the kit's own wiring cannot be made to do. */
function build(o: { exclude?: unknown; appealFacts?: (cells: ReadonlyArray<{ rule: number; level: 'hostile' | 'severe' }>) => AiAppealFacts[] } = {}) {
  const store = withMemoryAi(new MemoryStore());
  const base = PRESETS.strict;
  const service = new AiService({
    options: { adapter: createFakeModerationAI([]) },
    store,
    clock: { now: () => NOW },
    logger: undefined,
    profile: () => ({ ...base, ai: { ...base.ai, level: 2, ...(o.exclude === undefined ? {} : { actExcludeRules: o.exclude }) } }) as never,
    rules: defineRules(starterRules('standard')),
    suggest: (_subject, level, rule) => suggest(base, [], level, rule, NOW),
    subscribe: () => () => undefined,
    audit: () => true,
    exampleRetentionMs: () => 0,
    ...(o.appealFacts === undefined ? {} : { appealFacts: o.appealFacts }),
  });
  return { service, store };
}

const cellOf = (view: AiGatesView, rule: number, level: 'hostile' | 'severe') => view.cells.find((c) => c.rule === rule && c.level === level);

describe('gates(): which cells', () => {
  it('lists each rule x aiAutoAct level and nothing for banter, rude or uncovered', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    const view = w.cw.ai.gates();
    expect(view.version).toBe(1);
    expect(view.cells.map((c) => `${c.rule}/${c.level}`)).toEqual(ACTIVE_RULES.flatMap((n) => [`${n}/hostile`, `${n}/severe`]));
    for (const c of view.cells) {
      expect(['hostile', 'severe']).toContain(c.level);
      expect(typeof c.rule).toBe('number');
    }
    expect(view.cells.some((c) => (c.level as string) === 'banter' || (c.level as string) === 'rude' || (c.rule as unknown) === 'uncovered')).toBe(false);
  });

  it('follows the profile: the standard preset lists severe only, and an empty aiAutoAct lists nothing', async () => {
    const standard = await aiWorld({ level: 2, over: { profile: 'standard' } });
    expect(standard.cw.ai.gates().cells.map((c) => c.level)).toEqual(ACTIVE_RULES.map(() => 'severe'));
    const none = await aiWorld({ level: 2, over: { profile: 'strict', overrides: { ai: { level: 2 }, aiAutoAct: [] } } });
    expect(none.cw.ai.gates().cells).toEqual([]);
  });

  it('a retired rule has no cell, and a rule that is added shows at once', async () => {
    const rules = defineRules([...starterRules('standard'), { number: 20, title: 'Old', text: 'Gone.', retired: true }, { number: 21, title: 'New', text: 'Be kind.' }]);
    const w = await aiWorld({ level: 2, over: { profile: 'strict', rules } });
    const numbers = new Set(w.cw.ai.gates().cells.map((c) => c.rule));
    expect(numbers.has(20)).toBe(false);
    expect(numbers.has(21)).toBe(true);
  });

  it('each cell carries the reach preview for its own rule and level, the counts and the appeals facts', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    const c = cellOf(w.cw.ai.gates(), 3, 'hostile');
    expect(c?.reach.map((r) => r.record)).toEqual(['clean', 'oneWarning', 'chat24h', 'ban7d']);
    expect(c?.reach[0]).toMatchObject({ step: { kind: 'chat', durationMs: DAY }, withinCeilings: true });
    expect(c?.counts).toMatchObject({ qualifying: 0, cleanAgree: 0, deciders: 0, firstAt: null, lastAt: null });
    expect(c?.appeals).toMatchObject({ available: false });
    expect(c?.actsToday).toBe(0);
    const sev = cellOf(w.cw.ai.gates(), 3, 'severe');
    expect(sev?.reach[0]?.withinCeilings).toBe(false);
  });

  it('the window and the clock are in the view', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    const view = w.cw.ai.gates();
    expect(view.windowDays).toBe(AI_GATE_DEFAULTS.windowDays);
    expect(view.at).toBe(w.clock.t);
    expect(view.instance).toEqual({
      capHour: { used: 0, max: 10 },
      capDay: { used: 0, max: 50 },
      reviewDebt: { unreviewed: 0, oldestMs: null, max: 25, maxMs: 72 * 3_600_000 },
    });
  });
});

describe('gates(): the numbers', () => {
  it('computes from the store and the clock only: changing nothing else changes nothing', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    seed(w, clean(3, 'hostile', 40));
    const first = w.cw.ai.gates();
    expect(w.cw.ai.gates()).toEqual(first);
    // Something unrelated happening (a report filed, the AI reading it) moves no number of any cell.
    await w.report();
    await w.idle();
    const after = w.cw.ai.gates();
    expect(after.cells).toEqual(first.cells);
    // The clock is an input: a day later the window start moves, and `at` with it.
    w.clock.t += DAY;
    expect(w.cw.ai.gates().at).toBe(after.at + DAY);
    // A decision in the store is an input.
    seed(w, [decision(3, 'hostile', 'mod_c', w.clock.t)]);
    expect(cellOf(w.cw.ai.gates(), 3, 'hostile')?.counts.qualifying).toBe(41);
  });

  it('counts only the window: a decision older than the window is not in the cell, and one inside is', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    seed(w, [decision(3, 'hostile', 'mod_a', NOW - 89 * DAY), decision(3, 'hostile', 'mod_a', NOW - 91 * DAY)]);
    expect(cellOf(w.cw.ai.gates(), 3, 'hostile')?.counts.qualifying).toBe(1);
  });

  it('a cell with a few decisions shows every check failing and why, and is closed', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    seed(w, clean(3, 'hostile', 10));
    const c = cellOf(w.cw.ai.gates(), 3, 'hostile');
    expect(c?.open).toBe(false);
    expect(c?.checks.map((k) => k.name)).toEqual(['volume', 'breadth', 'agreement', 'override', 'recency', 'appeals_rule', 'appeals_acts', 'keep']);
    expect(c?.checks.find((k) => k.name === 'volume')).toEqual({ name: 'volume', ok: false, value: 10, need: 'min:100' });
    expect(c?.checks.find((k) => k.name === 'breadth')?.ok).toBe(true);
  });

  it('a cell with 100 qualifying decisions and clean numbers is open in the view but actingAvailable is false', async () => {
    const w = await appealsWorld();
    seed(w, clean(3, 'hostile', 100));
    const view = w.cw.ai.gates();
    const c = cellOf(view, 3, 'hostile');
    expect(c?.counts).toMatchObject({ qualifying: 100, cleanAgree: 100, deciders: 2 });
    expect(c?.appeals.available).toBe(true);
    expect(c?.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual([]);
    expect(c?.open).toBe(true);
    // Release 1 never acts: an open cell is a number on a dashboard, not a licence.
    expect(view.actingAvailable).toBe(false);
    expect(w.cw.ai.status()).toBeDefined();
  });

  it('99 is not open, and the cell beside it (the other level, another rule) is untouched', async () => {
    const w = await appealsWorld();
    seed(w, clean(3, 'hostile', 99));
    const view = w.cw.ai.gates();
    expect(cellOf(view, 3, 'hostile')?.open).toBe(false);
    expect(cellOf(view, 3, 'severe')?.counts.qualifying).toBe(0);
    expect(cellOf(view, 4, 'hostile')?.counts.qualifying).toBe(0);
  });

  it('a decision confirmed from an AI action (source review) does not count', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    seed(w, [decision(3, 'hostile', 'mod_a', NOW - DAY, { source: 'review' })]);
    expect(cellOf(w.cw.ai.gates(), 3, 'hostile')?.counts.qualifying).toBe(0);
  });

  it('a rule the AI named but the human filed under another counts in the AI cell, not the human one', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    seed(w, [decision(3, 'hostile', 'mod_a', NOW - DAY, { rule: '4', severity: 'severe' })]);
    const view = w.cw.ai.gates();
    expect(cellOf(view, 3, 'hostile')?.counts.qualifying).toBe(1);
    expect(cellOf(view, 4, 'severe')?.counts.qualifying).toBe(0);
  });

  it('a cell the store knows that the profile does not list (a rule that was retired, or banter) is not shown', async () => {
    const w = await aiWorld({ level: 2, over: strict });
    seed(w, [decision(99, 'hostile', 'mod_a', NOW - DAY), decision(3, 'rude' as never, 'mod_a', NOW - DAY, { aiSeverity: 'rude' }), decision(3, 'hostile', 'mod_a', NOW - DAY, { aiRule: 'uncovered' })]);
    const view = w.cw.ai.gates();
    expect(view.cells.some((c) => c.rule === 99)).toBe(false);
    expect(view.cells.every((c) => c.counts.qualifying === 0)).toBe(true);
  });
});

describe('gates(): appeals', () => {
  it('marks every appeals check unavailable when cw.appeals is absent or disabled', async () => {
    for (const over of [strict, { profile: 'strict' as const, overrides: { ai: { level: 2 as const }, appeals: { enabled: false } } }]) {
      const w = await aiWorld({ level: 2, over });
      seed(w, clean(3, 'hostile', 100));
      const view = w.cw.ai.gates();
      for (const c of view.cells) {
        expect(c.appeals).toEqual({ available: false, ruleSanctions: 0, ruleRevokes: 0, ruleReduces: 0, actRevokeAt: null });
        expect(c.checks.find((k) => k.name === 'appeals_rule')?.ok).toBe(false);
        expect(c.checks.find((k) => k.name === 'appeals_acts')?.ok).toBe(false);
        expect(c.open).toBe(false);
      }
    }
  });

  it('with appeals on, the facts are the rule-wide sanctions and revokes, the same for both levels of a rule', async () => {
    const w = await appealsWorld();
    const view = w.cw.ai.gates();
    for (const c of view.cells) expect(c.appeals).toEqual({ available: true, ruleSanctions: 0, ruleRevokes: 0, ruleReduces: 0, actRevokeAt: null });
    expect(cellOf(view, 3, 'hostile')?.checks.find((k) => k.name === 'appeals_rule')).toMatchObject({ ok: true, value: null });
  });

  it('a throwing appeals read leaves every fact unavailable, not the view broken', () => {
    const { service } = build({ appealFacts: () => { throw new Error('boom'); } });
    try {
      const view = service.gates();
      expect(view.cells.length).toBeGreaterThan(0);
      expect(view.cells.every((c) => !c.appeals.available)).toBe(true);
    } finally {
      service.close();
    }
  });

  it('an appeals read that answers the wrong number of cells is not trusted', () => {
    const { service } = build({ appealFacts: () => [{ available: true, ruleSanctions: 5, ruleRevokes: 0, ruleReduces: 0, actRevokeAt: null }] });
    try {
      expect(service.gates().cells.every((c) => !c.appeals.available)).toBe(true);
    } finally {
      service.close();
    }
  });
});

describe('gates(): never throws, and is empty when there is nothing to show', () => {
  it('gates() never throws and returns an empty view with the AI off, without an adapter, or on a store failure', async () => {
    // The AI off (level 0).
    const off = await aiWorld({ level: 0, over: strict });
    expect(off.cw.ai.gates()).toMatchObject({ version: 1, actingAvailable: false, cells: [] });
    // No adapter at all: the inert facade.
    const inert = createInertAi().gates();
    expect(inert).toMatchObject({ version: 1, actingAvailable: false, cells: [], windowDays: AI_GATE_DEFAULTS.windowDays });
    // The inert file may not import the gates (the browser bundle holds no AI module), so its numbers are written out: they must be the real ones.
    expect(inert.instance).toEqual({ capHour: { used: 0, max: AI_ACT_CAP_DEFAULTS.perHour }, capDay: { used: 0, max: AI_ACT_CAP_DEFAULTS.perDay }, reviewDebt: { unreviewed: 0, oldestMs: null, max: AI_ACT_CAP_DEFAULTS.reviewDebtMax, maxMs: AI_ACT_CAP_DEFAULTS.reviewWithinMs } });
    expect(inert.instance).toEqual(off.cw.ai.gates().instance);
    // A store failure.
    const w = await aiWorld({ level: 2, over: strict });
    vi.spyOn(w.store as MemoryAiStore, 'aiGateRows').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => w.cw.ai.gates()).not.toThrow();
    expect(w.cw.ai.gates()).toMatchObject({ cells: [], actingAvailable: false });
    expect(w.logged.some(([event]) => event === 'ai.gates_failed')).toBe(true);
    // The log names a class only.
    expect(JSON.stringify(w.logged)).not.toContain('disk full');
  });

  it('a store without the gate query answers an empty view too (an adapter written before 0.1.13)', async () => {
    const store = withMemoryAi(new MemoryStore());
    Object.defineProperty(store, 'aiGateRows', { value: undefined });
    const w = await aiWorld({ level: 2, over: strict, store });
    expect(w.cw.ai.gates().cells).toEqual([]);
  });

  it('a profile that fails to read gives an empty view', async () => {
    const adapter = createFakeModerationAI([]);
    const store = withMemoryAi(new MemoryStore());
    let calls = 0;
    const service = new AiService({
      options: { adapter },
      store,
      clock: { now: () => NOW },
      logger: undefined,
      profile: () => {
        calls += 1;
        throw new Error('no profile');
      },
      rules: defineRules(starterRules('standard')),
      suggest: () => ({ outcome: 'none', label: '', why: '' }),
      subscribe: () => () => undefined,
      audit: () => true,
      exampleRetentionMs: () => 0,
    });
    try {
      expect(service.gates()).toMatchObject({ cells: [] });
      expect(calls).toBeGreaterThan(0);
    } finally {
      service.close();
    }
  });
});

describe('gates(): excluded rules', () => {
  it('a rule in ai.actExcludeRules is shown as excluded, not hidden, and its cells are never open', () => {
    const { service, store } = build({ exclude: [2] });
    try {
      for (const r of clean(2, 'hostile', 150)) store.insertAiOutcome(r);
      const view = service.gates();
      const hidden = view.cells.filter((c) => c.rule === 2);
      expect(hidden.map((c) => c.level)).toEqual(['hostile', 'severe']);
      expect(hidden.every((c) => c.excluded === true && c.open === false)).toBe(true);
      expect(view.cells.filter((c) => c.rule !== 2).every((c) => c.excluded === false)).toBe(true);
      // Its numbers are still shown: excluded is a verdict on the cell, not a deletion of the data.
      expect(hidden[0]?.counts.qualifying).toBe(150);
    } finally {
      service.close();
    }
  });

  it('nothing excluded when the field is absent, empty or not a list of rule numbers', () => {
    for (const value of [undefined, [], 'rule 2', [0, -1, 1.5, '2'], null, {}]) {
      const { service } = build({ exclude: value });
      try {
        expect(service.gates().cells.every((c) => c.excluded === false), JSON.stringify(value)).toBe(true);
      } finally {
        service.close();
      }
    }
  });
});

describe('gates(): no identifier, no text, no report id', () => {
  it('gates() carries no identifier, no text and no report id (deep search of a seeded world)', async () => {
    const w = await appealsWorld();
    const t = w.table({ reporter: 'key-reporter-distinct-7731', target: 'key-target-distinct-7732' });
    w.cw.chat.accept(t.room, 'p2', 'zorbak vlemmo distinct words quissel');
    w.clock.t += 1_000;
    const filed = await w.submit(t.room, { note: 'distinct reporter note drakkuun' });
    if (!filed.ok) throw new Error('refused');
    await w.idle();
    // Decisions by a moderator with a distinctive ref, in the cell, so the counts have something in them.
    seed(w, [decision(3, 'hostile', 'mod_distinct_zq9981', NOW - DAY, { reportId: filed.reportId, readId: 'read-distinct-5521' })]);
    const view = w.cw.ai.gates();
    expect(cellOf(view, 3, 'hostile')?.counts.deciders).toBe(1);
    const text = JSON.stringify(view);
    for (const secret of ['key-reporter-distinct-7731', 'key-target-distinct-7732', t.reporter, t.target, filed.reportId, 'read-distinct-5521', 'mod_distinct_zq9981', 'distinct words', 'drakkuun', 'zorbak', t.room]) {
      expect(text, secret).not.toContain(secret);
    }
    // Every leaf is a number, a boolean, null, or a short fixed word (a name, a kind, a need code, a record, a label of the ladder step).
    const leaves: unknown[] = [];
    const walk = (v: unknown): void => {
      if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
      else leaves.push(v);
    };
    walk(view);
    for (const leaf of leaves) {
      if (typeof leaf === 'string') expect(leaf.length, leaf).toBeLessThan(60);
      else expect(['number', 'boolean', 'object']).toContain(typeof leaf);
    }
  });
});
