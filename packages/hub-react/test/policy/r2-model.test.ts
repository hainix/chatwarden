import { applyPolicyLayer, PRESETS, resolveProfile } from '@chatwarden/core';
import type { GuidelineCover, GuidelineTier, ModerationProfile, PolicyLayer } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { dirtySections, draftOf, layerOf, problemsOf } from '../../src/policy/model.js';
import { addTier, ALL_COVERS, moveCover, tierDraftOf, tierProblems } from '../../src/policy/principles.js';

// Review R2, I1: a 0.2.1 code profile that the kit still accepts (four covers, long text) never blocks a save of a section the owner did not touch, and the structure editor can add a cover
// that no principle holds. The same model rules at the level of plain functions.

const standard = PRESETS.standard.guidelines;
/** A 0.2.1 profile in code: the four conduct levels only (`repeated` and `after_warning` are optional for a code profile). */
const fourCovers = (): GuidelineTier[] =>
  standard
    .map((t) => ({ ...t, covers: t.covers.filter((c) => c !== 'repeated' && c !== 'after_warning') }))
    .filter((t) => t.covers.length > 0);
const FOUR = resolveProfile('standard', { guidelines: fourCovers() });
const LONG = resolveProfile('standard', { guidelines: standard.map((t, i) => (i === 0 ? { ...t, title: 'T'.repeat(90), description: 'D'.repeat(700), examples: Array.from({ length: 10 }, (_, k) => `example ${k}`) } : t)) });
const keys = (o: object): string[] => Object.keys(o).sort();

describe('problemsOf with the saved profile: only a section that was changed is judged', () => {
  it('without the saved profile every section is judged, as before', () => {
    expect(keys(problemsOf(draftOf(FOUR)))).toEqual(['guide-covers']);
  });
  it('a four-cover code profile, untouched, has no problem', () => {
    expect(problemsOf(draftOf(FOUR), FOUR)).toEqual({});
  });
  it('a code profile with a long title, description and ten examples, untouched, has no problem', () => {
    expect(keys(problemsOf(draftOf(LONG)))).toEqual(['guide-0-description', 'guide-0-examples', 'guide-0-title']);
    expect(problemsOf(draftOf(LONG), LONG)).toEqual({});
  });
  it('the same profile, once a principle is edited, is judged again (the missing covers and the long text)', () => {
    const d = draftOf(FOUR);
    d.guidelines = d.guidelines.map((g, i) => (i === 1 ? { ...g, title: 'Plain insults' } : g));
    expect(keys(problemsOf(d, FOUR))).toEqual(['guide-covers']);
    const long = draftOf(LONG);
    long.guidelines = long.guidelines.map((g, i) => (i === 3 ? { ...g, title: 'After' } : g));
    expect(keys(problemsOf(long, LONG))).toEqual(['guide-0-description', 'guide-0-examples', 'guide-0-title']);
  });
  it('an edit elsewhere is judged as before (a bad repeat window still refuses)', () => {
    const d = draftOf(FOUR);
    d.repeat = { ...d.repeat, windowDays: '0' };
    expect(keys(problemsOf(d, FOUR))).toEqual(['repeat-windowDays']);
  });
  it('team notes: untouched none; a note added with no text is judged', () => {
    const d = draftOf(FOUR);
    expect(problemsOf(d, FOUR)).toEqual({});
    d.teamNotes = [{ text: '  ', rule: '' }];
    expect(keys(problemsOf(d, FOUR))).toContain('note-0-text');
  });
});

describe('layerOf with the saved profile and layer', () => {
  it('a ladder edit on a four-cover code profile is a valid layer that sends the ladder and nothing else', () => {
    const d = draftOf(FOUR);
    d.ladder = d.ladder.map((r, i) => (i === 0 ? { ...r, lowMedium: { ...d.ladder[3]!.high } } : r));
    const r = layerOf(d, FOUR, FOUR, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.layer)).toEqual(['ladder']);
  });
  it('the same through the three-argument call (the saved layer left out)', () => {
    const d = draftOf(FOUR);
    d.repeat = { ...d.repeat, notes: '3' };
    const r = layerOf(d, FOUR, FOUR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.layer)).toEqual(['repeat']);
  });
  it('a long-text code profile is saved through a durations edit', () => {
    const d = draftOf(LONG);
    d.durations = [3_600_000];
    const r = layerOf(d, LONG, LONG, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.layer)).toEqual(['durations']);
  });
  it('a layer saved by a 0.2.1 hub (positional guidelines) is sent back as it is stored when another section is saved', () => {
    const saved: PolicyLayer = { guidelines: [null, { outcome: 'Our own outcome.' }] };
    const effective = applyPolicyLayer(PRESETS.standard as ModerationProfile, saved);
    const d = draftOf(effective);
    d.durations = [3_600_000];
    const r = layerOf(d, PRESETS.standard as ModerationProfile, effective, saved);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layer.guidelines).toEqual(saved.guidelines);
      expect(r.layer.durations).toEqual([3_600_000]);
    }
  });
  it('a saved whole-form layer is sent back as stored when another section is saved', () => {
    const tiers = standard.map((t, i) => (i === 0 ? { ...t, title: 'Banter and jokes' } : t));
    const saved: PolicyLayer = { guidelines: { tiers }, teamNotes: [{ text: 'We say gg.' }] };
    const effective = applyPolicyLayer(PRESETS.standard as ModerationProfile, saved);
    const d = draftOf(effective);
    d.durations = [3_600_000];
    const r = layerOf(d, PRESETS.standard as ModerationProfile, effective, saved);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layer.guidelines).toEqual(saved.guidelines);
      expect(r.layer.teamNotes).toEqual(saved.teamNotes);
    }
  });
  it('an edited principles section replaces the stored one with the whole form', () => {
    const saved: PolicyLayer = { guidelines: [null, { outcome: 'Our own outcome.' }] };
    const effective = applyPolicyLayer(PRESETS.standard as ModerationProfile, saved);
    const d = draftOf(effective);
    d.guidelines = d.guidelines.map((g, i) => (i === 0 ? { ...g, title: 'Banter and jokes' } : g));
    const r = layerOf(d, PRESETS.standard as ModerationProfile, effective, saved);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.layer.guidelines)).toBe(false);
  });
  it('dirtySections is unchanged by all this', () => {
    expect(dirtySections(draftOf(FOUR), FOUR)).toEqual([]);
  });
});

describe('the structure editor can add a cover that no principle holds', () => {
  const drafts = (p: ModerationProfile) => p.guidelines.map(tierDraftOf);
  const flatCovers = (tiers: ReturnType<typeof drafts>): GuidelineCover[] => tiers.flatMap((t) => t.covers);
  it('moveCover puts an uncovered level into the principle chosen, in the canonical order, and touches nothing else', () => {
    const before = drafts(FOUR);
    const copy = structuredClone(before);
    const r = moveCover(before, 'repeated', 2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tiers[2]!.covers).toEqual(['hostile', 'repeated']);
      expect(r.tiers.map((t) => t.title)).toEqual(before.map((t) => t.title));
      expect(r.tiers.filter((_, i) => i !== 2).map((t) => t.covers)).toEqual(before.filter((_, i) => i !== 2).map((t) => t.covers));
    }
    expect(before).toEqual(copy);
  });
  it('both missing covers moved in leave the covers exactly once and the draft valid', () => {
    let tiers = drafts(FOUR);
    for (const c of ['repeated', 'after_warning'] as const) {
      const r = moveCover(tiers, c, 0);
      expect(r.ok).toBe(true);
      if (r.ok) tiers = r.tiers;
    }
    expect([...flatCovers(tiers)].sort()).toEqual([...ALL_COVERS].sort());
    expect(tierProblems(tiers)['guide-covers']).toBeUndefined();
  });
  it('addTier takes uncovered levels into a new blank principle placed last', () => {
    const before = drafts(FOUR);
    const r = addTier(before, ['repeated', 'after_warning']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tiers).toHaveLength(before.length + 1);
      expect(r.tiers.at(-1)).toEqual({ title: '', description: '', examples: '', covers: ['repeated', 'after_warning'], outcome: '' });
      expect(r.tiers.slice(0, -1)).toEqual(before);
    }
  });
  it('addTier with an owned level and an uncovered one takes both and leaves the owner its other levels', () => {
    const before = drafts(PRESETS.standard as ModerationProfile).map((t) => ({ ...t, covers: t.covers.filter((c) => c !== 'after_warning') })).filter((t) => t.covers.length > 0);
    const r = addTier(before, ['hostile', 'after_warning']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const added = r.tiers.find((t) => t.title === '' && t.covers.includes('after_warning'))!;
      expect(added.covers).toEqual(['hostile', 'after_warning']);
      expect(r.tiers.find((t) => t.covers.includes('repeated'))!.covers).toEqual(['repeated']);
      expect(flatCovers(r.tiers).sort()).toEqual([...ALL_COVERS].sort());
    }
  });
  it('an uncovered level together with the only level of a principle still leaves that principle empty: refused', () => {
    const before = drafts(FOUR);
    expect(addTier(before, ['rude', 'repeated'])).toEqual({ ok: false, reason: 'empty_source' });
  });
  it('a name that is not a level is still unknown, and so is a tier that does not exist', () => {
    const before = drafts(FOUR);
    expect(moveCover(before, 'nonsense' as GuidelineCover, 0)).toEqual({ ok: false, reason: 'unknown_cover' });
    expect(addTier(before, ['nonsense' as GuidelineCover])).toEqual({ ok: false, reason: 'unknown_cover' });
    expect(moveCover(before, 'repeated', 9)).toEqual({ ok: false, reason: 'no_such_tier' });
  });
  it('a complete list behaves as it did: moving an owned level between principles keeps it exactly once', () => {
    const tiers = drafts(PRESETS.standard as ModerationProfile);
    const r = moveCover(tiers, 'hostile', 4);
    expect(r.ok).toBe(true);
    if (r.ok) expect(flatCovers(r.tiers).sort()).toEqual([...ALL_COVERS].sort());
  });
});
