import type { Store } from './types.js';

// The urgent lane's three optional store methods (0.2.0). A custom store written before the lane has none of them: the kit says so once when it starts, and a call that needs a missing one
// fails with a named error (never a `TypeError`), so a log line that carries only the class and the HTTP answer both say what is wrong.

/** The optional store methods the urgent lane uses. */
export const URGENT_STORE_METHODS = ['setReportUrgent', 'setHandoff', 'countOpenUrgent'] as const;

/** The urgent-lane methods this store does not have, in the order of {@link URGENT_STORE_METHODS}. Empty for both first-party stores. */
export function missingUrgentMethods(store: Store): string[] {
  const s = store as unknown as Record<string, unknown>;
  return URGENT_STORE_METHODS.filter((m) => typeof s[m] !== 'function');
}

/** True when the store has every method the urgent lane uses. */
export function hasUrgentMethods(store: Store): boolean {
  return missingUrgentMethods(store).length === 0;
}

/**
 * Thrown when a call needs an optional store method the store does not have (today: `cases.setUrgent` and `cases.handoff` over a store without the urgent lane). The message names the call
 * and the missing methods; `missing` lists them. It is an `Error`, not a `TypeError`: the HTTP layer answers it 501 `not_supported`, and a log line shows the class `StoreCapabilityError`.
 */
export class StoreCapabilityError extends Error {
  readonly missing: readonly string[];

  constructor(call: string, missing: readonly string[]) {
    super(`${call}: the store does not support this (it lacks ${missing.join(', ')}); use a store that has the urgent-lane methods`);
    this.name = 'StoreCapabilityError';
    this.missing = [...missing];
  }
}
