import { describe, expect, it, vi } from 'vitest';
import { LiveTerms, type TermPack } from '../src/index.js';
import { MemoryTermStore, syntheticTermPack } from '../src/fixtures/index.js';

const T0 = 1_700_000_000_000;
const VERSION = '2026.12.0';
const ACTOR = `corpus:${VERSION}`;

type PackTerm = { id: string; term: string; active?: boolean; language?: string; positive?: string[] };
type PackException = { id: string; phrase: string; active?: boolean };

/** A hand-made pack of invented words (what the loader builds from a release, minus the zip). */
function pack(
  version: string,
  terms: PackTerm[],
  over: { exceptions?: PackException[]; negativeCorpus?: string[]; knownLosses?: string[]; positiveCorpus?: string[]; id?: string } = {},
): TermPack {
  return {
    id: over.id ?? 'chatwarden-corpus',
    version,
    terms: terms.map((t) => ({
      id: t.id,
      term: t.term,
      language: t.language ?? 'en',
      active: t.active ?? true,
      positive: t.positive ?? [`you ${t.term}`],
      negative: [],
    })),
    exceptions: (over.exceptions ?? []).map((e) => ({ id: e.id, phrase: e.phrase, language: 'en', active: e.active ?? true })),
    negativeCorpus: over.negativeCorpus ?? [],
    knownLosses: over.knownLosses ?? [],
    ...(over.positiveCorpus === undefined ? {} : { positiveCorpus: over.positiveCorpus }),
  };
}

const BASE = (): TermPack =>
  pack('2026.11.0', [
    { id: 'CWT-1', term: 'zorbak' },
    { id: 'CWT-2', term: 'vlemmo' },
    { id: 'CWT-3', term: 'quissel' },
  ]);

interface Rig {
  store: MemoryTermStore;
  live: LiveTerms;
  warn: ReturnType<typeof vi.fn>;
}
async function loaded(initial: TermPack | null = BASE(), store = new MemoryTermStore()): Promise<Rig> {
  const warn = vi.fn();
  const clock = { now: () => T0 };
  const live = new LiveTerms({ store, pack: initial, clock, logger: { warn } });
  await live.load();
  return { store, live, warn };
}
const blocked = (live: LiveTerms, text: string) => live.match(text) !== null;
const ZERO = { added: 0, deactivated: 0, reactivated: 0, changed: 0, keptYours: 0, skipped: 0 };
const summaryOf = (r: ReturnType<LiveTerms['syncPack']>) => {
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.summary;
};
const snapshotOf = (store: MemoryTermStore) => structuredClone(store.state);
const row = (store: MemoryTermStore, id: string) => store.state.terms.find((t) => t.id === id)!;

describe('syncPack', () => {
  it('syncPack: adds new rows with the corpus actor, follows an untouched row\'s text and active, and writes the existing audit rows', async () => {
    // CWT-3 starts inactive in the store, so the second release can reactivate it.
    const seeded = await loaded(pack('2026.11.0', [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-3', term: 'quissel', active: false }]));
    expect(blocked(seeded.live, 'you quissel')).toBe(false);
    const auditBefore = seeded.store.state.audit.length;
    const next = pack(VERSION, [
      { id: 'CWT-1', term: 'zorbak', active: false },
      { id: 'CWT-2', term: 'vlemmox' },
      { id: 'CWT-3', term: 'quissel' },
      { id: 'CWT-4', term: 'drakkuun' },
    ]);
    const res = seeded.live.syncPack(next, { actor: ACTOR });
    expect(res).toEqual({ ok: true, version: VERSION, summary: { added: 1, deactivated: 1, reactivated: 1, changed: 1, keptYours: 0, skipped: 0 } });
    expect(row(seeded.store, 'CWT-1')).toMatchObject({ active: false, updatedBy: ACTOR });
    expect(row(seeded.store, 'CWT-2')).toMatchObject({ term: 'vlemmox', active: true, updatedBy: ACTOR });
    expect(row(seeded.store, 'CWT-3')).toMatchObject({ active: true });
    expect(row(seeded.store, 'CWT-4')).toMatchObject({ term: 'drakkuun', active: true, addedBy: ACTOR, updatedBy: null, addedAt: T0 });
    // The live matcher swapped.
    expect(blocked(seeded.live, 'you zorbak')).toBe(false);
    expect(blocked(seeded.live, 'you vlemmo')).toBe(false);
    expect(blocked(seeded.live, 'you vlemmox')).toBe(true);
    expect(blocked(seeded.live, 'you quissel')).toBe(true);
    expect(blocked(seeded.live, 'you drakkuun')).toBe(true);
    // The existing audit names, one row per real change, written by the corpus actor.
    const rows = seeded.store.state.audit.slice(auditBefore);
    expect(rows.map((a) => [a.action, a.subjectRef, a.actor]).sort()).toEqual(
      [
        ['term.add', 'CWT-4', ACTOR],
        ['term.toggle', 'CWT-1', ACTOR],
        ['term.toggle', 'CWT-3', ACTOR],
        ['term.update', 'CWT-2', ACTOR],
      ].sort(),
    );
    const added = rows.find((a) => a.action === 'term.add')!;
    expect(added.beforeJson).toBeNull();
    expect(JSON.parse(added.afterJson)).toMatchObject({ id: 'CWT-4', active: true, addedBy: ACTOR });
    const toggled = rows.find((a) => a.subjectRef === 'CWT-1')!;
    expect(JSON.parse(toggled.beforeJson!)).toMatchObject({ active: true });
    expect(JSON.parse(toggled.afterJson)).toMatchObject({ active: false });
    expect(seeded.store.state.terms).toHaveLength(4);
  });

  it('syncPack: a row a moderator toggled, renamed or re-noted is kept (keptYours) and is never reactivated or deactivated', async () => {
    const r = await loaded();
    expect((await r.live.change('alice', (e) => e.setTermActive('CWT-1', false))).ok).toBe(true);
    expect((await r.live.change('bob', (e) => e.updateTerm('CWT-2', { term: 'vlemmoz' }))).ok).toBe(true);
    expect((await r.live.change('cy', (e) => e.updateTerm('CWT-3', { note: 'ours' }))).ok).toBe(true);
    const before = snapshotOf(r.store);
    // The release says the opposite on every row: CWT-1 on, CWT-2 back to its word, CWT-3 off.
    const next = pack(VERSION, [
      { id: 'CWT-1', term: 'zorbak', active: true },
      { id: 'CWT-2', term: 'vlemmo' },
      { id: 'CWT-3', term: 'quissel', active: false },
      { id: 'CWT-9', term: 'tarvo' },
    ]);
    const res = r.live.syncPack(next, { actor: ACTOR });
    expect(summaryOf(res)).toEqual({ ...ZERO, added: 1, keptYours: 3 });
    for (const id of ['CWT-1', 'CWT-2', 'CWT-3']) {
      expect(row(r.store, id)).toEqual(before.terms.find((t) => t.id === id));
    }
    expect(blocked(r.live, 'you zorbak')).toBe(false); // still off: a switched-off term stays off
    expect(blocked(r.live, 'you vlemmoz')).toBe(true);
    expect(blocked(r.live, 'you quissel')).toBe(true);
    // And again, with the same pack and a second, later one: still theirs.
    expect(summaryOf(r.live.syncPack(next, { actor: ACTOR }))).toEqual({ ...ZERO, keptYours: 3 });
    expect(summaryOf(r.live.syncPack(pack('2027.01.0', next.terms.map((t) => ({ ...t }))), { actor: 'corpus:2027.01.0' }))).toEqual({ ...ZERO, keptYours: 3 });
    expect(row(r.store, 'CWT-1').active).toBe(false);
  });

  it('syncPack: a row the corpus itself changed is still the corpus\'s to change, until a human edits it', async () => {
    const r = await loaded();
    expect(summaryOf(r.live.syncPack(pack('2026.12.0', [{ id: 'CWT-1', term: 'zorbak', active: false }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-3', term: 'quissel' }]), { actor: 'corpus:2026.12.0' }))).toEqual({ ...ZERO, deactivated: 1 });
    // A later release restores the row: the corpus's own earlier stamp does not make it "touched".
    expect(summaryOf(r.live.syncPack(pack('2027.01.0', [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-3', term: 'quissel' }]), { actor: 'corpus:2027.01.0' }))).toEqual({ ...ZERO, reactivated: 1 });
    // A human switches it off: from now on it is theirs.
    expect((await r.live.change('alice', (e) => e.setTermActive('CWT-1', false))).ok).toBe(true);
    expect(summaryOf(r.live.syncPack(pack('2027.02.0', [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-3', term: 'quissel' }]), { actor: 'corpus:2027.02.0' }))).toEqual({ ...ZERO, keptYours: 1 });
    expect(row(r.store, 'CWT-1').active).toBe(false);
  });

  it('syncPack: a term the adopter added is never touched; nothing is ever deleted; a withdrawn pack row only deactivates', async () => {
    const r = await loaded();
    const added = await r.live.change('alice', (e) => e.addTerm({ term: 'snerp', language: 'en' }));
    if (!added.ok) throw new Error('setup');
    const mine = added.value;
    const before = snapshotOf(r.store);
    // The release no longer lists CWT-2 at all and withdraws CWT-3 (inactive row).
    const next = pack(VERSION, [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-3', term: 'quissel', active: false }]);
    expect(summaryOf(r.live.syncPack(next, { actor: ACTOR }))).toEqual({ ...ZERO, deactivated: 1 });
    expect(row(r.store, mine)).toEqual(before.terms.find((t) => t.id === mine));
    expect(row(r.store, 'CWT-2')).toEqual(before.terms.find((t) => t.id === 'CWT-2')); // absent from the pack: left alone, still on
    expect(r.store.state.terms.map((t) => t.id).sort()).toEqual(before.terms.map((t) => t.id).sort());
    expect(row(r.store, 'CWT-3')).toMatchObject({ active: false });
    expect(blocked(r.live, 'you snerp')).toBe(true);
    expect(blocked(r.live, 'you vlemmo')).toBe(true);
  });

  it('syncPack: a duplicate word under another id is skipped; two syncs of the same pack are a no-op (all zeros)', async () => {
    const r = await loaded();
    const added = await r.live.change('alice', (e) => e.addTerm({ term: 'glarn', language: 'en' }));
    if (!added.ok) throw new Error('setup');
    const next = pack(VERSION, [
      { id: 'CWT-1', term: 'zorbak' },
      { id: 'CWT-5', term: 'GLARN' }, // same word as the adopter's row
      { id: 'CWT-6', term: 'vlemo' }, // reads as CWT-2's word once repeats collapse
      { id: 'CWT-7', term: 'fenrisk' },
    ]);
    const first = summaryOf(r.live.syncPack(next, { actor: ACTOR }));
    expect(first).toEqual({ ...ZERO, added: 1, skipped: 2 });
    expect(r.store.state.terms.map((t) => t.id)).not.toContain('CWT-5');
    expect(r.store.state.terms.map((t) => t.id)).not.toContain('CWT-6');
    // Skipped is a standing fact about the pack, not a change: the second run adds nothing and writes nothing.
    const before = snapshotOf(r.store);
    expect(summaryOf(r.live.syncPack(next, { actor: ACTOR }))).toEqual({ ...ZERO, skipped: 2 });
    expect(r.store.state).toEqual(before);
    // A pack with no duplicates is a clean no-op the second time.
    const clean = pack('2027.01.0', [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-7', term: 'fenrisk' }]);
    expect(summaryOf(r.live.syncPack(clean, { actor: 'corpus:2027.01.0' }))).toEqual(ZERO);
    const again = snapshotOf(r.store);
    expect(summaryOf(r.live.syncPack(clean, { actor: 'corpus:2027.01.0' }))).toEqual(ZERO);
    expect(r.store.state).toEqual(again);
  });

  it('syncPack: a renamed pack row that would read as another row\'s word is skipped, not applied', async () => {
    const r = await loaded();
    const next = pack(VERSION, [{ id: 'CWT-1', term: 'vlemmo' }, { id: 'CWT-2', term: 'vlemmo' }]);
    // hand-made duplicate words in one pack: the first row would take CWT-2's word.
    const res = r.live.syncPack(next, { actor: ACTOR });
    expect(summaryOf(res)).toMatchObject({ skipped: 1 });
    expect(row(r.store, 'CWT-1').term).toBe('zorbak');
  });

  it('syncPack: exceptions follow the same rules (add, follow, keptYours, skipped, never deleted)', async () => {
    const r = await loaded(pack('2026.11.0', [{ id: 'CWT-1', term: 'zorbak' }], { exceptions: [{ id: 'CWX-1', phrase: 'snerp glarn' }, { id: 'CWX-2', phrase: 'tarvo lake' }, { id: 'CWX-3', phrase: 'quissel bay' }] }));
    expect((await r.live.change('alice', (e) => e.setExceptionActive('CWX-3', false))).ok).toBe(true);
    const next = pack(
      VERSION,
      [{ id: 'CWT-1', term: 'zorbak' }],
      { exceptions: [{ id: 'CWX-1', phrase: 'snerp glarn', active: false }, { id: 'CWX-2', phrase: 'tarvo bay' }, { id: 'CWX-3', phrase: 'quissel bay', active: true }, { id: 'CWX-4', phrase: 'fenrisk hill' }, { id: 'CWX-5', phrase: 'Fenrisk Hill' }] },
    );
    expect(summaryOf(r.live.syncPack(next, { actor: ACTOR }))).toEqual({ added: 1, deactivated: 1, reactivated: 0, changed: 1, keptYours: 1, skipped: 1 });
    expect(r.store.state.exceptions.map((e) => [e.id, e.phrase, e.active])).toEqual([
      ['CWX-1', 'snerp glarn', false],
      ['CWX-2', 'tarvo bay', true],
      ['CWX-3', 'quissel bay', false],
      ['CWX-4', 'fenrisk hill', true],
    ]);
    expect(r.store.state.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['exception.add', 'exception.toggle', 'exception.update']));
  });

  it('syncPack: a pack that leaves no active term, or whose exception would unblock a positive line, is refused with the existing codes and writes nothing', async () => {
    const r = await loaded();
    const matcherBefore = ['you zorbak', 'you vlemmo', 'you quissel'].map((l) => blocked(r.live, l));
    const before = snapshotOf(r.store);
    // 1. nothing active would remain (every row withdrawn, one new row inactive).
    const none = pack(VERSION, [
      { id: 'CWT-1', term: 'zorbak', active: false },
      { id: 'CWT-2', term: 'vlemmo', active: false },
      { id: 'CWT-3', term: 'quissel', active: false },
      { id: 'CWT-4', term: 'drakkuun', active: false },
    ]);
    expect(r.live.syncPack(none, { actor: ACTOR })).toEqual({ ok: false, code: 'invalid' });
    expect(r.store.state).toEqual(before);
    // 2. an exception that unblocks a positive line the pack requires blocked (and rows were being added).
    const unblocks = pack(VERSION, [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-8', term: 'fenrisk' }], {
      exceptions: [{ id: 'CWX-1', phrase: 'you zorbak' }],
    });
    expect(r.live.syncPack(unblocks, { actor: ACTOR })).toEqual({ ok: false, code: 'unblocks_known' });
    expect(r.store.state).toEqual(before);
    // 3. a pack-wide positive line the new exception unblocks.
    const corpus = pack(VERSION, [{ id: 'CWT-1', term: 'zorbak' }], { exceptions: [{ id: 'CWX-1', phrase: 'my zorbak' }], positiveCorpus: ['hello my zorbak'] });
    expect(r.live.syncPack(corpus, { actor: ACTOR })).toEqual({ ok: false, code: 'unblocks_known' });
    expect(r.store.state).toEqual(before);
    // 4. a row that does not build (a one-letter word) is refused as invalid, with the rows written before it rolled back.
    const bad = pack(VERSION, [{ id: 'CWT-4', term: 'tarvo' }, { id: 'CWT-5', term: 'a' }]);
    expect(r.live.syncPack(bad, { actor: ACTOR })).toEqual({ ok: false, code: 'invalid' });
    expect(r.store.state).toEqual(before);
    // The live list is exactly what it was, and the refused packs' corpora were not adopted.
    expect(['you zorbak', 'you vlemmo', 'you quissel'].map((l) => blocked(r.live, l))).toEqual(matcherBefore);
    expect(blocked(r.live, 'you tarvo')).toBe(false);
    expect(r.live.check('quissel', 'en', ['hello my zorbak'])).toEqual({ ok: true, hits: [] });
    expect((await r.live.change('alice', (e) => e.addException({ phrase: 'my zorbak', language: 'en' }))).ok).toBe(true); // the refused positiveCorpus did not stick
  });

  it('syncPack: a pack with a duplicate row id or a non-array row list is refused as invalid and writes nothing', async () => {
    const r = await loaded();
    const before = snapshotOf(r.store);
    const dup = pack(VERSION, [{ id: 'CWT-4', term: 'tarvo' }, { id: 'CWT-4', term: 'fenrisk' }]);
    expect(r.live.syncPack(dup, { actor: ACTOR })).toEqual({ ok: false, code: 'invalid' });
    const broken = { ...pack(VERSION, []), terms: 'nope' } as unknown as TermPack;
    expect(r.live.syncPack(broken, { actor: ACTOR })).toEqual({ ok: false, code: 'invalid' });
    expect(r.store.state).toEqual(before);
  });

  it('syncPack: dryRun returns the same summary and leaves store, audit and matcher untouched', async () => {
    const r = await loaded();
    expect((await r.live.change('alice', (e) => e.setTermActive('CWT-3', false))).ok).toBe(true);
    const next = pack(VERSION, [
      { id: 'CWT-1', term: 'zorbak', active: false },
      { id: 'CWT-2', term: 'vlemmox' },
      { id: 'CWT-3', term: 'quissel' },
      { id: 'CWT-4', term: 'drakkuun' },
    ], { negativeCorpus: ['an innocent line'] });
    const before = snapshotOf(r.store);
    const rowsBefore = JSON.stringify(r.live.rows);
    const dry = r.live.syncPack(next, { actor: ACTOR, dryRun: true });
    expect(r.store.state).toEqual(before);
    expect(JSON.stringify(r.live.rows)).toBe(rowsBefore);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    expect(blocked(r.live, 'you drakkuun')).toBe(false);
    const real = r.live.syncPack(next, { actor: ACTOR });
    expect(dry).toEqual(real);
    expect(summaryOf(real)).toEqual({ added: 1, deactivated: 1, reactivated: 0, changed: 1, keptYours: 1, skipped: 0 });
  });

  it('syncPack: dryRun of a refused pack reports the refusal and changes nothing', async () => {
    const r = await loaded();
    const before = snapshotOf(r.store);
    const none = pack(VERSION, [{ id: 'CWT-1', term: 'zorbak', active: false }, { id: 'CWT-2', term: 'vlemmo', active: false }, { id: 'CWT-3', term: 'quissel', active: false }]);
    expect(r.live.syncPack(none, { actor: ACTOR, dryRun: true })).toEqual({ ok: false, code: 'invalid' });
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('syncPack: after success check() uses the new pack\'s negative corpus and the canary uses the new positive lines', async () => {
    const r = await loaded(pack('2026.11.0', [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }], { negativeCorpus: ['an old plain line zorbak'] }));
    expect(r.live.check('quissel', 'en', [])).toEqual({ ok: true, hits: [] });
    const next = pack(VERSION, [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }], {
      negativeCorpus: ['a new plain line about a quissel', 'an old plain line zorbak'],
      knownLosses: ['an old plain line zorbak'],
      positiveCorpus: ['say vlemmo twice'],
    });
    expect(summaryOf(r.live.syncPack(next, { actor: ACTOR }))).toEqual(ZERO);
    expect(r.live.check('quissel', 'en', [])).toEqual({ ok: true, hits: ['a new plain line about a quissel'] });
    // The new positive corpus now protects 'say vlemmo twice'; the old pack never listed it.
    const refused = await r.live.change('alice', (e) => e.addException({ phrase: 'say vlemmo twice', language: 'en' }));
    expect(refused).toMatchObject({ ok: false, code: 'unblocks_known' });
    // A row's own positive lines (from the new pack) are protected too.
    const withLines = pack('2027.01.0', [{ id: 'CWT-1', term: 'zorbak', positive: ['hello zorbak friend'] }, { id: 'CWT-2', term: 'vlemmo' }]);
    expect(summaryOf(r.live.syncPack(withLines, { actor: 'corpus:2027.01.0' }))).toEqual(ZERO);
    expect(await r.live.change('alice', (e) => e.addException({ phrase: 'hello zorbak friend', language: 'en' }))).toMatchObject({ ok: false, code: 'unblocks_known' });
  });

  it('syncPack: not_loaded before load(); build_failed when the store throws mid-way, with everything rolled back', async () => {
    const warn = vi.fn();
    const store = new MemoryTermStore();
    const fresh = new LiveTerms({ store, pack: BASE(), clock: { now: () => T0 }, logger: { warn } });
    expect(fresh.syncPack(pack(VERSION, [{ id: 'CWT-9', term: 'tarvo' }]), { actor: ACTOR })).toEqual({ ok: false, code: 'not_loaded' });
    expect(store.state.terms).toEqual([]);

    const r = await loaded();
    const before = snapshotOf(r.store);
    let inserts = 0;
    r.store.fail = (m) => {
      if (m === 'insertTerm' && (inserts += 1) === 2) throw new Error('disk gone: tarvo secret');
    };
    const next = pack(VERSION, [{ id: 'CWT-1', term: 'zorbak', active: false }, { id: 'CWT-4', term: 'tarvo' }, { id: 'CWT-5', term: 'fenrisk' }, { id: 'CWT-6', term: 'glarn' }]);
    expect(r.live.syncPack(next, { actor: ACTOR })).toEqual({ ok: false, code: 'build_failed' });
    r.store.fail = () => {};
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    expect(blocked(r.live, 'you tarvo')).toBe(false);
    // The log carries the error class only.
    const logged = JSON.stringify(r.warn.mock.calls).toLowerCase();
    expect(logged).not.toContain('tarvo');
    expect(logged).not.toContain('secret');
    expect(r.warn).toHaveBeenCalledWith('terms.sync_failed', { error: 'Error' });
    // The same pack succeeds once the store is healthy again.
    expect(summaryOf(r.live.syncPack(next, { actor: ACTOR }))).toMatchObject({ added: 3, deactivated: 1 });
  });

  it('syncPack: with no starting pack it adds rows to an empty store and the matcher swaps', async () => {
    const r = await loaded(null);
    expect(blocked(r.live, 'you zorbak')).toBe(false);
    expect(summaryOf(r.live.syncPack(pack(VERSION, [{ id: 'CWT-1', term: 'zorbak' }]), { actor: ACTOR }))).toEqual({ ...ZERO, added: 1 });
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('syncPack: the synthetic fixture pack syncs onto itself as a no-op', async () => {
    const synthetic = syntheticTermPack();
    const r = await loaded(synthetic);
    expect(summaryOf(r.live.syncPack(synthetic, { actor: ACTOR }))).toEqual(ZERO);
  });

  it('syncPack: 1000 rows sync once through the store without a list read per row', async () => {
    const terms: PackTerm[] = Array.from({ length: 1000 }, (_, i) => ({ id: `CWT-${i}`, term: `zorbak${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}${'uvwxyzabcd'[Math.floor(i / 100) % 10]}` }));
    const r = await loaded(pack('2026.11.0', [{ id: 'CWT-X', term: 'tarvo' }]));
    let lists = 0;
    r.store.fail = (m) => {
      if (m === 'listTerms' || m === 'listExceptions') lists += 1;
    };
    expect(summaryOf(r.live.syncPack(pack(VERSION, terms), { actor: ACTOR }))).toEqual({ ...ZERO, added: 1000 });
    expect(lists).toBeLessThan(10);
  });
});

describe('the corpus: actor prefix is reserved to the corpus (review I2)', () => {
  const edits: [string, (e: Parameters<Parameters<LiveTerms['changeSync']>[1]>[0]) => unknown][] = [
    ['addTerm', (e) => e.addTerm({ term: 'glarn', language: 'en' })],
    ['updateTerm', (e) => e.updateTerm('CWT-1', { note: 'n' })],
    ['setTermActive', (e) => e.setTermActive('CWT-1', false)],
    ['addException', (e) => e.addException({ phrase: 'glarn lake', language: 'en' })],
    ['setExceptionActive', (e) => e.setExceptionActive('missing', false)],
  ];

  it('changeSync and change refuse a human actor that starts with corpus: (invalid), call nothing and write nothing', async () => {
    for (const actor of ['corpus:', 'corpus:2026.12.0', 'corpus:alice', 'corpus:\u0000']) {
      for (const [name, edit] of edits) {
        const r = await loaded();
        const before = snapshotOf(r.store);
        const fn = vi.fn(edit);
        const sync = r.live.changeSync(actor, fn);
        const async = await r.live.change(actor, fn);
        expect({ actor, name, sync, async }).toMatchObject({ sync: { ok: false, code: 'invalid' }, async: { ok: false, code: 'invalid' } });
        expect(fn).not.toHaveBeenCalled();
        expect(snapshotOf(r.store)).toEqual(before);
        expect(blocked(r.live, 'you zorbak')).toBe(true);
      }
    }
  });

  it('the refusal message says nothing about the actor', async () => {
    const r = await loaded();
    const out = r.live.changeSync('corpus:zorbak-admin', (e) => e.setTermActive('CWT-1', false));
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('zorbak-admin');
  });

  it('controls: ordinary actors, ones that merely contain or resemble corpus, still edit; and a corpus-like actor never makes a row the corpus\'s', async () => {
    for (const actor of ['alice', 'Corpus:alice', ' corpus:alice', 'the-corpus:alice', 'corpus', 'corpus-bot', 'staff@example.test']) {
      const r = await loaded();
      const out = r.live.changeSync(actor, (e) => e.setTermActive('CWT-1', false));
      expect({ actor, ok: out.ok }).toEqual({ actor, ok: true });
      // The row is the adopter's from now on: the corpus restores nothing.
      expect(summaryOf(r.live.syncPack(pack('2026.12.0', [{ id: 'CWT-1', term: 'zorbak' }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-3', term: 'quissel' }]), { actor: ACTOR }))).toEqual({ ...ZERO, keptYours: 1 });
      expect(row(r.store, 'CWT-1').active).toBe(false);
    }
  });

  it('syncPack still takes the corpus actor, and a row it changed is stamped with it', async () => {
    const r = await loaded();
    r.live.syncPack(pack('2026.12.0', [{ id: 'CWT-1', term: 'zorbak', active: false }, { id: 'CWT-2', term: 'vlemmo' }, { id: 'CWT-3', term: 'quissel' }]), { actor: ACTOR });
    expect(row(r.store, 'CWT-1').updatedBy).toBe(ACTOR);
  });
});
