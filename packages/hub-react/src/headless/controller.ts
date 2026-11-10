import { toHubError } from '../client.js';
import type { HubClient } from '../client.js';
import { createT, en } from '../i18n.js';
import type { HubT } from '../i18n.js';
import type { Me } from '../types.js';
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
}

/** What a host may change after the controller is made. */
export interface HubControllerSettings {
  t?: HubT;
}

export interface HubController {
  readonly client: HubClient;
  readonly session: Session;
  readonly toasts: ToastStore;
  readonly queue: LiveQueueStore;
  /** Who is signed in: null until `start()` or `identify()`. */
  readonly me: Store<Me | null>;
  /** Say who is signed in, when the host has already asked `GET /me` itself. Starts nothing. */
  identify(me: Me): void;
  /** Asks `GET /me` (unless `identify` was called) and, for a role that can read reports, starts the live queue. */
  start(): Promise<ActionResult<Me>>;
  /** Tell the controller what the host has changed since it was made: the words. */
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

  const identify = (who: Me): void => {
    if (!disposed) me.set(who);
  };

  return {
    client,
    session,
    toasts,
    queue,
    me: { subscribe: me.subscribe, getSnapshot: me.getSnapshot },
    identify,
    async start() {
      let who = me.getSnapshot();
      if (who === null) {
        try {
          who = await client.me();
        } catch (e) {
          return { ok: false, error: toHubError(e) };
        }
        identify(who);
      }
      if (!disposed && who.can['reports.read'] === true) queue.start();
      return { ok: true, value: who };
    },
    configure(patch) {
      if (patch.t !== undefined) words = patch.t;
    },
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      queue.dispose();
      toasts.dispose();
    },
  };
}
