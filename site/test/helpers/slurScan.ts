// Scans text for any word of obscenity's English deny set, the way test/dist.test.ts needs it: in chunks that are cut only at
// whitespace, never inside a word. (A fixed window that starts mid-word reads "cument" out of "document" and flags a slur.)
// No real word is written in this repo: the deny set is obscenity's own, and sample words are read from its file at run time.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';

const CHUNK = 4000;
let matcher: RegExpMatcher | null = null;

/** Splits `text` into pieces of about `size` characters, each ending at whitespace (or at the end). Joined, they are `text`. */
export function wordSafeChunks(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const ws = /\s/.exec(text.slice(end));
      end = ws === null ? text.length : end + ws.index + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** The deny-set words found in `text`, each as the text that matched. */
export function scanForSlurs(text: string): string[] {
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  const hits: string[] = [];
  for (const chunk of wordSafeChunks(text)) {
    for (const m of matcher.getAllMatches(chunk, true)) hits.push(chunk.slice(m.startIndex, m.endIndex + 1));
  }
  return hits;
}

/** Words of the deny set, read from obscenity's own file (for controls that need a real hit without writing one down). */
export function datasetWords(): string[] {
  // obscenity's `exports` map hides its subpaths, so find the package entry (dist/index.js) and go from there.
  const entry = createRequire(import.meta.url).resolve('obscenity');
  const file = join(dirname(entry), 'preset', 'english.js');
  return [...readFileSync(file, 'utf8').matchAll(/originalWord: '([a-z]+)'/g)].map((m) => m[1] as string);
}
