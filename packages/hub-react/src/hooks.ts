import { useCallback, useEffect, useRef, useState } from 'react';
import { toHubError } from './client.js';
import type { HubError } from './client.js';
import type { Page } from './types.js';

export interface HubData<T> {
  /** The answer for the current key. Kept through a failed reload; never the answer of another key. */
  data: T | undefined;
  /** The last failure for the current key, or null. */
  error: HubError | null;
  /** True from the start of a load or reload until it answers. */
  loading: boolean;
  /** Ask again for the same key. */
  reload: () => void;
}

interface DataState<T> {
  key: string;
  data: T | undefined;
  error: HubError | null;
  loading: boolean;
}

/**
 * Loads once per `key`, and again on `reload()`. A moderator is reading and typing, so there is no polling: a list that moves
 * under them is worse than a stale one.
 * - Data of a previous key is never shown under a new key.
 * - A slow answer to an old request never overwrites a newer one (each request has a number; only the latest counts).
 * - A failed reload keeps the last good data and sets `error` beside it.
 */
export function useHubData<T>(key: string, load: () => Promise<T>): HubData<T> {
  const [state, setState] = useState<DataState<T>>({ key, data: undefined, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef(0);

  const run = useCallback((forKey: string): void => {
    const mine = ++latest.current;
    setState((s) => ({ key: forKey, data: s.key === forKey ? s.data : undefined, error: s.key === forKey ? s.error : null, loading: true }));
    loadRef.current().then(
      (data) => {
        if (mine === latest.current) setState({ key: forKey, data, error: null, loading: false });
      },
      (e: unknown) => {
        if (mine === latest.current) setState((s) => ({ key: forKey, data: s.key === forKey ? s.data : undefined, error: toHubError(e), loading: false }));
      },
    );
  }, []);

  useEffect(() => {
    run(key);
    return () => {
      // Whatever is still in flight is for a key we are leaving, or for a component that is gone.
      latest.current += 1;
    };
  }, [key, run]);

  // On the render where the key has just changed, the state still holds the old key: show nothing until the effect runs.
  const own = state.key === key;
  return {
    data: own ? state.data : undefined,
    error: own ? state.error : null,
    loading: own ? state.loading : true,
    reload: () => run(key),
  };
}

export type ActionResult<R> = { ok: true; value: R } | { ok: false; error: HubError };

export interface HubAction<A extends unknown[], R> {
  /** Runs the action. Never throws. A call made while one is running returns that run's answer and sends nothing. */
  run: (...args: A) => Promise<ActionResult<R>>;
  busy: boolean;
  error: HubError | null;
  clearError: () => void;
}

/**
 * Runs one write. It is busy while it runs, a double submit sends once (the second call gets the first call's answer),
 * and a failure comes back as `{ ok: false, error }` and stays in `error` until the next run or `clearError()`.
 */
export function useHubAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): HubAction<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inFlight = useRef<Promise<ActionResult<R>> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((...args: A): Promise<ActionResult<R>> => {
    if (inFlight.current !== null) return inFlight.current;
    setBusy(true);
    setError(null);
    const p = (async (): Promise<ActionResult<R>> => {
      try {
        const value = await fnRef.current(...args);
        return { ok: true, value };
      } catch (e) {
        const err = toHubError(e);
        if (mounted.current) setError(err);
        return { ok: false, error: err };
      } finally {
        inFlight.current = null;
        if (mounted.current) setBusy(false);
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { run, busy, error, clearError };
}

export interface PagedList<T> {
  items: T[];
  /** The cursor of the next page, or null when the list has ended. */
  next: string | null;
  /** The first page is loading. */
  loading: boolean;
  /** A later page is loading. */
  loadingMore: boolean;
  error: HubError | null;
  loadMore: () => Promise<void>;
  /** Start over from the first page (the list stays on screen until it answers). */
  reload: () => void;
}

interface PagedState<T> {
  key: string;
  items: T[];
  next: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: HubError | null;
  loaded: boolean;
}

const freshList = <T>(key: string): PagedState<T> => ({ key, items: [], next: null, loading: true, loadingMore: false, error: null, loaded: false });

/**
 * A list read page by page. `key` names the query: a new key starts over. `loadMore` follows `next` and appends; a second call
 * while one is running does nothing; a failed page keeps what is shown and sets `error`, and `loadMore` tries that page again.
 */
export function usePagedList<T>(key: string, load: (cursor: string | undefined) => Promise<Page<T>>): PagedList<T> {
  const [state, setState] = useState<PagedState<T>>(() => freshList<T>(key));
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef(0);
  const more = useRef(false);

  const first = useCallback((forKey: string): void => {
    const mine = ++latest.current;
    more.current = false;
    setState((s) => (s.key === forKey ? { ...s, loading: true, loadingMore: false, error: null } : freshList<T>(forKey)));
    loadRef.current(undefined).then(
      (page) => {
        if (mine === latest.current) setState({ key: forKey, items: page.items, next: page.next, loading: false, loadingMore: false, error: null, loaded: true });
      },
      (e: unknown) => {
        if (mine === latest.current) setState((s) => ({ ...(s.key === forKey ? s : freshList<T>(forKey)), loading: false, error: toHubError(e) }));
      },
    );
  }, []);

  useEffect(() => {
    first(key);
    return () => {
      latest.current += 1;
    };
  }, [key, first]);

  const own = state.key === key;
  const current = own ? state : freshList<T>(key);

  const loadMore = useCallback(async (): Promise<void> => {
    if (more.current || !state.loaded || state.next === null || state.key !== key) return;
    more.current = true;
    const mine = latest.current;
    const cursor = state.next;
    setState((s) => ({ ...s, loadingMore: true, error: null }));
    try {
      const page = await loadRef.current(cursor);
      if (mine === latest.current) setState((s) => ({ ...s, items: [...s.items, ...page.items], next: page.next, loadingMore: false, error: null }));
    } catch (e) {
      if (mine === latest.current) setState((s) => ({ ...s, loadingMore: false, error: toHubError(e) }));
    } finally {
      if (mine === latest.current) more.current = false;
    }
  }, [key, state.key, state.loaded, state.next]);

  return {
    items: current.items,
    next: current.next,
    loading: current.loading,
    loadingMore: current.loadingMore,
    error: current.error,
    loadMore,
    reload: () => first(key),
  };
}
