import { chooseRelease, parseIndex, verifySignature } from '@chatwarden/matcher/corpus';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshIndex } from '../src/tools/publishing.js';
import { signBytes } from '../src/tools/sign.js';
import { generateSigningKey, loadSigningKey } from '../src/tools/keys.js';
import { DAY_MS } from './world.js';
import { PASS, makePublishWorld, type PublishWorld } from './publish-world.js';

// Revocation and refresh (design 7): the index is re-signed without a release, a revocation is never swallowed by the "already live" shortcut, and a
// failed put-back is reported as failed.

let pw: PublishWorld;
beforeEach(async () => {
  pw = await makePublishWorld();
});
interface RawLive {
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  revokedKeyIds: string[];
  revokedReleases: unknown[];
  releases: unknown[];
  latest: Record<string, string>;
}
const rawLive = (): RawLive => pw.store.json<RawLive>('v1/index.json');
const refresh = (over: Partial<Parameters<typeof refreshIndex>[0]> = {}): ReturnType<typeof refreshIndex> =>
  refreshIndex({ store: pw.store, clock: pw.bw.clock, signIndex: (b) => signBytes('index', b, pw.key.key, 'k1'), keyId: 'k1', keys: pw.keys, ...over });

describe('re-publishing a live release with a revocation', () => {
  it('is not skipped: the revocation is signed in with the next sequence, the files are not uploaded again', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const attempts = pw.store.attempts.length;
    const out = await pw.publish(one.built, one.zipSig, { revokedKeyIds: ['k0'], revokedReleases: [{ kind: 'terms', version: '2026.01.0', reason: 'bad_release' }] });
    expect(out).toMatchObject({ published: true, sequence: 2, uploaded: ['v1/index.json.sig', 'v1/index.json'] });
    expect(pw.store.attempts.slice(attempts).map((a) => a.key)).toEqual(['v1/index.json.sig', 'v1/index.json']);
    expect(rawLive()).toMatchObject({ revokedKeyIds: ['k0'], revokedReleases: [{ kind: 'terms', version: '2026.01.0', reason: 'bad_release' }] });
  });

  it('the same revocation again changes nothing; a new one does', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    const rev = { revokedKeyIds: ['k0'], revokedReleases: [{ kind: 'terms' as const, version: '2026.01.0', reason: 'legal' as const }] };
    await pw.publish(one.built, one.zipSig, rev);
    expect(await pw.publish(one.built, one.zipSig, rev)).toMatchObject({ published: false });
    expect(await pw.publish(one.built, one.zipSig, { revokedKeyIds: ['k9'] })).toMatchObject({ published: true, sequence: 2 });
    expect(rawLive().revokedKeyIds).toEqual(['k0', 'k9']);
    // already revoked: the first reason stays and nothing is signed
    expect(await pw.publish(one.built, one.zipSig, { revokedReleases: [{ kind: 'terms', version: '2026.01.0', reason: 'bad_release' }] })).toMatchObject({ published: false });
    expect(await pw.publish(one.built, one.zipSig, { revokedReleases: [{ kind: 'terms', version: '2026.02.0', reason: 'bad_release' }] })).toMatchObject({ published: true });
  });

  it('a revoked live release is refused by the kit afterwards (chooseRelease)', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    await pw.publish(one.built, one.zipSig, { revokedReleases: [{ kind: 'terms', version: '2026.12.0', reason: 'bad_release' }] });
    const index = parseIndex(pw.store.files.get('v1/index.json') as Uint8Array, pw.bw.clock.now());
    expect(() => chooseRelease(index, { kind: 'terms', kit: '0.1.11', follow: 'stable' })).toThrow(expect.objectContaining({ code: 'revoked_release' }));
  });

  it('refresh: true re-signs an otherwise unchanged index', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    pw.bw.clock.advance(60 * DAY_MS);
    const out = await pw.publish(one.built, one.zipSig, { refresh: true });
    expect(out).toMatchObject({ published: true, sequence: 2 });
    expect(Date.parse(rawLive().expiresAt) - pw.bw.clock.now()).toBe(90 * DAY_MS);
  });
});

describe('refreshIndex (no release file)', () => {
  it('bumps the sequence and moves the expiry 90 days from now; releases and latest stay as they were', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const before = rawLive();
    const beforeBytes = pw.store.files.get('v1/index.json') as Uint8Array;
    pw.bw.clock.advance(80 * DAY_MS);
    const out = await refresh();
    expect(out).toMatchObject({ published: true, sequence: 2, uploaded: ['v1/index.json.sig', 'v1/index.json'] });
    const after = rawLive();
    expect(after.sequence).toBe(2);
    expect(after.releases).toEqual(before.releases);
    expect(after.latest).toEqual(before.latest);
    expect(Date.parse(after.expiresAt) - pw.bw.clock.now()).toBe(90 * DAY_MS);
    // 20 days later the first index has expired, the refreshed one has not
    pw.bw.clock.advance(20 * DAY_MS);
    expect(() => parseIndex(pw.store.files.get('v1/index.json') as Uint8Array, pw.bw.clock.now())).not.toThrow();
    expect(() => parseIndex(beforeBytes, pw.bw.clock.now())).toThrow();
  });

  it('adds revocations (kept, never dropped) and does not duplicate', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig, { revokedKeyIds: ['k0'] });
    await refresh({ revokedKeyIds: ['k0', 'k5'], revokedReleases: [{ kind: 'terms', version: '2026.01.0', reason: 'legal' }, { kind: 'terms', version: '2026.01.0', reason: 'legal' }] });
    expect(rawLive()).toMatchObject({ sequence: 2, revokedKeyIds: ['k0', 'k5'], revokedReleases: [{ kind: 'terms', version: '2026.01.0', reason: 'legal' }] });
    expect(rawLive().revokedReleases).toHaveLength(1);
    await refresh();
    expect(rawLive()).toMatchObject({ sequence: 3, revokedKeyIds: ['k0', 'k5'] });
  });

  it('refuses when there is no index, a lower sequence, or an index that does not verify; a dry run uploads nothing', async () => {
    await expect(refresh()).rejects.toMatchObject({ code: 'bad_index' });
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    await expect(refresh({ sequence: 1 })).rejects.toMatchObject({ code: 'sequence' });
    const attempts = pw.store.attempts.length;
    const dry = await refresh({ dryRun: true });
    expect(dry).toMatchObject({ published: true, sequence: 2, uploaded: [] });
    expect(pw.store.attempts).toHaveLength(attempts);
    await expect(refresh({ keys: [{ id: 'k1', publicKey: generateSigningKey('x', PASS).publicKey }] })).rejects.toMatchObject({ code: 'bad_index' });
  });

  it('a failed upload leaves the previous pair live', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const before = pw.store.text('v1/index.json');
    pw.store.failAt = new Set([pw.store.attempts.length + 2]);
    await expect(refresh()).rejects.toMatchObject({ code: 'upload_failed' });
    expect(pw.store.text('v1/index.json')).toBe(before);
  });
});

describe('a compromised key (design 7)', () => {
  it('the standby key signs an index that revokes the first key; it verifies with both keys trusted, and the first key no longer signs for the kit', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const g2 = generateSigningKey('k2', PASS);
    const k2 = loadSigningKey(g2.pem, PASS);
    const both = [...pw.keys, { id: 'k2', publicKey: k2.publicKey }];
    await refresh({ keyId: 'k2', keys: both, signIndex: (b) => signBytes('index', b, k2.key, 'k2'), revokedKeyIds: ['k1'], revokedReleases: [{ kind: 'terms', version: '2026.12.0', reason: 'key_compromise' }] });
    const bytes = pw.store.files.get('v1/index.json') as Uint8Array;
    const sig = pw.store.files.get('v1/index.json.sig') as Uint8Array;
    const index = parseIndex(bytes, pw.bw.clock.now());
    expect(index.keyId).toBe('k2');
    expect(index.revokedKeyIds).toEqual(['k1']);
    await verifySignature('index', bytes, sig, both, { revokedKeyIds: ['k1'] });
    // a signature by the revoked key is refused once the index says so
    const forged = signBytes('index', bytes, pw.key.key, 'k1');
    await expect(verifySignature('index', bytes, forged, both, { revokedKeyIds: ['k1'] })).rejects.toBeDefined();
  });
});

describe('a failed put-back is reported as failed', () => {
  it('says the previous pair was put back when it was, and could NOT be when the restore writes fail too', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    await pw.publish(one.built, one.zipSig);
    const two = await pw.release('2026.12.1', 2, ['vlemmo']);
    // a second publish writes: zip (1), zip.sig (2), index.json.sig (3), index.json (4); then the restore writes the signature (5) and the index (6)
    const base = pw.store.attempts.length;
    pw.store.failAt = new Set([base + 4]);
    const ok = await pw.publish(two.built, two.zipSig).catch((e: unknown) => e as Error);
    expect(ok).toMatchObject({ code: 'upload_failed' });
    expect(String((ok as Error).message)).toContain('were put back');
    expect(String((ok as Error).message)).not.toContain('NOT');

    const good = { index: pw.store.files.get('v1/index.json') as Uint8Array, sig: pw.store.files.get('v1/index.json.sig') as Uint8Array };
    const base2 = pw.store.attempts.length;
    pw.store.failAt = new Set([base2 + 4, base2 + 5]);
    const bad = await pw.publish(two.built, two.zipSig).catch((e: unknown) => e as Error);
    expect(bad).toMatchObject({ code: 'upload_failed' });
    expect(String((bad as Error).message)).toContain('could NOT be put back');
    expect(String((bad as Error).message)).not.toContain('were put back');
    expect(String((bad as Error).message)).not.toMatch(/secret-host/);

    // the failed restore left the new signature beside the old index: the owner puts the pair back by hand
    pw.store.files.set('v1/index.json', good.index);
    pw.store.files.set('v1/index.json.sig', good.sig);
    const base3 = pw.store.attempts.length;
    pw.store.failAt = new Set([base3 + 4, base3 + 6]); // the signature goes back, the index does not
    const half = await pw.publish(two.built, two.zipSig).catch((e: unknown) => e as Error);
    expect(String((half as Error).message)).toContain('could NOT be put back');
  });

  it('the first release (nothing to put back) fails without a claim that a put-back failed', async () => {
    const one = await pw.release('2026.12.0', 1, ['zorbak']);
    pw.store.failAt = new Set([5]); // robots, zip, zip.sig, index.json.sig, index.json
    const err = await pw.publish(one.built, one.zipSig).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'upload_failed' });
    expect(String((err as Error).message)).not.toContain('NOT');
  });
});
