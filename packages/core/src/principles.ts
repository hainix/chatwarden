// The moderation principles block of the AI prompt: the guideline tiers and team notes as one screened, capped list of lines. The code lives in
// `ai/principles.ts` (the AI folder may import only its own files and a short allowlist of core modules); this module is its public face, for
// `PolicyService` and the barrel.
export { PRINCIPLES_BLOCK_MAX, PRINCIPLES_LINE_MAX, promptPrinciples } from './ai/principles.js';
export type { PrinciplesInput, PromptExcluded, PromptPrinciples } from './ai/principles.js';
