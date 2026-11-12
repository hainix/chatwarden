import type { ResolvedSignalKind, SignalFeeds } from '@chatwarden/core';
import type { Problems } from './panels.js';

// The draft of the Signals panel: the four feeds as the owner edits them (each off until switched on), the checks the kit makes again on its side, and
// the layer to save. Pure: nothing here reads the page or sends anything. The kinds are the game's own, declared in its code: the hub only chooses among
// them and never invents one.

export type Effect = 'note' | 'raise';

/** The shared shape of the record and AI feeds: which kinds (all, or some) and how many days. */
export interface WindowDraft {
  on: boolean;
  all: boolean;
  kinds: string[];
  days: string;
}

export interface QueueDraft {
  on: boolean;
  kinds: string[];
  players: string;
  days: string;
  /** What the code set and the hub does not edit: kept, so a save does not drop it. */
  minWeight?: number;
}

export interface RuleDraft {
  /** A rule's id: kept for a saved one, `rule-N` for a new one. Never shown. */
  id: string;
  effect: Effect;
  kinds: string[];
  players: string;
  days: string;
  minWeight?: number;
}

export interface SignalsDraft {
  record: WindowDraft;
  queue: QueueDraft;
  ladderOn: boolean;
  rules: RuleDraft[];
  ai: WindowDraft;
}

export const DAYS_MAX = 90;
export const PLAYERS_MAX = 50;
export const RULES_MAX = 20;
type Kinds = Readonly<Record<string, ResolvedSignalKind>>;

const windowOf = (f: { kinds: readonly string[] | '*'; windowDays: number } | undefined): WindowDraft =>
  f === undefined ? { on: false, all: false, kinds: [], days: '' } : { on: true, all: f.kinds === '*', kinds: f.kinds === '*' ? [] : [...f.kinds], days: String(f.windowDays) };

/** The feeds in force, as a draft. A server from before signals sends none: everything off. */
export function signalsDraftOf(feeds: SignalFeeds | undefined): SignalsDraft {
  const q = feeds?.queue;
  const ladder = feeds?.ladder ?? [];
  return {
    record: windowOf(feeds?.record),
    queue: q === undefined ? { on: false, kinds: [], players: '', days: '' } : { on: true, kinds: [...q.kinds], players: String(q.minDistinct), days: String(q.windowDays), ...(q.minWeight === undefined ? {} : { minWeight: q.minWeight }) },
    ladderOn: ladder.length > 0,
    rules: ladder.map((r) => ({ id: r.id, effect: r.effect, kinds: [...r.kinds], players: String(r.minDistinct), days: String(r.windowDays), ...(r.minWeight === undefined ? {} : { minWeight: r.minWeight }) })),
    ai: windowOf(feeds?.ai),
  };
}

/** A whole number from `lo` to `hi` typed as plain digits, or null. */
function whole(s: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n >= lo && n <= hi ? n : null;
}

type ProblemKey = 'hub.settings.signals.error.days' | 'hub.settings.signals.error.players' | 'hub.settings.signals.error.kinds' | 'hub.settings.signals.error.negative' | 'hub.settings.signals.error.undeclared';
const problem = (key: ProblemKey): { key: ProblemKey } => ({ key });

/** Does this kind exist and (when `negativeOnly`) count against? */
function kindOk(kinds: Kinds, id: string, negativeOnly: boolean): 'ok' | 'undeclared' | 'negative' {
  if (!Object.hasOwn(kinds, id)) return 'undeclared';
  return negativeOnly && kinds[id]!.polarity !== 'negative' ? 'negative' : 'ok';
}

function kindsProblem(chosen: readonly string[], kinds: Kinds, negativeOnly: boolean): { key: ProblemKey } | undefined {
  if (chosen.length === 0) return problem('hub.settings.signals.error.kinds');
  const worst = chosen.map((k) => kindOk(kinds, k, negativeOnly));
  if (worst.includes('undeclared')) return problem('hub.settings.signals.error.undeclared');
  if (worst.includes('negative')) return problem('hub.settings.signals.error.negative');
  return undefined;
}

/** The fields that cannot be sent, by key (`record.days`, `queue.kinds`, `ladder.0.players`, ...); nothing for a form that is off. */
export function signalsProblems(d: SignalsDraft, kinds: Kinds): Problems {
  const out: Record<string, { key: ProblemKey }> = {};
  const windowFeed = (name: 'record' | 'ai', f: WindowDraft): void => {
    if (!f.on) return;
    if (whole(f.days, 1, DAYS_MAX) === null) out[`${name}.days`] = problem('hub.settings.signals.error.days');
    if (!f.all) {
      const p = kindsProblem(f.kinds, kinds, false);
      if (p !== undefined) out[`${name}.kinds`] = p;
    }
  };
  windowFeed('record', d.record);
  windowFeed('ai', d.ai);
  if (d.queue.on) {
    const p = kindsProblem(d.queue.kinds, kinds, true);
    if (p !== undefined) out['queue.kinds'] = p;
    if (whole(d.queue.players, 1, PLAYERS_MAX) === null) out['queue.players'] = problem('hub.settings.signals.error.players');
    if (whole(d.queue.days, 1, DAYS_MAX) === null) out['queue.days'] = problem('hub.settings.signals.error.days');
  }
  if (d.ladderOn) {
    d.rules.forEach((r, i) => {
      const p = kindsProblem(r.kinds, kinds, r.effect === 'raise');
      if (p !== undefined) out[`ladder.${i}.kinds`] = p;
      if (whole(r.players, 1, PLAYERS_MAX) === null) out[`ladder.${i}.players`] = problem('hub.settings.signals.error.players');
      if (whole(r.days, 1, DAYS_MAX) === null) out[`ladder.${i}.days`] = problem('hub.settings.signals.error.days');
    });
  }
  return out;
}

const num = (s: string): number => Number(s.trim());

/** The feeds to save: a form that is off is left out (so it stays off whatever the code says). Only for a draft with no problems. */
export function signalsFeeds(d: SignalsDraft): SignalFeeds {
  const feeds: SignalFeeds = {};
  if (d.record.on) feeds.record = { kinds: d.record.all ? '*' : [...d.record.kinds], windowDays: num(d.record.days) };
  if (d.queue.on) feeds.queue = { kinds: [...d.queue.kinds], minDistinct: num(d.queue.players), windowDays: num(d.queue.days), ...(d.queue.minWeight === undefined ? {} : { minWeight: d.queue.minWeight }) };
  if (d.ladderOn && d.rules.length > 0) {
    feeds.ladder = d.rules.map((r) => ({ id: r.id, effect: r.effect, kinds: [...r.kinds], minDistinct: num(r.players), windowDays: num(r.days), ...(r.minWeight === undefined ? {} : { minWeight: r.minWeight }) }));
  }
  if (d.ai.on) feeds.ai = { kinds: d.ai.all ? '*' : [...d.ai.kinds], windowDays: num(d.ai.days) };
  return feeds;
}

/** What a draft means, with what a switched-off form holds left out, so two drafts that mean the same compare equal. */
const meaning = (d: SignalsDraft): unknown => [
  d.record.on ? [d.record.all, d.record.all ? [] : [...d.record.kinds].sort(), d.record.days.trim()] : null,
  d.queue.on ? [[...d.queue.kinds].sort(), d.queue.players.trim(), d.queue.days.trim()] : null,
  d.ladderOn ? d.rules.map((r) => [r.id, r.effect, [...r.kinds].sort(), r.players.trim(), r.days.trim()]) : null,
  d.ai.on ? [d.ai.all, d.ai.all ? [] : [...d.ai.kinds].sort(), d.ai.days.trim()] : null,
];

export const signalsDirty = (d: SignalsDraft, effective: SignalFeeds | undefined): boolean => JSON.stringify(meaning(d)) !== JSON.stringify(meaning(signalsDraftOf(effective)));

/** The field a refusal's layer path names, as the draft's key; null for a path that is not one of the fields. */
export function signalsFieldKey(path: string): string | null {
  const m = /^layer\.signals\.feeds\.(record|queue|ai|ladder)(?:\[(\d+)\])?(?:\.(kinds|minDistinct|windowDays|id|effect)|)/.exec(path);
  if (m === null) return null;
  const [, feed, index, field] = m;
  const part = field === 'minDistinct' ? 'players' : field === 'windowDays' ? 'days' : 'kinds';
  if (feed === 'ladder') return `ladder.${index ?? '0'}.${part}`;
  if (feed === 'queue') return `queue.${part === 'players' || part === 'days' ? part : 'kinds'}`;
  return `${feed}.${part === 'days' ? 'days' : 'kinds'}`;
}

/** The next free rule id (`rule-1`, `rule-2`, ...), never one already in the draft. */
export function nextRuleId(rules: readonly RuleDraft[]): string {
  const used = new Set(rules.map((r) => r.id));
  for (let n = 1; ; n += 1) if (!used.has(`rule-${n}`)) return `rule-${n}`;
}

/** The kinds the game declared itself: the built-in one the kit records on its own does not count unless the game changed it. */
export function declaredKinds(kinds: Kinds | undefined, builtin: Readonly<Record<string, { label: string }>>): Array<[string, ResolvedSignalKind]> {
  return Object.entries(kinds ?? {}).filter(([id, k]) => !(Object.hasOwn(builtin, id) && builtin[id]!.label === k.label && k.weight === 1));
}
