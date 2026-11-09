export const VERSION = '0.0.0';

export type { TermRow, ExceptionRow, Matcher } from './matcher.js';
export { MatcherBuildError, buildMatcher } from './matcher.js';
export { stripInvisible, foldTerm, foldPhrase, collapseLikePreset } from './normalise.js';
export { nameViews, matchName } from './names.js';
