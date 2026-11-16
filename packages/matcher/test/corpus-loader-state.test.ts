import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';
import { startCorpus } from '../src/corpus/node/index.js';
import { BASE, MemoryCache, newTerms, rig, settle } from './corpus-loader-world.js';

// Review A2: the ratchet is persisted as soon as a verified index is accepted; state.json is written one at a time; startCorpus says
// which kit it is.

describe('the ratchet is persisted whenever a verified index is accepted', () => {
  it('a newer index whose release cannot be used (kit_too_old) still raises maxSequence on disk', async () => {
    const r = await rig();
    await r.loader.refresh();
    expect(r.cache.json('state.json').maxSequence).toBe(14);
    await r.w.addRelease('2027.01.0', { sequence: 20, minKit: '9.0.0' });
    r.w.sequence = 20;
    await r.w.publishIndex();
    const res = await r.loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'kit_too_old' });
    expect(r.cache.json('state.json').maxSequence).toBe(20);
    // The release that is loaded is still the old one, and what state.json names is unchanged.
    expect(r.cache.json('state.json').release).toBe('2026.12.0');
    // A restart on a copy of this disk refuses a replay of the old index.
    const replay = await rig();
    replay.cache.files = new Map(r.cache.files);
    const again = await replay.make().refresh();
    expect(again.status.lastError).toMatchObject({ code: 'rollback', stage: 'index' });
  });

  it('with nothing cached yet (first start), a refused choice still leaves the sequence and the revoked key ids on disk', async () => {
    const r = await rig({}, false);
    await r.w.addRelease('2026.12.0', { sequence: 20, minKit: '9.0.0' });
    r.w.sequence = 20;
    r.w.revokedKeyIds = ['k2'];
    await r.w.publishIndex();
    const res = await r.loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'kit_too_old' });
    expect(r.cache.json('state.json')).toMatchObject({ maxSequence: 20, revokedKeyIds: ['k2'], release: null });
  });

  it('a cache that cannot write the release still records the ratchet when state.json itself can be written', async () => {
    const r = await rig();
    r.cache.fail = (op, name) => op === 'write' && name.startsWith('releases/');
    const res = await r.loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'cache_failed' });
    expect(r.cache.json('state.json')).toMatchObject({ maxSequence: 14, release: null });
  });

  it('a failure to write the ratchet is itself harmless: nothing is adopted and the error is the usual one', async () => {
    const r = await rig();
    r.cache.fail = (op, name) => op === 'write' && name === 'state.json';
    const res = await r.loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'cache_failed', stage: 'cache' });
    expect(r.loader.pack()).toBeNull();
  });

  it('an index that does not verify persists nothing', async () => {
    const r = await rig();
    r.w.fault('index.json', { kind: 'flip' });
    await r.loader.refresh();
    expect(r.cache.files.has('state.json')).toBe(false);
  });
});

/** A cache whose state.json writes take a few turns, and which counts how many are running at once. */
class SlowStateCache extends MemoryCache {
  running = 0;
  maxRunning = 0;
  onWrite: (name: string) => void = () => undefined;
  override async write(name: string, bytes: Uint8Array): Promise<void> {
    this.onWrite(name);
    if (name !== 'state.json') return super.write(name, bytes);
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    await settle(3);
    await super.write(name, bytes);
    this.running -= 1;
  }
}

describe('state.json is written one at a time, newest values last', () => {
  it('an apply during a refresh does not interleave two state.json writes, and the file ends with the newest sequence and the applied version', async () => {
    const r = await rig();
    const cache = new SlowStateCache();
    const t = newTerms();
    const loader = r.make({ cache, terms: t.live, apply: 'manual' });
    await loader.refresh();
    expect(cache.maxRunning).toBe(1);
    // A newer release arrives; while the refresh commits it, the owner applies the one already verified.
    await r.w.addRelease('2027.01.0', { sequence: 15 });
    r.w.sequence = 15;
    await r.w.publishIndex();
    cache.onWrite = (name) => {
      if (name === 'index.json') loader.applyTo(t.live);
    };
    const res = await loader.refresh();
    cache.onWrite = () => undefined;
    await settle(30);
    expect(res.status.lastError).toBeNull();
    expect(cache.maxRunning).toBe(1);
    expect(cache.json('state.json')).toMatchObject({ maxSequence: 15, release: '2027.01.0', applied: '2026.12.0' });
  });

  it('two refreshes that overlap share one run, so state.json is never written twice at once', async () => {
    const r = await rig();
    const cache = new SlowStateCache();
    const loader = r.make({ cache });
    await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
    expect(cache.maxRunning).toBe(1);
    expect(cache.json('state.json')).toMatchObject({ maxSequence: 14, release: '2026.12.0' });
  });
});

describe('startCorpus says which kit it is, so minKit is enforced', () => {
  const next = (v: string): string => {
    const [a, b, c] = v.split('.').map(Number) as [number, number, number];
    return `${a}.${b}.${c + 1}`;
  };

  it('a release that needs a newer kit than the matcher is refused (kit_too_old) with no kit option; one for this kit loads; an explicit kit wins', async () => {
    const dirs: string[] = [];
    const dir = (): string => {
      const d = mkdtempSync(join(tmpdir(), 'cw-corpus-kit-'));
      dirs.push(d);
      return d;
    };
    try {
      const needs = await rig({}, false);
      await needs.w.addRelease('2026.12.0', { minKit: next(VERSION) });
      await needs.w.publishIndex();
      const common = { select: { languages: ['en'] }, baseUrl: BASE, follow: 'stable' as const };
      const a = await startCorpus({ ...common, dir: dir(), keys: needs.w.keys(), fetch: needs.w.fetch, schedule: needs.schedule });
      expect(a.status().lastError).toMatchObject({ code: 'kit_too_old' });
      expect(a.pack()).toBeNull();
      a.stop();

      const fits = await rig({}, false);
      await fits.w.addRelease('2026.12.0', { minKit: VERSION });
      await fits.w.publishIndex();
      const b = await startCorpus({ ...common, dir: dir(), keys: fits.w.keys(), fetch: fits.w.fetch, schedule: fits.schedule });
      expect(b.status()).toMatchObject({ state: 'ready', lastError: null });
      b.stop();

      const c = await startCorpus({ ...common, dir: dir(), keys: needs.w.keys(), fetch: needs.w.fetch, kit: next(VERSION), schedule: needs.schedule });
      expect(c.status().lastError).toBeNull();
      c.stop();
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
