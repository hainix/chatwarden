// @chatwarden/matcher/corpus/node: the server-only half of the shared term list. The one folder under packages/matcher/src that may
// import `node:` (eslint.config.js names it, scripts/eslint-ban.test.ts pins both sides of that). Nothing outside this folder imports it.

export { fileCache } from './fileCache.js';
export { installationKey } from './installationKey.js';
export { startCorpus, type StartCorpusOptions, type StartedCorpus, type StartedEvalCorpus } from './start.js';
