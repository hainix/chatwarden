import type { CorpusKey } from '@chatwarden/matcher/corpus';
import { buildTermsRelease, type BuildResult } from '../src/build/release.js';
import { generateSigningKey, loadSigningKey, type LoadedKey } from '../src/tools/keys.js';
import { publishRelease, type PublishInput, type PublishResult, type PutMeta, type ReleaseStore } from '../src/tools/publishing.js';
import { signBytes } from '../src/tools/sign.js';
import { makeBuildWorld, type BuildWorld } from './build-world.js';

// The publisher's world: a memory bucket that records every write in order (with the headers it was given) and can fail or corrupt a write, a
// signing key generated here, and releases built by the real builder from invented words.

export const PASS = 'a passphrase made up for the tests 99';

export class MemoryStore implements ReleaseStore {
  files = new Map<string, Uint8Array>();
  /** Every successful and failed write attempt, in order. */
  attempts: { key: string; meta: PutMeta; ok: boolean }[] = [];
  /** Make the Nth write attempt (1 based) fail. */
  failAt = new Set<number>();
  /** Store other bytes than were written, once, for a key (a corrupt upload). */
  corrupt = new Map<string, (bytes: Uint8Array) => Uint8Array>();
  /** Fail reads of a key. */
  failRead = new Set<string>();

  read(key: string): Promise<Uint8Array | null> {
    if (this.failRead.has(key)) return Promise.reject(new Error('read failed: secret-host.example'));
    const bytes = this.files.get(key);
    return Promise.resolve(bytes === undefined ? null : bytes.slice());
  }
  write(key: string, bytes: Uint8Array, meta: PutMeta): Promise<void> {
    const n = this.attempts.length + 1;
    if (this.failAt.has(n)) {
      this.attempts.push({ key, meta, ok: false });
      return Promise.reject(new Error('write failed: secret-host.example'));
    }
    this.attempts.push({ key, meta, ok: true });
    const bad = this.corrupt.get(key);
    this.corrupt.delete(key); // a corruption happens once; the put-back of the old file is not corrupted again
    this.files.set(key, bad?.(bytes) ?? bytes.slice());
    return Promise.resolve();
  }
  /** The keys written successfully, in order. */
  get order(): string[] {
    return this.attempts.filter((a) => a.ok).map((a) => a.key);
  }
  text(key: string): string {
    return new TextDecoder().decode(this.files.get(key));
  }
  json<T = Record<string, unknown>>(key: string): T {
    return JSON.parse(this.text(key)) as T;
  }
}

export interface PublishWorld {
  bw: BuildWorld;
  store: MemoryStore;
  key: LoadedKey;
  keyId: string;
  keys: CorpusKey[];
  /** Builds a release of `n` invented words (more than the last, so two versions differ), signs its zip, and returns both. */
  release(version: string, sequence: number, words?: string[]): Promise<{ built: BuildResult; zipSig: string }>;
  publish(built: BuildResult, zipSig: string, over?: Partial<PublishInput>): Promise<PublishResult>;
}

export async function makePublishWorld(): Promise<PublishWorld> {
  const bw = await makeBuildWorld();
  const store = new MemoryStore();
  const generated = generateSigningKey('k1', PASS);
  const key = loadSigningKey(generated.pem, PASS);
  const keys: CorpusKey[] = [{ id: 'k1', publicKey: key.publicKey }];
  let nextId = 1;
  return {
    bw,
    store,
    key,
    keyId: 'k1',
    keys,
    async release(version, sequence, words = []) {
      for (const term of words) {
        await bw.term({ id: `CWT-2026-${String(nextId).padStart(5, '0')}`, term, since: null });
        nextId += 1;
      }
      const built = await buildTermsRelease(bw.db, { clock: bw.clock, version, sequence, previous: null, allowBulk: true });
      return { built, zipSig: signBytes('zip', built.zip, key.key, 'k1') };
    },
    publish(built, zipSig, over = {}) {
      return publishRelease({
        store,
        clock: bw.clock,
        summary: built.summary,
        zip: built.zip,
        zipSig,
        signIndex: (bytes) => signBytes('index', bytes, key.key, 'k1'),
        keyId: 'k1',
        keys,
        ...over,
      });
    },
  };
}
