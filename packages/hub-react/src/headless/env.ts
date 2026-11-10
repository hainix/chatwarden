import type { HubError } from '../client.js';

// What the controller needs from the runtime it is in, behind two small interfaces so it can be tested with no DOM and run where
// there is none (a worker, Node, a native shell). Both default to the browser's own, looked up when called, so a test's fake timers
// and a test's events reach the controller.

/** The timers, and the clock that measures them. Every member is optional in `createHubController({ schedule })`. */
export interface Timers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Reads a clock to measure elapsed time with (a paused toast keeps what it had left). Default `Date.now`. */
  now(): number;
}

export const browserTimers: Timers = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as Parameters<typeof clearInterval>[0]),
  now: () => Date.now(),
};

/** What the page is doing: whether anyone is looking, whether there is a network, and when the page is going away. */
export interface PageSource {
  /** False while the tab is hidden. */
  visible(): boolean;
  /** False while the browser says it is offline. */
  online(): boolean;
  /** The tab was shown or hidden. Returns the function that stops listening. */
  onVisibilityChange(listener: () => void): () => void;
  /** The page is going away (`pagehide`). */
  onPageHide(listener: () => void): () => void;
  onOnline(listener: () => void): () => void;
  onOffline(listener: () => void): () => void;
}

const listen = (target: 'document' | 'window', type: string, listener: () => void): (() => void) => {
  const t = target === 'document' ? (typeof document === 'undefined' ? undefined : document) : typeof window === 'undefined' ? undefined : window;
  if (t === undefined) return () => undefined;
  t.addEventListener(type, listener);
  return () => t.removeEventListener(type, listener);
};

/** The browser's page: `document.visibilityState`, `navigator.onLine`, and their events. Outside a browser: always visible, always online. */
export const browserPage: PageSource = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  onVisibilityChange: (listener) => listen('document', 'visibilitychange', listener),
  onPageHide: (listener) => listen('window', 'pagehide', listener),
  onOnline: (listener) => listen('window', 'online', listener),
  onOffline: (listener) => listen('window', 'offline', listener),
};

/** How a command answers: the value, or the error. A command never throws for an outcome it expects (a 409, a 404, no network). */
export type ActionResult<R> = { ok: true; value: R } | { ok: false; error: HubError };
