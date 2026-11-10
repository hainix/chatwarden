import type { Plugin } from 'vite';

/**
 * The matcher is built on `obscenity`, whose package carries a ready-made English word list (`englishDataset`) that the matcher
 * never uses: it builds its own dataset from the term pack. The package is a CommonJS build with no `sideEffects` flag, so a
 * bundler keeps that list, and with it real slurs, in the page. This site ships invented words only (test/dist.test.ts scans the
 * build for any word of that list). So the unused list is cut out of the one file that defines it: the transformers in the same
 * file, which the matcher does use, stay.
 *
 * It fails loudly, in both ways it could silently do nothing:
 *  - the file is found but its layout changed (the marker is gone): the transform throws;
 *  - the file is never found (obscenity moved or renamed it, or another build of it was resolved): `buildEnd` throws, because
 *    the demo always bundles the matcher, so a build that never met the file kept the list.
 */
const FILE = /\/obscenity\/dist\/preset\/english\.js$/;
const START = 'exports.englishDataset = new DataSet_1.DataSet()';

/** The source of obscenity's `preset/english.js` with the word list removed. Throws when the list cannot be found. */
export function cutObscenityWordList(code: string): string {
  const at = code.indexOf(START);
  if (at < 0) throw new Error('obscenity changed: cannot find englishDataset to cut out of the bundle');
  return `${code.slice(0, at)}exports.englishDataset = new DataSet_1.DataSet();\n`;
}

export function withoutObscenityWordList(): Plugin {
  let cut = 0;
  return {
    name: 'without-obscenity-word-list',
    enforce: 'pre',
    transform(code, id) {
      if (!FILE.test(id.replaceAll('\\', '/').split('?')[0] ?? '')) return null;
      const out = cutObscenityWordList(code);
      cut += 1;
      return { code: out, map: null };
    },
    buildEnd(error) {
      if (error !== undefined) return; // the build already failed: do not hide the real reason behind this one
      if (cut === 0) {
        this.error('without-obscenity-word-list never found obscenity/dist/preset/english.js, so the real word list may be in the bundle');
      }
    },
  };
}
