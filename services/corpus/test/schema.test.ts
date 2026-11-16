import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySchema, createD1 } from './d1.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const TABLES = ['audit', 'counters', 'innocent_words', 'negative_lines', 'releases', 'reports', 'reviews', 'submissions', 'term_lines', 'terms'];

async function db() {
  const d1 = createD1();
  await applySchema(d1);
  return d1;
}

const term = (id: string, key: string, status = 'provisional') =>
  [id, key, key, '["en"]', 'slur', 'none', 'severe', status, '2026-12-01T00:00:00Z', '2026-12-01T00:00:00Z'] as const;
const INSERT_TERM =
  'INSERT INTO terms (id, word_key, term, languages, category, target, severity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)';

describe('schema.sql applies cleanly twice (idempotent) and enforces the CHECK constraints', () => {
  it('creates every table of design 6.9 and can be applied again over data without losing it', async () => {
    const d1 = await db();
    const names = (await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    await d1.prepare(INSERT_TERM).bind(...term('CWT-2026-00001', 'zorbak')).run();
    await applySchema(d1);
    await applySchema(d1);
    expect((await d1.prepare('SELECT COUNT(*) AS c FROM terms').first<{ c: number }>())?.c).toBe(1);
  });

  it('refuses a status outside the four a term may have', async () => {
    const d1 = await db();
    for (const [i, ok] of ['provisional', 'accepted', 'disputed', 'withdrawn'].entries()) {
      await d1.prepare(INSERT_TERM).bind(...term(`CWT-2026-0000${i}`, `k${ok}`, ok)).run();
    }
    await expect(d1.prepare(INSERT_TERM).bind(...term('CWT-2026-99999', 'vlemmo', 'approved')).run()).rejects.toThrow(/CHECK/);
  });

  it('refuses a second term with the same word_key, whatever its id', async () => {
    const d1 = await db();
    await d1.prepare(INSERT_TERM).bind(...term('CWT-2026-00001', 'zorbak')).run();
    await expect(d1.prepare(INSERT_TERM).bind(...term('CWT-2026-00002', 'zorbak')).run()).rejects.toThrow(/UNIQUE/);
  });

  it('refuses a second review of one subject by one reviewer, and a verdict outside the four', async () => {
    const d1 = await db();
    const ins = 'INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES (?,?,?,?,?,?)';
    await d1.prepare(ins).bind('submission', 'sub_1', 'r1', 'approve', 1, '2026-12-01T00:00:00Z').run();
    await expect(d1.prepare(ins).bind('submission', 'sub_1', 'r1', 'decline', 1, '2026-12-01T00:00:00Z').run()).rejects.toThrow(/UNIQUE/);
    await d1.prepare(ins).bind('submission', 'sub_1', 'r2', 'approve', 0, '2026-12-01T00:00:00Z').run();
    await d1.prepare(ins).bind('term', 'sub_1', 'r1', 'approve', 1, '2026-12-01T00:00:00Z').run();
    await expect(d1.prepare(ins).bind('submission', 'sub_2', 'r1', 'maybe', 1, '2026-12-01T00:00:00Z').run()).rejects.toThrow(/CHECK/);
  });

  it('closes the other enumerations: line kind and origin, report kind, submission status and reason', async () => {
    const d1 = await db();
    await expect(d1.prepare("INSERT INTO term_lines VALUES ('t', 'other', 'x', 'template')").run()).rejects.toThrow(/CHECK/);
    await expect(d1.prepare("INSERT INTO term_lines VALUES ('t', 'positive', 'x', 'scraped')").run()).rejects.toThrow(/CHECK/);
    await d1.prepare("INSERT INTO term_lines VALUES ('t', 'positive', 'x', 'template')").run();
    await expect(d1.prepare("INSERT INTO term_lines VALUES ('t', 'positive', 'x', 'reviewer')").run()).rejects.toThrow(/UNIQUE/);
    await expect(d1.prepare("INSERT INTO reports VALUES ('rep_1', 'CWT-2026-00001', 'spam', 'inst:a', 'received', '2026-12-01')").run()).rejects.toThrow(/CHECK/);
    const sub = (status: string, reason: string | null) =>
      d1
        .prepare('INSERT INTO submissions (id, installation, word_key, term, language, category, status, reason, received_day) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(`sub_${status}${reason ?? ''}`, 'i', 'k', 'k', 'en', 'slur', status, reason, '2026-12-01')
        .run();
    await sub('received', null);
    await sub('declined', 'known_innocent');
    await expect(sub('pending', null)).rejects.toThrow(/CHECK/);
    await expect(sub('declined', 'because i said so')).rejects.toThrow(/CHECK/);
  });

  it('keeps the primary keys the design names: one counter per key and day, one release per kind and version', async () => {
    const d1 = await db();
    await d1.prepare("INSERT INTO counters VALUES ('inst:a', '2026-12-01', 1)").run();
    await expect(d1.prepare("INSERT INTO counters VALUES ('inst:a', '2026-12-01', 2)").run()).rejects.toThrow(/UNIQUE/);
    await d1.prepare("INSERT INTO counters VALUES ('inst:a', '2026-12-02', 2)").run();
    const rel = "INSERT INTO releases VALUES ('terms', '2026.12.0', 1, 'aa', 'k1', '2026-12-01T00:00:00Z', NULL)";
    await d1.prepare(rel).run();
    await expect(d1.prepare(rel).run()).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it('holds no column that could keep a raw IP, a free-text report or a reviewer name on a term', async () => {
    const d1 = await db();
    const cols = async (t: string) => (await d1.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols('reports')).toEqual(['id', 'term_id', 'kind', 'channel', 'status', 'received_day']);
    for (const t of TABLES) for (const c of await cols(t)) expect(c).not.toMatch(/^(ip|address|remote|text|free|comment|body)/);
    expect(await cols('counters')).toEqual(['key', 'day', 'n']);
  });
});

describe('schema.sql text', () => {
  it('has no non-ASCII character and uses LF endings only', () => {
    expect([...schema].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(schema).not.toContain('\r');
  });
});
