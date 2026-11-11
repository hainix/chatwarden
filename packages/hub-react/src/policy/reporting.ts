import { MAX_REASON_RULES, MAX_REPORT_REASONS, OTHER_REASON_ID, defaultReporting } from '@chatwarden/core';
import type { ReportFlow, ReportReasonInput, ReportingSettings, ResolvedReporting } from '@chatwarden/core';
import type { Problem } from '../decision.js';

// The Reporting settings are edited as a local draft, like the ladder: the draft holds what was typed or picked, and the functions here
// turn it into the `reporting` section of a layer, say what the kit would refuse, say whether it changed, and find the field a refusal
// names. No page, no network.

/** The kit's limits (the kit enforces them; they are written here so the page can say so before it sends). */
export const REASON_LABEL_MAX = 60;
export const REASON_HINT_MAX = 160;
export const REASON_GROUP_MAX = 40;
export const THANKS_MAX = 300;
export { MAX_REASON_RULES, MAX_REPORT_REASONS, OTHER_REASON_ID };

/** One reason as the screen edits it. `key` is the row's own identity on the page (it never reaches the kit); `id` is the kit's, empty until a new row is saved. */
export interface ReasonDraft {
  key: string;
  id: string;
  label: string;
  hint: string;
  group: string;
  rules: number[];
  asksNote: boolean;
  enabled: boolean;
}

export interface ReportingDraft {
  flow: ReportFlow;
  reasons: ReasonDraft[];
  thanks: string;
}

/** The reason that can be renamed and re-mapped but never removed or switched off. */
export const isLocked = (r: Pick<ReasonDraft, 'id'>): boolean => r.id === OTHER_REASON_ID;

/** The draft the reporting settings in force make. A kit that does not send them yet has the defaults. */
export function reportingDraftOf(reporting: ResolvedReporting | undefined): ReportingDraft {
  const r = reporting ?? defaultReporting();
  return {
    flow: r.flow,
    thanks: r.thanks,
    reasons: r.reasons.map((x, i) => ({ key: `r${i}`, id: x.id, label: x.label, hint: x.hint, group: x.group, rules: [...x.rules], asksNote: x.asksNote, enabled: x.enabled })),
  };
}

/** What counts as a change: the flow, the thank-you and each reason's content and order (the row key does not). */
function sameness(d: ReportingDraft, newIds: boolean): string {
  return JSON.stringify([
    d.flow,
    d.thanks.trim(),
    d.reasons.map((r) => [newIds ? r.id : r.id === '' ? '+' : r.id, r.label.trim(), r.hint.trim(), r.group.trim(), r.rules, r.asksNote, r.enabled]),
  ]);
}

/** Whether the draft differs from the settings in force. */
export function reportingDirty(draft: ReportingDraft, effective: ResolvedReporting | undefined): boolean {
  return sameness(draft, false) !== sameness(reportingDraftOf(effective), false);
}

/** A lowercase slug for a new reason's id, from its label, not in `taken`. Letters and digits only inside, at most 32 characters. */
export function slugOf(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28)
      .replace(/_+$/g, '') || 'reason';
  const free = (id: string): boolean => !taken.has(id) && id !== 'none';
  if (free(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}_${n}`;
    if (free(id)) return id;
  }
}

/** The reasons as the kit takes them: a new row gets an id from its label, in order, never one that is taken. */
function inputsOf(d: ReportingDraft): ReportReasonInput[] {
  const taken = new Set(d.reasons.filter((r) => r.id !== '').map((r) => r.id));
  return d.reasons.map((r) => {
    let id = r.id;
    if (id === '') {
      id = slugOf(r.label, taken);
      taken.add(id);
    }
    return { id, label: r.label.trim(), hint: r.hint.trim(), group: r.group.trim(), rules: [...r.rules], asksNote: r.asksNote, enabled: isLocked({ id }) ? true : r.enabled };
  });
}

/**
 * The `reporting` section a draft sends, or null when it is the same as the profile in code (`base`): a save replaces the whole layer,
 * so a section equal to the base is left out and goes back to it. The reasons list is sent whole when anything in it changed.
 */
export function reportingLayer(draft: ReportingDraft, base: ResolvedReporting | undefined): ReportingSettings | null {
  const from = reportingDraftOf(base);
  const layer: ReportingSettings = {};
  if (draft.flow !== from.flow) layer.flow = draft.flow;
  if (draft.thanks.trim() !== from.thanks.trim()) layer.thanks = draft.thanks.trim();
  const mine = JSON.stringify(inputsOf(draft));
  if (mine !== JSON.stringify(inputsOf(from))) layer.reasons = inputsOf(draft);
  return Object.keys(layer).length === 0 ? null : layer;
}

/** What the draft refuses before anything is sent, by field key. */
export function reportingProblems(d: ReportingDraft): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  const thanks = d.thanks.trim();
  if (thanks === '') out['thanks'] = { key: 'hub.reporting.thanks.error.empty' };
  else if (thanks.length > THANKS_MAX) out['thanks'] = { key: 'hub.reporting.error.long', params: { max: THANKS_MAX } };
  for (const r of d.reasons) {
    const label = r.label.trim();
    if (label === '') out[`reason-${r.key}-label`] = { key: 'hub.reporting.reason.error.label' };
    else if (label.length > REASON_LABEL_MAX) out[`reason-${r.key}-label`] = { key: 'hub.reporting.error.long', params: { max: REASON_LABEL_MAX } };
    if (r.hint.trim().length > REASON_HINT_MAX) out[`reason-${r.key}-hint`] = { key: 'hub.reporting.error.long', params: { max: REASON_HINT_MAX } };
    if (r.group.trim().length > REASON_GROUP_MAX) out[`reason-${r.key}-group`] = { key: 'hub.reporting.error.long', params: { max: REASON_GROUP_MAX } };
    if (r.rules.length > MAX_REASON_RULES) out[`reason-${r.key}-rules`] = { key: 'hub.reporting.reason.error.rules', params: { max: MAX_REASON_RULES } };
  }
  if (!d.reasons.some((r) => r.enabled || isLocked(r))) out['reasons'] = { key: 'hub.reporting.reasons.error.none' };
  return out;
}

let keys = 0;
const freshKey = (): string => `n${(keys += 1)}`;

/** A blank row at the end (switched on), or the draft as it is when the list is full. Returns the row's key too. */
export function addReason(d: ReportingDraft): { draft: ReportingDraft; key: string | null } {
  if (d.reasons.length >= MAX_REPORT_REASONS) return { draft: d, key: null };
  const key = freshKey();
  const row: ReasonDraft = { key, id: '', label: '', hint: '', group: '', rules: [], asksNote: false, enabled: true };
  // "Something else" stays last: a new row goes before it.
  const at = d.reasons.findIndex((r) => isLocked(r));
  const reasons = at === d.reasons.length - 1 ? [...d.reasons.slice(0, at), row, d.reasons[at] as ReasonDraft] : [...d.reasons, row];
  return { draft: { ...d, reasons }, key };
}

/** Changes one reason. "Something else" cannot be switched off. */
export function patchReason(d: ReportingDraft, key: string, patch: Partial<Omit<ReasonDraft, 'key' | 'id'>>): ReportingDraft {
  return { ...d, reasons: d.reasons.map((r) => (r.key !== key ? r : { ...r, ...patch, enabled: isLocked(r) ? true : (patch.enabled ?? r.enabled) })) };
}

/** Removes one reason. "Something else" cannot be removed. */
export function removeReason(d: ReportingDraft, key: string): ReportingDraft {
  const row = d.reasons.find((r) => r.key === key);
  if (row === undefined || isLocked(row)) return d;
  return { ...d, reasons: d.reasons.filter((r) => r.key !== key) };
}

/** Moves one reason up (-1) or down (+1) in the list; the list's ends stay put. */
export function moveReason(d: ReportingDraft, key: string, by: -1 | 1): ReportingDraft {
  const i = d.reasons.findIndex((r) => r.key === key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.reasons.length) return d;
  const reasons = [...d.reasons];
  [reasons[i], reasons[j]] = [reasons[j] as ReasonDraft, reasons[i] as ReasonDraft];
  return { ...d, reasons };
}

/** The group names in use, in list order, for the group field's suggestions. */
export function groupsOf(d: ReportingDraft): string[] {
  const out: string[] = [];
  for (const r of d.reasons) {
    const g = r.group.trim();
    if (g !== '' && !out.includes(g)) out.push(g);
  }
  return out;
}

/** The field a refusal of the kit points at: `layer.reporting.reasons[2].label` is the label of the third row. Null when it names none. */
export function reportingFieldKey(path: string, d: ReportingDraft): string | null {
  if (path === 'layer.reporting.flow') return 'flow';
  if (path === 'layer.reporting.thanks') return 'thanks';
  const m = /^layer\.reporting\.reasons\[(\d+)\](?:\.(\w+))?/.exec(path);
  if (m !== null) {
    const row = d.reasons[Number(m[1])];
    if (row === undefined) return 'reasons';
    const part = m[2];
    if (part === 'hint' || part === 'group' || part === 'rules') return `reason-${row.key}-${part}`;
    return `reason-${row.key}-label`;
  }
  if (path === 'layer.reporting.reasons' || path === 'layer.reporting') return 'reasons';
  return null;
}

/** One group of the "What players see" preview: a heading (empty for none) and the reasons under it, "Something else" last. Only reasons that are on. */
export function playerGroups(d: ReportingDraft): Array<{ name: string; labels: string[] }> {
  const on = d.reasons.filter((r) => (r.enabled || isLocked(r)) && r.label.trim() !== '');
  const groups: Array<{ name: string; labels: string[] }> = [];
  for (const r of on) {
    if (isLocked(r)) continue;
    const name = r.group.trim();
    const into = groups.find((g) => g.name === name);
    if (into === undefined) groups.push({ name, labels: [r.label.trim()] });
    else into.labels.push(r.label.trim());
  }
  const other = on.find((r) => isLocked(r));
  if (other !== undefined) {
    const last = groups.at(-1);
    if (last !== undefined && last.name === '') last.labels.push(other.label.trim());
    else groups.push({ name: '', labels: [other.label.trim()] });
  }
  return groups;
}
