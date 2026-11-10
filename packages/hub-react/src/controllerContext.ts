import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { HubController } from './headless/controller.js';
import type { Store } from './headless/store.js';

// The React side of the headless controller. It sits in its own context rather than in `HubContextValue`, which is a public type
// that adopters build by hand; adding a required member to it would break them.

export const ControllerContext = createContext<HubController | null>(null);

/** The hub's controller. Throws outside a `<Hub>`. */
export function useController(): HubController {
  const value = useContext(ControllerContext);
  if (value === null) throw new Error('This must be used inside <Hub>');
  return value;
}

/** The controller when there is one (a component that also runs on its own). */
export function useOptionalController(): HubController | null {
  return useContext(ControllerContext);
}

/** A store's current value, kept fresh. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * A store's current value, kept fresh the way `useState` would: each change is a batched update, rendered after the code that made
 * it has finished. `useSyncExternalStore` renders at once (a synchronous lane), which is right for a value that must never be
 * stale, but the live queue is loaded in the background and its screens were written around the batched timing: a skeleton is
 * drawn before the first answer, not instead of it.
 */
export function useStoreBatched<T>(store: Store<T>): T {
  const [, setValue] = useState(() => store.getSnapshot());
  useEffect(() => {
    setValue(store.getSnapshot());
    return store.subscribe(() => setValue(store.getSnapshot()));
  }, [store]);
  // The state only schedules the render; what the render reads is the store, so a different store is never shown late.
  return store.getSnapshot();
}
