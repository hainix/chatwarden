import { parseIndex, verifySignature } from '@chatwarden/matcher/corpus';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as publish } from '../src/tools/publish.js';
import { main as sign } from '../src/tools/sign.js';
import { makeBuildWorld } from './build-world.js';
import { buildTermsRelease } from '../src/build/release.js';
import { generateSigningKey } from '../src/tools/keys.js';
import { PASS, MemoryStore } from './publish-world.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';

// tools/publish.mjs through its logic: the release summary and the signed zip in a folder, the index signed with the key and passphrase the owner
// gives, uploads through an injected store (the real one is wrangler), and a file of SQL for the owner to apply.

let tw: ToolWorld;
let store: MemoryStore;
let keyPath: string;
let pub: string;
let releaseJson: string;

beforeEach(async () => {
  tw = makeToolWorld({ secrets: Array.from({ length: 8 }, () => PASS) });
  store = new MemoryStore();
  const k = generateSigningKey('k1', PASS);
  pub = k.publicKey;
  keyPath = join(tw.dir, 'k1.pem');
  writeFileSync(keyPath, k.pem);
  const bw = await makeBuildWorld();
  await bw.term({ id: 'CWT-2026-00001', term: 'zorbak' });
  await bw.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
  const built = await buildTermsRelease(bw.db, { clock: tw.clock, version: '2026.12.0', sequence: 1, previous: null });
  const zip = join(tw.dir, 'terms-2026.12.0.zip');
  writeFileSync(zip, built.zip);
  releaseJson = join(tw.dir, 'terms-2026.12.0.release.json');
  writeFileSync(releaseJson, JSON.stringify({ summary: built.summary, held: built.held, stamped: built.stamped }));
  expect(await sign(['--kind', 'zip', '--file', zip, '--key-id', 'k1', '--key', keyPath], tw.io)).toBe(0);
  tw.out.length = 0;
});
afterEach(() => tw.cleanup());

const base = (): string[] => ['--release', releaseJson, '--key-id', 'k1', '--key', keyPath];
const all = (): string => tw.everything();

describe('publish (the tool)', () => {
  it('signs the index with the owner\u2019s key, uploads in order, and writes the SQL that records the release', async () => {
    expect(await publish(base(), tw.io, { store })).toBe(0);
    expect(store.order).toEqual(['robots.txt', 'v1/terms/2026.12.0/terms-2026.12.0.zip', 'v1/terms/2026.12.0/terms-2026.12.0.zip.sig', 'v1/index.json.sig', 'v1/index.json']);
    const keys = [{ id: 'k1', publicKey: pub }];
    await verifySignature('index', store.files.get('v1/index.json') as Uint8Array, store.files.get('v1/index.json.sig') as Uint8Array, keys);
    expect(parseIndex(store.files.get('v1/index.json') as Uint8Array, tw.clock.now()).latest).toEqual({ terms: '2026.12.0' });
    const sql = readFileSync(join(tw.dir, 'record-terms-2026.12.0.sql'), 'utf8');
    expect(sql).toContain("INSERT INTO releases (kind, version, sequence, sha256, key_id, published_at, doi) VALUES ('terms', '2026.12.0', 1,");
    expect(sql).toContain("'CWT-2026-00001'");
    expect(all()).toContain('wrangler d1 execute chatwarden-corpus --remote --file');
    expect(all()).toContain('verify-live');
  });

  it('never prints the passphrase, the key, a word or a bucket path', async () => {
    await publish(base(), tw.io, { store });
    expect(all()).not.toContain(PASS);
    expect(all()).not.toMatch(/BEGIN|PRIVATE KEY|zorbak|vlemmo/);
    expect(all()).not.toContain(keyPath);
  });

  it('--dry-run signs and writes the index and its signature to --out, uploads nothing, writes no SQL', async () => {
    const out = join(tw.dir, 'dry');
    expect(await publish([...base(), '--dry-run', '--out', out], tw.io, { store })).toBe(0);
    expect(store.attempts).toEqual([]);
    expect(existsSync(join(out, 'index.json'))).toBe(true);
    expect(existsSync(join(out, 'index.json.sig'))).toBe(true);
    expect(existsSync(join(tw.dir, 'record-terms-2026.12.0.sql'))).toBe(false);
    expect(all()).toContain('dry run');
  });

  it('adds the Zenodo mirror from the zenodo tool\u2019s result file', async () => {
    const mirror = join(tw.dir, 'zenodo-terms-2026.12.0.json');
    writeFileSync(mirror, JSON.stringify({ kind: 'terms', version: '2026.12.0', doi: '10.5281/zenodo.1234567', fileUrl: 'https://zenodo.org/records/1234567/files/terms-2026.12.0.zip?download=1' }));
    expect(await publish([...base(), '--mirror', mirror], tw.io, { store })).toBe(0);
    const index = store.json<{ releases: { mirrors: unknown[] }[] }>('v1/index.json');
    expect(index.releases[0]?.mirrors).toEqual([{ kind: 'zenodo', doi: '10.5281/zenodo.1234567', url: 'https://zenodo.org/records/1234567/files/terms-2026.12.0.zip?download=1' }]);
    expect(readFileSync(join(tw.dir, 'record-terms-2026.12.0.sql'), 'utf8')).not.toContain('zenodo');
  });

  it('refuses a mirror file that is not https, not a Zenodo DOI or for another release, and uploads nothing', async () => {
    for (const body of [
      { kind: 'terms', version: '2026.12.0', doi: '10.5281/zenodo.1', fileUrl: 'http://zenodo.org/x' },
      { kind: 'terms', version: '2026.12.0', doi: 'nope', fileUrl: 'https://zenodo.org/x' },
      { kind: 'terms', version: '2026.11.0', doi: '10.5281/zenodo.1', fileUrl: 'https://zenodo.org/x' },
      'not json at all',
    ]) {
      const f = join(tw.dir, 'm.json');
      writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
      expect(await publish([...base(), '--mirror', f], tw.io, { store })).toBe(1);
    }
    expect(store.attempts).toEqual([]);
  });

  it('after a rotation the new key publishes on top of an index the old key signed only when the old key is named with --trust', async () => {
    expect(await publish(base(), tw.io, { store })).toBe(0);
    const k2 = generateSigningKey('k2', PASS);
    const k2Path = join(tw.dir, 'k2.pem');
    writeFileSync(k2Path, k2.pem);
    const bw = await makeBuildWorld();
    await bw.term({ id: 'CWT-2026-00009', term: 'quissel' });
    const built = await buildTermsRelease(bw.db, { clock: tw.clock, version: '2026.12.1', sequence: 2, previous: '2026.12.0', allowBulk: true });
    const zip = join(tw.dir, 'terms-2026.12.1.zip');
    writeFileSync(zip, built.zip);
    const rel = join(tw.dir, 'terms-2026.12.1.release.json');
    writeFileSync(rel, JSON.stringify({ summary: built.summary, held: [], stamped: built.stamped }));
    expect(await sign(['--kind', 'zip', '--file', zip, '--key-id', 'k2', '--key', k2Path], tw.io)).toBe(0);
    const before = store.text('v1/index.json');
    const argv = ['--release', rel, '--key-id', 'k2', '--key', k2Path];
    expect(await publish(argv, tw.io, { store })).toBe(1);
    expect(tw.err.join(String.fromCharCode(10))).toContain('bad_index');
    expect(store.text('v1/index.json')).toBe(before);
    expect(await publish([...argv, '--trust', `k1=${pub}`], tw.io, { store })).toBe(0);
    expect(store.json<{ keyId: string; sequence: number }>('v1/index.json')).toMatchObject({ keyId: 'k2', sequence: 2 });
  });

  it('exits 1 with a fixed line for: a wrong passphrase, no key, a missing zip signature, a missing release file, a bad option', async () => {
    const cases: [string[], ToolWorld][] = [
      [base(), makeToolWorld({ secrets: ['not the passphrase 123'] })],
      [['--release', releaseJson, '--key-id', 'k1'], makeToolWorld({ secrets: [PASS] })],
      [['--release', join(tw.dir, 'none.json'), '--key-id', 'k1', '--key', keyPath], makeToolWorld({ secrets: [PASS] })],
      [[...base(), '--bogus'], makeToolWorld({ secrets: [PASS] })],
      [[...base(), '--sequence', 'x'], makeToolWorld({ secrets: [PASS] })],
      [[...base(), '--bucket', 'A B'], makeToolWorld({ secrets: [PASS] })],
    ];
    for (const [argv, w] of cases) {
      expect(await publish(argv, w.io, { store }), argv.join(' ')).toBe(1);
      expect(w.everything()).not.toMatch(/BEGIN|PRIVATE KEY|not the passphrase|zorbak/);
      w.cleanup();
    }
    expect(store.attempts).toEqual([]);
    const sigPath = join(tw.dir, 'terms-2026.12.0.zip.sig');
    writeFileSync(sigPath, 'x');
    const w = makeToolWorld({ secrets: [PASS] });
    expect(await publish(base(), w.io, { store })).toBe(1);
    expect(w.err.join('\n')).toContain('bad_signature');
    w.cleanup();
  });

  it('a failed upload prints its closed code and the previous index is untouched', async () => {
    expect(await publish(base(), tw.io, { store })).toBe(0);
    const before = store.text('v1/index.json');
    const bw = await makeBuildWorld();
    await bw.term({ id: 'CWT-2026-00009', term: 'quissel' });
    const built = await buildTermsRelease(bw.db, { clock: tw.clock, version: '2026.12.1', sequence: 2, previous: '2026.12.0', allowBulk: true });
    const zip = join(tw.dir, 'terms-2026.12.1.zip');
    writeFileSync(zip, built.zip);
    writeFileSync(join(tw.dir, 'terms-2026.12.1.release.json'), JSON.stringify({ summary: built.summary, held: [], stamped: built.stamped }));
    expect(await sign(['--kind', 'zip', '--file', zip, '--key-id', 'k1', '--key', keyPath], tw.io)).toBe(0);
    store.failAt = new Set([store.attempts.length + 2]);
    tw.err.length = 0;
    expect(await publish(['--release', join(tw.dir, 'terms-2026.12.1.release.json'), '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(1);
    expect(tw.err.join('\n')).toContain('upload_failed');
    expect(store.text('v1/index.json')).toBe(before);
  });
});
