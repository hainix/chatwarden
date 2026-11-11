import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// The demo is a separate chunk, and it is the heavy one: the real moderator hub, the staff routes it runs over, the player components
// and the kit (about 180 KB gzip). It loads when this section nears the viewport (IntersectionObserver, 200px ahead, so a phone's
// first screen does not fetch it), or as soon as a visitor points at or focuses the placeholder. Until then the placeholder has the demo's final size, so the
// page does not jump when the demo arrives.
const Demo = lazy(() => import('../demo/Demo'));

function Placeholder({ onWake }: { onWake: () => void }) {
  return (
    <div className="demo-slot" data-demo-slot onPointerEnter={onWake} onFocusCapture={onWake}>
      <div className="demo-pane">
        <h3>The game</h3>
        <div className="ghost-lines" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="demo-pane">
        <h3>Your moderator</h3>
        <div className="ghost-lines" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <p className="demo-status" role="status">
        Loading the demo…
      </p>
    </div>
  );
}

/** If the chunk cannot load (offline, a stale deploy), say so and point at the rest of the page. */
class LoadGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="demo-slot demo-failed" data-demo-slot>
        <p className="demo-status" role="status">
          Could not load the demo. Reload the page to try again, or follow the <a href="#add-it">steps below</a> to run the kit yourself.
        </p>
      </div>
    );
  }
}

export function DemoSlot() {
  const [wake, setWake] = useState(false);
  const section = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wake) return;
    if (typeof IntersectionObserver !== 'function') {
      setWake(true);
      return;
    }
    const el = section.current;
    if (el === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setWake(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [wake]);

  return (
    <section id="demo" aria-labelledby="demo-title" className="section demo">
      <div className="wrap">
        <div className="section-head">
          <h2 id="demo-title">Play both sides</h2>
          <p className="section-lead">
            Chat as a player, report a line, then decide as the moderator. No sign-up, no API key.
          </p>
        </div>
        <div ref={section}>
          {wake ? (
            <LoadGuard>
              <Suspense fallback={<Placeholder onWake={() => setWake(true)} />}>
                <Demo />
              </Suspense>
            </LoadGuard>
          ) : (
            <Placeholder onWake={() => setWake(true)} />
          )}
        </div>
      </div>
    </section>
  );
}
