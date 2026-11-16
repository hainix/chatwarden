import { parseEvalSet, readZip } from '@chatwarden/matcher/corpus';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as evalset } from '../src/tools/evalset.js';
import { makeBuildWorld, type BuildWorld } from './build-world.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';

// tools/eval.mjs: build an eval release from a folder of cases and a copy of the database (for the corpus's terms), and check one case before a
// reviewer sees it. Invented words only.

let w: BuildWorld;
let tw: ToolWorld;
beforeEach(async () => {
  w = await makeBuildWorld();
  tw = makeToolWorld({ start: '2026-12-01T09:00:00Z' });
  await w.term({ id: 'CWT-2026-00001', term: 'quissel' });
});
afterEach(() => tw.cleanup());

const caseOf = (id: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  id,
  group: 'rude',
  reason: 'harassment',
  note: null,
  lines: [
    { who: 'reporter', text: 'that was a fair fight' },
    { who: 'reported', text: 'you play like a quissel', blocked: true },
  ],
  expect: { severity: 'rude', verdict: 'noted', mustCite: [2] },
  meta: { language: 'en', source: 'synthetic', reviewed: 3, ...meta },
  ...over,
});

function dumpOf(world: BuildWorld): string {
  const parts = [readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')];
  for (const table of ['terms', 'releases']) {
    const cols = (world.db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const quoted = cols.map((c) => `quote("${c}")`).join(" || ',' || ");
    for (const r of world.db.raw.prepare(`SELECT ${quoted} AS v FROM ${table}`).all() as { v: string }[]) parts.push(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${r.v});`);
  }
  return parts.join('\n');
}

function setup(cases: Record<string, unknown[]>): { dir: string; dump: string } {
  const dir = join(tw.dir, 'cases');
  mkdirSync(dir, { recursive: true });
  for (const [lang, list] of Object.entries(cases)) writeFileSync(join(dir, `cases.${lang}.json`), JSON.stringify(list));
  const dump = join(tw.dir, 'd1.sql');
  writeFileSync(dump, dumpOf(w));
  return { dir, dump };
}
const all = (): string => tw.everything();

describe('eval build', () => {
  it('builds the zip and the summary the sign, publish and zenodo tools read, from a folder of cases', async () => {
    const { dir, dump } = setup({ en: [caseOf('a-1'), caseOf('a-2')], es: [caseOf('b-1', {}, { language: 'es' })] });
    const out = join(tw.dir, 'out');
    expect(await evalset(['build', '--cases', dir, '--dump', dump, '--out', out], tw.io)).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['eval-2026.12.0.release.json', 'eval-2026.12.0.zip']);
    const set = parseEvalSet(await readZip(new Uint8Array(readFileSync(join(out, 'eval-2026.12.0.zip')))), { version: '2026.12.0', sequence: 1 });
    expect(set.cases.map((c) => c.id)).toEqual(['a-1', 'a-2', 'b-1']);
    const summary = JSON.parse(readFileSync(join(out, 'eval-2026.12.0.release.json'), 'utf8')) as { summary: { kind: string; languages: unknown }; held: unknown[]; stamped: unknown[] };
    expect(summary.summary.kind).toBe('eval');
    expect(summary.stamped).toEqual([]);
    expect(all()).toContain('3 cases');
    expect(all()).not.toMatch(/quissel|fair fight/);
  });

  it('prints held cases by id and code, never a line, and still builds the rest', async () => {
    const { dir, dump } = setup({ en: [caseOf('ok-1'), caseOf('url-1', { lines: [{ who: 'reporter', text: 'see https://example.test/secret' }] }, { source: 'contributed' }), caseOf('low-1', {}, { reviewed: 1 })] });
    expect(await evalset(['build', '--cases', dir, '--dump', dump, '--out', join(tw.dir, 'out')], tw.io)).toBe(0);
    expect(all()).toContain('url-1: contact');
    expect(all()).toContain('low-1: unreviewed');
    expect(all()).not.toMatch(/secret|example\.test/);
  });

  it('numbers its versions and sequences from the database, per kind and across kinds', async () => {
    await w.release('eval', '2026.12.0', 1);
    await w.release('terms', '2026.12.0', 2);
    const { dir, dump } = setup({ en: [caseOf('a-1')] });
    expect(await evalset(['build', '--cases', dir, '--dump', dump, '--out', join(tw.dir, 'out')], tw.io)).toBe(0);
    expect(readdirSync(join(tw.dir, 'out')).sort()).toEqual(['eval-2026.12.1.release.json', 'eval-2026.12.1.zip']);
    const set = parseEvalSet(await readZip(new Uint8Array(readFileSync(join(tw.dir, 'out', 'eval-2026.12.1.zip')))), { version: '2026.12.1', sequence: 3 });
    expect(set.manifest.previous).toBe('2026.12.0');
    expect(set.sequence).toBe(3);
  });

  it('refuses a missing option, an unknown subcommand, a folder with no cases files, and a file that is not a list', async () => {
    const { dir, dump } = setup({ en: [caseOf('a-1')] });
    expect(await evalset([], tw.io)).toBe(1);
    expect(await evalset(['frobnicate'], tw.io)).toBe(1);
    expect(await evalset(['build', '--dump', dump], tw.io)).toBe(1);
    expect(await evalset(['build', '--cases', join(tw.dir, 'empty'), '--dump', dump, '--out', join(tw.dir, 'o')], tw.io)).toBe(1);
    writeFileSync(join(dir, 'cases.pt.json'), '{"not":"a list"}');
    expect(await evalset(['build', '--cases', dir, '--dump', dump, '--out', join(tw.dir, 'o')], tw.io)).toBe(1);
    expect(all()).not.toMatch(/Error:|at .*\.ts/);
  });
});

describe('eval check', () => {
  it('prints ok for a clean case and the codes for one that is not, against a source if given, and never a line', async () => {
    const { dump } = setup({});
    const clean = join(tw.dir, 'c.json');
    writeFileSync(clean, JSON.stringify(caseOf('c-1')));
    expect(await evalset(['check', '--case', clean, '--dump', dump], tw.io)).toBe(0);
    expect(tw.out.join('\n')).toContain('ok');
    const source = join(tw.dir, 's.json');
    writeFileSync(source, JSON.stringify(caseOf('s-1')));
    tw.out.length = 0;
    expect(await evalset(['check', '--case', clean, '--source', source, '--dump', dump], tw.io)).toBe(1);
    expect(tw.out.join('\n')).toContain('copy_of_source');
    const bad = join(tw.dir, 'b.json');
    writeFileSync(bad, JSON.stringify(caseOf('b-1', { lines: [{ who: 'Alice', text: 'mail name@example.test' }] })));
    tw.out.length = 0;
    expect(await evalset(['check', '--case', bad], tw.io)).toBe(1);
    expect(tw.out.join('\n')).toContain('identifier, contact');
    expect(all()).not.toMatch(/Alice|name@example/);
  });
});
