import type { AiFacade, AiStatsView, AiStatus } from './service.js';

// The facade when no AI is configured. Apart from the service so that a build with no AI in it never loads the service (the kit imports the
// service only when `createChatwarden` is given an adapter): a browser bundle of the kit carries these few lines and not the AI module. For the same
// reason this file imports no other AI file (scripts/browser-bundle.test.ts pins it), so the few numbers of the empty gate view are written out here;
// test/ai/gates-service.test.ts pins them equal to the real defaults.

/** The facade when no AI is configured: always off, never touches the store. */
export function createInertAi(): AiFacade {
  const status: AiStatus = { available: false, level: 0, maxLevel: 0, state: 'off', spentMicros: 0, capMicros: 0, capCalls: 0, day: '', reads: 0, cacheHitRate: null, invalid: {} };
  return {
    level: () => 0,
    status: () => ({ ...status, invalid: {} }),
    read: () => null,
    expected: () => false,
    readAgain: () => Promise.resolve('off'),
    briefs: () => new Map(),
    stats: (q) => emptyStats(q?.since ?? 0),
    markReversed: () => false,
    dontTeach: () => false,
    gates: () => ({
      version: 1,
      windowDays: 90,
      at: 0,
      actingAvailable: false,
      cells: [],
      instance: {
        capHour: { used: 0, max: 10 },
        capDay: { used: 0, max: 50 },
        reviewDebt: { unreviewed: 0, oldestMs: null, max: 25, maxMs: 72 * 3_600_000 },
      },
    }),
    idle: () => Promise.resolve(),
    sweep: () => Promise.resolve(),
    close: () => undefined,
  };
}

export const emptyStats = (since: number): AiStatsView => ({ since, decided: 0, agree: 0, override: 0, none: 0, falsePositives: 0, oneClick: 0, agreementRate: null, falsePositiveRate: null, oneClickRate: null, rules: [] });

