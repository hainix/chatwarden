// The build transforms as plugins: one for esbuild (the script) and one for Vite (the tests), both calling the same functions.
import { readFileSync } from 'node:fs';
import { elementCss, hubCssPath, injectShadowDocument, shadowDocumentPath } from './transform.mjs';

export const CSS_MODULE = 'cw-hub-element:css';
const RESOLVED_CSS = '\0cw-hub-element:css';

const cssModuleSource = () => `export default ${JSON.stringify(elementCss(readFileSync(hubCssPath, 'utf8')))};\n`;

/** esbuild: the hub CSS as a string module, and hub-react's `document` swapped for the shadow-aware one. */
export function esbuildPlugin() {
  return {
    name: 'hub-element',
    setup(build) {
      build.onResolve({ filter: /^cw-hub-element:css$/ }, () => ({ path: CSS_MODULE, namespace: 'cw-hub-element' }));
      build.onLoad({ filter: /.*/, namespace: 'cw-hub-element' }, () => ({ contents: cssModuleSource(), loader: 'js' }));
      // The filter is loose on purpose (a path separator is a different character on each OS); injectShadowDocument decides.
      build.onLoad({ filter: /hub-react.*\.[cm]?[jt]sx?$/ }, (args) => {
        const code = readFileSync(args.path, 'utf8');
        const out = injectShadowDocument(code, args.path);
        if (out === null) return null;
        const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
        return { contents: out, loader: ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : 'js' };
      });
    },
  };
}

/** Vite (Vitest): the same two transforms. */
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
    transform(code, id) {
      const out = injectShadowDocument(code, id.split('?')[0]);
      return out === null ? null : { code: out, map: null };
    },
  };
}

export { shadowDocumentPath };
