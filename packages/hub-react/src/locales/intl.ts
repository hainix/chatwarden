/** The tag handed to `Intl` (dates, numbers, plurals): the locale asked for when it is well formed (`es_AR` is read as `es-AR`), else the language that matched. */
export function intlTag(requested: string, matched: string): string {
  try {
    return Intl.getCanonicalLocales(requested.trim().replace(/_/g, '-'))[0] ?? matched;
  } catch {
    return matched;
  }
}
