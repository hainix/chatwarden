import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toHubError } from './client.js';
import type { HubError } from './client.js';
import { CLAIM_TTL_MS, actorName } from './claims.js';
import { useHub } from './context.js';
import type { DecisionForm } from './decision.js';
import { useOptionalQueue } from './liveQueue.js';
import { parseRoute } from './router.js';
import { UNDO_MS, useToasts } from './toasts.js';
import type { Hold } from './toasts.js';
import type { Claim, DecideInput, DecideResult } from './types.js';

// A decision is not sent the moment Decide is pressed. It is held for UNDO_MS (the Undo toast), then sent. The case leaves the
// queue at once; if the send fails it comes back, with the error and what was typed. Everything about that lives here, above any
// one case, because "Decide and take next" leaves the case (and the form) behind while the decision is still waiting.
//
// Closing the hub sends a held decision at once (the toast host flushes on `pagehide`, when the tab is hidden and on unmount);
// the send always carries `keepalive`, so the page going away does not cancel it.

export type DecisionState =
  /** In its Undo window: nothing has been sent. */
  | { status: 'held' }
  | { status: 'sending' }
  | { status: 'done'; replay: boolean; groups: DecideResult['groups'] }
  /** The server did not take it. The form comes back with this error. */
  | { status: 'failed'; error: HubError }
  /** Someone else decided the report first. */
  | { status: 'conflict' }
  /** Undone: nothing was sent, and the case comes back as it was. */
  | { status: 'undone' };

export interface DecisionEntry {
  reportId: string;
  person: string;
  /** How the reported person is named in a toast. */
  name: string;
  input: DecideInput;
  /** The form as it was when Decide was pressed, to give back on a failure or an Undo. */
  snapshot: DecisionForm;
  state: DecisionState;
}

/** True while a decision is held for its Undo window or being sent: it is out of the moderator's hands. */
export const isWaiting = (entry: DecisionEntry | undefined): boolean => entry !== undefined && (entry.state.status === 'held' || entry.state.status === 'sending');

/** True while the case should be off the screen: waiting, or sent. (An Undo, a failure or a conflict brings it back.) */
export const hasLeft = (entry: DecisionEntry | undefined): boolean => isWaiting(entry) || entry?.state.status === 'done';

export interface SubmitDecision {
  reportId: string;
  person: string;
  name: string;
  input: DecideInput;
  snapshot: DecisionForm;
}

export interface Decisions {
  /** What is going on with a report's decision, or undefined. */
  entry: (reportId: string) => DecisionEntry | undefined;
  /** True while a decision on this person is held or being sent (so a claim is not released from under it). */
  isPending: (person: string) => boolean;
  /** Hold a decision for the Undo window and send it after. A second submit for the same report while one waits is ignored. */
  submit: (decision: SubmitDecision) => void;
  /** Cancel a held decision. Nothing is sent. */
  undo: (reportId: string) => void;
  /** Send a failed decision again, at once, with the same body. */
  retry: (reportId: string) => void;
  /** Forget a finished, failed or undone entry (its form has been taken back). */
  dismiss: (reportId: string) => void;
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
  const { client, t, router, go } = useHub();
  const queue = useOptionalQueue();
  const toasts = useToasts();
  const [entries, setEntries] = useState<ReadonlyMap<string, DecisionEntry>>(() => new Map());
  // The same map, readable at once (the claim is released on leaving a case, in an effect cleanup, and must see a decision that
  // was queued a moment before).
  const live = useRef(new Map<string, DecisionEntry>());
  const holds = useRef(new Map<string, Hold>());

  const latest = useRef({ client, t, queue, toasts, router, go });
  latest.current = { client, t, queue, toasts, router, go };
  // The claim the person held when Decide was pressed. The case looks released at once; Undo or a failure gives it back.
  const claims = useRef(new Map<string, Claim | null>());

  const put = useCallback((entry: DecisionEntry): void => {
    live.current.set(entry.reportId, entry);
    setEntries(new Map(live.current));
  }, []);
  const drop = useCallback((reportId: string): void => {
    if (live.current.delete(reportId)) setEntries(new Map(live.current));
  }, []);
  const stateOf = useCallback(
    (entry: DecisionEntry, state: DecisionState): DecisionEntry => {
      const next = { ...entry, state };
      put(next);
      return next;
    },
    [put],
  );

  /** Whether the person is looking at this report right now. */
  const isOpen = useCallback((reportId: string): boolean => {
    const route = parseRoute(latest.current.router.path);
    return route.name === 'report' && route.id === reportId;
  }, []);

  const send = useCallback(
    async (start: DecisionEntry): Promise<void> => {
      const { client: c, queue: q, toasts: tt, t: words } = latest.current;
      let entry = stateOf(start, { status: 'sending' });
      q?.setPending(entry.person, true);
      try {
        const result = await c.decide(entry.reportId, entry.input, { keepalive: true });
        entry = stateOf(entry, { status: 'done', replay: result.replay, groups: result.groups });
        tt.push({ text: words('hub.decide.sent', { who: entry.name }) });
        // The case is closed now: read the queue again so it is gone, and only then let it show (it must not flash back).
        if (q !== null) await q.reload();
      } catch (e) {
        const error = toHubError(e);
        if (error.code === 'already_decided') {
          entry = stateOf(entry, { status: 'conflict' });
          tt.push({ text: words('hub.decide.already'), tone: 'bad' });
          if (q !== null) await q.reload();
        } else {
          entry = stateOf(entry, { status: 'failed', error });
          if (error.code === 'claimed' && error.heldBy !== undefined) {
            const until = error.heldUntil ?? 0;
            q?.patchClaim(entry.person, { by: error.heldBy, since: until - CLAIM_TTL_MS, until });
          } else q?.patchClaim(entry.person, claims.current.get(entry.reportId) ?? null);
          // The case is not open any more (the moderator took the next one): say so, with the way back.
          if (!isOpen(entry.reportId)) {
            const text = error.code === 'claimed' && error.heldBy !== undefined ? words('hub.decide.failedAway.claimed', { who: entry.name, name: actorName(error.heldBy) }) : words('hub.decide.failedAway', { who: entry.name });
            const reportId = entry.reportId;
            tt.push({ text, tone: 'bad', action: { label: words('hub.decide.failedAway.open'), run: () => latest.current.go({ name: 'report', id: reportId }) } });
          }
        }
      } finally {
        q?.setPending(entry.person, false);
      }
    },
    [isOpen, stateOf],
  );

  const submit = useCallback(
    (d: SubmitDecision): void => {
      const existing = live.current.get(d.reportId);
      if (isWaiting(existing)) return;
      const entry: DecisionEntry = { ...d, state: { status: 'held' } };
      put(entry);
      const { queue: q, toasts: tt, t: words } = latest.current;
      q?.setPending(d.person, true);
      claims.current.set(d.reportId, q?.groups.find((g) => g.person === d.person)?.claim ?? null);
      q?.patchClaim(d.person, null);
      const hold = tt.hold({
        text: words('hub.decide.held', { who: d.name, seconds: UNDO_MS / 1000 }),
        run: () => {
          holds.current.delete(d.reportId);
          const current = live.current.get(d.reportId);
          if (current !== undefined && current.state.status === 'held') return send(current);
          return undefined;
        },
        onUndo: () => {
          holds.current.delete(d.reportId);
          const current = live.current.get(d.reportId);
          if (current === undefined) return;
          stateOf(current, { status: 'undone' });
          latest.current.queue?.setPending(d.person, false);
          latest.current.queue?.patchClaim(d.person, claims.current.get(d.reportId) ?? null);
          // Undo brings the case back: if the moderator has gone on to another one, they are taken back to it.
          if (!isOpen(d.reportId)) latest.current.go({ name: 'report', id: d.reportId });
        },
      });
      holds.current.set(d.reportId, hold);
    },
    [isOpen, put, send, stateOf],
  );

  const undo = useCallback((reportId: string): void => {
    holds.current.get(reportId)?.undo();
  }, []);

  const retry = useCallback(
    (reportId: string): void => {
      const entry = live.current.get(reportId);
      if (entry !== undefined && entry.state.status === 'failed') void send(entry);
    },
    [send],
  );

  const isPending = useCallback((person: string): boolean => {
    for (const e of live.current.values()) if (e.person === person && isWaiting(e)) return true;
    return false;
  }, []);

  // A held decision that never got its window to end (the hub unmounted) is sent by the toast host's own cleanup; nothing to do.
  useEffect(() => () => holds.current.clear(), []);

  const value = useMemo<Decisions>(
    () => ({ entry: (id) => entries.get(id), isPending, submit, undo, retry, dismiss: drop }),
    [entries, isPending, submit, undo, retry, drop],
  );
  return <DecisionContext.Provider value={value}>{children}</DecisionContext.Provider>;
}
