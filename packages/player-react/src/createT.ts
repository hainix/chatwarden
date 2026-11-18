// `createT`: the `t` the components take, from a catalog and a locale. It lives in a file of its own so an entry that needs only the function (the appeal page) does not carry the
// English catalog of `i18n.ts`; `i18n.ts` re-exports it, so `createT` is imported from there as it always was.
import type { PlayerCatalog, PlayerT } from './i18n.js';

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Builds the `t` function for a catalog and a locale.
 * - `{name}` is replaced by `params.name`; a name with no value stays as written; a value is never expanded again.
 * - Numbers are formatted for the locale (`1,234`).
 * - With a numeric `count`, the plural form for the locale is used (`key.one`, `key.other`, ...), `key.zero` for 0 if it
 *   exists, and `key.other` when the locale's form is missing.
 * - A key with no text comes back as the key itself, so a gap in a translation is visible instead of blank.
 */
export function createT(catalog: PlayerCatalog, locale = 'en'): PlayerT {
  let numbers: Intl.NumberFormat;
  let plurals: Intl.PluralRules;
  try {
    numbers = new Intl.NumberFormat(locale);
    plurals = new Intl.PluralRules(locale);
  } catch {
    numbers = new Intl.NumberFormat('en');
    plurals = new Intl.PluralRules('en');
  }
  const has = (key: string): boolean => Object.hasOwn(catalog, key);

  return (key, params) => {
    let template: string | undefined;
    const count = params?.count;
    if (isCount(count)) {
      const form = count === 0 && has(`${key}.zero`) ? 'zero' : plurals.select(count);
      for (const candidate of [`${key}.${form}`, `${key}.other`]) {
        if (has(candidate)) {
          template = catalog[candidate];
          break;
        }
      }
    }
    template ??= has(key) ? catalog[key] : undefined;
    if (template === undefined) return key;
    if (params === undefined) return template;
    return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
      if (!Object.hasOwn(params, name)) return whole;
      const value = params[name];
      return typeof value === 'number' ? numbers.format(value) : String(value);
    });
  };
}
