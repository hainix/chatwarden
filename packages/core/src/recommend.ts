import { PRESETS } from './profile.js';
import type { PolicyCell, PolicyLayer, PresetName } from './profile.js';
import type { LadderCell } from './ladder.js';

// The recommended setup (0.2.2): the owner says what kind of game this is, and the kit proposes a starting layer built from one of its presets,
// the principles, the first-offence table, the repeat rule, the ladder and the AI standard together. Pure: nothing here saves anything.

/** What kind of game this is: the one question of the first-run setup. */
export const GAME_KINDS = ['competitive', 'social', 'kids', 'creator'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/** The preset each kind of game starts from. */
export const GAME_PRESET: Readonly<Record<GameKind, PresetName>> = Object.freeze({
  competitive: 'relaxed',
  social: 'standard',
  kids: 'strict',
  creator: 'standard',
});

/** The one team note a creator game starts with. */
export const CREATOR_TEAM_NOTE = 'Protect the creator and their guests from targeted abuse';

/** A recommended starting point: the game, the preset it comes from and the layer to save (a fresh, JSON-clean object on every call). */
export interface Recommendation {
  game: GameKind;
  preset: PresetName;
  layer: PolicyLayer;
}

/** A ladder cell as a layer holds it: a fresh copy, the label kept. A ladder cell is never a note, so the kind narrows. */
const cell = (c: LadderCell): PolicyCell => ({ kind: c.kind as PolicyCell['kind'], durationMs: c.durationMs, label: c.label });

/** True for one of the four {@link GAME_KINDS}. */
export function isGameKind(v: unknown): v is GameKind {
  return typeof v === 'string' && (GAME_KINDS as readonly string[]).includes(v);
}

/**
 * The recommended layer for a kind of game, built from the matching preset: its guideline tiers (the whole form), first-offence table, repeat rule,
 * ladder and AI standard, and for a creator game the one team note. Never `levels` or `profanity` (they stay in code). Applying it over any base
 * makes those sections equal the preset's. Throws `RangeError` for anything but a {@link GAME_KINDS} value.
 */
export function recommendFor(game: GameKind): Recommendation {
  if (!isGameKind(game)) throw new RangeError('game must be one of competitive, social, kids or creator');
  const preset = GAME_PRESET[game];
  const p = PRESETS[preset];
  const layer: PolicyLayer = {
    guidelines: { tiers: structuredClone(p.guidelines) },
    firstOffense: structuredClone(p.firstOffense),
    repeat: structuredClone(p.repeat),
    ladder: p.ladder.map((r) => ({ step: r.step, lowMedium: cell(r.lowMedium), high: cell(r.high) })),
    aiContext: p.aiContext,
    ...(game === 'creator' ? { teamNotes: [{ text: CREATOR_TEAM_NOTE }] } : {}),
  };
  return { game, preset, layer };
}
