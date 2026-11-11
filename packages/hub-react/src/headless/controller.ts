import { toHubError } from '../client.js';
import type { HubClient } from '../client.js';
import { createT, en } from '../i18n.js';
import type { HubT } from '../i18n.js';
import { emptyForm } from '../decision.js';
import type { DecisionForm } from '../decision.js';
import { personTag } from '../format.js';
import type { Claim, DecideInput, Me } from '../types.js';
import { createDecisionStore } from './decisions.js';
import type { DecideOptions, DecisionOutcome, DecisionStore } from './decisions.js';
import { createCaseStore } from './cases.js';
import type { ContinueOutcome, OpenCase, TakeOutcome } from './cases.js';
import { browserPage, browserTimers } from './env.js';
import type { ActionResult, PageSource, Timers } from './env.js';
import { createLiveQueue } from './liveQueue.js';
import type { LiveQueueStore } from './liveQueue.js';
import { createSession } from './session.js';
import type { Session } from './session.js';
import { createStore } from './store.js';
import type { Store } from './store.js';
import { createToastStore } from './toasts.js';
import type { ToastStore } from './toasts.js';

export interface HubControllerOptions {
  /** The staff client: `createHubClient(fetchTransport({ baseUrl: '/admin' }))`. */
  client: HubClient;
  /** The hub's clock (claims, "updated at"). Default `Date.now`. */
  now?: () => number;
  /** The timers, and the clock that measures them. Default: the runtime's own (`setTimeout`, ...). Any member may be replaced. */
  schedule?: Partial<Timers>;
  /** What the page is doing: visible or hidden, online, going away. Default: the browser's; outside a browser, always visible and online. */
  page?: Partial<PageSource>;
  /** The words for toasts. Default: English. */
  t?: HubT;
  /**
   * Where the moderator is looking, and how to bring them somewhere: a host with a router says so here.
   * @experimental
   */
  host?: HubHost;
}

/**
 * What the controller asks of the host it runs in. Both are optional: without them the open case (see `open`) is "what the
 * moderator is looking at", and bringing them to a report does nothing (the controller never navigates by itself).
 * @experimental
 */
export interface HubHost {
  /** The report the moderator has open right now, or null. Asked when a decision fails or is undone, to know whether they have moved on. */
  openReport?: () => string | null;
  /** Bring the moderator to a report: Undo of a case they left, "Open the case" on a failed decision, a case taken by Take next. */
  show?: (reportId: string) => void;
}

/**
 * What a host may change after the controller is made.
 * @experimental
 */
export interface HubControllerSettings {
  t?: HubT;
}

/** A decision to make. `name` is how the reported person is named in a toast (default their short tag); `snapshot` the form to give back on a failure. */
export interface DecideCommand {
  reportId: string;
  person: string;
  input: DecideInput;
  name?: string;
  snapshot?: DecisionForm;
}

/** How `start()` went, with what lets go of the hold it took on the queue (a no-op when there is none). */
export type StartResult = ActionResult<Me> & { release: () => void };

export interface HubController {
  readonly client: HubClient;
  readonly session: Session;
  readonly toasts: ToastStore;
  readonly queue: LiveQueueStore;
  readonly decisions: DecisionStore;
  /** The case the moderator has open (see `open`), or null. */
  readonly opened: Store<OpenCase | null>;
  /** Who is signed in: null until `start()` or `identify()`. */
  readonly me: Store<Me | null>;
  /** Say who is signed in, when the host has already asked `GET /me` itself. Starts nothing. */
  identify(me: Me): void;
  /**
   * Asks `GET /me` (unless `identify` was called) and, for a role that can read reports, starts the live queue and waits for its first
   * read, so `queue.getSnapshot()` has the cases (or the error) when this resolves. The answer is `{ ok, value | error }` as before, and
   * carries `release`: the start is a hold on the queue, which runs while any hold is unreleased (see `queue.acquire`), so the pieces of
   * a `HubProvider` that share this controller never stop what you started. Ignore `release` and it runs until `dispose()`.
   */
  start(): Promise<StartResult>;
  /**
   * Open a case: the moderator becomes its handler if nobody is, the claim and the "viewing" hint are renewed while the tab is
   * visible, and its row stays in the queue. Opening another case leaves this one. Resolves once the first claim has answered.
   */
  open(reportId: string): Promise<void>;
  /** Leave the open case (or the given one, if it is the open one). Its claim is let go unless a decision on it is waiting, or the claim is not yours. */
  leave(reportId?: string): void;
  /** Claim and open the oldest unclaimed case that matches the queue's category filter. Never throws; says how it went. */
  takeNext(): Promise<TakeOutcome>;
  /** After a decision: the same person's next open report (the claim is kept), else Take next. */
  continueFrom(decided: { reportId: string; person: string }): Promise<ContinueOutcome>;
  /** Claim a free case. */
  claim(person: string): Promise<ActionResult<Claim>>;
  /** A senior or owner moving another moderator's live claim to themselves. */
  takeOver(person: string): Promise<ActionResult<{ claim: Claim; tookOverFrom: string | null }>>;
  /** Release your claim on a case; the toast offers Undo, which claims it again. */
  release(person: string): Promise<ActionResult<{ released: boolean }>>;
  /**
   * Decide a report. It is held for the Undo window (5 s unless `hold` says otherwise), then sent; the case leaves the queue at once and
   * comes back if the send fails. The promise answers how it ended and never rejects for a 409, a 404 or a dropped connection.
   */
  decide(command: DecideCommand, options?: DecideOptions): Promise<DecisionOutcome>;
  /** Cancel a held decision: nothing is sent, and the case comes back. A no-op once it is on its way. */
  undo(reportId: string): void;
  /** Send a failed decision again, at once, with the same body. */
  retry(reportId: string): Promise<DecisionOutcome | { status: 'none' }>;
  /** Forget a finished, failed or undone decision (its form has been taken back). */
  dismiss(reportId: string): void;
  /**
   * Tell the controller what the host has changed since it was made: the words.
   * @experimental
   */
  configure(patch: HubControllerSettings): void;
  /** True once `dispose()` has run. */
  readonly disposed: boolean;
  /** Stops every timer and listener, and sends a held decision at once, as closing the hub does. Safe to call twice. */
  dispose(): void;
}

export function createHubController(options: HubControllerOptions): HubController {
  const { client } = options;
  const timers: Timers = { ...browserTimers, ...options.schedule };
  const page: PageSource = { ...browserPage, ...options.page };
  const now = options.now ?? Date.now;
  let words: HubT = options.t ?? createT(en, 'en');
  let disposed = false;

  const me = createStore<Me | null>(null);
  const toasts = createToastStore({ words: () => words, timers, page });
  const session = createSession(client, now);
  const queue = createLiveQueue({ client, now, timers, page, toasts, words: () => words, actor: () => me.getSnapshot()?.actor ?? '' });

  const host = options.host ?? {};
  /** One answer to "can this role read reports": yes until we know who is signed in, then what the server's permission table says. */
  const canRead = (who: Me | null = me.getSnapshot()): boolean => who === null || who.can['reports.read'] === true;
  const decisions = createDecisionStore({ client, toasts, queue: () => (canRead() ? queue : null), words: () => words, host: { openReport: () => host.openReport?.() ?? cases.opened.getSnapshot()?.reportId ?? null, show: (id) => host.show?.(id) } });
  const cases = createCaseStore({ client, now, timers, page, toasts, words: () => words, queue: () => (canRead() ? queue : null), decisions, me: () => me.getSnapshot(), show: (id) => host.show?.(id) });

  const identify = (who: Me): void => {
    if (!disposed) me.set(who);
  };

  return {
    client,
    session,
    toasts,
    queue,
    decisions,
    opened: cases.opened,
    me: { subscribe: me.subscribe, getSnapshot: me.getSnapshot },
    identify,
    async start() {
      let who = me.getSnapshot();
      if (who === null) {
        try {
          who = await client.me();
        } catch (e) {
          return { ok: false, error: toHubError(e), release: () => undefined };
        }
        identify(who);
      }
      if (!disposed && canRead(who)) {
        const hold = queue.acquire();
        await hold.ready;
        return { ok: true, value: who, release: hold.release };
      }
      return { ok: true, value: who, release: () => undefined };
    },
    open: cases.open,
    leave: cases.leave,
    takeNext: cases.takeNext,
    continueFrom: cases.continueFrom,
    claim: cases.claim,
    takeOver: cases.takeOver,
    release: cases.release,
    decide: (command, opts) => decisions.submit({ reportId: command.reportId, person: command.person, input: command.input, name: command.name ?? personTag(command.person), snapshot: command.snapshot ?? emptyForm() }, opts),
    undo: (reportId) => decisions.undo(reportId),
    retry: (reportId) => decisions.retry(reportId),
    dismiss: (reportId) => decisions.dismiss(reportId),
    configure(patch) {
      if (patch.t !== undefined) words = patch.t;
    },
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // The open case lets go first, then the toasts: a decision still held is sent now, as closing the hub sends it.
      cases.dispose();
      toasts.dispose();
      queue.dispose();
    },
  };
}
