import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';

// Simple or Detailed. Simple is the default: one card per case, one click to apply the suggestion. Detailed is the full workbench.
// Where the choice comes from: the adopter's `mode` prop (which also hides the switch), else what this moderator chose last time
// (kept in this browser), else Simple. A browser that will not remember (private window, blocked storage) still switches for the
// visit: every storage access is guarded.

export type HubMode = 'simple' | 'detailed';

/** Where a moderator's choice is kept. */
export const MODE_KEY = 'chatwarden.hub.mode';
export const DEFAULT_MODE: HubMode = 'simple';

const isMode = (v: unknown): v is HubMode => v === 'simple' || v === 'detailed';

/** The remembered mode, or the default when nothing is kept, the value is not a mode, or storage cannot be read. */
export function readMode(): HubMode {
  try {
    const kept = window.localStorage.getItem(MODE_KEY);
    return isMode(kept) ? kept : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/** Remembers a mode. A browser that refuses is not an error: the choice then lasts for this visit only. */
export function writeMode(mode: HubMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage is blocked or full: the switch still works for this visit.
  }
}

export interface ModeValue {
  mode: HubMode;
  setMode: (mode: HubMode) => void;
  /** The adopter fixed the mode: there is no switch. */
  fixed: boolean;
}

// Outside a hub (a part shown on its own) nothing is Simple: the parts that change with the mode keep their detailed look.
const ModeContext = createContext<ModeValue>({ mode: 'detailed', setMode: () => undefined, fixed: true });

export const ModeProvider = ModeContext.Provider;

/** Which mode the hub is in, and how to change it. */
export function useMode(): ModeValue {
  return useContext(ModeContext);
}

const noopSubscribe = (): (() => void) => () => undefined;

/** The hub's mode: the prop, else this visit's choice, else the remembered one, else Simple. */
export function useModeState(prop: HubMode | undefined): ModeValue {
  // The server and the first client render agree on the default; the remembered choice follows at once on the client.
  const remembered = useSyncExternalStore(noopSubscribe, readMode, () => DEFAULT_MODE);
  const [chosen, setChosen] = useState<HubMode | null>(null);
  const fixed = prop !== undefined;
  const setMode = useCallback((next: HubMode): void => {
    setChosen(next);
    writeMode(next);
  }, []);
  const mode = prop ?? chosen ?? remembered;
  return useMemo(() => ({ mode, setMode, fixed }), [mode, setMode, fixed]);
}
