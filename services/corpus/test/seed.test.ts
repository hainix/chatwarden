import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTermsRelease } from '../src/build/release.js';
import { dictionarySql, negativesSql, planTerms, SeedError, main as seed } from '../src/tools/seed.js';
import { openDump } from '../src/tools/localD1.js';
import { makeBuildWorld, type BuildWorld } from './build-world.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';

// The seed import (owner action 5): the owner's exported list becomes `provisional` rows with a source for each term, as SQL the owner applies. The
// SQL also writes what the review page's own approval would have: a submission and an approval vote, so that a later dispute and restore
// gives the status the votes earn (provisional), not a state with no votes behind it. Invented words only; the real list never touches git.

let w: BuildWorld;
let tw: ToolWorld;
beforeEach(async () => {
  w = await makeBuildWorld();
  tw = makeToolWorld();
});
afterEach(() => tw.cleanup());

const NOW = '2026-12-01T09:00:00Z';
const entry = (over: Record<string, unknown> = {}) => ({ term: 'zorbak', languages: ['en'], category: 'abuse', severity: 'hostile', source: 'moxgate-2026-11', ...over });
const empty = { next: 1, keys: new Set<string>() };
const rows = async (sql: string, ...v: unknown[]) => (await w.db.prepare(sql).bind(...v).all<Record<string, unknown>>()).results;
const apply = (sql: string): void => w.db.raw.exec(sql);

describe('planTerms', () => {
  it('writes each term as a provisional row with one approval, and the submission and the vote behind it, and a source in the audit', async () => {
    const plan = planTerms([entry(), entry({ term: 'vlemmo', languages: ['en', 'es'], category: 'slur', target: 'ethnicity', severity: 'severe', defaultActive: false })], empty, NOW, 2026);
    expect(plan).toMatchObject({ imported: 2, skipped: [], first: 'CWT-2026-00001', last: 'CWT-2026-00002' });
    apply(plan.sql);
    expect(await rows('SELECT id, term, languages, category, target, severity, status, default_active, collides_with, since, approvals FROM terms ORDER BY id')).toEqual([
      { id: 'CWT-2026-00001', term: 'zorbak', languages: '["en"]', category: 'abuse', target: 'none', severity: 'hostile', status: 'provisional', default_active: 1, collides_with: '[]', since: null, approvals: 1 },
      { id: 'CWT-2026-00002', term: 'vlemmo', languages: '["en","es"]', category: 'slur', target: 'ethnicity', severity: 'severe', status: 'provisional', default_active: 0, collides_with: '[]', since: null, approvals: 1 },
    ]);
    expect(await rows("SELECT id, term_id, status, word_key FROM submissions ORDER BY id")).toEqual([
      { id: 'seed_CWT-2026-00001', term_id: 'CWT-2026-00001', status: 'accepted', word_key: 'zorbak' },
      { id: 'seed_CWT-2026-00002', term_id: 'CWT-2026-00002', status: 'accepted', word_key: 'vlemo' },
    ]);
    expect(await rows("SELECT subject_kind, subject_id, reviewer, verdict FROM reviews ORDER BY subject_id")).toEqual([
      { subject_kind: 'submission', subject_id: 'seed_CWT-2026-00001', reviewer: 'seed:moxgate-2026-11', verdict: 'approve' },
      { subject_kind: 'submission', subject_id: 'seed_CWT-2026-00002', reviewer: 'seed:moxgate-2026-11', verdict: 'approve' },
    ]);
    expect(await rows("SELECT actor, action, subject FROM audit ORDER BY id")).toEqual([
      { actor: 'seed:moxgate-2026-11', action: 'seed.import', subject: 'CWT-2026-00001' },
      { actor: 'seed:moxgate-2026-11', action: 'seed.import', subject: 'CWT-2026-00002' },
    ]);
  });

  it('the votes it writes are the ones the review page counts: one approval, so a restore after a dispute gives provisional', async () => {
    apply(planTerms([entry()], empty, NOW, 2026).sql);
    const approvals = await rows("SELECT COUNT(*) AS n FROM reviews WHERE subject_kind = 'submission' AND verdict = 'approve' AND subject_id IN (SELECT id FROM submissions WHERE term_id = ?)", 'CWT-2026-00001');
    expect(approvals[0]?.n).toBe(1);
  });

  it('is safe to apply twice: nothing is duplicated, nothing is overwritten', async () => {
    const plan = planTerms([entry()], empty, NOW, 2026);
    apply(plan.sql);
    await w.db.prepare("UPDATE terms SET status = 'accepted', approvals = 2 WHERE id = 'CWT-2026-00001'").run();
    apply(plan.sql);
    expect((await rows('SELECT COUNT(*) AS n FROM terms'))[0]?.n).toBe(1);
    expect((await rows('SELECT status, approvals FROM terms'))[0]).toEqual({ status: 'accepted', approvals: 2 });
    for (const t of ['submissions', 'reviews', 'audit']) expect((await rows(`SELECT COUNT(*) AS n FROM ${t}`))[0]?.n, t).toBe(1);
  });

  it('does not leave a submission or a vote behind for a term that was not written (the word, or the id, was already taken)', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'quissel' });
    apply(planTerms([entry()], empty, NOW, 2026).sql); // the id is taken by another word
    expect((await rows('SELECT COUNT(*) AS n FROM terms'))[0]?.n).toBe(1);
    for (const t of ['submissions', 'reviews', 'audit']) expect((await rows(`SELECT COUNT(*) AS n FROM ${t}`))[0]?.n, t).toBe(0);
  });

  it('numbers from the next free number, skips words that are already terms, and a word twice in the file, and says which entries by position', () => {
    const plan = planTerms([entry(), entry({ term: 'Z\u00f3rbak' }), entry({ term: 'vlemmo' }), entry({ term: 'quissel' })], { next: 40, keys: new Set(['quissel']) }, NOW, 2026);
    expect(plan.skipped).toEqual([
      { index: 1, reason: 'duplicate_in_file' },
      { index: 3, reason: 'known_word' },
    ]);
    expect(plan).toMatchObject({ imported: 2, first: 'CWT-2026-00040', last: 'CWT-2026-00041' });
  });

  it('refuses the whole file when an entry is not valid, naming positions only, never a word', () => {
    const attack = "x'); DROP TABLE terms; --";
    const bad: Record<string, unknown>[] = [
      entry({ term: 'two words' }),
      entry({ term: 'ab' }),
      entry({ term: attack }),
      entry({ languages: [] }),
      entry({ languages: ['fr'] }),
      entry({ category: 'nasty' }),
      entry({ severity: 'banter' }),
      entry({ target: 'everyone' }),
      entry({ category: 'slur' }), // a slur needs a target
      entry({ category: 'slur', target: 'none' }),
      entry({ source: '' }),
      entry({ source: attack }),
      entry({ defaultActive: 'yes' }),
      entry({ extra: 1 }),
    ];
    for (const b of bad) {
      const err = (() => {
        try {
          planTerms([entry({ term: 'tarvo' }), b], empty, NOW, 2026);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err, JSON.stringify(b)).toBeInstanceOf(SeedError);
      expect(err).toMatchObject({ code: 'invalid_entry', indices: [1] });
      expect(String((err as Error).message)).not.toMatch(/tarvo|DROP|zorbak/);
    }
    expect(() => planTerms({}, empty, NOW, 2026)).toThrow(SeedError);
    expect(() => planTerms([], empty, NOW, 2026)).toThrow(SeedError);
  });

  it('a seeded D1 builds a release: provisional rows, since stamped by the build, nothing held', async () => {
    apply(planTerms([entry(), entry({ term: 'vlemmo', languages: ['es'] }), entry({ term: 'quissel', languages: ['pt'] })], empty, NOW, 2026).sql);
    const built = await buildTermsRelease(w.db, { clock: w.clock, version: '2026.12.0', sequence: 1, previous: null });
    expect(built.held).toEqual([]);
    expect(built.release.manifest.counts.status).toEqual({ accepted: 0, provisional: 3, disputed: 0, withdrawn: 0 });
    expect(built.stamped).toEqual(['CWT-2026-00001', 'CWT-2026-00002', 'CWT-2026-00003']);
  });
});

describe('dictionarySql and negativesSql', () => {
  it('imports a word list ranked by position, best rank kept for a repeated word, accents and non-words handled like loadInnocentWords', async () => {
    const out = dictionarySql('en', '# a comment\nzorbakian\n\nVlemmoid\nzorbakian\n  glarnish  \nnot a word\nab\n');
    expect(out.imported).toBe(3);
    apply(out.sql);
    expect(await rows('SELECT word_key, rank FROM innocent_words WHERE language = ? ORDER BY rank', 'en')).toEqual([
      { word_key: 'zorbakian', rank: 1 },
      { word_key: 'vlemoid', rank: 2 },
      { word_key: 'glarnish', rank: 3 },
    ]);
    apply(dictionarySql('en', 'glarnish\n').sql);
    expect((await rows("SELECT rank FROM innocent_words WHERE word_key = 'glarnish'"))[0]?.rank).toBe(1);
  });

  it('can import unranked words, and refuses a language that is not supported', () => {
    expect(dictionarySql('es', 'una\ndos\n', { ranked: false }).sql).toContain('NULL');
    expect(() => dictionarySql('fr', 'x\n')).toThrow(SeedError);
  });

  it('imports negative lines, skipping blanks and lines over 500 characters, and is safe to apply twice', async () => {
    const text = `a plain sentence\n\nit's fine\n${'x'.repeat(501)}\na plain sentence\n`;
    const out = negativesSql('en', text);
    expect(out.imported).toBe(2);
    apply(out.sql);
    apply(out.sql);
    expect(await rows('SELECT line, origin FROM negative_lines ORDER BY line')).toEqual([
      { line: "it's fine", origin: 'import' },
      { line: 'a plain sentence', origin: 'import' },
    ].sort((a, b) => (a.line < b.line ? -1 : 1)));
  });

  it('refuses a control character in a line (it would be a way to splice something into the SQL)', () => {
    expect(() => negativesSql('en', 'fine\u0000line\n')).toThrow(SeedError);
    expect(() => dictionarySql('en', 'zorbak\u0000\n')).not.toThrow(); // not a plain word: skipped, never written
  });
});

describe('seed (the tool)', () => {
  const dumpOf = (): string => {
    const lines = [readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')];
    return lines.join('\n');
  };
  const files = (over: Record<string, unknown>[] = [entry()]) => {
    const dir = join(tw.dir, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seed.json'), JSON.stringify(over));
    writeFileSync(join(dir, 'd1.sql'), dumpOf());
    writeFileSync(join(dir, 'en.txt'), 'zorbakian\nvlemmoid\n');
    writeFileSync(join(dir, 'neg.txt'), 'a plain sentence\n');
    return dir;
  };

  it('writes one SQL file for the terms, the dictionary and the negative lines, prints counts only, and the SQL applies', async () => {
    const dir = files();
    const out = join(dir, 'import.sql');
    expect(await seed(['--terms', join(dir, 'seed.json'), '--dump', join(dir, 'd1.sql'), '--dictionary', `en=${join(dir, 'en.txt')}`, '--negatives', `en=${join(dir, 'neg.txt')}`, '--out', out], tw.io)).toBe(0);
    const printed = tw.everything();
    expect(printed).toContain('1 terms');
    expect(printed).toContain('2 dictionary words');
    expect(printed).toContain('1 negative lines');
    expect(printed).not.toMatch(/zorbak|vlemmoid|plain sentence/);
    apply(readFileSync(out, 'utf8'));
    expect((await rows('SELECT COUNT(*) AS n FROM terms'))[0]?.n).toBe(1);
    expect((await rows('SELECT COUNT(*) AS n FROM innocent_words'))[0]?.n).toBe(2);
    expect(tw.writes.at(-1)).toMatchObject({ mode: 0o600, exclusive: true });
  });

  it('continues the numbering after the ids in the dump and skips the words it already holds', async () => {
    const dir = files([entry({ term: 'zorbak' }), entry({ term: 'tarvo' })]);
    const db = makeBuildWorld();
    const w2 = await db;
    await w2.term({ id: 'CWT-2026-00007', term: 'zorbak' });
    const rowsOf = w2.db.raw.prepare('SELECT quote(id) AS id, quote(word_key) AS k, quote(term) AS t FROM terms').all() as { id: string; k: string; t: string }[];
    writeFileSync(
      join(dir, 'd1.sql'),
      `${dumpOf()}\n${rowsOf.map((r) => `INSERT INTO terms (id, word_key, term, languages, category, target, severity, status, default_active, collides_with, since, approvals, created_at, updated_at) VALUES (${r.id}, ${r.k}, ${r.t}, '["en"]', 'abuse', 'none', 'hostile', 'accepted', 1, '[]', NULL, 2, 'x', 'x');`).join('\n')}`,
    );
    const out = join(dir, 'import.sql');
    expect(await seed(['--terms', join(dir, 'seed.json'), '--dump', join(dir, 'd1.sql'), '--out', out], tw.io)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('CWT-2026-00008');
    expect(readFileSync(out, 'utf8')).not.toContain('CWT-2026-00007');
    expect(tw.out.join('\n')).toContain('1 skipped');
    expect(openDump(dumpOf())).toBeDefined();
  });

  it('refuses to write inside a git working tree, to overwrite a file, and to read a term list without a dump', async () => {
    const dir = files();
    const repo = join(tw.dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await seed(['--terms', join(dir, 'seed.json'), '--dump', join(dir, 'd1.sql'), '--out', join(repo, 'import.sql')], tw.io)).toBe(1);
    expect(tw.err.join('\n')).toContain('git working tree');
    writeFileSync(join(dir, 'taken.sql'), 'x');
    expect(await seed(['--terms', join(dir, 'seed.json'), '--dump', join(dir, 'd1.sql'), '--out', join(dir, 'taken.sql')], tw.io)).toBe(1);
    expect(readFileSync(join(dir, 'taken.sql'), 'utf8')).toBe('x');
    expect(await seed(['--terms', join(dir, 'seed.json'), '--out', join(dir, 'new.sql')], tw.io)).toBe(1);
    expect(await seed(['--out', join(dir, 'none.sql')], tw.io)).toBe(1);
  });

  it('an invalid entry stops it with positions only, and writes nothing', async () => {
    const dir = files([entry(), entry({ category: 'nasty', term: 'quissel' })]);
    expect(await seed(['--terms', join(dir, 'seed.json'), '--dump', join(dir, 'd1.sql'), '--out', join(dir, 'import.sql')], tw.io)).toBe(1);
    expect(tw.err.join('\n')).toContain('invalid_entry');
    expect(tw.err.join('\n')).toContain('1');
    expect(tw.everything()).not.toMatch(/quissel|zorbak/);
    expect(tw.writes).toEqual([]);
  });
});
