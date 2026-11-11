import { createContext, useEffect } from 'react';
import type { HubController, HubHost } from './headless/controller.js';
import type { QueueHold } from './headless/liveQueue.js';
import { useOptionalController } from './controllerContext.js';
import { useHub } from './context.js';

// What pieces that share one controller must agree on, kept per controller (so every piece and hook under one `HubProvider`, or
// under several that were given the same controller, sees the same):
// - the queue is held once for all the parts that need it (one hold of the queue's own ref-count: see `queue.acquire`), so it runs
//   while a piece needs it or the adopter started it, and the pieces release only their own hold;
// - a case is claimed once and its heartbeat runs once, however many parts show it, and only one case is held at a time (the
//   controller holds one open case): the case that was most recently shown or entered.
// Where a piece sends the moderator: a piece calls its own callbacks from the outcome of what it did (`showNext`), the same way for a
// controller it made and one it was given. A controller the provider made also gets `host` (below), so what the controller starts by
// itself (the "Open the case" toast on a failed decision, Undo of a case the moderator left) reaches the callbacks too; what a piece
// did itself is `quietly` (the outcome already navigated) and a case a piece is showing needs no navigation. A controller the adopter
// made keeps the adopter's own `host`.

/** Where a piece was told cases, people and reports go. Read when called, so a new callback prop is used at once. */
export interface PieceNav {
  onOpenCase?: ((person: string, reportId: string) => void) | undefined;
  onOpenPerson?: ((person: string) => void) | undefined;
  onOpenReport?: ((reportId: string) => void) | undefined;
  onOpenTerms?: (() => void) | undefined;
}

/** The nav of the piece a part is in, or null in the hub's shell (where the router shows a case). */
export const PieceNavContext = createContext<{ current: PieceNav } | null>(null);

/** Whether a piece has any way to show a case it would go on to. */
export const canShowNext = (nav: PieceNav): boolean => nav.onOpenCase !== undefined || nav.onOpenReport !== undefined;

/** Tell a piece's callback which case to show next: `onOpenCase` (person and report) if it has one, else `onOpenReport`. */
export function showNext(nav: PieceNav, person: string, reportId: string): void {
  if (nav.onOpenCase !== undefined) nav.onOpenCase(person, reportId);
  else nav.onOpenReport?.(reportId);
}

export interface PieceRuntime {
  /** The host a provider-made controller is created with: `show` goes to the most recent piece that can open a case. */
  readonly host: HubHost;
  /** Tell the runtime which controller it serves. */
  bind(controller: HubController): void;
  /** A piece that can be told to open things. Returns what removes it. */
  addNav(nav: { current: PieceNav }): () => void;
  /** Run something the piece does itself (Take next, decide and next): the controller's own `show` is not repeated, the outcome navigates. */
  quietly<T>(run: () => Promise<T>): Promise<T>;
  /** A part that needs the live queue running. Returns what lets it go. */
  needQueue(): () => void;
  /** A part that shows a case, and so wants it claimed and its heartbeat running. Returns what lets it go. */
  showCase(reportId: string): () => void;
  /** The moderator is in a part that shows this case: it becomes the one that is held. */
  enterCase(reportId: string): void;
}

const inProduction = (): boolean => typeof process !== 'undefined' && process.env.NODE_ENV === 'production';

export function createRuntime(): PieceRuntime {
  let controller: HubController | null = null;
  const shown = new Map<string, number>();
  let recent: string[] = [];
  let current: string | null = null;
  let syncing = false;
  let queueUsers = 0;
  let hold: QueueHold | null = null;
  let quiet = 0;
  const navs = new Set<{ current: PieceNav }>();
  let warned = false;
  let watching: (() => void) | null = null;

  const wanted = (): string | null => {
    for (let i = recent.length - 1; i >= 0; i -= 1) if (shown.has(recent[i] as string)) return recent[i] as string;
    return null;
  };

  // Two different people shown at once is a layout the hub supports (both can be read, and answered), but only one is held: the
  // other is shown unclaimed, with no heartbeat. Said once, in development, when the queue can tell people from reports.
  const warnIfMany = (): void => {
    if (warned || controller === null || shown.size < 2 || inProduction()) return;
    const queue = controller.queue;
    if (queue.getSnapshot().status !== 'ready') {
      if (watching === null) {
        watching = queue.subscribe(() => {
          if (queue.getSnapshot().status !== 'ready') return;
          watching?.();
          watching = null;
          warnIfMany();
        });
      }
      return;
    }
    const groups = queue.getSnapshot().groups;
    const people = new Set([...shown.keys()].map((id) => groups.find((g) => g.reportIds.includes(id))?.person ?? id));
    if (people.size < 2) return;
    warned = true;
    console.warn(
      'Chatwarden hub: more than one case is shown at once, but the hub holds one case at a time (the one you last entered). The other cards are shown unclaimed, with no heartbeat; reading and deciding on them still work.',
    );
  };

  // In a microtask: StrictMode unmounts and mounts a part within one commit, which must not let a case go and claim it again.
  const sync = (): void => {
    if (syncing) return;
    syncing = true;
    queueMicrotask(() => {
      syncing = false;
      if (controller === null || controller.disposed) return;
      warnIfMany();
      const want = wanted();
      if (want === current) return;
      current = want;
      if (want === null) controller.leave();
      else void controller.open(want);
    });
  };

  const host: HubHost = {
    show(reportId) {
      // A case a piece is showing is already in front of the moderator; and what a piece just did itself has navigated by its outcome.
      if (quiet > 0 || shown.has(reportId)) return;
      const person = controller?.queue.getSnapshot().groups.find((g) => g.reportIds.includes(reportId))?.person ?? null;
      for (const nav of [...navs].reverse()) {
        const to = nav.current;
        if (to.onOpenCase !== undefined && person !== null) return to.onOpenCase(person, reportId);
        if (to.onOpenReport !== undefined) return to.onOpenReport(reportId);
      }
    },
  };

  return {
    host,
    bind(c) {
      controller = c;
    },
    addNav(nav) {
      navs.add(nav);
      return () => void navs.delete(nav);
    },
    async quietly(run) {
      quiet += 1;
      try {
        return await run();
      } finally {
        quiet -= 1;
      }
    },
    needQueue() {
      queueUsers += 1;
      // The first part takes the hold for all of them; the adopter's own start() is another hold, so neither stops the other.
      if (queueUsers === 1 && controller !== null && hold === null) hold = controller.queue.acquire();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        queueUsers -= 1;
        // Released with the last part. In a microtask, so a remount in the same commit keeps it running.
        queueMicrotask(() => {
          if (queueUsers === 0 && hold !== null) {
            hold.release();
            hold = null;
          }
        });
      };
    },
    showCase(reportId) {
      shown.set(reportId, (shown.get(reportId) ?? 0) + 1);
      recent = [...recent.filter((r) => r !== reportId), reportId];
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (shown.get(reportId) ?? 1) - 1;
        if (left <= 0) {
          shown.delete(reportId);
          recent = recent.filter((r) => r !== reportId);
        } else shown.set(reportId, left);
        sync();
      };
    },
    enterCase(reportId) {
      if (!shown.has(reportId) || recent[recent.length - 1] === reportId) return;
      recent = [...recent.filter((r) => r !== reportId), reportId];
      sync();
    },
  };
}

const runtimes = new WeakMap<HubController, PieceRuntime>();

/** Remember the runtime of a controller a provider made with its host. */
export function bindRuntime(controller: HubController, runtime: PieceRuntime): void {
  runtime.bind(controller);
  runtimes.set(controller, runtime);
}

/** The runtime of a controller: the one its provider made, or one made on first use for a controller the adopter brought. */
export function runtimeOf(controller: HubController): PieceRuntime {
  let runtime = runtimes.get(controller);
  if (runtime === undefined) {
    runtime = createRuntime();
    runtime.bind(controller);
    runtimes.set(controller, runtime);
  }
  return runtime;
}

/** The runtime of the controller above. Throws where there is none. */
export function useRuntime(): PieceRuntime {
  const controller = useOptionalController();
  if (controller === null) throw new Error('This must be used inside <HubProvider> (or <Hub>)');
  return runtimeOf(controller);
}

/** Keeps the live queue running while this component is mounted, if the role can read reports. */
export function useQueueRunning(wanted = true): void {
  const { can } = useHub();
  const runtime = useRuntime();
  const reads = can('reports.read');
  useEffect(() => (wanted && reads ? runtime.needQueue() : undefined), [runtime, wanted, reads]);
}

/** Keeps a case claimed (with its heartbeat) while this component is mounted. `null` is no case. */
export function useCaseShown(reportId: string | null, enabled = true): void {
  const { can } = useHub();
  const runtime = useRuntime();
  const reads = can('reports.read');
  useEffect(() => (enabled && reads && reportId !== null ? runtime.showCase(reportId) : undefined), [runtime, reportId, enabled, reads]);
}
