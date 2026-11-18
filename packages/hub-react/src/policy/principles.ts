import { looksLikeInjection, MAX_GUIDELINE_OUTCOME, MAX_TIER_DESCRIPTION, MAX_TIER_EXAMPLE, MAX_TIER_EXAMPLES, MAX_TIER_TITLE, TEAM_NOTE_MAX, TEAM_NOTES_MAX } from '@chatwarden/core';
import type { GuidelineCover, GuidelineTier, TeamNote } from '@chatwarden/core';
import type { Problem } from '../decision.js';
import { charsOf } from './reporting.js';

// The pure rules of the principles editor (the Moderation principles and Team notes panels): the tiers and notes as typed, the structure operations (add or split a principle, remove or merge
// one, move a level between principles) and what the draft refuses before anything is sent. Every operation returns a NEW list and keeps every cover in exactly one tier, no tier empty, the
// covers of a tier in the canonical order. No React, no network.

export { MAX_GUIDELINE_OUTCOME, MAX_TIER_DESCRIPTION, MAX_TIER_EXAMPLE, MAX_TIER_EXAMPLES, MAX_TIER_TITLE, TEAM_NOTE_MAX, TEAM_NOTES_MAX };

/** The six things a principle can cover, in the order the kit and the guide list them. */
export const ALL_COVERS: readonly GuidelineCover[] = ['banter', 'rude', 'hostile', 'severe', 'repeated', 'after_warning'];

/** One principle as typed: the examples are one text, a line each. */
export interface TierDraft {
  title: string;
  description: string;
  /** One example per line. */
  examples: string;
  covers: GuidelineCover[];
  outcome: string;
}

/** One team note as typed: the rule is the digits typed, or empty for "any rule". */
export interface NoteDraft {
  text: string;
  rule: string;
}

/** Why a structure change was refused. `no_such_tier` is a tier index that is not in the list. */
export type TierEdit = { ok: true; tiers: TierDraft[] } | { ok: false; reason: 'none_chosen' | 'unknown_cover' | 'empty_source' | 'last_tier' | 'no_such_tier' };

const inOrder = (covers: readonly GuidelineCover[]): GuidelineCover[] => ALL_COVERS.filter((c) => covers.includes(c));
const copyTier = (t: TierDraft): TierDraft => ({ ...t, covers: [...t.covers] });
const isCover = (c: unknown): c is GuidelineCover => (ALL_COVERS as readonly unknown[]).includes(c);

/** The draft a tier of the profile makes. */
export function tierDraftOf(t: GuidelineTier): TierDraft {
  return { title: t.title, description: t.description, examples: t.examples.join('\n'), covers: inOrder(t.covers), outcome: t.outcome };
}

/** The lines of an examples text: trimmed, blanks dropped. */
const linesOf = (examples: string): string[] =>
  examples
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** What a save carries: every text trimmed, the examples split on newlines with blank lines dropped. */
export function tiersOf(tiers: readonly TierDraft[]): GuidelineTier[] {
  return tiers.map((t) => ({ title: t.title.trim(), description: t.description.trim(), examples: linesOf(t.examples), covers: [...t.covers], outcome: t.outcome.trim() }));
}

/** The note as a layer carries it: no `rule` key for "any rule". A rule that is not digits is kept as typed (the draft then has a problem, so it is never sent). */
export function notesOf(notes: readonly NoteDraft[]): TeamNote[] {
  return notes.map((n) => {
    const rule = n.rule.trim();
    return rule === '' ? { text: n.text.trim() } : { text: n.text.trim(), rule: /^\d+$/.test(rule) ? Number(rule) : Number.NaN };
  });
}

/**
 * Take the chosen covers out of the principle(s) that own them and put them in a new, blank principle placed right after the first of those (a level no principle holds, from a 0.2.1
 * profile in code, is simply added: with only such levels the new principle goes last). Refused when none is chosen, when a chosen name is not a level, or when it would leave a
 * principle with nothing (`empty_source`: a principle needs at least one level).
 */
export function addTier(tiers: readonly TierDraft[], covers: readonly GuidelineCover[]): TierEdit {
  const chosen = inOrder(covers.filter(isCover));
  if (covers.length === 0) return { ok: false, reason: 'none_chosen' };
  if (chosen.length !== new Set(covers).size) return { ok: false, reason: 'unknown_cover' };
  const owners = chosen.map((c) => tiers.findIndex((t) => t.covers.includes(c))).filter((i) => i >= 0);
  const next = tiers.map((t) => ({ ...copyTier(t), covers: t.covers.filter((c) => !chosen.includes(c)) }));
  if (next.some((t) => t.covers.length === 0)) return { ok: false, reason: 'empty_source' };
  const after = owners.length === 0 ? next.length - 1 : Math.min(...owners);
  next.splice(after + 1, 0, { title: '', description: '', examples: '', covers: chosen, outcome: '' });
  return { ok: true, tiers: next };
}

/** Remove a principle: its covers go to the principle above it (the next one when it is the first), its text is dropped. The only principle cannot be removed. */
export function removeTier(tiers: readonly TierDraft[], index: number): TierEdit {
  if (!Number.isInteger(index) || index < 0 || index >= tiers.length) return { ok: false, reason: 'no_such_tier' };
  if (tiers.length < 2) return { ok: false, reason: 'last_tier' };
  const into = index === 0 ? 1 : index - 1;
  const next = tiers.map(copyTier);
  next[into] = { ...next[into]!, covers: inOrder([...next[into]!.covers, ...next[index]!.covers]) };
  next.splice(index, 1);
  return { ok: true, tiers: next };
}

/**
 * Move a cover to the principle at `to`. Moving it to where it already is changes nothing; moving the last cover out of a principle is refused (`empty_source`). A level no principle holds
 * (a 0.2.1 profile in code may leave `repeated` and `after_warning` out) is added to the principle at `to`.
 */
export function moveCover(tiers: readonly TierDraft[], cover: GuidelineCover, to: number): TierEdit {
  if (!isCover(cover)) return { ok: false, reason: 'unknown_cover' };
  if (!Number.isInteger(to) || to < 0 || to >= tiers.length) return { ok: false, reason: 'no_such_tier' };
  const from = tiers.findIndex((t) => t.covers.includes(cover));
  const next = tiers.map(copyTier);
  if (from < 0) {
    next[to] = { ...next[to]!, covers: inOrder([...next[to]!.covers, cover]) };
    return { ok: true, tiers: next };
  }
  if (from === to) return { ok: true, tiers: next };
  if (next[from]!.covers.length < 2) return { ok: false, reason: 'empty_source' };
  next[from] = { ...next[from]!, covers: next[from]!.covers.filter((c) => c !== cover) };
  next[to] = { ...next[to]!, covers: inOrder([...next[to]!.covers, cover]) };
  return { ok: true, tiers: next };
}

/**
 * The first field of a principle that reads like an instruction to the AI (its name, its description, then its examples), or null when none does. The kit says which principle is
 * flagged; this is the same screen, run over the saved text, so the warning can sit under the field it is about.
 */
export function flaggedField(tier: Pick<TierDraft, 'title' | 'description' | 'examples'>): 'title' | 'description' | 'examples' | null {
  if (looksLikeInjection(tier.title)) return 'title';
  if (looksLikeInjection(tier.description)) return 'description';
  if (linesOf(tier.examples).some(looksLikeInjection)) return 'examples';
  return null;
}

const EMPTY: Problem = { key: 'hub.settings.principle.error.empty' };
const long = (max: number): Problem => ({ key: 'hub.settings.principle.error.long', params: { max } });

/** What the kit would refuse in the principles, by field key (`guide-<i>-title|description|examples|outcome`, and `guide-covers` for the structure). */
export function tierProblems(tiers: readonly TierDraft[]): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  tiers.forEach((t, i) => {
    const text = (field: 'title' | 'description' | 'outcome', max: number): void => {
      const v = t[field].trim();
      if (v === '') out[`guide-${i}-${field}`] = EMPTY;
      else if (charsOf(v) > max) out[`guide-${i}-${field}`] = long(max);
    };
    text('title', MAX_TIER_TITLE);
    text('description', MAX_TIER_DESCRIPTION);
    text('outcome', MAX_GUIDELINE_OUTCOME);
    const lines = linesOf(t.examples);
    if (lines.length > MAX_TIER_EXAMPLES) out[`guide-${i}-examples`] = { key: 'hub.settings.principle.error.examples.count', params: { max: MAX_TIER_EXAMPLES } };
    else if (lines.some((l) => charsOf(l) > MAX_TIER_EXAMPLE)) out[`guide-${i}-examples`] = { key: 'hub.settings.principle.error.examples.long', params: { max: MAX_TIER_EXAMPLE } };
  });
  const flat = tiers.flatMap((t) => t.covers);
  const exactlyOnce = ALL_COVERS.every((c) => flat.filter((x) => x === c).length === 1) && flat.length === ALL_COVERS.length;
  if (!exactlyOnce || tiers.some((t) => t.covers.length === 0)) out['guide-covers'] = { key: 'hub.settings.principle.error.covers' };
  return out;
}

/** What the kit would refuse in the team notes, by field key (`note-<i>-text`, `note-<i>-rule`, `notes-count`). */
export function noteProblems(notes: readonly NoteDraft[]): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  if (notes.length > TEAM_NOTES_MAX) out['notes-count'] = { key: 'hub.settings.notes.error.count', params: { max: TEAM_NOTES_MAX } };
  notes.forEach((n, i) => {
    const text = n.text.trim();
    if (text === '') out[`note-${i}-text`] = { key: 'hub.settings.notes.error.empty' };
    else if (charsOf(text) > TEAM_NOTE_MAX) out[`note-${i}-text`] = { key: 'hub.settings.notes.error.long', params: { max: TEAM_NOTE_MAX } };
    const rule = n.rule.trim();
    if (rule !== '' && (!/^\d+$/.test(rule) || !Number.isSafeInteger(Number(rule)) || Number(rule) < 1)) out[`note-${i}-rule`] = { key: 'hub.settings.notes.error.rule' };
  });
  return out;
}
