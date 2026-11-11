import { createContext, useEffect } from 'react';
import type { HubController } from './headless/controller.js';
import { useOptionalController } from './controllerContext.js';
import { useHub } from './context.js';

// What pieces that share one controller must agree on, kept per controller (so every piece and hook under one `HubProvider`, or
// under several that were given the same controller, sees the same):
// - the queue is started once, by the first part that needs it, however many need it, and stopped when the last one leaves, but only
//   if the parts started it (a controller the adopter already runs is left running);
// - a case is claimed once and its heartbeat runs once, however many parts show it, and only one case is held at a time (the
//   controller holds one open case): the case that was most recently shown or entered.
// Where a piece sends the moderator is not here: a piece calls its own callbacks from the outcome of what it did (`showNext`), the
// same way for a controller it made and one it was given.

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
  /** Tell the runtime which controller it serves. */
  bind(controller: HubController): void;
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
  let startedQueue = false;
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

  return {
    bind(c) {
      controller = c;
    },
    needQueue() {
      queueUsers += 1;
      // The first part starts it, unless something else (the adopter, the hub's shell) is already running it.
      if (queueUsers === 1 && controller !== null && !controller.queue.running) {
        startedQueue = true;
        void controller.queue.start();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        queueUsers -= 1;
        // Stopped only by the one that started it. In a microtask, so a remount in the same commit keeps it running.
        queueMicrotask(() => {
          if (queueUsers === 0 && startedQueue) {
            startedQueue = false;
            controller?.queue.stop();
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

/** The runtime of a controller, made on first use (one per controller, whoever made it). */
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
