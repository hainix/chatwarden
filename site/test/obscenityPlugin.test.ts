// @vitest-environment node
// The Vite plugin that cuts obscenity's English word list out of the bundle (the site ships invented words only). It must
// cut the real file correctly, and it must FAIL LOUDLY when it cannot: a build that quietly kept the list is the bug.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { cutObscenityWordList, withoutObscenityWordList } from '../vite/withoutObscenityWordList';

const require = createRequire(import.meta.url);
// obscenity's `exports` map hides its subpaths: find the package entry (dist/index.js) and go from there.
const ENGLISH = join(dirname(require.resolve('obscenity')), 'preset', 'english.js');
const real = readFileSync(ENGLISH, 'utf8');
// A word of the list, read from the file itself (no real slur is written in this repo).
const WORD = [...real.matchAll(/originalWord: '([a-z]{6,})'/g)][0]?.[1] as string;

type Hooks = {
  transform: (this: unknown, code: string, id: string) => { code: string; map: null } | null;
  buildEnd: (this: { error(msg: string): never }, error?: Error) => void;
};
const hooks = () => withoutObscenityWordList() as unknown as Hooks;
const ctx = { error: (msg: string): never => { throw new Error(msg); } };

describe('the cut on the real obscenity file', () => {
  const cut = cutObscenityWordList(real);

  it('removes the word list: none of its words is left, the file is much shorter', () => {
    expect(WORD).toBeTruthy();
    expect(real).toContain(WORD); // control: the real file does hold the list
    expect(cut).not.toContain(WORD);
    expect(cut).not.toMatch(/originalWord: '/); // no phrase of the list is left (a doc comment may still name the field)
    expect(cut.length).toBeLessThan(real.length / 3);
  });
  it('keeps what the matcher uses: the recommended transformers, byte for byte', () => {
    const upto = real.indexOf('exports.englishDataset = new DataSet_1.DataSet()');
    expect(cut.startsWith(real.slice(0, upto))).toBe(true);
    expect(cut).toContain('exports.englishRecommendedTransformers');
    expect(cut.endsWith('exports.englishDataset = new DataSet_1.DataSet();\n')).toBe(true);
  });
  it('still runs as CommonJS: the transformers load and the dataset is empty', () => {
    const req = createRequire(join(dirname(ENGLISH), 'x.js'));
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(`(function (exports, require, module) {${cut}\n})`, {})(mod.exports, req, mod);
    const ex = mod.exports as { englishRecommendedTransformers: { blacklistMatcherTransformers: unknown[] }; englishDataset: { build(): { blacklistedTerms: unknown[] } } };
    expect(ex.englishRecommendedTransformers.blacklistMatcherTransformers.length).toBeGreaterThan(0);
    expect(ex.englishDataset.build().blacklistedTerms).toEqual([]);
  });
});

describe('the plugin', () => {
  it('transforms the obscenity file, on posix and Windows paths and with a query', () => {
    for (const id of [ENGLISH.replaceAll('\\', '/'), ENGLISH.replaceAll('/', '\\'), `${ENGLISH.replaceAll('\\', '/')}?v=1`]) {
      const out = hooks().transform.call(ctx, real, id);
      expect(out?.code, id).not.toContain(WORD);
    }
  });
  it('leaves every other module alone', () => {
    const h = hooks();
    expect(h.transform.call(ctx, 'exports.englishDataset = new DataSet_1.DataSet().x', '/n/node_modules/other/dist/preset/english.js')).toBeNull();
    expect(h.transform.call(ctx, real, '/n/node_modules/obscenity/dist/index.js')).toBeNull();
    expect(h.transform.call(ctx, real, '/n/src/english.js')).toBeNull();
  });
  it('throws when the file is found but the dataset marker is gone (obscenity changed its layout)', () => {
    const changed = real.replace('exports.englishDataset = new DataSet_1.DataSet()', 'exports.englishDataset = makeDataSet()');
    expect(() => cutObscenityWordList(changed)).toThrow(/obscenity changed/);
    expect(() => hooks().transform.call(ctx, changed, ENGLISH)).toThrow(/obscenity changed/);
  });
  it('throws at the end of the build when it never matched a file (obscenity moved, renamed or an ESM build was resolved)', () => {
    expect(() => hooks().buildEnd.call(ctx)).toThrow(/never found obscenity/i);
  });
  it('does not throw at the end of the build once it has cut the file', () => {
    const h = hooks();
    h.transform.call(ctx, real, ENGLISH);
    expect(() => h.buildEnd.call(ctx)).not.toThrow();
  });
  it('does not hide an earlier build error behind its own', () => {
    expect(() => hooks().buildEnd.call(ctx, new Error('the real failure'))).not.toThrow();
  });
  it('counts per plugin instance (a second build starts from zero)', () => {
    const a = hooks();
    a.transform.call(ctx, real, ENGLISH);
    expect(() => hooks().buildEnd.call(ctx)).toThrow();
    expect(() => a.buildEnd.call(ctx)).not.toThrow();
  });
});
