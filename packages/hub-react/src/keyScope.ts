import { createContext, useContext, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

// Where a part listens for keys: on the element it lives in, never on the page. A hub answers a key only when focus is inside it, so
// two hubs on one page never both answer one key press, a key pressed in the adopter's own code is never taken, and a hub inside a
// shadow root hears its own keys with the real target (not the host the page would see). In the shell the element is the hub's
// root; a piece placed in somebody else's page has its own.
//
// The root element takes React's own `onKeyDown` and passes each key to the parts that asked to hear it, rather than every part
// adding a native listener. React gives a key press the urgency of a key press wherever it happens; a native listener inside a shadow
// root does not (the browser hides `window.event` there), so a window opened by a key would take its focus a frame late.

export type KeyHandler = (e: KeyboardEvent) => void;

/** What a root element hands its parts: a way to hear the keys pressed inside it. */
export interface KeyBus {
  add(handler: KeyHandler): () => void;
}

/** The keys of the nearest hub root or piece root above; null outside both. */
export const KeyScope = createContext<KeyBus | null>(null);

/** Make the bus for one root element. Put `onKeyDown` on that element and provide `bus` to what is inside it. */
export function useKeyBus(): { bus: KeyBus; onKeyDown: (e: ReactKeyboardEvent) => void } {
  return useMemo(() => {
    const handlers = new Set<KeyHandler>();
    return {
      bus: {
        add: (handler) => {
          handlers.add(handler);
          return () => void handlers.delete(handler);
        },
      },
      onKeyDown: (e) => {
        for (const handler of [...handlers]) handler(e.nativeEvent);
      },
    };
  }, []);
}

/**
 * Start hearing the keys pressed where this part lives. Returns what stops it; does nothing when there is no root above (which only
 * a part used outside the hub and the pieces would have).
 */
export function useKeyListener(): (onKeyDown: KeyHandler) => () => void {
  const bus = useContext(KeyScope);
  return (onKeyDown) => (bus === null ? () => undefined : bus.add(onKeyDown));
}
