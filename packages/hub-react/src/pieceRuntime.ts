import { useEffect } from 'react';
import type { HubHost, HubController } from './headless/controller.js';
import { useOptionalController } from './controllerContext.js';
import { useHub } from './context.js';

// What pieces that share one controller must agree on, kept per controller (so every piece and hook under one `HubProvider`, or
// under several that were given the same controller, sees the same):
// - the queue is started once, by the first part that needs it, however many need it;
// - a case is claimed once and its heartbeat runs once, however many parts show it, and only one case is held at a time (the
//   controller holds one open case): the case that was most recently shown or entered;
// - `host.show`, the controller's "bring the moderator to this case", is answered by the most recent piece that was told where
//   cases go, and by nobody (it does nothing) when none was.

/** Where a piece was told cases, people and reports go. Read when called, so a new callback prop is used at once. */
export interface PieceNav {
  onOpenCase?: ((person: string, reportId: string) => void) | undefined;
  onOpenPerson?: ((person: string) => void) | undefined;
  onOpenReport?: ((reportId: string) => void) | undefined;
  onOpenTerms?: (() => void) | undefined;
}

export interface PieceRuntime {
  /** The provider made the controller, so it starts and stops the queue and disposes the controller. */
  readonly owned: boolean;
  /** The host an owned controller is made with. */
  readonly host: HubHost;
  /** Tell the runtime which controller it serves. */
  bind(controller: HubController): void;
  /** A part that needs the live queue running. Returns what lets it go. */
  needQueue(): () => void;
  /** A part that shows a case, and so wants it claimed and its heartbeat running. Returns what lets it go. */
  showCase(reportId: string): () => void;
  /** The moderator is in a part that shows this case: it becomes the one that is held. */
  enterCase(reportId: string): void;
  /** A piece that can be told to open things. Returns what removes it. */
  addNav(nav: { current: PieceNav }): () => void;
}

export function createRuntime(owned: boolean): PieceRuntime {
  let controller: HubController | null = null;
  const navs = new Set<{ current: PieceNav }>();
  const shown = new Map<string, number>();
  let recent: string[] = [];
  let current: string | null = null;
  let syncing = false;
  let queueUsers = 0;

  const wanted = (): string | null => {
    for (let i = recent.length - 1; i >= 0; i -= 1) if (shown.has(recent[i] as string)) return recent[i] as string;
    return null;
  };
  // In a microtask: StrictMode unmounts and mounts a part within one commit, which must not let a case go and claim it again.
  const sync = (): void => {
    if (syncing) return;
    syncing = true;
    queueMicrotask(() => {
      syncing = false;
      if (controller === null || controller.disposed) return;
      const want = wanted();
      if (want === current) return;
      current = want;
      if (want === null) controller.leave();
      else void controller.open(want);
    });
  };

  const host: HubHost = {
    show(reportId) {
      const person = controller?.queue.getSnapshot().groups.find((g) => g.reportIds.includes(reportId))?.person ?? null;
      for (const nav of [...navs].reverse()) {
        const to = nav.current;
        if (to.onOpenCase !== undefined && person !== null) return to.onOpenCase(person, reportId);
        if (to.onOpenReport !== undefined) return to.onOpenReport(reportId);
      }
    },
  };

  return {
    owned,
    host,
    bind(c) {
      controller = c;
    },
    needQueue() {
      queueUsers += 1;
      if (queueUsers === 1) void controller?.queue.start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        queueUsers -= 1;
        // A provider that made the controller stops the queue when nothing needs it; one that was given a controller leaves it
        // running, because the adopter may be reading it too. In a microtask, so a remount in the same commit keeps it running.
        if (owned) queueMicrotask(() => queueUsers === 0 && controller?.queue.stop());
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
    addNav(nav) {
      navs.add(nav);
      return () => void navs.delete(nav);
    },
  };
}

const runtimes = new WeakMap<HubController, PieceRuntime>();

/** Remember the runtime of a controller a provider made. */
export function bindRuntime(controller: HubController, runtime: PieceRuntime): void {
  runtime.bind(controller);
  runtimes.set(controller, runtime);
}

/** The runtime of a controller: the one its provider made, or one made now for a controller the adopter brought. */
export function runtimeOf(controller: HubController): PieceRuntime {
  let runtime = runtimes.get(controller);
  if (runtime === undefined) {
    runtime = createRuntime(false);
    bindRuntime(controller, runtime);
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
