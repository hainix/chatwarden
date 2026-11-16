import { describe, expect, it } from 'vitest';
import { buildMatcher, loadTermPack } from '../src/index.js';
import { CorpusError } from '../src/corpus/index.js';
import { parseTermsRelease, type TermsRelease } from '../src/corpus/release.js';
import { releaseToPack, type PackSelection } from '../src/corpus/select.js';
import { exampleNegative, generatedTerms, inventedWords, releaseFiles, type Json, type ReleaseParts } from './corpus-world.js';

const WORDS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
const release = (parts: ReleaseParts = {}): TermsRelease => parseTermsRelease(releaseFiles(parts));
const ids = (pack: ReturnType<typeof releaseToPack>, active?: boolean): string[] =>
  pack.terms.filter((t) => active === undefined || t.active === active).map((t) => t.id.slice(-2));

describe('releaseToPack: selection', () => {
  const r = release();

  it('releaseToPack: languages, categories, minSeverity and statuses select as documented; defaults are hostile and both statuses', () => {
    // defaults for en: zorbak (severe), vlemmo (hostile) active; quissel is rude, so below the default; snerp (withdrawn) and glarn
    // (default-off) ride along inactive
    const en = releaseToPack(r, { languages: ['en'] });
    expect(en.id).toBe('chatwarden-corpus');
    expect(en.version).toBe('2026.12.0');
    expect(ids(en)).toEqual(['01', '02', '07', '08']);
    expect(ids(en, true)).toEqual(['01', '02']);
    // minSeverity: rude lets quissel in; severe drops vlemmo
    expect(ids(releaseToPack(r, { languages: ['en'], minSeverity: 'rude' }), true)).toEqual(['01', '02', '03']);
    expect(ids(releaseToPack(r, { languages: ['en'], minSeverity: 'hostile' }), true)).toEqual(['01', '02']);
    expect(ids(releaseToPack(r, { languages: ['en'], minSeverity: 'severe' }), true)).toEqual(['01']);
    // categories: only slurs (zorbak, and the inactive rows that are slurs by language); abuse only adds vlemmo (and quissel with rude)
    expect(ids(releaseToPack(r, { languages: ['en'], categories: ['slur'] }), true)).toEqual(['01']);
    expect(ids(releaseToPack(r, { languages: ['en'], categories: ['abuse'] }), true)).toEqual(['02']);
    expect(ids(releaseToPack(r, { languages: ['en'], categories: ['abuse'], minSeverity: 'rude' }), true)).toEqual(['02', '03']);
    expect(ids(releaseToPack(r, { languages: ['en'], categories: ['sexual', 'other'] }), true)).toEqual([]);
    // statuses: accepted only drops the provisional rows; both is the default
    expect(ids(releaseToPack(r, { languages: ['es'], statuses: ['accepted'] }), true)).toEqual(['05']);
    expect(ids(releaseToPack(r, { languages: ['es'], statuses: ['accepted', 'provisional'] }), true)).toEqual(['04', '05']);
    expect(ids(releaseToPack(r, { languages: ['es'] }), true)).toEqual(['04', '05']);
    expect(ids(releaseToPack(r, { languages: ['es'], statuses: ['provisional'] }), true)).toEqual(['04']);
    // a row carries the first of its languages that was asked for
    expect(releaseToPack(r, { languages: ['pt', 'es'] }).terms.find((t) => t.id.endsWith('05'))!.language).toBe('pt');
    expect(releaseToPack(r, { languages: ['es', 'pt'] }).terms.find((t) => t.id.endsWith('05'))!.language).toBe('es');
    // the pack's own rows carry the lines; rows are in release order
    const zorbak = en.terms[0]!;
    expect(zorbak).toEqual({ id: 'CWT-2026-00001', term: 'zorbak', language: 'en', active: true, positive: ['you zorbak', 'ZORBAK!!'], negative: ['zorbakian', 'szorbak'] });
    // the release is not changed by selecting from it
    releaseToPack(r, { languages: ['en', 'es', 'pt'], minSeverity: 'rude' });
    expect(r.terms).toHaveLength(8);
    expect(r.terms[0]!.defaultActive).toBe(true);
  });

  it('pt-BR and pt-PT select pt; case and region are ignored; a repeated language is one', () => {
    const base = ids(releaseToPack(r, { languages: ['pt'] }));
    expect(base).toEqual(['05', '06']);
    for (const tag of ['pt-BR', 'pt-PT', 'PT', 'Pt-br', 'pt_BR', ' pt ']) expect(ids(releaseToPack(r, { languages: [tag] })), tag).toEqual(base);
    expect(releaseToPack(r, { languages: ['en', 'EN', 'en-US', 'en-GB'] })).toEqual(releaseToPack(r, { languages: ['en'] }));
    // an exception follows the same rule
    expect(releaseToPack(r, { languages: ['pt-BR'] }).exceptions.map((e) => e.id)).toEqual(['CWX-2026-00008']);
  });

  it('releaseToPack: a disputed and a withdrawn row load inactive; a defaultActive:false row loads inactive; none is ever switched on by the loader', () => {
    const options: Array<Partial<PackSelection>> = [
      {},
      { minSeverity: 'rude' },
      { minSeverity: 'severe' },
      { statuses: ['accepted'] },
      { statuses: ['provisional'] },
      { categories: ['slur'] },
      { categories: ['other', 'abuse', 'sexual', 'slur'] },
    ];
    const languageSets = [['en'], ['es'], ['pt'], ['en', 'es'], ['en', 'es', 'pt'], ['pt-BR', 'es']];
    let seenDisputed = 0;
    let seenWithdrawn = 0;
    let seenDefaultOff = 0;
    for (const languages of languageSets) {
      for (const opt of options) {
        const pack = releaseToPack(r, { languages, ...opt });
        for (const row of pack.terms) {
          const source = r.terms.find((t) => t.id === row.id)!;
          if (source.status === 'disputed') {
            seenDisputed += 1;
            expect(row.active, `${row.id} disputed`).toBe(false);
          }
          if (source.status === 'withdrawn') {
            seenWithdrawn += 1;
            expect(row.active, `${row.id} withdrawn`).toBe(false);
          }
          if (!source.defaultActive) {
            seenDefaultOff += 1;
            expect(row.active, `${row.id} default off`).toBe(false);
          }
          if (row.active) expect(['accepted', 'provisional']).toContain(source.status);
        }
        for (const ex of pack.exceptions) {
          if (r.exceptions.find((e) => e.id === ex.id)!.status === 'withdrawn') expect(ex.active).toBe(false);
        }
      }
    }
    // controls: the loops did reach the rows the claims are about
    expect(seenDisputed).toBeGreaterThan(0);
    expect(seenWithdrawn).toBeGreaterThan(0);
    expect(seenDefaultOff).toBeGreaterThan(0);
    // a withdrawn or disputed row stays in the pack for a language that is asked for even when the filters would drop an active one
    expect(ids(releaseToPack(r, { languages: ['en'], minSeverity: 'severe', categories: ['abuse'], statuses: ['provisional'] }))).toEqual(['07']);
    expect(ids(releaseToPack(r, { languages: ['pt'], minSeverity: 'severe', categories: ['abuse'], statuses: ['provisional'] }))).toEqual(['06']);
    // and a language that is not asked for brings none of them
    expect(ids(releaseToPack(r, { languages: ['es'] }))).not.toContain('07');
  });

  it('releaseToPack: collidesWith switches a row off only when the colliding language is also selected', () => {
    // drakkuun is Spanish and an ordinary English word: off when English is installed too, on when Spanish stands alone
    const row = (languages: string[]) => releaseToPack(r, { languages }).terms.find((t) => t.id.endsWith('04'));
    expect(row(['es'])!.active).toBe(true);
    expect(row(['es', 'pt'])!.active).toBe(true);
    expect(row(['es', 'en'])!.active).toBe(false);
    expect(row(['en', 'es'])!.active).toBe(false);
    expect(row(['pt', 'es', 'en'])!.active).toBe(false);
    expect(row(['es-ES', 'EN-gb'])!.active).toBe(false);
    // the row is still there when it is off (so a later sync can follow it), and English alone does not carry a Spanish-only row
    expect(row(['en'])).toBeUndefined();
    // a row that collides with a language that is not selected is on
    const files = release({ terms: [...(r.terms as unknown as Json[]).slice(0, 3), { ...r.terms[3], collidesWith: ['pt'] }] });
    expect(releaseToPack(files, { languages: ['es', 'en'] }).terms.find((t) => t.id.endsWith('04'))!.active).toBe(true);
    expect(releaseToPack(files, { languages: ['es', 'pt'] }).terms.find((t) => t.id.endsWith('04'))!.active).toBe(false);
  });

  it('exceptions: selected by language and status; withdrawn and disputed ride along off', () => {
    expect(releaseToPack(r, { languages: ['en'] }).exceptions).toEqual([
      { id: 'CWX-2026-00007', phrase: 'snerp glarn', language: 'en', active: true },
      { id: 'CWX-2026-00009', phrase: 'quissel bay', language: 'en', active: false },
    ]);
    expect(releaseToPack(r, { languages: ['pt'] }).exceptions.map((e) => [e.id, e.active])).toEqual([['CWX-2026-00008', true]]);
    expect(releaseToPack(r, { languages: ['pt'], statuses: ['accepted'] }).exceptions).toEqual([]);
    expect(releaseToPack(r, { languages: ['es'] }).exceptions).toEqual([]);
  });

  it('the negative corpus, the known losses and the positive corpus are merged for the selected languages', () => {
    const files = release({
      negative: {
        en: exampleNegative('en', { lines: ['one', 'two', 'shared line'], knownLosses: ['loss en'] }),
        es: exampleNegative('es', { lines: ['tres', 'shared line'], knownLosses: ['loss es', 'loss en'] }),
        pt: exampleNegative('pt', { lines: ['quatro'], knownLosses: [] }),
      },
      positive: { schema: 'chatwarden-corpus-positive/1', lines: ['p1', 'p2'] },
    });
    const both = releaseToPack(files, { languages: ['en', 'es'] });
    expect(both.negativeCorpus).toEqual(['one', 'two', 'shared line', 'tres']);
    expect(both.knownLosses).toEqual(['loss en', 'loss es']);
    expect(both.positiveCorpus).toEqual(['p1', 'p2']);
    expect(releaseToPack(files, { languages: ['es', 'en'] }).negativeCorpus).toEqual(['tres', 'shared line', 'one', 'two']);
    expect(releaseToPack(files, { languages: ['pt'] }).negativeCorpus).toEqual(['quatro']);
    expect(releaseToPack(files, { languages: ['pt'] }).knownLosses).toEqual([]);
    // a selected language with no negative file adds nothing, and no positive.json leaves no positiveCorpus key
    const sparse = release({ negative: { en: exampleNegative('en') }, positive: null });
    const pack = releaseToPack(sparse, { languages: ['en', 'pt'] });
    expect(pack.negativeCorpus).toEqual(['a plain en sentence', 'another en sentence']);
    expect('positiveCorpus' in pack).toBe(false);
    expect(releaseToPack(sparse, { languages: ['pt'] }).negativeCorpus).toEqual([]);
  });

  it('an empty selection (no language) is a RangeError naming the option, not a value; so is every other option out of range', () => {
    const refuses = (select: unknown, option: string): void => {
      let err: unknown;
      try {
        releaseToPack(r, select as PackSelection);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(select)).toBeInstanceOf(RangeError);
      expect((err as RangeError).message, JSON.stringify(select)).toContain(option);
      for (const w of WORDS) expect((err as RangeError).message.toLowerCase()).not.toContain(w);
    };
    for (const languages of [[], undefined, null, 'en', [''], [' '], [null], [5], ['english'], ['e1'], ['en', 'zorbak vlemmo'], ['zorbak'], {}, ['x']]) {
      refuses({ languages }, 'languages');
    }
    refuses({}, 'languages');
    refuses(undefined, 'languages');
    refuses(null, 'languages');
    refuses('en', 'languages');
    for (const categories of [[], ['zorbak'], 'slur', [1], ['Slur'], null]) refuses({ languages: ['en'], categories }, 'categories');
    for (const minSeverity of ['banter', 'zorbak', '', 'Severe', 5, null, ['severe']]) refuses({ languages: ['en'], minSeverity }, 'minSeverity');
    for (const statuses of [[], ['disputed'], ['withdrawn'], ['accepted', 'zorbak'], 'accepted', [2], null]) refuses({ languages: ['en'], statuses }, 'statuses');
    // a getter that throws is a RangeError too, never another class
    const hostile = { get languages(): string[] { throw new Error('vlemmo'); } };
    expect(() => releaseToPack(r, hostile as unknown as PackSelection)).toThrow(RangeError);
    // controls: undefined optional options are the defaults
    expect(() => releaseToPack(r, { languages: ['en'], categories: undefined, minSeverity: undefined, statuses: undefined })).not.toThrow();
  });
});

describe('releaseToPack: the result is a pack', () => {
  it('releaseToPack: the result passes loadTermPack and builds with buildMatcher; positive lines of an active term are matched by it, negative lines of every term are not (a generated pack of invented words)', () => {
    const words = inventedWords(120, 7);
    const rows = generatedTerms(words);
    const parsed = parseTermsRelease(releaseFiles({ terms: rows, exceptions: [], negative: { en: exampleNegative('en'), es: exampleNegative('es'), pt: exampleNegative('pt') } }));
    for (const select of [{ languages: ['en'] }, { languages: ['es'] }, { languages: ['en', 'es', 'pt'], minSeverity: 'rude' as const }, { languages: ['pt-BR'], statuses: ['accepted' as const] }]) {
      const pack = releaseToPack(parsed, select);
      expect(() => loadTermPack(pack)).not.toThrow();
      const matcher = buildMatcher(pack.terms, pack.exceptions);
      let activeSeen = 0;
      for (const t of pack.terms) {
        if (t.active) {
          activeSeen += 1;
          for (const line of t.positive) expect(matcher.match(line)?.termId, `${t.id} ${line}`).toBe(t.id);
        }
        // the negative lines of every term, active or not, are not blocked by anything in the pack
        for (const line of t.negative) expect(matcher.match(line), `${t.id} ${line}`).toBeNull();
      }
      expect(activeSeen).toBeGreaterThan(0);
      // an inactive row is never matched, though its own positive lines are in the pack
      for (const t of pack.terms.filter((x) => !x.active)) expect(matcher.match(`you ${t.term}`)).toBeNull();
    }
  });

  it('a hand-made release whose rows would not load is bad_pack at the validate stage, with a fixed message', () => {
    const parsed = release();
    const twin = { ...parsed, terms: [parsed.terms[0]!, { ...parsed.terms[1]!, term: 'ZORBAK' }] } as TermsRelease;
    const tooShort = { ...parsed, terms: [{ ...parsed.terms[0]!, term: 'zo' }] } as TermsRelease;
    const sameId = { ...parsed, terms: [parsed.terms[0]!, { ...parsed.terms[1]!, id: parsed.terms[0]!.id }] } as TermsRelease;
    for (const bad of [twin, tooShort, sameId]) {
      let err: unknown;
      try {
        releaseToPack(bad, { languages: ['en'] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CorpusError);
      expect((err as CorpusError).code).toBe('bad_pack');
      expect((err as CorpusError).stage).toBe('validate');
      for (const w of WORDS) expect(String(err).toLowerCase()).not.toContain(w);
    }
  });

  it('no function in select.ts puts a term or line in an error message (Review Focus 4): a hostile release and hostile options', () => {
    const parsed = release();
    const hostile = { ...parsed, terms: parsed.terms.map((t) => ({ ...t, term: `${t.term}9` })) } as TermsRelease;
    let err: unknown;
    try {
      releaseToPack(hostile, { languages: ['en'] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CorpusError);
    const text = [String((err as Error).message), JSON.stringify(err), JSON.stringify(Object.getOwnPropertyNames(err as object))].join(' ').toLowerCase();
    for (const w of WORDS) expect(text).not.toContain(w);
  });
});
