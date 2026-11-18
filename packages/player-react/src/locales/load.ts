// Loads a language on demand: the catalogue is its own chunk, fetched only when a game asks for that language, and the main entry
// carries none of its text. The words are merged over the English, so a key a catalogue lacks shows the English.

import { createT, en } from '../i18n.js';
import type { PlayerT } from '../i18n.js';
import { matchLocale } from './match.js';
import type { ShippedLocale } from './match.js';

const catalogues: Record<ShippedLocale, () => Promise<Readonly<Record<string, string>>>> = {
  es: () => import('./es.js').then((m) => m.es),
  pt: () => import('./pt.js').then((m) => m.pt),
};

/** The tag handed to `Intl` (dates, numbers, plurals): the one asked for when it is well formed, else the language that matched. */
function tagFor(requested: string, matched: string): string {
  try {
    return Intl.getCanonicalLocales(requested.trim().replace(/_/g, '-'))[0] ?? matched;
  } catch {
    return matched;
  }
}

/**
 * The `t` for a locale: Spanish or Portuguese words (the whole player set, the chat box's words and the report-dialog defaults) over the
 * English, formatted for the locale asked for (`es-MX`, `pt-BR`). English, an unknown locale and a failed load give the English `t`; this never
 * rejects, and a failed load is not remembered, so the next call tries again. Pass the result as `t` (with the same `locale`) to the components.
 */
export async function loadPlayerT(locale: unknown): Promise<PlayerT> {
  const matched = matchLocale(locale);
  if (matched === null) return createT(en, 'en');
  try {
    const catalogue = await catalogues[matched]();
    return createT({ ...en, ...catalogue }, tagFor(locale as string, matched));
  } catch {
    return createT(en, 'en');
  }
}
