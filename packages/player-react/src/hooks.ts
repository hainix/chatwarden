import { useCallback, useEffect, useRef, useState } from 'react';
import { PlayerError, toPlayerError } from './client.js';

export interface PlayerData<T> {
  /** The last answer, kept when a later load fails. */
  data: T | undefined;
  /** The last failure, or null. Cleared when a load starts. */
  error: PlayerError | null;
  /** Starts the same load again. */
  reload: () => void;
}

/**
 * Runs `load` on mount, again when `refreshKey` changes, and again on `reload()`. An answer from a load that has been replaced
 * (or from a component that is gone) is dropped, so a slow old request never overwrites a newer one.
 */
export function usePlayerData<T>(load: () => Promise<T>, refreshKey: unknown): PlayerData<T> {
  const [state, setState] = useState<{ data: T | undefined; error: PlayerError | null }>({ data: undefined, error: null });
  const [again, setAgain] = useState(0);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    let live = true;
    setState((s) => (s.error === null ? s : { ...s, error: null }));
    loader.current().then(
      (data) => {
        if (live) setState({ data, error: null });
      },
      (e: unknown) => {
        if (live) setState((s) => ({ data: s.data, error: toPlayerError(e) }));
      },
    );
    return () => {
      live = false;
    };
  }, [refreshKey, again]);

  const reload = useCallback(() => setAgain((n) => n + 1), []);
  return { data: state.data, error: state.error, reload };
}
