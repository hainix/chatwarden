// @chatwarden/store-memory/testing: a kit for your own tests (a fake clock, a scripted chat, outcome assertions). Browser-safe (no `node:` import), no
// dependency beyond @chatwarden/core, and no test runner: assertions throw plain errors and outcomes are strings. Everything here is @experimental until 0.2,
// and none of it is for production.
export { durationMs } from './duration.js';
export type { Duration } from './duration.js';
export { createFakeClock } from './clock.js';
export type { FakeClock } from './clock.js';
export { wordFilter, wordMatcher } from './words.js';
export { checkLines, createTestKit } from './kit.js';
export type { TestKit, TestKitOptions } from './kit.js';
export type { ReportLabel, ReportOutcome, SayLabel, SayOutcome, TestRoom } from './room.js';
export { ScriptMismatch, expectOutcomes } from './script.js';
export type { Run, Step } from './script.js';
