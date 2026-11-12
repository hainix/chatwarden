import { Component, Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { CommandBarProps } from './shell/CommandBar.js';
import type { AiPartsProps } from './case/AiParts.js';
import type { UsePolicy } from './policyHooks.js';
import type { AiReadView, PolicyState, SignalCountView } from './types.js';

// Parts of the hub that few moderators open often are loaded the first time they are shown, so the hub's first load carries only
// what every moderator uses: the sweep disclosure and its window (behind a closed disclosure), the shortcut sheet (opened by `?`) and the
// command bar (opened by Ctrl+K). Each is fetched once and kept, and the shell asks for all three just after its first paint, so by the
// time a key is pressed the code is almost always there; until it is, nothing is drawn (a window opens a moment later, never lost).
// A failed fetch draws nothing and the next opening fetches again: these are optional extras, not screens.
//
// With a bundler that does not split (the single-file `<chatwarden-hub>`), the `import()` is part of the one file: nothing is fetched.

/** A failed fetch of a part's code, told apart from a part that breaks while it renders (which is not ours to catch). */
class LoadFailure extends Error {
  constructor() {
    super('A part of the hub could not be loaded.');
    this.name = 'LoadFailure';
  }
}

class Boundary extends Component<{ children: ReactNode; onFail: () => void; hide: boolean }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    if (error instanceof LoadFailure || this.props.hide) this.props.onFail();
  }

  override render(): ReactNode {
    const { error } = this.state;
    // A part that breaks while it renders is not ours to catch, except the AI's: those hide themselves (the case is never taken down by advice).
    if (error !== null && !(error instanceof LoadFailure) && !this.props.hide) throw error;
    return error === null ? this.props.children : null;
  }
}

/** What a panel of the Advanced settings screen is given: the policy as the screen read it (one read for all its panels). */
export interface PanelProps {
  state: PolicyState;
  policy: UsePolicy;
}

/** What a part asks of the page to get its code. Exposed so a test can make a fetch fail or wait; nothing else replaces them. */
export const partLoaders: {
  bulk: () => Promise<ComponentType<Record<string, never>>>;
  sheet: () => Promise<ComponentType<{ onClose: () => void }>>;
  bar: () => Promise<ComponentType<CommandBarProps>>;
  strip: () => Promise<ComponentType<{ read: AiReadView | null; expected: boolean }>>;
  aiParts: () => Promise<ComponentType<AiPartsProps>>;
  signalLines: () => Promise<ComponentType<{ signals: readonly SignalCountView[] | undefined }>>;
  pacePanel: () => Promise<ComponentType<PanelProps>>;
} = {
  bulk: () => import('./case/BulkDismiss.js').then((m) => m.BulkDismiss),
  sheet: () => import('./shell/ShortcutSheet.js').then((m) => m.ShortcutSheet),
  bar: () => import('./shell/CommandBar.js').then((m) => m.CommandBar),
  strip: () => import('./case/AiStrip.js').then((m) => m.AiStrip),
  aiParts: () => import('./case/AiParts.js').then((m) => m.AiParts),
  signalLines: () => import('./person/SignalLines.js').then((m) => m.SignalLines),
  pacePanel: () => import('./screens/PaceSettings.js').then((m) => m.PaceSettings),
};

/** A part that is asked for by the moderator (a window) is told when its code could not be fetched, so it can close and say so. */
export interface FailureAware {
  onFailed?: () => void;
}

function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, hide = false): { Part: ComponentType<P & FailureAware>; preload: () => void; reset: () => void } {
  const make = () =>
    lazy(() =>
      load().then(
        (component) => ({ default: component }),
        () => {
          throw new LoadFailure();
        },
      ),
    );
  let Inner = make();
  let failed = false;
  const Part = ({ onFailed, ...props }: P & FailureAware) => {
    // After a failure the next time the part is drawn asks for the code again (React keeps a failed lazy component failed).
    if (failed) {
      failed = false;
      Inner = make();
    }
    return (
      <Boundary
        hide={hide}
        onFail={() => {
          failed = true;
          onFailed?.();
        }}
      >
        <Suspense fallback={null}>
          <Inner {...(props as unknown as P)} />
        </Suspense>
      </Boundary>
    );
  };
  return {
    Part,
    preload: () => {
      void load().catch(() => undefined);
    },
    reset: () => {
      failed = false;
      Inner = make();
    },
  };
}

const bulk = lazyPart(() => partLoaders.bulk());
const sheet = lazyPart(() => partLoaders.sheet());
const bar = lazyPart(() => partLoaders.bar());
const strip = lazyPart(() => partLoaders.strip(), true);
const aiParts = lazyPart(() => partLoaders.aiParts(), true);
const signalLines = lazyPart(() => partLoaders.signalLines(), true);
const pacePanel = lazyPart(() => partLoaders.pacePanel());

/** "Close more reports at once": the disclosure at the bottom of the decision bar. */
export const LazyBulkDismiss: ComponentType<Record<string, never>> = bulk.Part as ComponentType<Record<string, never>>;
export const LazyShortcutSheet = sheet.Part;
export const LazyCommandBar = bar.Part;
/** The AI's read on the case (the strip and its menu): loaded when a case has a read or expects one. */
export const LazyAiStrip = strip.Part;
/** The AI's suggestion on a case (level 2): the bar's header, and the Simple card's suggestion, Accept button and reason. */
export const LazyAiParts = aiParts.Part;

/** The Person page's signal lines (inside the Timeline panel): loaded when the record has counts to show; an optional extra, never an error. */
export const LazySignalLines = signalLines.Part;

/** The "Slow mode and flooding" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazyPaceSettings = pacePanel.Part;

/** Forgets what was fetched, so the next drawing of each part asks again (tests). */
export function resetLazyParts(): void {
  bulk.reset();
  sheet.reset();
  bar.reset();
  strip.reset();
  aiParts.reset();
  signalLines.reset();
  pacePanel.reset();
}

/** Asks for the code of all three (the sweep disclosure only for a role that may sweep), once, just after the hub's first paint. */
export function preloadShellParts(withBulk: boolean): () => void {
  const id = setTimeout(() => {
    bar.preload();
    sheet.preload();
    if (withBulk) bulk.preload();
  }, 0);
  return () => clearTimeout(id);
}
