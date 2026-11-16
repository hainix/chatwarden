import { parseIndex } from '@chatwarden/matcher/corpus';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTermsRelease } from '../src/build/release.js';
import { generateSigningKey } from '../src/tools/keys.js';
import { main as publish } from '../src/tools/publish.js';
import { main as sign } from '../src/tools/sign.js';
import { makeBuildWorld } from './build-world.js';
import { MemoryStore, PASS } from './publish-world.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';

// publish: the index-only paths (--refresh, --revoke-key, --revoke-release, with no release file) and the strict mirror file.

let tw: ToolWorld;
let store: MemoryStore;
let keyPath: string;
let k2Path: string;
let pub1: string;
let pub2: string;
let releaseJson: string;

beforeEach(async () => {
  tw = makeToolWorld({ secrets: Array.from({ length: 12 }, () => PASS) });
  store = new MemoryStore();
  const k = generateSigningKey('k1', PASS);
  pub1 = k.publicKey;
  keyPath = join(tw.dir, 'k1.pem');
  writeFileSync(keyPath, k.pem);
  const k2 = generateSigningKey('k2', PASS);
  pub2 = k2.publicKey;
  k2Path = join(tw.dir, 'k2.pem');
  writeFileSync(k2Path, k2.pem);
  const bw = await makeBuildWorld();
  await bw.term({ id: 'CWT-2026-00001', term: 'zorbak' });
  const built = await buildTermsRelease(bw.db, { clock: tw.clock, version: '2026.12.0', sequence: 1, previous: null });
  const zip = join(tw.dir, 'terms-2026.12.0.zip');
  writeFileSync(zip, built.zip);
  releaseJson = join(tw.dir, 'terms-2026.12.0.release.json');
  writeFileSync(releaseJson, JSON.stringify({ summary: built.summary, held: built.held, stamped: built.stamped }));
  expect(await sign(['--kind', 'zip', '--file', zip, '--key-id', 'k1', '--key', keyPath], tw.io)).toBe(0);
  expect(await publish(['--release', releaseJson, '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(0);
  tw.out.length = 0;
});
afterEach(() => tw.cleanup());

const err = (): string => tw.err.join(String.fromCharCode(10));
const live = (): { sequence: number; keyId: string; expiresAt: string; revokedKeyIds: string[]; revokedReleases: unknown[]; releases: unknown[] } => store.json('v1/index.json');

describe('publish --refresh (no release file)', () => {
  it('re-signs the live index with the next sequence and a fresh 90 days, uploads nothing but the pair, and writes no SQL', async () => {
    const before = live();
    tw.clock.advance(70 * 24 * 60 * 60 * 1000);
    const attempts = store.attempts.length;
    expect(await publish(['--refresh', '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(0);
    expect(store.attempts.slice(attempts).map((a) => a.key)).toEqual(['v1/index.json.sig', 'v1/index.json']);
    const after = live();
    expect(after.sequence).toBe(before.sequence + 1);
    expect(after.releases).toEqual(before.releases);
    expect(Date.parse(after.expiresAt) - tw.clock.now()).toBe(90 * 24 * 60 * 60 * 1000);
    expect(() => parseIndex(store.files.get('v1/index.json') as Uint8Array, tw.clock.now())).not.toThrow();
    expect(tw.out.join(' ')).toContain('refreshed');
  });

  it('--dry-run signs and writes the new index to --out and uploads nothing', async () => {
    const attempts = store.attempts.length;
    const out = join(tw.dir, 'dry');
    expect(await publish(['--refresh', '--dry-run', '--out', out, '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(0);
    expect(store.attempts).toHaveLength(attempts);
    expect(tw.writes.map((w) => w.path)).toEqual(expect.arrayContaining([join(out, 'index.json'), join(out, 'index.json.sig')]));
  });

  it('with no release and no --refresh, --revoke-key or --revoke-release it stops with the usage', async () => {
    expect(await publish(['--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(1);
    expect(err()).toContain('usage:');
  });
});

describe('publish --revoke-key and --revoke-release', () => {
  it('revokes a release without a release file: reason is one of the kit’s, and the live release is then refused by kits', async () => {
    expect(await publish(['--revoke-release', 'terms:2026.12.0:bad_release', '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(0);
    expect(live().revokedReleases).toEqual([{ kind: 'terms', version: '2026.12.0', reason: 'bad_release' }]);
    expect(live().sequence).toBe(2);
  });

  it('takes several, comma separated', async () => {
    expect(await publish(['--revoke-release', 'terms:2026.01.0:legal,eval:2026.02.0:bad_release', '--revoke-key', 'k7,k8', '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(0);
    expect(live().revokedReleases).toEqual([
      { kind: 'terms', version: '2026.01.0', reason: 'legal' },
      { kind: 'eval', version: '2026.02.0', reason: 'bad_release' },
    ]);
    expect(live().revokedKeyIds).toEqual(['k7', 'k8']);
  });

  it('also works together with a release file: re-publishing a live release with a revocation is not skipped', async () => {
    expect(await publish(['--release', releaseJson, '--revoke-key', 'k7', '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(0);
    expect(live().revokedKeyIds).toEqual(['k7']);
    expect(live().sequence).toBe(2);
  });

  it.each([
    ['--revoke-release', 'terms:2026.12.0'],
    ['--revoke-release', 'terms:2026.12.0:because'],
    ['--revoke-release', 'other:2026.12.0:legal'],
    ['--revoke-release', 'terms:x:legal'],
    ['--revoke-release', 'terms:2026.12.0:legal,'],
    ['--revoke-key', 'bad id!'],
    ['--revoke-key', ''],
  ])('refuses %s %s before any upload', async (flag, value) => {
    const attempts = store.attempts.length;
    expect(await publish([flag as string, value as string, '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(1);
    expect(store.attempts).toHaveLength(attempts);
  });

  it('refuses to revoke the key that signs the index (the kit would ignore it)', async () => {
    const attempts = store.attempts.length;
    expect(await publish(['--revoke-key', 'k1', '--key-id', 'k1', '--key', keyPath], tw.io, { store })).toBe(1);
    expect(err()).toContain('bad_input');
    expect(store.attempts).toHaveLength(attempts);
  });
});

describe('the compromise procedure through the CLI', () => {
  it('the standby k2, trusting k1, signs an index that revokes k1 and the release k1 signed; the index then names k2', async () => {
    const argv = ['--revoke-key', 'k1', '--revoke-release', 'terms:2026.12.0:key_compromise', '--key-id', 'k2', '--key', k2Path];
    // without --trust the live index (signed by k1) cannot be verified: nothing is built on it
    expect(await publish(argv, tw.io, { store })).toBe(1);
    expect(err()).toContain('bad_index');
    expect(live().keyId).toBe('k1');
    expect(await publish([...argv, '--trust', `k1=${pub1}`], tw.io, { store })).toBe(0);
    const after = live();
    expect(after).toMatchObject({ keyId: 'k2', revokedKeyIds: ['k1'], sequence: 2 });
    expect(after.revokedReleases).toEqual([{ kind: 'terms', version: '2026.12.0', reason: 'key_compromise' }]);
    expect(pub2.length).toBeGreaterThan(0);
  });
});

describe('--mirror takes only a real Zenodo result', () => {
  const mirrorFile = (body: Record<string, unknown>): string => {
    const f = join(tw.dir, 'm.json');
    writeFileSync(f, JSON.stringify(body));
    return f;
  };
  const good = { kind: 'terms', version: '2026.12.0', doi: '10.5281/zenodo.1234567', fileUrl: 'https://zenodo.org/records/1234567/files/terms-2026.12.0.zip?download=1' };
  const run = (body: Record<string, unknown>): Promise<number> => publish(['--release', releaseJson, '--mirror', mirrorFile(body), '--key-id', 'k1', '--key', keyPath], tw.io, { store });

  it('accepts the production result', async () => {
    expect(await run(good)).toBe(0);
    expect(JSON.stringify(live().releases)).toContain('zenodo.org/records/1234567');
  });

  it.each([
    ['a sandbox url', { fileUrl: 'https://sandbox.zenodo.org/records/1/files/terms-2026.12.0.zip?download=1' }],
    ['a sandbox DOI', { doi: '10.5072/zenodo.1234567' }],
    ['a result marked sandbox', { sandbox: true }],
    ['another host', { fileUrl: 'https://example.org/records/1/files/terms-2026.12.0.zip' }],
    ['a look-alike host', { fileUrl: 'https://zenodo.org.example.net/records/1/files/x.zip' }],
    ['a host with credentials', { fileUrl: 'https://zenodo.org@example.net/records/1/files/x.zip' }],
    ['another DOI prefix', { doi: '10.1234/zenodo.1' }],
    ['a port', { fileUrl: 'https://zenodo.org:8443/records/1/files/x.zip' }],
  ])('refuses %s, and uploads nothing', async (_name, change) => {
    const attempts = store.attempts.length;
    expect(await run({ ...good, ...change })).toBe(1);
    expect(err()).toContain('bad_input');
    expect(store.attempts).toHaveLength(attempts);
  });
});
