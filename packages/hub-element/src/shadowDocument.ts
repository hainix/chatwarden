// hub-react reads the page: `document.activeElement`, `getElementById`, `querySelector` and page-wide key listeners. Inside a shadow
// root all of those lie: the active element is the host, a key's target is the host (so "is this a text field?" is always no), and
// an id is not found. In the element's script, hub-react's `document` is `cwDocument` (build/transform.mjs swaps it in), which answers
// for the shadow roots registered here and for the page otherwise. It is a stop-gap: hub-react taking its root from
// `getRootNode()` would make it unnecessary.

const roots = new Set<ShadowRoot>();

/** Lets the shim see inside this shadow root. Returns what takes it away again. */
export function registerShadowRoot(root: ShadowRoot): () => void {
  roots.add(root);
  return () => {
    roots.delete(root);
  };
}

/** The element that has focus, looking through every registered shadow root down to the innermost. */
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active !== null && active.shadowRoot !== null && roots.has(active.shadowRoot)) {
    const inner: Element | null = active.shadowRoot.activeElement;
    if (inner === null) break;
    active = inner;
  }
  return active;
}

/** The registered root that holds focus, if one does. */
function activeRoot(): ShadowRoot | null {
  const root = deepActiveElement()?.getRootNode();
  return root instanceof ShadowRoot && roots.has(root) ? root : null;
}

/** Where to look for an element: the root with focus first (two hubs may share an id), then the others, then the page. */
function searchOrder(): Array<ShadowRoot | Document> {
  const first = activeRoot();
  return [...(first === null ? [] : [first]), ...[...roots].filter((r) => r !== first), document];
}

const KEYS = new Set(['keydown', 'keyup', 'keypress']);
type Listener = EventListenerOrEventListenerObject;
const wrappers = new WeakMap<object, Map<string, EventListener>>();
const wrapperKey = (type: string, options: boolean | AddEventListenerOptions | EventListenerOptions | undefined): string =>
  `${type}:${(typeof options === 'boolean' ? options : options?.capture) === true ? 'capture' : 'bubble'}`;

/** The event as the page's listener should see it: the same event, but `target` is the element inside the shadow root. */
function seenFrom(e: Event, origin: EventTarget): Event {
  return new Proxy(e, {
    get(target, prop) {
      if (prop === 'target') return origin;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function call(listener: Listener, e: Event): void {
  if (typeof listener === 'function') listener.call(document, e);
  else listener.handleEvent(e);
}

function wrap(type: string, listener: Listener): EventListener {
  return (e: Event) => {
    const path = e.composedPath();
    const inside = [...roots].some((r) => path.includes(r));
    if (inside) {
      const origin = path[0];
      call(listener, origin === undefined || origin === e.target ? e : seenFrom(e, origin));
    } else if (!KEYS.has(type)) {
      // A click in the page outside still reaches a listener that wants to close a menu; a key from the page never does.
      call(listener, e);
    }
  };
}

const overrides: Record<string, unknown> = {
  getElementById(id: string): HTMLElement | null {
    for (const where of searchOrder()) {
      const found = where.getElementById(id);
      if (found !== null) return found;
    }
    return null;
  },
  querySelector(selector: string): Element | null {
    for (const where of searchOrder()) {
      const found = where.querySelector(selector);
      if (found !== null) return found;
    }
    return null;
  },
  addEventListener(type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions): void {
    if (listener === null) return;
    const byKind = wrappers.get(listener) ?? new Map<string, EventListener>();
    const key = wrapperKey(type, options);
    if (byKind.has(key)) return;
    const wrapped = wrap(type, listener);
    byKind.set(key, wrapped);
    wrappers.set(listener, byKind);
    document.addEventListener(type, wrapped, options);
  },
  removeEventListener(type: string, listener: Listener | null, options?: boolean | EventListenerOptions): void {
    if (listener === null) return;
    const key = wrapperKey(type, options);
    const wrapped = wrappers.get(listener)?.get(key);
    if (wrapped === undefined) return;
    wrappers.get(listener)?.delete(key);
    document.removeEventListener(type, wrapped, options);
  },
};

/** hub-react's `document` inside the element's script. */
export const cwDocument: Document = new Proxy((typeof document === 'undefined' ? {} : document) as Document, {
  get(target, prop) {
    if (prop === 'activeElement') return deepActiveElement();
    if (typeof prop === 'string' && Object.hasOwn(overrides, prop)) return overrides[prop];
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
});
