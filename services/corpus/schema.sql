-- The corpus service's tables (design 6.9). SQLite dialect, the one D1 speaks. Every statement is idempotent, so this file can be applied again
-- (`wrangler d1 execute chatwarden-corpus --file=schema.sql`) after an edit that only adds tables, columns' indexes or views.
-- Nothing here stores an IP address, a chat line, a free-text report or the name of a reviewer on a term.

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,                       -- CWT-2026-00042
  word_key TEXT NOT NULL UNIQUE,             -- collapseLikePreset(foldTerm(term)): one row per word, any language
  term TEXT NOT NULL,
  languages TEXT NOT NULL,                   -- JSON array
  category TEXT NOT NULL, target TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisional','accepted','disputed','withdrawn')),
  default_active INTEGER NOT NULL DEFAULT 1,
  collides_with TEXT NOT NULL DEFAULT '[]',
  since TEXT, approvals INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS term_lines (
  term_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('positive','negative')),
  line TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('template','dictionary','reviewer')),
  PRIMARY KEY (term_id, kind, line)
);

-- decided_at: when the submission left the queue (a clock timestamp); it orders "the last 10 results" and starts the 90-day life of a note.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  installation TEXT NOT NULL,                -- sha256 of the installation public key, hex
  word_key TEXT NOT NULL, term TEXT NOT NULL, language TEXT NOT NULL, category TEXT NOT NULL, target TEXT, note TEXT,
  status TEXT NOT NULL CHECK (status IN ('received','in_review','accepted','declined','merged')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('known_innocent','not_a_term','duplicate','needs_context','other')),
  term_id TEXT,
  received_day TEXT NOT NULL,
  decided_at TEXT,
  -- held: a gate failure found at review (a closed code); the submission stays in the queue, no term is made until a reviewer overrides it.
  held TEXT
);
CREATE INDEX IF NOT EXISTS submissions_word_key ON submissions (word_key);
CREATE INDEX IF NOT EXISTS submissions_installation ON submissions (installation, status);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve','decline','dispute','restore')),
  fluent INTEGER NOT NULL, at TEXT NOT NULL,
  UNIQUE (subject_kind, subject_id, reviewer)
);

-- The reviewers (design 10.3): who may use /admin, and the languages each is fluent in (a JSON array of tags). The owner maintains this table
-- by hand (`wrangler d1 execute`). reviewer_installations registers the installation keys (by their hash) a reviewer controls: nobody reviews a
-- submission from a key registered to them.
CREATE TABLE IF NOT EXISTS reviewers (email TEXT PRIMARY KEY, fluent TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS reviewer_installations (reviewer TEXT NOT NULL, installation TEXT NOT NULL, PRIMARY KEY (reviewer, installation));

-- No free text is stored for a report. channel is `inst:<hash>` (a signed report) or `web:<hash>` (the docs-site form).
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  term_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('innocent_sense','wrong_category','removal')),
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','disputed','withdrawn','restored','declined')),
  received_day TEXT NOT NULL
);
-- One open report per term, per channel key, per day (design 10.6): a second one collapses into the first.
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open ON reports (term_id, channel, received_day) WHERE status = 'received';

CREATE TABLE IF NOT EXISTS innocent_words (language TEXT NOT NULL, word_key TEXT NOT NULL, rank INTEGER, PRIMARY KEY (language, word_key));
CREATE INDEX IF NOT EXISTS innocent_words_key ON innocent_words (word_key);

CREATE TABLE IF NOT EXISTS negative_lines (language TEXT NOT NULL, line TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY (language, line));

-- Rate limits. Keys are `inst:<hash>` and `net:<hash(ip + daily salt)>`; the IP itself is never written. A row is purged after two days.
CREATE TABLE IF NOT EXISTS counters (key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, day));

CREATE TABLE IF NOT EXISTS releases (
  kind TEXT NOT NULL, version TEXT NOT NULL, sequence INTEGER NOT NULL, sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL, published_at TEXT NOT NULL, doi TEXT,
  PRIMARY KEY (kind, version)
);

CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL);

-- At most one pending submission per word, whoever sends it: a second one at the same moment is a duplicate, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_pending ON submissions (word_key) WHERE status IN ('received','in_review');
