// The one thing the build does to hub-react on the way in: its stylesheet becomes a string module (`cw-hub-element:css`), one for
// esbuild (the script) and one for Vite (the tests), both from the same function. hub-react's sources and styles are used as they
// are: they find nodes through their own root and read every --cw-* token with its own default, so nothing is rewritten.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CSS_MODULE = 'cw-hub-element:css';
const RESOLVED_CSS = '\0cw-hub-element:css';

export const hubCssPath = resolve(import.meta.dirname, '..', '..', 'hub-react', 'src', 'styles.css');

// The element itself is a block, and `hidden` hides it. Everything else is hub-react's stylesheet, untouched.
const HOST_RULES = ':host {\n  display: block;\n}\n:host([hidden]) {\n  display: none;\n}\n';

/**
 * The stylesheet in the shadow root: the host rules, then hub-react's own styles.css verbatim.
 * @returns {string}
 */
export function elementStylesheet() {
  return HOST_RULES + readFileSync(hubCssPath, 'utf8');
}

const cssModuleSource = () => `export default ${JSON.stringify(elementStylesheet())};\n`;

/** esbuild: the hub CSS as a string module. */
export function esbuildPlugin() {
  return {
    name: 'hub-element',
    setup(build) {
      build.onResolve({ filter: /^cw-hub-element:css$/ }, () => ({ path: CSS_MODULE, namespace: 'cw-hub-element' }));
      build.onLoad({ filter: /.*/, namespace: 'cw-hub-element' }, () => ({ contents: cssModuleSource(), loader: 'js' }));
    },
  };
}

/** Vite (Vitest): the same module. */
export function hubElementPlugin() {
  return {
    name: 'hub-element',
    enforce: 'pre',
    resolveId(id) {
      return id === CSS_MODULE ? RESOLVED_CSS : null;
    },
    load(id) {
      return id === RESOLVED_CSS ? cssModuleSource() : null;
    },
  };
}
