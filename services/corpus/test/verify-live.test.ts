import { CORPUS_BASE_URL, createCorpusLoader, type CorpusCache } from '@chatwarden/matcher/corpus';
import { LiveTerms, VERSION as KIT } from '@chatwarden/matcher';
import { MemoryTermStore } from '@chatwarden/matcher/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { main as verifyLiveMain, verifyLive } from '../src/tools/verifyLive.js';
import { makePublishWorld, type MemoryStore, type PublishWorld } from './publish-world.js';
import { makeToolWorld } from './tool-world.js';

// The release the owner publishes, read from the public URLs by the kit's own loader. The "network" is the memory bucket behind a fake fetch.

const BASE = 'https://releases.example.test/v1';
let pw: PublishWorld;
beforeEach(async () => {
  pw = await makePublishWorld();
});

/** A fetch that serves the bucket's `v1/` files at BASE, with an optional change to what is served. */
const fetchOf = (store: MemoryStore, tweak: (path: string, bytes: Uint8Array) => Uint8Array = (_p, b) => b): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (!url.startsWith(`${BASE}/`)) return new Response('no', { status: 404 });
    const path = url.slice(BASE.length + 1);
    const bytes = store.files.get(`v1/${path}`);
    return bytes === undefined ? new Response('not found', { status: 404 }) : new Response(tweak(path, bytes).slice(), { status: 200 });
  }) as typeof fetch;

async function publishOne(): Promise<void> {
  const one = await pw.release('2026.12.0', 1, ['zorbak', 'vlemmo', 'quissel']);
  await pw.publish(one.built, one.zipSig);
}
const clockNow = () => pw.bw.clock;

describe('the owner\u2019s release, loaded by the kit: build, sign, publish, then the loader verifies, selects and syncs it into a LiveTerms', () => {
  it('a release built, signed and published by the service is verified by the real loader, selected, and synced into a LiveTerms', async () => {
    await publishOne();
    const files = new Map<string, Uint8Array>();
    const cache: CorpusCache = {
      read: async (name) => files.get(name) ?? null,
      write: async (name, bytes) => void files.set(name, bytes.slice()),
      remove: async (name) => void files.delete(name),
    };
    const store = new MemoryTermStore();
    const live = new LiveTerms({ store, pack: null, clock: clockNow(), logger: { warn: () => undefined } });
    const loader = createCorpusLoader({ select: { languages: ['en'], minSeverity: 'rude' }, cache, clock: clockNow(), baseUrl: BASE, keys: pw.keys, fetch: fetchOf(pw.store), pin: '2026.12.0', kit: KIT });
    const result = await loader.refresh();
    expect(result.status).toMatchObject({ state: 'ready', available: '2026.12.0', lastError: null });
    const applied = loader.applyTo(live);
    expect(applied).toMatchObject({ ok: true });
    const terms = store.listTerms().map((t) => t.term).sort();
    expect(terms).toEqual(['quissel', 'vlemmo', 'zorbak']);
    expect(store.listTerms().every((t) => t.active)).toBe(true);
    expect(live.check('zorbak', 'en', ['a line']).ok).toBe(true);
  });

  it('with the wrong key, a flipped byte or no keys the loader refuses it (the service\u2019s output is only as trusted as its signature)', async () => {
    await publishOne();
    const mk = (keys: typeof pw.keys, fetch: typeof globalThis.fetch) =>
      createCorpusLoader({ select: { languages: ['en'] }, cache: { read: async () => null, write: async () => undefined, remove: async () => undefined }, clock: clockNow(), baseUrl: BASE, keys, fetch, follow: 'stable' });
    const other = await makePublishWorld();
    expect((await mk(other.keys, fetchOf(pw.store)).refresh()).status.lastError?.code).toBeDefined();
    expect((await mk([], fetchOf(pw.store)).refresh()).status.lastError?.code).toBe('no_trusted_keys');
    const flipped = fetchOf(pw.store, (p, b) => (p.endsWith('.zip') ? b.map((x, i) => (i === 70 ? x ^ 1 : x)) : b));
    const r = await mk(pw.keys, flipped).refresh();
    expect(r.status.state).not.toBe('ready');
  });
});

describe('verify-live passes against the fake and fails on a flipped byte', () => {
  const run = (over: Partial<Parameters<typeof verifyLive>[0]> = {}) => verifyLive({ fetch: fetchOf(pw.store), baseUrl: BASE, keys: pw.keys, clock: clockNow(), ...over });

  it('passes for a published release and says which version of which kind it checked', async () => {
    await publishOne();
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([{ kind: 'terms', version: '2026.12.0', ok: true, detail: '3 terms in en, es, pt' }]);
  });

  it('fails on a flipped byte in the zip, in the zip signature, in the index and in the index signature', async () => {
    await publishOne();
    for (const target of ['terms/2026.12.0/terms-2026.12.0.zip', 'terms/2026.12.0/terms-2026.12.0.zip.sig', 'index.json', 'index.json.sig']) {
      const r = await run({ fetch: fetchOf(pw.store, (p, b) => (p === target ? b.map((x, i) => (i === Math.floor(b.length / 2) ? x ^ 1 : x)) : b)) });
      expect(r.ok, target).toBe(false);
    }
  });

  it('fails with no keys, with another key, with no index, and with an index that has expired', async () => {
    await publishOne();
    expect((await run({ keys: [] })).ok).toBe(false);
    expect((await run({ keys: (await makePublishWorld()).keys })).ok).toBe(false);
    expect((await run({ fetch: fetchOf(new (pw.store.constructor as new () => MemoryStore)()) })).ok).toBe(false);
    pw.bw.clock.advance(100 * 24 * 60 * 60 * 1000);
    expect((await run()).ok).toBe(false);
  });

  it('a result holds codes and counts, never a word or a url', async () => {
    await publishOne();
    const bad = await run({ fetch: fetchOf(pw.store, (p, b) => (p.endsWith('.zip') ? b.slice(0, 40) : b)) });
    expect(JSON.stringify(bad)).not.toMatch(/zorbak|vlemmo|quissel|example\.test/);
  });
});

describe('verify-live (the tool)', () => {
  it('prints one line a release, exits 0 when everything verifies and 1 when something does not', async () => {
    await publishOne();
    const key = pw.keys[0]!;
    const tw = makeToolWorld({ fetch: fetchOf(pw.store) });
    expect(await verifyLiveMain(['--base', BASE, '--key', `${key.id}=${key.publicKey}`], tw.io)).toBe(0);
    expect(tw.out.join('\n')).toContain('terms 2026.12.0: verified');
    const bad = makeToolWorld({ fetch: fetchOf(pw.store, (p, b) => (p === 'index.json' ? b.slice(0, 10) : b)) });
    expect(await verifyLiveMain(['--base', BASE, '--key', `${key.id}=${key.publicKey}`], bad.io)).toBe(1);
    expect(bad.err.join('\n') + bad.out.join('\n')).toMatch(/FAILED/);
    for (const w of [tw, bad]) w.cleanup();
  });

  it('refuses a key that is not id=base64url, and with no --key it uses the kit\u2019s own keys (none yet: it says so)', async () => {
    const tw = makeToolWorld();
    expect(await verifyLiveMain(['--key', 'garbage'], tw.io)).toBe(1);
    expect(await verifyLiveMain([], tw.io)).toBe(1);
    expect(tw.err.join('\n')).toContain('no_trusted_keys');
    expect(CORPUS_BASE_URL).toBe('https://releases.chatwarden.dev/v1');
    tw.cleanup();
  });
});
