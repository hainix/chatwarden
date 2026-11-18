import type { Clock } from '@chatwarden/core';
import { createCorpusLoader, systemSchedule, type CorpusEvalLoader, type CorpusLoader, type CorpusLoaderOptions } from '../loader.js';
import { VERSION } from '../../index.js';
import { fileCache } from './fileCache.js';

// The convenience starter (design 8.2, 9): a disk cache in `dir`, one refresh bounded to 10 seconds so a game never waits on the
// network, and the periodic refresh. It does not reject for anything that goes wrong while it runs (a folder that cannot be written, no
// network, a cache full of garbage); the loader's `status()` says what happened. Only a configuration that can never work (a missing
// `dir`, neither `pin` nor `follow`, ...) throws, as a RangeError, because that one is the caller's to fix.

const STARTUP_BOUND_MS = 10_000;
const systemClock: Clock = { now: () => Date.now() };

export type StartCorpusOptions = Omit<CorpusLoaderOptions, 'cache' | 'clock'> & { dir: string; clock?: Clock };

/** A running loader: everything {@link CorpusLoader} does, and `stop()` for the periodic refresh the starter began. */
export type StartedCorpus = CorpusLoader & { stop(): void };

/** A running eval-set loader (`kind: 'eval'`): everything {@link CorpusEvalLoader} does, and `stop()`. */
export type StartedEvalCorpus = CorpusEvalLoader & { stop(): void };

/**
 * Open the cache folder, refresh once (waiting at most 10 seconds for it; a slower refresh carries on in the background), start the
 * periodic refresh (24 hours, plus or minus 10 percent, unref'd) and return the loader. With `apply: 'auto'` and `terms`, the verified
 * list is applied inside that first refresh.
 */
export async function startCorpus(options: StartCorpusOptions & { kind: 'eval' }): Promise<StartedEvalCorpus>;
export async function startCorpus(options: StartCorpusOptions & { kind?: 'terms' }): Promise<StartedCorpus>;
export async function startCorpus(options: StartCorpusOptions): Promise<StartedCorpus | StartedEvalCorpus>;
export async function startCorpus(options: StartCorpusOptions): Promise<StartedCorpus | StartedEvalCorpus> {
  if (options === null || typeof options !== 'object') throw new RangeError('startCorpus: options are required');
  const { dir, clock, ...rest } = options;
  if (typeof dir !== 'string' || dir === '') throw new RangeError('startCorpus: dir must be the folder the cache lives in');
  const schedule = rest.schedule ?? systemSchedule;
  const loader = createCorpusLoader({ ...rest, kit: rest.kit ?? VERSION, schedule, cache: fileCache(dir), clock: clock ?? systemClock } as CorpusLoaderOptions);

  let cancelBound: () => void = () => undefined;
  const bound = new Promise<void>((resolve) => {
    try {
      cancelBound = schedule.after(STARTUP_BOUND_MS, resolve);
    } catch {
      resolve();
    }
  });
  await Promise.race([loader.refresh().then(() => undefined), bound]);
  cancelBound();
  const stop = loader.start({ schedule });
  return { ...loader, stop } as StartedCorpus | StartedEvalCorpus;
}
