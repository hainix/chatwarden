// Task 2 fills the [data-demo-slot] element with the real, code-split demo. Until then this is a placeholder card
// with the demo's final dimensions, so the page does not jump when the demo arrives.
export function DemoSlot() {
  return (
    <section id="demo" aria-labelledby="demo-title" className="section demo">
      <div className="wrap">
        <div className="section-head">
          <h2 id="demo-title">Play both sides</h2>
          <p className="section-lead">
            Chat as a player, report a line, then decide as the moderator. No sign-up, no API key.
          </p>
        </div>
        <div className="demo-slot" data-demo-slot>
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
          <p className="demo-status">Interactive demo — loading in the next build</p>
        </div>
      </div>
    </section>
  );
}
