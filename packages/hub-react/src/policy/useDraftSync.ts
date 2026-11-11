import { useEffect, useRef } from 'react';
import type { UsePolicy } from '../policyHooks.js';
import type { PolicySection, PolicyState } from '../types.js';
import type { Pending } from './useSaveFlow.js';

/**
 * What a settings screen does when the state it was given is replaced. After a save or a reset the screen is waiting for the new state:
 * all of its draft is made from it after a save, and only the sections that were reset after a reset (so edits elsewhere are kept). A
 * state that arrives for another reason leaves the draft alone. A read that failed brings no state, so the screen stops waiting.
 * Returns the `pending` ref the save and reset flows set.
 */
export function useDraftSync(
  state: PolicyState,
  policy: UsePolicy,
  apply: { all: (state: PolicyState) => void; sections: (sections: readonly PolicySection[], state: PolicyState) => void },
): Pending {
  const pending: Pending = useRef(null);
  const seen = useRef(state);
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    if (seen.current === state) return;
    seen.current = state;
    const p = pending.current;
    pending.current = null;
    if (p === 'all') latest.current.all(state);
    else if (p !== null) latest.current.sections(p, state);
  }, [state]);
  // A read that failed brings no state: the draft is not waiting for one (a later read for another reason must not replace it).
  useEffect(() => {
    if (policy.error !== null) pending.current = null;
  }, [policy.error]);
  return pending;
}
