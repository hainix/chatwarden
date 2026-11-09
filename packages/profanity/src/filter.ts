import type { ProfanityConfig, ProfanityFilter } from '@chatwarden/core';
import {
  collapseLikePreset,
  foldTerm,
  mergeSpans,
  stripInvisible,
  stripWithMap,
  toOriginal,
} from '@chatwarden/matcher';
import {
  DataSet,
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  parseRawPattern,
} from 'obscenity';

/** The built-in word lists, by language code. Only English today; more arrive as they are contributed. */
export const SUPPORTED_LANGUAGES: readonly string[] = ['en'];

const STYLES: readonly string[] = ['full', 'keepFirst', 'grawlix'];

/** What `grawlix` masks cycle through. */
const GRAWLIX = '#$%@!&';

/** A word must have this many letters once repeated letters are collapsed, as in the slur matcher: a one- or
 *  two-letter "word" would star ordinary text. */
const MIN_WORD_LENGTH = 3;

/** Thrown when the profanity config cannot be built into a filter. The message names the field (for example
 *  `profanity.add[2]`) and never repeats a word the adopter wrote. */
export class ProfanityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfanityConfigError';
  }
}

/** Every phrase in the dataset carries the word it stands for (the English list's own `originalWord`); the
 *  words this package adds carry the word as the adopter wrote it, folded. `remove` matches against it. */
interface PhraseMeta {
  originalWord: string;
}

/** The comparison form of a word for `remove`: accents off, lowercase, spaces trimmed and collapsed. */
const removalKey = (word: string): string => foldTerm(word).replace(/\s+/g, ' ');

/** An adopter's word as the pattern that matches it: plain letters, accents stripped, repeated letters collapsed
 *  the way the transformers collapse the input (a pattern that still held a collapsible double could never
 *  match). Anything else would be read by obscenity as pattern syntax or could never match a whole word. */
function toPatternWord(raw: unknown, path: string): { key: string; pattern: string } {
  const folded = typeof raw === 'string' ? foldTerm(raw) : '';
  if (!/^[a-z]+$/.test(folded)) {
    throw new ProfanityConfigError(`${path} must be a single word of plain letters`);
  }
  const pattern = collapseLikePreset(folded);
  if (pattern.length < MIN_WORD_LENGTH) {
    throw new ProfanityConfigError(
      `${path} must have at least ${MIN_WORD_LENGTH} letters once repeated letters are collapsed`,
    );
  }
  return { key: folded, pattern };
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ProfanityConfigError(`${path} must be a list of words`);
  return [...(value as unknown[])] as string[];
}

function addWholeWord(dataset: DataSet<PhraseMeta>, word: { key: string; pattern: string }): void {
  dataset.addPhrase((phrase) =>
    phrase.setMetadata({ originalWord: word.key }).addPattern(parseRawPattern(`|${word.pattern}|`)),
  );
}

/** The punctuation marks the leetspeak table reads as letters (! | ( / $ @ become i i c l s a). Matching the
 *  text a second time with them turned into spaces catches "snerp!" and "(snerp)" while the first pass still
 *  catches in-word leetspeak. The second pass can only add hits. */
const LEET_PUNCTUATION = /[!|(/$@]/;
const LEET_PUNCTUATION_ALL = /[!|(/$@]/g;

function mask(visible: string[], style: ProfanityConfig['style']): string {
  const n = Math.max(visible.length, 1);
  if (style === 'grawlix') return Array.from({ length: n }, (_, i) => GRAWLIX[i % GRAWLIX.length]).join('');
  if (style === 'keepFirst' && n > 1) return visible[0]! + '*'.repeat(n - 1);
  return '*'.repeat(n);
}

/**
 * Builds the filter for a profile's `profanity` section.
 *
 * - The words: the built-in list of each language in `languages` (today `'en'`, obscenity's English dataset), or,
 *   when `only` is set, exactly the words in `only` (whole-word patterns). Then `add` joins them (whole-word
 *   patterns), then `remove` takes words out by name, case-insensitively, whichever list they came from. So a
 *   word in both `add` and `remove` is removed.
 * - Evasion: the same handling as the slur matcher. The line is read the way obscenity's English preset reads it
 *   (case, leetspeak, look-alike characters, repeated letters) after hidden characters and accents are stripped,
 *   and `!`, `$`, `(` and the like next to a word do not hide it. Separators ("s n e r p") are not removed, on
 *   purpose: precision first.
 * - `style` masks each hit on the ORIGINAL text, so everything around it is left as typed: `full` is `*` for
 *   each letter, `keepFirst` the first letter and then `*`, `grawlix` a cycle of `#$%@!&`. The length is the
 *   hit's visible letters, so a hidden character does not show.
 * - `mode` is not the filter's concern: it reports, and the chat service decides whether to deliver, star or
 *   refuse. It is never a slur check and a hit is never a rule violation.
 *
 * Throws {@link ProfanityConfigError} for an unknown language or style, a list that is not a list, or an `add` or
 * `only` word that is not plain letters (at least three once repeated letters are collapsed). The config is
 * copied, so changing it afterwards changes nothing.
 */
export function createProfanityFilter(config: ProfanityConfig): ProfanityFilter {
  if (typeof config !== 'object' || config === null) {
    throw new ProfanityConfigError('profanity config must be an object');
  }
  const style = config.style;
  if (!STYLES.includes(style)) {
    throw new ProfanityConfigError("profanity.style must be 'full', 'keepFirst' or 'grawlix'");
  }
  const languages = stringList(config.languages, 'profanity.languages');
  languages.forEach((language, i) => {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new ProfanityConfigError(
        `profanity.languages[${i}] '${String(language)}' is not a built-in list (available: ${SUPPORTED_LANGUAGES.join(', ')})`,
      );
    }
  });
  const only = config.only === null || config.only === undefined ? null : stringList(config.only, 'profanity.only');
  const add = stringList(config.add, 'profanity.add');
  const remove = stringList(config.remove, 'profanity.remove');

  const dataset = new DataSet<PhraseMeta>();
  if (only !== null) {
    only.forEach((raw, i) => addWholeWord(dataset, toPatternWord(raw, `profanity.only[${i}]`)));
  } else if (languages.includes('en')) {
    dataset.addAll(englishDataset);
  }
  add.forEach((raw, i) => addWholeWord(dataset, toPatternWord(raw, `profanity.add[${i}]`)));
  const removed = new Set(remove.map((raw, i) => {
    if (typeof raw !== 'string') throw new ProfanityConfigError(`profanity.remove[${i}] must be a word`);
    return removalKey(raw);
  }));
  if (removed.size > 0) {
    dataset.removePhrasesIf((phrase) => {
      const word = phrase.metadata?.originalWord;
      return word !== undefined && removed.has(removalKey(word));
    });
  }

  const built = dataset.build();
  const matcher = new RegExpMatcher({ ...built, ...englishRecommendedTransformers });

  return {
    apply(text: string) {
      const view = stripWithMap(text);
      const passes = LEET_PUNCTUATION.test(view.text) ? [view.text, view.text.replace(LEET_PUNCTUATION_ALL, ' ')] : [view.text];
      const found: Array<{ start: number; end: number; termId: string }> = [];
      for (const pass of passes) {
        for (const hit of matcher.getAllMatches(pass, true)) {
          found.push({ ...toOriginal(view, hit.startIndex, hit.endIndex), termId: 'profanity' });
        }
      }
      if (found.length === 0) return { hit: false, text };
      let out = '';
      let at = 0;
      for (const span of mergeSpans(found)) {
        out += text.slice(at, span.start) + mask(Array.from(stripInvisible(text.slice(span.start, span.end))), style);
        at = span.end;
      }
      return { hit: true, text: out + text.slice(at) };
    },
  };
}
