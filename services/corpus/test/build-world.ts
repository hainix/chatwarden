import { wordKey } from '../src/wordkey.js';
import { applySchema, createD1, type TestD1 } from './d1.js';
import { makeClock, type TestClock } from './world.js';

// The builder's world: an in-memory D1 with the schema, and seeders for terms, dictionary words and negative lines. Invented words only; every
// dictionary word here is made up (a "contains the term" word is the term plus a made-up ending), and the test corpus is generated.

export interface SeedTerm {
  id: string;
  term: string;
  languages?: string[];
  category?: string;
  target?: string;
  severity?: string;
  status?: string;
  defaultActive?: boolean;
  collidesWith?: string[];
  since?: string | null;
  approvals?: number;
}

export interface BuildWorld {
  db: TestD1;
  clock: TestClock;
  term: (t: SeedTerm) => Promise<void>;
  line: (termId: string, kind: 'positive' | 'negative', line: string, origin?: 'template' | 'dictionary' | 'reviewer') => Promise<void>;
  innocent: (language: string, words: readonly string[], rank?: number | null) => Promise<void>;
  negative: (language: string, lines: readonly string[]) => Promise<void>;
  release: (kind: string, version: string, sequence: number) => Promise<void>;
}

export const BUILD_START = '2026-12-01T09:00:00Z';

export async function makeBuildWorld(): Promise<BuildWorld> {
  const db = createD1();
  await applySchema(db);
  const clock = makeClock(BUILD_START);
  const at = '2026-11-01T00:00:00Z';
  return {
    db,
    clock,
    term: async (t) => {
      await db
        .prepare(
          'INSERT INTO terms (id, word_key, term, languages, category, target, severity, status, default_active, collides_with, since, approvals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          t.id,
          wordKey(t.term),
          t.term,
          JSON.stringify(t.languages ?? ['en']),
          t.category ?? 'abuse',
          t.target ?? 'none',
          t.severity ?? 'hostile',
          t.status ?? 'accepted',
          t.defaultActive === false ? 0 : 1,
          JSON.stringify(t.collidesWith ?? []),
          t.since === undefined ? null : t.since,
          t.approvals ?? 2,
          at,
          at,
        )
        .run();
    },
    line: async (termId, kind, line, origin = 'reviewer') => {
      await db.prepare('INSERT INTO term_lines (term_id, kind, line, origin) VALUES (?, ?, ?, ?)').bind(termId, kind, line, origin).run();
    },
    innocent: async (language, words, rank = null) => {
      for (const w of words) {
        await db.prepare('INSERT OR REPLACE INTO innocent_words (language, word_key, rank) VALUES (?, ?, ?)').bind(language, wordKey(w), rank).run();
      }
    },
    negative: async (language, lines) => {
      for (const l of lines) await db.prepare('INSERT OR REPLACE INTO negative_lines (language, line, origin) VALUES (?, ?, ?)').bind(language, l, 'test').run();
    },
    release: async (kind, version, sequence) => {
      await db.prepare('INSERT INTO releases (kind, version, sequence, sha256, key_id, published_at, doi) VALUES (?, ?, ?, ?, ?, ?, NULL)').bind(kind, version, sequence, 'a'.repeat(64), 'k1', at).run();
    },
  };
}
