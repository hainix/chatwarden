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
  if (make === null) return null;
  try {
    return make(locale);
  } catch {
    // A locale Intl refuses: names in English are better than none.
    try {
      return make('en');
    } catch {
      return null;
    }
  }
}

/**
 * `English (en)` for a code Intl can name, else the code alone. The code stays in the label because it is what a moderator types
 * and what the server stores.
 */
export function languageLabel(code: string, locale: string, make: LanguageNamesFactory | null = defaultNames): string {
  const names = namesFor(make, locale);
  if (names === null) return code;
  let name: string | undefined;
  try {
    name = names.of(code);
  } catch {
    return code;
  }
  if (name === undefined || name === '' || name.toLowerCase() === code.toLowerCase()) return code;
  return `${name} (${code})`;
}

/** Each code once, ordered by its label in the locale; codes Intl cannot name come last, in the order given. */
export function sortLanguages(codes: readonly string[], locale: string, make: LanguageNamesFactory | null = defaultNames): string[] {
  const unique = [...new Set(codes)];
  const named = unique.filter((c) => languageLabel(c, locale, make) !== c);
  const bare = unique.filter((c) => languageLabel(c, locale, make) === c);
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale);
  } catch {
    collator = new Intl.Collator('en');
  }
  named.sort((a, b) => collator.compare(languageLabel(a, locale, make), languageLabel(b, locale, make)));
  return [...named, ...bare];
}
