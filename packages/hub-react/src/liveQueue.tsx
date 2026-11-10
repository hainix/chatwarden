import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchAll, toHubError } from './client.js';
import type { HubError } from './client.js';
import { useHub } from './context.js';
import { BANNER_AFTER_FAILURES, adopt, pollDelay, reconcile } from './live.js';
import type { ShownRow } from './live.js';
import { filterGroups, groupQueue } from './queue.js';
import type { QueueFilter, QueueGroup } from './queue.js';
import { useToasts } from './toasts.js';
import type { Claim } from './types.js';

// The live queue: the open cases, loaded once and then kept fresh in the background. Every part of the hub that shows the queue
// (the queue pane, the team view, the command bar, the case panel) reads this one copy, so the hub asks the server once.
//
// How it stays fresh: `GET /changes` is one cheap read. While the tab is visible it is asked every 5 seconds, while hidden every
// 30, never while the browser is offline. Only when its token changed is the queue read again. A fresh queue is folded into the
// list on screen without moving anything under the cursor (see `reconcile`): new cases wait behind the "N new" pill.

/** The open queue is read 200 reports a page, up to 5 pages: 1,000 reports. Past that the numbers say they are partial. */
export const QUEUE_PAGE = 200;
export const QUEUE_MAX_PAGES = 5;

export type Connection = 'live' | 'lost' | 'offline';

export interface LiveQueue {
  /** `loading` until the first answer; `error` when there has never been one; `ready` after, even while a refresh fails. */
  status: 'loading' | 'error' | 'ready';
  error: HubError | null;
  /** Every open case as of the last read, longest wait first. For counts and search; not the list on screen. */
  groups: QueueGroup[];
  /** The list on screen, in a fixed order. */
  rows: ShownRow[];
  /** The rows that pass the filters. */
  visible: ShownRow[];
  /** Cases that are in `groups` but not yet on screen. */
  incoming: number;
  /** True when the queue was longer than what was read (the oldest reports are left out). */
  partial: boolean;
  /** How many open reports were read. */
  reports: number;
  connection: Connection;
  /** When the last read succeeded (the hub's clock), or null. */
  updatedAt: number | null;
  filter: QueueFilter;
  setFilter: (patch: Partial<QueueFilter>) => void;
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
  /** After a release the open case must not claim itself again at the next heartbeat. */
  holdOff: (person: string, on: boolean) => void;
  isHeldOff: (person: string) => boolean;
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

const isVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

const NO_CATEGORY_FILTER: QueueFilter = { claim: 'all', category: 'all' };

interface Loaded {
  status: 'loading' | 'error' | 'ready';
  error: HubError | null;
  groups: QueueGroup[];
  rows: ShownRow[];
  incoming: number;
  partial: boolean;
  reports: number;
  updatedAt: number | null;
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const { client, now, me } = useHub();
  const toasts = useToasts();
  const { t } = useHub();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading', error: null, groups: [], rows: [], incoming: 0, partial: false, reports: 0, updatedAt: null });
  const [connection, setConnection] = useState<Connection>(isOffline() ? 'offline' : 'live');
  const [filter, setFilterState] = useState<QueueFilter>(NO_CATEGORY_FILTER);

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const nowRef = useRef(now);
  nowRef.current = now;
  const tRef = useRef(t);
  tRef.current = t;
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  const token = useRef<string | null>(null);
  const failures = useRef(0);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const interacting = useRef(false);
  const openPerson = useRef<string | null>(null);
  const heldOff = useRef(new Set<string>());
  const busy = useRef(false);
  const kickRef = useRef<() => void>(() => undefined);

  const keep = useCallback((person: string): boolean => interacting.current || person === openPerson.current, []);

  /** Reads the queue and puts it on screen: in place (`refresh`), or as it is (`adopt`, for the first read and by request). */
  const read = useCallback(
    async (mode: 'adopt' | 'refresh', knownToken?: string): Promise<QueueGroup[]> => {
      // The token is taken before the list: a change in between shows up at the next poll instead of being lost.
      const at = knownToken ?? (await client.changes()).token;
      const all = await fetchAll((cursor) => client.listReports({ status: 'open', limit: QUEUE_PAGE, ...(cursor === undefined ? {} : { cursor }) }), {
        maxPages: QUEUE_MAX_PAGES,
      });
      token.current = at;
      const groups = groupQueue(all.items, { sort: 'oldest' });
      setLoaded((prev) => {
        const shown = mode === 'adopt' || prev.status !== 'ready' ? { rows: adopt(groups), incoming: 0 } : reconcile(prev.rows, groups, keep);
        return { status: 'ready', error: null, groups, rows: shown.rows, incoming: shown.incoming, partial: all.next !== null, reports: all.items.length, updatedAt: nowRef.current() };
      });
      return groups;
    },
    [client, keep],
  );

  const succeeded = useCallback((): void => {
    const was = connectionRef.current;
    failures.current = 0;
    if (was !== 'live') {
      setConnection('live');
      toastsRef.current.push({ text: tRef.current('hub.toast.backOnline') });
    }
  }, []);

  const failed = useCallback((error: unknown): void => {
    failures.current += 1;
    const e = toHubError(error);
    setLoaded((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'error', error: e }));
    if (failures.current >= BANNER_AFTER_FAILURES && !isOffline()) setConnection('lost');
  }, []);

  // The loop. One timer at a time; it asks `changes` and reads the queue only when the token moved.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (): void => {
      clearTimeout(timer);
      if (cancelled || isOffline()) return;
      timer = setTimeout(() => void tick(), pollDelay({ visible: isVisible(), failures: failures.current }));
    };

    const tick = async (): Promise<void> => {
      clearTimeout(timer);
      if (cancelled) return;
      if (busy.current) {
        schedule();
        return;
      }
      busy.current = true;
      try {
        if (token.current === null) {
          await read('adopt');
        } else {
          const c = await client.changes(token.current);
          if (cancelled) return;
          if (c.changed) await read('refresh', c.token);
        }
        if (!cancelled) succeeded();
      } catch (e) {
        if (!cancelled) failed(e);
      } finally {
        busy.current = false;
      }
      schedule();
    };

    kickRef.current = () => void tick();

    const onVisibility = (): void => {
      if (isVisible()) void tick();
      else schedule();
    };
    const onOnline = (): void => {
      failures.current = 0;
      void tick();
    };
    const onOffline = (): void => {
      clearTimeout(timer);
      setConnection('offline');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (!isOffline()) void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [client, read, succeeded, failed]);

  // The cursor has moved away: a case that closed while it was on it can go now.
  const settle = useCallback((): void => {
    setLoaded((prev) => {
      if (prev.status !== 'ready') return prev;
      const next = reconcile(prev.rows, prev.groups, keep);
      return next.rows.length === prev.rows.length && next.rows.every((r, i) => r.gone === prev.rows[i]?.gone && r.group === prev.rows[i]?.group)
        ? prev
        : { ...prev, rows: next.rows, incoming: next.incoming };
    });
  }, [keep]);

  const setInteracting = useCallback(
    (inside: boolean): void => {
      interacting.current = inside;
      if (!inside) settle();
    },
    [settle],
  );
  const setOpenPerson = useCallback(
    (person: string | null): void => {
      openPerson.current = person;
      if (person === null) settle();
    },
    [settle],
  );

  const patch = useCallback((person: string, change: (g: QueueGroup) => QueueGroup): void => {
    setLoaded((prev) => {
      const at = (g: QueueGroup): QueueGroup => (g.person === person ? change(g) : g);
      return { ...prev, groups: prev.groups.map(at), rows: prev.rows.map((r) => (r.group.person === person ? { ...r, group: change(r.group) } : r)) };
    });
  }, []);
  const patchClaim = useCallback((person: string, claim: Claim | null): void => patch(person, (g) => ({ ...g, claim })), [patch]);
  const patchViewing = useCallback((person: string, viewers: string[]): void => patch(person, (g) => ({ ...g, viewing: [...viewers].sort() })), [patch]);

  const showIncoming = useCallback((): void => {
    setLoaded((prev) => ({ ...prev, rows: adopt(prev.groups), incoming: 0 }));
  }, []);

  const reload = useCallback(async (): Promise<QueueGroup[]> => {
    try {
      const groups = await read('adopt');
      succeeded();
      return groups;
    } catch (e) {
      failed(e);
      return loadedRef.current.groups;
    }
  }, [read, succeeded, failed]);

  const retryNow = useCallback((): void => {
    failures.current = 0;
    kickRef.current();
  }, []);

  const setFilter = useCallback((p: Partial<QueueFilter>): void => setFilterState((f) => ({ ...f, ...p })), []);
  const holdOff = useCallback((person: string, on: boolean): void => {
    if (on) heldOff.current.add(person);
    else heldOff.current.delete(person);
  }, []);
  const isHeldOff = useCallback((person: string): boolean => heldOff.current.has(person), []);

  const nowMs = now();
  const visible = useMemo(() => {
    const keepPersons = new Set(filterGroups(loaded.rows.map((r) => r.group), filter, me.actor, nowMs).map((g) => g.person));
    return loaded.rows.filter((r) => keepPersons.has(r.group.person));
  }, [loaded.rows, filter, me.actor, nowMs]);

  const value = useMemo<LiveQueue>(
    () => ({
      status: loaded.status,
      error: loaded.error,
      groups: loaded.groups,
      rows: loaded.rows,
      visible,
      incoming: loaded.incoming,
      partial: loaded.partial,
      reports: loaded.reports,
      connection,
      updatedAt: loaded.updatedAt,
      filter,
      setFilter,
      showIncoming,
      reload,
      retryNow,
      patchClaim,
      patchViewing,
      setInteracting,
      setOpenPerson,
      holdOff,
      isHeldOff,
    }),
    [loaded, visible, connection, filter, setFilter, showIncoming, reload, retryNow, patchClaim, patchViewing, setInteracting, setOpenPerson, holdOff, isHeldOff],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
