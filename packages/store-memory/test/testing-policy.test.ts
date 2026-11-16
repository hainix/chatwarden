import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConductLevel } from '@chatwarden/core';
import { ScriptMismatch, createTestKit, expectOutcomes } from '../src/testing/index.js';
import type { Step } from '../src/testing/index.js';

const LEVELS: ConductLevel[] = ['banter', 'rude', 'hostile', 'severe'];
const PROFILES = ['relaxed', 'standard', 'strict'] as const;

/** What the profile's own table suggests for a person with a clean record at `level`: the one place the numbers live. */
async function tableFor(profile: (typeof PROFILES)[number], level: ConductLevel): Promise<string> {
  const kit = await createTestKit({ profile });
  const preview = kit.cw.policy.preview({});
  if (!preview.ok) throw new Error('a preset must preview');
  return preview.samples.clean[level].label;
}

describe('the presets', () => {
  it('strict, standard and relaxed give the suggestions their profile tables name for the same script', async () => {
    const script = (labels: Record<ConductLevel, string>): Step[] => [
      { player: 'tarvo', say: 'good game', expect: 'delivered' },
      ...LEVELS.map((level): Step => ({ suggest: 'tarvo', level, expect: labels[level] })),
    ];
    const seen = new Map<string, string[]>();
    for (const profile of PROFILES) {
      const labels = Object.fromEntries(await Promise.all(LEVELS.map(async (level) => [level, await tableFor(profile, level)]))) as Record<ConductLevel, string>;
      const kit = await createTestKit({ profile });
      const run = await kit.play(script(labels));
      const suggestions = run.steps.flatMap((s) => (s.kind === 'suggest' ? [s.suggestion.label] : []));
      expect(suggestions).toEqual(LEVELS.map((level) => labels[level]));
      seen.set(profile, suggestions);
    }
    // The presets are different from each other somewhere, so this test cannot pass by comparing a table with itself.
    expect(new Set([...seen.values()].map((labels) => labels.join('|'))).size).toBeGreaterThan(1);
  });

  it('the suggestion reads the player\'s record: a first rude line and a repeat differ for the same profile table', async () => {
    const kit = await createTestKit({ profile: 'standard' });
    const room = kit.room();
    room.join('tarvo');
    const clean = kit.suggest('tarvo', 'hostile');
    const preview = kit.cw.policy.preview({});
    if (!preview.ok) throw new Error('preview');
    expect(clean.label).toBe(preview.samples.clean.hostile.label);
    // After a sanction is on record, the same level suggests the next step up (the sample with a warning on record).
    const subject = kit.cw.rooms.subjectAt('lobby', 'tarvo');
    if (subject === null) throw new Error('seated');
    await kit.cw.sanctions.apply({ kind: 'warning', subject, includeIp: false, durationMs: null, reason: 'testing', actor: 'mod@example.test', source: 'moderator', automated: false, rule: 2, roomId: 'lobby' });
    expect(kit.suggest('tarvo', 'rude').label).toBe(preview.samples.oneWarning.rude.label);
  });

  it('a profile override changes exactly one outcome', async () => {
    const lines = [
      { player: 'a', say: 'hello', expect: 'delivered' as const },
      { player: 'b', say: 'what a snerp', expect: 'starred' as const },
      { player: 'c', say: 'you zorbak', expect: 'refused:blocked' as const },
      { player: 'd', say: '   ', expect: 'refused:empty' as const },
    ];
    const base = await createTestKit({ blocked: ['zorbak'], swears: ['snerp'] });
    const baseRun = await base.play(lines);
    const changed = await createTestKit({ blocked: ['zorbak'], swears: ['snerp'], overrides: { profanity: { mode: 'refuse' } } });
    const changedRun = await changed.play(lines.map((line) => ({ player: line.player, say: line.say })));
    const differing = baseRun.outcomes.map((label, index) => [label, changedRun.outcomes[index]]).filter(([a, b]) => a !== b);
    expect(differing).toEqual([['starred', 'refused:profanity']]);
  });

  it('a name the preset does not have is the kit\'s own error, not a silent default', async () => {
    await expect(createTestKit({ profile: 'bogus' as never })).rejects.toThrow();
  });
});

describe('the README', () => {
  /** The first ```ts block under the test kit heading, without its import line: what a reader would paste. */
  function example(): string {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('## The test kit'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    if (block === undefined) throw new Error('the README has no test kit example');
    expect(block.startsWith("import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';")).toBe(true);
    return block.split('\n').slice(1).join('\n');
  }
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;

  it('the README example runs and matches (scripts/readme.test.ts compiles the same block)', async () => {
    await expect(new AsyncFunction('createTestKit', 'expectOutcomes', example())(createTestKit, expectOutcomes)).resolves.toBeUndefined();
  });

  it('and it fails when what it says is wrong: the same block with one expectation changed is a ScriptMismatch', async () => {
    const wrong = example().replace("say: 'good game', expect: 'delivered'", "say: 'good game', expect: 'refused:blocked'");
    expect(wrong).not.toBe(example());
    await expect(new AsyncFunction('createTestKit', 'expectOutcomes', wrong)(createTestKit, expectOutcomes)).rejects.toBeInstanceOf(ScriptMismatch);
  });
});
