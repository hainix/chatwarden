import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { userEvent } from '@testing-library/user-event';
import { waitFor } from '@testing-library/dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goTo, inside } from './helpers.js';
import { hubWorld } from './world.js';

// The BUILT scripts, not the sources: written out as the package ships them and imported as a page would. This is what proves the
// bundle works end to end (React inside it, the CSS inlined, the keys scoped to the element's own shadow root).

// Built under node_modules, where Vitest leaves a file to Node's own `import()` (as a page would load it) and does not transform it.
const load = (file: string): Promise<unknown> => import(/* @vite-ignore */ file.split(sep).join('/'));

let dir = '';
let standalonePath = '';
let secondPath = '';
let modulePath = '';

beforeAll(() => {
  // The build script, run as `npm run build` runs it (esbuild cannot run inside this jsdom environment, so it is a child process).
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'cw-hub-element-'));
  execFileSync(process.execPath, [join(process.cwd(), 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  standalonePath = join(dir, 'hub-element.js');
  modulePath = join(dir, 'index.js');
  secondPath = join(dir, 'hub-element-second-copy.js');
  copyFileSync(standalonePath, secondPath);
}, 120_000);

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('the built scripts', () => {
  it('the module registers nothing when imported; defineChatwardenHub registers it, twice is fine', async () => {
    const mod = (await load(modulePath)) as typeof import('../src/index.js');
    expect(customElements.get('chatwarden-hub')).toBeUndefined();
    expect(Object.keys(mod).sort()).toEqual(['ChatwardenHubElement', 'DEFAULT_TAG', 'VERSION', 'defineChatwardenHub']);
    const cls = mod.defineChatwardenHub('cw-from-module');
    expect(mod.defineChatwardenHub('cw-from-module')).toBe(cls);
    expect(customElements.get('cw-from-module')).toBe(cls);
    expect(customElements.get('chatwarden-hub')).toBeUndefined();
  });

  it('the standalone registers <chatwarden-hub> on import, and importing it again is harmless', async () => {
    const mod = (await load(standalonePath)) as typeof import('../src/index.js');
    expect(customElements.get('chatwarden-hub')).toBe(mod.ChatwardenHubElement);
    const again = (await load(secondPath)) as typeof import('../src/index.js');
    // A second copy of the script (a different URL) finds the tag taken and leaves it alone.
    expect(customElements.get('chatwarden-hub')).toBe(mod.ChatwardenHubElement);
    expect(again.defineChatwardenHub()).toBe(mod.ChatwardenHubElement);
  });

  it('draws the hub from a client, in its shadow root, with its own React', async () => {
    await load(standalonePath);
    const w = await hubWorld();
    const el = document.createElement('chatwarden-hub') as HTMLElement & { client: unknown };
    el.client = w.client;
    el.setAttribute('mode', 'detailed');
    document.body.append(el);
    await waitFor(() => expect(el.shadowRoot?.querySelector('.cw-body')).not.toBeNull(), { timeout: 8000 });
    // The CSS is in the shadow root: adopted as a stylesheet where the (jsdom) browser has them, a <style> where it has not.
    const adopted = (el.shadowRoot as ShadowRoot).adoptedStyleSheets ?? [];
    expect(adopted.length + (el.shadowRoot?.querySelectorAll('style').length ?? 0)).toBe(1);
    expect(document.querySelector('.cw-hub')).toBeNull();
  });

  it('its keys work from inside the shadow root and stay quiet outside', async () => {
    await load(standalonePath);
    const w = await hubWorld();
    await w.fileRich({ target: 'Mallory', reporter: 'Rae', room: 'one' });
    await w.fileRich({ target: 'Zed', reporter: 'Kit', room: 'two' });
    const el = document.createElement('chatwarden-hub') as HTMLElement & { client: unknown };
    el.client = w.client;
    el.setAttribute('mode', 'detailed');
    document.body.append(el);
    const root = el.shadowRoot as ShadowRoot;
    await waitFor(() => expect(root.querySelectorAll('.cw-queue .cw-case-link').length).toBe(2), { timeout: 8000 });
    const rows = [...root.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link')];
    const user = userEvent.setup();
    rows[0]?.focus();
    await user.keyboard('j');
    expect(root.activeElement).toBe(rows[1]);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await user.keyboard('?');
    await new Promise((r) => setTimeout(r, 30));
    expect(inside(el).queryByRole('dialog')).toBeNull();
    goTo('/');
  });
});
