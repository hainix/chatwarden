import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CaseProvider } from './case/CaseContext.js';
import { CaseSession, useCaseActions } from './cases.js';
import type { CommandTarget } from './commands.js';
import { useHub } from './context.js';
import { useOptionalDecisions } from './decisions.js';
import { activeOf, modalIn } from './dom.js';
import { MOVING_ATTRIBUTE } from './case/actGuard.js';
import { LazyCommandBar, LazyShortcutSheet, preloadShellParts } from './lazyParts.js';
import type { HubClient } from './client.js';
import type { HubController, HubHost } from './headless/controller.js';
import type { HubT } from './i18n.js';
import { useKeyListener } from './keyScope.js';
import { useOptionalQueue } from './liveQueue.js';
import { useMode } from './mode.js';
import type { HubMode } from './mode.js';
import { permissionFor } from './nav.js';
import { useQuickKeys } from './quickKeys.js';
import { HubRoot } from './provider.js';
import { buildPath, hashRouter, memoryRouter, parseRoute } from './router.js';
import type { HubRouter, Route } from './router.js';
import { screenFor } from './screens/index.js';
import { ScreenShown, isFocusFree } from './screens/lazy.js';
import { ConnectionBanner } from './shell/Banner.js';
import { CasePanel } from './shell/CasePanel.js';
import { QueuePane } from './shell/QueuePane.js';
import { Rail } from './shell/Rail.js';
import { TopBar } from './shell/TopBar.js';
import { QUEUE_OPEN_DELAY_MS, shortcutFor } from './shortcuts.js';
import { useToasts } from './toasts.js';
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
   * Which hub answers a key when nothing on the page has focus (as after load). The only hub with shortcuts on always does; with
   * several on a page, only the one marked `primary` does, and with none marked, none does. A hub always answers the keys pressed
   * while focus is inside it, primary or not. Default `false`.
   */
  primary?: boolean;
  /**
   * `simple` is one card per case with the suggestion one click away (for a team of one or two); `detailed` is the full workbench.
   * Set it to fix the mode and hide the Simple/Detailed switch. Left out, each moderator's last choice is kept in their browser,
   * and a browser that cannot keep it (or has none) gets `simple`.
   */
  mode?: HubMode;
  /**
   * Called with the hub's controller once it exists, and again if it is replaced (a new `client`). Keep it and call
   * `controller.refresh()` to have the hub read its queue now, when your page knows something just changed. The controller is the hub's own:
   * do not `dispose()` it. It is the same headless controller as `@chatwarden/hub-react/headless`, and `refresh` only reads.
   * @experimental
   */
  onController?: (controller: HubController) => void;
}

const noopSubscribe = (): (() => void) => () => undefined;

/**
 * The moderator hub, a team workbench: a {@link HubProvider} (which asks `GET /me` first and owns the controller) and the shell that
 * lays out three panes for what the signed-in role can use: the queue of open cases, the screen or case in the middle, and (beside
 * an open case) who is handling it. Pass a `client`; everything else has a default. To put single parts of it in your own page,
 * use `HubProvider` and the pieces instead.
 */
export function Hub({ client, t, locale = 'en', router: routerProp, theme, onNavigate, now, className, gameName, shortcuts = true, primary = false, mode, onController }: HubProps) {
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
    <HubRoot client={client} controller={undefined} t={t} locale={locale} now={now} theme={theme} className={className} shortcuts={shortcuts} primary={primary} mode={mode} shell={shell} onController={onController}>
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
    case 'settings':
      return `settings:${route.section}`;
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
  // The command bar, the sheet and the sweep window are fetched just after the first paint, so the first Ctrl+K or ? is not waiting for code.
  const mayCloseMany = can('reports.decide.bulk');
  useEffect(() => preloadShellParts(mayCloseMany), [mayCloseMany]);

  // A screen is its route name, plus the id for a report or person. A query change (the status filter) keeps the same screen
  // mounted, so the control the person just used keeps keyboard focus.
  const screenKey = screenKeyOf(route);
  const shownBefore = useRef<string | null>(null);
  // The person moved to a screen and its heading has not yet had the focus: a screen that loads on demand arrives after the move.
  const focusPending = useRef(false);
  /** Where focus was when the person moved: a closing window has just given it back, and a screen that arrives later may still take it from there. */
  const focusAtMove = useRef<Element | null>(null);
  const focusHeading = useCallback((failed?: HTMLElement): void => {
    // The screen's heading, or (a screen that could not load) the error that stands in its place.
    const target = failed ?? mainRef.current?.querySelector<HTMLElement>('.cw-screen-title') ?? null;
    if (target === null) return;
    focusPending.current = false;
    target.focus();
    setAnnouncement(failed === undefined ? (target.textContent ?? '') : (failed.querySelector('strong')?.textContent ?? ''));
  }, []);
  useEffect(() => {
    const previous = shownBefore.current;
    shownBefore.current = screenKey;
    // Not on the first screen: the person has not moved anywhere yet.
    if (previous === null || previous === screenKey) return;
    focusPending.current = true;
    focusAtMove.current = activeOf(mainRef.current);
    focusHeading();
  }, [screenKey, focusHeading]);
  // A lazy screen has come in (or failed to) after the person moved here. It takes the focus only if the focus is still nowhere: a
  // moderator who has since opened the command bar, tabbed into the queue or started typing keeps it where they put it.
  const onScreenShown = useCallback(
    (failed?: HTMLElement): void => {
      if (!focusPending.current) return;
      if (!isFocusFree(mainRef.current, focusAtMove.current)) {
        focusPending.current = false;
        return;
      }
      focusHeading(failed);
    },
    [focusHeading],
  );

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
          <ScreenShown.Provider value={onScreenShown}>{screenFor(route, simple)}</ScreenShown.Provider>
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
      {dialog === 'shortcuts' && <LazyShortcutSheet onClose={() => setDialog(null)} />}
    </>
  );
}

/** Runs what the command bar chose, after the bar has closed. */
function CommandWindow({ shortcuts, onClose, open }: { shortcuts: boolean; onClose: () => void; open: (d: Dialogs) => void }) {
  const { go } = useHub();
  const actions = useCaseActions();
  const undo = useUndo();
  const choose = (target: CommandTarget): void => {
    onClose();
    if (target.type === 'go') go(target.route);
    else if (target.type === 'shortcuts') open('shortcuts');
    else if (target.type === 'undo') undo();
    else void actions.takeNext();
  };
  return <LazyCommandBar shortcuts={shortcuts} onClose={onClose} onChoose={choose} />;
}

/**
 * Undoes the newest decision (or sweep) still in its Undo window and says so; the moderator is taken back to its case. Does nothing,
 * and says nothing, when none is waiting. Answers whether something was undone.
 */
function useUndo(): () => boolean {
  const { t } = useHub();
  const decisions = useOptionalDecisions();
  const toasts = useToasts();
  return () => {
    if (decisions === null) return false;
    const id = decisions.undoLatest();
    if (id === null) return false;
    toasts.push({ text: t('hub.toast.undone', { who: decisions.entry(id)?.name ?? '' }) });
    return true;
  };
}

/** The hub's one key listener, on the hub's own root: it hears a key pressed while focus is inside this hub (or, with nothing focused on the page, the one the page gives it: see `registerHub`). See `shortcutFor` for what each key means and when it stays quiet. */
function Shortcuts({ bodyRef, dialogOpen, open }: { bodyRef: { current: HTMLDivElement | null }; dialogOpen: boolean; open: (d: Dialogs) => void }) {
  const { can } = useHub();
  const actions = useCaseActions();
  const undo = useUndo();
  const listen = useKeyListener();
  const quickKeys = useQuickKeys().on;
  const latest = useRef({ dialogOpen, canTake: can('reports.decide'), actions, undo, quickKeys });
  latest.current = { dialogOpen, canTake: can('reports.decide'), actions, undo, quickKeys };

  useEffect(() => {
    // With Quick keys on, a move opens the case it ends on once the key has been still for a moment (a held key passes the rows in
    // between without claiming them). Another move, a click, Escape or the hub going away cancels it.
    let pending: ReturnType<typeof setTimeout> | null = null;
    // While a move is pending the hub's root says so, and no act key acts (it would act on the case being left).
    let moving: HTMLElement | null = null;
    const cancel = (): void => {
      if (pending !== null) clearTimeout(pending);
      pending = null;
      moving?.removeAttribute(MOVING_ATTRIBUTE);
      moving = null;
    };
    const body = bodyRef.current;
    body?.addEventListener('click', cancel, true);
    const rows = (): HTMLElement[] => [...(bodyRef.current?.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link') ?? [])];
    const onKeyDown = (e: KeyboardEvent, root: HTMLElement): void => {
      // Behind any window of this hub (the command bar, the sheet, a confirmation, the unsaved-changes guard) no key acts on the page.
      if (modalIn(root) !== null) return;
      const action = shortcutFor(e);
      if (action === null) return;
      const state = latest.current;
      // A window is open: it has its own keys (Escape closes it) and the page behind it is not the target.
      if (state.dialogOpen) return;
      if (action !== 'next' && action !== 'previous') cancel();
      if (action === 'command') {
        e.preventDefault();
        open('command');
      } else if (action === 'undo') {
        if (state.undo()) e.preventDefault();
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
        // The focus of the root the hub is in: inside a shadow root, the page's `activeElement` is only the host.
        const active = activeOf(bodyRef.current);
        let at = list.findIndex((r) => r === active);
        if (at < 0) at = list.findIndex((r) => r.getAttribute('aria-current') === 'true');
        const to = at < 0 ? (action === 'next' ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + (action === 'next' ? 1 : -1)));
        const row = list[to];
        row?.focus();
        cancel();
        if (state.quickKeys && row !== undefined) {
          moving = root;
          root.setAttribute(MOVING_ATTRIBUTE, '');
          pending = setTimeout(() => {
            const go = row.isConnected && activeOf(bodyRef.current) === row;
            cancel();
            // Only the row the cursor is still on: a moderator who has gone elsewhere is not taken somewhere by a timer.
            if (go) row.click();
          }, QUEUE_OPEN_DELAY_MS);
        }
      } else {
        // Escape with no window open: back to the queue, on the open case's row or the first one.
        const list = rows();
        const target = list.find((r) => r.getAttribute('aria-current') === 'true') ?? list[0];
        if (target !== undefined && activeOf(bodyRef.current) !== target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    const stop = listen(onKeyDown);
    return () => {
      stop();
      cancel();
      body?.removeEventListener('click', cancel, true);
    };
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
