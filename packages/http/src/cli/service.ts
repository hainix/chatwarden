// `chatwarden init --service` (design 3.5): write the service recipe folder. It needs no project (nothing is detected, no package.json is read), asks nothing, and follows the rules of
// every other init: new files only, a file that exists and differs is skipped unless told otherwise, no secret, no network, safe to run twice.
import { applyPlan, exitCodeOf } from './apply.js';
import type { Parsed } from './args.js';
import { GAME_PRESETS, normaliseDir } from './answers.js';
import type { CliEnv } from './env.js';
import { buildServicePlan } from './plan.js';
import { emitReport } from './report.js';
import type { ServiceAnswers } from './types.js';

/** The flags of the wiring that mean nothing for a standalone folder: each is a usage error with `--service`, named in the sentence. */
const NOT_WITH_SERVICE: ReadonlyArray<[string, (p: Parsed) => boolean]> = [
  ['--framework', (p) => p.framework !== undefined],
  ['--chat', (p) => p.chat !== undefined],
  ['--chat-transport', (p) => p.chatTransport !== undefined],
  ['--hub', (p) => p.hub !== undefined],
  ['--discord', (p) => p.discord === true],
  ['--no-discord', (p) => p.discord === false],
  ['--base', (p) => p.base !== undefined],
  ['--lang', (p) => p.lang !== undefined],
  ['--install', (p) => p.install],
  ['--check', (p) => p.check],
];

export const DEFAULT_SERVICE_DIR = 'chatwarden-service';

export async function runServiceInit(parsed: Parsed, env: CliEnv, version: string): Promise<number> {
  const usage = (message: string): number => {
    env.stderr.write(`chatwarden: ${message}\n`);
    return 1;
  };
  for (const [flag, given] of NOT_WITH_SERVICE) {
    if (given(parsed)) return usage(`${flag} does not apply with --service: the service folder has no framework, chat box, hub or Discord feed, and needs no project.`);
  }
  const dir = normaliseDir(parsed.dir ?? DEFAULT_SERVICE_DIR);
  if (typeof dir !== 'string') return usage(dir.error);
  const answers: ServiceAnswers = { service: true, store: parsed.store ?? 'sqlite', profile: parsed.profile ?? (parsed.game === undefined ? 'standard' : GAME_PRESETS[parsed.game]), ...(parsed.game === undefined ? {} : { game: parsed.game }), dir };
  const plan = buildServicePlan(answers, { chatwarden: version });
  const result = await applyPlan(env, plan, { onConflict: parsed.onConflict, dryRun: parsed.dryRun });
  emitReport(env, plan, result, { json: parsed.json, version });
  return exitCodeOf(result);
}
