import { createHubClient, fetchTransport, hashRouter, Hub, memoryRouter } from '@chatwarden/hub-react';
import type { HubClient, HubRouter, HubT, Route } from '@chatwarden/hub-react';
import hubCss from 'cw-hub-element:css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ATTRIBUTES, readConfig } from './config.js';
import type { HubElementConfig } from './config.js';

/** What `cw-navigate` carries: the route the hub is on now, and its path (`/reports/abc`). */
export interface CwNavigateDetail {
  route: Route;
  path: string;
}

/** What `cw-decided` carries: the report that was decided, and the verdict the moderator gave. */
export interface CwDecidedDetail {
  reportId: string;
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
}

declare global {
  interface HTMLElementEventMap {
    'cw-navigate': CustomEvent<CwNavigateDetail>;
    'cw-decided': CustomEvent<CwDecidedDetail>;
  }
}

// On a server there is no HTMLElement: the class is still made (so importing the package there does not throw), it just cannot be used.
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

// The hub CSS is one constructable stylesheet shared by every hub on the page, where the browser has them; otherwise a <style>.
let shared: { ctor: unknown; sheet: CSSStyleSheet } | null = null;

function adoptStyles(shadow: ShadowRoot): void {
  if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in shadow) {
    try {
      if (shared === null || shared.ctor !== CSSStyleSheet) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(hubCss);
        shared = { ctor: CSSStyleSheet, sheet };
      }
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, shared.sheet];
      return;
    } catch {
      shared = null;
    }
  }
  const style = document.createElement('style');
  style.textContent = hubCss;
  shadow.append(style);
}

let instances = 0;

/**
 * `<chatwarden-hub>`: the Chatwarden moderator hub, drawn in a shadow root. Attributes: `base-url`, `mode`, `theme`, `locale`,
 * `game-name`, `shortcuts`, `router`. Properties for what an attribute cannot hold: `client` and `t`. Events: `cw-navigate` and
 * `cw-decided`. It draws when it is connected and tears down (sending any decision held for Undo) when it is removed; moving it in
 * the DOM keeps it as it is.
 */
export class ChatwardenHubElement extends Base {
  static get observedAttributes(): string[] {
    return [...ATTRIBUTES];
  }

  #client: HubClient | null = null;
  #t: HubT | null = null;
  #root: Root | null = null;
  #container: HTMLDivElement | null = null;
  // Each connect or disconnect makes a new number: an unmount waits a microtask and only runs if nothing connected since.
  #generation = 0;
  #renderQueued = false;
  #warned = new Set<string>();
  #own: { baseUrl: string; client: HubClient } | null = null;
  #watched = new WeakMap<HubClient, HubClient>();
  #hash: HubRouter | null = null;
  #memory: HubRouter | null = null;
  #id = ++instances;

  constructor() {
    super();
    if (this.shadowRoot === null) this.attachShadow({ mode: 'open' });
    // A page may set `el.client` before this script defined the element: that value sits on the instance and hides the accessors.
    for (const name of ['client', 't'] as const) {
      if (Object.hasOwn(this, name)) {
        const value = (this as unknown as Record<string, unknown>)[name];
        delete (this as unknown as Record<string, unknown>)[name];
        (this as unknown as Record<string, unknown>)[name] = value;
      }
    }
  }

  /** A staff client you made (`createHubClient(...)`). When set, it is used instead of `base-url`. */
  get client(): HubClient | null {
    return this.#client;
  }
  set client(value: HubClient | null) {
    this.#client = value ?? null;
    this.#queueRender();
  }

  /** The words: `createT({ ...en, ...yours }, locale)` from `@chatwarden/hub-react`. Default: English. */
  get t(): HubT | null {
    return this.#t;
  }
  set t(value: HubT | null) {
    this.#t = value ?? null;
    this.#queueRender();
  }

  connectedCallback(): void {
    this.#generation++;
    // A move in the DOM (disconnect, then connect again) keeps the same root.
    if (this.#root !== null) return;
    const shadow = this.shadowRoot as ShadowRoot;
    if (shadow.querySelector('style') === null && !hasAdopted(shadow)) adoptStyles(shadow);
    const container = document.createElement('div');
    shadow.append(container);
    this.#container = container;
    this.#root = createRoot(container, { identifierPrefix: `cwhub${this.#id}-` });
    this.#render();
  }

  disconnectedCallback(): void {
    const generation = ++this.#generation;
    queueMicrotask(() => {
      if (generation === this.#generation && !this.isConnected) this.#stop();
    });
  }

  attributeChangedCallback(_name: string, before: string | null, after: string | null): void {
    if (before !== after) this.#queueRender();
  }

  #stop(): void {
    // Unmounting runs the hub's cleanups: its controller is disposed, which sends a decision held for Undo at once.
    this.#root?.unmount();
    this.#root = null;
    this.#container?.remove();
    this.#container = null;
  }

  #queueRender(): void {
    if (this.#root === null || this.#renderQueued) return;
    this.#renderQueued = true;
    queueMicrotask(() => {
      this.#renderQueued = false;
      this.#render();
    });
  }

  #warn = (message: string): void => {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    console.warn(message);
  };

  #render(): void {
    if (this.#root === null) return;
    const config = readConfig((name) => this.getAttribute(name), this.#warn);
    this.#root.render(
      createElement(Hub, {
        client: this.#clientFor(config),
        t: this.#t ?? undefined,
        locale: config.locale,
        router: this.#routerFor(config),
        theme: config.theme,
        mode: config.mode,
        gameName: config.gameName,
        shortcuts: config.shortcuts,
        onNavigate: this.#onNavigate,
      }),
    );
  }

  #onNavigate = (route: Route, path: string): void => {
    this.dispatchEvent(new CustomEvent<CwNavigateDetail>('cw-navigate', { detail: { route, path }, bubbles: true, composed: true }));
  };

  /** The client the hub talks through: the page's own, or one for `base-url`, either way watched for decisions. */
  #clientFor(config: HubElementConfig): HubClient {
    let source = this.#client;
    if (source === null) {
      if (this.#own?.baseUrl !== config.baseUrl) {
        this.#own = { baseUrl: config.baseUrl, client: createHubClient(fetchTransport({ baseUrl: config.baseUrl, credentials: 'same-origin' })) };
      }
      source = this.#own.client;
    }
    return this.#watch(source);
  }

  /** The same client, but a decision the server accepted is announced as `cw-decided`. The page's client object is left as it was. */
  #watch(source: HubClient): HubClient {
    const known = this.#watched.get(source);
    if (known !== undefined) return known;
    const decide: HubClient['decide'] = async (id, input, options) => {
      const result = await source.decide(id, input, options);
      // A replay means this decision was already made: it was announced then.
      if (!result.replay) {
        this.dispatchEvent(new CustomEvent<CwDecidedDetail>('cw-decided', { detail: { reportId: id, verdict: input.verdict }, bubbles: true, composed: true }));
      }
      return result;
    };
    // A Proxy, so the page's client is never written to (it may be frozen) and its methods still run with their own `this` (a class with
    // #private fields). The target is a bare object of ours: a Proxy over the client itself could not answer `decide` differently when
    // that property is frozen. Every method but `decide` is the source's own, bound to the source.
    const bound = new Map<PropertyKey, unknown>();
    const watched = new Proxy({} as HubClient, {
      get(_target, prop) {
        if (prop === 'decide') return decide;
        const value: unknown = Reflect.get(source, prop, source);
        if (typeof value !== 'function') return value;
        let method = bound.get(prop);
        if (method === undefined) {
          method = (value as (...args: unknown[]) => unknown).bind(source);
          bound.set(prop, method);
        }
        return method;
      },
      has: (_target, prop) => prop in source,
    });
    this.#watched.set(source, watched);
    return watched;
  }

  #routerFor(config: HubElementConfig): HubRouter {
    if (config.router === 'memory') return (this.#memory ??= memoryRouter('/'));
    return (this.#hash ??= hashRouter());
  }
}

function hasAdopted(shadow: ShadowRoot): boolean {
  return 'adoptedStyleSheets' in shadow && shadow.adoptedStyleSheets.length > 0;
}
