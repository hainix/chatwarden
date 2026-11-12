import { safeWarn } from './log.js';
import { BUILTIN_SIGNAL_KINDS } from './signals.js';
import type { ResolvedSignals } from './signals.js';
import type { SignalRuntime } from './signalService.js';
import type { Logger } from './types.js';

/**
 * What `cw.signals` is when the store cannot keep signals (it lacks the three signal methods): `record` is false and said once, every reader
 * is empty, and `kinds` still lists what the profile declares. The real service (`./signalService.js`) is loaded only for a store that can keep
 * them, so a page that never records a signal does not carry it.
 */
export function createInertSignals(logger: Logger | undefined, settings: () => ResolvedSignals): SignalRuntime {
  let said = false;
  const record = (): boolean => {
    if (!said) {
      said = true;
      safeWarn(logger, 'chatwarden.signals_store_unsupported');
    }
    return false;
  };
  return {
    record,
    flood: record,
    counts: () => [],
    kinds: () => Object.entries(settings().kinds).map(([kind, k]) => ({ kind, label: k.label, polarity: k.polarity, weight: k.weight, builtin: Object.hasOwn(BUILTIN_SIGNAL_KINDS, kind) })),
    boosted: () => new Set(),
    forRecord: () => [],
    ladderHits: () => [],
  };
}
