import { useEffect, useState } from 'react';
import type { HubError } from './client.js';
import { useStore } from './controllerContext.js';
import type { ActionResult } from './headless/env.js';
import { createAction, createPagedList, createResource, freshList } from './headless/resources.js';
import type { Page } from './types.js';

// The three shapes every screen is made of. The logic (the request numbering, the double-submit guard, the paging) is in
// `./headless/resources.ts`; each hook gives one component its own copy of that, and shows it with `useSyncExternalStore`.

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

/**
 * Loads once per `key`, and again on `reload()`. A moderator is reading and typing, so there is no polling: a list that moves
 * under them is worse than a stale one.
 * - Data of a previous key is never shown under a new key.
 * - A slow answer to an old request never overwrites a newer one (each request has a number; only the latest counts).
 * - A failed reload keeps the last good data and sets `error` beside it.
 */
export function useHubData<T>(key: string, load: () => Promise<T>): HubData<T> {
  const [resource] = useState(() => createResource(load, key));
  resource.setLoader(load);
  const state = useStore(resource);

  useEffect(() => {
    resource.start(key);
    return () => {
      // Whatever is still in flight is for a key we are leaving, or for a component that is gone.
      resource.stop();
    };
  }, [key, resource]);

  // On the render where the key has just changed, the state still holds the old key: show nothing until the effect runs.
  const own = state.key === key;
  return {
    data: own ? state.data : undefined,
    error: own ? state.error : null,
    loading: own ? state.loading : true,
    reload: () => resource.start(key),
  };
}

export type { ActionResult };

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
  const [action] = useState(() => createAction(fn));
  action.setFn(fn);
  const state = useStore(action);
  useEffect(() => action.attach(), [action]);
  return { run: action.run, busy: state.busy, error: state.error, clearError: action.clearError };
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
  /** Resolves with how many items it added (0 when there was nothing to load, a page was already loading, or it failed). */
  loadMore: () => Promise<number>;
  /** Start over from the first page (the list stays on screen until it answers). */
  reload: () => void;
}

/**
 * A list read page by page. `key` names the query: a new key starts over. `loadMore` follows `next` and appends; a second call
 * while one is running does nothing; a failed page keeps what is shown and sets `error`, and `loadMore` tries that page again.
 */
export function usePagedList<T>(key: string, load: (cursor: string | undefined) => Promise<Page<T>>): PagedList<T> {
  const [list] = useState(() => createPagedList(load, key));
  list.setLoader(load);
  const state = useStore(list);

  useEffect(() => {
    list.start(key);
    return () => {
      list.stop();
    };
  }, [key, list]);

  const own = state.key === key;
  const current = own ? state : freshList<T>(key);
  return {
    items: current.items,
    next: current.next,
    loading: current.loading,
    loadingMore: current.loadingMore,
    error: current.error,
    loadMore: list.loadMore,
    reload: () => list.start(key),
  };
}
