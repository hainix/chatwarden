import type { TermPack } from '../termPack.js';
import { SYNTHETIC_EXCEPTIONS, SYNTHETIC_TERMS } from './syntheticPack.js';

/** The synthetic terms as a TermPack. The negative corpus is every term's negative lines (all fine under
 *  the whole pack); `knownLosses` is empty unless the caller overrides it. */
export function syntheticTermPack(over: Partial<TermPack> = {}): TermPack {
  return {
    id: 'synthetic',
    version: '1',
    terms: SYNTHETIC_TERMS.map((t) => ({
      id: t.id,
      term: t.term,
      language: t.language,
      active: true,
      positive: [...t.positive],
      negative: [...t.negative],
    })),
    exceptions: SYNTHETIC_EXCEPTIONS.map((e) => ({ id: e.id, phrase: e.phrase, language: e.language, active: true })),
    negativeCorpus: SYNTHETIC_TERMS.flatMap((t) => t.negative),
    knownLosses: [],
    ...over,
  };
}
