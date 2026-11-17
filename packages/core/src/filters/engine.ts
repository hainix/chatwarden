import { filtersActive, type FilterAction, type ResolvedFilters } from '../filters.js';
import { errorClass, safeWarn } from '../log.js';
import { maskSpans } from '../mask.js';
import type { Clock, Logger, SubjectId } from '../types.js';
import { lowerKeepLength, type FilterSpan } from './fold.js';
import { judgeLink, scanLinks } from './links.js';
import { scanPersonal } from './personal.js';
import { compilePhrases, matchPhrases } from './phrases.js';
import { scanRatio, soften } from './ratio.js';

// The filter engine: one pass over a line with the owner's settings, all blocks run (so the counters and the strongest action are complete),
// and a verdict that says what happened and where. It never changes the line itself, holds no state and writes nothing; the chat path
// applies the verdict. A verdict carries ranges and keys, never a copy of the line.

/** At most this many characters of a line are read by the filters (a longer line cannot reach them through `accept`, which refuses it first). */
export const FILTER_LINE_CAP = 2000;

export type FilterHitKind = 'link' | 'personal_info' | 'phrase' | 'ratio';

/**
 * One thing a block found: a counter key, what it is, what the owner said to do about it, and where (ranges on the line, none for a ratio).
 * @experimental
 */
export interface FilterHit {
  /** The counter key: `link.unlisted`, `personal_info.phone`, `phrase.<id>`, `ratio.caps` ... (a closed shape, never text from a line). */
  key: string;
  kind: FilterHitKind;
  detail: string;
  action: FilterAction;
  /** The Community Rule the hit cites. */
  rule: number;
  spans: FilterSpan[];
}

/**
 * What the player is told when a line is refused: the kind (phrases and ratios both say `filter`) and the rule, never the matched part.
 * @experimental
 */
export interface FilterRefusal {
  reason: 'link' | 'personal_info' | 'filter';
  rule: number;
}

/**
 * The verdict on one line. `refuse` is the first refusing hit in the fixed order (links, personal info, phrases in list order, ratio);
 * `spans` are the ranges every `mask` hit covers (ratio hits have none); `softened` is the whole delivered line when a ratio rule masks
 * (the covered ranges applied, then the soften), else null; `flags` are the hits that file a report, in the fixed order. `hits` lists every
 * hit, whatever the strongest action, so the counters are complete.
 * @experimental
 */
export interface FilterVerdict {
  hits: FilterHit[];
  refuse: FilterRefusal | null;
  spans: FilterSpan[];
  softened: string | null;
  flags: FilterHit[];
}

export interface EvaluateContext {
  /** Is the speaker's account younger than `days`? Asked at most once per line, and only when an unlisted link is present and `newAccountDays` is set. */
  accountIsNew: (days: number) => boolean;
}

const emptyVerdict = (): FilterVerdict => ({ hits: [], refuse: null, spans: [], softened: null, flags: [] });

/** `text` with each ignore phrase replaced by spaces of the same length, so every offset still indexes the original line. */
function blankIgnored(text: string, ignore: readonly string[]): string {
  if (ignore.length === 0) return text;
  const lower = lowerKeepLength(text);
  let out: string[] | null = null;
  for (const phrase of ignore) {
    if (phrase.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(phrase, from);
      if (at < 0) break;
      out ??= text.split('');
      for (let i = at; i < at + phrase.length; i++) out[i] = ' ';
      from = at + phrase.length;
    }
  }
  return out === null ? text : out.join('');
}

/** Group `(key, detail, span)` items into hits, one per key, in order of first appearance. */
class Grouper {
  readonly hits: FilterHit[] = [];
  private readonly by = new Map<string, FilterHit>();
  add(key: string, kind: FilterHitKind, detail: string, action: FilterAction, rule: number, span: FilterSpan | null): void {
    let hit = this.by.get(key);
    if (hit === undefined) {
      hit = { key, kind, detail, action, rule, spans: [] };
      this.by.set(key, hit);
      this.hits.push(hit);
    }
    if (span !== null) hit.spans.push({ start: span.start, end: span.end });
  }
}

const reasonOf = (kind: FilterHitKind): FilterRefusal['reason'] => (kind === 'link' ? 'link' : kind === 'personal_info' ? 'personal_info' : 'filter');

/**
 * Run the owner's settings over one line. Pure: no I/O, no clock, no state, nothing thrown on purpose (the caller fences it anyway). With
 * every block off nothing is built and the verdict is empty. Reads at most the first 2 000 characters.
 */
export function evaluateFilters(settings: ResolvedFilters, line: string, ctx: EvaluateContext): FilterVerdict {
  if (typeof line !== 'string' || line.length === 0 || !filtersActive(settings)) return emptyVerdict();
  const capped = line.length > FILTER_LINE_CAP ? line.slice(0, FILTER_LINE_CAP) : line;
  const text = blankIgnored(capped, settings.ignore);
  const group = new Grouper();

  const links = settings.links;
  if (links !== null) {
    let asked: boolean | undefined;
    const isNew = (): boolean => (asked ??= links.newAccountDays !== null && ctx.accountIsNew(links.newAccountDays) === true);
    for (const c of scanLinks(text)) {
      const verdict = judgeLink(c, links, isNew);
      if (verdict !== null) group.add(`link.${verdict}`, 'link', verdict, links.action, links.rule, { start: c.start, end: c.end });
    }
  }

  const personal = settings.personalInfo;
  if (personal !== null) {
    for (const m of scanPersonal(text, personal)) {
      // An address can only count or flag: its own setting, never the block's action.
      const action = m.detail === 'address' ? (personal.address ?? 'count') : personal.action;
      group.add(`personal_info.${m.detail}`, 'personal_info', m.detail, action, personal.rule, m.span);
    }
  }

  if (settings.phrases.length > 0) {
    const found = matchPhrases(compilePhrases(settings.phrases), text);
    for (const rule of settings.phrases) {
      for (const m of found) if (m.ruleId === rule.id) group.add(`phrase.${rule.id}`, 'phrase', rule.id, rule.action, rule.rule, m.span);
    }
  }

  const ratio = settings.ratio;
  if (ratio !== null) {
    for (const d of scanRatio(text, ratio)) group.add(`ratio.${d.detail}`, 'ratio', d.detail, ratio.action, ratio.rule, null);
  }

  const hits = group.hits;
  if (hits.length === 0) return emptyVerdict();
  const refusing = hits.find((h) => h.action === 'refuse');
  const spans: FilterSpan[] = [];
  for (const h of hits) if (h.action === 'mask') for (const s of h.spans) spans.push({ start: s.start, end: s.end });
  const softens = ratio !== null && hits.some((h) => h.kind === 'ratio' && h.action === 'mask');
  return {
    hits,
    refuse: refusing === undefined ? null : { reason: reasonOf(refusing.kind), rule: refusing.rule },
    spans,
    softened: softens && ratio !== null ? soften(maskSpans(line, spans), ratio) : null,
    flags: hits.filter((h) => h.action === 'flag'),
  };
}

/** What a hook that may be a promise, a null or a throw is worth as a yes: only a plain `true`. */
export type AccountAgeHook = (accountIds: readonly string[]) => number | null | undefined;

export interface FilterEngineDeps {
  /** The filters in force for a room (the per-room getter; a room that has none of its own gets the profile's). */
  settings: (roomId: string) => ResolvedFilters;
  /** `signals.accountAgeDays`: the age in days of the account, or null or undefined when unknown. Absent: nobody is new. */
  accountAgeDays?: AccountAgeHook;
  /** The account ids the game gave for a person (the canonical subject's). */
  accountIds: (subject: SubjectId) => string[];
  canonical: (subject: SubjectId) => SubjectId;
  clock: Clock;
  logger: Logger | undefined;
}

/** `evaluate` for a room's line and a person; `evaluateWith` for settings that are not saved (a candidate), with no room. */
export interface FilterEngine {
  evaluate(roomId: string, text: string, ctx: { subject: SubjectId | null }): FilterVerdict;
  evaluateWith(settings: ResolvedFilters, text: string, ctx: { subject: SubjectId | null }): FilterVerdict;
  /** Is this person's account younger than `days`? Fenced: unknown, a guest, a throw and anything that is not a number read as no. */
  accountIsNew(subject: SubjectId | null, days: number): boolean;
}

/** The engine the facade builds: the per-room getter, the account-age lookup (fenced) and the pure evaluation. */
export function createFilterEngine(deps: FilterEngineDeps): FilterEngine {
  const accountIsNew = (subject: SubjectId | null, days: number): boolean => {
    if (subject === null || deps.accountAgeDays === undefined) return false;
    try {
      const age: unknown = deps.accountAgeDays(deps.accountIds(deps.canonical(subject)));
      return typeof age === 'number' && Number.isFinite(age) && age >= 0 && age < days;
    } catch (err) {
      safeWarn(deps.logger, 'chatwarden.filter_age_failed', { error: errorClass(err) });
      return false;
    }
  };
  const run = (settings: ResolvedFilters, text: string, subject: SubjectId | null): FilterVerdict => evaluateFilters(settings, text, { accountIsNew: (days) => accountIsNew(subject, days) });
  return {
    evaluate: (roomId, text, ctx) => run(deps.settings(roomId), text, ctx.subject),
    evaluateWith: (settings, text, ctx) => run(settings, text, ctx.subject),
    accountIsNew,
  };
}

/**
 * What `cw.filters.test` returns: the verdict, and the line as it would be delivered (null when it would be refused).
 * @experimental
 */
export interface FilterTestResult {
  verdict: FilterVerdict;
  delivered: string | null;
}

/** The delivered text for a verdict: the covered ranges starred, or the softened line; null when the line would be refused. */
export function testLine(verdict: FilterVerdict, text: string): FilterTestResult {
  return { verdict, delivered: verdict.refuse !== null ? null : (verdict.softened ?? maskSpans(text, verdict.spans)) };
}

/** The most lines `check` reads, and the most sample lines it keeps per counter key. */
export const CHECK_LINES_MAX = 5000;
export const CHECK_SAMPLES_MAX = 20;

/** @experimental */
export interface FilterCheckRule {
  key: string;
  kind: FilterHitKind;
  action: FilterAction;
  rule: number;
  /** How many of the lines hit it. */
  hits: number;
  samples: Array<{ text: string; spans: FilterSpan[] }>;
}

/**
 * What `cw.filters.check` returns: how many lines were read, how many would be refused or masked, and the rules that hit.
 * @experimental
 */
export interface FilterCheckResult {
  lines: number;
  refused: number;
  masked: number;
  rules: FilterCheckRule[];
}

/** Run `settings` over `lines`: per key, the lines hit and up to 20 samples. Nothing is written and nothing counted; a line that breaks the engine is skipped. */
export function checkLines(engine: FilterEngine, settings: ResolvedFilters, lines: readonly string[]): FilterCheckResult {
  const rules = new Map<string, FilterCheckRule>();
  let read = 0;
  let refused = 0;
  let masked = 0;
  const list = Array.isArray(lines) ? lines.slice(0, CHECK_LINES_MAX) : [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text.length === 0) continue;
    read++;
    let verdict: FilterVerdict;
    try {
      verdict = engine.evaluateWith(settings, text, { subject: null });
    } catch {
      continue;
    }
    if (verdict.refuse !== null) refused++;
    else if (verdict.spans.length > 0 || verdict.softened !== null) masked++;
    for (const hit of verdict.hits) {
      let r = rules.get(hit.key);
      if (r === undefined) {
        r = { key: hit.key, kind: hit.kind, action: hit.action, rule: hit.rule, hits: 0, samples: [] };
        rules.set(hit.key, r);
      }
      r.hits++;
      if (r.samples.length < CHECK_SAMPLES_MAX) r.samples.push({ text, spans: hit.spans.map((s) => ({ start: s.start, end: s.end })) });
    }
  }
  return { lines: read, refused, masked, rules: [...rules.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
}
