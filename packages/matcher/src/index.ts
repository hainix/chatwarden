export const VERSION = '0.2.3';

export type { TermRow, ExceptionRow, Matcher, Span } from './matcher.js';
export { MatcherBuildError, buildMatcher } from './matcher.js';
export { stripInvisible, foldTerm, foldPhrase, collapseLikePreset, skeleton, foldKana, normaliseUnspaced } from './normalise.js';
export { isUnspacedTerm, UNSPACED_SCRIPTS, UNSPACED_LANGUAGES } from './unspaced.js';
export type { UnspacedLanguage, UnspacedScript } from './unspaced.js';
export { stripWithMap, toOriginal, mergeSpans, type StrippedView } from './spans.js';
export { nameViews, matchName, matchReserved } from './names.js';
export { loadTermPack, type TermPack } from './termPack.js';
export type {
  AuditEntry,
  ExceptionPatch,
  ExceptionRecord,
  LegacyTermAuditAction,
  TermAuditAction,
  TermPatch,
  TermRecord,
  TermStore,
} from './termStore.js';
export {
  LiveTerms,
  type ChangeRefusalCode,
  type ChangeResult,
  type CheckResult,
  type ExceptionListRow,
  type SyncResult,
  type SyncSummary,
  type TermEditor,
  type TermListRow,
} from './liveTerms.js';
