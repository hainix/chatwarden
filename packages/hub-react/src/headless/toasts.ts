import type { HubT } from '../i18n.js';
import { browserPage, browserTimers } from './env.js';
import type { PageSource, Timers } from './env.js';
import { createStore } from './store.js';
import type { Store } from './store.js';

// Toasts: short news that does not need an answer ("You took the case"), and the one that does, for a few seconds: Undo.
// A "held" action is the Undo window the design asks for: the action waits, visible, for UNDO_MS; Undo cancels it; and it is
// sent at once if the toast is dismissed early, or if the hub is closing (the page hides, or the tab is hidden). Nothing is sent twice.
// This is the queue of toast records and their timers. How a toast looks (and that hovering it pauses it) is the UI's.

/** How long an Undo toast, and the action it holds, waits. The stylesheet's progress bar runs for the same 5 seconds. */
export const UNDO_MS = 5_000;
/** How long a plain toast stays. An error stays longer. */
export const TOAST_MS = 4_000;
export const TOAST_ERROR_MS = 7_000;
/** The most toasts on screen at once. */
export const TOAST_MAX = 3;

export interface ToastInput {
  text: string;
  tone?: 'neutral' | 'bad';
  /** One button on the toast, such as Undo. Choosing it dismisses the toast. */
  action?: { label: string; run: () => void };
  /** Milliseconds on screen. Default: 4 s; 7 s for an error; 5 s with an action. */
  ms?: number;
}

export interface HoldInput {
  text: string;
  /** What runs when the window ends without Undo, or at once on `commit()`, a dismissal, or the hub closing. Runs once. */
  run: () => unknown;
  /** The label of the Undo button. Default: the catalog's "Undo". */
  undoLabel?: string;
  /** Runs when Undo is chosen. */
  onUndo?: () => void;
  ms?: number;
}

export interface Hold {
  /** Cancel the action. A no-op once it has run. */
  undo: () => void;
  /** Run the action now. A no-op once it has run or been undone. */
  commit: () => void;
}

export interface Toasts {
  push: (input: ToastInput) => number;
  hold: (input: HoldInput) => Hold;
  dismiss: (id: number) => void;
}

/** One toast as it is shown. */
export interface ToastRecord {
  id: number;
  text: string;
  tone: 'neutral' | 'bad';
  action: { label: string; run: () => void } | null;
  ms: number;
  /** A held action: the toast carries the Undo progress bar. */
  held: boolean;
}

export interface ToastStore extends Toasts, Store<readonly ToastRecord[]> {
  /** Stop the toast's own timer, keeping what is left of it (a pointer is over it, or focus is in it). */
  pause: (id: number) => void;
  /** Start it again with what was left. */
  resume: (id: number) => void;
  /** Stops every timer and listener and runs what is still held, at once. Safe to call twice. */
  dispose: () => void;
}

export interface ToastStoreOptions {
  /** The words (the Undo label). Read each time, so a new catalog takes effect. */
  words: () => HubT;
  timers?: Timers;
  page?: PageSource;
}

/** Keeps at most TOAST_MAX: the oldest news goes first, and a toast with an Undo is only pushed off when every toast has one. */
function capped(list: ToastRecord[]): ToastRecord[] {
  const out = [...list];
  while (out.length > TOAST_MAX) {
    const at = out.findIndex((s) => s.action === null);
    out.splice(at < 0 ? 0 : at, 1);
  }
  return out;
}

interface Clock {
  left: number;
  startedAt: number | null;
  timer: unknown;
}

export function createToastStore(options: ToastStoreOptions): ToastStore {
  const timers = options.timers ?? browserTimers;
  const page = options.page ?? browserPage;
  const store = createStore<readonly ToastRecord[]>([]);
  let nextId = 0;
  let disposed = false;
  // What each held toast does when its window ends: id -> the pending action. Gone once run or undone.
  const pending = new Map<number, { run: () => unknown; settle: () => void }>();
  const clocks = new Map<number, Clock>();
  let stopWatching: (() => void) | null = null;

  const arm = (id: number, clock: Clock): void => {
    clock.startedAt = timers.now();
    clock.timer = timers.setTimeout(() => finish(id), clock.left);
  };
  const forget = (id: number): void => {
    const clock = clocks.get(id);
    if (clock !== undefined) timers.clearTimeout(clock.timer);
    clocks.delete(id);
  };
  const remove = (id: number): void => {
    forget(id);
    store.update((list) => (list.some((s) => s.id === id) ? list.filter((s) => s.id !== id) : list));
  };

  /** Ends a toast: a held action runs unless it was undone. */
  function finish(id: number): void {
    const held = pending.get(id);
    if (held !== undefined) {
      pending.delete(id);
      held.settle();
      void Promise.resolve()
        .then(held.run)
        .catch(() => undefined);
      watch();
    }
    remove(id);
  }

  /** The hub is closing (the tab, or the page going away): anything still held is sent now. */
  const flush = (): void => {
    for (const id of [...pending.keys()]) finish(id);
  };

  // The page listeners are on only while something is held: a hub that holds nothing listens to nothing.
  function watch(): void {
    if (pending.size > 0 && stopWatching === null && !disposed) {
      // `pagehide` is the tab closing; a hidden tab is the other way the page can go away without it (a phone switching apps).
      const offHide = page.onPageHide(flush);
      const offVisibility = page.onVisibilityChange(() => {
        if (!page.visible()) flush();
      });
      stopWatching = () => {
        offHide();
        offVisibility();
      };
    } else if (pending.size === 0 && stopWatching !== null) {
      stopWatching();
      stopWatching = null;
    }
  }

  /** A toast pushed out by the cap must still run its held action: it was never undone. */
  const reap = (): void => {
    const onScreen = new Set(store.getSnapshot().map((s) => s.id));
    for (const id of [...pending.keys()]) if (!onScreen.has(id)) finish(id);
    for (const id of [...clocks.keys()]) if (!onScreen.has(id)) forget(id);
  };

  const show = (record: ToastRecord): void => {
    const clock: Clock = { left: record.ms, startedAt: null, timer: undefined };
    clocks.set(record.id, clock);
    arm(record.id, clock);
    store.update((list) => capped([...list, record]));
    reap();
  };

  const push = (input: ToastInput): number => {
    if (disposed) return 0;
    const id = ++nextId;
    const tone = input.tone ?? 'neutral';
    const ms = input.ms ?? (input.action !== undefined ? UNDO_MS : tone === 'bad' ? TOAST_ERROR_MS : TOAST_MS);
    show({ id, text: input.text, tone, action: input.action ?? null, ms, held: false });
    return id;
  };

  const hold = (input: HoldInput): Hold => {
    if (disposed) {
      // The hub is gone: what was to be held is sent now, as a closing hub sends it.
      void Promise.resolve()
        .then(input.run)
        .catch(() => undefined);
      return { undo: () => undefined, commit: () => undefined };
    }
    const id = ++nextId;
    let settled = false;
    pending.set(id, {
      run: input.run,
      settle: () => {
        settled = true;
      },
    });
    watch();
    const undo = (): void => {
      if (settled || !pending.has(id)) return;
      pending.delete(id);
      settled = true;
      watch();
      input.onUndo?.();
      remove(id);
    };
    const commit = (): void => {
      if (settled || !pending.has(id)) return;
      finish(id);
    };
    const label = input.undoLabel ?? options.words()('hub.toast.undo');
    show({ id, text: input.text, tone: 'neutral', action: { label, run: undo }, ms: input.ms ?? UNDO_MS, held: true });
    return { undo, commit };
  };

  const pause = (id: number): void => {
    const clock = clocks.get(id);
    if (clock === undefined || clock.startedAt === null) return;
    timers.clearTimeout(clock.timer);
    clock.left = Math.max(0, clock.left - (timers.now() - clock.startedAt));
    clock.startedAt = null;
  };
  const resume = (id: number): void => {
    const clock = clocks.get(id);
    if (clock === undefined || clock.startedAt !== null) return;
    arm(id, clock);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopWatching?.();
    stopWatching = null;
    const held = [...pending.values()];
    pending.clear();
    for (const id of [...clocks.keys()]) forget(id);
    for (const entry of held) {
      entry.settle();
      void Promise.resolve()
        .then(entry.run)
        .catch(() => undefined);
    }
    store.set([]);
  };

  return { subscribe: store.subscribe, getSnapshot: store.getSnapshot, push, hold, dismiss: finish, pause, resume, dispose };
}
