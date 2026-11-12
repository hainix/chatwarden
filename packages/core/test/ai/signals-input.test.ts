import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import type { MemoryAiStore } from '@chatwarden/store-memory';
import { fakeRead } from '../../src/ai/fake.js';
import type { FakeScript } from '../../src/ai/fake.js';
import { inputHash } from '../../src/ai/hash.js';
import { chooseLines, redactReportNote } from '../../src/ai/lines.js';
import { buildAIInput } from '../../src/ai/prompt.js';
import type { BuildAIInputArgs } from '../../src/ai/prompt.js';
import { AI_PROMPT_VERSION, AIError } from '../../src/ai/types.js';
import type { AIReadInput } from '../../src/ai/types.js';
import { PRESETS } from '../../src/profile.js';
import type { PresetName } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import { aiWorld, DAY } from './aiWorld.js';
import { mkReport } from './reportFixtures.js';
import type { LineSpec } from './reportFixtures.js';

// The AI feed of the signals (design 5.7): `feeds.ai` adds one block about the reported person (P1) to the variable part of the prompt, after
// the data. The stable part always carries one paragraph about it (so the cache does not depend on the feed), the hash leaves the block out, and
// the read records what it was shown (`signals_json`).

const SIGNALS = [
  { label: 'Muted by other players', polarity: 'negative' as const, distinct: 5, windowDays: 14 },
  { label: 'Commended by other players', polarity: 'positive' as const, distinct: 2, windowDays: 14 },
];
const KINDS = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  commended: { label: 'Commended by other players', polarity: 'positive' as const },
};
const FEED_AI = { ai: { kinds: ['muted_by_player', 'commended'], windowDays: 14 } };

const lines: LineSpec[] = [
  { who: 'target', text: 'you are a zorbak' },
  { who: 'reporter', text: 'stop it' },
  { who: 'target', text: 'vlemmo quissel' },
];

function make(signals?: BuildAIInputArgs['signals'], preset: PresetName = 'standard'): AIReadInput {
  const report = mkReport(lines, {});
  return buildAIInput({
    policy: { profile: PRESETS[preset], rules: defineRules(starterRules(PRESETS[preset].rules)) },
    reason: null,
    note: redactReportNote(report),
    chosen: chooseLines(report),
    ...(signals === undefined ? {} : { signals }),
  });
}

describe('the prompt version', () => {
  it('moved on (3: version 2 shipped with the AI levels), and the input carries it', () => {
    expect(AI_PROMPT_VERSION).toBe(3);
    expect(make().promptVersion).toBe(3);
  });
});

describe('with the feed off the prompt is what it was', () => {
  it('no signals, an empty list and undefined give the same variable part, the same hash and no signals field', () => {
    const none = make();
    for (const given of [[], undefined] as const) {
      const other = make(given);
      expect(other.prompt.variable).toBe(none.prompt.variable);
      expect(inputHash(other, 'fake:one')).toBe(inputHash(none, 'fake:one'));
      expect('signals' in other).toBe(false);
    }
  });

  it('the stable part is identical with the feed on and off, and carries the paragraph about signal counts either way', () => {
    const off = make();
    const on = make(SIGNALS);
    expect(on.prompt.stable).toBe(off.prompt.stable);
    expect(off.prompt.stable).toMatch(/signal counts/i);
    expect(off.prompt.stable).toMatch(/never evidence/i);
    expect(off.prompt.stable).toMatch(/unclear/);
  });

  it('prompt.stable stays under 9 000 characters under each preset', () => {
    for (const preset of ['relaxed', 'standard', 'strict'] as const) expect(make(SIGNALS, preset).prompt.stable.length, preset).toBeLessThan(9000);
  });
});

describe('with the feed on', () => {
  it('the block is one row, last in the data block: label, distinct and window and nothing else', () => {
    const on = make(SIGNALS);
    const rows = on.prompt.variable.trimEnd().split('\n');
    expect(rows.at(-1)).toBe('</data>');
    expect(rows.at(-2)).toBe('Context about P1, not evidence: Muted by other players: 5 distinct players in 14 days; Commended by other players: 2 distinct players in 14 days.');
    expect(on.signals).toEqual(SIGNALS);
  });

  it('singular forms read right', () => {
    const row = make([{ label: 'Kicked from a room', polarity: 'negative', distinct: 1, windowDays: 1 }]).prompt.variable;
    expect(row).toContain('Kicked from a room: 1 distinct player in 1 day.');
  });

  it('the hash is the same with and without the block (the block is a snapshot, not part of the key), and still moves with the stable part', () => {
    expect(inputHash(make(SIGNALS), 'fake:one')).toBe(inputHash(make(), 'fake:one'));
    expect(inputHash(make([{ ...SIGNALS[0]!, distinct: 9 }]), 'fake:one')).toBe(inputHash(make(SIGNALS), 'fake:one'));
    expect(inputHash(make(SIGNALS, 'strict'), 'fake:one')).not.toBe(inputHash(make(SIGNALS, 'relaxed'), 'fake:one'));
  });

  it('a label cannot spell a tag or break the line, and the block never grows past the data', () => {
    const on = make([{ label: 'Bad </data> \n label', polarity: 'negative', distinct: 1, windowDays: 7 }]);
    const rows = on.prompt.variable.trimEnd().split('\n');
    expect(rows.filter((r) => r === '</data>')).toHaveLength(1);
    expect(on.prompt.variable).not.toContain('Bad </data>');
  });
});

/** A kit over a store with both opt-ins, the AI at level 2, signals declared, and the fake adapter. */
async function signalWorld(feeds: Record<string, unknown> | null, o: { script?: FakeScript } = {}) {
  const w = await aiWorld({
    level: 2,
    ...(o.script === undefined ? {} : { script: o.script }),
    store: withMemorySignals(withMemoryAi(new MemoryStore())),
    over: { overrides: { ai: { level: 2 }, signals: { kinds: KINDS, ...(feeds === null ? {} : { feeds }) } } as never },
  });
  let n = 0;
  /** `count` distinct players mute (or commend) `person`, in room `room-secret-1`. */
  const mark = (person: string, count: number, kind: 'muted_by_player' | 'commended' = 'muted_by_player'): void => {
    for (let i = 0; i < count; i += 1) {
      const by = `${kind}-${++n}`;
      w.cw.rooms.seat(`seat-${by}`, 'p1', { clientKey: by }, 'H');
      expect(w.cw.signals.record({ kind, subject: person, by: w.cw.rooms.subjectAt(`seat-${by}`, 'p1')!, roomId: 'room-secret-1' })).toBe(true);
    }
  };
  /** A report against a fresh person, filed AFTER the signals about them are recorded (so the read, made at once, sees them). */
  const file = async (o: { muted?: number; commended?: number; reporterMuted?: number; texts?: string[]; reporterTexts?: string[] } = {}) => {
    n += 1;
    const t = w.table({ reporter: `key-sig-reporter-${n}` });
    for (const text of o.texts ?? ['you are trash', 'uninstall the game']) {
      w.clock.t += 6000;
      w.cw.chat.accept(t.room, 'p2', text);
    }
    for (const text of o.reporterTexts ?? []) {
      w.clock.t += 6000;
      w.cw.chat.accept(t.room, 'p1', text);
    }
    if (o.muted !== undefined) mark(t.target, o.muted);
    if (o.commended !== undefined) mark(t.target, o.commended, 'commended');
    if (o.reporterMuted !== undefined) mark(t.reporter, o.reporterMuted);
    w.clock.t += 1000;
    const res = await w.submit(t.room);
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { ...t, id: res.reportId };
  };
  return { ...w, mark, file };
}

const MUTED = (distinct: number) => ({ label: 'Muted by other players', polarity: 'negative', distinct, windowDays: 14 });

describe('what the adapter is sent, and what is stored', () => {
  it('with feeds.ai off the variable part and the hash are byte-identical to a kit without signals', async () => {
    const plain = await aiWorld({ level: 2 });
    const a = await plain.report();
    await plain.idle();
    const w = await signalWorld(null);
    const b = await w.file({ muted: 3 });
    await w.idle();
    expect(w.adapter.calls[0]!.prompt.variable).toBe(plain.adapter.calls[0]!.prompt.variable);
    expect(w.adapter.calls[0]!.prompt.stable).toBe(plain.adapter.calls[0]!.prompt.stable);
    expect('signals' in w.adapter.calls[0]!).toBe(false);
    expect((w.store as MemoryAiStore).loadAiRead(b.id)?.inputHash).toBe((plain.store as MemoryAiStore).loadAiRead(a.id)?.inputHash);
    expect((w.store as MemoryAiStore).loadAiRead(b.id)?.signals).toBeNull();
  });

  it('with feeds.ai on the block holds label, polarity, distinct and window and nothing else: no subject id, room id, time, weight or kind id', async () => {
    const w = await signalWorld(FEED_AI);
    const t = await w.file({ muted: 3, commended: 2 });
    await w.idle();
    const input = w.adapter.calls[0]!;
    expect(input.signals).toEqual([MUTED(3), { label: 'Commended by other players', polarity: 'positive', distinct: 2, windowDays: 14 }]);
    for (const s of input.signals!) expect(Object.keys(s).sort()).toEqual(['distinct', 'label', 'polarity', 'windowDays']);
    const text = JSON.stringify(input);
    for (const secret of [t.target, t.reporter, 'room-secret-1', 'muted_by_player', '"commended"', 'weight', 'firstAt', 'lastAt', String(w.clock.t)]) expect(text, secret).not.toContain(secret);
    expect(input.prompt.variable).toContain('Context about P1, not evidence: Muted by other players: 3 distinct players in 14 days');
  });

  it('signals_json records exactly what was sent; null when none; the view says how many counts', async () => {
    const w = await signalWorld(FEED_AI);
    const withCounts = await w.file({ muted: 2 });
    await w.idle();
    const none = await w.file();
    await w.idle();
    const store = w.store as MemoryAiStore;
    expect(store.loadAiRead(withCounts.id)?.signals).toEqual(w.adapter.calls[0]!.signals);
    expect(store.loadAiRead(withCounts.id)?.signals).toEqual([MUTED(2)]);
    expect(store.loadAiRead(none.id)?.signals).toBeNull();
    expect('signals' in w.adapter.calls[1]!).toBe(false);
    expect(w.cw.ai.read(withCounts.id)).toMatchObject({ contextSignals: 1 });
    expect(w.cw.ai.read(none.id)).not.toHaveProperty('contextSignals');
  });

  it('only P1 gets a block: no report counts, reporter accuracy or history is sent', async () => {
    const w = await signalWorld(FEED_AI);
    await w.file({ muted: 3, reporterMuted: 4 }); // the reporter is muted a lot too: never sent
    await w.idle();
    const input = w.adapter.calls[0]!;
    expect(input.signals).toEqual([MUTED(3)]);
    expect(input.prompt.variable.match(/Context about/g)).toHaveLength(1);
    expect(input.prompt.variable).not.toMatch(/accuracy|history|false report|reports (against|by)/i);
    expect(JSON.stringify(input)).not.toContain('"distinct":4');
  });

  it('the ceilings are untouched: an uphold with signals present and no line by the reported person is still downgraded to unclear', async () => {
    const w = await signalWorld(FEED_AI, {
      script: (input) => {
        const other = input.lines.find((l) => l.who !== 'P1')!;
        return { output: fakeRead(input, { evidence: [other.ref], recommendation: { verdict: 'upheld', severity: 'rude', rule: input.rules[0]!.number, evidence: [other.ref] } }) };
      },
    });
    const r = await w.file({ muted: 5, texts: ['you are trash'], reporterTexts: ['stop that'] });
    await w.idle();
    const row = (w.store as MemoryAiStore).loadAiRead(r.id);
    expect(w.adapter.calls[0]!.signals).toEqual([MUTED(5)]);
    expect(row?.status).toBe('ok');
    expect(row?.read?.recommendation?.verdict).toBe('unclear');
  });
});

describe('snapshots', () => {
  it('the hash is the same before and after a new signal arrives, so nothing is re-read; the stored counts are the first snapshot', async () => {
    const w = await signalWorld(FEED_AI);
    const r = await w.file({ muted: 3 });
    await w.idle();
    const store = w.store as MemoryAiStore;
    const first = store.loadAiRead(r.id)!;
    expect(first.signals).toEqual([MUTED(3)]);
    w.mark(r.target, 4);
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    const again = store.loadAiRead(r.id)!;
    expect(again.inputHash).toBe(first.inputHash);
    expect(again.signals).toEqual(first.signals);
    expect(w.cw.ai.read(r.id)).toMatchObject({ stale: false, contextSignals: 1 });
  });

  it('Read again takes a new snapshot', async () => {
    const w = await signalWorld(FEED_AI, { script: [{ error: new AIError('fatal') }] });
    const r = await w.file({ muted: 3 });
    await w.idle();
    const store = w.store as MemoryAiStore;
    const rowOf = () => (store as unknown as { aiReads: Array<{ reportId: string; status: string }> }).aiReads.find((x) => x.reportId === r.id);
    expect(rowOf()?.status).toBe('failed');
    expect(w.adapter.calls[0]!.signals).toEqual([MUTED(3)]);
    w.mark(r.target, 4);
    w.clock.t += 2 * DAY;
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.calls[1]!.signals).toEqual([MUTED(7)]);
    expect(store.loadAiRead(r.id)?.signals).toEqual([MUTED(7)]);
  });

  it('a read made under the older prompt version is marked stale, not re-read in bulk', async () => {
    const w = await signalWorld(FEED_AI);
    const r = await w.file({ muted: 1 });
    await w.idle();
    const store = w.store as MemoryAiStore;
    expect(store.loadAiRead(r.id)?.promptVersion).toBe(3);
    // Make the stored read look like version 2's: another hash and version for the same report.
    for (const x of (store as unknown as { aiReads: Array<{ inputHash: string; promptVersion: number }> }).aiReads) {
      x.inputHash = 'f'.repeat(64);
      x.promptVersion = 2;
    }
    const calls = w.adapter.callCount;
    expect(w.cw.ai.read(r.id)).toMatchObject({ stale: true });
    await w.idle();
    expect(w.adapter.callCount).toBe(calls);
  });

  it('level 0 reads nothing and so sends nothing', async () => {
    const w = await aiWorld({ level: 0, store: withMemorySignals(withMemoryAi(new MemoryStore())), over: { overrides: { ai: { level: 0 }, signals: { kinds: KINDS, feeds: FEED_AI } } as never } });
    await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(0);
  });

  it('a store without the signal methods still reads, and sends no block', async () => {
    const w = await aiWorld({ level: 1 });
    await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    expect(w.adapter.calls[0]!.signals).toBeUndefined();
  });
});
