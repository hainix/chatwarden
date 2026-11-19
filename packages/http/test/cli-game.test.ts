import { describe, expect, it } from 'vitest';
import * as core from '@chatwarden/core';
import { CREATOR_TEAM_NOTE, GAME_PRESETS } from '../src/cli/answers.js';
import { serviceFiles } from '../src/cli/templates/service.js';
import { VERSION } from '../src/version.js';

// The CLI imports nothing from @chatwarden/core (a template is text), so its copy of the game map and of the creator note is pinned to core's here. This is the one CLI test that
// imports core.

describe('the CLI copy of the game recommendation equals core', () => {
  it("GAME_PRESETS equals core's GAME_PRESET and the keys equal GAME_KINDS", () => {
    expect({ ...GAME_PRESETS }).toEqual({ ...core.GAME_PRESET });
    expect(Object.keys(GAME_PRESETS)).toEqual([...core.GAME_KINDS]);
  });

  it("CREATOR_TEAM_NOTE equals core's CREATOR_TEAM_NOTE, and is what the core recommends for a creator", () => {
    expect(CREATOR_TEAM_NOTE).toBe(core.CREATOR_TEAM_NOTE);
    expect(core.recommendFor('creator').layer.teamNotes).toEqual([{ text: CREATOR_TEAM_NOTE }]);
  });

  it("the CLI's preset for each game is the preset core recommends", () => {
    for (const game of core.GAME_KINDS) expect(GAME_PRESETS[game], game).toBe(core.recommendFor(game).preset);
  });

  it('core.resolveProfile(preset, { teamNotes: [{ text: CREATOR_TEAM_NOTE }] }) is valid for the creator output', () => {
    const resolved = core.resolveProfile(GAME_PRESETS.creator, { teamNotes: [{ text: CREATOR_TEAM_NOTE }] });
    expect(resolved.teamNotes).toEqual([{ text: CREATOR_TEAM_NOTE }]);
    expect(resolved.id).toBe('standard');
  });

  it("the service profile.json for creator is { preset, ...overrides } that core's resolveProfile takes, with the loader's own split", () => {
    const file = serviceFiles({ store: 'sqlite', profile: 'standard', dir: 'x', game: 'creator' }, { chatwarden: VERSION }).find((f) => f.path === 'x/profile.json')!;
    const json = JSON.parse(file.content) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['preset', 'teamNotes', 'contexts', 'names']);
    // serve.ts splitProfile: every key besides preset and phrases is an override
    const { preset, ...overrides } = json;
    const resolved = core.resolveProfile(preset as 'standard', overrides as never);
    expect(resolved.teamNotes).toEqual([{ text: CREATOR_TEAM_NOTE }]);
  });
});
