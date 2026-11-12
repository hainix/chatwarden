import type { AiFacade, AiStatsView, AiStatus } from './service.js';

// The facade when no AI is configured. Apart from the service so that a build with no AI in it never loads the service (the kit imports the
// service only when `createChatwarden` is given an adapter): a browser bundle of the kit carries these few lines and not the AI module.

/** The facade when no AI is configured: always off, never touches the store. */
export function createInertAi(): AiFacade {
  const status: AiStatus = { available: false, level: 0, maxLevel: 0, state: 'off', spentMicros: 0, capMicros: 0, capCalls: 0, day: '', reads: 0, cacheHitRate: null, invalid: {} };
  return {
    level: () => 0,
    status: () => ({ ...status, invalid: {} }),
    read: () => null,
    readAgain: () => Promise.resolve('off'),
    briefs: () => new Map(),
    stats: (q) => emptyStats(q?.since ?? 0),
    markReversed: () => false,
    dontTeach: () => false,
    idle: () => Promise.resolve(),
    sweep: () => Promise.resolve(),
    close: () => undefined,
  };
}

export const emptyStats = (since: number): AiStatsView => ({ since, decided: 0, agree: 0, override: 0, none: 0, falsePositives: 0, oneClick: 0, agreementRate: null, falsePositiveRate: null, oneClickRate: null, rules: [] });

