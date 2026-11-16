import { readFile } from 'node:fs/promises';
import { wordKey } from '../src/wordkey.js';
import { makeAccess, type FakeAccess } from './access-world.js';
import { makeClock, makeWorld, sha256Hex, START, type TestClock, type World } from './world.js';

// The review world: the app with Cloudflare Access faked (generated RSA keys), the page's real files served as assets, a few reviewers and a way
// to seed submissions and terms. Invented words only.

const ASSET_DIR = new URL('../page/admin/', import.meta.url);
const TYPES: Record<string, string> = { 'index.html': 'text/html', 'page.js': 'text/javascript', 'page.css': 'text/css' };

/** The page's files from disk, the way the ASSETS binding serves them. */
export async function diskAssets(name: string): Promise<Response | null> {
  if (!(name in TYPES)) return null;
  try {
    return new Response(await readFile(new URL(name, ASSET_DIR)), { headers: { 'content-type': TYPES[name] as string } });
  } catch {
    return null;
  }
}

export interface ReviewWorld {
  w: World;
  clock: TestClock;
  access: FakeAccess;
  /** A request to the app as a reviewer (default alice), with a valid token unless `token` is given. `body` is sent as JSON. */
  admin: (path: string, init?: { method?: string; body?: unknown; rawBody?: string; who?: string; token?: string | null; headers?: Record<string, string>; contentType?: string | null }) => Promise<Response>;
  addReviewer: (email: string, fluent?: string[], active?: boolean) => Promise<void>;
  seed: (over?: SeedOptions) => Promise<string>;
  rows: (sql: string, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
  restore: () => void;
}

export interface SeedOptions {
  id?: string;
  term?: string;
  language?: string;
  category?: string;
  target?: string;
  note?: string | null;
  installation?: string;
  status?: string;
  reason?: string | null;
}

export async function makeReviewWorld(over: Parameters<typeof makeWorld>[0] = {}): Promise<ReviewWorld> {
  const clock = makeClock(START);
  const access = await makeAccess(clock);
  const w = await makeWorld({ clock, access: access.config, assets: diskAssets, ...over });
  let n = 0;
  const rows = async (sql: string, ...values: unknown[]) => (await w.db.prepare(sql).bind(...values).all<Record<string, unknown>>()).results;
  return {
    w,
    clock,
    access,
    rows,
    restore: () => w.restore(),
    async admin(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      const token = init.token === undefined ? await access.token({ claims: { email: init.who ?? 'alice@example.test' } }) : init.token;
      if (token !== null) headers['cf-access-jwt-assertion'] = token;
      const hasBody = init.body !== undefined || init.rawBody !== undefined;
      if (hasBody && init.contentType !== null) headers['content-type'] = init.contentType ?? 'application/json';
      return w.fetch(new Request(`https://corpus.test${path}`, { method: init.method ?? 'GET', headers, ...(hasBody ? { body: init.rawBody ?? JSON.stringify(init.body) } : {}) }));
    },
    async addReviewer(email, fluent = [], active = true) {
      await w.db.prepare('INSERT INTO reviewers (email, fluent, active) VALUES (?, ?, ?)').bind(email, JSON.stringify(fluent), active ? 1 : 0).run();
    },
    async seed(o = {}) {
      n += 1;
      const id = o.id ?? `sub_seed${String(n).padStart(4, '0')}`;
      const term = o.term ?? 'zorbak';
      await w.db
        .prepare('INSERT INTO submissions (id, installation, word_key, term, language, category, target, note, status, reason, received_day) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, o.installation ?? (await sha256Hex(new TextEncoder().encode(`inst-${n}`))), wordKey(term), term, o.language ?? 'en', o.category ?? 'abuse', o.target ?? 'none', o.note === undefined ? null : o.note, o.status ?? 'received', o.reason ?? null, '2026-12-02')
        .run();
      return id;
    },
  };
}

export const ALICE = 'alice@example.test'; // fluent in en
export const BOB = 'bob@example.test'; // fluent in nothing
export const CARA = 'cara@example.test'; // fluent in es
export const DAN = 'dan@example.test'; // fluent in en and es
export const EVE = 'eve@example.test'; // fluent in pt

export async function withReviewers(rw: ReviewWorld): Promise<void> {
  await rw.addReviewer(ALICE, ['en']);
  await rw.addReviewer(BOB, []);
  await rw.addReviewer(CARA, ['es']);
  await rw.addReviewer(DAN, ['en', 'es']);
  await rw.addReviewer(EVE, ['pt']);
}
