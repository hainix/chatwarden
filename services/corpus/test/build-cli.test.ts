import { parseTermsRelease, readZip } from '@chatwarden/matcher/corpus';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDump } from '../src/tools/localD1.js';
import { nodeIo, type ToolIo } from '../src/tools/io.js';
import { main as release } from '../src/tools/release.js';
import { makeBuildWorld, type BuildWorld } from './build-world.js';

// tools/release.mjs through its logic (src/tools/release.ts): a dump in, a zip and a summary out, the diff printed with ids only.

let w: BuildWorld;
let dir: string;
let lines: { out: string[]; err: string[] };
beforeEach(async () => {
  w = await makeBuildWorld();
  dir = mkdtempSync(join(tmpdir(), 'corpus-release-'));
  lines = { out: [], err: [] };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const io = (): ToolIo => ({ ...nodeIo(), clock: w.clock, out: (l) => void lines.out.push(l), err: (l) => void lines.err.push(l) });

/** A dump the way `wrangler d1 export` writes one: the schema, then an INSERT for every row. */
function dumpOf(world: BuildWorld): string {
  const parts = [readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')];
  for (const table of ['terms', 'term_lines', 'innocent_words', 'negative_lines', 'releases']) {
    const cols = (world.db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const quoted = cols.map((c) => `quote("${c}")`).join(" || ',' || ");
    for (const r of world.db.raw.prepare(`SELECT ${quoted} AS v FROM ${table}`).all() as { v: string }[]) parts.push(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${r.v});`);
  }
  return parts.join('\n');
}
const writeDump = (): string => {
  const path = join(dir, 'd1.sql');
  writeFileSync(path, dumpOf(w));
  return path;
};
const all = (): string => [...lines.out, ...lines.err].join('\n');

async function seed(): Promise<void> {
  await w.term({ id: 'CWT-2026-00001', term: 'zorbak', category: 'slur', target: 'none', severity: 'severe' });
  await w.term({ id: 'CWT-2026-00002', term: 'vlemmo', status: 'provisional', approvals: 1 });
  await w.negative('en', ['a plain sentence']);
}

describe('openDump', () => {
  it('answers the D1 interface over a dump: prepare, bind, first, all, run, batch', async () => {
    await seed();
    const db = openDump(dumpOf(w));
    expect((await db.prepare('SELECT COUNT(*) AS n FROM terms').first<{ n: number }>())?.n).toBe(2);
    expect((await db.prepare('SELECT term FROM terms WHERE id = ?').bind('CWT-2026-00002').first<{ term: string }>())?.term).toBe('vlemmo');
    expect((await db.prepare('SELECT id FROM terms ORDER BY id').all<{ id: string }>()).results.map((r) => r.id)).toEqual(['CWT-2026-00001', 'CWT-2026-00002']);
    expect(await db.prepare('SELECT id FROM terms WHERE id = ?').bind('nope').first()).toBeNull();
    await expect(db.prepare('SELECT nothing FROM nowhere').all()).rejects.toThrow();
    expect(await db.batch([db.prepare('SELECT 1 AS x')])).toHaveLength(1);
  });
});

describe('release.mjs', () => {
  it('builds the zip and the summary from a dump and prints a diff with ids and counts, and no word', async () => {
    await seed();
    const code = await release(['--dump', writeDump(), '--out', join(dir, 'out')], io());
    expect(code, all()).toBe(0);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['terms-2026.12.0.release.json', 'terms-2026.12.0.zip']);
    const zip = new Uint8Array(readFileSync(join(dir, 'out', 'terms-2026.12.0.zip')));
    const rel = parseTermsRelease(await readZip(zip), { version: '2026.12.0', sequence: 1 });
    expect(rel.terms.map((t) => t.id)).toEqual(['CWT-2026-00001', 'CWT-2026-00002']);
    const summary = JSON.parse(readFileSync(join(dir, 'out', 'terms-2026.12.0.release.json'), 'utf8')) as { summary: { sha256: string; sequence: number }; held: unknown[] };
    expect(summary.summary.sequence).toBe(1);
    expect(summary.held).toEqual([]);
    expect(all()).toContain('added: 2');
    expect(all()).toContain('CWT-2026-00001');
    expect(all()).not.toMatch(/zorbak|vlemmo/);
    expect(all()).toContain(summary.summary.sha256);
  });

  it('--show-words adds the word beside the id, and only then', async () => {
    await seed();
    await release(['--dump', writeDump(), '--out', join(dir, 'out'), '--show-words'], io());
    expect(all()).toMatch(/CWT-2026-00001 zorbak/);
  });

  it('takes the version, sequence and previous release from the database and the clock, and the rows of --previous for the diff', async () => {
    await seed();
    await release(['--dump', writeDump(), '--out', join(dir, 'one')], io());
    await w.db.prepare('UPDATE terms SET since = ? WHERE id = ?').bind('2026.12.0', 'CWT-2026-00001').run();
    await w.release('terms', '2026.12.0', 1);
    await w.db.prepare("UPDATE terms SET status = 'disputed' WHERE id = 'CWT-2026-00002'").run();
    lines.out.length = 0;
    w.clock.set('2026-12-20T00:00:00Z');
    const code = await release(['--dump', writeDump(), '--out', join(dir, 'two'), '--previous', join(dir, 'one', 'terms-2026.12.0.zip')], io());
    expect(code, all()).toBe(0);
    expect(readdirSync(join(dir, 'two')).sort()).toEqual(['terms-2026.12.1.release.json', 'terms-2026.12.1.zip']);
    const rel = parseTermsRelease(await readZip(new Uint8Array(readFileSync(join(dir, 'two', 'terms-2026.12.1.zip')))), { version: '2026.12.1', sequence: 2 });
    expect(rel.manifest.previous).toBe('2026.12.0');
    expect(all()).toContain('release follows 2026.12.0');
    expect(all()).toContain('CWT-2026-00002: status');
  });

  it('prints a closed code for a refused build (the bulk guard), with ids only, and exits 1', async () => {
    for (let i = 0; i < 201; i += 1) {
      const letters = 'bcdfghjklmnpqrstvwxz';
      await w.term({ id: `CWT-2026-${String(i + 1).padStart(5, '0')}`, term: `zo${letters[i % 20]}${letters[Math.floor(i / 20) % 20]}ak` });
    }
    expect(await release(['--dump', writeDump(), '--out', join(dir, 'out')], io())).toBe(1);
    expect(all()).toContain('bulk_guard');
    expect(readdirSync(dir)).not.toContain('out');
    expect(await release(['--dump', writeDump(), '--out', join(dir, 'out'), '--allow-bulk'], io())).toBe(0);
  });

  it('refuses a missing dump, an unknown option and a repeated one, with usage, and never prints a value', async () => {
    expect(await release([], io())).toBe(1);
    expect(all()).toContain('--dump is required');
    for (const bad of [['--dump', 'x', '--bogus'], ['--dump', 'x', '--dump', 'y'], ['positional'], ['--dump']]) {
      lines.err.length = 0;
      expect(await release(bad, io())).toBe(1);
      expect(lines.err[0]).not.toContain('secret');
      expect(lines.err.join('\n')).toContain('usage: release');
    }
  });

  it('a dump that cannot be read or built prints one fixed line, nothing from the file', async () => {
    writeFileSync(join(dir, 'bad.sql'), "INSERT INTO nowhere VALUES ('zorbak');");
    expect(await release(['--dump', join(dir, 'bad.sql')], io())).toBe(1);
    expect(lines.err.join('\n')).toContain('failed: could not build the release');
    expect(all()).not.toMatch(/zorbak|nowhere/);
    lines.err.length = 0;
    expect(await release(['--dump', join(dir, 'missing.sql')], io())).toBe(1);
    expect(all()).not.toContain('missing.sql');
  });
});
