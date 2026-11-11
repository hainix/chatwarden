import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { HubClient, HubError } from './client.js';
import type { HubContextValue } from './context.js';
import { HubContext } from './context.js';
import { ControllerContext, useOptionalController } from './controllerContext.js';
import { DecisionProvider } from './decisions.js';
import { createHubController } from './headless/controller.js';
import type { HubController, HubHost } from './headless/controller.js';
import { useHubData } from './hooks.js';
import { createT, en } from './i18n.js';
import { registerHub } from './dom.js';
import { KeyScope, useKeyBus } from './keyScope.js';
import { LeaveGuardContext } from './leaveGuard.js';
import type { LeaveGuard } from './leaveGuard.js';
import type { HubT } from './i18n.js';
import { errorText } from './labels.js';
import { QueueProvider } from './liveQueue.js';
import { ModeProvider, useModeState } from './mode.js';
import type { HubMode } from './mode.js';
import { bindRuntime, createRuntime } from './pieceRuntime.js';
import { buildPath, memoryRouter } from './router.js';
import type { HubRouter } from './router.js';
import { ToastProvider } from './toasts.js';
import type { Me, PermissionKey } from './types.js';

/**
 * What a provider takes besides where its controller comes from.
 * @experimental
 */
export interface HubProviderOptions {
  /** `simple` or `detailed`: what a `CaseList` row shows. Left out, each moderator's last choice is kept in their browser, and a browser that cannot keep it gets `simple`. */
  mode?: HubMode;
  /** The words. Default: English, in the `locale`. Build your own with `createT({ ...en, ...yours }, locale)`. */
  t?: HubT;
  /** BCP 47 tag for dates and numbers, and for the default English words' plural rules. Default `en`. */
  locale?: string;
  /** The clock for "5 minutes ago". Default: `Date.now`. */
  now?: () => number;
  /** `light` or `dark` forces a theme; `auto` (default) follows the visitor's `prefers-color-scheme`. Ignored with `bare`. */
  theme?: 'light' | 'dark' | 'auto';
  /** Set `false` to turn every keyboard shortcut off (a piece's keys, such as 1 and 2 on a case card), for a page that has its own. Default `true`. */
  shortcuts?: boolean;
  /**
   * Draw no wrapper. By default the provider puts its children in the `.cw-hub` theme root, so the pieces are styled where they sit.
   * With `bare`, you place the root: an element with the classes `cw-hub cw-hub--embed` (and, to force a theme, `data-cw-theme`).
   */
  bare?: boolean;
  /** Extra class names for the theme root. Ignored with `bare`. */
  className?: string;
}

/**
 * Where the provider's controller comes from: exactly one of a client (the provider makes and owns the controller) or a controller (yours).
 * @experimental
 */
export type HubControllerSource =
  | {
      /** The staff client: `createHubClient(fetchTransport({ baseUrl: '/admin' }))`. Create it once, outside render. The provider makes the controller, and disposes it when it unmounts. Its toasts ("Open the case", Undo of a case you left) open through the pieces' `onOpenCase` or `onOpenReport`, except for a case a piece is already showing. */
      client: HubClient;
      controller?: never;
    }
  | {
      /**
       * A controller you made with `createHubController` (see `@chatwarden/hub-react/headless`). The provider uses it and never disposes it: that is
       * yours to do. The pieces take their own hold on its queue (`queue.acquire`), so a `controller.start()` of yours keeps it running after they
       * unmount. What the controller starts by itself (the "Open the case" toast after a failed decision, Undo of a case the moderator left) goes to
       * the `host` you gave it, not to the pieces' callbacks: you own its navigation. What a piece does itself (Take next, decide and next) still calls
       * the piece's `onOpenCase` or `onOpenReport`, so do not also open the same case from your `host.show` for those.
       */
      controller: HubController;
      client?: never;
    };

/**
 * The props of `HubProvider`: a `client` or a `controller` (never both), and the options.
 * @experimental
 */
export type HubProviderProps = HubProviderOptions & HubControllerSource & { children?: ReactNode };

/** `useLayoutEffect` where there is a page to lay out; on a server (which runs no effects) a plain effect, so React 18 does not warn. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const cx = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

// A provider is told its client through a prop; this gives each client object a number so a new client reloads `GET /me`.
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

interface Made {
  client: HubClient;
  controller: HubController;
}

/**
 * One controller for as long as the provider is mounted with this client. A controller that was disposed (StrictMode runs the
 * cleanup once, in development) is replaced. With a controller of the adopter's, nothing is made and nothing is disposed.
 */
function useControllerOf(given: HubController | undefined, client: HubClient, make: () => Made['controller']): HubController {
  const own = given === undefined;
  const create = (): Made => ({ client, controller: make() });
  const [made, setMade] = useState<Made | null>(() => (own ? create() : null));
  let current = made;
  if (own && (current === null || current.client !== client)) {
    current = create();
    setMade(current);
  }
  const owned = own ? current?.controller : undefined;
  useEffect(() => {
    if (owned === undefined) return undefined;
    if (owned.disposed) {
      setMade(create());
      return undefined;
    }
    return () => owned.dispose();
    // `make` reads refs; a new client makes a new controller.
  }, [owned]);
  return given ?? (owned as HubController);
}

/** What the provider (and the hub's shell, which is made of it) is given besides the public props. */
export interface HubRootProps extends HubProviderOptions {
  /** `<Hub>`'s `primary` (not a provider option: pieces answer keys only while focus is inside them). */
  primary?: boolean;
  /** `<Hub>`'s `onController`: told the controller once it exists, and again if it is replaced. */
  onController?: ((controller: HubController) => void) | undefined;
  client: HubClient | undefined;
  controller: HubController | undefined;
  children?: ReactNode;
  /** The hub's shell: its router, the page-wide gate (a `<main>`), the queue always loading, and the root filling the viewport. */
  shell?: { router: HubRouter; host: HubHost } | undefined;
}

/** The provider and the hub's shell are one component: this. The shell passes its router and host; a provider placing pieces passes none. */
export function HubRoot({ client: clientProp, controller: given, mode: modeProp, t: tProp, locale = 'en', now, theme, shortcuts = true, primary = false, bare = false, className, shell, onController, children }: HubRootProps) {
  const client = given?.client ?? (clientProp as HubClient);
  const mode = useModeState(modeProp);
  const t = useMemo(() => tProp ?? createT(en, locale), [tProp, locale]);
  const inert = useMemo(() => memoryRouter('/'), []);
  const router = shell?.router ?? inert;
  const routerRef = useRef(router);
  routerRef.current = router;
  const nowRef = useRef(now ?? Date.now);
  nowRef.current = now ?? Date.now;
  const tRef = useRef(t);
  tRef.current = t;
  const guard = useRef<LeaveGuard | null>(null);
  // The hub's own root element hears the keys pressed inside it, in the shell (see keyScope.ts).
  const root = useRef<HTMLDivElement>(null);
  const keys = useKeyBus(root);
  const inShell = shell !== undefined;
  // A shell with shortcuts on tells the page it exists, for the keys pressed with nothing focused (see `registerHub` in dom.ts).
  useEffect(() => {
    const element = root.current;
    if (!inShell || !shortcuts || element === null) return;
    return registerHub(element, { dispatch: keys.bus.dispatch, primary });
  }, [inShell, shortcuts, primary, keys]);
  const hostRef = useRef(shell?.host);
  hostRef.current = shell?.host;

  // One controller per provider: the session cache, the toasts, the live queue, claims and decisions.
  const controller = useControllerOf(given, client, () => {
    // The hub's shell shows a case by its router; a provider placing pieces shows it by the pieces' callbacks (the runtime's host).
    const runtime = createRuntime();
    const made = createHubController({ client, now: () => nowRef.current(), t: tRef.current, host: hostRef.current ?? runtime.host });
    bindRuntime(made, runtime);
    return made;
  });

  // The page is told the controller once it exists, and again if it is replaced (a new client, or StrictMode's second mount). A
  // controller that has been disposed is never handed out. The latest callback is the one called; a new callback is not a new call.
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;
  useEffect(() => {
    if (!controller.disposed) onControllerRef.current?.(controller);
  }, [controller]);

  // Who is signed in: asked once per client, unless a controller of the adopter's already knows.
  const known = given?.me.getSnapshot() ?? null;
  const me = useHubData(`me:${clientId(client)}`, () => (known === null ? client.me() : Promise.resolve(known)));

  // The controller is told the words and who is signed in in a layout effect, not while rendering: a component that listens to
  // `controller.me` must not be updated during another's render. A layout effect runs before any passive effect, so the effects of
  // the parts below (which open the case and start the queue) already find it told. A controller of the adopter's keeps its own
  // words unless `t` was given.
  useIsomorphicLayoutEffect(() => {
    if (given === undefined || tProp !== undefined) controller.configure({ t });
    if (me.data !== undefined) controller.identify(me.data);
  }, [controller, t, me.data]);

  const session = controller.session;
  const value = useMemo<HubContextValue | null>(() => {
    if (me.data === undefined) return null;
    const meData: Me = me.data;
    return {
      client,
      t,
      locale,
      now: now ?? Date.now,
      router,
      session,
      shortcuts,
      me: meData,
      can: (permission: PermissionKey) => meData.can[permission] === true,
      go: (to) => {
        const move = (): void => routerRef.current.navigate(buildPath(to));
        // A screen with unsaved edits may take the move over and ask first.
        if (guard.current?.(move) !== true) move();
      },
      href: (to) => {
        const p = buildPath(to);
        return routerRef.current.href?.(p) ?? `#${p}`;
      },
    };
  }, [client, t, locale, now, router, session, shortcuts, me.data]);

  let content: ReactNode;
  if (value === null) {
    content = <Gate t={t} error={me.error} loading={me.loading} onRetry={me.reload} page={shell !== undefined} />;
  } else {
    const reads = value.can('reports.read');
    const inner = <DecisionProvider>{children}</DecisionProvider>;
    content = (
      <ControllerContext.Provider value={controller}>
        <HubContext.Provider value={value}>
          <LeaveGuardContext.Provider value={guard}>
            <ModeProvider value={mode}>
              <ToastProvider>{reads ? <QueueProvider run={shell !== undefined}>{inner}</QueueProvider> : inner}</ToastProvider>
            </ModeProvider>
          </LeaveGuardContext.Provider>
        </HubContext.Provider>
      </ControllerContext.Provider>
    );
  }

  if (bare) return <>{content}</>;
  // In the shell the root takes focus when a press lands on its empty space (tabIndex -1), so the keys keep working after a click
  // anywhere in the hub, and a closing window has somewhere in the hub to put focus.
  return (
    <div
      ref={root}
      className={cx('cw-hub', !inShell && 'cw-hub--embed', className)}
      {...(inShell ? { tabIndex: -1, onKeyDown: keys.onKeyDown } : {})}
      {...(theme === 'light' || theme === 'dark' ? { 'data-cw-theme': theme } : {})}
    >
      {inShell ? <KeyScope.Provider value={keys.bus}>{content}</KeyScope.Provider> : content}
    </div>
  );
}

/**
 * The one thing a piece needs above it. Give it a `client` and it makes, owns and disposes the controller (the live queue, claims,
 * the Undo hold and the toasts); give it a `controller` of your own and it uses that and never disposes it. It asks `GET /me` first
 * and shows a plain message until the answer is in (loading, signed out, no access, or a failed start with Try again).
 *
 * It draws the `.cw-hub` theme root around its children, so pieces are styled where they sit; `bare` draws none. Pieces under one
 * provider share one controller: one poll of the change token, one claim and heartbeat per case.
 *
 * ```tsx
 * <HubProvider client={client}>
 *   <CaseList onOpenCase={(person, reportId) => router.push(`/cases/${reportId}`)} />
 * </HubProvider>
 * ```
 * @experimental
 */
export function HubProvider(props: HubProviderProps) {
  const { client, controller, children, ...options } = props;
  return (
    <HubRoot client={client} controller={controller} {...options}>
      {children}
    </HubRoot>
  );
}

/**
 * The hub's controller, for the part of your page that wants the headless API (`decide`, `open`, the stores) next to the pieces.
 * Throws outside a `<HubProvider>` or `<Hub>`.
 * @experimental
 */
export function useHubController(): HubController {
  const controller = useOptionalController();
  if (controller === null) throw new Error('useHubController must be used inside <HubProvider> (or <Hub>)');
  return controller;
}

/** What shows before the provider knows who is signed in: loading, a sign-in message, no access, or a failed start. */
function Gate({ t, error, loading, onRetry, page }: { t: HubT; error: HubError | null; loading: boolean; onRetry: () => void; page: boolean }) {
  // The hub is a page of its own (a `<main>` with an `<h1>`); a provider sits inside somebody else's page, so there it is a box.
  const Box = page ? 'main' : 'div';
  const Title = page ? 'h1' : 'h2';
  if (error === null) {
    return (
      <div className="cw-gate">
        <p role="status">{loading ? t('hub.gate.loading') : ''}</p>
      </div>
    );
  }
  if (error.status === 401) {
    return (
      <Box className="cw-gate">
        <Title>{t('hub.gate.unauthorized.title')}</Title>
        <p>{t('hub.gate.unauthorized.body')}</p>
      </Box>
    );
  }
  if (error.status === 403) {
    return (
      <Box className="cw-gate">
        <Title>{t('hub.gate.forbidden.title')}</Title>
        <p>{t('hub.gate.forbidden.body')}</p>
      </Box>
    );
  }
  return (
    <Box className="cw-gate">
      <Title>{t('hub.gate.failed.title')}</Title>
      <p role="alert">{errorText(t, error)}</p>
      <button type="button" className="cw-btn" onClick={onRetry}>
        {t('hub.state.retry')}
      </button>
    </Box>
  );
}
