import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CaseProvider } from './case/CaseContext.js';
import { CaseSession, useCaseActions } from './cases.js';
import type { CommandTarget } from './commands.js';
import { useHub } from './context.js';
import type { HubClient } from './client.js';
import type { HubHost } from './headless/controller.js';
import type { HubT } from './i18n.js';
import { useOptionalQueue } from './liveQueue.js';
import { useMode } from './mode.js';
import type { HubMode } from './mode.js';
import { permissionFor } from './nav.js';
import { HubRoot } from './provider.js';
import { buildPath, hashRouter, memoryRouter, parseRoute } from './router.js';
import type { HubRouter, Route } from './router.js';
import { screenFor } from './screens/index.js';
import { ConnectionBanner } from './shell/Banner.js';
import { CasePanel } from './shell/CasePanel.js';
import { CommandBar } from './shell/CommandBar.js';
import { QueuePane } from './shell/QueuePane.js';
import { Rail } from './shell/Rail.js';
import { ShortcutSheet } from './shell/ShortcutSheet.js';
import { TopBar } from './shell/TopBar.js';
import { shortcutFor } from './shortcuts.js';
import { Link } from './ui.js';

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
  /** Your game's name, shown beside the product name in the top bar. Default: none. */
  gameName?: string;
  /** Set `false` to turn every keyboard shortcut off (J, K, N, ?, Ctrl or Cmd+K, Escape), for a page that has its own. Default `true`. */
  shortcuts?: boolean;
  /**
   * `simple` is one card per case with the suggestion one click away (for a team of one or two); `detailed` is the full workbench.
   * Set it to fix the mode and hide the Simple/Detailed switch. Left out, each moderator's last choice is kept in their browser,
   * and a browser that cannot keep it (or has none) gets `simple`.
   */
  mode?: HubMode;
}

const noopSubscribe = (): (() => void) => () => undefined;

/**
 * The moderator hub, a team workbench: a {@link HubProvider} (which asks `GET /me` first and owns the controller) and the shell that
 * lays out three panes for what the signed-in role can use: the queue of open cases, the screen or case in the middle, and (beside
 * an open case) who is handling it. Pass a `client`; everything else has a default. To put single parts of it in your own page,
 * use `HubProvider` and the pieces instead.
 */
export function Hub({ client, t, locale = 'en', router: routerProp, theme, onNavigate, now, className, gameName, shortcuts = true, mode }: HubProps) {
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

  // The router is the controller's host: it says which report is open and brings the moderator to one.
  const routerRef = useRef(router);
  routerRef.current = router;
  const shell = useMemo(
    () => ({
      router,
      host: {
        openReport: () => {
          const at = parseRoute(routerRef.current.path);
          return at.name === 'report' ? at.id : null;
        },
        show: (id: string) => routerRef.current.navigate(buildPath({ name: 'report', id })),
      } satisfies HubHost,
    }),
    [router],
  );

  return (
    <HubRoot client={client} controller={undefined} t={t} locale={locale} now={now} theme={theme} className={className} shortcuts={shortcuts} mode={mode} shell={shell}>
      <Shell route={route} gameName={gameName} shortcuts={shortcuts} />
    </HubRoot>
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

type Dialogs = null | 'command' | 'shortcuts';

/** The workbench: top bar, rail, queue, the screen, the case panel, and the windows and shortcuts that work across them. */
function Shell({ route, gameName, shortcuts }: { route: Route; gameName: string | undefined; shortcuts: boolean }) {
  const { t, can } = useHub();
  const simple = useMode().mode === 'simple';
  const queue = useOptionalQueue();
  const mainRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [announcement, setAnnouncement] = useState('');

  // A screen is its route name, plus the id for a report or person. A query change (the status filter) keeps the same screen
  // mounted, so the control the person just used keeps keyboard focus.
  const screenKey = screenKeyOf(route);
  const shownBefore = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownBefore.current;
    shownBefore.current = screenKey;
    // Not on the first screen: the person has not moved anywhere yet.
    if (previous === null || previous === screenKey) return;
    const heading = mainRef.current?.querySelector<HTMLElement>('.cw-screen-title');
    if (heading === null || heading === undefined) return;
    heading.focus();
    setAnnouncement(heading.textContent ?? '');
  }, [screenKey]);

  const needed = permissionFor(route);
  const allowed = needed === null || can(needed);
  const hasQueue = queue !== null;
  const reportId = route.name === 'report' ? route.id : null;
  // An open case shares one read of the report, the person's record and the decision form between the case pane and the pane beside it.
  const inCase = reportId !== null && allowed;
  const workContent = (
    <>
      <main className="cw-main" ref={mainRef} tabIndex={-1} key={screenKey}>
        {route.name === 'notFound' ? (
          <NotFound />
        ) : allowed ? (
          screenFor(route, simple)
        ) : (
          <div className="cw-screen">
            <div className="cw-empty">
              <h2 className="cw-screen-title" tabIndex={-1}>
                {t('hub.route.noAccess.title')}
              </h2>
              <p>{t('hub.route.noAccess.body')}</p>
            </div>
          </div>
        )}
      </main>
      {inCase && !simple && <CasePanel />}
    </>
  );

  return (
    <>
      <button type="button" className="cw-skip" onClick={() => mainRef.current?.focus()}>
        {t('hub.skip')}
      </button>
      <TopBar route={route} gameName={gameName} shortcuts={shortcuts} onCommand={() => setDialog('command')} />
      <ConnectionBanner />
      <div
        className="cw-body"
        ref={bodyRef}
        data-mode={simple ? 'simple' : 'detailed'}
        data-queue={hasQueue ? 'true' : 'false'}
        data-case={hasQueue && reportId !== null && !simple ? 'true' : 'false'}
      >
        {!simple && <Rail route={route} />}
        {hasQueue && <QueuePane route={route} shortcuts={shortcuts} />}
        <div className="cw-work">
          {inCase && reportId !== null ? (
            <CaseProvider key={reportId} reportId={reportId}>
              {workContent}
            </CaseProvider>
          ) : (
            workContent
          )}
        </div>
      </div>
      {hasQueue && reportId !== null && allowed && <CaseSession reportId={reportId} />}
      <div className="cw-sr" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {shortcuts && <Shortcuts bodyRef={bodyRef} dialogOpen={dialog !== null} open={setDialog} />}
      {dialog === 'command' && <CommandWindow shortcuts={shortcuts} onClose={() => setDialog(null)} open={setDialog} />}
      {dialog === 'shortcuts' && <ShortcutSheet onClose={() => setDialog(null)} />}
    </>
  );
}

/** Runs what the command bar chose, after the bar has closed. */
function CommandWindow({ shortcuts, onClose, open }: { shortcuts: boolean; onClose: () => void; open: (d: Dialogs) => void }) {
  const { go } = useHub();
  const actions = useCaseActions();
  const choose = (target: CommandTarget): void => {
    onClose();
    if (target.type === 'go') go(target.route);
    else if (target.type === 'shortcuts') open('shortcuts');
    else void actions.takeNext();
  };
  return <CommandBar shortcuts={shortcuts} onClose={onClose} onChoose={choose} />;
}

/** The one page-wide key listener. See `shortcutFor` for what each key means and when it stays quiet. */
function Shortcuts({ bodyRef, dialogOpen, open }: { bodyRef: { current: HTMLDivElement | null }; dialogOpen: boolean; open: (d: Dialogs) => void }) {
  const { can } = useHub();
  const actions = useCaseActions();
  const latest = useRef({ dialogOpen, canTake: can('reports.decide'), actions });
  latest.current = { dialogOpen, canTake: can('reports.decide'), actions };

  useEffect(() => {
    const rows = (): HTMLElement[] => [...(bodyRef.current?.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link') ?? [])];
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = shortcutFor(e);
      if (action === null) return;
      const state = latest.current;
      // A window is open: it has its own keys (Escape closes it) and the page behind it is not the target.
      if (state.dialogOpen) return;
      if (action === 'command') {
        e.preventDefault();
        open('command');
      } else if (action === 'help') {
        e.preventDefault();
        open('shortcuts');
      } else if (action === 'takeNext') {
        if (!state.canTake) return;
        e.preventDefault();
        void state.actions.takeNext();
      } else if (action === 'next' || action === 'previous') {
        const list = rows();
        if (list.length === 0) return;
        e.preventDefault();
        const active = document.activeElement;
        let at = list.findIndex((r) => r === active);
        if (at < 0) at = list.findIndex((r) => r.getAttribute('aria-current') === 'true');
        const to = at < 0 ? (action === 'next' ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + (action === 'next' ? 1 : -1)));
        list[to]?.focus();
      } else {
        // Escape with no window open: back to the queue, on the open case's row or the first one.
        const list = rows();
        const target = list.find((r) => r.getAttribute('aria-current') === 'true') ?? list[0];
        if (target !== undefined && document.activeElement !== target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [bodyRef, open]);

  return null;
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
