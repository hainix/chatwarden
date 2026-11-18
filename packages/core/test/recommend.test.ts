import { describe, expect, it } from 'vitest';
import { CREATOR_TEAM_NOTE, GAME_KINDS, GAME_PRESET, isGameKind, recommendFor } from '../src/recommend.js';
import type { GameKind } from '../src/recommend.js';
import { applyPolicyLayer, PRESETS } from '../src/profile.js';
import type { PresetName } from '../src/profile.js';

const BASES: PresetName[] = ['relaxed', 'standard', 'strict'];

describe('the game kinds', () => {
  it('GAME_KINDS is exactly competitive, social, kids, creator in that order; GAME_PRESET maps relaxed, standard, strict, standard', () => {
    expect([...GAME_KINDS]).toEqual(['competitive', 'social', 'kids', 'creator']);
    expect(GAME_PRESET).toEqual({ competitive: 'relaxed', social: 'standard', kids: 'strict', creator: 'standard' });
    expect(Object.isFrozen(GAME_PRESET)).toBe(true);
  });

  it("creator's note is CREATOR_TEAM_NOTE, equal to the literal in the spec", () => {
    expect(CREATOR_TEAM_NOTE).toBe('Protect the creator and their guests from targeted abuse');
    expect(recommendFor('creator').layer.teamNotes).toEqual([{ text: 'Protect the creator and their guests from targeted abuse' }]);
  });

  it("recommendFor('nope') throws RangeError; isGameKind accepts the four and refuses 'Kids', '', null, 3", () => {
    expect(() => recommendFor('nope' as GameKind)).toThrow(RangeError);
    expect(() => recommendFor('nope' as GameKind)).toThrow('game must be one of competitive, social, kids or creator');
    for (const bad of ['Kids', '', null, 3, undefined, {}, ['kids'], 'constructor', '__proto__', 'toString']) {
      expect(() => recommendFor(bad as GameKind), String(bad)).toThrow(RangeError);
      expect(isGameKind(bad), String(bad)).toBe(false);
    }
    for (const g of GAME_KINDS) expect(isGameKind(g)).toBe(true);
  });
});

describe('recommendFor', () => {
  it('the layer has exactly guidelines, firstOffense, repeat, ladder, aiContext (and teamNotes for creator only)', () => {
    for (const game of GAME_KINDS) {
      const keys = Object.keys(recommendFor(game).layer).sort();
      expect(keys, game).toEqual(game === 'creator' ? ['aiContext', 'firstOffense', 'guidelines', 'ladder', 'repeat', 'teamNotes'] : ['aiContext', 'firstOffense', 'guidelines', 'ladder', 'repeat']);
    }
  });

  it('answers the game, its preset and the layer', () => {
    for (const game of GAME_KINDS) {
      const r = recommendFor(game);
      expect(r.game).toBe(game);
      expect(r.preset).toBe(GAME_PRESET[game]);
      expect(Object.keys(r).sort()).toEqual(['game', 'layer', 'preset']);
    }
  });

  it('the guidelines are the whole form, the firstOffense has all four levels, the repeat all four fields and the ladder six rows with labels', () => {
    for (const game of GAME_KINDS) {
      const { layer, preset } = recommendFor(game);
      const p = PRESETS[preset];
      expect(layer.guidelines, game).toEqual({ tiers: p.guidelines });
      expect(Object.keys(layer.firstOffense ?? {}).sort(), game).toEqual(['banter', 'hostile', 'rude', 'severe']);
      expect(Object.keys(layer.repeat ?? {}).sort(), game).toEqual(['distinctGames', 'notes', 'outcome', 'windowDays']);
      expect(layer.ladder, game).toHaveLength(6);
      for (const row of layer.ladder ?? []) {
        expect(typeof row.lowMedium.label).toBe('string');
        expect(typeof row.high.label).toBe('string');
      }
      expect(layer.aiContext).toBe(p.aiContext);
    }
  });

  it('for each game the layer applies over every preset as base and the effective firstOffense, repeat, ladder, guidelines and aiContext equal the chosen preset', () => {
    for (const game of GAME_KINDS) {
      const { layer, preset } = recommendFor(game);
      for (const base of BASES) {
        const eff = applyPolicyLayer(PRESETS[base], layer);
        const want = PRESETS[preset];
        expect(eff.firstOffense, `${game} over ${base}`).toEqual(want.firstOffense);
        expect(eff.repeat, `${game} over ${base}`).toEqual(want.repeat);
        expect(eff.ladder, `${game} over ${base}`).toEqual(want.ladder);
        expect(eff.guidelines, `${game} over ${base}`).toEqual(want.guidelines);
        expect(eff.aiContext, `${game} over ${base}`).toBe(want.aiContext);
        // what the layer never carries stays the base's
        expect(eff.levels).toEqual(PRESETS[base].levels);
        expect(eff.profanity).toEqual(PRESETS[base].profanity);
        expect(eff.durations).toEqual(PRESETS[base].durations);
        expect(eff.teamNotes).toEqual(game === 'creator' ? [{ text: CREATOR_TEAM_NOTE }] : []);
      }
    }
  });

  it('kids over the relaxed preset gives the strict principles and ladder (a different base)', () => {
    const eff = applyPolicyLayer(PRESETS.relaxed, recommendFor('kids').layer);
    expect(eff.ladder).toEqual(PRESETS.strict.ladder);
    expect(eff.guidelines).toEqual(PRESETS.strict.guidelines);
    expect(eff.firstOffense).toEqual(PRESETS.strict.firstOffense);
    expect(eff.firstOffense).not.toEqual(PRESETS.relaxed.firstOffense);
    expect(eff.guidelines).not.toEqual(PRESETS.relaxed.guidelines);
  });

  it('levels and profanity are never in the layer', () => {
    for (const game of GAME_KINDS) {
      const layer = recommendFor(game).layer as Record<string, unknown>;
      expect(Object.hasOwn(layer, 'levels')).toBe(false);
      expect(Object.hasOwn(layer, 'profanity')).toBe(false);
    }
  });

  it('JSON round trip equals the layer', () => {
    for (const game of GAME_KINDS) {
      const { layer } = recommendFor(game);
      expect(JSON.parse(JSON.stringify(layer))).toEqual(layer);
    }
  });

  it('two calls give independent copies; mutating one changes neither the other nor PRESETS', () => {
    const before = JSON.stringify(PRESETS);
    const a = recommendFor('creator');
    const b = recommendFor('creator');
    expect(a).toEqual(b);
    expect(a.layer).not.toBe(b.layer);
    const tiers = (a.layer.guidelines as { tiers: Array<{ title: string; examples: string[] }> }).tiers;
    tiers[0]!.title = 'changed';
    tiers[0]!.examples.push('extra');
    (a.layer.ladder ?? [])[0]!.lowMedium.label = 'changed';
    (a.layer.firstOffense as Record<string, unknown>)['rude'] = 'none';
    (a.layer.repeat as { notes: number }).notes = 99;
    (a.layer.teamNotes ?? [])[0]!.text = 'changed';
    a.layer.aiContext = 'changed';
    expect(recommendFor('creator')).toEqual(b);
    expect(JSON.stringify(PRESETS)).toBe(before);
    expect(Object.isFrozen(a.layer)).toBe(false);
  });
});
