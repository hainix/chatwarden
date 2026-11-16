import type { R2BodyLike, R2Like } from '../src/env.js';

// A Map-backed R2 bucket for tests. It records every write in order (the release tools must upload the index last), and a test can make the
// Nth put fail.

export interface TestR2 extends R2Like {
  /** The keys written, in order, one entry per put. */
  readonly writes: string[];
  /** The stored bytes of a key, or undefined. */
  bytes(key: string): Uint8Array | undefined;
  /** Makes the put number `n` (counting from 1) reject once. */
  failPut(n: number): void;
}

const encoder = new TextEncoder();

function toBytes(value: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
}

export function createR2(): TestR2 {
  const store = new Map<string, Uint8Array>();
  const writes: string[] = [];
  let puts = 0;
  let failing = -1;
  const body = (key: string, bytes: Uint8Array): R2BodyLike => ({
    key,
    size: bytes.byteLength,
    arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
  });
  return {
    writes,
    bytes: (key) => store.get(key),
    failPut(n) {
      failing = n;
    },
    get: (key) => {
      const bytes = store.get(key);
      return Promise.resolve(bytes === undefined ? null : body(key, bytes));
    },
    put(key, value) {
      puts += 1;
      if (puts === failing) {
        failing = -1;
        return Promise.reject(new Error('R2: put failed'));
      }
      store.set(key, toBytes(value));
      writes.push(key);
      return Promise.resolve({ key });
    },
    delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
    list(options) {
      const prefix = options?.prefix ?? '';
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, bytes]) => ({ key, size: bytes.byteLength }));
      const start = options?.cursor === undefined ? 0 : Number(options.cursor);
      const limit = options?.limit ?? 1000;
      const objects = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return Promise.resolve(truncated ? { objects, truncated, cursor: String(start + limit) } : { objects, truncated });
    },
  };
}
