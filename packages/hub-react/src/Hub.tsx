import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { HubClient, HubError } from './client.js';
import { HubContext, useHub } from './context.js';
import type { HubContextValue } from './context.js';
import { useHubData } from './hooks.js';
import { createT, en } from './i18n.js';
import type { HubT, HubText } from './i18n.js';
import { errorText } from './labels.js';
import { permissionFor, TABS } from './nav.js';
import { buildPath, hashRouter, memoryRouter, parseRoute, tabOf } from './router.js';
import type { HubRouter, Route } from './router.js';
import { screenFor } from './screens/index.js';
import type { Me, PermissionKey, Role } from './types.js';
import { Link, Tag } from './ui.js';

export interface HubProps {
  /** The staff client: `createHubClient(fetchTransport({ baseUrl: '/admin' }))`. Create it once, outside render. */
  client: HubClient;
  /** The words. Default: English, in the `locale`. Build your own with `createT({ ...en, ...yours }, locale)`. */
  t?: HubT;
  /** BCP 47 tag for dates and numbers, and for the default English words' plural rules. Default `en`. */
  locale?: string;
  /** Where the hub is and how it moves. Default: the URL hash. See {@link HubRouter}. */
  router?: HubRouter;
  /** `light` or `dark` forces a theme; `auto` (default) follows the visitor's `prefers-color-scheme`. */
  theme?: 'light' | 'dark' | 'auto';
  /** Called with the route and its path when the hub first shows and each time the route changes. */
  onNavigate?: (route: Route, path: string) => void;
  /** The clock for "5 minutes ago". Default: `Date.now`. */
  now?: () => number;
  /** Extra class names for the root element. */
  className?: string;
}

const ROLE_LABEL: Record<Role, HubText> = {
  moderator: 'hub.session.role.moderator',
  senior: 'hub.session.role.senior',
  owner: 'hub.session.role.owner',
};

const noopSubscribe = (): (() => void) => () => undefined;
const cx = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

// A hub is told its client through a prop; this gives each client object a number so a new client reloads `GET /me`.
const clientIds = new WeakMap<object, number>();
let nextClientId = 0;
function clientId(client: object): number {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = ++nextClientId;
    clientIds.set(client, id);
  }
  return id;
}

/**
 * The moderator hub. It asks `GET /me` first and shows only what the signed-in role can use: tabs for the screens, then the
 * screen for the current route. Pass a `client`; everything else has a default.
 */
export function Hub({ client, t: tProp, locale = 'en', router: routerProp, theme, onNavigate, now, className }: HubProps) {
  const t = useMemo(() => tProp ?? createT(en, locale), [tProp, locale]);
  const fallbackRouter = useMemo(() => (typeof window === 'undefined' ? memoryRouter('/') : hashRouter()), []);
  const router = routerProp ?? fallbackRouter;
  const subscribe = useCallback((listener: () => void) => router.subscribe?.(listener) ?? noopSubscribe(), [router]);
  const path = useSyncExternalStore(subscribe, () => router.path, () => router.path);
  const route = useMemo(() => parseRoute(path), [path]);

  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    onNavigateRef.current?.(route, path);
    // Once per path: a new route object for the same path is not a navigation.
  }, [path]);

  const me = useHubData(`me:${clientId(client)}`, () => client.me());

  const routerRef = useRef(router);
  routerRef.current = router;
  const value = useMemo<HubContextValue | null>(() => {
    if (me.data === undefined) return null;
    const meData: Me = me.data;
    return {
      client,
      t,
      locale,
      now: now ?? Date.now,
      router,
      me: meData,
      can: (permission: PermissionKey) => meData.can[permission] === true,
      go: (to) => routerRef.current.navigate(buildPath(to)),
      href: (to) => {
        const p = buildPath(to);
        return routerRef.current.href?.(p) ?? `#${p}`;
      },
    };
  }, [client, t, locale, now, router, me.data]);

  const mainRef = useRef<HTMLElement | null>(null);

  // A screen is its route name, plus the id for a report or person. A query change (the status filter) keeps the same screen
  // mounted, so the control the person just used keeps keyboard focus.
  const screenKey = screenKeyOf(route);
  const ready = value !== null;
  const shownBefore = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!ready) return;
    const previous = shownBefore.current;
    shownBefore.current = screenKey;
    // Not on the first screen: the person has not moved anywhere yet.
    if (previous === null || previous === screenKey) return;
    const heading = mainRef.current?.querySelector<HTMLElement>('.cw-screen-title');
    if (heading === null || heading === undefined) return;
    heading.focus();
    setAnnouncement(heading.textContent ?? '');
  }, [ready, screenKey]);

  let content: ReactNode;
  if (value === null) {
    content = <Gate t={t} error={me.error} loading={me.loading} onRetry={me.reload} />;
  } else {
    const needed = permissionFor(route);
    const allowed = needed === null || value.can(needed);
    const current = tabOf(route);
    content = (
      <HubContext.Provider value={value}>
        <button type="button" className="cw-skip" onClick={() => mainRef.current?.focus()}>
          {t('hub.skip')}
        </button>
        <header className="cw-head">
          <h1 className="cw-title">{t('hub.title')}</h1>
          <div className="cw-who" role="group" aria-label={t('hub.session.label')}>
            <span className="cw-actor">{value.me.actor}</span>
            <Tag tone="accent">{t(ROLE_LABEL[value.me.role])}</Tag>
          </div>
        </header>
        <nav className="cw-nav" aria-label={t('hub.nav.label')}>
          <ul className="cw-tabs">
            {TABS.filter((tab) => tab.permission === null || value.can(tab.permission)).map((tab) => (
              <li key={tab.tab}>
                <Link to={tab.route} {...(current === tab.tab ? { 'aria-current': 'page' as const } : {})}>
                  {t(tab.label)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="cw-main" ref={mainRef} tabIndex={-1} key={screenKey}>
          {route.name === 'notFound' ? (
            <NotFound />
          ) : allowed ? (
            screenFor(route)
          ) : (
            <div className="cw-screen">
              <div className="cw-empty">
                <h2 className="cw-screen-title" tabIndex={-1}>{t('hub.route.noAccess.title')}</h2>
                <p>{t('hub.route.noAccess.body')}</p>
              </div>
            </div>
          )}
        </main>
        <div className="cw-sr" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </HubContext.Provider>
    );
  }

  return (
    <div className={cx('cw-hub', className)} {...(theme === 'light' || theme === 'dark' ? { 'data-cw-theme': theme } : {})}>
      {content}
    </div>
  );
}

/** What identifies a screen: the route, and for one report or one person, which. */
function screenKeyOf(route: Route): string {
  switch (route.name) {
    case 'report':
      return `report:${route.id}`;
    case 'person':
      return `person:${route.ref}`;
    case 'notFound':
      return `notFound:${route.path}`;
    default:
      return route.name;
  }
}

function NotFound() {
  const { t } = useHub();
  return (
    <div className="cw-screen">
      <div className="cw-empty">
        <h2 className="cw-screen-title" tabIndex={-1}>{t('hub.route.notFound.title')}</h2>
        <p>{t('hub.route.notFound.body')}</p>
        <Link to={{ name: 'overview' }} className="cw-link">
          {t('hub.route.notFound.back')}
        </Link>
      </div>
    </div>
  );
}

/** What shows before the hub knows who is signed in: loading, a sign-in message, no access, or a failed start. */
function Gate({ t, error, loading, onRetry }: { t: HubT; error: HubError | null; loading: boolean; onRetry: () => void }) {
  if (error === null) {
    return (
      <div className="cw-gate">
        <p role="status">{loading ? t('hub.gate.loading') : ''}</p>
      </div>
    );
  }
  if (error.status === 401) {
    return (
      <main className="cw-gate">
        <h1>{t('hub.gate.unauthorized.title')}</h1>
        <p>{t('hub.gate.unauthorized.body')}</p>
      </main>
    );
  }
  if (error.status === 403) {
    return (
      <main className="cw-gate">
        <h1>{t('hub.gate.forbidden.title')}</h1>
        <p>{t('hub.gate.forbidden.body')}</p>
      </main>
    );
  }
  return (
    <main className="cw-gate">
      <h1>{t('hub.gate.failed.title')}</h1>
      <p role="alert">{errorText(t, error)}</p>
      <button type="button" className="cw-btn" onClick={onRetry}>
        {t('hub.state.retry')}
      </button>
    </main>
  );
}
