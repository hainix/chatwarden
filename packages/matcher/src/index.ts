export const VERSION = '0.0.0';

export type { TermRow, ExceptionRow, Matcher, Span } from './matcher.js';
export { MatcherBuildError, buildMatcher } from './matcher.js';
export { stripInvisible, foldTerm, foldPhrase, collapseLikePreset } from './normalise.js';
export { nameViews, matchName } from './names.js';
export { loadTermPack, type TermPack } from './termPack.js';
export type {
  AuditEntry,
  ExceptionPatch,
  ExceptionRecord,
  TermPatch,
  TermRecord,
  TermStore,
} from './termStore.js';
export { LiveTerms, type ChangeResult, type CheckResult, type TermEditor } from './liveTerms.js';
