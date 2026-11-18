import { describe, expect, it, vi } from 'vitest';
import { LiveTerms, loadTermPack } from '../src/index.js';
import type { TermPack, TermRecord } from '../src/index.js';
import { MemoryTermStore, syntheticTermPack } from '../src/fixtures/index.js';

// L2: the term store and `LiveTerms` carry `matchMode`. A term in a script written without spaces is `segment` unless an owner says `contains`; the mode is stored with the row, rebuilt into the matcher
// atomically, written to the audit row, and shown by the dry run per mode. Invented strings only.

const T0 = 1_700_000_000_000;
const FRAGMENT = '\u5c14\u5df4\u5c3c'; // inside the place name PLACE
const PLACE = '\u963f\u5c14\u5df4\u5c3c\u4e9a';
const INSIDE = `\u6211\u53bb\u8fc7${PLACE}\u65c5\u6e38`;
const OUTSIDE = `\u4f60\u597d\uff0c${FRAGMENT}\u3002\u518d\u89c1`;
const HAN = '\u4f50\u5c14\u5df4\u514b';
const KATA = '\u30be\u30eb\u30d0\u30af';
const HIRA = '\u305e\u308b\u3070\u304f';

interface Rig {
  store: MemoryTermStore;
  live: LiveTerms;
  warn: ReturnType<typeof vi.fn>;
}
async function loaded(pack: TermPack | null = syntheticTermPack(), store = new MemoryTermStore()): Promise<Rig> {
  const warn = vi.fn();
  const clock = { now: () => T0 };
  const live = new LiveTerms({ store, pack, clock, logger: { warn } });
  await live.load();
  return { store, live, warn };
}
const stored = (r: Rig, id: string): TermRecord => r.store.state.terms.find((t) => t.id === id) as TermRecord;
const modeOf = (r: Rig, id: string): string | null => stored(r, id).matchMode ?? null;
const add = async (r: Rig, term: string, language: string, matchMode?: 'word' | 'segment' | 'contains' | null) => {
  let id = '';
  const res = await r.live.change('alice', (e) => {
    id = e.addTerm({ term, language, ...(matchMode === undefined ? {} : { matchMode }) });
  });
  return { res, id };
};

describe('adding a term', () => {
  it('a Han term with no mode stores no mode and builds a segment term (it does not hit inside a longer dictionary word)', async () => {
    const r = await loaded();
    const { res, id } = await add(r, FRAGMENT, 'zh');
    expect(res.ok).toBe(true);
    expect(modeOf(r, id)).toBeNull();
    expect(r.live.match(INSIDE)).toBeNull();
    expect(r.live.match(OUTSIDE)).toEqual({ termId: id });
  });

  it('with contains it stores contains and hits inside the word', async () => {
    const r = await loaded();
    const { res, id } = await add(r, FRAGMENT, 'zh', 'contains');
    expect(res.ok).toBe(true);
    expect(modeOf(r, id)).toBe('contains');
    expect(r.live.match(INSIDE)).toEqual({ termId: id });
  });

  it('segment is stored as asked, and null is no mode', async () => {
    const r = await loaded();
    const a = await add(r, FRAGMENT, 'zh', 'segment');
    const b = await add(r, HAN, 'zh', null);
    expect(modeOf(r, a.id)).toBe('segment');
    expect(modeOf(r, b.id)).toBeNull();
    expect(Object.hasOwn(stored(r, b.id), 'matchMode')).toBe(false);
  });

  it('a Latin term with segment or contains is refused with the existing invalid code and nothing is written', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    for (const mode of ['segment', 'contains'] as const) {
      const res = await r.live.change('alice', (e) => e.addTerm({ term: 'glarnish', language: 'en', matchMode: mode }));
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(r.store.state).toEqual(before);
    expect(r.live.match('you glarnish')).toBeNull();
  });

  it('a Latin term with word or no mode is fine, and word on a Han term, an unknown mode and a mode of the wrong type are refused', async () => {
    const r = await loaded();
    expect((await add(r, 'glarnish', 'en', 'word')).res.ok).toBe(true);
    expect((await add(r, 'tarvonish', 'en')).res.ok).toBe(true);
    for (const mode of ['word', 'fuzzy', '', 5, {}] as const) {
      const res = (await add(r, HAN, 'zh', mode as never)).res;
      expect(res, String(mode)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(r.store.state.terms.some((t) => t.term === HAN)).toBe(false);
  });

  it('a language that does not fit the script, a Cyrillic term and a short term are refused, and the message never quotes the term', async () => {
    const r = await loaded();
    for (const [term, language, mode] of [[HAN, 'en', undefined], [HAN, 'th', undefined], ['\u4f50', 'zh', undefined], [HAN.slice(0, 2), 'zh', 'contains'], ['\u0437\u043e\u0440\u0431\u0430\u043a', 'ru', undefined]] as const) {
      const res = await r.live.change('alice', (e) => e.addTerm({ term, language, ...(mode === undefined ? {} : { matchMode: mode }) }));
      expect(res.ok, term).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('invalid');
        expect(res.error).not.toContain(term);
      }
    }
  });

  it('the stored word keeps its marks and its kana: Thai tone marks are not folded away, and hiragana is stored as typed', async () => {
    const r = await loaded();
    const thai = '\u0e17\u0e35\u0e48\u0e19\u0e31\u0e48\u0e19';
    const t = await add(r, thai, 'th');
    const h = await add(r, HIRA, 'ja');
    expect(stored(r, t.id).term).toBe(thai);
    expect(stored(r, h.id).term).toBe(HIRA);
    expect(r.live.match(`\u0e09\u0e31\u0e19\u0e40\u0e2b\u0e47\u0e19${thai}`)).not.toBeNull();
    expect(r.live.match(`\u3053\u308c\u306f${KATA}\u3067\u3059`)).toEqual({ termId: h.id });
  });
});

describe('words that read the same', () => {
  it('hiragana and katakana of one term are duplicates, and Thai words that differ only by a mark are not', async () => {
    const r = await loaded();
    expect((await add(r, KATA, 'ja')).res.ok).toBe(true);
    expect((await add(r, HIRA, 'ja')).res).toMatchObject({ ok: false, code: 'duplicate' });
    expect((await add(r, '\u0e01\u0e31\u0e1a', 'th')).res.ok).toBe(true);
    expect((await add(r, '\u0e01\u0e1a', 'th')).res.ok).toBe(true);
  });

  it('the same Han word twice is a duplicate whatever the mode', async () => {
    const r = await loaded();
    expect((await add(r, HAN, 'zh')).res.ok).toBe(true);
    expect((await add(r, HAN, 'ja', 'contains')).res).toMatchObject({ ok: false, code: 'duplicate' });
  });
});

describe('editing the mode', () => {
  it('rebuilds the matcher atomically: contains hits inside the word, segment (or null) does not again', async () => {
    const r = await loaded();
    const { id } = await add(r, FRAGMENT, 'zh');
    expect(r.live.match(INSIDE)).toBeNull();
    expect((await r.live.change('alice', (e) => e.updateTerm(id, { matchMode: 'contains' }))).ok).toBe(true);
    expect(modeOf(r, id)).toBe('contains');
    expect(r.live.match(INSIDE)).toEqual({ termId: id });
    expect((await r.live.change('alice', (e) => e.updateTerm(id, { matchMode: 'segment' }))).ok).toBe(true);
    expect(r.live.match(INSIDE)).toBeNull();
    expect((await r.live.change('alice', (e) => e.updateTerm(id, { matchMode: 'contains' }))).ok).toBe(true);
    expect((await r.live.change('alice', (e) => e.updateTerm(id, { matchMode: null }))).ok).toBe(true);
    expect(modeOf(r, id)).toBeNull();
    expect(r.live.match(INSIDE)).toBeNull();
  });

  it('a refused edit changes nothing: the old mode, the rows and the matcher stay', async () => {
    const r = await loaded();
    const { id } = await add(r, FRAGMENT, 'zh', 'contains');
    const before = structuredClone(r.store.state);
    for (const patch of [{ matchMode: 'word' as const }, { matchMode: 'fuzzy' as never }, { language: 'en' }, { term: 'x' }]) {
      const res = await r.live.change('alice', (e) => e.updateTerm(id, patch));
      expect(res, JSON.stringify(patch)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(r.store.state).toEqual(before);
    expect(r.live.match(INSIDE)).toEqual({ termId: id });
  });

  it('a word, a language and a mode change together; a mode alone on a Latin term is refused', async () => {
    const r = await loaded();
    const { id } = await add(r, FRAGMENT, 'zh');
    expect((await r.live.change('alice', (e) => e.updateTerm(id, { term: HAN, matchMode: 'contains' }))).ok).toBe(true);
    expect(stored(r, id)).toMatchObject({ term: HAN, matchMode: 'contains' });
    expect(await r.live.change('alice', (e) => e.updateTerm('syn:zorbak', { matchMode: 'contains' }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a toggle and a note keep the mode', async () => {
    const r = await loaded();
    const { id } = await add(r, FRAGMENT, 'zh', 'contains');
    await r.live.change('alice', (e) => e.setTermActive(id, false));
    await r.live.change('alice', (e) => e.setTermActive(id, true));
    await r.live.change('alice', (e) => e.updateTerm(id, { note: 'a note' }));
    expect(modeOf(r, id)).toBe('contains');
  });
});

describe('the audit trail and the lists', () => {
  it('the audit row of an add carries the mode, and an update carries the old one before and the new one after', async () => {
    const r = await loaded();
    const { id } = await add(r, FRAGMENT, 'zh', 'contains');
    await r.live.change('alice', (e) => e.updateTerm(id, { matchMode: 'segment' }));
    const rows = r.store.state.audit.filter((a) => a.subjectRef === id);
    expect(rows.map((a) => a.action)).toEqual(['term.add', 'term.update']);
    expect(JSON.parse(rows[0]!.afterJson)).toMatchObject({ matchMode: 'contains' });
    expect(JSON.parse(rows[1]!.beforeJson as string)).toMatchObject({ matchMode: 'contains' });
    expect(JSON.parse(rows[1]!.afterJson)).toMatchObject({ matchMode: 'segment' });
  });

  it('records() and rows carry matchMode for a row that has one, and a Latin or untouched row reads as it did', async () => {
    const r = await loaded();
    const { id } = await add(r, FRAGMENT, 'zh', 'contains');
    const rec = r.live.records().terms.find((t) => t.id === id);
    expect(rec?.matchMode).toBe('contains');
    expect(r.live.rows.terms.find((t) => t.id === id)?.matchMode).toBe('contains');
    const latin = r.live.records().terms.find((t) => t.id === 'syn:zorbak');
    expect(Object.hasOwn(latin as object, 'matchMode')).toBe(false);
  });

  it('no log line carries a term', async () => {
    const r = await loaded();
    await add(r, FRAGMENT, 'zh', 'contains');
    await add(r, HAN, 'en');
    expect(JSON.stringify(r.warn.mock.calls)).not.toContain(FRAGMENT);
    expect(JSON.stringify(r.warn.mock.calls)).not.toContain(HAN);
  });
});

describe('the dry run', () => {
  const lines = [INSIDE, OUTSIDE, `\u4f60\u597d${HAN}`, '\u4f60\u597d\u518d\u89c1'];

  it('reports the mode it used, and how many recent lines it would block per mode: contains shows the larger number', async () => {
    const r = await loaded();
    const segment = r.live.check(FRAGMENT, 'zh', lines);
    const contains = r.live.check(FRAGMENT, 'zh', lines, 'contains');
    expect(segment).toMatchObject({ ok: true, matchMode: 'segment', hits: [OUTSIDE] });
    expect(contains).toMatchObject({ ok: true, matchMode: 'contains' });
    if (segment.ok && contains.ok) {
      expect(contains.hits.sort()).toEqual([INSIDE, OUTSIDE].sort());
      expect(contains.hits.length).toBeGreaterThan(segment.hits.length);
    }
  });

  it('reads the pack\'s negative corpus too, per mode, and leaves out known losses', async () => {
    const pack = syntheticTermPack({ negativeCorpus: [INSIDE, '\u4f60\u597d'], knownLosses: [] });
    const r = await loaded(pack);
    expect(r.live.check(FRAGMENT, 'zh', [])).toMatchObject({ ok: true, hits: [] });
    expect(r.live.check(FRAGMENT, 'zh', [], 'contains')).toMatchObject({ ok: true, hits: [INSIDE] });
    const lossy = await loaded(syntheticTermPack({ negativeCorpus: [INSIDE], knownLosses: [INSIDE] }));
    expect(lossy.live.check(FRAGMENT, 'zh', [], 'contains')).toMatchObject({ ok: true, hits: [] });
  });

  it('a Latin term reports no mode, and a mode that does not fit is the error the add would give, without the term', async () => {
    const r = await loaded();
    const latin = r.live.check('glarnish', 'en', ['you glarnish']);
    expect(latin).toMatchObject({ ok: true, hits: ['you glarnish'] });
    expect(Object.hasOwn(latin as object, 'matchMode')).toBe(false);
    const bad = r.live.check('glarnish', 'en', [], 'contains');
    expect(bad.ok).toBe(false);
    const mismatch = r.live.check(HAN, 'en', []);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).not.toContain(HAN);
  });

  it('writes nothing', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    r.live.check(FRAGMENT, 'zh', [INSIDE], 'contains');
    expect(r.store.state).toEqual(before);
  });
});

describe('packs and syncing', () => {
  const rowOf = (id: string, term: string, language: string, matchMode?: 'segment' | 'contains') => ({ id, term, language, active: true, positive: [], negative: [], ...(matchMode === undefined ? {} : { matchMode }) });
  const packOf = (...terms: ReturnType<typeof rowOf>[]): TermPack => loadTermPack({ id: 'p', version: '1', terms: [rowOf('t:latin', 'zorbak', 'en'), ...terms], exceptions: [], negativeCorpus: [], knownLosses: [] });

  it('seeding copies a pack row\'s mode into the store and the matcher honours it', async () => {
    const r = await loaded(packOf(rowOf('t:han', FRAGMENT, 'zh', 'contains')));
    expect(modeOf(r, 't:han')).toBe('contains');
    expect(r.live.match(INSIDE)).toEqual({ termId: 't:han' });
    const plain = await loaded(packOf(rowOf('t:han', FRAGMENT, 'zh')));
    expect(modeOf(plain, 't:han')).toBeNull();
    expect(plain.live.match(INSIDE)).toBeNull();
  });

  it('syncPack adds a row with its mode, changes the mode of an untouched row, and leaves a row a person edited alone', async () => {
    const r = await loaded(packOf(rowOf('t:han', FRAGMENT, 'zh')));
    const added = r.live.syncPack(packOf(rowOf('t:han', FRAGMENT, 'zh', 'contains'), rowOf('t:kata', KATA, 'ja', 'contains')), { actor: 'corpus:1' });
    expect(added.ok).toBe(true);
    expect(modeOf(r, 't:han')).toBe('contains');
    expect(modeOf(r, 't:kata')).toBe('contains');
    // a person edits the mode: the next release leaves it
    await r.live.change('alice', (e) => e.updateTerm('t:han', { matchMode: 'segment' }));
    r.live.syncPack(packOf(rowOf('t:han', FRAGMENT, 'zh', 'contains')), { actor: 'corpus:2' });
    expect(modeOf(r, 't:han')).toBe('segment');
  });

  it('a stored row that cannot be used makes the matcher fall back to the pack with its modes', async () => {
    const store = new MemoryTermStore();
    store.fail = (method) => {
      if (method === 'listTerms') throw new Error('disk');
    };
    const r = await loaded(packOf(rowOf('t:han', FRAGMENT, 'zh', 'contains')), store);
    expect(r.live.usingPack).toBe(true);
    expect(r.live.match(INSIDE)).toEqual({ termId: 't:han' });
  });
});
