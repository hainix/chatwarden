import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * The matcher is built on `obscenity`, whose package carries a ready-made English word list (`englishDataset`) that the matcher
 * never uses: it builds its own dataset from the term pack. The package is a CommonJS build with no `sideEffects` flag, so a
 * bundler keeps that list, and with it real slurs, in the page. This site ships invented words only (test/dist.test.ts scans the
 * build for any word of that list). So the unused list is cut out of the one file that defines it: the transformers in the same
 * file, which the matcher does use, stay. If obscenity's layout ever changes, the build fails here rather than ship the list.
 */
function withoutObscenityWordList(): Plugin {
  const START = 'exports.englishDataset = new DataSet_1.DataSet()';
  return {
    name: 'without-obscenity-word-list',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/obscenity\/dist\/preset\/english\.js$/.test(id.replaceAll('\\', '/').split('?')[0] ?? '')) return null;
      const at = code.indexOf(START);
      if (at < 0) throw new Error('obscenity changed: cannot find englishDataset to cut out of the bundle');
      return { code: `${code.slice(0, at)}exports.englishDataset = new DataSet_1.DataSet();\n`, map: null };
    },
  };
}

// The site is a static bundle for Cloudflare Pages. Nothing here loads from a third party.
export default defineConfig({
  plugins: [react(), withoutObscenityWordList()],
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
});
