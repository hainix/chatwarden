import { useCallback, useSyncExternalStore } from 'react';
import type { HubMode } from './mode.js';
import { useMode } from './mode.js';

// "Quick keys": whether 1, 2 and 3 act at once on the open case (and J, K and the arrow keys open the case they move to), or only
// choose. A per-moderator choice kept in this browser, like the mode. Simple already acted on its digits, so it defaults to on;
// Detailed's digits choose a verdict, so it defaults to off and turning it on is the moderator's own decision. A browser that will
// not remember (private window, blocked storage) still switches for the visit: every storage access is guarded.

/** Where the choice is kept: `'on'` or `'off'`. */
export const QUICK_KEYS_KEY = 'chatwarden.hub.quickKeys';

/** The default for a mode: on in Simple, off in Detailed. */
export const quickKeysDefault = (mode: HubMode): boolean => mode === 'simple';

/** The remembered choice, or the mode's default when nothing is kept, the value is not `on` or `off`, or storage cannot be read. */
export function readQuickKeys(mode: HubMode): boolean {
  try {
    const kept = window.localStorage.getItem(QUICK_KEYS_KEY);
    if (kept === 'on') return true;
    if (kept === 'off') return false;
  } catch {
    // Storage is blocked: the default stands.
  }
  return quickKeysDefault(mode);
}

// The choice of this visit, for a browser that will not keep it; and the listeners that hear a change.
let visit: boolean | null = null;
const listeners = new Set<() => void>();
const tell = (): void => {
  for (const l of [...listeners]) l();
};

/** Remembers a choice (and keeps it for this visit if the browser refuses). */
export function writeQuickKeys(on: boolean): void {
  visit = on;
  try {
    window.localStorage.setItem(QUICK_KEYS_KEY, on ? 'on' : 'off');
  } catch {
    // Storage is blocked or full: the switch still works for this visit.
  }
  tell();
}

/** Forgets this visit's choice (tests). */
export function resetQuickKeysVisit(): void {
  visit = null;
  tell();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (e: StorageEvent): void => {
    if (e.key === QUICK_KEYS_KEY || e.key === null) {
      visit = null;
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

/**
 * Quick keys for the hub's mode: the visit's choice, else the remembered one, else the mode's default. A part that is one mode's own
 * (the Simple card, wherever it is drawn: in the hub or as a piece) says which with `as`.
 */
export function useQuickKeys(as?: HubMode): { on: boolean; set: (on: boolean) => void } {
  const context = useMode().mode;
  const mode = as ?? context;
  const on = useSyncExternalStore(
    subscribe,
    () => visit ?? readQuickKeys(mode),
    () => quickKeysDefault(mode),
  );
  const set = useCallback((next: boolean): void => writeQuickKeys(next), []);
  return { on, set };
}
