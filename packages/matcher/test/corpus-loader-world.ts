// Test helper for the loader tests: a fake release server (an index, signature files and zips behind a fake `fetch` with a switch for
// every fault), an in-memory cache that can fail mid-write or be tampered with, a fake clock and a fake timer. Generated keys and
// invented words only; nothing here touches a network, a disk or Date.now.
import { exampleIndex, exampleTerms, exampleExceptions, releaseZip, sha256HexNode, sigFileBytes, sigFileFor, termRow, indexBytes, makeKey, type Json, type ReleaseParts, type TestKey } from './corpus-world.js';
import { createCorpusLoader, type CorpusCache, type CorpusLoader, type CorpusLoaderOptions, type Schedule } from '../src/corpus/loader.js';
import { LiveTerms } from '../src/index.js';
import { MemoryTermStore } from '../src/fixtures/index.js';
import { vi } from 'vitest';

export const BASE = 'https://releases.example.test/v1';
export const T0 = Date.UTC(2026, 11, 2); // 2026-12-02, inside the example index's validity window (issued 2026-12-01)

export interface FakeClock {
  t: number;
  now(): number;
}
export const fakeClock = (t = T0): FakeClock => ({ t, now() { return this.t; } });

/** A fake timer: `after` records, `advance` fires what is due, in order. */
export class FakeSchedule implements Schedule {
  now = 0;
  timers: { id: number; at: number; ms: number; fn: () => void }[] = [];
  private nextId = 1;
  after(ms: number, fn: () => void): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + ms, ms, fn });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }
  /** The delays of the timers that are still waiting. */
  get delays(): number[] {
    return this.timers.map((t) => t.ms);
  }
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) return;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      due.fn();
    }
  }
}

/** Lets pending promise callbacks run (a few turns), so a test can act while a refresh is waiting on something. */
export const settle = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

export type CacheOp = 'read' | 'write' | 'remove';
/** An in-memory CorpusCache that counts, can fail any operation, and can be tampered with. */
export class MemoryCache implements CorpusCache {
  files = new Map<string, Uint8Array>();
  log: string[] = [];
  /** Throw for the operations this returns true for (the Nth write, a name, ...). */
  fail: (op: CacheOp, name: string, nth: number) => boolean = () => false;
  private counts = { read: 0, write: 0, remove: 0 };
  async read(name: string): Promise<Uint8Array | null> {
    this.log.push(`read ${name}`);
    if (this.fail('read', name, (this.counts.read += 1))) throw new Error('disk read failed: secret-path');
    const f = this.files.get(name);
    return f === undefined ? null : f.slice();
  }
  async write(name: string, bytes: Uint8Array): Promise<void> {
    this.log.push(`write ${name}`);
    if (this.fail('write', name, (this.counts.write += 1))) throw new Error('disk write failed: secret-path');
    this.files.set(name, bytes.slice());
  }
  async remove(name: string): Promise<void> {
    this.log.push(`remove ${name}`);
    if (this.fail('remove', name, (this.counts.remove += 1))) throw new Error('disk remove failed');
    this.files.delete(name);
  }
  writes(): string[] {
    return this.log.filter((l) => l.startsWith('write ')).map((l) => l.slice(6));
  }
  text(name: string): string {
    return new TextDecoder().decode(this.files.get(name));
  }
  json(name: string): Json {
    return JSON.parse(this.text(name)) as Json;
  }
}

export type Fault =
  | { kind: 'throw' }
  | { kind: 'status'; status: number }
  | { kind: 'hang' }
  | { kind: 'hang-until-abort' }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'flip' }
  | { kind: 'truncate' }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'fn'; fn: (bytes: Uint8Array) => Uint8Array };

export interface Call {
  url: string;
  method: string;
  ifNoneMatch: string | null;
}

interface ReleaseSpec {
  sequence?: number;
  parts?: ReleaseParts;
  /** Signs the zip with this key (default: the world's active key `k1`). */
  key?: TestKey;
  minKit?: string;
  mirrors?: Json[];
  /** Use these bytes as the zip (junk, a hostile archive) instead of building one; still hashed and signed. */
  zipBytes?: Uint8Array;
  /** Entry fields replaced after the hash and size were taken. */
  entry?: Json;
}

/** The release server and everything a loader needs to talk to it. */
export class World {
  k1!: TestKey;
  k2!: TestKey;
  /** Path (below BASE) to bytes. */
  files = new Map<string, Uint8Array>();
  /** Where mirrors serve the same paths from: full URL to bytes. */
  mirrorFiles = new Map<string, Uint8Array>();
  /** Fault by URL: the first entry whose key the URL ends with, or equals, applies. */
  faults = new Map<string, Fault>();
  calls: Call[] = [];
  releases: Json[] = [];
  revokedReleases: Json[] = [];
  revokedKeyIds: string[] = [];
  latest: string | null = null;
  sequence = 14;
  indexKey: TestKey | undefined;
  /** Set to false to stop sending an ETag (and so to stop 304s). */
  etags = true;

  static async create(): Promise<World> {
    const w = new World();
    w.k1 = await makeKey('k1');
    w.k2 = await makeKey('k2');
    w.indexKey = w.k1;
    return w;
  }

  keys() {
    return [{ id: this.k1.id, publicKey: this.k1.publicKey }, { id: this.k2.id, publicKey: this.k2.publicKey }];
  }

  /** A terms release with `n` extra invented words, so two versions differ. */
  static termsWith(extra: string[] = []): Json[] {
    return [...exampleTerms(), ...extra.map((term, i) => termRow({ id: `CWT-2026-${String(100 + i).padStart(5, '0')}`, term, positive: [`you ${term}`], negative: [`${term}ian`] }))];
  }

  /** Builds, signs and stores a release and adds it to the index (call `publishIndex` after). Returns its zip bytes. */
  async addRelease(version: string, spec: ReleaseSpec = {}): Promise<Uint8Array> {
    const sequence = spec.sequence ?? this.sequence;
    const zip = spec.zipBytes ?? releaseZip({ ...spec.parts, manifest: { version, sequence, ...spec.parts?.manifest } });
    const key = spec.key ?? this.k1;
    const sig = sigFileBytes(await sigFileFor(key, 'zip', zip));
    const zipPath = `terms/${version}/terms-${version}.zip`;
    this.files.set(zipPath, zip);
    this.files.set(`${zipPath}.sig`, sig);
    const base = (exampleIndex().releases as Json[])[1] as Json;
    this.releases = this.releases.filter((r) => !(r.kind === 'terms' && r.version === version));
    this.releases.push({
      ...base,
      version,
      minKit: spec.minKit ?? '0.1.7',
      bytes: zip.length,
      sha256: sha256HexNode(zip),
      zip: zipPath,
      sig: `${zipPath}.sig`,
      mirrors: spec.mirrors ?? [],
      ...spec.entry,
    });
    this.latest = version;
    return zip;
  }

  /** Builds, signs (by `key`, default the world's index key) and stores the index. */
  async publishIndex(over: Json = {}, key: TestKey | undefined = this.indexKey): Promise<{ bytes: Uint8Array; sig: Uint8Array }> {
    const signer = key ?? this.k1;
    const index = exampleIndex({
      sequence: this.sequence,
      keyId: signer.id,
      revokedKeyIds: this.revokedKeyIds,
      revokedReleases: this.revokedReleases,
      latest: this.latest === null ? {} : { terms: this.latest },
      releases: this.releases,
      ...over,
    });
    const bytes = indexBytes(index);
    const sig = sigFileBytes(await sigFileFor(signer, 'index', bytes));
    this.files.set('index.json', bytes);
    this.files.set('index.json.sig', sig);
    return { bytes, sig };
  }

  url(path: string): string {
    return `${BASE}/${path}`;
  }

  fault(path: string, fault: Fault | null): void {
    const key = path.startsWith('https://') ? path : this.url(path);
    if (fault === null) this.faults.delete(key);
    else this.faults.set(key, fault);
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.url === this.url(path));
  }

  /** The fake `fetch`. */
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    this.calls.push({ url, method: init?.method ?? 'GET', ifNoneMatch: headers.get('if-none-match') });
    const fault = this.faults.get(url);
    if (fault?.kind === 'throw') throw new TypeError('fetch failed: secret-host.example');
    if (fault?.kind === 'hang') return new Promise<Response>(() => {});
    if (fault?.kind === 'hang-until-abort') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (fault?.kind === 'status') return new Response('server says no', { status: fault.status });
    let bytes: Uint8Array | undefined;
    if (url.startsWith(`${BASE}/`)) bytes = this.files.get(url.slice(BASE.length + 1));
    else bytes = this.mirrorFiles.get(url);
    if (bytes === undefined) return new Response('not found', { status: 404 });
    if (fault?.kind === 'bytes') bytes = fault.bytes;
    if (fault?.kind === 'flip') {
      bytes = bytes.slice();
      bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 0x01;
    }
    if (fault?.kind === 'truncate') bytes = bytes.slice(0, Math.floor(bytes.length / 2));
    if (fault?.kind === 'fn') bytes = fault.fn(bytes);
    if (fault?.kind === 'oversize') {
      return new Response(new Uint8Array(Math.min(fault.bytes, 64 * 1024 * 1024)), { status: 200, headers: { 'content-length': String(fault.bytes) } });
    }
    const out: Record<string, string> = {};
    if (url === this.url('index.json') && this.etags) {
      const tag = `"${sha256HexNode(bytes).slice(0, 16)}"`;
      out.etag = tag;
      if (headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers: out });
    }
    return new Response(bytes.slice(), { status: 200, headers: out });
  };
}

export { exampleExceptions, exampleTerms };

export interface Rig {
  w: World;
  cache: MemoryCache;
  clock: FakeClock;
  schedule: FakeSchedule;
  warn: ReturnType<typeof vi.fn>;
  loader: CorpusLoader;
  make(over?: Partial<CorpusLoaderOptions> & Record<string, unknown>): CorpusLoader;
}

/** A world with 2026.12.0 published (sequence 14), a cache, a clock, a timer and a loader that follows stable. */
export async function rig(over: Partial<CorpusLoaderOptions> & Record<string, unknown> = {}, publish = true): Promise<Rig> {
  const w = await World.create();
  if (publish) {
    await w.addRelease('2026.12.0');
    await w.publishIndex();
  }
  const cache = new MemoryCache();
  const clock = fakeClock();
  const schedule = new FakeSchedule();
  const warn = vi.fn();
  const make = (extra: Partial<CorpusLoaderOptions> & Record<string, unknown> = {}): CorpusLoader =>
    createCorpusLoader({
      select: { languages: ['en'] },
      cache,
      clock,
      baseUrl: BASE,
      keys: w.keys(),
      fetch: w.fetch,
      follow: 'stable',
      kit: '0.1.11',
      logger: { warn },
      schedule,
      ...over,
      ...extra,
    } as CorpusLoaderOptions);
  return { w, cache, clock, schedule, warn, loader: make(), make };
}

export const newTerms = (): { store: MemoryTermStore; live: LiveTerms } => {
  const store = new MemoryTermStore();
  return { store, live: new LiveTerms({ store, pack: null, clock: { now: () => T0 }, logger: { warn: () => {} } }) };
};

