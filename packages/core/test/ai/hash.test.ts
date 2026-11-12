import { describe, expect, it } from 'vitest';
import { inputHash } from '../../src/ai/hash.js';
import { buildAIInput } from '../../src/ai/prompt.js';
import { chooseLines, redactReportNote } from '../../src/ai/lines.js';
import type { AIReadInput } from '../../src/ai/types.js';
import { PRESETS } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import { mkReport } from './reportFixtures.js';
import type { LineSpec } from './reportFixtures.js';

function make(lines: LineSpec[], o: { note?: string | null; ruleTweak?: boolean } = {}): AIReadInput {
  const rules = starterRules('standard').map((r, i) => (o.ruleTweak && i === 0 ? { ...r, text: `${r.text} Also vlemmo.` } : r));
  const report = mkReport(lines, { note: o.note ?? null });
  return buildAIInput({
    policy: { profile: PRESETS.standard, rules: defineRules(rules) },
    reason: null,
    note: redactReportNote(report),
    chosen: chooseLines(report),
  });
}

const lines: LineSpec[] = [
  { who: 'target', text: 'you are a zorbak' },
  { who: 'reporter', text: 'stop it' },
];

/** The same value with every object's keys in the opposite order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  }
  return v;
}

describe('inputHash', () => {
  it('is a sha256 hex string', () => {
    expect(inputHash(make(lines), 'fake:one')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the hash is stable, covers the adapter id and the prompt version, and ignores a reorder of object keys', () => {
    const a = make(lines);
    const h = inputHash(a, 'fake:one');
    // Stable: the same input, and an identical input built again.
    expect(inputHash(a, 'fake:one')).toBe(h);
    expect(inputHash(make(lines), 'fake:one')).toBe(h);
    // Covers the adapter id.
    expect(inputHash(a, 'fake:two')).not.toBe(h);
    expect(inputHash(a, 'fake:one ')).not.toBe(h);
    expect(inputHash(a, '')).not.toBe(h);
    // Covers the prompt version.
    expect(inputHash({ ...a, promptVersion: a.promptVersion + 1 }, 'fake:one')).not.toBe(h);
    // Ignores a reorder of object keys.
    expect(inputHash(reverseKeys(a) as AIReadInput, 'fake:one')).toBe(h);
  });

  it('changes when the lines, the note or the rules change', () => {
    const base = inputHash(make(lines), 'x');
    expect(inputHash(make([{ who: 'target', text: 'you are a zorbak!' }, { who: 'reporter', text: 'stop it' }]), 'x')).not.toBe(base);
    expect(inputHash(make(lines, { note: 'new note' }), 'x')).not.toBe(base);
    expect(inputHash(make(lines, { ruleTweak: true }), 'x')).not.toBe(base);
  });

  it('does not let the stable and variable parts trade characters', () => {
    const a = make(lines);
    const moved: AIReadInput = { ...a, prompt: { ...a.prompt, stable: `${a.prompt.stable}X`, variable: a.prompt.variable } };
    const shifted: AIReadInput = { ...a, prompt: { ...a.prompt, stable: a.prompt.stable, variable: `X${a.prompt.variable}` } };
    expect(inputHash(moved, 'x')).not.toBe(inputHash(shifted, 'x'));
    // The adapter id cannot slide into the variable part either.
    const b: AIReadInput = { ...a, prompt: { ...a.prompt, variable: `${a.prompt.variable}id` } };
    expect(inputHash(b, '')).not.toBe(inputHash(a, 'id'));
  });

  it('does not depend on the schema object (it is static and tied to the prompt version)', () => {
    const a = make(lines);
    expect(inputHash({ ...a, prompt: { ...a.prompt, schema: { other: true } } }, 'x')).toBe(inputHash(a, 'x'));
  });
});
