import { createContext, useContext, useSyncExternalStore } from 'react';
import type { HubController } from './headless/controller.js';
import type { Store } from './headless/store.js';

// The React side of the headless controller. It sits in its own context rather than in `HubContextValue`, which is a public type
// that adopters build by hand; adding a required member to it would break them.

export const ControllerContext = createContext<HubController | null>(null);

/** The hub's controller. Throws outside a `<Hub>` or `<HubProvider>`. */
export function useController(): HubController {
  const value = useContext(ControllerContext);
  if (value === null) throw new Error('This must be used inside <HubProvider> (or <Hub>)');
  return value;
}

/** The controller when there is one (a component that also runs on its own). */
export function useOptionalController(): HubController | null {
  return useContext(ControllerContext);
}

/**
 * A store's current value, kept fresh with `useSyncExternalStore`: every change renders at once, no update is missed between the
 * render and the subscription, and a render under a transition or Suspense never shows two readers two different snapshots.
 * A snapshot is the same object until something changes (the stores promise that), so an unchanged store renders nothing.
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
