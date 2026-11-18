import { applyPolicyLayer, MAX_AI_CONTEXT, MAX_GUIDELINE_OUTCOME, MAX_TIER_DESCRIPTION, MAX_TIER_EXAMPLE, MAX_TIER_EXAMPLES, MAX_TIER_TITLE, PRESETS, TEAM_NOTE_MAX, TEAM_NOTES_MAX } from '@chatwarden/core';
import type { GuidelineCover, ModerationProfile } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { dirtySections, draftOf, fieldKeyOf, layerOf, problemsOf, setSection } from '../../src/policy/model.js';
import type { PolicyDraft } from '../../src/policy/model.js';
import { ALL_COVERS, addTier, moveCover, noteProblems, notesOf, removeTier, tierDraftOf, tierProblems, tiersOf } from '../../src/policy/principles.js';
import type { NoteDraft, TierDraft, TierEdit } from '../../src/policy/principles.js';

// The pure rules of the principles editor: the tiers as typed, the structure operations (add or split, remove or merge, move a cover) and their invariant (every cover in exactly one
// tier, no tier empty, covers in the canonical order), what the draft refuses, and the layer it sends.

const PRESET_NAMES = ['relaxed', 'standard', 'strict'] as const;
const tiersOfPreset = (name: (typeof PRESET_NAMES)[number]): TierDraft[] => PRESETS[name].guidelines.map(tierDraftOf);
const ok = (r: TierEdit): TierDraft[] => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.tiers;
};
const coversOf = (tiers: readonly TierDraft[]): GuidelineCover[][] => tiers.map((t) => [...t.covers]);
const base: ModerationProfile = PRESETS.standard;
const fresh = (): PolicyDraft => draftOf(base);
const noteOf = (text: string, rule = ''): NoteDraft => ({ text, rule });
const chars = (n: number, c = 'x'): string => c.repeat(n);

/** Every cover in exactly one tier, no empty tier, covers in the canonical order inside each tier. */
const invariant = (tiers: readonly TierDraft[]): void => {
  const flat = tiers.flatMap((t) => t.covers);
  expect([...flat].sort()).toEqual([...ALL_COVERS].sort());
  for (const t of tiers) {
    expect(t.covers.length).toBeGreaterThan(0);
    expect(t.covers).toEqual(ALL_COVERS.filter((c) => t.covers.includes(c)));
  }
};

describe('tierDraftOf and tiersOf', () => {
  it.each(PRESET_NAMES)('round-trip the %s preset', (name) => {
    expect(tiersOf(tiersOfPreset(name))).toEqual(PRESETS[name].guidelines);
  });
  it('holds the examples one per line and the covers in the canonical order', () => {
    const t = tierDraftOf({ title: 'T', description: 'D', examples: ['one', 'two'], covers: ['repeated', 'hostile'], outcome: 'O' });
    expect(t).toEqual({ title: 'T', description: 'D', examples: 'one\ntwo', covers: ['hostile', 'repeated'], outcome: 'O' });
    expect(tierDraftOf({ title: 'T', description: 'D', examples: [], covers: ['banter'], outcome: 'O' }).examples).toBe('');
  });
  it('trims every text, splits the examples on newlines (CRLF too) and drops blank lines', () => {
    const t: TierDraft = { title: '  Name  ', description: ' What \n', examples: ' a \n\n  \r\nb\r\n', covers: ['banter'], outcome: '\tDo it ' };
    expect(tiersOf([t])).toEqual([{ title: 'Name', description: 'What', examples: ['a', 'b'], covers: ['banter'], outcome: 'Do it' }]);
  });
  it('gives back a new list each time and never the draft covers array itself', () => {
    const tiers = tiersOfPreset('relaxed');
    const out = tiersOf(tiers);
    expect(out[2]!.covers).not.toBe(tiers[2]!.covers);
  });
});

describe('addTier', () => {
  it("on relaxed with ['repeated'] makes a blank tier after the hostile one; the source keeps hostile; six tiers; every cover exactly once", () => {
    const before = tiersOfPreset('relaxed');
    const copy = structuredClone(before);
    const after = ok(addTier(before, ['repeated']));
    expect(before).toEqual(copy);
    expect(after).toHaveLength(6);
    expect(coversOf(after)).toEqual([['banter'], ['rude'], ['hostile'], ['repeated'], ['after_warning'], ['severe']]);
    expect(after[3]).toEqual({ title: '', description: '', examples: '', covers: ['repeated'], outcome: '' });
    expect(after[2]!.title).toBe('Repeated hostility');
    invariant(after);
  });
  it('refuses to empty a source (banter alone, or both hostile and repeated); nothing changes in each case', () => {
    const before = tiersOfPreset('relaxed');
    const copy = structuredClone(before);
    expect(addTier(before, ['banter'])).toEqual({ ok: false, reason: 'empty_source' });
    expect(addTier(before, ['hostile', 'repeated'])).toEqual({ ok: false, reason: 'empty_source' });
    expect(before).toEqual(copy);
  });
  it('refuses none chosen and a name that is not a level; nothing changes in each case', () => {
    const before = tiersOfPreset('standard');
    const copy = structuredClone(before);
    expect(addTier(before, [])).toEqual({ ok: false, reason: 'none_chosen' });
    expect(addTier(before, ['nonsense' as GuidelineCover])).toEqual({ ok: false, reason: 'unknown_cover' });
    expect(before).toEqual(copy);
  });
  it('with covers from two tiers keeps both sources non-empty and puts the new tier after the first source', () => {
    // relaxed: [banter] [rude] [hostile repeated] [after_warning] [severe]; merge severe upwards so two tiers have two covers
    const tiers = ok(removeTier(tiersOfPreset('relaxed'), 4));
    expect(coversOf(tiers)).toEqual([['banter'], ['rude'], ['hostile', 'repeated'], ['severe', 'after_warning']]);
    const after = ok(addTier(tiers, ['repeated', 'after_warning']));
    expect(coversOf(after)).toEqual([['banter'], ['rude'], ['hostile'], ['repeated', 'after_warning'], ['severe']]);
    invariant(after);
  });
  it('a duplicate cover in the chosen list is taken once', () => {
    const after = ok(addTier(tiersOfPreset('relaxed'), ['repeated', 'repeated']));
    expect(after).toHaveLength(6);
    invariant(after);
  });
});

describe('removeTier', () => {
  it('removeTier(3) (after_warning) merges into tier 2 as hostile, repeated, after_warning in canonical order', () => {
    const before = tiersOfPreset('relaxed');
    const after = ok(removeTier(before, 3));
    expect(after).toHaveLength(4);
    expect(after[2]!.covers).toEqual(['hostile', 'repeated', 'after_warning']);
    expect(after[2]!.title).toBe('Repeated hostility');
    invariant(after);
  });
  it('removeTier(0) merges banter into the next tier and drops the first tier text', () => {
    const after = ok(removeTier(tiersOfPreset('relaxed'), 0));
    expect(after).toHaveLength(4);
    expect(after[0]!.covers).toEqual(['banter', 'rude']);
    expect(after[0]!.title).toBe('Aggressive but isolated');
    invariant(after);
  });
  it('the only tier is last_tier; an out-of-range index is refused too, and nothing changes', () => {
    const one: TierDraft[] = [{ title: 'All', description: 'D', examples: '', covers: [...ALL_COVERS], outcome: 'O' }];
    expect(removeTier(one, 0)).toEqual({ ok: false, reason: 'last_tier' });
    const tiers = tiersOfPreset('standard');
    const copy = structuredClone(tiers);
    expect(removeTier(tiers, 9)).toEqual({ ok: false, reason: 'no_such_tier' });
    expect(removeTier(tiers, -1)).toEqual({ ok: false, reason: 'no_such_tier' });
    expect(tiers).toEqual(copy);
  });
  it('remove then add restores the covers, not the text', () => {
    const before = tiersOfPreset('relaxed');
    const removed = ok(removeTier(before, 3));
    const added = ok(addTier(removed, ['after_warning']));
    expect(coversOf(added)).toEqual(coversOf(before));
    expect(added[3]!.title).toBe('');
    expect(added[3]!.outcome).toBe('');
  });
});

describe('moveCover', () => {
  it("moveCover('repeated', 1) moves it", () => {
    const after = ok(moveCover(tiersOfPreset('relaxed'), 'repeated', 1));
    expect(coversOf(after)).toEqual([['banter'], ['rude', 'repeated'], ['hostile'], ['after_warning'], ['severe']]);
    invariant(after);
  });
  it('moving the last cover of a tier out is empty_source', () => {
    const before = tiersOfPreset('relaxed');
    expect(moveCover(before, 'banter', 1)).toEqual({ ok: false, reason: 'empty_source' });
  });
  it('moving to where it already is is a no-op that is still ok, with a new list', () => {
    const before = tiersOfPreset('relaxed');
    const r = moveCover(before, 'repeated', 2);
    expect(r.ok).toBe(true);
    expect(ok(r)).toEqual(before);
    expect(ok(r)).not.toBe(before);
  });
  it('an unknown cover and a tier that does not exist are refused', () => {
    const before = tiersOfPreset('relaxed');
    expect(moveCover(before, 'nonsense' as GuidelineCover, 1)).toEqual({ ok: false, reason: 'unknown_cover' });
    expect(moveCover(before, 'repeated', 7)).toEqual({ ok: false, reason: 'no_such_tier' });
    expect(moveCover(before, 'repeated', -1)).toEqual({ ok: false, reason: 'no_such_tier' });
  });
  it('keeps the texts of both tiers', () => {
    const before = tiersOfPreset('relaxed');
    const after = ok(moveCover(before, 'repeated', 1));
    expect(after.map((t) => t.title)).toEqual(before.map((t) => t.title));
  });
});

describe('the invariant holds over many random edit sequences', () => {
  // A small seeded generator, so a failure repeats.
  const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  it.each(PRESET_NAMES)('from the %s preset, 300 random operations', (name) => {
    const next = rng(name.length * 7919);
    let tiers = tiersOfPreset(name);
    let applied = 0;
    for (let i = 0; i < 300; i++) {
      const pick = Math.floor(next() * 3);
      const cover = ALL_COVERS[Math.floor(next() * ALL_COVERS.length)]!;
      const r =
        pick === 0
          ? addTier(tiers, [cover, ...(next() < 0.3 ? [ALL_COVERS[Math.floor(next() * ALL_COVERS.length)]!] : [])])
          : pick === 1
            ? removeTier(tiers, Math.floor(next() * (tiers.length + 1)) - (next() < 0.1 ? 1 : 0))
            : moveCover(tiers, cover, Math.floor(next() * (tiers.length + 1)));
      if (r.ok) {
        tiers = r.tiers;
        applied++;
      }
      invariant(tiers);
    }
    expect(applied).toBeGreaterThan(30);
  });
});

describe('tierProblems', () => {
  const good = (): TierDraft[] => tiersOfPreset('standard');
  const withTier = (i: number, patch: Partial<TierDraft>): TierDraft[] => good().map((t, j) => (j === i ? { ...t, ...patch } : t));

  it('a preset has no problems', () => {
    for (const name of PRESET_NAMES) expect(tierProblems(tiersOfPreset(name))).toEqual({});
  });
  it('an empty name, description and outcome are each a problem on their own field', () => {
    const p = tierProblems(withTier(1, { title: '  ', description: '', outcome: '\n' }));
    expect(Object.keys(p).sort()).toEqual(['guide-1-description', 'guide-1-outcome', 'guide-1-title']);
    for (const k of Object.keys(p)) expect(p[k]!.key).toBe('hub.settings.principle.error.empty');
  });
  it('a name of 80 characters is fine and 81 is not', () => {
    expect(tierProblems(withTier(0, { title: chars(MAX_TIER_TITLE) }))).toEqual({});
    expect(tierProblems(withTier(0, { title: chars(MAX_TIER_TITLE + 1) }))['guide-0-title']).toEqual({ key: 'hub.settings.principle.error.long', params: { max: 80 } });
  });
  it('a description of 600 is fine and 601 is not', () => {
    expect(tierProblems(withTier(2, { description: chars(MAX_TIER_DESCRIPTION) }))).toEqual({});
    expect(tierProblems(withTier(2, { description: chars(MAX_TIER_DESCRIPTION + 1) }))['guide-2-description']).toEqual({ key: 'hub.settings.principle.error.long', params: { max: 600 } });
  });
  it('8 examples are fine and 9 are not; blank lines are not counted', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `e${i}`).join('\n');
    expect(tierProblems(withTier(0, { examples: lines(MAX_TIER_EXAMPLES) }))).toEqual({});
    expect(tierProblems(withTier(0, { examples: `${lines(MAX_TIER_EXAMPLES)}\n\n  \n` }))).toEqual({});
    expect(tierProblems(withTier(0, { examples: lines(MAX_TIER_EXAMPLES + 1) }))['guide-0-examples']).toEqual({ key: 'hub.settings.principle.error.examples.count', params: { max: 8 } });
  });
  it('an example of 120 characters is fine and 121 is not', () => {
    expect(tierProblems(withTier(0, { examples: chars(MAX_TIER_EXAMPLE) }))).toEqual({});
    expect(tierProblems(withTier(0, { examples: `ok\n${chars(MAX_TIER_EXAMPLE + 1)}` }))['guide-0-examples']).toEqual({ key: 'hub.settings.principle.error.examples.long', params: { max: 120 } });
  });
  it('an outcome of 1000 is fine and 1001 is not', () => {
    expect(tierProblems(withTier(3, { outcome: chars(MAX_GUIDELINE_OUTCOME) }))).toEqual({});
    expect(tierProblems(withTier(3, { outcome: chars(MAX_GUIDELINE_OUTCOME + 1) }))['guide-3-outcome']).toEqual({ key: 'hub.settings.principle.error.long', params: { max: 1000 } });
  });
  it('counts characters the way the kit does (a code point is one)', () => {
    expect(tierProblems(withTier(0, { title: '\u{1F600}'.repeat(MAX_TIER_TITLE) }))).toEqual({});
    expect(tierProblems(withTier(0, { title: '\u{1F600}'.repeat(MAX_TIER_TITLE + 1) }))['guide-0-title']).toBeDefined();
  });
  it('a missing cover, a duplicated cover and an empty tier are each guide-covers', () => {
    const missing = good().map((t) => ({ ...t, covers: t.covers.filter((c) => c !== 'severe') }));
    // the severe tier is now empty as well: still one key
    expect(tierProblems(missing)['guide-covers']).toEqual({ key: 'hub.settings.principle.error.covers' });
    const dup = good().map((t, i) => (i === 0 ? { ...t, covers: [...t.covers, 'severe' as const] } : t));
    expect(tierProblems(dup)['guide-covers']).toEqual({ key: 'hub.settings.principle.error.covers' });
    const empty: TierDraft[] = [...good(), { title: 'x', description: 'x', examples: '', covers: [], outcome: 'x' }];
    expect(tierProblems(empty)['guide-covers']).toEqual({ key: 'hub.settings.principle.error.covers' });
    expect(Object.keys(tierProblems(good()))).not.toContain('guide-covers');
  });
  it('a blank new tier is named, covered, described and given an outcome before it is valid', () => {
    const tiers = ok(addTier(tiersOfPreset('relaxed'), ['repeated']));
    expect(Object.keys(tierProblems(tiers)).sort()).toEqual(['guide-3-description', 'guide-3-outcome', 'guide-3-title']);
  });
});

describe('noteProblems', () => {
  it('no notes and ordinary notes have none', () => {
    expect(noteProblems([])).toEqual({});
    expect(noteProblems([noteOf('Be kind'), noteOf('About rule 3', '3'), noteOf('Another', '')])).toEqual({});
  });
  it('an empty note is a problem; 500 characters are fine and 501 are not', () => {
    expect(noteProblems([noteOf('  ')])['note-0-text']).toEqual({ key: 'hub.settings.notes.error.empty' });
    expect(noteProblems([noteOf(chars(TEAM_NOTE_MAX))])).toEqual({});
    expect(noteProblems([noteOf('ok'), noteOf(chars(TEAM_NOTE_MAX + 1))])['note-1-text']).toEqual({ key: 'hub.settings.notes.error.long', params: { max: 500 } });
  });
  it("a rule of '0' or '3a' is a problem; '' is fine", () => {
    expect(noteProblems([noteOf('a', '0')])['note-0-rule']).toEqual({ key: 'hub.settings.notes.error.rule' });
    expect(noteProblems([noteOf('a', '3a')])['note-0-rule']).toEqual({ key: 'hub.settings.notes.error.rule' });
    expect(noteProblems([noteOf('a', '-1')])['note-0-rule']).toBeDefined();
    expect(noteProblems([noteOf('a', '')])).toEqual({});
    expect(noteProblems([noteOf('a', '12')])).toEqual({});
  });
  it('30 notes are fine and 31 are notes-count', () => {
    const many = (n: number): NoteDraft[] => Array.from({ length: n }, (_, i) => noteOf(`n${i}`));
    expect(noteProblems(many(TEAM_NOTES_MAX))).toEqual({});
    expect(noteProblems(many(TEAM_NOTES_MAX + 1))['notes-count']).toEqual({ key: 'hub.settings.notes.error.count', params: { max: 30 } });
  });
});

describe('notesOf', () => {
  it('trims, turns a typed rule into a number and leaves no rule key when blank', () => {
    expect(notesOf([noteOf('  a  ', ' 4 '), noteOf('b', ''), noteOf('c', '  ')])).toEqual([{ text: 'a', rule: 4 }, { text: 'b' }, { text: 'c' }]);
    expect(Object.keys(notesOf([noteOf('b', '')])[0]!)).toEqual(['text']);
  });
});

describe('the draft: layerOf, draftOf, setSection, dirtySections', () => {
  const layer = (d: PolicyDraft, effective: ModerationProfile = base) => {
    const r = layerOf(d, base, effective);
    if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r.problems)}`);
    return r.layer;
  };

  it('draftOf builds tier drafts and note drafts; a profile without teamNotes has none', () => {
    const d = fresh();
    expect(d.guidelines).toEqual(base.guidelines.map(tierDraftOf));
    expect(d.teamNotes).toEqual([]);
    const withNotes = draftOf({ ...base, teamNotes: [{ text: 'a', rule: 2 }, { text: 'b' }] });
    expect(withNotes.teamNotes).toEqual([{ text: 'a', rule: '2' }, { text: 'b', rule: '' }]);
  });
  it('unchanged drafts give no guidelines or teamNotes key', () => {
    expect(layer(fresh())).toEqual({});
    expect(dirtySections(fresh(), base)).toEqual([]);
  });
  it('a whitespace-only edit is not a change', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((t, i) => (i === 0 ? { ...t, title: ` ${t.title} `, examples: `${t.examples}\n\n` } : t));
    d.teamNotes = [];
    expect(dirtySections(d, base)).toEqual([]);
    expect(layer(d)).toEqual({});
    const n = draftOf({ ...base, teamNotes: [{ text: 'a' }] });
    n.teamNotes = [{ text: ' a ', rule: ' ' }];
    expect(dirtySections(n, { ...base, teamNotes: [{ text: 'a' }] })).toEqual([]);
  });
  it('an edited title gives guidelines { tiers } with ALL tiers, trimmed, examples split; core accepts it', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((t, i) => (i === 1 ? { ...t, title: '  Name changed  ', examples: 'a\n\nb ' } : t));
    const l = layer(d);
    expect(Object.keys(l)).toEqual(['guidelines']);
    const whole = l.guidelines as { tiers: Array<{ title: string; examples: string[] }> };
    expect(whole.tiers).toHaveLength(base.guidelines.length);
    expect(whole.tiers[1]!.title).toBe('Name changed');
    expect(whole.tiers[1]!.examples).toEqual(['a', 'b']);
    expect(Array.isArray(l.guidelines)).toBe(false);
    expect(applyPolicyLayer(base, l).guidelines[1]!.title).toBe('Name changed');
  });
  it('a structure edit (add, then name it) is accepted by core', () => {
    const d = fresh();
    const split = ok(addTier(d.guidelines, ['repeated']));
    split[split.findIndex((t) => t.covers.includes('repeated'))] = { ...split[split.findIndex((t) => t.covers.includes('repeated'))]!, title: 'Pattern', description: 'Again and again.', outcome: 'A warning.' };
    d.guidelines = split;
    const l = layer(d);
    const eff = applyPolicyLayer(base, l);
    expect(eff.guidelines).toHaveLength(base.guidelines.length + 1);
    expect(eff.guidelines.flatMap((t) => t.covers).sort()).toEqual([...ALL_COVERS].sort());
    expect(dirtySections(d, base)).toEqual(['guidelines']);
  });
  it("a note with rule '4' gives { text, rule: 4 } and no rule key when blank; core accepts it", () => {
    const d = fresh();
    d.teamNotes = [noteOf('Rule four things', '4'), noteOf('General')];
    const l = layer(d);
    expect(l.teamNotes).toEqual([{ text: 'Rule four things', rule: 4 }, { text: 'General' }]);
    expect(Object.keys(l)).toEqual(['teamNotes']);
    expect(applyPolicyLayer(base, l).teamNotes).toEqual([{ text: 'Rule four things', rule: 4 }, { text: 'General' }]);
    expect(dirtySections(d, base)).toEqual(['teamNotes']);
  });
  it('putting the notes back to the base makes teamNotes drop out of the layer', () => {
    const d = fresh();
    d.teamNotes = [noteOf('x')];
    d.teamNotes = [];
    expect(layer(d)).toEqual({});
  });
  it('an old positional layer in force: draftOf(effective) shows its outcome; editing a title keeps that outcome and sends the whole form', () => {
    const effective = applyPolicyLayer(base, { guidelines: [null, { outcome: 'Our own outcome.' }] });
    const d = draftOf(effective);
    expect(d.guidelines[1]!.outcome).toBe('Our own outcome.');
    expect(dirtySections(d, effective)).toEqual([]);
    d.guidelines = d.guidelines.map((t, i) => (i === 0 ? { ...t, title: 'Renamed' } : t));
    const l = layer(d, effective);
    const whole = l.guidelines as { tiers: Array<{ title: string; outcome: string }> };
    expect(whole.tiers[0]!.title).toBe('Renamed');
    expect(whole.tiers[1]!.outcome).toBe('Our own outcome.');
    expect(applyPolicyLayer(base, l).guidelines[1]!.outcome).toBe('Our own outcome.');
  });
  it('the old positional layer in force sends the whole form on the next save, even when only another section is edited', () => {
    const effective = applyPolicyLayer(base, { guidelines: [null, { outcome: 'Our own outcome.' }] });
    const d = draftOf(effective);
    d.customDuration = false;
    const l = layer(d, effective);
    expect(Object.keys(l).sort()).toEqual(['customDuration', 'guidelines']);
    expect(Array.isArray(l.guidelines)).toBe(false);
  });
  it('setSection resets guidelines and teamNotes from a profile and leaves the other sections; dirtySections lists them in order', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((t) => ({ ...t, title: 'Z' }));
    d.teamNotes = [noteOf('n')];
    d.customDuration = false;
    expect(dirtySections(d, base)).toEqual(['customDuration', 'guidelines', 'teamNotes']);
    const a = setSection(d, 'guidelines', base);
    expect(a.guidelines).toEqual(fresh().guidelines);
    expect(a.teamNotes).toEqual([noteOf('n')]);
    const b = setSection(a, 'teamNotes', base);
    expect(b.teamNotes).toEqual([]);
    expect(b.customDuration).toBe(false);
    // from a profile that has notes
    const withNotes: ModerationProfile = { ...base, teamNotes: [{ text: 'kept', rule: 1 }] };
    expect(setSection(d, 'teamNotes', withNotes).teamNotes).toEqual([{ text: 'kept', rule: '1' }]);
  });
  it('problemsOf merges the tier and note problems and no longer reports the old guide-<i> keys', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((t, i) => (i === 0 ? { ...t, title: '' } : t));
    d.teamNotes = [noteOf('')];
    const keys = Object.keys(problemsOf(d)).sort();
    expect(keys).toEqual(['guide-0-title', 'note-0-text']);
    expect(layerOfProblems(d)).toEqual(keys);
  });
  it('aiContext is not part of this draft: a layer the screen sends keeps it through otherSections', () => {
    expect(Object.keys(fresh())).not.toContain('aiContext');
    expect(MAX_AI_CONTEXT).toBe(2000);
  });
});

const layerOfProblems = (d: PolicyDraft): string[] => {
  const r = layerOf(d, PRESETS.standard, PRESETS.standard);
  return r.ok ? [] : Object.keys(r.problems).sort();
};

describe('fieldKeyOf for the new paths', () => {
  it.each<[string, string | null]>([
    ['layer.guidelines[2].title', 'guide-2-title'],
    ['layer.guidelines[0].description', 'guide-0-description'],
    ['layer.guidelines[1].examples', 'guide-1-examples'],
    ['layer.guidelines[1].examples[3]', 'guide-1-examples'],
    ['layer.guidelines[3].outcome', 'guide-3-outcome'],
    ['layer.guidelines[3].covers', 'guide-covers'],
    ['layer.guidelines[3].covers[0]', 'guide-covers'],
    ['layer.guidelines', 'guide-covers'],
    ['layer.guidelines.tiers', 'guide-covers'],
    ['layer.guidelines.extra', 'guide-covers'],
    ['layer.guidelines[2]', 'guide-2-title'],
    ['layer.teamNotes[0].text', 'note-0-text'],
    ['layer.teamNotes[4].rule', 'note-4-rule'],
    ['layer.teamNotes[4]', 'note-4-text'],
    ['layer.teamNotes', 'note-0-text'],
    ['layer.aiContext', null],
    ['layer.profanity', null],
    ['layer', null],
  ])('%s -> %s', (path, key) => {
    expect(fieldKeyOf(path)).toBe(key);
  });
});
