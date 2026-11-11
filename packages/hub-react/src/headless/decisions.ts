import { toHubError } from '../client.js';
import type { HubClient, HubError } from '../client.js';
import { CLAIM_TTL_MS, actorName } from '../claims.js';
import type { DecisionForm } from '../decision.js';
import type { HubT } from '../i18n.js';
import { nextOpenReport } from '../queue.js';
import type { Claim, DecideInput, DecideResult } from '../types.js';
import type { LiveQueueStore } from './liveQueue.js';
import { createStore } from './store.js';
import type { Store } from './store.js';
import { UNDO_MS } from './toasts.js';
import type { Hold, Toasts } from './toasts.js';

// A decision is not sent the moment Decide is pressed. It is held for UNDO_MS (the Undo toast), then sent. The case leaves the
// queue at once; if the send fails it comes back, with the error and what was typed. Everything about that lives here, above any
// one case, because "Decide and take next" leaves the case (and the form) behind while the decision is still waiting.
//
// Closing the hub sends a held decision at once (the toast store flushes on `pagehide`, when the tab is hidden and on dispose);
// the send always carries `keepalive`, so the page going away does not cancel it.

/** @experimental */
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

/** @experimental */
export interface DecisionEntry {
  reportId: string;
  person: string;
  /** How the reported person is named in a toast. */
  name: string;
  input: DecideInput;
  /** The form as it was when Decide was pressed, to give back on a failure or an Undo. */
  snapshot: DecisionForm;
  /** The person has other open reports: their case stays in the queue, claimed, between the decisions. */
  keepsCase: boolean;
  state: DecisionState;
}

/**
 * True while a decision is held for its Undo window or being sent: it is out of the moderator's hands.
 * @experimental
 */
export const isWaiting = (entry: DecisionEntry | undefined): boolean => entry !== undefined && (entry.state.status === 'held' || entry.state.status === 'sending');

/**
 * True while the case should be off the screen: the decision is waiting, or it was sent in this visit. (An Undo, a failure or a
 * conflict brings the case back.) "Sent" counts only while the case as loaded is still open: a case that is read as closed is a
 * later visit to a decided case, and it is shown whole, with its result.
 * @experimental
 */
export const hasLeft = (entry: DecisionEntry | undefined, reportOpen = true): boolean => isWaiting(entry) || (entry?.state.status === 'done' && reportOpen);

/** @experimental */
export interface SubmitDecision {
  reportId: string;
  person: string;
  name: string;
  input: DecideInput;
  snapshot: DecisionForm;
}

/**
 * How a decision ended. A decision that is held or being sent has not ended: its promise waits.
 * @experimental
 */
export type DecisionOutcome =
  | { status: 'done'; replay: boolean; groups: DecideResult['groups'] }
  /** The server did not take it: the entry keeps the error and what was typed, and `retry` sends it again. */
  | { status: 'failed'; error: HubError }
  /** Someone else decided the report first. */
  | { status: 'conflict' }
  /** Undone during the hold: nothing was sent. */
  | { status: 'undone' };

/** @experimental */
export interface DecideOptions {
  /**
   * The Undo window. `true` (default): 5 seconds. A number: that many milliseconds. `false`: send at once, with no Undo (a script,
   * or a decision someone has already confirmed).
   */
  hold?: boolean | number;
}

/** @experimental */
export interface DecisionStore extends Store<ReadonlyMap<string, DecisionEntry>> {
  /** What is going on with a report's decision, or undefined. */
  entry: (reportId: string) => DecisionEntry | undefined;
  /** True while a decision on this person is held or being sent (so a claim is not released from under it). */
  isPending: (person: string) => boolean;
  /** The reports whose decision is held, being sent or sent (the queue may still list them as open). */
  decidedIds: () => ReadonlySet<string>;
  /** True while a decision on this person is waiting that will let go of the claim itself (their last open report): leaving must not release it first. */
  willRelease: (person: string) => boolean;
  /**
   * Hold a decision for the Undo window and send it after. Answers how it ended. A second submit for the same report while one
   * waits is ignored: it answers what the first answers.
   */
  submit: (decision: SubmitDecision, options?: DecideOptions) => Promise<DecisionOutcome>;
  /** Cancel a held decision. Nothing is sent. */
  undo: (reportId: string) => void;
  /** Send a failed decision again, at once, with the same body. For a report with nothing failed it answers what there is. */
  retry: (reportId: string) => Promise<DecisionOutcome | { status: 'none' }>;
  /** Forget a finished, failed or undone entry (its form has been taken back). */
  dismiss: (reportId: string) => void;
}

/**
 * Where the moderator is looking: the controller's host (the router, in the React hub) tells it.
 * @experimental
 */
export interface DecisionHost {
  /** The report the moderator has open right now, or null. */
  openReport: () => string | null;
  /** Bring them to a report. */
  show: (reportId: string) => void;
}

/** @experimental */
export interface DecisionStoreOptions {
  client: HubClient;
  toasts: Toasts;
  /** The live queue, or null for a role that cannot read reports (there is no queue to keep in step). */
  queue: () => LiveQueueStore | null;
  words: () => HubT;
  host: DecisionHost;
}

const outcomeOf = (state: DecisionState): DecisionOutcome | null => {
  switch (state.status) {
    case 'done':
      return { status: 'done', replay: state.replay, groups: state.groups };
    case 'failed':
      return { status: 'failed', error: state.error };
    case 'conflict':
      return { status: 'conflict' };
    case 'undone':
      return { status: 'undone' };
    default:
      return null;
  }
};

/** @experimental */
export function createDecisionStore(options: DecisionStoreOptions): DecisionStore {
  const { client, toasts, host } = options;
  const store = createStore<ReadonlyMap<string, DecisionEntry>>(new Map());
  // The same map, readable at once (the claim is released on leaving a case and must see a decision that was queued a moment before).
  const live = new Map<string, DecisionEntry>();
  const holds = new Map<string, Hold>();
  // The claim the person held when Decide was pressed. The case looks released at once; Undo or a failure gives it back.
  const claims = new Map<string, Claim | null>();
  const waiters = new Map<string, Array<(outcome: DecisionOutcome) => void>>();

  const put = (entry: DecisionEntry): void => {
    live.set(entry.reportId, entry);
    store.set(new Map(live));
    const outcome = outcomeOf(entry.state);
    if (outcome !== null) {
      const list = waiters.get(entry.reportId) ?? [];
      waiters.delete(entry.reportId);
      for (const resolve of list) resolve(outcome);
    }
  };
  const drop = (reportId: string): void => {
    if (live.delete(reportId)) store.set(new Map(live));
  };
  const stateOf = (entry: DecisionEntry, state: DecisionState): DecisionEntry => {
    const next = { ...entry, state };
    put(next);
    return next;
  };

  /** Resolves with the next ending of the decision on this report. */
  const listen = (reportId: string): Promise<DecisionOutcome> =>
    new Promise((resolve) => {
      waiters.set(reportId, [...(waiters.get(reportId) ?? []), resolve]);
    });
  /** Resolves with how the decision on this report ends (at once when it already has). */
  const wait = (reportId: string): Promise<DecisionOutcome> => {
    const existing = live.get(reportId);
    const done = existing === undefined ? null : outcomeOf(existing.state);
    return done !== null ? Promise.resolve(done) : listen(reportId);
  };

  const isOpen = (reportId: string): boolean => host.openReport() === reportId;

  const decidedIds = (): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const e of live.values()) if (isWaiting(e) || e.state.status === 'done') ids.add(e.reportId);
    return ids;
  };
  const willRelease = (person: string): boolean => {
    for (const e of live.values()) if (e.person === person && isWaiting(e) && !e.keepsCase) return true;
    return false;
  };
  const isPending = (person: string): boolean => {
    for (const e of live.values()) if (e.person === person && isWaiting(e)) return true;
    return false;
  };

  const send = async (start: DecisionEntry): Promise<void> => {
    const words = options.words();
    const queue = options.queue();
    let entry = stateOf(start, { status: 'sending' });
    if (!entry.keepsCase) queue?.setPending(entry.person, true);
    try {
      const result = await client.decide(entry.reportId, entry.input, { keepalive: true });
      entry = stateOf(entry, { status: 'done', replay: result.replay, groups: result.groups });
      toasts.push({ text: words('hub.decide.sent', { who: entry.name }) });
      // The case is closed now: read the queue again so it is gone, and only then let it show (it must not flash back).
      if (queue !== null) await queue.reload();
    } catch (e) {
      const error = toHubError(e);
      if (error.code === 'already_decided') {
        entry = stateOf(entry, { status: 'conflict' });
        toasts.push({ text: words('hub.decide.already'), tone: 'bad' });
        if (queue !== null) await queue.reload();
      } else {
        entry = stateOf(entry, { status: 'failed', error });
        if (error.code === 'claimed' && error.heldBy !== undefined) {
          const until = error.heldUntil ?? 0;
          queue?.patchClaim(entry.person, { by: error.heldBy, since: until - CLAIM_TTL_MS, until });
        } else if (!entry.keepsCase) queue?.patchClaim(entry.person, claims.get(entry.reportId) ?? null);
        // The case is not open any more (the moderator took the next one): say so, with the way back.
        if (!isOpen(entry.reportId)) {
          const text =
            error.code === 'claimed' && error.heldBy !== undefined
              ? words('hub.decide.failedAway.claimed', { who: entry.name, name: actorName(error.heldBy) })
              : words('hub.decide.failedAway', { who: entry.name });
          const reportId = entry.reportId;
          toasts.push({ text, tone: 'bad', action: { label: words('hub.decide.failedAway.open'), run: () => host.show(reportId) } });
        }
      }
    } finally {
      if (!entry.keepsCase) queue?.setPending(entry.person, false);
    }
  };

  const submit = (d: SubmitDecision, options2: DecideOptions = {}): Promise<DecisionOutcome> => {
    const existing = live.get(d.reportId);
    if (isWaiting(existing)) return wait(d.reportId);
    const words = options.words();
    // One case per person: with other reports of theirs open the row stays in the queue, claimed, and the claim is not let go
    // (the server keeps it too); the case leaves the queue only with its last report.
    const queue = options.queue();
    const keepsCase = queue !== null && nextOpenReport(queue.getSnapshot().groups, d.person, d.reportId, decidedIds()) !== null;
    const entry: DecisionEntry = { ...d, keepsCase, state: { status: 'held' } };
    // A new decision starts over: an earlier, finished one must not answer for it.
    live.delete(d.reportId);
    put(entry);
    const outcome = listen(d.reportId);
    if (!keepsCase) {
      queue?.setPending(d.person, true);
      claims.set(d.reportId, queue?.getSnapshot().groups.find((g) => g.person === d.person)?.claim ?? null);
      queue?.patchClaim(d.person, null);
    }
    const hold = options2.hold ?? true;
    if (hold === false) {
      void send(entry);
      return outcome;
    }
    const ms = hold === true ? UNDO_MS : hold;
    holds.set(
      d.reportId,
      toasts.hold({
        text: words('hub.decide.held', { who: d.name, seconds: ms / 1000 }),
        ms,
        run: () => {
          holds.delete(d.reportId);
          const current = live.get(d.reportId);
          if (current !== undefined && current.state.status === 'held') return send(current);
          return undefined;
        },
        onUndo: () => {
          holds.delete(d.reportId);
          const current = live.get(d.reportId);
          if (current === undefined) return;
          stateOf(current, { status: 'undone' });
          if (!keepsCase) {
            const latest = options.queue();
            latest?.setPending(d.person, false);
            latest?.patchClaim(d.person, claims.get(d.reportId) ?? null);
          }
          // Undo brings the case back: if the moderator has gone on to another one, they are taken back to it.
          if (!isOpen(d.reportId)) host.show(d.reportId);
        },
      }),
    );
    return outcome;
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    entry: (id) => live.get(id),
    isPending,
    decidedIds,
    willRelease,
    submit,
    undo: (reportId) => holds.get(reportId)?.undo(),
    async retry(reportId) {
      const entry = live.get(reportId);
      if (entry === undefined) return { status: 'none' };
      if (entry.state.status !== 'failed') return wait(reportId);
      const next = listen(reportId);
      void send(entry);
      return next;
    },
    dismiss: drop,
  };
}
