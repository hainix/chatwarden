import { createContext, useContext, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

// A screen with unsaved edits asks before the hub moves away from it. The hub's `go` (every link, the command bar, a button that
// opens another screen) calls the guard of the screen on show, if it has one: the guard returns true when it took over (it will call
// `proceed` if the moderator decides to leave), and false when the move may go ahead. The question is in the page, never `confirm()`.

/** Returns true when it handled the move (and may call `proceed` later); false to let it go. */
export type LeaveGuard = (proceed: () => void) => boolean;

export type GuardSlot = MutableRefObject<LeaveGuard | null>;

export const LeaveGuardContext = createContext<GuardSlot | null>(null);

/** Registers the guard for as long as the part is on show. Reads the latest `guard` on every move. */
export function useLeaveGuard(guard: LeaveGuard): void {
  const slot = useContext(LeaveGuardContext);
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    if (slot === null) return undefined;
    const mine: LeaveGuard = (proceed) => latest.current(proceed);
    slot.current = mine;
    return () => {
      if (slot.current === mine) slot.current = null;
    };
  }, [slot]);
}
