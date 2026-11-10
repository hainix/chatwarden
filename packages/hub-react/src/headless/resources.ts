import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import type { Page } from '../types.js';
import type { ActionResult } from './env.js';
import { createStore } from './store.js';
import type { Store } from './store.js';

// The three shapes every screen is made of: read something once per key, do one write, read a list page by page. Each is a Store, so
// any framework can show it; the React hooks `useHubData`, `useHubAction` and `usePagedList` are these, one per component.

// ---- a read ------------------------------------------------------------------------------------------------------------

export interface ResourceState<T> {
  key: string;
  /** The answer for `key`. Kept through a failed reload; never the answer of another key. */
  data: T | undefined;
  /** The last failure for `key`, or null. */
  error: HubError | null;
  /** True from the start of a load or reload until it answers. */
  loading: boolean;
}

export interface ResourceStore<T> extends Store<ResourceState<T>> {
  /** Load for `key`: a different key starts over (and shows nothing of the last one), the same key loads again. */
  start: (key: string) => void;
  /** Ask again for the current key. */
  reload: () => void;
  /** Use another loader from now on, without loading. */
  setLoader: (load: () => Promise<T>) => void;
  /** Abandon whatever is in flight (a key is being left, or the screen is gone). */
  stop: () => void;
}

/**
 * Loads once per key, and again on `reload()`. A moderator is reading and typing, so there is no polling: a list that moves under
 * them is worse than a stale one.
 * - Data of a previous key is never shown under a new key.
 * - A slow answer to an old request never overwrites a newer one (each request has a number; only the latest counts).
 * - A failed reload keeps the last good data and sets `error` beside it.
 */
export function createResource<T>(load: () => Promise<T>, key = ''): ResourceStore<T> {
  let loader = load;
  let latest = 0;
  let current = key;
  const store = createStore<ResourceState<T>>({ key, data: undefined, error: null, loading: true });

  const run = (forKey: string): void => {
    const mine = ++latest;
    current = forKey;
    store.update((s) => ({ key: forKey, data: s.key === forKey ? s.data : undefined, error: s.key === forKey ? s.error : null, loading: true }));
    // `new Promise` so a loader that throws before it returns a promise is a failed load, not a throw.
    new Promise<T>((resolve) => resolve(loader())).then(
      (data) => {
        if (mine === latest) store.set({ key: forKey, data, error: null, loading: false });
      },
      (e: unknown) => {
        if (mine === latest) store.update((s) => ({ key: forKey, data: s.key === forKey ? s.data : undefined, error: toHubError(e), loading: false }));
      },
    );
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    start: run,
    reload: () => run(current),
    setLoader(next) {
      loader = next;
    },
    stop() {
      latest += 1;
    },
  };
}

// ---- a write -----------------------------------------------------------------------------------------------------------

export interface ActionState {
  busy: boolean;
  error: HubError | null;
}

export interface ActionStore<A extends unknown[], R> extends Store<ActionState> {
  /** Runs the action. Never throws. A call made while one is running returns that run's answer and sends nothing. */
  run: (...args: A) => Promise<ActionResult<R>>;
  clearError: () => void;
  /** Use another function from now on. */
  setFn: (fn: (...args: A) => Promise<R>) => void;
  /** The screen is showing this action: it may change what it shows. Returns the function that says it is gone. */
  attach: () => () => void;
}

/**
 * Runs one write. It is busy while it runs, a double submit sends once (the second call gets the first call's answer), and a failure
 * comes back as `{ ok: false, error }` and stays in `error` until the next run or `clearError()`.
 */
export function createAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): ActionStore<A, R> {
  let current = fn;
  let inFlight: Promise<ActionResult<R>> | null = null;
  let attached = true;
  const store = createStore<ActionState>({ busy: false, error: null });

  const run = (...args: A): Promise<ActionResult<R>> => {
    if (inFlight !== null) return inFlight;
    store.set({ busy: true, error: null });
    // `fn` is called now (inside the click), but every continuation below runs later, after `inFlight` is set. An async IIFE
    // would run its `finally` at once when `fn` throws before returning a promise, and the guard would then point at a
    // settled promise for good.
    const finish = (result: ActionResult<R>): ActionResult<R> => {
      inFlight = null;
      if (attached) store.set({ busy: false, error: result.ok ? null : result.error });
      return result;
    };
    const p: Promise<ActionResult<R>> = new Promise<R>((resolve) => resolve(current(...args))).then(
      (value) => finish({ ok: true, value }),
      (e: unknown) => finish({ ok: false, error: toHubError(e) }),
    );
    inFlight = p;
    return p;
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    run,
    clearError: () => store.update((s) => (s.error === null ? s : { ...s, error: null })),
    setFn(next) {
      current = next;
    },
    attach() {
      attached = true;
      return () => {
        attached = false;
      };
    },
  };
}

// ---- a list read page by page -----------------------------------------------------------------------------------------------

export interface PagedState<T> {
  key: string;
  items: T[];
  /** The cursor of the next page, or null when the list has ended. */
  next: string | null;
  /** The first page is loading. */
  loading: boolean;
  /** A later page is loading. */
  loadingMore: boolean;
  error: HubError | null;
  loaded: boolean;
}

export interface PagedListStore<T> extends Store<PagedState<T>> {
  /** Load the first page for `key`; a different key starts over. */
  start: (key: string) => void;
  /** Start over from the first page (the list stays on screen until it answers). */
  reload: () => void;
  /** Resolves with how many items it added (0 when there was nothing to load, a page was already loading, or it failed). */
  loadMore: () => Promise<number>;
  setLoader: (load: (cursor: string | undefined) => Promise<Page<T>>) => void;
  stop: () => void;
}

export const freshList = <T>(key: string): PagedState<T> => ({ key, items: [], next: null, loading: true, loadingMore: false, error: null, loaded: false });

/**
 * A list read page by page. `key` names the query: a new key starts over. `loadMore` follows `next` and appends; a second call
 * while one is running does nothing; a failed page keeps what is shown and sets `error`, and `loadMore` tries that page again.
 */
export function createPagedList<T>(load: (cursor: string | undefined) => Promise<Page<T>>, key = ''): PagedListStore<T> {
  let loader = load;
  let latest = 0;
  let more = false;
  let current = key;
  const store = createStore<PagedState<T>>(freshList<T>(key));

  const first = (forKey: string): void => {
    const mine = ++latest;
    current = forKey;
    more = false;
    store.update((s) => (s.key === forKey ? { ...s, loading: true, loadingMore: false, error: null } : freshList<T>(forKey)));
    new Promise<Page<T>>((resolve) => resolve(loader(undefined))).then(
      (page) => {
        if (mine === latest) store.set({ key: forKey, items: page.items, next: page.next, loading: false, loadingMore: false, error: null, loaded: true });
      },
      (e: unknown) => {
        if (mine === latest) store.update((s) => ({ ...(s.key === forKey ? s : freshList<T>(forKey)), loading: false, error: toHubError(e) }));
      },
    );
  };

  const loadMore = async (): Promise<number> => {
    const state = store.getSnapshot();
    if (more || !state.loaded || state.next === null || state.key !== current) return 0;
    more = true;
    const mine = latest;
    const cursor = state.next;
    store.update((s) => ({ ...s, loadingMore: true, error: null }));
    try {
      const page = await loader(cursor);
      if (mine !== latest) return 0;
      store.update((s) => ({ ...s, items: [...s.items, ...page.items], next: page.next, loadingMore: false, error: null }));
      return page.items.length;
    } catch (e) {
      if (mine === latest) store.update((s) => ({ ...s, loadingMore: false, error: toHubError(e) }));
      return 0;
    } finally {
      if (mine === latest) more = false;
    }
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    start: first,
    reload: () => first(current),
    loadMore,
    setLoader(next) {
      loader = next;
    },
    stop() {
      latest += 1;
    },
  };
}
