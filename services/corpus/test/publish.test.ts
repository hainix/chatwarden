import { chooseRelease, parseIndex, verifySignature, type CorpusIndex } from '@chatwarden/matcher/corpus';
import { beforeEach, describe, expect, it } from 'vitest';
import { r2Store } from '../src/tools/publishing.js';
import { createR2 } from './r2.js';
import { makePublishWorld, type PublishWorld } from './publish-world.js';

// Publishing (design 6.1, 6.2, 7): files first, the index last, the sequence only up, everything read back and verified with the kit.

let pw: PublishWorld;
beforeEach(async () => {
  pw = await makePublishWorld();
});

const NOW = Date.parse('2026-12-01T09:00:00Z');
const live = async (): Promise<CorpusIndex> => {
  const bytes = pw.store.files.get('v1/index.json') as Uint8Array;
  await verifySignature('index', bytes, pw.store.files.get('v1/index.json.sig') as Uint8Array, pw.keys);
  return parseIndex(bytes, NOW);
};
const liveBytes = (): { index: string; sig: string } => ({ index: pw.store.text('v1/index.json'), sig: pw.store.text('v1/index.json.sig') });

describe('publish uploads the index after the release files (the fake bucket records the order); a failure on the third file leaves the previous index live', () => {
  it('the first release: robots.txt, the zip, its signature, the index signature, then the index last', async () => {
    const { built, zipSig } = await pw.release('2026.12.0', 1, ['zorbak', 'vlemmo']);
    const out = await pw.publish(built, zipSig);
    expect(pw.store.order).toEqual(['robots.txt', 'v1/terms/2026.12.0/terms-2026.12.0.zip', 'v1/terms/2026.12.0/terms-2026.12.0.zip.sig', 'v1/index.json.sig', 'v1/index.json']);
    expect(out).toMatchObject({ published: true, sequence: 1 });
    expect(out.uploaded).toEqual(pw.store.order);
    expect(pw.store.text('robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('writes the index of design 6.2: sequence, freshness 90 days, the key, latest, and the entry with its hash, paths, counts and minimum kit', async () => {
    const { built, zipSig } = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(built, zipSig, { notes: 'First release. Plain sentences only.' });
    const raw = pw.store.json<Record<string, unknown>>('v1/index.json');
    expect(Object.keys(raw)).toEqual(['schema', 'sequence', 'issuedAt', 'expiresAt', 'keyId', 'revokedKeyIds', 'revokedReleases', 'latest', 'releases']);
    expect(raw).toMatchObject({ schema: 'chatwarden-corpus-index/1', sequence: 1, issuedAt: '2026-12-01T09:00:00Z', expiresAt: '2027-03-01T09:00:00Z', keyId: 'k1', revokedKeyIds: [], revokedReleases: [], latest: { terms: '2026.12.0' } });
    expect((raw.releases as Record<string, unknown>[])[0]).toEqual({
      kind: 'terms',
      version: '2026.12.0',
      publishedAt: '2026-12-01T09:00:00Z',
      minKit: built.summary.minKit,
      languages: built.summary.languages,
      bytes: built.zip.length,
      sha256: built.summary.sha256,
      zip: 'terms/2026.12.0/terms-2026.12.0.zip',
      sig: 'terms/2026.12.0/terms-2026.12.0.zip.sig',
      mirrors: [],
      notes: 'First release. Plain sentences only.',
    });
    const index = await live();
    expect(chooseRelease(index, { kind: 'terms', kit: '0.1.11', follow: 'stable' }).version).toBe('2026.12.0');
  });

  it('sends the headers of design 6.1: zips attachment and immutable, the index five minutes', async () => {
    const { built, zipSig } = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(built, zipSig);
    const meta = Object.fromEntries(pw.store.attempts.map((a) => [a.key, a.meta]));
    expect(meta['v1/terms/2026.12.0/terms-2026.12.0.zip']).toEqual({ contentType: 'application/zip', cacheControl: 'public, max-age=31536000, immutable', contentDisposition: 'attachment; filename="terms-2026.12.0.zip"' });
    expect(meta['v1/terms/2026.12.0/terms-2026.12.0.zip.sig']).toMatchObject({ contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' });
    expect(meta['v1/index.json']).toEqual({ contentType: 'application/json', cacheControl: 'public, max-age=300' });
    expect(meta['v1/index.json.sig']).toEqual({ contentType: 'application/json', cacheControl: 'public, max-age=300' });
  });

  it('a failure on the first, second, third or fourth upload leaves the previous index and signature live, byte for byte, and says so with a fixed message', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const before = liveBytes();
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    const written = pw.store.attempts.length;
    // The second publish writes: zip (1), zip.sig (2), index.json.sig (3), index.json (4).
    for (const nth of [1, 2, 3, 4]) {
      pw.store.failAt = new Set([written + nth]);
      const err = await pw.publish(two.built, two.zipSig).catch((e: unknown) => e);
      expect(err, `failure at ${nth}`).toMatchObject({ code: 'upload_failed' });
      expect(String((err as Error).message)).not.toMatch(/secret-host/);
      expect(liveBytes(), `failure at ${nth}`).toEqual(before);
      await live(); // and it still verifies
      pw.store.failAt = new Set();
      pw.store.attempts.length = written;
    }
  });

  it('a corrupt upload (the bucket stores other bytes than it was given) is caught by the read back, and the previous index stays live', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const before = liveBytes();
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    pw.store.corrupt.set('v1/terms/2026.12.1/terms-2026.12.1.zip', (b) => b.map((x, i) => (i === 50 ? x ^ 1 : x)));
    await expect(pw.publish(two.built, two.zipSig)).rejects.toMatchObject({ code: 'verify_failed' });
    expect(liveBytes()).toEqual(before);
    pw.store.corrupt.clear();
    pw.store.corrupt.set('v1/index.json', (b) => b.map((x, i) => (i === 20 ? x ^ 1 : x)));
    await expect(pw.publish(two.built, two.zipSig)).rejects.toMatchObject({ code: 'verify_failed' });
    expect(liveBytes()).toEqual(before); // the old pair was put back
  });
});

describe('a dry run', () => {
  it('builds, signs and verifies the new index and uploads nothing, not even a read back', async () => {
    const { built, zipSig } = await pw.release('2026.12.0', 1, ['zorbak']);
    const out = await pw.publish(built, zipSig, { dryRun: true });
    expect(out).toMatchObject({ published: true, sequence: 1, uploaded: [] });
    expect(pw.store.attempts).toEqual([]);
    await verifySignature('index', out.indexBytes, out.indexSig, pw.keys);
    expect(parseIndex(out.indexBytes, NOW).latest.terms).toBe('2026.12.0');
  });
});

describe('publish refuses a lower sequence', () => {
  it('raises the sequence by one for every published index, and never takes a sequence at or below the live one', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    expect((await pw.publish(one.built, one.zipSig)).sequence).toBe(1);
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    expect((await pw.publish(two.built, two.zipSig)).sequence).toBe(2);
    const three = await pw.release('2027.01.0', 3, ['quissel']);
    for (const sequence of [1, 2]) await expect(pw.publish(three.built, three.zipSig, { sequence })).rejects.toMatchObject({ code: 'sequence' });
    expect((await pw.publish(three.built, three.zipSig, { sequence: 7 })).sequence).toBe(7);
    expect((await live()).sequence).toBe(7);
  });

  it('refuses a release built for a higher sequence than the index would have, and one the kit would refuse for it', async () => {
    const high = await pw.release('2026.12.0', 5, ['zorbak']);
    await expect(pw.publish(high.built, high.zipSig)).rejects.toMatchObject({ code: 'sequence' });
    expect(pw.store.attempts).toEqual([]);
  });
});

describe('publishing on top of an existing index', () => {
  it('appends: earlier entries stay byte for byte, latest moves to the new version, mirrors and revocations carry over', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig, { revokedKeyIds: ['old'], revokedReleases: [{ kind: 'terms', version: '2026.01.0', reason: 'bad_release' }] });
    const first = pw.store.json<{ releases: unknown[] }>('v1/index.json').releases[0];
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    await pw.publish(two.built, two.zipSig);
    const raw = pw.store.json<{ releases: Record<string, unknown>[]; latest: Record<string, string>; revokedKeyIds: string[]; revokedReleases: unknown[] }>('v1/index.json');
    expect(raw.releases.map((r) => r.version)).toEqual(['2026.12.0', '2026.12.1']);
    expect(raw.releases[0]).toEqual(first);
    expect(raw.latest).toEqual({ terms: '2026.12.1' });
    expect(raw.revokedKeyIds).toEqual(['old']);
    expect(raw.revokedReleases).toEqual([{ kind: 'terms', version: '2026.01.0', reason: 'bad_release' }]);
    expect(pw.store.order.filter((k) => k.endsWith('.zip'))).toEqual(['v1/terms/2026.12.0/terms-2026.12.0.zip', 'v1/terms/2026.12.1/terms-2026.12.1.zip']);
  });

  it('an older patch does not move `latest`; a newer one does', async () => {
    const hi = await pw.release('2027.01.0', 1, ['zorbak']);
    await pw.publish(hi.built, hi.zipSig);
    const lo = await pw.release('2026.12.3', 2, ['vlemmo']);
    await pw.publish(lo.built, lo.zipSig);
    expect((await live()).latest.terms).toBe('2027.01.0');
    const patch = await pw.release('2027.01.1', 3, ['quissel']);
    await pw.publish(patch.built, patch.zipSig);
    expect((await live()).latest.terms).toBe('2027.01.1');
  });

  it('refuses the same version with other bytes (a version never changes), and does nothing for the same bytes again', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const before = liveBytes();
    const attempts = pw.store.attempts.length;
    const again = await pw.publish(one.built, one.zipSig);
    expect(again).toMatchObject({ published: false, uploaded: [] });
    expect(pw.store.attempts).toHaveLength(attempts);
    const other = await pw.release('2026.12.0', 2, ['vlemmo']);
    await expect(pw.publish(other.built, other.zipSig)).rejects.toMatchObject({ code: 'version_exists' });
    expect(liveBytes()).toEqual(before);
  });

  it('adds a mirror to an existing release by rewriting the index only (a new sequence, no zip upload)', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const attempts = pw.store.attempts.length;
    const mirror = { kind: 'zenodo', doi: '10.5281/zenodo.1234567', url: 'https://zenodo.org/records/1234567/files/terms-2026.12.0.zip?download=1' };
    const out = await pw.publish(one.built, one.zipSig, { mirrors: { 'terms:2026.12.0': [mirror] } });
    expect(out).toMatchObject({ published: true, sequence: 2, uploaded: ['v1/index.json.sig', 'v1/index.json'] });
    expect(pw.store.attempts.slice(attempts).map((a) => a.key)).toEqual(['v1/index.json.sig', 'v1/index.json']);
    expect((await live()).releases[0]?.mirrors).toEqual([mirror]);
    // and the same mirror again changes nothing
    expect(await pw.publish(one.built, one.zipSig, { mirrors: { 'terms:2026.12.0': [mirror] } })).toMatchObject({ published: false });
  });

  it('keeps the entry\u2019s mirrors when a later release is published', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const mirror = { kind: 'zenodo', doi: '10.5281/zenodo.1', url: 'https://zenodo.org/records/1/files/a.zip?download=1' };
    await pw.publish(one.built, one.zipSig, { mirrors: { 'terms:2026.12.0': [mirror] } });
    const two = await pw.release('2026.12.1', 3, ['vlemmo']);
    await pw.publish(two.built, two.zipSig);
    expect((await live()).releases[0]?.mirrors).toEqual([mirror]);
  });
});

describe('what it will not build on, and what it will not upload', () => {
  it('refuses a live index whose signature does not verify with the keys given, or whose signature is missing, and uploads nothing', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    const attempts = pw.store.attempts.length;
    pw.store.files.set('v1/index.json', pw.store.files.get('v1/index.json')!.map((b, i) => (i === 30 ? b ^ 1 : b)));
    await expect(pw.publish(two.built, two.zipSig)).rejects.toMatchObject({ code: 'bad_index' });
    pw.store.files.delete('v1/index.json.sig');
    await expect(pw.publish(two.built, two.zipSig)).rejects.toMatchObject({ code: 'bad_index' });
    expect(pw.store.attempts).toHaveLength(attempts);
  });

  it('refuses when the live index cannot be read at all (it never treats a failed read as "no index")', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    pw.store.failRead.add('v1/index.json');
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    const attempts = pw.store.attempts.length;
    const err = await pw.publish(two.built, two.zipSig).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upload_failed' });
    expect(String((err as Error).message)).not.toMatch(/secret-host/);
    expect(pw.store.attempts).toHaveLength(attempts);
  });

  it('refuses a zip that is not the one the summary describes, one whose signature is wrong or by another key, and one the kit cannot read', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    const flipped = one.built.zip.map((b, i) => (i === 60 ? b ^ 1 : b));
    await expect(pw.publish({ ...one.built, zip: flipped }, one.zipSig)).rejects.toMatchObject({ code: 'bad_input' });
    const other = await makePublishWorld();
    const foreign = await other.release('2026.12.0', 1, ['zorbak']);
    await expect(pw.publish(one.built, foreign.zipSig)).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(pw.publish(one.built, 'not a signature')).rejects.toMatchObject({ code: 'bad_signature' });
    expect(pw.store.attempts).toEqual([]);
  });

  it('a zip signature is not accepted as an index signature (the kind is part of the message)', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await expect(pw.publish(one.built, one.zipSig, { signIndex: () => one.zipSig })).rejects.toMatchObject({ code: 'bad_index' });
    expect(pw.store.attempts).toEqual([]);
  });

  it('no message holds a word, a key or a path', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    pw.store.failAt = new Set([2]);
    const err = (await pw.publish(one.built, one.zipSig).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('an upload failed; the previous index is still live');
    expect(err.message + String(err.stack).split('\n')[0]).not.toMatch(/zorbak|v1\/|secret-host/);
  });
});

describe('r2Store: the same publisher over an R2 binding', () => {
  it('writes through the binding with the headers, reads back, and answers null for a missing key', async () => {
    const r2 = createR2();
    const store = r2Store(r2);
    expect(await store.read('v1/index.json')).toBeNull();
    await store.write('v1/a.zip', new Uint8Array([1, 2, 3]), { contentType: 'application/zip', cacheControl: 'public, max-age=1', contentDisposition: 'attachment; filename="a.zip"' });
    expect(Array.from((await store.read('v1/a.zip')) as Uint8Array)).toEqual([1, 2, 3]);
    expect(r2.writes).toEqual(['v1/a.zip']);
  });
});
