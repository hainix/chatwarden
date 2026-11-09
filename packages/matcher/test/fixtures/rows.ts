import type { ExceptionRow, TermRow } from '../../src/index.js';
import { SYNTHETIC_EXCEPTIONS, SYNTHETIC_TERMS } from './syntheticPack.js';

export const term = (id: string, t: string, active = true, language = 'en'): TermRow => ({ id, term: t, language, active });
export const exception = (id: string, phrase: string, active = true, language = 'en'): ExceptionRow => ({
  id,
  phrase,
  language,
  active,
});

export const packTermRows = (): TermRow[] =>
  SYNTHETIC_TERMS.map((t) => ({ id: t.id, term: t.term, language: t.language, active: true }));
export const packExceptionRows = (): ExceptionRow[] =>
  SYNTHETIC_EXCEPTIONS.map((e) => ({ id: e.id, phrase: e.phrase, language: e.language, active: true }));
