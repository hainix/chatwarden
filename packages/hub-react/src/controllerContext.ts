import { createContext, useContext, useEffect, useState } from 'react';
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

/**
 * A store's current value, kept fresh the way `useState` would be: each change is a batched update, rendered after the code that
 * made it has finished. `useSyncExternalStore` is the usual bridge, but it renders in a synchronous lane, a task ahead of where
 * these screens have always drawn: a skeleton is drawn before the first answer, not instead of it, and a held decision sent from a
 * `pagehide` handler would render inside the event. Every screen and test was written around the batched timing, so this keeps it.
 * It reads the store at render, so what it returns is never older than the store.
 */
export function useStore<T>(store: Store<T>): T {
  const [, setValue] = useState(() => store.getSnapshot());
  useEffect(() => {
    setValue(store.getSnapshot());
    return store.subscribe(() => setValue(store.getSnapshot()));
  }, [store]);
  // The state only schedules the render; what the render reads is the store, so a different store is never shown late.
  return store.getSnapshot();
}
