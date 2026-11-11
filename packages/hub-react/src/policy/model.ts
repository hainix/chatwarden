import { DEFAULT_AREA_RULES, DEFAULT_DURATIONS, DEFAULT_SEVERE_RULES } from '@chatwarden/core';
import type { ConductLevel, ModerationProfile, Outcome, PolicyLayer, PolicyLadderRow, PolicySection } from '@chatwarden/core';
import type { Problem } from '../decision.js';
import { lengthValue, resolveLength } from './length.js';
import type { LengthDraft } from './length.js';

// The settings screen edits a local draft of the profile and sends a layer. The draft holds what was typed or picked (lengths as a
// menu value, numbers as text) so a half-typed value is kept as typed; the functions here turn it into the layer the kit takes,
// say what it refuses, which sections changed, and which field a refusal of the kit points at. No page, no network.

/** A profile as the kit may answer it: the two length fields are read defensively (an older kit leaves them out). */
export type ProfileLike = Omit<ModerationProfile, 'durations' | 'customDuration'> & Partial<Pick<ModerationProfile, 'durations' | 'customDuration'>>;

export type CellKind = 'chat' | 'area' | 'ban' | 'warning';
export type OutcomeKind = 'none' | 'note' | 'warning' | 'chat' | 'area' | 'ban';
export type Column = 'lowMedium' | 'high';
export const COLUMNS: readonly Column[] = ['lowMedium', 'high'];
/** The conduct levels with a first offence to edit: banter never punishes, so it is not here. */
export const EDITED_LEVELS = ['rude', 'hostile', 'severe'] as const;
export type EditedLevel = (typeof EDITED_LEVELS)[number];

export interface CellDraft {
  kind: CellKind;
  length: LengthDraft;
}
export interface OutcomeDraft {
  kind: OutcomeKind;
  length: LengthDraft;
}

export interface PolicyDraft {
  durations: number[];
  customDuration: boolean;
  ladder: Array<Record<Column, CellDraft>>;
  firstOffense: Record<EditedLevel, OutcomeDraft>;
  /** Numbers are text, as typed. */
  repeat: { windowDays: string; notes: string; distinctGames: boolean; outcome: OutcomeDraft };
  areaRules: number[];
  severeRules: number[];
  /** The outcome text of each guideline tier, by position. */
  guidelines: string[];
}

/** The kit's longest repeat window: the record only reaches back 90 days. */
export const MAX_WINDOW_DAYS = 90;
export const GUIDELINE_OUTCOME_MAX = 1000;

/** A kind has a length when it is a restriction or a ban. */
export const timed = (kind: string): boolean => kind === 'chat' || kind === 'area' || kind === 'ban';

const lengthOf = (kind: string, ms: number | null): LengthDraft => ({ value: timed(kind) ? lengthValue(ms) : '24h', amount: '', unit: 'hours' });

function outcomeDraft(o: Outcome): OutcomeDraft {
  return typeof o === 'string' ? { kind: o, length: lengthOf(o, null) } : { kind: o.kind, length: lengthOf(o.kind, o.durationMs) };
}

/** The draft a profile makes. Reads the two length fields defensively: a profile from an older kit has the default lengths. */
export function draftOf(profile: ProfileLike): PolicyDraft {
  return {
    durations: [...(profile.durations ?? DEFAULT_DURATIONS)],
    customDuration: profile.customDuration ?? true,
    ladder: profile.ladder.map((row) => ({
      lowMedium: { kind: row.lowMedium.kind as CellKind, length: lengthOf(row.lowMedium.kind, row.lowMedium.durationMs) },
      high: { kind: row.high.kind as CellKind, length: lengthOf(row.high.kind, row.high.durationMs) },
    })),
    firstOffense: { rude: outcomeDraft(profile.firstOffense.rude), hostile: outcomeDraft(profile.firstOffense.hostile), severe: outcomeDraft(profile.firstOffense.severe) },
    repeat: {
      windowDays: String(profile.repeat.windowDays),
      notes: String(profile.repeat.notes),
      distinctGames: profile.repeat.distinctGames,
      outcome: outcomeDraft(profile.repeat.outcome),
    },
    areaRules: [...(profile.areaRules ?? DEFAULT_AREA_RULES)],
    severeRules: [...(profile.severeRules ?? DEFAULT_SEVERE_RULES)],
    guidelines: profile.guidelines.map((g) => g.outcome),
  };
}

/** The draft with one section taken from a profile (a reset, or a reload), and every other section as it was. */
export function setSection(draft: PolicyDraft, section: PolicySection, profile: ProfileLike): PolicyDraft {
  const from = draftOf(profile);
  switch (section) {
    case 'durations':
      return { ...draft, durations: from.durations };
    case 'customDuration':
      return { ...draft, customDuration: from.customDuration };
    case 'ladder':
      return { ...draft, ladder: from.ladder };
    case 'firstOffense':
      return { ...draft, firstOffense: from.firstOffense };
    case 'repeat':
      return { ...draft, repeat: from.repeat };
    case 'areaRules':
      return { ...draft, areaRules: from.areaRules };
    case 'severeRules':
      return { ...draft, severeRules: from.severeRules };
    case 'guidelines':
      return { ...draft, guidelines: from.guidelines };
    default:
      // A section of a newer kit (Reporting) is edited by its own screen: this draft holds none of it.
      return draft;
  }
}

// What a length field resolves to, or (while it cannot) what was typed, so an unfinished value still counts as a change.
const lengthKey = (kind: string, l: LengthDraft): unknown => {
  if (!timed(kind)) return null;
  const r = resolveLength(l);
  return r.ok ? r.ms : ['typed', l.value, l.amount, l.unit];
};
const cellKey = (c: CellDraft): unknown => [c.kind, lengthKey(c.kind, c.length)];
const outcomeKey = (o: OutcomeDraft): unknown => [o.kind, lengthKey(o.kind, o.length)];

function sectionKey(d: PolicyDraft, section: PolicySection): string {
  switch (section) {
    case 'durations':
      return JSON.stringify(d.durations);
    case 'customDuration':
      return JSON.stringify(d.customDuration);
    case 'ladder':
      return JSON.stringify(d.ladder.map((r) => [cellKey(r.lowMedium), cellKey(r.high)]));
    case 'firstOffense':
      return JSON.stringify(EDITED_LEVELS.map((l) => outcomeKey(d.firstOffense[l])));
    case 'repeat':
      return JSON.stringify([d.repeat.windowDays.trim(), d.repeat.notes.trim(), d.repeat.distinctGames, outcomeKey(d.repeat.outcome)]);
    case 'areaRules':
      return JSON.stringify(d.areaRules);
    case 'severeRules':
      return JSON.stringify(d.severeRules);
    case 'guidelines':
      return JSON.stringify(d.guidelines);
    default:
      return '';
  }
}

/**
 * The saved sections this screen does not edit (Reporting, in a newer kit), as they are stored. A save replaces the whole layer, so they
 * go back in with it: saving the ladder must never drop what another screen saved.
 */
export function otherSections(layer: PolicyLayer): PolicyLayer {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer)) if (!(SECTION_ORDER as readonly string[]).includes(key)) out[key] = value;
  return out as PolicyLayer;
}

export const SECTION_ORDER: readonly PolicySection[] = ['durations', 'customDuration', 'ladder', 'firstOffense', 'repeat', 'areaRules', 'severeRules', 'guidelines'];

/** The sections whose draft differs from what is in force (`effective`), in the kit's order. */
export function dirtySections(draft: PolicyDraft, effective: ProfileLike): PolicySection[] {
  const saved = draftOf(effective);
  return SECTION_ORDER.filter((s) => sectionKey(draft, s) !== sectionKey(saved, s));
}

/** What the draft refuses before anything is sent, by field key (see {@link fieldKeyOf}). */
export function problemsOf(draft: PolicyDraft): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  const checkLength = (key: string, kind: string, l: LengthDraft): void => {
    if (!timed(kind)) return;
    const r = resolveLength(l);
    if (!r.ok) out[key] = r.problem;
  };
  draft.ladder.forEach((row, i) => {
    for (const col of COLUMNS) checkLength(`ladder-${i}-${col}-length`, row[col].kind, row[col].length);
  });
  for (const level of EDITED_LEVELS) checkLength(`first-${level}-length`, draft.firstOffense[level].kind, draft.firstOffense[level].length);
  const days = draft.repeat.windowDays.trim();
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > MAX_WINDOW_DAYS) out['repeat-windowDays'] = { key: 'hub.settings.repeat.error.days', params: { max: MAX_WINDOW_DAYS } };
  if (!/^\d+$/.test(draft.repeat.notes.trim()) || Number(draft.repeat.notes.trim()) < 1) out['repeat-notes'] = { key: 'hub.settings.repeat.error.notes' };
  checkLength('repeat-length', draft.repeat.outcome.kind, draft.repeat.outcome.length);
  draft.guidelines.forEach((text, i) => {
    if (text.trim() === '') out[`guide-${i}`] = { key: 'hub.settings.guideline.error.empty' };
    else if (text.length > GUIDELINE_OUTCOME_MAX) out[`guide-${i}`] = { key: 'hub.settings.guideline.error.long', params: { max: GUIDELINE_OUTCOME_MAX } };
  });
  return out;
}

const msOf = (kind: string, l: LengthDraft): number | null => {
  if (!timed(kind)) return null;
  const r = resolveLength(l);
  return r.ok ? r.ms : null;
};
const cellOf = (c: CellDraft): { kind: CellKind; durationMs: number | null } => ({ kind: c.kind, durationMs: msOf(c.kind, c.length) });
function outcomeOf(o: OutcomeDraft): Outcome {
  return timed(o.kind) ? { kind: o.kind as 'chat' | 'area' | 'ban', durationMs: msOf(o.kind, o.length) } : (o.kind as 'none' | 'note' | 'warning');
}

export type LayerResult = { ok: true; layer: PolicyLayer } | { ok: false; problems: Record<string, Problem> };

/**
 * The layer a draft sends: only the sections that differ from the profile in code (`base`), because a save replaces the whole layer
 * and a section left out goes back to the base. A ladder cell the draft left as it is in force keeps its label; an edited one gets the
 * kit's generated label. A draft with problems has no layer.
 */
export function layerOf(draft: PolicyDraft, base: ProfileLike, effective: ProfileLike): LayerResult {
  const problems = problemsOf(draft);
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const from = draftOf(base);
  const same = (s: PolicySection): boolean => sectionKey(draft, s) === sectionKey(from, s);
  const layer: PolicyLayer = {};
  if (!same('durations')) layer.durations = [...draft.durations];
  if (!same('customDuration')) layer.customDuration = draft.customDuration;
  if (!same('ladder')) {
    layer.ladder = draft.ladder.map((row, i): PolicyLadderRow => {
      const cell = (col: Column): PolicyLadderRow['lowMedium'] => {
        const now = cellOf(row[col]);
        const was = effective.ladder[i]?.[col];
        const kept = was !== undefined && was.kind === now.kind && was.durationMs === now.durationMs;
        return kept ? { ...now, label: was.label } : now;
      };
      return { step: i as PolicyLadderRow['step'], lowMedium: cell('lowMedium'), high: cell('high') };
    });
  }
  if (!same('firstOffense')) {
    const first: Partial<Record<ConductLevel, Outcome>> = {};
    for (const level of EDITED_LEVELS) if (JSON.stringify(outcomeKey(draft.firstOffense[level])) !== JSON.stringify(outcomeKey(from.firstOffense[level]))) first[level] = outcomeOf(draft.firstOffense[level]);
    layer.firstOffense = first;
  }
  if (!same('repeat')) {
    const repeat: NonNullable<PolicyLayer['repeat']> = {};
    if (draft.repeat.windowDays.trim() !== from.repeat.windowDays) repeat.windowDays = Number(draft.repeat.windowDays.trim());
    if (draft.repeat.notes.trim() !== from.repeat.notes) repeat.notes = Number(draft.repeat.notes.trim());
    if (draft.repeat.distinctGames !== from.repeat.distinctGames) repeat.distinctGames = draft.repeat.distinctGames;
    if (JSON.stringify(outcomeKey(draft.repeat.outcome)) !== JSON.stringify(outcomeKey(from.repeat.outcome))) repeat.outcome = outcomeOf(draft.repeat.outcome);
    layer.repeat = repeat;
  }
  if (!same('areaRules')) layer.areaRules = [...draft.areaRules];
  if (!same('severeRules')) layer.severeRules = [...draft.severeRules];
  if (!same('guidelines')) layer.guidelines = draft.guidelines.map((text, i) => (text === from.guidelines[i] ? null : { outcome: text }));
  return { ok: true, layer };
}

/**
 * The field a refusal of the kit points at, as a key the screen puts on the field (`data-field`), or null when the path names no one
 * field (`layer`, `layer.profanity`, `reason`). Paths are the kit's: `layer.ladder[2].high.durationMs`, `layer.firstOffense.severe`.
 */
export function fieldKeyOf(path: string): string | null {
  let m = /^layer\.durations(\[\d+\])?$/.exec(path);
  if (m !== null) return 'durations';
  if (path === 'layer.customDuration') return 'custom';
  m = /^layer\.ladder(?:\[(\d+)\](?:\.(lowMedium|high)(?:\.(\w+))?)?)?$/.exec(path);
  if (m !== null) {
    const row = m[1] ?? '0';
    const col = m[2] ?? 'lowMedium';
    return `ladder-${row}-${col}-${m[3] === 'durationMs' ? 'length' : 'kind'}`;
  }
  m = /^layer\.firstOffense\.(rude|hostile|severe)(?:\.(\w+))?$/.exec(path);
  if (m !== null) return `first-${m[1]}-${m[2] === 'durationMs' ? 'length' : 'kind'}`;
  m = /^layer\.repeat\.(windowDays|notes|distinctGames|outcome)(?:\.(\w+))?$/.exec(path);
  if (m !== null) {
    if (m[1] === 'distinctGames') return 'repeat-distinct';
    if (m[1] === 'outcome') return m[2] === 'durationMs' ? 'repeat-length' : 'repeat-kind';
    return `repeat-${m[1]}`;
  }
  if (/^layer\.areaRules(\[\d+\])?$/.test(path)) return 'area';
  if (/^layer\.severeRules(\[\d+\])?$/.test(path)) return 'severe';
  m = /^layer\.guidelines(?:\[(\d+)\](?:\.\w+)?)?$/.exec(path);
  if (m !== null) return `guide-${m[1] ?? '0'}`;
  return null;
}
