import type { SignalCount, SignalPolarity, SignalThreshold } from './signals.js';
import type { SignalSourceRow, SubjectId } from './types.js';

// Counting signals by distinct source (design 5.3). Pure: it takes the grouped rows the store answered (`listSignalSources`) and counts
// them. A "count" is how many different sources said it, never how many times: a thousand mutes from one player are one source.

/** What counting needs to know. `kinds` is the request: only these kinds are counted, and only if they are own keys. */
export interface CountContext {
  kinds: Readonly<Record<string, { label: string; polarity: SignalPolarity }>>;
  /** Folds a merged subject into the person it became (`SubjectIndex.canonical`). */
  canonical: (subject: SubjectId) => SubjectId;
  /** The window the rows were read for, reported on each count. */
  windowDays: number;
}

/** What one threshold evaluation answers. `firstAt` and `lastAt` are null when no source counted. */
export interface ThresholdResult {
  met: boolean;
  distinct: number;
  weight: number;
  firstAt: number | null;
  lastAt: number | null;
}

interface Counted {
  distinct: number;
  weight: number;
  firstAt: number;
  lastAt: number;
}

/**
 * The source of a row, with a player folded through `canonical` so two aliases of one person are one source: `b:<canonical by>` when
 * the row has a `by` (the row's `bySubject`, or the id inside the key when the row has none), and the key as stored for a room
 * (`r:`) or a day (`d:`).
 */
function sourceOf(row: SignalSourceRow, canonical: (s: SubjectId) => SubjectId): string {
  if (!row.sourceKey.startsWith('b:')) return row.sourceKey;
  const by = row.bySubject ?? row.sourceKey.slice(2);
  return `b:${canonical(by)}`;
}

/**
 * Count one kind: group by source, take the highest weight in a source, drop sources whose weight is not above 0, then the number of
 * sources left and the sum of their weights. The times span the sources that counted.
 */
function countKind(rows: readonly SignalSourceRow[], canonical: (s: SubjectId) => SubjectId): Counted | null {
  const sources = new Map<string, Counted>();
  for (const row of rows) {
    const w = row.weight;
    if (!(typeof w === 'number' && w > 0 && Number.isFinite(w))) continue;
    const key = sourceOf(row, canonical);
    const s = sources.get(key);
    if (s === undefined) sources.set(key, { distinct: 1, weight: w, firstAt: row.firstAt, lastAt: row.lastAt });
    else {
      if (w > s.weight) s.weight = w;
      if (row.firstAt < s.firstAt) s.firstAt = row.firstAt;
      if (row.lastAt > s.lastAt) s.lastAt = row.lastAt;
    }
  }
  if (sources.size === 0) return null;
  let weight = 0;
  let firstAt = Infinity;
  let lastAt = -Infinity;
  for (const s of sources.values()) {
    weight += s.weight;
    if (s.firstAt < firstAt) firstAt = s.firstAt;
    if (s.lastAt > lastAt) lastAt = s.lastAt;
  }
  return { distinct: sources.size, weight, firstAt, lastAt };
}

/** Rows by kind, for the kinds in the request only (own keys: a row of an undeclared or prototype-named kind is ignored). */
function byKind(rows: readonly SignalSourceRow[], kinds: CountContext['kinds'], only?: readonly string[]): Map<string, SignalSourceRow[]> {
  const out = new Map<string, SignalSourceRow[]>();
  for (const row of rows) {
    if (!Object.hasOwn(kinds, row.kind) || (only !== undefined && !only.includes(row.kind))) continue;
    const list = out.get(row.kind);
    if (list === undefined) out.set(row.kind, [row]);
    else list.push(row);
  }
  return out;
}

/**
 * The counts for a person: one entry per requested kind that has at least one counted source, in the order of the request. `rows` are
 * the store's grouped rows for the person and all their aliases, already limited to the window; aliases fold here. For staff tooling
 * and your own game: never send the result to a player.
 */
export function countSignals(rows: readonly SignalSourceRow[], ctx: CountContext): SignalCount[] {
  const grouped = byKind(rows, ctx.kinds);
  const out: SignalCount[] = [];
  for (const kind of Object.keys(ctx.kinds)) {
    const list = grouped.get(kind);
    if (list === undefined) continue;
    const counted = countKind(list, ctx.canonical);
    if (counted === null) continue;
    const spec = ctx.kinds[kind]!;
    out.push({ kind, label: spec.label, polarity: spec.polarity, windowDays: ctx.windowDays, ...counted });
  }
  return out;
}

/**
 * Does a person meet a threshold? Sources are counted per kind and the numbers added across the kinds, so one player who both muted and
 * blocked counts twice for a two-kind threshold (use one kind per threshold when that matters). Met when `distinct >= minDistinct` and,
 * if `minWeight` is given, `weight >= minWeight`. A kind that is not in `ctx.kinds` is ignored. The window is the caller's: `rows` are
 * already limited to `t.windowDays`.
 */
export function evaluateThreshold(rows: readonly SignalSourceRow[], ctx: Omit<CountContext, 'windowDays'> & { windowDays?: number }, t: SignalThreshold): ThresholdResult {
  const grouped = byKind(rows, ctx.kinds, t.kinds);
  let distinct = 0;
  let weight = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const kind of t.kinds) {
    const list = grouped.get(kind);
    if (list === undefined) continue;
    const counted = countKind(list, ctx.canonical);
    if (counted === null) continue;
    distinct += counted.distinct;
    weight += counted.weight;
    if (firstAt === null || counted.firstAt < firstAt) firstAt = counted.firstAt;
    if (lastAt === null || counted.lastAt > lastAt) lastAt = counted.lastAt;
  }
  const met = distinct >= t.minDistinct && (t.minWeight === undefined || weight >= t.minWeight);
  return { met, distinct, weight, firstAt, lastAt };
}
