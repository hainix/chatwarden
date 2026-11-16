// @vitest-environment node
// The dist scan takes the random build hash out of a chunk file name and nothing else: a real word in a name is still scanned.
import { describe, expect, it } from 'vitest';
import { datasetWords, scanForSlurs, stripBuildHashes } from './helpers/slurScan';

describe('stripBuildHashes', () => {
  it('removes the hash and keeps the rest of the name', () => {
    expect(stripBuildHashes('assets/core-CEmFckgm.js')).toBe('assets/core.js');
    expect(stripBuildHashes('/assets/index-D4-x_9Qz.css and /assets/vendor-react-AbCdEfGh.js')).toBe('/assets/index.css and /assets/vendor-react.js');
    expect(stripBuildHashes('chunk-12345678.js?x=1')).toBe('chunk.js?x=1');
  });

  it('leaves text that is not a hashed chunk name alone', () => {
    for (const text of ['plain words here', 'a-b.js', 'core.js', 'name-1234567.js', 'name-123456789.json', 'value-12345678 and more']) {
      expect(stripBuildHashes(text), text).toBe(text);
    }
  });

  it('a real word in a chunk file name is still scanned (control: the old strip removed the whole token)', () => {
    // The word comes from obscenity's own dataset at run time: no real slur is written in this repo.
    const word = datasetWords().find((w) => w.length >= 6 && /^[a-z]+$/.test(w)) as string;
    expect(word).toBeDefined();
    const name = `assets/${word}-CEmFckgm.js`;
    expect(scanForSlurs(stripBuildHashes(name)).length).toBeGreaterThan(0);
    expect(scanForSlurs(stripBuildHashes(`assets/${word}-CEmFckgm.css`)).length).toBeGreaterThan(0);
    // the whole-token strip the scan used before would have hidden it
    expect(scanForSlurs(name.replace(/[\w./-]+-[\w-]{8}\.(?:js|css)/g, ' '))).toEqual([]);
  });

  it('a hash that happens to spell part of a word no longer matters', () => {
    const word = datasetWords().find((w) => w.length >= 6 && w.length <= 8 && /^[a-z]+$/.test(w)) as string;
    const hashed = `assets/core-${word.padEnd(8, 'x').slice(0, 8)}.js`;
    expect(scanForSlurs(stripBuildHashes(hashed))).toEqual([]);
  });
});
