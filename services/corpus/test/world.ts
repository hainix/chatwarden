import { webcrypto } from 'node:crypto';
import { createCommunityShare, mintStamp, signedMessage, type CommunityShare } from '@chatwarden/matcher/corpus';
import { createApp, type AppDeps, type LogEvent } from '../src/worker.js';
import { applySchema, createD1, type TestD1 } from './d1.js';

// The test world of the service: an in-memory D1 with the schema applied, a fake clock, a spied log, generated Ed25519 keys (no key in this file
// is real) and the kit's own share client driven against the app through an in-process fetch. Invented words only.

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => Buffer.from(new Uint8Array(await subtle.digest('SHA-256', bytes))).toString('hex');

export interface Installation {
  publicKey: string;
  /** The hash the service files this installation under: sha256 of the raw public key, hex. */
  id: () => Promise<string>;
  /** Signs a message as is and returns base64url. */
  sign: (message: Uint8Array) => Promise<string>;
}

export async function makeInstallation(): Promise<Installation> {
  const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: b64u(raw),
    id: () => sha256Hex(raw),
    sign: async (message) => b64u(new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, message))),
  };
}

export interface TestClock {
  now(): number;
  set(iso: string): void;
  advance(ms: number): void;
}
export function makeClock(iso: string): TestClock {
  let t = Date.parse(iso);
  return { now: () => t, set: (v) => void (t = Date.parse(v)), advance: (ms) => void (t += ms) };
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const START = '2026-12-02T12:00:00Z';
export const TODAY = '2026-12-02';

export const validBody = (over: Record<string, unknown> = {}, drop: string[] = []): string => {
  const base: Record<string, unknown> = {
    schema: 'chatwarden-corpus-submission/1',
    term: 'zorbak',
    language: 'en',
    category: 'slur',
    target: 'none',
    note: null,
    day: TODAY,
    kit: '0.1.11',
  };
  const merged = { ...base, ...over };
  for (const k of drop) delete merged[k];
  return JSON.stringify(merged);
};

/** A distinct, valid, plain-letter word for each n (no doubled letters, so none collapses into another). */
export function wordN(n: number): string {
  const a = 'bcdfghjklm';
  const b = 'npqrstvwxz';
  const c = 'aeiou';
  return `tarvo${a[n % 10]}${b[Math.floor(n / 10) % 10]}${c[Math.floor(n / 100) % 5]}${a[Math.floor(n / 500) % 10]}`;
}

export interface PostSpec {
  body?: string | Uint8Array;
  installation?: Installation;
  /** The kind the signature is made for. Default `submission`. */
  kind?: 'submission' | 'report' | 'index';
  /** Sign these bytes instead of the body. */
  signBytes?: Uint8Array;
  /** `null` leaves the stamp header out. Default: a good stamp for the body at the service's bits. */
  stamp?: string | null;
  /** Overrides, or removes (`null`), any header. */
  headers?: Record<string, string | null>;
  ip?: string;
  /** Default `application/json`; `null` sends none. */
  contentType?: string | null;
  /** A stream body (for the cap on a body of unknown length). */
  stream?: ReadableStream<Uint8Array>;
  method?: string;
  path?: string;
}

export interface World {
  db: TestD1;
  clock: TestClock;
  logs: LogEvent[];
  /** Everything written to console.warn / console.error / console.log while the world is alive. */
  consoleOutput: string[];
  deps: AppDeps;
  fetch: (request: Request) => Promise<Response>;
  stampBits: number;
  post: (spec?: PostSpec) => Promise<Response>;
  /** A signed GET of a submission's status. */
  get: (id: string, spec?: { installation?: Installation; kind?: 'submission' | 'report'; ip?: string; headers?: Record<string, string | null> }) => Promise<Response>;
  /** The kit's share client, signing as `installation`, going to the app from `ip`. */
  client: (installation: Installation, ip?: string, extra?: { stampBits?: number }) => CommunityShare;
  /** Every table as JSON text, for "nothing leaked" checks. */
  dump: () => Promise<string>;
  seedInnocent: (rows: [string, string, number | null][]) => Promise<void>;
  addTerm: (id: string, key: string, status?: string) => Promise<void>;
  restore: () => void;
}

export async function makeWorld(over: Partial<AppDeps> = {}): Promise<World> {
  const db = createD1();
  await applySchema(db);
  const clock = (over.clock as TestClock | undefined) ?? makeClock(START);
  const logs: LogEvent[] = [];
  const consoleOutput: string[] = [];
  const originals = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  const spy = (...args: unknown[]): void => {
    consoleOutput.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.warn = spy;
  console.error = spy;
  console.log = spy;
  console.info = spy;
  const stampBits = over.stampBits ?? 8;
  const deps: AppDeps = { db, clock, secret: 'test-secret-not-a-real-secret', log: (e) => void logs.push(e), stampBits, ...over };
  const app = createApp(deps);
  const defaultIp = '203.0.113.7';

  const send = (path: string, init: RequestInit, ip: string): Promise<Response> =>
    app.fetch(new Request(`https://corpus.test${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers as ConstructorParameters<typeof Headers>[0])), 'cf-connecting-ip': ip } }));

  const installation = await makeInstallation();

  async function post(spec: PostSpec = {}): Promise<Response> {
    const inst = spec.installation ?? installation;
    const raw = spec.body ?? validBody();
    const bytes = typeof raw === 'string' ? enc.encode(raw) : raw;
    const headers: Record<string, string> = {};
    const contentType = spec.contentType === undefined ? 'application/json' : spec.contentType;
    if (contentType !== null) headers['content-type'] = contentType;
    headers['x-cw-key'] = inst.publicKey;
    headers['x-cw-sig'] = await inst.sign(signedMessage(spec.kind ?? 'submission', spec.signBytes ?? bytes));
    const stamp = spec.stamp === undefined ? mintStamp(bytes, stampBits) : spec.stamp;
    if (stamp !== null) headers['x-cw-stamp'] = stamp;
    for (const [k, v] of Object.entries(spec.headers ?? {})) {
      if (v === null) delete headers[k];
      else headers[k] = v;
    }
    const init: RequestInit & { duplex?: string } = { method: spec.method ?? 'POST', headers };
    if (spec.stream !== undefined) {
      init.body = spec.stream;
      init.duplex = 'half';
    } else if ((spec.method ?? 'POST') !== 'GET') init.body = bytes;
    return send(spec.path ?? '/v1/submissions', init, spec.ip ?? defaultIp);
  }

  async function get(id: string, spec: { installation?: Installation; kind?: 'submission' | 'report'; ip?: string; headers?: Record<string, string | null> } = {}): Promise<Response> {
    const inst = spec.installation ?? installation;
    const headers: Record<string, string> = { 'x-cw-key': inst.publicKey, 'x-cw-sig': await inst.sign(signedMessage(spec.kind ?? 'submission', enc.encode(id))) };
    for (const [k, v] of Object.entries(spec.headers ?? {})) {
      if (v === null) delete headers[k];
      else headers[k] = v;
    }
    return send(`/v1/submissions/${id}`, { method: 'GET', headers }, spec.ip ?? defaultIp);
  }

  const client = (inst: Installation, ip = defaultIp, extra: { stampBits?: number } = {}): CommunityShare =>
    createCommunityShare({
      endpoint: 'https://corpus.test',
      sign: inst.sign,
      publicKey: inst.publicKey,
      clock,
      kit: '0.1.11',
      stampBits: extra.stampBits ?? stampBits,
      fetch: ((url: string, init: RequestInit) => send(new URL(url).pathname, init, ip)) as typeof fetch,
    });

  async function dump(): Promise<string> {
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()).results;
    const out: Record<string, unknown> = {};
    for (const { name } of tables) out[name] = (await db.prepare(`SELECT * FROM ${name}`).all()).results;
    return JSON.stringify(out);
  }

  return {
    db,
    clock,
    logs,
    consoleOutput,
    deps,
    fetch: (r) => app.fetch(r),
    stampBits,
    post,
    get,
    client,
    dump,
    seedInnocent: async (rows) => {
      for (const [l, k, r] of rows) await db.prepare('INSERT INTO innocent_words VALUES (?, ?, ?)').bind(l, k, r).run();
    },
    addTerm: async (id, key, status = 'accepted') => {
      await db
        .prepare('INSERT INTO terms (id, word_key, term, languages, category, target, severity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(id, key, key, '["en"]', 'slur', 'none', 'severe', status, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')
        .run();
    },
    restore: () => {
      console.warn = originals.warn;
      console.error = originals.error;
      console.log = originals.log;
      console.info = originals.info;
    },
  };
}

export const idOf = async (res: Response): Promise<string> => ((await res.json()) as { id: string }).id;
export const errorOf = async (res: Response): Promise<string | undefined> => ((await res.json()) as { error?: string }).error;
