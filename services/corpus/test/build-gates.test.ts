import { parseTermsRelease } from '@chatwarden/matcher/corpus';
import { describe, expect, it } from 'vitest';
import { GateFault, languageSelections, runGates } from '../src/build/gates.js';
import { buildFromSnapshot } from '../src/build/release.js';
import type { Snapshot, TermRecord } from '../src/build/snapshot.js';
import { makeClock } from './world.js';

// The gates, on a snapshot built in memory (no database): the selections, the counts, and what each failure holds.

const rec = (over: Partial<TermRecord>): TermRecord => ({
  id: 'CWT-2026-00001', wordKey: 'zorbak', term: 'zorbak', languages: ['en'], category: 'abuse', target: 'none', severity: 'hostile', status: 'accepted', defaultActive: true,
  storedCollidesWith: [], freshCollidesWith: [], since: null, approvals: 2, positiveLines: [], negativeLines: [], dictionary: [], ...over,
});
const snap = (terms: TermRecord[], negativeCorpus: Record<string, string[]> = { en: [], es: [], pt: [] }): Snapshot => ({ terms, negativeCorpus });
const clock = makeClock('2026-12-01T09:00:00Z');
const opts = { clock, version: '2026.12.0', sequence: 1, previous: null };

describe('languageSelections', () => {
  it('is every non-empty set for up to four languages, in a fixed order', () => {
    expect(languageSelections(['en', 'es', 'pt'])).toEqual([['en'], ['es'], ['en', 'es'], ['pt'], ['en', 'pt'], ['es', 'pt'], ['en', 'es', 'pt']]);
    expect(languageSelections(['en'])).toEqual([['en']]);
    expect(languageSelections([])).toEqual([]);
  });

  it('is each language alone and all together for five or more', () => {
    expect(languageSelections(['a', 'b', 'c', 'd', 'e'])).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['a', 'b', 'c', 'd', 'e']]);
  });
});

describe('the gates over a snapshot', () => {
  it('counts the lines it checked (positive: rows and the pack-wide file; negative: rows and the corpus; cross-language: dictionary words)', () => {
    const r = buildFromSnapshot(
      snap([rec({ dictionary: [{ word: 'zorbakian', languages: ['en'] }, { word: 'unzorbak', languages: ['es'] }] })], { en: ['a plain line'], es: ['una linea'], pt: [] }),
      opts,
    );
    expect(r.gate.positiveLines).toBe(r.release.terms[0]!.positive.length + r.release.positive.length);
    expect(r.gate.negativeLines).toBe(2 + 2); // two row negatives (the dictionary words) and two corpus lines
    expect(r.gate.crossLanguageLines).toBe(2);
    expect(r.release.manifest.gate).toMatchObject({ positiveLines: r.gate.positiveLines, negativeLines: r.gate.negativeLines, crossLanguageLines: 2, passed: true });
  });

  it('a dictionary word of a language that is not installed is not asked to pass: only the collision decides', () => {
    // "zorbak" is an ordinary Spanish word: the English row collides with es, so it is on for English and off with Spanish installed.
    const r = buildFromSnapshot(snap([rec({ freshCollidesWith: ['es'], dictionary: [{ word: 'zorbak', languages: ['es'] }] })]), opts);
    expect(r.held).toEqual([]);
    // Without the collision recorded the same word fails the selection that has Spanish and the row is held.
    const held = buildFromSnapshot(snap([rec({ dictionary: [{ word: 'zorbak', languages: ['es'] }] })]), opts);
    expect(held.held).toEqual([{ id: 'CWT-2026-00001', code: 'innocent_word_blocked' }]);
  });

  it('the blocking term is the one held, even when the word is in another term\u2019s dictionary list', () => {
    const a = rec({ id: 'CWT-2026-00001', dictionary: [{ word: 'vlemmo', languages: ['en'] }] });
    const b = rec({ id: 'CWT-2026-00002', wordKey: 'vlemmo', term: 'vlemmo' });
    const r = buildFromSnapshot(snap([a, b]), opts);
    expect(r.held).toEqual([{ id: 'CWT-2026-00002', code: 'innocent_word_blocked' }]);
    expect(r.release.terms.map((t) => t.id)).toEqual(['CWT-2026-00001']);
  });

  it('a published term (since set) that fails stops the build with its id, and a never-published one in the same build does not hide it', () => {
    const a = rec({ id: 'CWT-2026-00001', since: '2026.11.0' });
    const b = rec({ id: 'CWT-2026-00002', wordKey: 'vlemmo', term: 'vlemmo' });
    const corpus = { en: ['the zorbak and the vlemmo'], es: [], pt: [] };
    const err = (() => { try { buildFromSnapshot(snap([a, b], corpus), opts); } catch (e) { return e; } return null; })();
    expect(err).toMatchObject({ code: 'gate_failed', ids: ['CWT-2026-00001'] });
  });

  it('a withdrawn row that would block a corpus line is published, inactive, and passes', () => {
    const r = buildFromSnapshot(snap([rec({ status: 'withdrawn' })], { en: ['a zorbak'], es: [], pt: [] }), opts);
    expect(r.held).toEqual([]);
    expect(r.release.terms[0]?.status).toBe('withdrawn');
  });

  it('runGates throws a GateFault (not a hold) when a pack-wide line has no owner', () => {
    const r = buildFromSnapshot(snap([rec({})]), opts);
    const release = parseTermsRelease(r.files, { version: '2026.12.0', sequence: 1 });
    release.positive.push('no such line');
    expect(() => runGates({ release, records: new Map(), negativeCorpus: {}, positiveOwner: new Map(), languages: ['en', 'es', 'pt'] })).toThrow(GateFault);
  });
});
