export const VERSION = '0.1.5';

export type { TermRow, ExceptionRow, Matcher, Span } from './matcher.js';
export { MatcherBuildError, buildMatcher } from './matcher.js';
export { stripInvisible, foldTerm, foldPhrase, collapseLikePreset } from './normalise.js';
export { stripWithMap, toOriginal, mergeSpans, type StrippedView } from './spans.js';
export { nameViews, matchName } from './names.js';
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
  type TermEditor,
  type TermListRow,
} from './liveTerms.js';
