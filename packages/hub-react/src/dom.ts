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

/** Whether `node` is the element in its own root that has keyboard focus. */
export function hasFocus(node: Node | null): boolean {
  return node !== null && activeIn(rootOf(node)) === node;
}

/** The first window (`aria-modal` dialog) open in this root, or null: while one is, the page behind it is not the target of a key. */
export function modalIn(root: DomRoot): Element | null {
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
