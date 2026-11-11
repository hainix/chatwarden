import type { ReportStatus } from './types.js';

/** What the Reports screen filters on. `all` leaves the status filter out. */
export type QueueStatus = ReportStatus | 'all';

/** The screens the hub has. `notFound` is a path that matches none of them. */
export type Route =
  | { name: 'overview' }
  | { name: 'reports'; status: QueueStatus }
  | { name: 'report'; id: string }
  | { name: 'person'; ref: string }
  | { name: 'terms' }
  | { name: 'blocked' }
  | { name: 'gaps' }
  | { name: 'audit' }
  | { name: 'guide' }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'actions' }
  | { name: 'notFound'; path: string };

/** The sections of the settings screen (`#/settings/ladder`). A later section is another entry here and another panel on the screen. */
export type SettingsSection = 'ladder';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['ladder'];

/** The tabs. A report and a person live under Reports. */
export type TabName = 'overview' | 'reports' | 'blocked' | 'terms' | 'gaps' | 'audit' | 'guide' | 'settings';

/**
 * How the hub learns where it is and moves. The default is the URL hash (`#/reports`). To use your own router, pass an
 * object whose `path` is the current hub path (`/reports/abc`, with no `#`) and whose `navigate` moves there, and render the
 * hub again when the path changes. An object that also has `subscribe` is listened to, so the hub follows without a parent
 * render. `href` gives links their address (default `#` + path), so a link can open in a new tab.
 */
export interface HubRouter {
  readonly path: string;
  navigate(path: string): void;
  href?(path: string): string;
  subscribe?(listener: () => void): () => void;
}

const STATUSES: readonly QueueStatus[] = ['open', 'actioned', 'dismissed', 'all'];
// What the server accepts for an id or a person ref in a path (RouteParams): letters, digits, underscore and hyphen, 1-64.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `#/reports?x=1` -> `/reports?x=1`; an empty path is `/`. */
export function normalizePath(path: string): string {
  const stripped = path.replace(/^#/, '');
  if (stripped === '') return '/';
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The route for a hub path (with or without a leading `#`). Never throws: a path that fits no screen is `notFound`. */
export function parseRoute(path: string): Route {
  const normal = normalizePath(path);
  const notFound: Route = { name: 'notFound', path: normal };
  const [pathname = '/', query = ''] = normal.split('?', 2) as [string, string?];
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const parts = trimmed.split('/').slice(1);
  if (trimmed === '/' || trimmed === '') return { name: 'overview' };
  const [first, second, ...rest] = parts;
  if (rest.length > 0 || first === undefined || first === '') return notFound;

  const idOf = (segment: string | undefined): string | null => {
    if (segment === undefined) return null;
    const value = decode(segment);
    return value !== null && ID.test(value) ? value : null;
  };

  switch (first) {
    case 'reports': {
      if (second === undefined) {
        const status = new URLSearchParams(query).get('status');
        return { name: 'reports', status: STATUSES.find((s) => s === status) ?? 'open' };
      }
      const id = idOf(second);
      return id === null ? notFound : { name: 'report', id };
    }
    case 'people': {
      const ref = idOf(second);
      return ref === null ? notFound : { name: 'person', ref };
    }
    case 'terms':
    case 'blocked':
    case 'gaps':
    case 'audit':
    case 'guide':
    case 'actions':
      return second === undefined ? { name: first } : notFound;
    case 'settings': {
      if (second === undefined) return { name: 'settings', section: 'ladder' };
      const section = SETTINGS_SECTIONS.find((x) => x === second);
      return section === undefined ? notFound : { name: 'settings', section };
    }
    default:
      return notFound;
  }
}

/** The hub path for a route. `parseRoute(buildPath(route))` is `route`. */
export function buildPath(route: Route): string {
  switch (route.name) {
    case 'overview':
      return '/';
    case 'reports':
      return route.status === 'open' ? '/reports' : `/reports?status=${route.status}`;
    case 'report':
      return `/reports/${encodeURIComponent(route.id)}`;
    case 'person':
      return `/people/${encodeURIComponent(route.ref)}`;
    case 'notFound':
      return route.path;
    case 'settings':
      return `/settings/${route.section}`;
    default:
      return `/${route.name}`;
  }
}

/** Which tab a route belongs to, or null (a path that matches nothing lights no tab). */
export function tabOf(route: Route): TabName | null {
  switch (route.name) {
    case 'overview':
    case 'actions':
      return 'overview';
    case 'reports':
    case 'report':
    case 'person':
      return 'reports';
    case 'terms':
    case 'blocked':
    case 'gaps':
    case 'audit':
    case 'guide':
    case 'settings':
      return route.name;
    case 'notFound':
      return null;
  }
}

/** A router that tells the hub when it moves and gives links their addresses: what {@link hashRouter} and {@link memoryRouter} are. */
export interface ObservableRouter extends HubRouter {
  href(path: string): string;
  subscribe(listener: () => void): () => void;
}

export interface MemoryRouter extends ObservableRouter {
  /** Every path visited, oldest first. */
  readonly history: readonly string[];
  back(): void;
}

/** A router that keeps its path in memory: for tests and for a demo that must not touch the page's URL. */
export function memoryRouter(initial = '/'): MemoryRouter {
  const stack: string[] = [normalizePath(initial)];
  const listeners = new Set<() => void>();
  const move = (): void => {
    for (const fn of [...listeners]) fn();
  };
  return {
    get path() {
      return stack[stack.length - 1] as string;
    },
    get history() {
      return [...stack];
    },
    navigate(path) {
      const next = normalizePath(path);
      if (next === stack[stack.length - 1]) return;
      stack.push(next);
      move();
    },
    back() {
      if (stack.length < 2) return;
      stack.pop();
      move();
    },
    href: (path) => `#${normalizePath(path)}`,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The default router: the page's URL hash. Several hubs on one page would share it; pass your own router for that. */
export function hashRouter(win: Window = window): ObservableRouter {
  return {
    get path() {
      return normalizePath(win.location.hash);
    },
    navigate(path) {
      win.location.hash = `#${normalizePath(path)}`;
    },
    href: (path) => `#${normalizePath(path)}`,
    subscribe(listener) {
      win.addEventListener('hashchange', listener);
      return () => win.removeEventListener('hashchange', listener);
    },
  };
}
