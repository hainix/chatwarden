import { createContext, useContext } from 'react';
import type { RefObject } from 'react';

// Where a part listens for keys. In the hub's shell, the whole page: the keys work wherever focus is. A piece placed in somebody
// else's page listens on its own root only, so two cards on one page never both answer one key press, and a key pressed in the
// adopter's own code is never taken.

/** The element a piece's keys are scoped to; null in the shell, which listens on the page. */
export const KeyScope = createContext<RefObject<HTMLElement | null> | null>(null);

/** Start listening for keys where this part lives. Returns what stops it; does nothing when the scope has no element yet. */
export function useKeyListener(): (onKeyDown: (e: KeyboardEvent) => void) => () => void {
  const scope = useContext(KeyScope);
  return (onKeyDown) => {
    const target: EventTarget | null = scope === null ? document : scope.current;
    if (target === null) return () => undefined;
    const listener = onKeyDown as EventListener;
    target.addEventListener('keydown', listener);
    return () => target.removeEventListener('keydown', listener);
  };
}
