// A language code, named for a person. `Intl.DisplayNames` does the naming; where it is missing, refuses the code or the locale,
// or has no name for it, the code itself stands. Nothing here holds English.

/** The part of `Intl.DisplayNames` this file uses, so a test can hand in one that throws. */
export interface LanguageNames {
  of(code: string): string | undefined;
}
export type LanguageNamesFactory = (locale: string) => LanguageNames;

const defaultNames: LanguageNamesFactory | null =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? (locale) => new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' })
    : null;

function namesFor(make: LanguageNamesFactory | null, locale: string): LanguageNames | null {
  // A locale Intl refuses: names in English are better than none.
  for (const loc of [locale, 'en']) {
    try {
      return make === null ? null : make(loc);
    } catch {
      // try the next
    }
  }
  return null;
}

/**
 * `English (en)` for a code Intl can name, else the code alone. The code stays in the label because it is what a moderator types
 * and what the server stores.
 */
export function languageLabel(code: string, locale: string, make: LanguageNamesFactory | null = defaultNames): string {
  let name: string | undefined;
  try {
    name = namesFor(make, locale)?.of(code);
  } catch {
    return code;
  }
  return name === undefined || name === '' || name.toLowerCase() === code.toLowerCase() ? code : `${name} (${code})`;
}

/** Each code once, ordered by its label in the locale; codes Intl cannot name come last, in the order given. */
export function sortLanguages(codes: readonly string[], locale: string, make: LanguageNamesFactory | null = defaultNames): string[] {
  const labelled = [...new Set(codes)].map((c) => ({ c, l: languageLabel(c, locale, make) }));
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale);
  } catch {
    collator = new Intl.Collator('en');
  }
  const named = labelled.filter((x) => x.l !== x.c).sort((x, y) => collator.compare(x.l, y.l));
  return [...named, ...labelled.filter((x) => x.l === x.c)].map((x) => x.c);
}
