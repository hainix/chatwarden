import { afterEach, describe, expect, it } from 'vitest';
import { hubShown, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The hub's CSS is inlined in the script and lives in the shadow root only: adopted as a constructable stylesheet where the
// browser has them (no inline <style>, so a strict CSP needs nothing extra), and as a <style> element where it has not.

class FakeSheet {
  css = '';
  replaceSync(css: string): void {
    this.css = css;
  }
}

const sheets = new WeakMap<object, unknown[]>();
const realSheet = globalThis.CSSStyleSheet;
const realAdopted = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
let changed = false;

/** A browser that has constructable stylesheets (whatever jsdom itself offers, this is the same on every machine). */
function installConstructableSheets(): void {
  changed = true;
  (globalThis as { CSSStyleSheet: unknown }).CSSStyleSheet = FakeSheet;
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get(this: object) {
      return sheets.get(this) ?? [];
    },
    set(this: object, value: unknown[]) {
      sheets.set(this, value);
    },
  });
}

/** A browser from before constructable stylesheets: no `replaceSync`, no `adoptedStyleSheets`. */
function removeConstructableSheets(): void {
  changed = true;
  (globalThis as { CSSStyleSheet: unknown }).CSSStyleSheet = class {};
  delete (ShadowRoot.prototype as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
}

afterEach(() => {
  if (!changed) return;
  changed = false;
  (globalThis as { CSSStyleSheet: unknown }).CSSStyleSheet = realSheet;
  if (realAdopted === undefined) delete (ShadowRoot.prototype as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
  else Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', realAdopted);
});

const adopted = (el: Element): FakeSheet[] => ((el.shadowRoot as unknown as { adoptedStyleSheets: FakeSheet[] }).adoptedStyleSheets ?? []) as FakeSheet[];

describe('with a <style> fallback (a browser without constructable stylesheets)', () => {
  it('puts one <style> with the hub CSS in the shadow root, and nothing in the page', async () => {
    removeConstructableSheets();
    const w = await hubWorld();
    const headBefore = document.head.innerHTML;
    const sheetsBefore = document.styleSheets.length;
    const el = mount({}, { client: w.client });
    await hubShown(el);
    const styles = el.shadowRoot?.querySelectorAll('style') ?? [];
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain('.cw-hub');
    expect(styles[0]?.textContent).toContain(':host');
    expect(document.head.innerHTML).toBe(headBefore);
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(document.styleSheets.length).toBe(sheetsBefore);
  });

  it('is drawn once per element, not once per render', async () => {
    removeConstructableSheets();
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    el.setAttribute('theme', 'dark');
    el.setAttribute('mode', 'detailed');
    await new Promise((r) => setTimeout(r, 30));
    expect(el.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
  });
});

describe('with constructable stylesheets', () => {
  it('adopts one stylesheet into the shadow root and adds no <style> element at all', async () => {
    installConstructableSheets();
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    expect(adopted(el)).toHaveLength(1);
    expect(adopted(el)[0]?.css).toContain('.cw-hub');
    expect(el.shadowRoot?.querySelectorAll('style')).toHaveLength(0);
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });

  it('shares one stylesheet object between every hub on the page', async () => {
    installConstructableSheets();
    const w = await hubWorld();
    const a = mount({}, { client: w.client });
    const b = mount({}, { client: w.client });
    await hubShown(a);
    await hubShown(b);
    expect(adopted(a)[0]).toBeDefined();
    expect(adopted(a)[0]).toBe(adopted(b)[0]);
  });

  it('falls back to <style> when the browser refuses the stylesheet', async () => {
    installConstructableSheets();
    (globalThis as { CSSStyleSheet: unknown }).CSSStyleSheet = class {
      replaceSync(): void {
        throw new Error('refused');
      }
    };
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    expect(el.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
  });
});

describe('the hub CSS in the shadow root', () => {
  it("is hub-react's own stylesheet: the token defaults stay private under .cw-hub and every read has its default, with nothing rewritten", async () => {
    removeConstructableSheets();
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    const css = el.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(css).toContain(':where(.cw-hub) {');
    for (const token of ['bg', 'surface', 'ink', 'accent', 'font', 'radius-m', 'hub-height']) {
      expect(css, token).toContain(`--cwd-${token}:`);
      expect(css, token).toContain(`var(--cw-${token}, var(--cwd-${token}))`);
    }
    // No public name is declared by the sheet, on the root or the host: a declaration would hide what the page sets above the hub.
    expect(css).not.toMatch(/--cw-[a-z0-9-]+\s*:/);
  });

  it('makes the host a block, hidden when it is hidden', async () => {
    removeConstructableSheets();
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    const css = el.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/:host\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/:host\(\[hidden\]\)\s*\{[^}]*display:\s*none/);
  });
});
