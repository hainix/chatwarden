import { useState } from 'react';
import type { HubError } from '../client.js';
import type { HubText } from '../i18n.js';
import type { UsePolicy } from '../policyHooks.js';
import type { PolicySection, PolicyState } from '../types.js';
import { SECTION_ORDER } from './model.js';
import type { Pending } from './useSaveFlow.js';

export type ResetKey = 'lengths' | 'ladder' | 'first' | 'repeat' | 'rules' | 'guidelines' | 'reporting' | 'all';

/** What each Reset covers: the kit's sections (a panel can hold two), and the words for its button and its toast. */
export const RESETS: Record<ResetKey, { sections: readonly PolicySection[]; what: HubText; done: HubText }> = {
  lengths: { sections: ['durations', 'customDuration'], what: 'hub.settings.lengths.what', done: 'hub.settings.lengths.done' },
  ladder: { sections: ['ladder'], what: 'hub.settings.ladder.what', done: 'hub.settings.ladder.done' },
  first: { sections: ['firstOffense'], what: 'hub.settings.first.what', done: 'hub.settings.first.done' },
  repeat: { sections: ['repeat'], what: 'hub.settings.repeat.what', done: 'hub.settings.repeat.done' },
  rules: { sections: ['areaRules', 'severeRules'], what: 'hub.settings.rules.what', done: 'hub.settings.rules.done' },
  guidelines: { sections: ['guidelines'], what: 'hub.settings.guidelines.what', done: 'hub.settings.guidelines.done' },
  reporting: { sections: ['reporting'], what: 'hub.reporting.what', done: 'hub.reporting.done' },
  // Everything on the Steps and ladder screen. Reporting has its own screen and its own reset, so this leaves it alone.
  all: { sections: SECTION_ORDER, what: 'hub.settings.reset.all', done: 'hub.settings.reset.all.done' },
};

export interface ResetFlow {
  /** The reset whose question is open, if any. */
  confirming: ResetKey | null;
  error: HubError | null;
  /** Whether there is anything saved to reset. */
  canReset: (key: ResetKey) => boolean;
  open: (key: ResetKey) => void;
  close: (key: ResetKey) => void;
  run: (key: ResetKey, why: string) => Promise<void>;
}

/**
 * Resetting sections to the default. One question at a time. A reset of two sections is two calls: if the second fails after the first
 * went through, the screen still takes the new state for the sections asked (`pending` is kept) and shows the error.
 */
export function useResetFlow({ policy, state, editable, pending, onDone, onClosed }: { policy: UsePolicy; state: PolicyState; editable: boolean; pending: Pending; onDone: (key: ResetKey) => void; onClosed: (key: ResetKey) => void }): ResetFlow {
  const [confirming, setConfirming] = useState<ResetKey | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const saved = Object.keys(state.layer) as PolicySection[];
  const sectionsOf = (key: ResetKey): PolicySection[] => RESETS[key].sections.filter((s) => saved.includes(s));
  const canReset = (key: ResetKey): boolean => sectionsOf(key).length > 0 || (key === 'all' && state.layerError !== undefined);

  const open = (key: ResetKey): void => {
    if (!editable || !canReset(key)) return;
    setError(null);
    setConfirming(key);
  };
  const close = (key: ResetKey): void => {
    setConfirming(null);
    setError(null);
    onClosed(key);
  };
  const run = async (key: ResetKey, why: string): Promise<void> => {
    if (!editable) return;
    // Always the sections this screen knows, by name: what another screen saved after this page loaded is never wiped. The one exception is
    // an unreadable saved layer (`layerError`): there is nothing to name, so one call that names no section clears it whole.
    const sections = key === 'all' && state.layerError !== undefined && sectionsOf(key).length === 0 ? undefined : sectionsOf(key);
    pending.current = sections ?? 'all';
    const res = await policy.reset(sections, why);
    if (!res.ok) {
      // Nothing went through: nothing is coming. Some did: the new state is on its way and the draft takes it for these sections.
      if (res.partial !== true) pending.current = null;
      setError(res.error);
      return;
    }
    setConfirming(null);
    setError(null);
    onDone(key);
  };

  return { confirming, error, canReset, open, close, run };
}
