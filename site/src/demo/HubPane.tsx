// The moderator side of the demo is the real hub (@chatwarden/hub-react), not a copy of it. It runs over the kit's real staff
// routes (@chatwarden/http/admin), called in the page through the hub's routerTransport: no network, and the hub cannot tell.
// The staff member is a made-up owner, so every screen opens. Everything the hub does goes through these routes, so the one
// thing this file adds is a listener that tells the demo when a case was opened and when a decision was taken (the tour and the
// game pane's notice button follow those), without the hub knowing about the demo.
import '@chatwarden/hub-react/styles.css';
import { createHubClient, Hub, memoryRouter, routerTransport } from '@chatwarden/hub-react';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';
import type { KitRequest, KitResponse } from '@chatwarden/http/admin';
import type { HubController } from '@chatwarden/hub-react/headless';
import { useEffect, useMemo, useRef } from 'react';
import type { Theme } from '../lib/theme';
import type { DemoWorld } from './engine';
import { DEMO_ACTOR } from './kitEngine';

export type StaffEvent =
  /** The hub read a report to show its case. */
  | { kind: 'case-opened'; reportId: string }
  /** The kit took a decision (the hub sends it after its five seconds of Undo). */
  | { kind: 'decided'; reportId: string };

/** The staff routes over this kit, as the in-page handler the hub's transport calls. `onEvent` hears the two calls the tour follows. */
export function staffHandle(world: DemoWorld, onEvent?: (event: StaffEvent) => void): (req: KitRequest) => Promise<KitResponse> {
  const handle = createRouter(adminRoutes(world.cw, { authorize: () => ({ actor: DEMO_ACTOR, role: 'owner' }), terms: world.terms }));
  return async (req) => {
    const res = await handle(req);
    if (res.status === 200 && onEvent !== undefined) {
      const opened = req.method === 'GET' ? /^\/reports\/([^/]+)$/.exec(req.path) : null;
      const decided = req.method === 'POST' ? /^\/reports\/([^/]+)\/decide$/.exec(req.path) : null;
      if (opened !== null) onEvent({ kind: 'case-opened', reportId: decodeURIComponent(opened[1] as string) });
      if (decided !== null) onEvent({ kind: 'decided', reportId: decodeURIComponent(decided[1] as string) });
    }
    return res;
  };
}

interface Props {
  world: DemoWorld;
  theme: Theme;
  /**
   * True while the visitor is working in the demo. The hub's keys are on only then: with nothing focused, the page's one hub would
   * otherwise answer J, K and N for a visitor who is just scrolling the landing page.
   */
  active: boolean;
  onEvent: (event: StaffEvent) => void;
  /** The hub's controller, once it exists and again for each new hub (a Reset): the page's way to ask it to read its queue now. */
  onController?: (controller: HubController) => void;
}

/**
 * The hub in the demo's moderator pane: Simple mode (the hub's default, with its Simple/Detailed switch showing), on a router of
 * its own that never touches the page's address. The client and the router are made once per kit: a Reset makes a new kit, so a new hub.
 */
export function HubPane({ world, theme, active, onEvent, onController }: Props) {
  // The listener changes on every render; the handler keeps calling the latest one.
  const latest = useRef(onEvent);
  useEffect(() => {
    latest.current = onEvent;
  });
  const { client, router, gate } = useMemo(() => {
    // A decision still held for Undo is sent when the hub goes away (a Reset). It reaches the old kit, and the page must not hear
    // of it: the gate is closed the moment this hub is replaced or removed.
    const open = { on: true };
    return {
      client: createHubClient(routerTransport(staffHandle(world, (e) => open.on && latest.current(e)))),
      router: memoryRouter('/'),
      gate: open,
    };
  }, [world]);
  useEffect(() => {
    gate.on = true; // (a development double mount closes it and opens it again)
    return () => {
      gate.on = false;
    };
  }, [gate]);
  // `primary`: this hub answers keys when nothing has focus (as after a click on its empty space or on the demo's). `shortcuts`
  // follows the visitor: off when they are elsewhere on the page. The hub never answers a key typed in the chat box or a dialog,
  // whatever these say: it answers only while focus is inside it, or nothing is focused.
  return <Hub client={client} router={router} theme={theme} primary shortcuts={active} gameName="Lobby" className="demo-hub" onController={onController} />;
}

interface PaneProps extends Omit<Props, 'world'> {
  /** The kit, or null while it is being built. */
  world: DemoWorld | null;
  /** The pane switcher hides the pane that is not showing (phones). */
  hidden: boolean;
}

/** The moderator pane: a heading, and the hub (or a line saying it is on its way). */
export function ModeratorPane({ world, hidden, theme, active, onEvent, onController }: PaneProps) {
  return (
    <section className="pane pane-mod" data-pane="mod" aria-labelledby="pane-mod-title" hidden={hidden}>
      <header className="pane-head">
        <h3 id="pane-mod-title" tabIndex={-1}>
          Your moderator
        </h3>
        <span className="pane-tag">the real hub, over the real staff routes</span>
      </header>
      <div className="hub-host">
        {world === null ? (
          <p className="demo-status" role="status">
            Opening the moderator hub…
          </p>
        ) : (
          <HubPane world={world} theme={theme} active={active} onEvent={onEvent} onController={onController} />
        )}
      </div>
    </section>
  );
}
