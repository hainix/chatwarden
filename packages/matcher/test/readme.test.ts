import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LiveTerms, loadTermPack } from '../src/index.js';
import { createCommunityShare, createCorpusLoader, type CorpusCache } from '../src/corpus/index.js';
import { MemoryTermStore, syntheticTermPack } from '../src/fixtures/index.js';

// The README's loader, syncPack and share blocks, run against fakes: no network, no disk, no key. The compile check of every ```ts block
// is in scripts/readme.test.ts; this file proves the calls the README shows do what it says.

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const corpusSection = readme.slice(readme.indexOf('## The community term corpus'), readme.indexOf('## Options'));
const blocks = [...corpusSection.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
const clock = { now: () => 1_800_000_000_000 };
const memoryCache = (): CorpusCache => {
  const files = new Map<string, Uint8Array>();
  return {
    read: async (name) => files.get(name) ?? null,
    write: async (name, bytes) => void files.set(name, bytes),
    remove: async (name) => void files.delete(name),
  };
};

describe('the matcher README blocks for the shared term list', () => {
  it('the readme code blocks for the loader, syncPack and the share client compile and run against fakes', async () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const text = blocks.join('\n');
    for (const call of ['startCorpus(', 'applyTo(', 'status()', 'createCommunityShare(', 'installationKey(', 'share.share(', 'share.report(']) expect(text, call).toContain(call);

    // The loader: no trusted keys, so it says so by a code and the live list is untouched.
    const terms = new LiveTerms({ store: new MemoryTermStore(), pack: loadTermPack(syntheticTermPack()), clock });
    await terms.load();
    const before = JSON.stringify(terms.rows);
    const loader = createCorpusLoader({ select: { languages: ['en'] }, pin: '2026.12.0', cache: memoryCache(), clock, keys: [], terms, logger: { warn: () => undefined } });
    expect(loader.status().state).toBe('none');
    const res = await loader.refresh();
    expect(res.status).toMatchObject({ state: 'failed', applied: null, pending: null, lastError: { code: 'no_trusted_keys' } });
    expect(loader.applyTo(terms)).toBeNull();
    expect(JSON.stringify(terms.rows)).toBe(before);

    // syncPack on the invented pack: a dry run reports and changes nothing, a second run of the same pack is all zeros.
    const dry = terms.syncPack(loadTermPack(syntheticTermPack()), { actor: 'corpus:2026.12.0', dryRun: true });
    expect(dry).toMatchObject({ ok: true });
    expect(JSON.stringify(terms.rows)).toBe(before);

    // The share client: a closed result, never a throw, and a report is a term id and a kind.
    const sent: Array<{ url: string; body: string }> = [];
    const share = createCommunityShare({
      sign: async () => 'c2ln',
      publicKey: 'A'.repeat(43),
      clock,
      stampBits: 0,
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: new TextDecoder().decode(init?.body as Uint8Array) });
        return new Response(JSON.stringify({ id: 'sub_1', status: 'received' }), { status: 202 });
      },
    });
    expect(await share.share({ term: 'zorbak', language: 'en', category: 'abuse' })).toEqual({ ok: true, status: 'received', id: 'sub_1' });
    expect(sent[0]?.url).toBe('https://corpus.chatwarden.dev/v1/submissions');
    expect(await share.report({ termId: 'CWT-2026-00001', kind: 'innocent_sense' })).toEqual({ ok: true, id: 'sub_1' });
    expect(sent[1]?.url).toBe('https://corpus.chatwarden.dev/v1/reports');
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({ schema: 'chatwarden-corpus-report/1', termId: 'CWT-2026-00001', kind: 'innocent_sense', day: '2027-01-15', kit: '0.0.0' });
  });

  it('with no keys nothing is applied and nothing throws, whatever the folder holds', async () => {
    const terms = new LiveTerms({ store: new MemoryTermStore(), pack: loadTermPack(syntheticTermPack()), clock });
    await terms.load();
    const cache = memoryCache();
    await cache.write('state.json', new TextEncoder().encode('{"applied":"2026.12.0","release":"2026.12.0"}'));
    const loader = createCorpusLoader({ select: { languages: ['en'] }, follow: 'stable', cache, clock, keys: [], terms, logger: { warn: () => undefined } });
    const res = await loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'no_trusted_keys' });
    expect(loader.pack()).toBeNull();
  });

  it('the README never shows a term that is not invented', () => {
    const quoted = [...corpusSection.matchAll(/\b(?:term|phrase): '([^']*)'/g)].map((m) => m[1] as string);
    expect(quoted.length).toBeGreaterThan(0);
    for (const t of quoted) expect(['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn']).toContain(t);
  });
});
