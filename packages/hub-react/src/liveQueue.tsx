import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useController, useStore } from './controllerContext.js';
import { useRuntime } from './pieceRuntime.js';
import { useHub } from './context.js';
import { QUEUE_MAX_PAGES, QUEUE_PAGE, visibleRows } from './headless/liveQueue.js';
import type { Connection, LiveQueueState, LiveQueueStore } from './headless/liveQueue.js';
import type { QueueGroup } from './queue.js';
import type { Claim } from './types.js';

// The live queue: the open cases, loaded once and then kept fresh in the background. Every part of the hub that shows the queue
// (the queue pane, the team view, the command bar, the case panel) reads this one copy, so the hub asks the server once.
// The loading, the polling and its backoff, the "N new" list and the minute tick are the headless controller's
// (`./headless/liveQueue.ts`); this hands them to the screens.

export { QUEUE_MAX_PAGES, QUEUE_PAGE };
export type { Connection };

/** The queue as a screen reads it: what the controller knows, and what a screen can do about it. */
export interface LiveQueue extends LiveQueueState {
  /** The rows that pass the filters, worked out from the clock at render (a claim that lapsed is not "mine"). */
  visible: LiveQueueState['visible'];
  setFilter: LiveQueueStore['setFilter'];
  /** Put the new cases on screen (this reorders the list: the moderator asked for it). */
  showIncoming: () => void;
  /** Read the queue again now and put it on screen as it is. Answers the open cases it read (the old ones if the read failed). */
  reload: () => Promise<QueueGroup[]>;
  /** Ask now, instead of waiting for the next poll (the banner's "Try now"). */
  retryNow: () => void;
  /** The server told us a claim (or that there is none); show it at once rather than at the next poll. */
  patchClaim: (person: string, claim: Claim | null) => void;
  patchViewing: (person: string, viewers: string[]) => void;
  /** Whether the pointer or keyboard focus is in the list: while it is, a case that closes stays in place, marked. */
  setInteracting: (inside: boolean) => void;
  /** The case that is open in the main pane: its row never disappears under the moderator, even once it closes. */
  setOpenPerson: (person: string | null) => void;
  setPending: (person: string, on: boolean) => void;
  /** After a release the open case must not claim itself again at the next heartbeat. */
  holdOff: (person: string, on: boolean) => void;
  isHeldOff: (person: string) => boolean;
  /** One Take-next guard for the whole hub (button, shortcut, command bar): false while one is running or cooling down. */
  beginTake: () => boolean;
  /** Ends a Take next; the guard stays shut for `cooldownMs` more. */
  endTake: (cooldownMs: number) => void;
}

const QueueContext = createContext<LiveQueue | null>(null);

/** The live queue. Throws outside the provider; use `useOptionalQueue` where the role may not read reports. */
export function useQueue(): LiveQueue {
  const value = useContext(QueueContext);
  if (value === null) throw new Error('useQueue must be used inside <Hub>, for a role that can read reports');
  return value;
}

/** The live queue, or null for a role that cannot read reports (there is no queue to show). */
export function useOptionalQueue(): LiveQueue | null {
  return useContext(QueueContext);
}

/**
 * Hands the queue to the screens below. `run` (the hub's shell) also keeps it loading and polling while mounted; a provider that
 * places pieces leaves that to the pieces that need the queue, so a page with only a Terms screen asks the server for no cases.
 */
export function QueueProvider({ children, run = true }: { children: ReactNode; run?: boolean }) {
  const controller = useController();
  const runtime = useRuntime();
  const { now, me } = useHub();
  const q = controller.queue;
  const state = useStore(q);
  useEffect(() => (run ? runtime.needQueue() : undefined), [runtime, run]);

  // `visible` depends on the clock (a claim lapses without a change token), so it is worked out here, at render, as it always was.
  const nowMs = now();
  const visible = useMemo(() => visibleRows(state.rows, state.filter, state.pending, me.actor, nowMs), [state.rows, state.filter, state.pending, me.actor, nowMs]);

  const value = useMemo<LiveQueue>(
    () => ({
      ...state,
      visible,
      setFilter: q.setFilter,
      showIncoming: q.showIncoming,
      reload: q.reload,
      retryNow: q.retryNow,
      patchClaim: q.patchClaim,
      patchViewing: q.patchViewing,
      setInteracting: q.setInteracting,
      setOpenPerson: q.setOpenPerson,
      setPending: q.setPending,
      holdOff: q.holdOff,
      isHeldOff: q.isHeldOff,
      beginTake: q.beginTake,
      endTake: q.endTake,
    }),
    [state, visible, q],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
