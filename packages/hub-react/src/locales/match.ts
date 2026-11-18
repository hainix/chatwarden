// Which of the shipped languages a locale tag asks for. Pure: no catalogue is loaded here, so the main entry can use it.

/** The languages the package ships a catalogue for. */
export const SHIPPED_LOCALES = ['es', 'pt'] as const;
export type ShippedLocale = (typeof SHIPPED_LOCALES)[number];

/** The longest tag looked at; anything longer is not a locale. */
const MAX_TAG = 64;

/**
 * The language in `available` that a locale tag asks for, or `null`. Only the base language counts, in any case, with `-` or `_`:
 * `es`, `es-MX`, `es-419`, `ES` and `es_AR` are `es`; `pt`, `pt-BR` and `pt-PT` are `pt`. Anything else (another language, an empty
 * string, something that is not a string, a very long string) is `null`.
 */
export function matchLocale<L extends string = ShippedLocale>(requested: unknown, available: readonly L[] = SHIPPED_LOCALES as unknown as readonly L[]): L | null {
  if (typeof requested !== 'string' || requested.length > MAX_TAG) return null;
  const base = requested.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  return available.find((l) => l.toLowerCase() === base) ?? null;
}
