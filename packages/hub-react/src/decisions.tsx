import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useController, useStore } from './controllerContext.js';
import { hasLeft, isWaiting } from './headless/decisions.js';
import type { DecideOptions, DecisionEntry, DecisionState, DismissOpenOutcome, DismissOpenRequest, SubmitDecision } from './headless/decisions.js';
import type { DismissOpenInput, DismissOpenResult } from './types.js';

// A decision is not sent the moment Decide is pressed. It is held for UNDO_MS (the Undo toast), then sent. The case leaves the
// queue at once; if the send fails it comes back, with the error and what was typed. The hold, the send and the rules around them are
// the headless controller's (`./headless/decisions.ts`); this hands them to the screens. They live above any one case, because
// "Decide and take next" leaves the case (and the form) behind while the decision is still waiting.

export { hasLeft, isWaiting };
export type { DecisionEntry, DecisionState, DismissOpenOutcome, DismissOpenRequest, SubmitDecision };

export interface Decisions {
  /** What is going on with a report's decision, or undefined. */
  entry: (reportId: string) => DecisionEntry | undefined;
  /** True while a decision on this person is held or being sent (so a claim is not released from under it). */
  isPending: (person: string) => boolean;
  /** The reports whose decision is held, being sent or sent (the queue may still list them as open). */
  decidedIds: () => ReadonlySet<string>;
  /** True while a decision on this person is waiting that will let go of the claim itself (their last open report): leaving must not release it first. */
  willRelease: (person: string) => boolean;
  /** Hold a decision for the Undo window and send it after. A second submit for the same report while one waits is ignored. */
  submit: (decision: SubmitDecision) => void;
  /** Cancel a held decision. Nothing is sent. */
  undo: (reportId: string) => void;
  /** Send a failed decision again, at once, with the same body. */
  retry: (reportId: string) => void;
  /** Forget a finished, failed or undone entry (its form has been taken back). */
  dismiss: (reportId: string) => void;
  /** A decision or sweep is in its Undo window now (so Undo has something to take back). */
  canUndo: boolean;
  /** Undo the newest decision or sweep still in its Undo window and answer the report to show again, or null when nothing is waiting. */
  undoLatest: () => string | null;
  /** Dismiss all open reports about a person or from a reporter: held for the Undo window, then sent once. Answers how it ended. */
  dismissOpen: (request: DismissOpenRequest, options?: DecideOptions) => Promise<DismissOpenOutcome>;
  /** A dry run of a sweep: the counts, with nothing held or changed. Rejects with a `HubError`. */
  previewDismiss: (scope: DismissOpenInput['scope'], ref: string) => Promise<DismissOpenResult>;
}

const DecisionContext = createContext<Decisions | null>(null);

/** The decisions in flight. Throws outside a `<Hub>`. */
export function useDecisions(): Decisions {
  const value = useContext(DecisionContext);
  if (value === null) throw new Error('useDecisions must be used inside <Hub>');
  return value;
}

/** Same, for code that also runs where there is no decision to make (a role that cannot read reports). */
export function useOptionalDecisions(): Decisions | null {
  return useContext(DecisionContext);
}

export function DecisionProvider({ children }: { children: ReactNode }) {
  const d = useController().decisions;
  const entries = useStore(d);
  const value = useMemo<Decisions>(
    () => ({
      entry: (id) => entries.get(id),
      isPending: d.isPending,
      decidedIds: d.decidedIds,
      willRelease: d.willRelease,
      submit: (decision) => void d.submit(decision),
      undo: d.undo,
      retry: (id) => void d.retry(id),
      dismiss: d.dismiss,
      canUndo: [...entries.values()].some((e) => e.state.status === 'held'),
      undoLatest: d.undoLatest,
      dismissOpen: d.dismissOpen,
      previewDismiss: d.previewDismiss,
    }),
    [entries, d],
  );
  return <DecisionContext.Provider value={value}>{children}</DecisionContext.Provider>;
}
