import { Component, Suspense, createContext, lazy, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { activeOf } from '../dom.js';
import type { HubText } from '../i18n.js';
import { ErrorBlock, Loading } from '../ui.js';

// The settings and admin screens are loaded when they are first opened, so the hub's first load carries only the screens every
// moderator uses (Overview, Reports, a case, a person). A screen's code is fetched once; the skeleton shows while it comes, and a
// failed fetch is the hub's own error block with Try again, which asks for the code again.
//
// With a bundler that does not split (the single-file `<chatwarden-hub>`), the `import()` is part of the one file: nothing is fetched.

/**
 * What the shell hears when a lazy screen has come in, or has failed to (it is then given the error block), so keyboard focus can follow
 * a screen that arrived after the move. A piece has no shell above it: it hears nothing and takes no focus.
 */
export const ScreenShown = createContext<((failed?: HTMLElement) => void) | null>(null);

/**
 * Focus is where it was when the moderator moved here, or nowhere (the page, or the main area): a screen that arrives late may take it.
 * Anywhere else the moderator has put it since (the command bar, the queue, a filter), and it stays. Asks the root `main` is in, so it
 * is right inside a shadow root too (see dom.ts).
 */
export function isFocusFree(main: HTMLElement | null, atMove: Element | null): boolean {
  const active = activeOf(main);
  return active === null || active.tagName === 'BODY' || active === atMove || active === main || (main !== null && main.contains(active));
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The screen is on the page: in the same commit, so its heading can take focus before the browser paints. */
function Shown() {
  const shown = useContext(ScreenShown);
  useIsomorphicLayoutEffect(() => {
    shown?.();
  }, [shown]);
  return null;
}

/** A failed fetch of a screen's code, told apart from a screen that breaks while it renders (which is not ours to catch). */
class LoadFailure extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super('A screen could not be loaded.');
    this.name = 'LoadFailure';
    this.reason = reason;
  }
}

interface BoundaryProps {
  what: HubText;
  /** The screen again, from the code as it is now: read at each render, so a retry shows the fresh load. */
  children: () => ReactNode;
  onRetry: () => void;
}

interface BoundaryState {
  error: unknown;
}

class LoadBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  /** How many times Try again has been used: a failure that keeps coming back is probably a stale page, which only a reload fixes. */
  private retries = 0;

  private retry = (): void => {
    this.retries += 1;
    this.props.onRetry();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    // Only a failed fetch is shown here: anything else goes on up to the page's own boundary, as it would have before.
    if (error !== null && !(error instanceof LoadFailure)) throw error;
    if (error === null) return this.props.children();
    return <Failed what={this.props.what} reason={error.reason} onRetry={this.retry} retried={this.retries > 0} reload={this.retries >= RELOAD_AFTER} />;
  }
}

/** Try again that has failed this many times suggests reloading the page. */
const RELOAD_AFTER = 2;

function Failed({ what, reason, onRetry, retried, reload }: { what: HubText; reason: unknown; onRetry: () => void; retried: boolean; reload: boolean }) {
  const { t } = useHub();
  const error: HubError = toHubError(reason);
  const box = useRef<HTMLDivElement>(null);
  const shown = useContext(ScreenShown);
  // In the hub's shell the error stands where the screen's heading would have, so it takes the focus (if the shell says it may) and is announced.
  useIsomorphicLayoutEffect(() => {
    const element = box.current;
    if (element === null || shown === null) return;
    shown(element);
    // Try again removed the button that had the focus; the new failure is where it goes back to, so it is read out again.
    const active = activeOf(element);
    if (retried && (active === null || active.tagName === 'BODY')) element.focus();
  }, [shown]);
  return (
    <div className="cw-screen">
      <div ref={box} tabIndex={-1}>
        <ErrorBlock error={error} what={t(what)} onRetry={onRetry} />
        {reload && <p className="cw-hint">{t('hub.state.reloadHint')}</p>}
      </div>
    </div>
  );
}

/** What shows while the code comes: the hub's quiet "Loading" line and grey bars, where the screen will be. */
function Fallback() {
  return (
    <div className="cw-screen">
      <Loading />
    </div>
  );
}

/**
 * A screen that is loaded the first time it is shown. `what` names it in "Could not load {what}." Props pass through. The code is
 * fetched once and kept; a failed fetch shows the hub's error block, and its Try again fetches again (React keeps a failed lazy
 * component failed, so a retry makes a new one).
 */
export function lazyScreen<P extends object>(what: HubText, load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const make = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(() =>
      load().then(
        (component) => ({ default: component }),
        (reason: unknown) => {
          throw new LoadFailure(reason);
        },
      ),
    );
  let Inner = make();
  const Screen = (props: P) => (
    <LoadBoundary
      what={what}
      onRetry={() => {
        Inner = make();
      }}
    >
      {() => (
        <Suspense fallback={<Fallback />}>
          <Inner {...props} />
          <Shown />
        </Suspense>
      )}
    </LoadBoundary>
  );
  return Screen;
}

export const LazyTerms = lazyScreen('hub.state.what.terms', () => import('./Terms.js').then((m) => m.Terms));
export const LazyBlocked = lazyScreen('hub.state.what.blocked', () => import('./Blocked.js').then((m) => m.Blocked));
export const LazyGaps = lazyScreen('hub.state.what.gaps', () => import('./Gaps.js').then((m) => m.Gaps));
export const LazyAudit = lazyScreen('hub.state.what.audit', () => import('./Audit.js').then((m) => m.Audit));
export const LazyGuide = lazyScreen('hub.state.what.guide', () => import('./Guide.js').then((m) => m.Guide));
export const LazyActions = lazyScreen('hub.state.what.allActions', () => import('./Actions.js').then((m) => m.Actions));
export const LazyLadderSettings = lazyScreen('hub.state.what.settings', () => import('./LadderSettings.js').then((m) => m.LadderSettingsScreen));
export const LazyAiSettings = lazyScreen('hub.state.what.settings', () => import('./AiSettings.js').then((m) => m.AiSettingsScreen));
export const LazyAdvancedSettings = lazyScreen('hub.state.what.advanced', () => import('./AdvancedSettings.js').then((m) => m.AdvancedSettingsScreen));
export const LazyAppealCard = lazyScreen('hub.state.what.appeal', () => import('../case/AppealCard.js').then((m) => m.AppealScreen));
export const LazyAppeals = lazyScreen('hub.state.what.appeals', () => import('./Appeals.js').then((m) => m.Appeals));
export const LazyReportingSettings = lazyScreen('hub.state.what.reportingSettings', () => import('./ReportingSettings.js').then((m) => m.ReportingSettingsScreen));
