import type { PageSource, Timers } from '../../src/headless/env.js';
import { createHubController } from '../../src/headless/controller.js';
import type { HubControllerOptions } from '../../src/headless/controller.js';
import { hubWorld } from '../world.js';
import type { WorldOptions } from '../world.js';

// What the controller's tests stand on: timers that only move when the test moves them, and a page the test can hide, close, or
// take offline. No DOM and no global fake timers: the controller is handed both, as an adopter's runtime would.

export interface ManualTimers extends Timers {
  /** Moves the clock forward, running every timer that falls due, in order, letting the real routes answer between them. */
  advance(ms: number): Promise<void>;
  /** How many timers (timeouts and intervals) are waiting. */
  count(): number;
  /** Where the clock is, in ms since the test began. */
  readonly at: number;
}

/** Lets what is already queued run: the real routes answer in microtasks and a few macrotasks. */
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function manualTimers(): ManualTimers {
  let clock = 0;
  let next = 0;
  const waiting = new Map<number, { due: number; every: number | null; run: () => void }>();
  const timers: ManualTimers = {
    setTimeout(run, ms) {
      const id = ++next;
      waiting.set(id, { due: clock + ms, every: null, run });
      return id;
    },
    clearTimeout(handle) {
      waiting.delete(handle as number);
    },
    setInterval(run, ms) {
      const id = ++next;
      waiting.set(id, { due: clock + ms, every: ms, run });
      return id;
    },
    clearInterval(handle) {
      waiting.delete(handle as number);
    },
    now: () => clock,
    count: () => waiting.size,
    get at() {
      return clock;
    },
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        let id = -1;
        let first: { due: number; every: number | null; run: () => void } | undefined;
        for (const [k, w] of waiting) {
          if (w.due <= target && (first === undefined || w.due < first.due)) {
            id = k;
            first = w;
          }
        }
        if (first === undefined) break;
        clock = first.due;
        if (first.every === null) waiting.delete(id);
        else first.due += first.every;
        first.run();
        await settle();
      }
      clock = target;
    },
  };
  return timers;
}

export interface FakePage extends PageSource {
  hide(): void;
  show(): void;
  /** The page is going away. */
  close(): void;
  goOffline(): void;
  goOnline(): void;
  /** How many listeners are attached right now (a stopped controller leaves none). */
  listeners(): number;
}

export function fakePage(): FakePage {
  let visible = true;
  let online = true;
  const on = { visibility: new Set<() => void>(), hide: new Set<() => void>(), online: new Set<() => void>(), offline: new Set<() => void>() };
  const add = (set: Set<() => void>, l: () => void): (() => void) => {
    set.add(l);
    return () => {
      set.delete(l);
    };
  };
  const fire = (set: Set<() => void>): void => {
    for (const l of [...set]) l();
  };
  return {
    visible: () => visible,
    online: () => online,
    onVisibilityChange: (l) => add(on.visibility, l),
    onPageHide: (l) => add(on.hide, l),
    onOnline: (l) => add(on.online, l),
    onOffline: (l) => add(on.offline, l),
    hide() {
      visible = false;
      fire(on.visibility);
    },
    show() {
      visible = true;
      fire(on.visibility);
    },
    close: () => fire(on.hide),
    goOffline() {
      online = false;
      fire(on.offline);
    },
    goOnline() {
      online = true;
      fire(on.online);
    },
    listeners: () => on.visibility.size + on.hide.size + on.online.size + on.offline.size,
  };
}

// ---- a controller over the real staff routes -------------------------------------------------------------------------------


export interface RigOptions {
  world?: WorldOptions;
  controller?: Partial<HubControllerOptions>;
}

/** The real routes over the in-memory store, a controller on them, and the timers and page the test moves. */
export async function rig(options: RigOptions = {}) {
  const w = await hubWorld(options.world);
  const timers = manualTimers();
  const page = fakePage();
  const controller = createHubController({ client: w.client, now: w.now, schedule: timers, page, ...options.controller });
  /** The requests of one kind sent so far (`GET /changes`, `POST /cases/x/claim`, ...). */
  const count = (method: string, path: string | RegExp): number =>
    w.sent.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))).length;
  return { w, timers, page, controller, count };
}
export type Rig = Awaited<ReturnType<typeof rig>>;
