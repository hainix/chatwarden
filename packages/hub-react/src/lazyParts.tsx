import { Component, Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';

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

class Boundary extends Component<{ children: ReactNode; onFail: () => void }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    if (error instanceof LoadFailure) this.props.onFail();
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null && !(error instanceof LoadFailure)) throw error;
    return error === null ? this.props.children : null;
  }
}

function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): { Part: ComponentType<P>; preload: () => void } {
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
  const Part = (props: P) => {
    // After a failure the next time the part is drawn asks for the code again (React keeps a failed lazy component failed).
    if (failed) {
      failed = false;
      Inner = make();
    }
    return (
      <Boundary
        onFail={() => {
          failed = true;
        }}
      >
        <Suspense fallback={null}>
          <Inner {...props} />
        </Suspense>
      </Boundary>
    );
  };
  return {
    Part,
    preload: () => {
      void load().catch(() => undefined);
    },
  };
}

const bulk = lazyPart(() => import('./case/BulkDismiss.js').then((m) => m.BulkDismiss));
const sheet = lazyPart(() => import('./shell/ShortcutSheet.js').then((m) => m.ShortcutSheet));
const bar = lazyPart(() => import('./shell/CommandBar.js').then((m) => m.CommandBar));

/** "Close more reports at once": the disclosure at the bottom of the decision bar. */
export const LazyBulkDismiss: ComponentType<Record<string, never>> = bulk.Part as ComponentType<Record<string, never>>;
export const LazyShortcutSheet = sheet.Part;
export const LazyCommandBar = bar.Part;

/** Asks for the code of all three (the sweep disclosure only for a role that may sweep), once, just after the hub's first paint. */
export function preloadShellParts(withBulk: boolean): () => void {
  const id = setTimeout(() => {
    bar.preload();
    sheet.preload();
    if (withBulk) bulk.preload();
  }, 0);
  return () => clearTimeout(id);
}
