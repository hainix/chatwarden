// @vitest-environment node
import { PRESETS, recommendFor } from '@chatwarden/core';
import type { ConductLevel } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { caseLevel, notesForRule, tierForLevel } from '../src/case/principles.js';
import { createT, en } from '../src/i18n.js';
import { ladderSummary } from '../src/setup/summary.js';
import type { SetupOption } from '../src/types.js';

// The pure rules of the case's "Principles for this case" disclosure (Detailed pane): which principle matches the report's conduct level, which team notes belong to the case's Community
// Rule, which level a case is read at; and the one line the first-run panel says about the ladder of a choice.

const LEVELS: readonly ConductLevel[] = ['banter', 'rude', 'hostile', 'severe'];
const RULES = [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4, retired: true }, { number: 5 }];

describe('tierForLevel', () => {
  it('picks the first tier whose covers include the level; null when none does', () => {
    const tiers = PRESETS.relaxed.guidelines;
    expect(tierForLevel(tiers, 'banter')?.title).toBe('Minor, isolated');
    expect(tierForLevel(tiers, 'severe')?.title).toBe('Severe');
    expect(tierForLevel([], 'hostile')).toBeNull();
    expect(tierForLevel([tiers[0]!], 'severe')).toBeNull();
  });
  it('for the relaxed preset hostile gives "Repeated hostility" and rude gives "Aggressive but isolated"', () => {
    const tiers = PRESETS.relaxed.guidelines;
    expect(tierForLevel(tiers, 'hostile')?.title).toBe('Repeated hostility');
    expect(tierForLevel(tiers, 'rude')?.title).toBe('Aggressive but isolated');
  });
  it('every level of every preset has a tier', () => {
    for (const preset of Object.values(PRESETS)) for (const level of LEVELS) expect(tierForLevel(preset.guidelines, level), `${preset.id} ${level}`).not.toBeNull();
  });
  it('the first of two tiers that both cover the level wins, and a tier covering only repeated or after_warning never matches a level', () => {
    const a = { title: 'A', description: '', examples: [], covers: ['hostile' as const], outcome: '' };
    const b = { title: 'B', description: '', examples: [], covers: ['hostile' as const, 'severe' as const], outcome: '' };
    expect(tierForLevel([a, b], 'hostile')?.title).toBe('A');
    expect(tierForLevel([a, b], 'severe')?.title).toBe('B');
    const only = { title: 'C', description: '', examples: [], covers: ['repeated' as const, 'after_warning' as const], outcome: '' };
    for (const level of LEVELS) expect(tierForLevel([only], level)).toBeNull();
  });
});

describe('notesForRule', () => {
  const notes = [{ text: 'about 3', rule: 3 }, { text: 'general' }, { text: 'about 4', rule: 4 }, { text: 'about 3 again', rule: 3 }, { text: 'about 9', rule: 9 }];
  it('keeps notes for rule 3 only, in order', () => {
    expect(notesForRule(notes, 3, RULES).map((n) => n.text)).toEqual(['about 3', 'about 3 again']);
  });
  it('drops the notes of a retired rule', () => {
    expect(notesForRule(notes, 4, RULES)).toEqual([]);
  });
  it("'uncovered' gives none, and so does a rule that is not in the list", () => {
    expect(notesForRule(notes, 'uncovered', RULES)).toEqual([]);
    expect(notesForRule(notes, 9, RULES)).toEqual([]);
  });
  it('a note with no rule never belongs to a case, and no notes give none', () => {
    expect(notesForRule([{ text: 'general' }], 3, RULES)).toEqual([]);
    expect(notesForRule([], 3, RULES)).toEqual([]);
    expect(notesForRule(notes, 3, [])).toEqual([]);
  });
});

describe('caseLevel', () => {
  it('is the picked level, else the AI read severity, else hostile', () => {
    expect(caseLevel('severe', 'rude')).toBe('severe');
    expect(caseLevel(null, 'rude')).toBe('rude');
    expect(caseLevel(null, undefined)).toBe('hostile');
    expect(caseLevel('banter', undefined)).toBe('banter');
  });
  it('a report about play or a name with nothing picked reads rude, as the ladder does (review R2 M2)', () => {
    expect(caseLevel(null, undefined, 'play')).toBe('rude');
    expect(caseLevel(null, undefined, 'name')).toBe('rude');
    expect(caseLevel(null, undefined, 'chat')).toBe('hostile');
    expect(caseLevel(null, undefined, undefined)).toBe('hostile');
  });
  it('what the moderator picked, or the AI read, still wins over the kind', () => {
    expect(caseLevel('severe', undefined, 'play')).toBe('severe');
    expect(caseLevel('banter', undefined, 'name')).toBe('banter');
    expect(caseLevel(null, 'hostile', 'play')).toBe('hostile');
  });
});

describe('ladderSummary', () => {
  const t = createT(en, 'en');
  const option = (game: 'competitive' | 'social' | 'kids' | 'creator'): SetupOption => JSON.parse(JSON.stringify(recommendFor(game))) as SetupOption;

  it('names the first offences for rude, hostile and severe and the last step, in words', () => {
    const line = ladderSummary(option('kids'), t);
    expect(line).toContain('Rude, ');
    expect(line).toContain('Hostile, ');
    expect(line).toContain('Severe, ');
    expect(line).not.toMatch(/[{}]|\[object|durationMs|kind/);
    const last = PRESETS.strict.ladder.at(-1)!.high.label;
    expect(line).toContain(last);
  });
  it('differs between a relaxed and a strict choice, and is one line', () => {
    expect(ladderSummary(option('competitive'), t)).not.toBe(ladderSummary(option('kids'), t));
    for (const game of ['competitive', 'social', 'kids', 'creator'] as const) expect(ladderSummary(option(game), t)).not.toContain('\n');
  });
  it('turns an outcome object into words, never raw JSON, and falls back when the layer has no ladder', () => {
    const o = option('social');
    o.layer.firstOffense = { rude: 'note', hostile: { kind: 'chat', durationMs: 24 * 3_600_000 }, severe: { kind: 'ban', durationMs: null } };
    const line = ladderSummary(o, t);
    expect(line).toContain('Note');
    expect(line).toContain('Chat restriction, 24 hours');
    expect(line).toContain('Ban, permanent');
    delete o.layer.ladder;
    expect(() => ladderSummary(o, t)).not.toThrow();
    expect(ladderSummary(o, t)).toContain('Rude, ');
  });
});
