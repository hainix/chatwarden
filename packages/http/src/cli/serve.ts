// `chatwarden serve` (design 3.4): the subcommand. All it does is hand its flags and the machine's environment, streams and signals to the process (service/launch.ts loads it on demand).
import { launchServe } from '../service/launch.js';
import type { ServeIo } from '../service/launch.js';
import type { ServeFlags } from './args.js';
import type { CliEnv } from './env.js';

/** What a test may replace in `chatwarden serve`: the importer, the file reader, the log, the signals, the hub script. */
export type ServeOverrides = Partial<Omit<ServeIo, 'env' | 'stdout' | 'stderr'>>;

/** Run `chatwarden serve`. Resolves the exit code: 0 stopped, 2 it would not start. */
export function runServe(flags: ServeFlags, env: CliEnv, overrides: ServeOverrides = {}): Promise<number> {
  return launchServe(flags, { env: env.env, stdout: env.stdout, stderr: env.stderr, ...(env.signals === undefined ? {} : { signals: env.signals }), ...overrides });
}
