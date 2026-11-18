import { loadTermPack, type TermPack } from '../termPack.js';
import { CorpusError } from './errors.js';
import type { ExceptionRow6, TermRow6, TermsRelease } from './release.js';

// From a verified release to the pack a game loads (design 6.5 to 6.7, 13). Pure. The release is not changed; the result is a
// `TermPack` with the id `chatwarden-corpus`, passed through `loadTermPack` before it is returned. A refusal never quotes a term.

/** What a game takes from a release. Only `languages` has no default. @experimental */
export interface PackSelection {
  /** Required, at least one tag, e.g. `['en', 'es']`. `pt-BR` and `pt-PT` select `pt`. */
  languages: readonly string[];
  /** Default: all four. */
  categories?: readonly ('slur' | 'abuse' | 'sexual' | 'other')[];
  /** The mildest use of a word to load. Default `'hostile'`. */
  minSeverity?: 'rude' | 'hostile' | 'severe';
  /** Default: both. Disputed and withdrawn rows always load, inactive. */
  statuses?: readonly ('accepted' | 'provisional')[];
}

const ALL_CATEGORIES = ['slur', 'abuse', 'sexual', 'other'] as const;
const SEVERITY_RANK: Readonly<Record<string, number>> = { rude: 0, hostile: 1, severe: 2 };
const SELECTABLE_STATUSES = ['accepted', 'provisional'] as const;
const LANG_RE = /^[a-z]{2,3}$/;

/** The base tag of a language as written: `pt-BR` and `PT_br` are `pt`. Null when it is not a tag. */
function baseTag(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const tag = (v.trim().toLowerCase().split(/[-_]/)[0] ?? '');
  return LANG_RE.test(tag) ? tag : null;
}

/** The base tags a selection names, in the order asked for (`pt-BR` is `pt`); a RangeError naming the option when there are none. @internal */
export function selectedLanguages(select: unknown): string[] {
  return normalise(select).languages;
}

interface Normalised {
  languages: string[];
  categories: ReadonlySet<string>;
  minRank: number;
  statuses: ReadonlySet<string>;
}

/** Check the options and fill the defaults; a bad one is a RangeError that names the option and never echoes its value. */
function normalise(select: unknown): Normalised {
  let rawLanguages: unknown;
  let rawCategories: unknown;
  let rawSeverity: unknown;
  let rawStatuses: unknown;
  try {
    const s = select as { languages?: unknown; categories?: unknown; minSeverity?: unknown; statuses?: unknown };
    rawLanguages = s.languages;
    rawCategories = s.categories;
    rawSeverity = s.minSeverity;
    rawStatuses = s.statuses;
  } catch {
    throw new RangeError('PackSelection.languages must name at least one language');
  }
  if (!Array.isArray(rawLanguages) || rawLanguages.length === 0) throw new RangeError('PackSelection.languages must name at least one language');
  const languages: string[] = [];
  for (const raw of rawLanguages as unknown[]) {
    const tag = baseTag(raw);
    if (tag === null) throw new RangeError('PackSelection.languages: every entry must be a language tag such as en or pt-BR');
    if (!languages.includes(tag)) languages.push(tag);
  }
  const categories: readonly string[] = rawCategories === undefined ? ALL_CATEGORIES : listOf(rawCategories, ALL_CATEGORIES, 'PackSelection.categories must list slur, abuse, sexual or other');
  const statuses: readonly string[] = rawStatuses === undefined ? SELECTABLE_STATUSES : listOf(rawStatuses, SELECTABLE_STATUSES, 'PackSelection.statuses must list accepted or provisional');
  let minRank = SEVERITY_RANK.hostile as number;
  if (rawSeverity !== undefined) {
    const rank = typeof rawSeverity === 'string' && Object.hasOwn(SEVERITY_RANK, rawSeverity) ? SEVERITY_RANK[rawSeverity] : undefined;
    if (rank === undefined) throw new RangeError('PackSelection.minSeverity must be rude, hostile or severe');
    minRank = rank;
  }
  return { languages, categories: new Set(categories), minRank, statuses: new Set(statuses) };
}

function listOf(v: unknown, allowed: readonly string[], message: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !allowed.includes(x))) throw new RangeError(message);
  return v as string[];
}

/** The first of the selected languages (in the order they were asked for) that a row lists, or null if it lists none of them. */
const firstSelected = (rowLanguages: readonly string[], selected: readonly string[]): string | null => selected.find((l) => rowLanguages.includes(l)) ?? null;

function selectTerm(row: TermRow6, o: Normalised): TermPack['terms'][number] | null {
  const language = firstSelected(row.languages, o.languages);
  if (language === null) return null;
  const pass = { id: row.id, term: row.term, language, ...(row.matchMode === undefined ? {} : { matchMode: row.matchMode }), positive: [...row.positive], negative: [...row.negative] };
  // A disputed or withdrawn row is carried so a later sync can switch off a copy a store already has; it is never on.
  if (row.status === 'disputed' || row.status === 'withdrawn') return { ...pass, active: false };
  if (!o.statuses.has(row.status) || !o.categories.has(row.category) || (SEVERITY_RANK[row.severity] as number) < o.minRank) return null;
  const collides = row.collidesWith.some((l) => o.languages.includes(l));
  return { ...pass, active: row.defaultActive && !collides };
}

function selectException(row: ExceptionRow6, o: Normalised): TermPack['exceptions'][number] | null {
  const language = firstSelected(row.languages, o.languages);
  if (language === null) return null;
  if (row.status === 'disputed' || row.status === 'withdrawn') return { id: row.id, phrase: row.phrase, language, active: false };
  if (!o.statuses.has(row.status)) return null;
  return { id: row.id, phrase: row.phrase, language, active: true };
}

const unique = (lines: readonly string[]): string[] => [...new Set(lines)];

/**
 * Select rows from a verified release and map them to a {@link TermPack} (`id: 'chatwarden-corpus'`, the release's version), then
 * run it through `loadTermPack`. A row is active when its status is accepted or provisional (and selected), it is `defaultActive`,
 * and none of its `collidesWith` languages is also selected; disputed and withdrawn rows load inactive, and nothing here ever
 * switches a row on that the release did not. The negative corpus and known losses are merged for the selected languages, in the
 * order they were asked for. An empty or invalid selection is a `RangeError` naming the option; a result that does not load is
 * `CorpusError('bad_pack', 'validate')`.
 * @experimental
 */
export function releaseToPack(release: TermsRelease, select: PackSelection): TermPack {
  const o = normalise(select);
  const terms = release.terms.flatMap((row) => {
    const out = selectTerm(row, o);
    return out === null ? [] : [out];
  });
  const exceptions = release.exceptions.flatMap((row) => {
    const out = selectException(row, o);
    return out === null ? [] : [out];
  });
  const negativeCorpus = unique(o.languages.flatMap((l) => release.negative[l]?.lines ?? []));
  const knownLosses = unique(o.languages.flatMap((l) => release.negative[l]?.knownLosses ?? []));
  const positiveCorpus = unique(release.positive);
  const pack = {
    id: 'chatwarden-corpus',
    version: release.version,
    terms,
    exceptions,
    negativeCorpus,
    knownLosses,
    ...(positiveCorpus.length === 0 ? {} : { positiveCorpus }),
  };
  try {
    return loadTermPack(pack);
  } catch {
    // loadTermPack's messages name rows and sometimes quote a term; none of that is passed on.
    throw new CorpusError('bad_pack', 'validate');
  }
}
