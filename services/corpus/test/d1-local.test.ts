import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTermsRelease, readZip } from '@chatwarden/matcher/corpus';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTermsRelease } from '../src/build/release.js';
import type { D1Like } from '../src/env.js';
import { openDump } from '../src/tools/localD1.js';
import { recordSql } from '../src/tools/record.js';
import { planTerms } from '../src/tools/seed.js';
import { ALICE, BOB, makeReviewWorld, type ReviewWorld } from './review-world.js';
import { validBody } from './world.js';
import { makeInstallation } from './world.js';

// THE LOCAL D1 SMOKE (opt-in). Every other test runs the service's SQL on node:sqlite through an adapter that follows D1. This one runs it on D1's
// own engine, locally and with no Cloudflare account, through wrangler's local mode (workerd + miniflare):
//   - the schema and the seed and record SQL are applied with the owner's own command, `wrangler d1 execute chatwarden-corpus --local --file ...`;
//   - the service's app, review routes and release builder then run against the real D1 binding (`getPlatformProxy`), covering what a fake could hide:
//     INSERT ... ON CONFLICT ... RETURNING (the counters), `changes()` inside a batch (the audit of a negative line), the partial unique indexes
//     (a duplicate pending word, a double vote), the UNIQUE error text the service maps to 409, `instr`, and the builder's queries.
// It needs workerd (installed with the workspace) and takes about a minute, so it does not run by default:  npm run smoke:d1 -w @chatwarden/corpus-service
// (or CORPUS_D1_LOCAL=1 npx vitest run services/corpus/test/d1-local.test.ts). It is skipped, with this reason, in every other run.

const enabled = process.env.CORPUS_D1_LOCAL === '1';
const service = fileURLToPath(new URL('..', import.meta.url));
const wranglerBin = (): string => fileURLToPath(new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function runWrangler(args: string[], cwd: string = service): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
    let output = '';
    child.stdout.on('data', (d: Buffer) => void (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => void (output += d.toString()));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} failed (${code}): ${output.slice(-800)}`))));
  });
}

describe.skipIf(!enabled)('local D1 smoke: the service on D1\u2019s own engine, no Cloudflare account', () => {
  let dir: string;
  let proxy: { env: { DB: D1Like }; dispose(): Promise<void> };
  let db: D1Like;
  let rw: ReviewWorld;
  // wrangler's local state lives in `<work>/.wrangler/state`, in a folder of its own, so the smoke never touches the service folder or another run.
  let work: string;
  const execute = (file: string): Promise<void> => runWrangler(['d1', 'execute', 'chatwarden-corpus', '--local', '--file', file], work);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-d1-'));
    work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'wrangler.jsonc'), JSON.stringify({ name: 'corpus-smoke', compatibility_date: '2026-11-01', d1_databases: [{ binding: 'DB', database_name: 'chatwarden-corpus', database_id: 'REPLACE_AT_DEPLOY' }] }));
    await execute(join(service, 'schema.sql'));
    await execute(join(service, 'schema.sql')); // idempotent: the owner may apply it again
    const { getPlatformProxy } = await import('wrangler');
    proxy = (await getPlatformProxy({ configPath: join(work, 'wrangler.jsonc'), persist: { path: join(work, '.wrangler', 'state', 'v3') } })) as unknown as typeof proxy;
    db = proxy.env.DB;
    rw = await makeReviewWorld({ db });
    for (const [email, fluent] of [[ALICE, '["en"]'], [BOB, '[]']] as const) await db.prepare('INSERT INTO reviewers (email, fluent, active) VALUES (?, ?, 1)').bind(email, fluent).run();
  }, 180_000);

  afterAll(async () => {
    rw?.restore();
    await proxy?.dispose();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  const count = async (sql: string, ...v: unknown[]): Promise<number> => (await db.prepare(sql).bind(...v).first<{ n: number }>())?.n ?? -1;

  it('the Worker bundles for deployment with the real wrangler.jsonc (a dry run: no account, no upload), and the bundle holds no term list', async () => {
    const out = join(dir, 'bundle');
    await runWrangler(['deploy', '--dry-run', '--outdir', out]);
    expect(existsSync(join(out, 'worker.js'))).toBe(true);
    const code = readFileSync(join(out, 'worker.js'), 'utf8');
    expect(code).toContain('/v1/submissions');
    expect(code).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  }, 180_000);

  it('has every table and both partial unique indexes after the schema was applied by wrangler', async () => {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    for (const t of ['audit', 'counters', 'innocent_words', 'negative_lines', 'releases', 'reports', 'reviewer_installations', 'reviewers', 'reviews', 'submissions', 'term_lines', 'terms']) expect(names, t).toContain(t);
    expect(names).toContain('submissions_one_pending');
    expect(names).toContain('reports_one_open');
  });

  it('INSERT ... ON CONFLICT DO UPDATE ... RETURNING counts a request in the rate-limit table (counters.hit), through the real submission route', async () => {
    const inst = await makeInstallation();
    const res = await rw.w.post({ installation: inst, body: validBody({ term: 'zorbak' }) });
    expect(res.status).toBe(202);
    const rows = (await db.prepare("SELECT key, n FROM counters ORDER BY key").all<{ key: string; n: number }>()).results;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.n >= 1)).toBe(true);
    // the address is never stored: a counter key is a hash
    expect(JSON.stringify(rows)).not.toContain('203.0.113');
  });

  it('the partial unique index makes two pending submissions of one word at once one row: the loser is answered duplicate, not an error', async () => {
    const [a, b] = [await makeInstallation(), await makeInstallation()];
    const answers = await Promise.all([rw.w.post({ installation: a, body: validBody({ term: 'vlemmo' }), ip: '198.51.100.1' }), rw.w.post({ installation: b, body: validBody({ term: 'vlemmo' }), ip: '198.51.100.2' })]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 202]);
    expect(await count("SELECT COUNT(*) AS n FROM submissions WHERE word_key = 'vlemo' AND status IN ('received','in_review')")).toBe(1);
  });

  it('a review: approve makes the term (a batch with RETURNING-free inserts and an audit row), and `changes()` in a batch audits a negative line once, not twice', async () => {
    const sub = (await db.prepare("SELECT id FROM submissions WHERE word_key = 'zorbak'").first<{ id: string }>())?.id as string;
    expect(sub).toBeDefined();
    const approved = await rw.admin(`/admin/api/submissions/${sub}/approve`, { method: 'POST', body: { target: 'ethnicity' }, who: ALICE });
    expect(approved.status).toBe(200);
    const term = (await db.prepare("SELECT id, status FROM terms WHERE word_key = 'zorbak'").first<{ id: string; status: string }>()) as { id: string; status: string };
    expect(term.status).toBe('provisional');
    const add = () => rw.admin(`/admin/api/terms/${term.id}/negative`, { method: 'POST', body: { line: 'a zorbakian lake' }, who: ALICE });
    expect(await (await add()).json()).toEqual({ added: true });
    expect(await (await add()).json()).toEqual({ added: false });
    expect(await count("SELECT COUNT(*) AS n FROM audit WHERE action = 'review.negative' AND subject = ?", term.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM term_lines WHERE term_id = ?", term.id)).toBe(1);
  });

  it('the UNIQUE error text of real D1 is the one the service maps: a vote that loses a race is 409, never 500', async () => {
    const term = (await db.prepare("SELECT id FROM terms WHERE word_key = 'zorbak'").first<{ id: string }>()) as { id: string };
    const out = await Promise.all([rw.admin(`/admin/api/terms/${term.id}/dispute`, { method: 'POST', body: {}, who: BOB }), rw.admin(`/admin/api/terms/${term.id}/dispute`, { method: 'POST', body: {}, who: BOB })]);
    expect(out.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM reviews WHERE subject_kind = 'term' AND subject_id = ? AND reviewer = ?", term.id, BOB)).toBe(1);
  });

  it('the seed SQL applies with wrangler d1 execute, and the builder runs on the real D1 (instr, the dictionary gate, ORDER BY on a boolean) and writes a release the kit reads', async () => {
    await db.prepare("INSERT INTO innocent_words (language, word_key, rank) VALUES ('en', 'tarvoish', 40)").run();
    await db.prepare("INSERT INTO negative_lines (language, line, origin) VALUES ('en', 'a plain line', 'test')").run();
    const plan = planTerms([{ term: 'quissel', languages: ['en'], category: 'abuse', severity: 'hostile', source: 'smoke-test' }, { term: 'tarvo', languages: ['en', 'pt'], category: 'abuse', severity: 'hostile', source: 'smoke-test' }], { next: 100, keys: new Set() }, '2026-12-01T09:00:00Z', 2026);
    const file = join(dir, 'seed.sql');
    writeFileSync(file, plan.sql);
    await execute(file);
    expect(await count("SELECT COUNT(*) AS n FROM terms WHERE id IN ('CWT-2026-00100','CWT-2026-00101')")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM reviews WHERE reviewer = 'seed:smoke-test'")).toBe(2);
    const built = await buildTermsRelease(db, { clock: rw.clock, version: '2026.12.0', sequence: 1, previous: null, allowBulk: true });
    const rel = parseTermsRelease(await readZip(built.zip), { version: '2026.12.0', sequence: 1 });
    expect(rel.terms.map((t) => t.id)).toEqual(expect.arrayContaining(['CWT-2026-00100', 'CWT-2026-00101']));
    expect(rel.terms.find((t) => t.id === 'CWT-2026-00101')?.negative).toContain('tarvoish');
    // and the record SQL, the last owner step, applies with the owner's command and gives `since` to the terms it names
    const record = join(dir, 'record.sql');
    writeFileSync(record, recordSql({ kind: 'terms', version: '2026.12.0', sequence: 1, sha256: built.summary.sha256, keyId: 'k1', publishedAt: '2026-12-01T09:00:00Z', stamped: built.stamped }));
    await execute(record);
    expect(await count("SELECT COUNT(*) AS n FROM terms WHERE since IS NULL")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM releases WHERE version = '2026.12.0'")).toBe(1);
    expect(readFileSync(record, 'utf8')).not.toMatch(/quissel|tarvo/);
  }, 180_000);

  it('`wrangler d1 export` writes a dump that the release tool opens, and a release built from the dump is the release built from the database', async () => {
    const out = join(dir, 'export.sql');
    await runWrangler(['d1', 'export', 'chatwarden-corpus', '--local', '--output', out], work);
    const fromDump = await buildTermsRelease(openDump(readFileSync(out, 'utf8')), { clock: rw.clock, version: '2026.12.1', sequence: 2, previous: '2026.12.0', allowBulk: true });
    const fromD1 = await buildTermsRelease(db, { clock: rw.clock, version: '2026.12.1', sequence: 2, previous: '2026.12.0', allowBulk: true });
    expect(fromDump.summary.sha256).toBe(fromD1.summary.sha256);
    expect(fromDump.release.terms.length).toBeGreaterThan(0);
  }, 180_000);
});
