// Loads a language on demand: the catalogue is its own chunk, fetched only when a moderator's locale asks for that language, so the hub's first
// load carries none of its text. The words are merged over the English (the hub's, the AI parts' and the privacy parts'), so a key a catalogue
// lacks shows the English.

import { en } from '../i18n.js';
import type { HubCatalog } from '../i18n.js';
import { matchLocale } from './match.js';
import type { ShippedLocale } from './match.js';

/** What a language module holds: the hub's words, the AI parts' words and the privacy parts' words. */
interface Words {
  core: HubCatalog;
  ai: HubCatalog;
  privacy: HubCatalog;
}

/** What the hub asks of the page to get a language. Exposed so a test can make an import fail or wait; nothing else replaces it. */
export const hubLocaleLoaders: Record<ShippedLocale, () => Promise<unknown>> = {
  es: () => import('./es.js'),
  pt: () => import('./pt.js'),
};

/** A language module's three catalogues: `es`, `esAi`, `esPrivacy` (or the `pt` ones). */
function wordsOf(locale: ShippedLocale, module: unknown): Words {
  const m = module as Record<string, HubCatalog | undefined>;
  const name = locale === 'es' ? 'es' : 'pt';
  return { core: m[name] ?? {}, ai: m[`${name}Ai`] ?? {}, privacy: m[`${name}Privacy`] ?? {} };
}

/**
 * The hub's words for a locale, as one catalogue to give `createT`: the English under the language's words, so a key left out reads in English.
 * English, an unknown locale and anything that is not a locale give the English catalogue, and import nothing. A language module that cannot be
 * loaded rejects: the provider keeps English and the next call tries again.
 */
export async function loadHubCatalog(locale: unknown): Promise<HubCatalog> {
  const matched = matchLocale(locale);
  if (matched === null) return en;
  const [module, ai, privacy] = await Promise.all([hubLocaleLoaders[matched](), import('../ai/i18n.js').then((m) => m.aiEn), import('../privacy/i18n.js').then((m) => m.privacyEn)]);
  const words = wordsOf(matched, module);
  return { ...en, ...ai, ...privacy, ...words.core, ...words.ai, ...words.privacy };
}
