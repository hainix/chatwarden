import { readZip } from '@chatwarden/matcher/corpus';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { doiSql } from '../src/tools/record.js';
import { main as zenodo } from '../src/tools/zenodo.js';
import { publishToZenodo, zenodoMetadata, type ZenodoRelease } from '../src/tools/zenodoClient.js';
import { makeBuildWorld } from './build-world.js';
import { buildTermsRelease } from '../src/build/release.js';
import { signBytes } from '../src/tools/sign.js';
import { generateSigningKey, loadSigningKey } from '../src/tools/keys.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';
import { FakeZenodo, TOKEN, ZENODO, type Step } from './zenodo-world.js';

// Zenodo (design 11), against a fake of its REST API. No network, no real token: the token here is a made-up string, and the tests prove it goes
// only into the Authorization header.

const PASS = 'a passphrase made up for the tests 99';
let tw: ToolWorld;
let fake: FakeZenodo;
let release: ZenodoRelease;
let releaseJson: string;
let fingerprint: string;
let publicKey: string;

beforeEach(async () => {
  tw = makeToolWorld({ env: { ZENODO_TOKEN: TOKEN } });
  fake = new FakeZenodo({ id: 1000, version: '2026.11.0' });
  const k = generateSigningKey('k1', PASS);
  const loaded = loadSigningKey(k.pem, PASS);
  fingerprint = loaded.fingerprint;
  publicKey = loaded.publicKey;
  const bw = await makeBuildWorld();
  await bw.term({ id: 'CWT-2026-00001', term: 'zorbak' });
  const built = await buildTermsRelease(bw.db, { clock: tw.clock, version: '2026.12.0', sequence: 1, previous: null });
  const sig = signBytes('zip', built.zip, loaded.key, 'k1');
  const manifest = (await readZip(built.zip)).get('manifest.json') as Uint8Array;
  release = {
    kind: 'terms',
    version: '2026.12.0',
    zip: built.zip,
    sig: new TextEncoder().encode(sig),
    manifest,
    keys: [{ id: 'k1', fingerprint }],
  };
  writeFileSync(join(tw.dir, 'terms-2026.12.0.zip'), built.zip);
  writeFileSync(join(tw.dir, 'terms-2026.12.0.zip.sig'), sig);
  releaseJson = join(tw.dir, 'terms-2026.12.0.release.json');
  writeFileSync(releaseJson, JSON.stringify({ summary: built.summary, held: [], stamped: built.stamped }));
});
afterEach(() => tw.cleanup());

const opts = () => ({ fetch: fake.fetch, token: TOKEN, record: 1000, today: '2026-12-01' });
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('the call sequence and the metadata are exactly as specified', () => {
  it('makes a new version of the record, replaces the carried-over files, uploads the zip, its signature and the manifest, sets the metadata, publishes', async () => {
    const out = await publishToZenodo(opts(), release);
    expect(fake.sequence()).toEqual([
      'GET /api/deposit/depositions/:id',
      'POST /api/deposit/depositions/:id/actions/newversion',
      'GET /api/deposit/depositions/:id',
      'DELETE /api/deposit/depositions/:id/files/f0',
      'PUT /api/files/bucket-:id/terms-2026.12.0.zip',
      'PUT /api/files/bucket-:id/terms-2026.12.0.zip.sig',
      'PUT /api/files/bucket-:id/terms-2026.12.0.manifest.json',
      'PUT /api/deposit/depositions/:id',
      'POST /api/deposit/depositions/:id/actions/publish',
    ]);
    expect(out).toEqual({ kind: 'terms', version: '2026.12.0', doi: '10.5281/zenodo.2001', fileUrl: `${ZENODO}/records/2001/files/terms-2026.12.0.zip?download=1`, recordId: 2001, depositionId: 2001 });
    expect(text(fake.uploaded.get('terms-2026.12.0.zip.sig') as Uint8Array)).toBe(text(release.sig));
    expect(Buffer.from(fake.uploaded.get('terms-2026.12.0.zip') as Uint8Array).equals(Buffer.from(release.zip))).toBe(true);
    expect(text(fake.uploaded.get('terms-2026.12.0.manifest.json') as Uint8Array)).toBe(text(release.manifest));
    expect(fake.published.map((d) => d.id).sort()).toEqual([1000, 2001]);
    expect(fake.drafts).toEqual([]);
  });

  it('the metadata is a dataset under CC BY 4.0 with the version, the content warning, the attribution and the key fingerprints', async () => {
    const md = zenodoMetadata(release, { today: '2026-12-01' });
    expect(md).toMatchObject({
      upload_type: 'dataset',
      title: 'Chatwarden community term list 2026.12.0',
      access_right: 'open',
      license: 'cc-by-4.0',
      version: '2026.12.0',
      publication_date: '2026-12-01',
      creators: [{ name: 'Chatwarden maintainers' }],
    });
    expect(Object.keys(md).sort()).toEqual(['access_right', 'creators', 'description', 'keywords', 'license', 'publication_date', 'title', 'upload_type', 'version']);
    const d = md.description;
    expect(d).toContain('CONTENT WARNING');
    expect(d).toContain('Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.');
    expect(d).toContain(fingerprint);
    expect(d).toContain('k1');
    expect(d).toContain('chatwarden-corpus/1');
    expect(d).not.toMatch(/zorbak/);
    expect(zenodoMetadata({ ...release, kind: 'eval' }, { today: '2026-12-01' }).title).toBe('Chatwarden eval and calibration set 2026.12.0');
    expect(zenodoMetadata(release, { today: '2026-12-01', creator: 'A. Maintainer' }).creators).toEqual([{ name: 'A. Maintainer' }]);
  });

  it('the metadata sent is the metadata described', async () => {
    await publishToZenodo(opts(), release);
    const put = fake.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/api/deposit/depositions/'));
    expect(put?.body).toEqual({ metadata: zenodoMetadata(release, { today: '2026-12-01' }) });
  });

  it('keeps html out of the description the owner did not write: the text holds no tag but the few it uses, and no url from the data', () => {
    const d = zenodoMetadata(release, { today: '2026-12-01' }).description;
    expect([...d.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]).every((t) => ['p', 'code', 'strong', 'ul', 'li'].includes(t as string))).toBe(true);
  });

  it('the token goes only in the Authorization header: never in a url, and every call carried it', async () => {
    await publishToZenodo(opts(), release);
    expect(fake.badAuth).toBe(0);
    expect(fake.tokenInUrl).toBe(0);
  });
});

describe('an API error at each step stops with a fixed message and leaves the index unchanged', () => {
  const steps: Step[] = ['lookup', 'newversion', 'draft', 'delete', 'upload', 'metadata', 'publish'];

  it.each(steps)('an error at %s is one fixed ToolError that holds no token and no server text, and nothing is returned', async (step) => {
    fake.failing.set(step, 500);
    const err = (await publishToZenodo(opts(), release).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('zenodo');
    expect(err.message).toBe(`zenodo step "${step}" failed (HTTP 500); nothing was added to the index`);
    expect(err.message + String(err.stack).split('\n')[0]).not.toContain(TOKEN);
    expect(fake.published.length).toBe(1);
  });

  it('a network failure (the fetch throws) is the same kind of fixed message, with no host', async () => {
    const throwing: typeof fetch = () => Promise.reject(new TypeError('connect ECONNREFUSED secret-host.example:443'));
    const err = (await publishToZenodo({ ...opts(), fetch: throwing }, release).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('zenodo step "lookup" failed (no answer); nothing was added to the index');
    expect(err.message).not.toMatch(/secret-host|ECONNREFUSED/);
  });

  it('a rejected token (401) says so in the same fixed form', async () => {
    const err = (await publishToZenodo({ ...opts(), token: 'a different token' }, release).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('zenodo step "lookup" failed (HTTP 401); nothing was added to the index');
  });

  it('after a failure part-way, running it again finishes the same draft: one new version, not two', async () => {
    fake.failing.set('metadata', 500);
    await expect(publishToZenodo(opts(), release)).rejects.toMatchObject({ code: 'zenodo' });
    expect(fake.drafts).toHaveLength(1);
    const out = await publishToZenodo(opts(), release);
    expect(out.doi).toBe('10.5281/zenodo.2001');
    expect(fake.drafts).toEqual([]);
    expect(fake.published.map((d) => d.id).sort()).toEqual([1000, 2001]);
  });
});

describe('a re-run for the same version does not create a second version', () => {
  it('once published, the same call (the same record) returns the same DOI and file url and creates nothing', async () => {
    const first = await publishToZenodo(opts(), release);
    const calls = fake.calls.length;
    const again = await publishToZenodo(opts(), release);
    expect(again).toEqual(first);
    expect(fake.published).toHaveLength(2);
    expect(fake.drafts).toEqual([]);
    expect(fake.calls.slice(calls).every((c) => c.method === 'GET' || c.path.endsWith('/newversion'))).toBe(true);
  });

  it('given the new version\u2019s own record, it finds the version there and does nothing more', async () => {
    const first = await publishToZenodo(opts(), release);
    fake.calls.length = 0;
    const again = await publishToZenodo({ ...opts(), record: first.depositionId }, release);
    expect(again).toEqual(first);
    expect(fake.sequence()).toEqual(['GET /api/deposit/depositions/:id']);
  });
});

describe('zenodo (the tool)', () => {
  const run = (argv: string[], w: ToolWorld = tw) => zenodo(argv, w.io, { fetch: fake.fetch });
  const base = (): string[] => ['--release', releaseJson, '--record', '1000', '--key', `k1=${publicKey}`];

  it('publishes, writes the result file the publish tool reads, prints the DOI and the record id for the next release, and never the token', async () => {
    expect(await run(base())).toBe(0);
    const result = JSON.parse(readFileSync(join(tw.dir, 'zenodo-terms-2026.12.0.json'), 'utf8')) as Record<string, unknown>;
    expect(result).toEqual({ kind: 'terms', version: '2026.12.0', doi: '10.5281/zenodo.2001', fileUrl: `${ZENODO}/records/2001/files/terms-2026.12.0.zip?download=1`, recordId: 2001, depositionId: 2001 });
    expect(tw.everything()).toContain('10.5281/zenodo.2001');
    expect(tw.everything()).toContain('--record 2001');
    expect(tw.everything()).not.toContain(TOKEN);
    expect(fake.badAuth).toBe(0);
  });

  it('the fingerprints in the description are the ones of the public keys it was given', async () => {
    await run(base());
    const put = fake.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/api/deposit/depositions/'));
    expect(JSON.stringify(put?.body)).toContain(fingerprint);
  });

  it('a result file that exists is the answer: no network at all', async () => {
    await run(base());
    const calls = fake.calls.length;
    tw.out.length = 0;
    expect(await run(base())).toBe(0);
    expect(fake.calls).toHaveLength(calls);
    expect(tw.out.join('\n')).toContain('already on Zenodo');
  });

  it('--dry-run prints the metadata and the files it would send, and makes no call and no file', async () => {
    expect(await run([...base(), '--dry-run'])).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(tw.dir, 'zenodo-terms-2026.12.0.json'))).toBe(false);
    const printed = tw.out.join('\n');
    expect(printed).toContain('"upload_type": "dataset"');
    expect(printed).toContain('terms-2026.12.0.zip.sig');
    expect(printed).not.toContain(TOKEN);
  });

  it('a dry run needs no token', async () => {
    const w = makeToolWorld({ env: {} });
    expect(await zenodo([...base(), '--dry-run'], w.io, { fetch: fake.fetch })).toBe(0);
    w.cleanup();
  });

  it('with no token in the environment it stops before any call; the variable\u2019s name can be changed, its value is never an argument', async () => {
    const w = makeToolWorld({ env: {} });
    expect(await zenodo(base(), w.io, { fetch: fake.fetch })).toBe(1);
    expect(w.err.join('\n')).toContain('no_token');
    expect(fake.calls).toEqual([]);
    const named = makeToolWorld({ env: { MY_ZENODO: TOKEN } });
    expect(await zenodo([...base(), '--token-env', 'MY_ZENODO'], named.io, { fetch: fake.fetch })).toBe(0);
    expect(await zenodo([...base(), '--token', TOKEN], named.io, { fetch: fake.fetch })).toBe(1);
    expect(named.everything()).not.toContain(TOKEN);
    w.cleanup();
    named.cleanup();
  });

  it('an API error prints the fixed line and writes no result file', async () => {
    fake.failing.set('upload', 503);
    expect(await run(base())).toBe(1);
    expect(tw.err.join('\n')).toContain('zenodo step "upload" failed (HTTP 503)');
    expect(tw.everything()).not.toContain(TOKEN);
    expect(existsSync(join(tw.dir, 'zenodo-terms-2026.12.0.json'))).toBe(false);
  });

  it('refuses a record that is not a number, a key that is not id=publicKey, and an unreadable release file, before any call', async () => {
    const key = `k1=${publicKey}`;
    const cases: string[][] = [
      ['--release', releaseJson, '--record', 'x'],
      ['--release', releaseJson, '--record', '0'],
      ['--release', releaseJson, '--record', '1000', '--key', 'garbage'],
      ['--release', join(tw.dir, 'none.json'), '--record', '1000', '--key', key],
      ['--release', releaseJson, '--record', '1.5'],
    ];
    for (const argv of cases) expect(await run(argv), argv.join(' ')).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it('writes the SQL that records the DOI beside the result file, and prints the command; the sandbox writes none', async () => {
    expect(await run(base())).toBe(0);
    expect(readFileSync(join(tw.dir, 'doi-terms-2026.12.0.sql'), 'utf8')).toBe(doiSql('terms', '2026.12.0', '10.5281/zenodo.2001'));
    expect(tw.everything()).toContain('wrangler d1 execute chatwarden-corpus --remote --file');
  });

  describe('--sandbox keeps its own result file, so a sandbox run never stands in for the real one', () => {
    const SANDBOX = 'https://sandbox.zenodo.org';
    const runSandbox = (argv: string[]) => zenodo(argv, tw.io, { fetch: new FakeZenodo({ id: 1000, version: '2026.11.0' }, SANDBOX).fetch });

    it('writes zenodo-sandbox-<kind>-<version>.json with sandbox: true, and no production result file', async () => {
      expect(await runSandbox([...base(), '--sandbox'])).toBe(0);
      expect(existsSync(join(tw.dir, 'zenodo-terms-2026.12.0.json'))).toBe(false);
      expect(existsSync(join(tw.dir, 'doi-terms-2026.12.0.sql'))).toBe(false);
      const result = JSON.parse(readFileSync(join(tw.dir, 'zenodo-sandbox-terms-2026.12.0.json'), 'utf8')) as Record<string, unknown>;
      expect(result).toMatchObject({ kind: 'terms', version: '2026.12.0', sandbox: true });
      expect(String(result.fileUrl)).toContain('sandbox.zenodo.org');
      expect(String(result.doi).startsWith('10.5072/')).toBe(true);
    });

    it('a production run after a sandbox run still goes to Zenodo (it is not "already on Zenodo")', async () => {
      expect(await runSandbox([...base(), '--sandbox'])).toBe(0);
      tw.out.length = 0;
      expect(await run(base())).toBe(0);
      expect(tw.out.join(String.fromCharCode(10))).not.toContain('already on Zenodo');
      expect(fake.calls.length).toBeGreaterThan(0);
      const prod = JSON.parse(readFileSync(join(tw.dir, 'zenodo-terms-2026.12.0.json'), 'utf8')) as Record<string, unknown>;
      expect(prod.sandbox).toBeUndefined();
      expect(String(prod.doi).startsWith('10.5281/')).toBe(true);
    });

    it('a second sandbox run is "already" the sandbox one', async () => {
      await runSandbox([...base(), '--sandbox']);
      tw.out.length = 0;
      expect(await runSandbox([...base(), '--sandbox'])).toBe(0);
      expect(tw.out.join(String.fromCharCode(10))).toContain('already on the Zenodo SANDBOX');
    });

    it('says in its output that the archive is a sandbox one and not to use it as a mirror', async () => {
      await runSandbox([...base(), '--sandbox']);
      expect(tw.out.join(String.fromCharCode(10))).toMatch(/sandbox/i);
      expect(tw.out.join(String.fromCharCode(10))).not.toContain('publish --mirror <the zenodo-... result file');
    });
  });
});
