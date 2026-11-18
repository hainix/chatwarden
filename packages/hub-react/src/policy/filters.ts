import { checkFilters, FILTER_LIMITS, ProfileError, RATIO_DEFAULTS } from '@chatwarden/core';
import type { FilterAction, FilterSettings, LinkSettings, PersonalInfoSettings, PhraseRuleSettings, RatioSettings, ResolvedFilters } from '@chatwarden/core';

// The draft of the "Chat filters" panel. It is the kit's own `FilterSettings`, held as the owner edits it: a block is `null` when off, `phrases` is the whole list,
// and every check is the kit's own (`checkFilters`), so the form refuses what the server refuses and says where. Pure: nothing here reads the page or sends anything.

export interface FilterDraft {
  links: LinkSettings | null;
  personalInfo: PersonalInfoSettings | null;
  ratio: RatioSettings | null;
  phrases: PhraseRuleSettings[];
  ignore: string[];
  flagCapPerDay: number;
}

export const ACTIONS: readonly FilterAction[] = ['count', 'flag', 'mask', 'refuse'];

/** What the kit has in force (`effective.filters`, every field filled), as a draft. A server older than 0.2.0 sends none: everything off. */
export function filterDraftOf(r: ResolvedFilters | undefined): FilterDraft {
  if (r === undefined) return { links: null, personalInfo: null, ratio: null, phrases: [], ignore: [], flagCapPerDay: FILTER_LIMITS.flagCapDefault };
  return {
    links: r.links === null ? null : { action: r.links.action, rule: r.links.rule, allow: [...r.links.allow], deny: [...r.links.deny], unlisted: r.links.unlisted, invites: r.links.invites, shorteners: r.links.shorteners, newAccountDays: r.links.newAccountDays },
    personalInfo: r.personalInfo === null ? null : { action: r.personalInfo.action, rule: r.personalInfo.rule, kinds: [...r.personalInfo.kinds], phone: r.personalInfo.phone, address: r.personalInfo.address },
    ratio:
      r.ratio === null
        ? null
        : {
            action: r.ratio.action,
            rule: r.ratio.rule,
            caps: r.ratio.caps === null ? null : { ...r.ratio.caps },
            repeats: r.ratio.repeats === null ? null : { ...r.ratio.repeats },
            emoji: r.ratio.emoji === null ? null : { ...r.ratio.emoji },
            mentions: r.ratio.mentions === null ? null : { ...r.ratio.mentions },
          },
    phrases: r.phrases.map((p) => ({ id: p.id, label: p.label, action: p.action, rule: p.rule, phrases: [...p.phrases] })),
    ignore: [...r.ignore],
    flagCapPerDay: r.flagCapPerDay,
  };
}

/** The `filters` section to save: every block named (`null` for off), so a block the owner turned off stays off whatever the code says. */
export function filterLayer(d: FilterDraft): FilterSettings {
  return { links: d.links, personalInfo: d.personalInfo, ratio: d.ratio, phrases: d.phrases, ignore: d.ignore, flagCapPerDay: d.flagCapPerDay };
}

/** Is the draft different from what is in force? (Compared by meaning: both sides go through `filterLayer`.) */
export const filterDirty = (d: FilterDraft, effective: ResolvedFilters | undefined): boolean => JSON.stringify(filterLayer(d)) !== JSON.stringify(filterLayer(filterDraftOf(effective)));

/** The first thing the kit would refuse in the draft: the path in it and the kit's reason (English, a hint only), or null when it is fine. */
export function filterProblem(d: FilterDraft): { path: string; message: string } | null {
  try {
    checkFilters(filterLayer(d), 'filters');
    return null;
  } catch (e) {
    if (e instanceof ProfileError) return { path: e.path, message: e.message };
    throw e;
  }
}

/** Which card a path belongs to. */
export type CardKey = 'links' | 'personalInfo' | 'ratio' | 'phrases' | 'other';
export function cardOfPath(path: string): CardKey {
  const rest = path.replace(/^(layer\.)?(filters\.?)?/, '');
  if (rest.startsWith('links')) return 'links';
  if (rest.startsWith('personalInfo')) return 'personalInfo';
  if (rest.startsWith('ratio')) return 'ratio';
  if (rest.startsWith('phrases')) return 'phrases';
  return 'other';
}

/** The field a path names, as a catalog word and its number (the entry or the line), for "Denied domains, entry 2". */
export type FieldWord =
  | 'allow' | 'deny' | 'newAccountDays' | 'rule' | 'kinds' | 'capsPercent' | 'capsLetters' | 'run' | 'emoji' | 'mentions' | 'pattern' | 'id' | 'label' | 'rules' | 'ignore' | 'flagCap' | 'general';
export function fieldOfPath(path: string): { word: FieldWord; n: number | null; rule: number | null } {
  const rest = path.replace(/^(layer\.)?filters\.?/, '');
  const index = (m: RegExpMatchArray | null, at: number): number | null => (m === null ? null : Number(m[at]) + 1);
  let m: RegExpMatchArray | null;
  if ((m = rest.match(/^links\.allow\[(\d+)\]/)) !== null) return { word: 'allow', n: index(m, 1), rule: null };
  if ((m = rest.match(/^links\.deny\[(\d+)\]/)) !== null) return { word: 'deny', n: index(m, 1), rule: null };
  if (rest.startsWith('links.newAccountDays')) return { word: 'newAccountDays', n: null, rule: null };
  if ((m = rest.match(/^phrases\[(\d+)\]\.phrases\[(\d+)\]/)) !== null) return { word: 'pattern', n: index(m, 2), rule: index(m, 1) };
  if ((m = rest.match(/^phrases\[(\d+)\]\.id/)) !== null) return { word: 'id', n: null, rule: index(m, 1) };
  if ((m = rest.match(/^phrases\[(\d+)\]\.label/)) !== null) return { word: 'label', n: null, rule: index(m, 1) };
  if ((m = rest.match(/^phrases\[(\d+)\]/)) !== null) return { word: 'rules', n: null, rule: index(m, 1) };
  if (rest.startsWith('phrases')) return { word: 'rules', n: null, rule: null };
  if (/\.rule$/.test(rest)) return { word: 'rule', n: null, rule: null };
  if (rest.startsWith('personalInfo.kinds')) return { word: 'kinds', n: null, rule: null };
  if (rest.startsWith('ratio.caps.maxPercent')) return { word: 'capsPercent', n: null, rule: null };
  if (rest.startsWith('ratio.caps.minLetters')) return { word: 'capsLetters', n: null, rule: null };
  if (rest.startsWith('ratio.repeats')) return { word: 'run', n: null, rule: null };
  if (rest.startsWith('ratio.emoji')) return { word: 'emoji', n: null, rule: null };
  if (rest.startsWith('ratio.mentions')) return { word: 'mentions', n: null, rule: null };
  if (rest.startsWith('ignore')) return { word: 'ignore', n: null, rule: null };
  if (rest.startsWith('flagCapPerDay')) return { word: 'flagCap', n: null, rule: null };
  return { word: 'general', n: null, rule: null };
}

/** The reason a problem has, from the kit's message: the one worth its own sentence is the shared hosting one; the rest are one plain sentence. */
export const isSharedHosting = (message: string): boolean => /shared hosting/i.test(message);

/** The path of a refusal from the server in the draft's terms (`layer.filters...`), or null for a path that is not in the filters. */
export const filterRefusalPath = (path: string): string | null => (/^layer\.filters(\.|\[|$)/.test(path) ? path : null);

/** A pattern list typed one to a line: blank lines dropped, each line trimmed. */
export const patternsOf = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/** A new phrase rule: an id that is unique among the rules and fits the kit's id shape. */
export function newPhrase(existing: readonly PhraseRuleSettings[], label = ''): PhraseRuleSettings {
  const ids = new Set(existing.map((p) => p.id));
  let n = existing.length + 1;
  while (ids.has(`rule${n}`)) n += 1;
  return { id: `rule${n}`, label, action: 'count', phrases: [''] };
}

/** An id made from a name, in the kit's id shape (`[a-z][a-z0-9_-]{0,31}`), unique among the others; the name it came from is the label. */
export function idFromName(name: string, others: readonly string[], fallback: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 28);
  let id = base === '' ? fallback : base;
  let n = 2;
  while (others.includes(id)) id = `${base === '' ? fallback : base}-${n++}`.slice(0, 32);
  return id;
}

/** The numbers a ratio check uses when switched on and given none. */
export const RATIO_START = RATIO_DEFAULTS;
export const LIMITS = FILTER_LIMITS;
