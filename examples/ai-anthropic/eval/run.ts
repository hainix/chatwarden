import type { EvalOutcome } from './score.ts';

// The opt-in eval (design section 13). It spends real money, so it runs only when ANTHROPIC_API_KEY is set and only when a person
// runs it: `npm run eval:ai --workspace @chatwarden/example-ai-anthropic`. It is never part of `npm test` and never runs in CI.
//
//   --thinking off   the cost experiment: send `thinking: { type: 'disabled' }` and compare quality and cost with the default run.
//
// The key is passed to the adapter explicitly, so a stray login profile or environment never triggers spend. Without a key the
// script prints one line and exits 0 before it imports the adapter or the SDK.

/** Typical cost of one read with a cache hit, micro-dollars (design section 7: about $0.00029). */
const TYPICAL_COST_MICROS = 290;
const HARD_DEADLINE_MS = 30_000;

async function main(argv: string[]): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key.trim() === '') {
    console.log('skipped: ANTHROPIC_API_KEY is not set');
    return 0;
  }

  const flag = argv.indexOf('--thinking');
  const thinking = flag === -1 ? 'adaptive' : argv[flag + 1];
  if (thinking !== 'adaptive' && thinking !== 'off') {
    console.error('usage: eval:ai [--thinking off]');
    return 2;
  }

  const { loadCases } = await import('./cases.ts');
  const { runCase } = await import('./pipeline.ts');
  const { formatScore, scoreResults } = await import('./score.ts');
  const { createAnthropicAI } = await import('../src/anthropic.ts');

  const cases = loadCases();
  const ai = createAnthropicAI({ apiKey: key, thinking });
  console.log(`${ai.id}, thinking ${thinking}: ${cases.length} cases, estimated spend about $${((cases.length * TYPICAL_COST_MICROS) / 1_000_000).toFixed(4)}`);

  const outcomes: EvalOutcome[] = [];
  let stopped = false;
  for (const c of cases) {
    const outcome = await runCase(ai, c, AbortSignal.timeout(HARD_DEADLINE_MS));
    outcomes.push(outcome);
    const read = outcome.read;
    console.log(`  ${c.id.padEnd(28)} ${outcome.status}${read ? ` ${read.severity}/${read.recommendation?.verdict ?? 'none'}` : outcome.code ? ` (${outcome.code})` : ''}`);
    if (outcome.code === 'fatal') {
      stopped = true;
      console.error('stopped: the provider rejected the request (key, permission or request shape); fix that and run again');
      break;
    }
  }

  const score = scoreResults(cases.slice(0, outcomes.length), outcomes);
  console.log(`\n${formatScore(score)}`);
  if (score.cacheHit !== null && score.cacheHit.n === 0) {
    console.log('\nNo cache read on any repeat call: cache_control is not taking effect (check the stable prompt is at least 512 tokens, and see the README).');
  }
  return stopped || score.ceilingViolations > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
