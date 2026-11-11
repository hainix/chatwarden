// The one place the hub looks things up in the page. The hub may be drawn in the page's document or inside a shadow root (the
// <chatwarden-hub> element does, and an adopter may), where `document.activeElement` is the host, `document.getElementById`
// finds nothing and a listener on `document` hears every hub on the page. So nothing else in the package says `document`: it asks
// for the root a node lives in, and looks there. (`headless/env.ts` is the other file allowed: the page being hidden or offline
// really is the page's. A test holds both lists.)

/** Where a node lives: the page's document, or the shadow root that holds it. */
export type DomRoot = Document | ShadowRoot;

/** The root `node` is in: its shadow root, or its document. A node not attached to anything has its own document. */
export function rootOf(node: Node): DomRoot {
  const root = node.getRootNode();
  // By node type, not `instanceof`: a hub in an iframe has a different `ShadowRoot` class from the script's.
  if (root.nodeType === 11 && 'host' in root) return root as ShadowRoot;
  if (root.nodeType === 9) return root as Document;
  return node.ownerDocument ?? document;
}

/** The element in `root` that has keyboard focus, or null. In a shadow root: the one inside it, not the host the page sees. */
export function activeIn(root: DomRoot): Element | null {
  return root.activeElement;
}

/** The element with this id in `root` (and not in another root), or null. */
export function byId(root: DomRoot, id: string): HTMLElement | null {
  return root.getElementById(id);
}

/** The element that has keyboard focus in the root `node` is in (see {@link activeIn}); null for no node, or when focus is elsewhere. */
export function activeOf(node: Node | null): Element | null {
  return node === null ? null : activeIn(rootOf(node));
}

/** Whether `node` is the element in its own root that has keyboard focus. */
export function hasFocus(node: Node | null): boolean {
  return node !== null && activeOf(node) === node;
}

/** The first window (`aria-modal` dialog) open inside `root` (a hub root or a piece root), or null: while one is, the hub behind it is not the target of a key. */
export function modalIn(root: ParentNode): Element | null {
  return root.querySelector('[role="dialog"][aria-modal="true"]');
}

// Anything a person types into, or edits in place.
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]';

/** The parts of an event `isTypingTarget` reads, so a test can hand in a plain object. */
export interface TypingEvent {
  target: EventTarget | null;
  composedPath?: () => EventTarget[];
}

/**
 * Whether a key was pressed on text, not a command: in a field, a menu, an editable region, or inside one. It reads where the event
 * began (`composedPath()[0]`), not `event.target`, which a listener outside a shadow root sees retargeted to the host.
 */
export function isTypingTarget(event: TypingEvent): boolean {
  const origin = event.composedPath?.()[0] ?? event.target;
  return typeof Element !== 'undefined' && origin instanceof Element && origin.closest(TYPING) !== null;
}

/**
 * Hears an event anywhere on the page, shadow roots included (UI events are composed, so they reach the window whole). For
 * "a press away from this menu". Test where it began with `composedPath()`: `event.target` is the host for anything in a shadow root.
 */
export function onPage(type: string, listener: (event: Event) => void): () => void {
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}

// ---- The page's hubs: who answers a key when nothing is focused -------------------------------------------------------------
//
// A hub hears the keys pressed while focus is inside it (React's `onKeyDown` on its root). After load, though, focus is on the page's
// body, and a drop-in hub should answer J, N, ? and Ctrl+K without a click first. So each hub that has shortcuts on registers here,
// and one listener on the window gives a key pressed with nothing focused to the page's hub: the only one registered, or, among
// several, the one marked `primary`. With several and no primary, nobody. It never takes a key when focus is anywhere else (an
// adopter's own control, another component's shadow root), a key already handled, a key pressed inside a hub (that hub heard it), or
// Escape (which is only ever the hub's own, when focus is in it).
//
// The registry lives on `globalThis` under a symbol from the global registry, not in this module: the element script and a page's own
// copy of hub-react are two copies of this file, and they have to see one list of hubs and install one listener between them.

/** What a registered hub offers the page: where a key goes, and whether it is the page's primary hub. */
export interface HubEntry {
  dispatch(event: KeyboardEvent): void;
  primary: boolean;
}

interface HubRegistry {
  hubs: Map<Element, HubEntry>;
  /** Removes the page listener; null while there is none. */
  stop: (() => void) | null;
}

const REGISTRY = Symbol.for('chatwarden.hubs');

function registry(): HubRegistry {
  const holder = globalThis as unknown as Record<symbol, HubRegistry | undefined>;
  return (holder[REGISTRY] ??= { hubs: new Map(), stop: null });
}

/** A key pressed on the page, with nothing focused: hand it to the page's hub, if there is exactly one that may have it. */
function pageKey(event: Event): void {
  const e = event as KeyboardEvent;
  if (e.defaultPrevented || e.key === 'Escape') return;
  const { hubs } = registry();
  const path = e.composedPath();
  for (const root of hubs.keys()) if (path.includes(root)) return;
  const focused = document.activeElement;
  if (focused !== null && focused !== document.body) return;
  let answers: HubEntry | undefined;
  if (hubs.size === 1) answers = hubs.values().next().value;
  else {
    const primary = [...hubs.values()].filter((h) => h.primary);
    if (primary.length === 1) answers = primary[0];
  }
  answers?.dispatch(e);
}

/**
 * Tell the page this hub exists and has shortcuts on, keyed by its root element (registering the same root again replaces it, so
 * StrictMode's second effect run is harmless). Returns what takes it out; the last hub out takes the page listener away.
 */
export function registerHub(root: Element, entry: HubEntry): () => void {
  const r = registry();
  r.hubs.set(root, entry);
  if (r.stop === null) r.stop = onPage('keydown', pageKey);
  return () => {
    if (r.hubs.get(root) === entry) r.hubs.delete(root);
    if (r.hubs.size === 0 && r.stop !== null) {
      r.stop();
      r.stop = null;
    }
  };
}
