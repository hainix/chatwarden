import { beforeEach, describe, expect, it } from 'vitest';
import { doiSql, recordSql } from '../src/tools/record.js';
import { makeBuildWorld, type BuildWorld } from './build-world.js';

// The statements that tell the database a release is out (the owner applies them with `wrangler d1 execute --remote --file`). Built from
// validated values only: an id, a version, a hash and a timestamp are checked against their own shapes before they are written into text.

let w: BuildWorld;
beforeEach(async () => {
  w = await makeBuildWorld();
  await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: null });
  await w.term({ id: 'CWT-2026-00002', term: 'vlemmo', since: '2026.11.0' });
  await w.term({ id: 'CWT-2026-00003', term: 'quissel', since: null });
  const sub = (id: string, status: string, termId: string, key: string): Promise<unknown> =>
    w.db
      .prepare("INSERT INTO submissions (id, installation, word_key, term, language, category, status, term_id, received_day) VALUES (?, 'i', ?, ?, 'en', 'abuse', ?, ?, '2026-11-20')")
      .bind(id, key, key, status, termId)
      .run();
  await sub('sub_a', 'accepted', 'CWT-2026-00001', 'zorbak');
  await sub('sub_b', 'accepted', 'CWT-2026-00003', 'quissel');
  await sub('sub_c', 'declined', 'CWT-2026-00001', 'zorbakb');
});

const input = { kind: 'terms' as const, version: '2026.12.0', sequence: 3, sha256: 'a'.repeat(64), keyId: 'k1', publishedAt: '2026-12-01T09:00:00Z', stamped: ['CWT-2026-00001'] };
const rows = async (sql: string) => (await w.db.prepare(sql).all<Record<string, unknown>>()).results;

describe('recordSql', () => {
  it('records the release, gives `since` to the stamped terms only, and marks their accepted submissions merged', async () => {
    w.db.raw.exec(recordSql(input));
    expect(await rows('SELECT kind, version, sequence, sha256, key_id, published_at, doi FROM releases')).toEqual([
      { kind: 'terms', version: '2026.12.0', sequence: 3, sha256: 'a'.repeat(64), key_id: 'k1', published_at: '2026-12-01T09:00:00Z', doi: null },
    ]);
    expect(await rows('SELECT id, since FROM terms ORDER BY id')).toEqual([
      { id: 'CWT-2026-00001', since: '2026.12.0' },
      { id: 'CWT-2026-00002', since: '2026.11.0' },
      { id: 'CWT-2026-00003', since: null },
    ]);
    expect(await rows('SELECT id, status FROM submissions ORDER BY id')).toEqual([
      { id: 'sub_a', status: 'merged' },
      { id: 'sub_b', status: 'accepted' },
      { id: 'sub_c', status: 'declined' },
    ]);
  });

  it('is safe to apply twice, and never changes a `since` that is set', async () => {
    w.db.raw.exec(recordSql(input));
    w.db.raw.exec(recordSql({ ...input, stamped: ['CWT-2026-00001', 'CWT-2026-00002'] }));
    expect((await rows('SELECT COUNT(*) AS n FROM releases'))[0]?.n).toBe(1);
    expect((await rows("SELECT since FROM terms WHERE id = 'CWT-2026-00002'"))[0]?.since).toBe('2026.11.0');
  });

  it('an eval release records only itself', async () => {
    w.db.raw.exec(recordSql({ ...input, kind: 'eval', stamped: [] }));
    expect(await rows('SELECT kind FROM releases')).toEqual([{ kind: 'eval' }]);
    expect((await rows('SELECT COUNT(*) AS n FROM terms WHERE since IS NULL'))[0]?.n).toBe(2);
  });

  it('refuses a value that is not the shape it should be, so nothing but a literal is ever written into the text', () => {
    const attack = "'; DROP TABLE terms; --";
    for (const bad of [
      { kind: 'terms; x' }, { version: attack }, { version: '2026.13.0' }, { sequence: 0 }, { sequence: 1.5 }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) },
      { keyId: attack }, { publishedAt: '2026-12-01' }, { publishedAt: attack }, { stamped: [attack] }, { stamped: ['CWT-2026-0001'] }, { stamped: 'CWT-2026-00001' },
    ]) {
      expect(() => recordSql({ ...input, ...bad } as never), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('writes no word, only ids, a version and hashes', () => {
    expect(recordSql(input)).not.toMatch(/zorbak|vlemmo|quissel/);
  });

  it('a long list of stamped terms is split into several statements that each stay small', () => {
    const many = Array.from({ length: 1200 }, (_, i) => `CWT-2026-${String(i + 1).padStart(5, '0')}`);
    const text = recordSql({ ...input, stamped: many });
    const updates = text.split('\n').filter((l) => l.startsWith('UPDATE terms'));
    expect(updates.length).toBeGreaterThan(1);
    expect(updates.every((l) => l.length < 20_000)).toBe(true);
    expect(new Set(updates.join(' ').match(/CWT-\d{4}-\d{5}/g)).size).toBe(1200);
  });
});

describe('doiSql', () => {
  it('sets the DOI on a recorded release, and refuses a DOI that is not one', async () => {
    w.db.raw.exec(recordSql(input));
    w.db.raw.exec(doiSql('terms', '2026.12.0', '10.5281/zenodo.1234567'));
    expect((await rows('SELECT doi FROM releases'))[0]?.doi).toBe('10.5281/zenodo.1234567');
    for (const bad of ["10.5281/zenodo.1'; --", 'doi:10.5281/x', '', 'x'.repeat(200)]) expect(() => doiSql('terms', '2026.12.0', bad), bad).toThrow(RangeError);
    expect(() => doiSql('terms', 'x', '10.5281/zenodo.1')).toThrow(RangeError);
  });
});
