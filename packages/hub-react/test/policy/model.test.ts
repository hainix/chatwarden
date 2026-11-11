import { applyPolicyLayer, resolveProfile } from '@chatwarden/core';
import type { ModerationProfile } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { dirtySections, draftOf, fieldKeyOf, layerOf, otherSections, problemsOf, setSection } from '../../src/policy/model.js';
import type { PolicyDraft } from '../../src/policy/model.js';

// The settings screen edits a local draft of the profile. These are its rules as plain functions: the draft a profile makes, the
// layer a draft sends (only what differs from the code's profile, so a section left alone is reset), what the draft refuses,
// which sections changed, and which field a server refusal points at.

const H = 3_600_000;
const D = 24 * H;
const base: ModerationProfile = resolveProfile('standard');
const fresh = (): PolicyDraft => draftOf(base);
const layer = (d: PolicyDraft, effective: ModerationProfile = base) => {
  const r = layerOf(d, base, effective);
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r.problems)}`);
  return r.layer;
};
const len = (value: string, amount = '', unit: 'hours' | 'days' = 'hours') => ({ value, amount, unit });

describe('an untouched draft', () => {
  it('sends an empty layer: nothing differs from the profile in code', () => {
    expect(layer(fresh())).toEqual({});
  });
  it('is not dirty', () => {
    expect(dirtySections(fresh(), base)).toEqual([]);
  });
  it('holds every editable thing of the profile', () => {
    const d = fresh();
    expect(d.durations).toEqual([...(base.durations ?? [])]);
    expect(d.customDuration).toBe(true);
    expect(d.ladder).toHaveLength(6);
    expect(d.ladder[2]?.high.kind).toBe(base.ladder[2]?.high.kind);
    expect(d.firstOffense.hostile.kind).toBe('chat');
    expect(d.firstOffense.hostile.length.value).toBe('24h');
    expect(d.firstOffense.rude.kind).toBe('warning');
    expect(d.repeat).toMatchObject({ windowDays: '30', notes: '2', distinctGames: false });
    expect(d.areaRules).toEqual([5, 6]);
    expect(d.severeRules).toEqual([1]);
    expect(d.guidelines).toEqual(base.guidelines.map((g) => g.outcome));
  });
  it('reads a profile that leaves the new fields out with their defaults (an older kit)', () => {
    const old: Record<string, unknown> = { ...base };
    delete old.durations;
    delete old.customDuration;
    const d = draftOf(old as never);
    expect(d.durations).toEqual([H, 6 * H, 12 * H, D, 3 * D, 7 * D, 30 * D]);
    expect(d.customDuration).toBe(true);
  });
});

describe('each section, edited, sends only itself and is valid for the kit', () => {
  const check = (d: PolicyDraft, sections: string[]): ModerationProfile => {
    const l = layer(d);
    expect(Object.keys(l).sort()).toEqual([...sections].sort());
    return applyPolicyLayer(base, l);
  };

  it('durations', () => {
    const d = fresh();
    d.durations = [30 * 60_000, H, 2 * H];
    expect(check(d, ['durations']).durations).toEqual([30 * 60_000, H, 2 * H]);
  });
  it('the custom switch', () => {
    const d = fresh();
    d.customDuration = false;
    expect(check(d, ['customDuration']).customDuration).toBe(false);
  });
  it('the ladder: all six rows, the unchanged cells keep their label, the changed cell gets a generated one', () => {
    const d = fresh();
    d.ladder = d.ladder.map((r, i) => (i === 0 ? { ...r, lowMedium: { kind: 'chat', length: len(String(6 * H)) } } : r));
    const l = layer(d);
    expect(l.ladder).toHaveLength(6);
    expect(l.ladder?.[0]?.lowMedium).toEqual({ kind: 'chat', durationMs: 6 * H });
    expect(l.ladder?.[0]?.high).toEqual({ kind: base.ladder[0]?.high.kind, durationMs: base.ladder[0]?.high.durationMs, label: base.ladder[0]?.high.label });
    expect(l.ladder?.[3]?.lowMedium.label).toBe(base.ladder[3]?.lowMedium.label);
    const got = check(d, ['ladder']);
    expect(got.ladder[0]?.lowMedium).toMatchObject({ kind: 'chat', durationMs: 6 * H, label: 'Restrict chat 6 hours' });
  });
  it('a warning cell has no length, permanent is null, a custom length is read', () => {
    const d = fresh();
    d.ladder = d.ladder.map((r, i) =>
      i === 1
        ? { lowMedium: { kind: 'warning', length: len(String(D)) }, high: { kind: 'ban', length: len('permanent') } }
        : i === 2
          ? { ...r, lowMedium: { kind: 'area', length: len('custom', '2', 'days') } }
          : r,
    );
    const l = layer(d);
    expect(l.ladder?.[1]?.lowMedium).toEqual({ kind: 'warning', durationMs: null });
    expect(l.ladder?.[1]?.high).toEqual({ kind: 'ban', durationMs: null });
    expect(l.ladder?.[2]?.lowMedium).toEqual({ kind: 'area', durationMs: 2 * D });
    check(d, ['ladder']);
  });
  it('first offence: only the levels that changed', () => {
    const d = fresh();
    d.firstOffense.hostile = { kind: 'chat', length: len(String(6 * H)) };
    d.firstOffense.rude = { kind: 'note', length: len(String(D)) };
    const l = layer(d);
    expect(l.firstOffense).toEqual({ rude: 'note', hostile: { kind: 'chat', durationMs: 6 * H } });
    expect(check(d, ['firstOffense']).firstOffense.hostile).toEqual({ kind: 'chat', durationMs: 6 * H });
  });
  it('first offence: "no action" and "warning" have no length', () => {
    const d = fresh();
    d.firstOffense.rude = { kind: 'none', length: len(String(D)) };
    d.firstOffense.hostile = { kind: 'warning', length: len('permanent') };
    expect(layer(d).firstOffense).toEqual({ rude: 'none', hostile: 'warning' });
  });
  it('repeated: only the keys that changed', () => {
    const d = fresh();
    d.repeat = { ...d.repeat, notes: '3', distinctGames: true };
    expect(layer(d).repeat).toEqual({ notes: 3, distinctGames: true });
    d.repeat = { ...d.repeat, windowDays: '60', outcome: { kind: 'warning', length: len(String(D)) } };
    expect(layer(d).repeat).toEqual({ notes: 3, distinctGames: true, windowDays: 60, outcome: 'warning' });
    check(d, ['repeat']);
  });
  it('area and severe rules', () => {
    const d = fresh();
    d.areaRules = [2, 5];
    d.severeRules = [];
    expect(layer(d)).toEqual({ areaRules: [2, 5], severeRules: [] });
    expect(check(d, ['areaRules', 'severeRules']).areaRules).toEqual([2, 5]);
  });
  it('the guidelines: positional, null for a tier left as it is', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((g, i) => (i === 1 ? 'A warning, then a short chat break.' : g));
    const l = layer(d);
    expect(l.guidelines).toEqual(base.guidelines.map((_, i) => (i === 1 ? { outcome: 'A warning, then a short chat break.' } : null)));
    expect(check(d, ['guidelines']).guidelines[1]?.outcome).toBe('A warning, then a short chat break.');
  });
  it('putting a value back to the code makes the section drop out of the layer', () => {
    const d = fresh();
    d.durations = [H];
    expect(Object.keys(layer(d))).toEqual(['durations']);
    d.durations = [...(base.durations ?? [])];
    expect(layer(d)).toEqual({});
  });
});

describe('the code can already differ from the preset: the layer is measured against the base the server gave', () => {
  it('a profile with its own durations, set in code, is the base', () => {
    const own = resolveProfile('standard', { durations: [2 * H, 4 * H] });
    const d = draftOf(own);
    expect(d.durations).toEqual([2 * H, 4 * H]);
    expect(layerOf(d, own, own)).toEqual({ ok: true, layer: {} });
  });
  it('an effective profile (with a saved layer) starts the draft; the layer is still against the base', () => {
    const effective = applyPolicyLayer(base, { durations: [H] });
    const d = draftOf(effective);
    expect(d.durations).toEqual([H]);
    const r = layerOf(d, base, effective);
    expect(r).toEqual({ ok: true, layer: { durations: [H] } });
    expect(dirtySections(d, effective)).toEqual([]);
  });
});

describe('dirtySections: what differs from what is saved', () => {
  it('names the sections in the kit order', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((g, i) => (i === 0 ? 'x' : g));
    d.durations = [H];
    d.severeRules = [1, 2];
    expect(dirtySections(d, base)).toEqual(['durations', 'severeRules', 'guidelines']);
  });
  it('a length typed but not yet valid still counts as a change', () => {
    const d = fresh();
    d.ladder = d.ladder.map((r, i) => (i === 0 ? { ...r, high: { ...r.high, length: len('custom', '', 'hours') } } : r));
    expect(dirtySections(d, base)).toEqual(['ladder']);
  });
  it('setSection puts one section back to a profile and leaves the others', () => {
    const d = fresh();
    d.durations = [H];
    d.severeRules = [1, 2];
    const back = setSection(d, 'durations', base);
    expect(back.durations).toEqual([...(base.durations ?? [])]);
    expect(back.severeRules).toEqual([1, 2]);
    expect(setSection(d, 'customDuration', applyPolicyLayer(base, { customDuration: false })).customDuration).toBe(false);
  });
});

describe('problemsOf: what the draft refuses before anything is sent', () => {
  it('a clean draft has none', () => {
    expect(problemsOf(fresh())).toEqual({});
  });
  it('a custom length with no number, in a cell, a first offence and the repeat rule', () => {
    const d = fresh();
    d.ladder = d.ladder.map((r, i) => (i === 3 ? { ...r, high: { kind: 'ban', length: len('custom', '', 'days') } } : r));
    d.firstOffense.hostile = { kind: 'chat', length: len('custom', '400', 'days') };
    d.repeat = { ...d.repeat, outcome: { kind: 'chat', length: len('custom', 'x', 'days') } };
    const p = problemsOf(d);
    expect(Object.keys(p).sort()).toEqual(['first-hostile-length', 'ladder-3-high-length', 'repeat-length']);
    expect(p['ladder-3-high-length']?.key).toBe('hub.length.error.empty');
    expect(p['first-hostile-length']?.key).toBe('hub.length.error.long');
    expect(p['repeat-length']?.key).toBe('hub.length.error.number');
  });
  it('repeat numbers must be whole, the window at most 90 days', () => {
    const d = fresh();
    d.repeat = { ...d.repeat, notes: '0', windowDays: '91' };
    expect(Object.keys(problemsOf(d)).sort()).toEqual(['repeat-notes', 'repeat-windowDays']);
    d.repeat = { ...d.repeat, notes: '1.5', windowDays: '' };
    expect(Object.keys(problemsOf(d)).sort()).toEqual(['repeat-notes', 'repeat-windowDays']);
    d.repeat = { ...d.repeat, notes: '5', windowDays: '90' };
    expect(problemsOf(d)).toEqual({});
  });
  it('a guideline outcome must have words and at most 1000 characters', () => {
    const d = fresh();
    d.guidelines = d.guidelines.map((g, i) => (i === 0 ? '   ' : i === 2 ? 'x'.repeat(1001) : g));
    const p = problemsOf(d);
    expect(Object.keys(p).sort()).toEqual(['guide-0', 'guide-2']);
    d.guidelines[2] = 'x'.repeat(1000);
    expect(Object.keys(problemsOf(d))).toEqual(['guide-0']);
  });
  it('layerOf refuses a draft with problems, and says which', () => {
    const d = fresh();
    d.repeat = { ...d.repeat, notes: '0' };
    const r = layerOf(d, base, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.problems)).toEqual(['repeat-notes']);
  });
});

describe('fieldKeyOf: the field a server refusal points at', () => {
  it.each<[string, string | null]>([
    ['layer.durations', 'durations'],
    ['layer.durations[3]', 'durations'],
    ['layer.customDuration', 'custom'],
    ['layer.ladder[2].high.durationMs', 'ladder-2-high-length'],
    ['layer.ladder[0].lowMedium.kind', 'ladder-0-lowMedium-kind'],
    ['layer.ladder[5].high.label', 'ladder-5-high-kind'],
    ['layer.ladder[4]', 'ladder-4-lowMedium-kind'],
    ['layer.ladder', 'ladder-0-lowMedium-kind'],
    ['layer.firstOffense.severe', 'first-severe-kind'],
    ['layer.firstOffense.hostile.durationMs', 'first-hostile-length'],
    ['layer.firstOffense.rude.kind', 'first-rude-kind'],
    ['layer.repeat.windowDays', 'repeat-windowDays'],
    ['layer.repeat.notes', 'repeat-notes'],
    ['layer.repeat.distinctGames', 'repeat-distinct'],
    ['layer.repeat.outcome', 'repeat-kind'],
    ['layer.repeat.outcome.durationMs', 'repeat-length'],
    ['layer.areaRules[1]', 'area'],
    ['layer.severeRules', 'severe'],
    ['layer.guidelines[2].outcome', 'guide-2'],
    ['layer.guidelines', 'guide-0'],
    ['layer', null],
    ['layer.profanity', null],
    ['version', null],
    ['reason', null],
    ['', null],
  ])('%s -> %s', (path, key) => {
    expect(fieldKeyOf(path)).toBe(key);
  });
});

describe('otherSections: what another screen saved goes back with a save', () => {
  it('keeps a section this screen does not edit, and none of its own', () => {
    const stored = { durations: [H], reporting: { thanks: 'Thanks!' } } as never;
    expect(otherSections(stored)).toEqual({ reporting: { thanks: 'Thanks!' } });
    expect(otherSections({ durations: [H] })).toEqual({});
    expect(otherSections({})).toEqual({});
  });
  it('a draft is not dirty for a section it does not hold, and setSection leaves it alone', () => {
    const d = fresh();
    expect(setSection(d, 'reporting' as never, base)).toBe(d);
    expect(dirtySections(d, base)).toEqual([]);
  });
});
