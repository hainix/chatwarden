import { Component, Suspense, createContext, lazy, useContext, useEffect, useLayoutEffect } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import type { HubText } from '../i18n.js';
import { ErrorBlock, Loading } from '../ui.js';

// The settings and admin screens are loaded when they are first opened, so the hub's first load carries only the screens every
// moderator uses (Overview, Reports, a case, a person). A screen's code is fetched once; the skeleton shows while it comes, and a
// failed fetch is the hub's own error block with Try again, which asks for the code again.
//
// With a bundler that does not split (the single-file `<chatwarden-hub>`), the `import()` is part of the one file: nothing is fetched.

/** What the shell hears when a lazy screen has come in, so keyboard focus can follow a screen that arrived after the move. */
export const ScreenShown = createContext<(() => void) | null>(null);

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

  private retry = (): void => {
    this.props.onRetry();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    // Only a failed fetch is shown here: anything else goes on up to the page's own boundary, as it would have before.
    if (error !== null && !(error instanceof LoadFailure)) throw error;
    if (error === null) return this.props.children();
    return <Failed what={this.props.what} reason={error.reason} onRetry={this.retry} />;
  }
}

function Failed({ what, reason, onRetry }: { what: HubText; reason: unknown; onRetry: () => void }) {
  const { t } = useHub();
  const error: HubError = toHubError(reason);
  return (
    <div className="cw-screen">
      <ErrorBlock error={error} what={t(what)} onRetry={onRetry} />
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
export const LazyReportingSettings = lazyScreen('hub.state.what.reportingSettings', () => import('./ReportingSettings.js').then((m) => m.ReportingSettingsScreen));
