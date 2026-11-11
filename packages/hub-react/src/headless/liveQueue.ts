import { fetchAll, toHubError } from '../client.js';
import type { HubClient, HubError } from '../client.js';
import type { HubT } from '../i18n.js';
import { BANNER_AFTER_FAILURES, adopt, pollDelay, reconcile } from '../live.js';
import type { ShownRow } from '../live.js';
import { filterGroups, groupQueue } from '../queue.js';
import type { QueueFilter, QueueGroup } from '../queue.js';
import type { Claim } from '../types.js';
import type { PageSource, Timers } from './env.js';
import { createStore } from './store.js';
import type { Store } from './store.js';
import type { Toasts } from './toasts.js';

// The live queue: the open cases, loaded once and then kept fresh in the background. Every part of the hub that shows the queue
// (the queue pane, the team view, the command bar, the case panel) reads this one copy, so the hub asks the server once.
//
// How it stays fresh: `GET /changes` is one cheap read. While the tab is visible it is asked every 5 seconds, while hidden every
// 30, never while the browser is offline. Only when its token changed is the queue read again. A fresh queue is folded into the
// list on screen without moving anything under the cursor (see `reconcile`): new cases wait behind the "N new" pill.

/**
 * The open queue is read 200 reports a page, up to 5 pages: 1,000 reports. Past that the numbers say they are partial.
 * @experimental
 */
export const QUEUE_PAGE = 200;
/** @experimental */
export const QUEUE_MAX_PAGES = 5;

/** @experimental */
export type Connection = 'live' | 'lost' | 'offline' | 'signedOut';

/**
 * What the queue knows, as a snapshot.
 * @experimental
 */
export interface LiveQueueState {
  /** `loading` until the first answer; `error` when there has never been one; `ready` after, even while a refresh fails. */
  status: 'loading' | 'error' | 'ready';
  error: HubError | null;
  /** Every open case as of the last read, longest wait first. For counts and search; not the list on screen. */
  groups: QueueGroup[];
  /** The list on screen, in a fixed order. */
  rows: ShownRow[];
  /** The rows that pass the filters (and whose decision is not on its way), as of the last change. */
  visible: ShownRow[];
  /** Cases that are in `groups` but not yet on screen. */
  incoming: number;
  /** True when the queue was longer than what was read (the oldest reports are left out). */
  partial: boolean;
  /** How many open reports were read. */
  reports: number;
  connection: Connection;
  /** Why the hub is `signedOut`: the 401 or 403 the server answered, or null. */
  authError: HubError | null;
  /** Changes each minute while the tab is visible, so what depends on the clock (waits, lapsed claims) is drawn again. */
  minute: number;
  /** Counts every read of the queue that was put to use, so a screen can reload its own data when the queue moved. */
  revision: number;
  /** When the last read succeeded (the hub's clock), or null. */
  updatedAt: number | null;
  filter: QueueFilter;
  /** People whose decision is on its way (held for Undo, or sending): their case leaves the list at once and comes back if it fails. */
  pending: ReadonlySet<string>;
}

/** The least time between two `refresh()` reads. */
const REFRESH_MIN_MS = 1_000;

/**
 * One hold on a live queue (see `acquire`).
 * @experimental
 */
export interface QueueHold {
  release: () => void;
  ready: Promise<void>;
}

/** @experimental */
export interface LiveQueueStore extends Store<LiveQueueState> {
  /** True while it is polling (after `start`, until `stop` or `dispose`). A part that starts the queue for itself can ask first, and stop only what it started. */
  readonly running: boolean;
  /**
   * Take a hold on the queue: it loads and polls while any hold is unreleased, and stops when the last one is released. Each part that
   * needs the queue holds it for itself (the hub, a piece, your own code), so none can stop it from under another. `release` works
   * once; `ready` settles when the first read has been tried (it never rejects). A disposed queue takes no hold.
   */
  acquire: () => QueueHold;
  /**
   * Begin loading and polling, and keep doing so until `stop()`: a hold that is never released. Safe to call twice. Resolves once the first read has been tried (it never rejects: a failure is in the snapshot). */
  start: () => Promise<void>;
  /** Stop the polling, the minute and every listener (the state stays), whatever holds there are: they are all let go. */
  stop: () => void;
  /** Stop for good: a later `start` does nothing. */
  dispose: () => void;
  setFilter: (patch: Partial<QueueFilter>) => void;
  /** Put the new cases on screen (this reorders the list: the moderator asked for it). */
  showIncoming: () => void;
  /** Read the queue again now and put it on screen as it is. Answers the open cases it read (the old ones if the read failed). */
  reload: () => Promise<QueueGroup[]>;
  /** Ask now, instead of waiting for the next poll (the banner's "Try now"). */
  retryNow: () => void;
  /**
   * @experimental Poll the change token now, as a normal poll would (and read the queue when it moved). Only reads: it sends nothing that writes.
   * Does nothing while the queue is not running (before `start`), after `dispose`, while the browser is offline, or once the session has
   * ended. At most one read a second: a call made while a read is on its way is ignored, and one made within a second of the last
   * refresh is held and sent once, when the second is up (calls in between add nothing). Do not call it in a loop: it is for "something
   * just changed", not for polling; the queue polls by itself.
   */
  refresh: () => void;
  /** The server told us a claim (or that there is none); show it at once rather than at the next poll. */
  patchClaim: (person: string, claim: Claim | null) => void;
  patchViewing: (person: string, viewers: string[]) => void;
  /** Whether the pointer or keyboard focus is in the list: while it is, a case that closes stays in place, marked. */
  setInteracting: (inside: boolean) => void;
  /** The case that is open in the main pane: its row never disappears under the moderator, even once it closes. */
  setOpenPerson: (person: string | null) => void;
  /** A cursor or an open case has moved away: a case that closed while it was on it can go now. */
  settle: () => void;
  setPending: (person: string, on: boolean) => void;
  /** After a release the open case must not claim itself again at the next heartbeat. */
  holdOff: (person: string, on: boolean) => void;
  isHeldOff: (person: string) => boolean;
  /** One Take-next guard for the whole hub (button, shortcut, command bar): false while one is running or cooling down. */
  beginTake: () => boolean;
  /** Ends a Take next; the guard stays shut for `cooldownMs` more. */
  endTake: (cooldownMs: number) => void;
}

/** @experimental */
export interface LiveQueueOptions {
  client: HubClient;
  /** The hub's clock. */
  now: () => number;
  timers: Timers;
  page: PageSource;
  toasts: Toasts;
  words: () => HubT;
  /** Who is signed in (for the "mine" filter). */
  actor: () => string;
}

const NO_FILTER: QueueFilter = { claim: 'all', category: 'all' };

/**
 * The rows that pass the filters and whose decision is not on its way. Pure: the clock comes in.
 * @experimental
 */
export function visibleRows(rows: readonly ShownRow[], filter: QueueFilter, pending: ReadonlySet<string>, actor: string, now: number): ShownRow[] {
  const keepPersons = new Set(filterGroups(rows.map((r) => r.group), filter, actor, now).map((g) => g.person));
  return rows.filter((r) => keepPersons.has(r.group.person) && !pending.has(r.group.person));
}

/** @experimental */
export function createLiveQueue(options: LiveQueueOptions): LiveQueueStore {
  const { client, now, timers, page, toasts, words } = options;
  const initial: LiveQueueState = {
    status: 'loading',
    error: null,
    groups: [],
    rows: [],
    visible: [],
    incoming: 0,
    partial: false,
    reports: 0,
    connection: page.online() ? 'live' : 'offline',
    authError: null,
    minute: 0,
    revision: 0,
    updatedAt: null,
    filter: NO_FILTER,
    pending: new Set(),
  };
  const store = createStore<LiveQueueState>(initial);

  /** Every change goes through here, so `visible` is never out of step with what it is made from. */
  const commit = (change: (prev: LiveQueueState) => LiveQueueState): void => {
    store.update((prev) => {
      const next = change(prev);
      if (next === prev) return prev;
      const same = next.rows === prev.rows && next.filter === prev.filter && next.pending === prev.pending && next.minute === prev.minute;
      return same ? next : { ...next, visible: visibleRows(next.rows, next.filter, next.pending, options.actor(), now()) };
    });
  };

  let token: string | null = null;
  let failures = 0;
  let interacting = false;
  let openPerson: string | null = null;
  const heldOff = new Set<string>();
  let busy = false;
  let seq = 0;
  let authStopped = false;
  let retryAfterMs = 0;
  let takeBusy = false;
  let takeTimer: unknown;
  // `refresh()`: when it last read, and the trailing read that is waiting for the second to be up (undefined: none).
  let lastRefresh = Number.NEGATIVE_INFINITY;
  let refreshTimer: unknown;
  const refreshNow = (): void => {
    lastRefresh = timers.now();
    run?.kick();
  };
  let run: Run | null = null;
  let disposed = false;

  const keep = (person: string): boolean => interacting || person === openPerson;

  /** Reads the queue and puts it on screen: in place (`refresh`), or as it is (`adopt`, for the first read and by request). */
  const read = async (mode: 'adopt' | 'refresh', knownToken?: string): Promise<QueueGroup[]> => {
    // Reads can overlap (a poll, Take next, Try again): only the one started last is put to use, so a slow old answer never
    // overwrites a newer one.
    const mine = ++seq;
    // The token is taken before the list: a change in between shows up at the next poll instead of being lost.
    const at = knownToken ?? (await client.changes()).token;
    const all = await fetchAllOpen(client);
    const groups = groupQueue(all.items, { sort: 'oldest' });
    if (mine !== seq) return groups;
    token = at;
    commit((prev) => {
      const shown = mode === 'adopt' || prev.status !== 'ready' ? { rows: adopt(groups), incoming: 0 } : reconcile(prev.rows, groups, keep);
      return { ...prev, status: 'ready', error: null, groups, rows: shown.rows, incoming: shown.incoming, partial: all.next !== null, reports: all.items.length, updatedAt: now(), revision: prev.revision + 1 };
    });
    return groups;
  };

  const succeeded = (): void => {
    const was = store.getSnapshot().connection;
    failures = 0;
    authStopped = false;
    commit((prev) => (prev.authError === null ? prev : { ...prev, authError: null }));
    if (was !== 'live') {
      commit((prev) => ({ ...prev, connection: 'live' }));
      toasts.push({ text: words()('hub.toast.backOnline') });
    }
  };

  const failed = (error: unknown): void => {
    failures += 1;
    const e = toHubError(error);
    commit((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'error', error: e }));
    if (e.status === 401 || e.status === 403) {
      // Signed out, or no longer allowed: asking again every few seconds cannot help. Stop, say so, and offer a retry.
      authStopped = true;
      commit((prev) => ({ ...prev, authError: e, connection: 'signedOut' }));
      return;
    }
    retryAfterMs = e.status === 429 && e.retryAfter !== undefined ? e.retryAfter * 1000 : 0;
    if (failures >= BANNER_AFTER_FAILURES && page.online()) commit((prev) => ({ ...prev, connection: 'lost' }));
  };

  interface Run {
    /** Settles when the first poll has been answered. */
    first: Promise<void>;
    kick: () => void;
    stop: () => void;
  }

  // The loop. One timer at a time; it asks `changes` and reads the queue only when the token moved.
  const begin = (): Run => {
    let cancelled = false;
    let timer: unknown;

    const schedule = (): void => {
      timers.clearTimeout(timer);
      if (cancelled || !page.online() || authStopped) return;
      const wait = Math.max(pollDelay({ visible: page.visible(), failures }), retryAfterMs);
      retryAfterMs = 0;
      timer = timers.setTimeout(() => void tick(), wait);
    };

    const tick = async (): Promise<void> => {
      timers.clearTimeout(timer);
      if (cancelled) return;
      if (busy) {
        schedule();
        return;
      }
      busy = true;
      try {
        if (token === null) {
          await read('adopt');
        } else {
          const c = await client.changes(token);
          if (cancelled) return;
          if (c.changed) await read('refresh', c.token);
        }
        if (!cancelled) succeeded();
      } catch (e) {
        if (!cancelled) failed(e);
      } finally {
        busy = false;
      }
      schedule();
    };

    const onVisibility = (): void => {
      if (page.visible()) void tick();
      else schedule();
    };
    const onOnline = (): void => {
      failures = 0;
      void tick();
    };
    const onOffline = (): void => {
      timers.clearTimeout(timer);
      commit((prev) => ({ ...prev, connection: 'offline' }));
    };
    const offs = [page.onVisibilityChange(onVisibility), page.onOnline(onOnline), page.onOffline(onOffline)];
    const first = page.online() ? tick() : Promise.resolve();

    // A minute tick, while the tab is visible: waits, the 24 hour flip and lapsed claims are worked out from the clock, and a
    // quiet queue changes nothing else.
    const bump = (): void => commit((prev) => ({ ...prev, minute: prev.minute + 1 }));
    const minuteTimer = timers.setInterval(() => page.visible() && bump(), 60_000);
    offs.push(
      page.onVisibilityChange(() => {
        if (page.visible()) bump();
      }),
    );

    return {
      first,
      kick: () => void tick(),
      stop: () => {
        cancelled = true;
        timers.clearTimeout(timer);
        timers.clearInterval(minuteTimer);
        for (const off of offs) off();
      },
    };
  };

  // The cursor has moved away: a case that closed while it was on it can go now.
  const settle = (): void => {
    commit((prev) => {
      if (prev.status !== 'ready') return prev;
      const next = reconcile(prev.rows, prev.groups, keep);
      return next.rows.length === prev.rows.length && next.rows.every((r, i) => r.gone === prev.rows[i]?.gone && r.group === prev.rows[i]?.group)
        ? prev
        : { ...prev, rows: next.rows, incoming: next.incoming };
    });
  };

  const patch = (person: string, change: (g: QueueGroup) => QueueGroup): void => {
    commit((prev) => {
      if (!prev.groups.some((g) => g.person === person) && !prev.rows.some((r) => r.group.person === person)) return prev;
      const at = (g: QueueGroup): QueueGroup => (g.person === person ? change(g) : g);
      return { ...prev, groups: prev.groups.map(at), rows: prev.rows.map((r) => (r.group.person === person ? { ...r, group: change(r.group) } : r)) };
    });
  };

  // Who wants it running: holds taken with `acquire`, and `start()`, which is a hold that only `stop()` lets go.
  const holds = new Set<object>();
  let kept = false;
  const halt = (): void => {
    timers.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    run?.stop();
    run = null;
    timers.clearTimeout(takeTimer);
  };

  const api: LiveQueueStore = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    get running() {
      return run !== null;
    },
    acquire() {
      const token = {};
      if (disposed) return { release: () => undefined, ready: Promise.resolve() };
      holds.add(token);
      if (run === null) run = begin();
      return {
        ready: run.first,
        release() {
          if (!holds.delete(token)) return;
          if (holds.size === 0 && !kept) halt();
        },
      };
    },
    start() {
      kept = true;
      if (run === null && !disposed) run = begin();
      return run?.first ?? Promise.resolve();
    },
    stop() {
      holds.clear();
      kept = false;
      halt();
    },
    dispose() {
      disposed = true;
      api.stop();
    },
    setFilter: (p) => commit((prev) => (Object.entries(p).every(([k, v]) => prev.filter[k as keyof QueueFilter] === v) ? prev : { ...prev, filter: { ...prev.filter, ...p } })),
    showIncoming: () => commit((prev) => ({ ...prev, rows: adopt(prev.groups), incoming: 0 })),
    async reload() {
      // A disposed hub asks nothing more: a decision it sent on the way out has been sent, and there is nobody to show the queue to.
      if (disposed) return store.getSnapshot().groups;
      try {
        const groups = await read('adopt');
        succeeded();
        return groups;
      } catch (e) {
        failed(e);
        return store.getSnapshot().groups;
      }
    },
    retryNow() {
      failures = 0;
      run?.kick();
    },
    refresh() {
      if (disposed || authStopped || !page.online() || run === null) return;
      // A read is on its way: it answers this call. (It must not reach the poll timer either.)
      if (busy) return;
      // A trailing read is already waiting: it answers this call too.
      if (refreshTimer !== undefined) return;
      const wait = lastRefresh + REFRESH_MIN_MS - timers.now();
      if (wait > 0) {
        refreshTimer = timers.setTimeout(() => {
          refreshTimer = undefined;
          if (!disposed && !busy && !authStopped && page.online()) refreshNow();
        }, wait);
        return;
      }
      refreshNow();
    },
    patchClaim: (person, claim) => patch(person, (g) => ({ ...g, claim })),
    patchViewing: (person, viewers) => patch(person, (g) => ({ ...g, viewing: [...viewers].sort() })),
    setInteracting(inside) {
      interacting = inside;
      if (!inside) settle();
    },
    setOpenPerson(person) {
      openPerson = person;
      if (person === null) settle();
    },
    settle,
    setPending(person, on) {
      commit((prev) => {
        if (prev.pending.has(person) === on) return prev;
        const next = new Set(prev.pending);
        if (on) next.add(person);
        else next.delete(person);
        return { ...prev, pending: next };
      });
    },
    holdOff(person, on) {
      if (on) heldOff.add(person);
      else heldOff.delete(person);
    },
    isHeldOff: (person) => heldOff.has(person),
    beginTake() {
      if (takeBusy) return false;
      takeBusy = true;
      timers.clearTimeout(takeTimer);
      return true;
    },
    endTake(cooldownMs) {
      timers.clearTimeout(takeTimer);
      if (disposed) {
        takeBusy = false;
        return;
      }
      takeTimer = timers.setTimeout(() => {
        takeBusy = false;
      }, cooldownMs);
    },
  };
  return api;
}

function fetchAllOpen(client: HubClient) {
  return fetchAll((cursor) => client.listReports({ status: 'open', limit: QUEUE_PAGE, ...(cursor === undefined ? {} : { cursor }) }), { maxPages: QUEUE_MAX_PAGES });
}
