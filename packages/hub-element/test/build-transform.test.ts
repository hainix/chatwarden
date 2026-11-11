import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build helper with JSDoc types; the package tsconfig does not cover build/
import { elementStylesheet, esbuildPlugin, hubCssPath, hubElementPlugin } from '../build/plugin.mjs';

// What the build does to hub-react's stylesheet on the way in: it puts the host rules in front and changes nothing else. hub-react
// declares its token defaults privately (--cwd-*), reads each as var(--cw-x, var(--cwd-x)) and finds nodes through its own root, so
// there is nothing to rewrite: a build that quietly changed it again would be a second copy of the theme contract to keep right.

const hubCss = readFileSync(hubCssPath as string, 'utf8');
const css = elementStylesheet() as string;

describe('the stylesheet in the shadow root', () => {
  it('is the host rules followed by hub-react\'s styles.css, byte for byte', () => {
    expect(css.endsWith(hubCss)).toBe(true);
    expect(css.slice(0, css.length - hubCss.length)).toBe(':host {\n  display: block;\n}\n:host([hidden]) {\n  display: none;\n}\n');
  });

  it('makes the host a block, hidden when it is hidden', () => {
    expect(css).toMatch(/:host\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/:host\(\[hidden\]\)\s*\{[^}]*display:\s*none/);
  });

  it('keeps the token defaults where hub-react put them: private, under :where(.cw-hub), nothing on :host', () => {
    expect(css).toContain(':where(.cw-hub) {');
    expect(css).toContain('--cwd-bg:');
    expect(css).not.toMatch(/--cw-[a-z0-9-]+\s*:/);
    // The only `:host` rules are the two host rules.
    expect([...css.matchAll(/:host[^{]*\{/g)]).toHaveLength(2);
    expect(css).toContain('var(--cw-bg, var(--cwd-bg))');
  });
});

describe('the plugins', () => {
  it('both resolve the same CSS module name, and serve the same stylesheet', () => {
    const vite = hubElementPlugin() as { resolveId: (id: string) => string | null; load: (id: string) => string | null };
    const resolved = vite.resolveId('cw-hub-element:css');
    expect(resolved).not.toBeNull();
    expect(vite.resolveId('./other')).toBeNull();
    const served = vite.load(resolved as string) as string;
    expect(served).toBe(`export default ${JSON.stringify(css)};\n`);
    expect(vite.load('something-else')).toBeNull();
  });

  it('the Vite plugin has no transform: hub-react\'s sources are used as they are', () => {
    expect((hubElementPlugin() as Record<string, unknown>).transform).toBeUndefined();
  });

  it('the esbuild plugin hooks only its own CSS module, never a hub-react source', () => {
    const hooks: Array<{ kind: string; filter: RegExp; namespace?: string }> = [];
    (esbuildPlugin() as { setup: (b: unknown) => void }).setup({
      onResolve: (o: { filter: RegExp }) => hooks.push({ kind: 'resolve', filter: o.filter }),
      onLoad: (o: { filter: RegExp; namespace?: string }) => hooks.push({ kind: 'load', filter: o.filter, ...(o.namespace === undefined ? {} : { namespace: o.namespace }) }),
    });
    expect(hooks.map((h) => h.kind)).toEqual(['resolve', 'load']);
    expect(hooks[0]?.filter.test('cw-hub-element:css')).toBe(true);
    expect(hooks[0]?.filter.test('/packages/hub-react/src/Hub.tsx')).toBe(false);
    // The load hook is confined to the module's own namespace, so it cannot see a file on disk.
    expect(hooks[1]?.namespace).toBe('cw-hub-element');
  });
});
