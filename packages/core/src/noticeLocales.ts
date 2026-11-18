// The words of the appeal page and of the delivered text in English, Spanish and Portuguese, and the choice between them. The subpath
// `@chatwarden/core/notice-locales`. The kit's HTTP layer renders the appeal page and a game's delivery hook sends the text with these, and player-react's
// own copies of the notice words are held equal to them by a parity test. Pure: no Node built-in module, no clock, nothing read from a store.
//
// Spanish and Portuguese are machine drafts nobody has read yet (see each catalogue's `meta`): have a person who speaks the language read them before
// turning the language on for players. A game can word any language itself with `appeals.words` in the profile, and add languages of its own.

import { APPEAL_WORDS } from './appealWords.js';
import type { AppealWordKey, NoticeLocaleMeta } from './appealWords.js';
import { NOTICE_WORDS } from './noticeCopy.js';
import type { NoticeWordKey } from './noticeCopy.js';
import { NOTICE_WORDS_ES } from './noticeLocales.es.js';
import { NOTICE_WORDS_PT } from './noticeLocales.pt.js';

export { APPEAL_WORDS, NOTICE_WORDS_ES, NOTICE_WORDS_PT };
export type { AppealWordKey, NoticeLocaleMeta, NoticeWordKey };
export { buildDeliveryContent, escapeHtml } from './deliveryCopy.js';
export type { DeliveryContentInput } from './deliveryCopy.js';
export { durationText, fillWords } from './noticeCopy.js';

/** A game's own words, by language then by word key (`appeals.words`). */
export type AppealWordOverrides = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The languages the kit ships. */
export const NOTICE_LOCALES = ['en', 'es', 'pt'] as const;

const SHIPPED: Readonly<Record<string, Readonly<Record<string, string>> | undefined>> = { es: NOTICE_WORDS_ES, pt: NOTICE_WORDS_PT };
const ENGLISH: Readonly<Record<string, string>> = { ...NOTICE_WORDS, ...APPEAL_WORDS };
const LANGUAGE = /^[a-z]{2,3}$/;
const TAG_MAX = 64;

const hasOwn = (o: unknown, key: string): boolean => typeof o === 'object' && o !== null && Object.hasOwn(o, key);

/**
 * The language to answer in, from what the person asked for (the entries of `?lang=` and `Accept-Language`, best first): the first entry whose base language (lower case, before
 * the first `-` or `_`) is two or three letters and is one of `en`, `es`, `pt` or an own key of `overrides` (a game's own language). Entries that are not strings, are longer than 64
 * characters or are not a language are skipped. English when nothing matches. Never throws.
 */
export function chooseLocale(requested: readonly unknown[], overrides?: AppealWordOverrides): string {
  if (!Array.isArray(requested)) return 'en';
  for (const entry of requested as unknown[]) {
    if (typeof entry !== 'string' || entry.length > TAG_MAX) continue;
    const base = entry.toLowerCase().split(/[-_]/)[0] ?? '';
    if (!LANGUAGE.test(base)) continue;
    if ((NOTICE_LOCALES as readonly string[]).includes(base) || hasOwn(overrides, base)) return base;
  }
  return 'en';
}

/**
 * The words for one language: the English set, then the shipped Spanish or Portuguese over it, then the game's own words for that language (`overrides[language]`) over both. Only a key
 * that exists in the English set is taken, and only a non-empty string (an unknown key, a number, an empty string and `__proto__` are ignored). Returns the language it chose (see
 * {@link chooseLocale}) and a fresh object each call.
 */
export function noticeWordsFor(locale: unknown, overrides?: AppealWordOverrides): { locale: string; words: Record<string, string> } {
  const lang = chooseLocale([locale], overrides);
  const words: Record<string, string> = { ...ENGLISH };
  const shipped = Object.hasOwn(SHIPPED, lang) ? SHIPPED[lang] : undefined;
  if (shipped !== undefined) Object.assign(words, shipped);
  const own: unknown = hasOwn(overrides, lang) ? (overrides as AppealWordOverrides)[lang] : undefined;
  if (typeof own === 'object' && own !== null) {
    for (const key of Object.keys(own)) {
      if (!Object.hasOwn(ENGLISH, key)) continue;
      const value: unknown = (own as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '') words[key] = value;
    }
  }
  return { locale: lang, words };
}
