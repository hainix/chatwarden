import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shared by the locale tests: what makes a drafted catalogue valid against the English one. The checks are plain functions so a test
// can also feed them a bad catalogue and see them fail (a control).

/** The `{name}` placeholders of a string, as a sorted list (a repeat counts). */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1] as string).sort();
}

/** The plural forms a catalogue may carry for a key; `many` and the rest fall back to `.other`, as `createT` does. */
export const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

/** The base keys that have plural forms in a catalogue. */
export function pluralBases(catalog: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.keys(catalog).filter((k) => PLURAL_SUFFIX.test(k)).map((k) => k.replace(PLURAL_SUFFIX, '')))].sort();
}

/** Markup a catalogue text must not carry: a tag, an entity, an inline code fence or a Markdown emphasis or link. */
export function hasMarkup(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>|&[a-zA-Z#0-9]+;|`|\*\*|__|\]\(/.test(text);
}

/** The syntax characters a string uses on purpose (a pattern help line writes `a|b`, `word*` and `~`): a translation keeps them as many times. */
export function syntaxMarks(text: string): string {
  return [...text].filter((c) => '|*~'.includes(c)).join('');
}

/** The keys a source file marks `@deprecated`: unused since an older release, so a translation may leave them out. */
export function deprecatedKeys(...sourceUrls: URL[]): Set<string> {
  const out = new Set<string>();
  for (const url of sourceUrls) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    for (const m of source.matchAll(/@deprecated[^\n]*\*\/\s*\n\s*'([^']+)'/g)) out.add(m[1] as string);
  }
  return out;
}

export interface Problems {
  missing: string[];
  extra: string[];
  placeholders: string[];
  empty: string[];
  identical: string[];
  markup: string[];
  syntax: string[];
  plurals: string[];
}

/**
 * Every way a catalogue can fail against the English one: keys missing (unless deprecated) or outside it, placeholders that differ,
 * empty text, text equal to the English (unless the key is on the allowlist), markup, lost syntax characters, and a plural base
 * without `.one` and `.other`.
 */
export function problems(english: Readonly<Record<string, string>>, catalog: Readonly<Record<string, string>>, opts: { allow: ReadonlySet<string>; deprecated: ReadonlySet<string> }): Problems {
  const out: Problems = { missing: [], extra: [], placeholders: [], empty: [], identical: [], markup: [], syntax: [], plurals: [] };
  for (const key of Object.keys(english)) if (!Object.hasOwn(catalog, key) && !opts.deprecated.has(key)) out.missing.push(key);
  for (const [key, text] of Object.entries(catalog)) {
    const source = english[key];
    if (source === undefined) {
      out.extra.push(key);
      continue;
    }
    if (typeof text !== 'string' || text.trim() === '') out.empty.push(key);
    if (typeof text !== 'string') continue;
    if (placeholders(text).join() !== placeholders(source).join()) out.placeholders.push(key);
    if (text === source && !opts.allow.has(key)) out.identical.push(key);
    if (hasMarkup(text)) out.markup.push(key);
    if (syntaxMarks(text) !== syntaxMarks(source)) out.syntax.push(key);
  }
  for (const base of pluralBases(english)) {
    if (opts.deprecated.has(`${base}.one`) || opts.deprecated.has(`${base}.other`)) continue;
    if (!Object.hasOwn(catalog, `${base}.one`) || !Object.hasOwn(catalog, `${base}.other`)) out.plurals.push(base);
  }
  return out;
}

/** True when there is nothing to fix. */
export const clean = (p: Problems): boolean => Object.values(p).every((list) => list.length === 0);

/** The meta of a drafted catalogue: what it says about who read it. */
export interface Meta {
  locale: string;
  status: string;
  reviewedBy: readonly string[];
  reviewedAt: string | null;
}

/** A catalogue is a machine draft with nobody named and no date, or something else with both: one without the others is wrong. */
export function metaConsistent(meta: Meta): boolean {
  const draft = meta.status === 'machine-draft';
  const named = meta.reviewedBy.length > 0;
  const dated = meta.reviewedAt !== null;
  return draft ? !named && !dated : named && dated;
}

/**
 * Words that claim a review, in English, Spanish and Portuguese. `reviewedBy` and `reviewedAt` are the names of the meta fields and
 * are taken out first.
 */
export const CLAIM_WORDS = /\b(review(ed)?|verified|native|official|approved|revisad[oa]s?|verificad[oa]s?|nativ[oa]s?|oficial(es)?|aprovad[oa]s?|aprobad[oa]s?)\b/i;

/** The text of a source file after its leading comment block (the header): the part a claim may not appear in. */
export function afterHeader(source: string): string {
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] as string).startsWith('//')) i++;
  return lines.slice(i).join('\n').replace(/reviewed(By|At)/g, '');
}
