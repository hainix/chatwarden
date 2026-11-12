import { useCallback, useSyncExternalStore } from 'react';
import { useHub } from '../context.js';

// "Hide the AI on this case": this moderator's choice, for the session (this page, not the server), one entry per moderator and case. It is
// part of the AI's lazy code: with the AI off nothing here is loaded.

const hidden = new Set<string>();
const listeners = new Set<() => void>();
const keyOf = (actor: string, reportId: string): string => `${actor}\n${reportId}`;

/** Forgets every "hide the AI" (tests). */
export function forgetHiddenAi(): void {
  hidden.clear();
  for (const l of [...listeners]) l();
}

/** Whether this moderator hid the AI on this case, and how to hide or show it. */
export function useAiHidden(reportId: string): [boolean, (on: boolean) => void] {
  const { me } = useHub();
  const key = keyOf(me.actor, reportId);
  const on = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => hidden.has(key),
    () => false,
  );
  const set = useCallback(
    (next: boolean): void => {
      if (next) hidden.add(key);
      else hidden.delete(key);
      for (const l of [...listeners]) l();
    },
    [key],
  );
  return [on, set];
}
