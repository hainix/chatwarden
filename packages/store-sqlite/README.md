# @chatwarden/store-sqlite

The SQLite store for Chatwarden, the open-source chat moderation kit for games. It keeps the kit's state in one SQLite file:
people (as hashed identifiers), reports, sanctions, strikes, mutes, notices, decisions, the term list and the audit trail. It
uses the SQLite that is built into Node (`node:sqlite`), so there is no native module to compile and nothing else to install.

Use it with `@chatwarden/core`: `openStore(...)` returns the `store` that `createChatwarden` asks for.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/store-sqlite @chatwarden/core @chatwarden/matcher
```

`@chatwarden/core` and `@chatwarden/matcher` are peer dependencies: the store's type declarations refer to both, so your project
needs one copy of each (and the engine you pass the store to is `@chatwarden/core` anyway). Node 22.13 or newer, which has
`node:sqlite` without a flag. Node marks `node:sqlite` as experimental and prints an `ExperimentalWarning` the first time it is
used; the kit's tests run on it in CI on Node 22.13 and 24.

## Quick start

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';

// The kit owns this file: it creates it, turns on WAL mode and brings the tables up to date.
const store = openStore({ path: './chatwarden.db' });

const platform: Platform = {
  identify: (ctx) => {
    const conn = ctx as { playerToken: string; remoteAddress: string };
    return { clientKey: conn.playerToken, ip: conn.remoteAddress };
  },
};

const cw = await createChatwarden({ store, secret: process.env.CHATWARDEN_SECRET!, platform });

// ... serve your chat ...

await cw.close(); // flushes pending writes, then closes the store
```

Already have a SQLite connection of your own? Hand it over, and the kit adds its tables to it and leaves the connection open:

```ts
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@chatwarden/store-sqlite';

const db = new DatabaseSync('./app.db'); // your app's database
const store = openStore({ db });
console.log(store.schemaVersion()); // the number of the latest migration applied

store.close(); // does nothing to a database you passed in; close `db` yourself
db.close();
```

## Options

`openStore(options)` takes one of two places, and optionally a migration list.

| Option | What it does |
| --- | --- |
| `{ path: string }` | A file the kit owns. Created if missing. `':memory:'` gives a throwaway database for tests. The kit turns on foreign keys and WAL mode, and closes the file on `close()`. |
| `{ db: DatabaseSync }` | A connection your app owns. The kit turns on foreign keys, never changes the journal mode, and leaves the connection open on `close()`. |
| `migrations` | Replace the shipped migration list. For tests of the migration runner; leave it out. |

How it behaves:

- **Migrations run on open.** Each migration and its version bump commit together; a failing one rolls back and throws, leaving
  earlier ones applied. A database written by a newer version of the kit is refused (`database schema version N is newer than
  this kit supports`) rather than opened and damaged.
- **The kit only touches tables whose names start with `kit_`,** so it can share a database with your own tables.
- **One process at a time.** `node:sqlite` is synchronous and a SQLite file is not a network database. Run one app process per
  file. For several processes, write a `Store` for a server database; the interface is exported by `@chatwarden/core`.
- **Back it up like any database.** With WAL on, copy the `-wal` and `-shm` files with the main file, or use SQLite's `VACUUM INTO`.

## Security notes

- **What it stores about a person.** A subject id (an opaque `s_...` value), and for each identifier the kit saw: a keyed hash of
  the client key, a keyed hash of the IP address, or the account id exactly as your app gave it. The raw client key and the raw
  IP address never reach the store; hashing happens in `@chatwarden/core` before a row is written. Pass an opaque account id,
  not an email address.
- **What it stores about chat.** No chat is stored as it is typed. A report holds an excerpt of the conversation around the
  reported line (so a moderator can judge it), and a player's notice holds an excerpt of that player's own lines. Both are
  deleted by the retention purge. The term list holds the words your moderators added, which are the words you ban.
- **Subject ids are staff-only.** The tables are full of them. The store is the moderators' database: do not expose it, a backup
  of it or a query on it to a player, and keep the file readable by the app's user only (`chmod 600`).
- **What is never logged.** The store itself logs nothing. Errors it throws are SQLite's own and may name a table or column but
  never a value; the kit logs only an event name and the error class.
- **Rooms, names and languages (0.2.0).** Migration 26 is the one migration of the 0.2.0 release (the other themes' columns and tables are in it too); its rooms block adds four columns and one index. `kit_reports.scope` is the staff scope of the room a report was filed in (the `scope` tag, null for a room with none; filled in for the reports already stored) with the index `kit_reports_by_scope (scope, status, created_at)`, so a scoped moderator's reads filter in the query. `kit_reports.entity_json` is the clan, guild or team a report is about, as `{ kind, ref, label }` (null for a report about a player alone), and goes with its report (it holds no person id, and the privacy registry lists it as a column without subject ids). `kit_mutes.block` is 1 for a block: a mute that is also two-way and never expires, one row per pair, so the retention purge and the 500 per viewer cap leave it alone. `kit_terms.match_mode` is `word`, `segment` or `contains` for a term in a script written without spaces (null means by script). A store you write yourself that lacks the optional methods answers the routes that need them with 501 `not_supported`.
- **AI reads and the casebook.** Migration 20 adds three tables and five indexes for the optional AI help (levels 1 and 2): `kit_ai_reads` (one row per report and input: the validated read, its one-line summary, the state of the call and what it cost), `kit_ai_spend` (the ledger the daily cap reads: counts and micro-dollars) and `kit_ai_outcomes` (the casebook: how each decided report compared with the read; ids and choices, plus up to six pseudonymised lines of example text that are kept for 180 days at most). No existing table, column or row is touched, and no identity is stored (no subject, handle, seat or hash of a person). Reads go with their report and by age, the ledger by age, outcomes after 365 days (`retention.aiOutcomesMs`) and example text after 180 days (`retention.aiExamplesMs`). An existing database upgrades in place on the first start. It is one-way: a 0.1.6 store refuses a database at version 20, so back up the file before upgrading if you might roll back.
- **AI levels 3 and 4, release 2 (0.1.14).** Migration 25 adds one column, `kit_ai_reads.purpose` (`read` for every existing row, or `confirm` for the second reader's look before the AI would act), and two tables: `kit_ai_acting` (one row: the owner's acting mode, its pause, who and when) and `kit_ai_actions` (one row per report, ever: queued, held back, refused with a closed code, or "would have applied"; ids, the rule and conduct level, a state, a code and times, and a reviewer's private note that is cleared with the report), with five indexes. It adds the optional `Store` methods for them, including `purgeAiActions`, and `retention.aiActionsMs` (365 days, at least 90) clears the rows. Nothing in this release writes a sanction. It is **one-way** (a 0.1.13 or older store refuses a database at version 25): **back up the file before upgrading**.
- **AI levels 3 and 4, release 1 (0.1.13).** Migration 24 adds five columns to the casebook, `kit_ai_outcomes` (`ai_rule`, `ai_severity`, `ai_confidence`, `decided_by` and `source`, which is `human` for every existing row and is limited to `human`, `holdback`, `review` or `service`), an index on the AI's own rule, conduct level and date, and one new table, `kit_ai_noauto` (one row per person marked "do not automate": a closed reason code, who set it and when; it is never purged). Rows whose AI read is still stored (90 days) are filled in from it; older rows stay empty and are not counted by the gates. It adds the optional `Store` methods `aiGateRows`, `setNoAutomation` and `loadNoAutomation`. **It is one-way: a 0.1.12 or older store refuses a database at version 24, so back up the file before upgrading.** Nothing here holds chat, and nothing in this release lets the AI act.
- **Appeals and names.** Migration 22 adds two tables: `kit_appeals` (one row per appeal: the sanction group, the notice it was filed from, the rule, the status, the
  times, who decided it and the moderator's private reason, and `statement`, the one new free text a player writes, at most 1000 characters; a UNIQUE index on
  the group is what makes it one appeal for each sanction, so two processes on one file never both win) and `kit_blocked_names` (a blocked name kept as evidence, only for a
  kit with `names.keepBlocked`). It adds a nullable `kit_sanctions.report_id` (the report whose decision made a sanction, filled in for existing moderator
  sanctions where the decision can be found), a `corrective` column on `kit_ai_outcomes` (default 0) and rebuilds `kit_notices`, because SQLite cannot widen a CHECK in
  place and the table now allows four more kinds (`rename_required`, `appeal_upheld`, `appeal_reduced`, `appeal_revoked`); every notice keeps its id and its
  place. **It is one-way: a 0.1.8 or older store refuses a database at version 22, so back up the file before upgrading.** Retention clears a statement 90 days
  after the decision (`retention.appealStatementsMs`), deletes the appeal row after 365 days (`appealsMs`, never less than 90) and a kept name after 30
  (`blockedNamesMs`); these tables hold subject ids and a player's own words, so they are staff-only like the rest.
- **Signals.** Migration 21 adds one table, `kit_signals` (one row per signal a game recorded about a player: a kind id, the subject id, a source key, the `by` subject when there is one, a room id, a time, a weight and a cap bucket; ids and numbers only, no text, handle or seat), with three indexes (one UNIQUE index on kind, subject, source key and cap bucket, which is the per-source cap, so two processes on one file never both write the second row; one on subject and time for the grouped read; one on time for the purge), and one nullable column on the table migration 20 made, `kit_ai_reads.signals_json` (the signal counts an AI read was shown, as a label, a number of players and a number of days; NULL for every read that exists now and for a read made without the signal feed). Rows are deleted by age with `retention.signalsMs` (90 days by default, never under 14), and a read's counts go with the read. The kit also writes `flood_triggered` rows by itself, with no signals declared, whenever the burst limit trips (this store always has the signal methods), at most one per player, room and day; they are kept 90 days like any other. An existing database upgrades in place on the first start. It is one-way: a 0.1.7 store refuses a database at version 21, so back up the file before upgrading if you might roll back.
- **Reporter outcomes.** Migration 19 adds one index, `kit_reports_by_reporter_outcome (reporter_subject, created_at, status, bad_faith)`, and nothing else: no table, column or row changes. It lets `reporterOutcomes` (how a reporter's recent reports turned out, one grouped read for a whole queue page) be answered from the index alone. An existing database upgrades in place. It is one-way: a 0.1.4 store refuses a database at version 19, so back up the file before
  upgrading if you might roll back.
- **The editable profile.** Migration 16 adds `kit_policy_layer` (at most one row: the owner's stored edits to the moderation
  profile as JSON, and a version) and a nullable `detail_json` column on `kit_audit` (the sections changed and the reason of a
  `policy.update` or `policy.reset` row; NULL on every other row). A save is one conditional `INSERT` or `UPDATE` on the version, so
  two server processes on one file never both win; the loser gets a version conflict. An existing database upgrades in place and
  keeps every row. Nothing here holds chat.
- **Claims and saved reasons.** Migration 15 adds `kit_claims` (a soft claim per person: the staff actor holding the case and when it
  lapses) and `kit_reasons` (the moderators' saved decision reasons). A claim is taken with one conditional statement, so two
  server processes on the same file never both win a case. If a second process commits between the kit's read and its write,
  SQLite refuses the write (`database is locked`); the kit retries that claim up to 3 times with a fresh read, so the loser
  gets the normal "claimed" answer. The store sets a 5 second `busy_timeout` on a connection that has none (yours is kept if
  you set one), so short writes from two processes queue instead of failing. The queue's change token is a counter row in `kit_meta` that every
  report, decision, sanction, gap, claim-owner and reason change moves in the same transaction. Nothing here holds chat; the
  claim table holds subject ids and staff actors, so it is staff-only like the rest. Expired claim rows are replaced by the
  next claim and are not purged (see below).
- **What retention does not purge.** `cw.purge()` and the built-in timer delete old reports, sanctions, strikes, mutes, notices,
  audit rows, signal rows, decided appeals, appeal statements, kept blocked names and webhook keys. The subject tables (`kit_subjects`, `kit_subject_ids`), the Discord thread map
  (`kit_discord_threads`) and the claim table (`kit_claims`, one row per person ever claimed) are not purged, because the ladder and a returning player's record depend on knowing who is who. They
  hold hashes and ids, not chat. To erase one person, use `cw.privacy.erase` (see `@chatwarden/core`, "Privacy requests and legal hold", and [docs/privacy-requests.md](https://github.com/hainix/chatwarden/blob/main/docs/privacy-requests.md)): it clears every table above in one transaction, `kit_claims` and the Discord thread map included, and keeps only what a stated safety remainder or a legal hold needs. Do not edit the database by hand for this.
- **Encryption at rest is yours.** SQLite does not encrypt the file. Put it on an encrypted disk if the hashes and the moderators'
  excerpts need that.

### Migration 26 (0.2.0, one-way)

Migration 26 is the one migration of the whole 0.2.0 release: every theme's block is in it, and nothing adds a 27. It only adds (no table is rebuilt, no row is rewritten except the scope backfill below), and it runs in one transaction with the version bump, so a failure leaves version 25. **It is one-way: a 0.1.14 or older build refuses a database at version 26, so back up the database file before you upgrade.**

- **Chat filters.** `kit_reports.origin` (`filter` for a report a chat filter filed, null for a player's) and `kit_reports.origin_key` (the counter key that made it, never text), with `kit_reports_open_filter` (one open filter report per person and room) and `kit_reports_by_origin` (the daily cap). `kit_filter_hits` is one row per UTC day, counter key and applied action: counts only, no person, room or text.
- **Legal hold.** `kit_legal_holds` is one row per held report (a code from the closed list, who and when, and the release), with `kit_legal_holds_open` for the purges and the erase.
- **Privacy requests.** `kit_erasures` is one receipt row per erase (counts as JSON, no subject, no text), with `kit_erasures_pending` for the finish pass; the `erasure_epoch` row of `kit_meta` is a counter every erase moves, so another process learns that a person it holds in memory is gone. Four lookup indexes keep an erase from scanning by person: `kit_mutes_by_target`, `kit_blocked_names_by_subject`, `kit_signals_by_source` and `kit_sanctions_by_report`.
- **Urgent lane and desk.** `kit_reports.urgent` (a snapshot taken at filing, 0 on every earlier row) with `kit_reports_urgent_open`, `kit_reports.handoff_at` and `kit_reports.handoff_by`, `kit_reports.escalated_to`, `kit_reports.escalated_by` and `kit_reports.escalated_at`, and `kit_reports.evidence_ref` (the game's opaque id). `kit_report_comments` is the staff thread of a report, at most 50 a report, deleted with it, with `kit_report_comments_by_report`. `kit_chat_days` is one row per UTC day with two counts (lines delivered and refused), written only when `desk.insights` is on. `kit_reports_by_reporter_outcome_reason` is the reporter-accuracy index with the reason added.
- **Rooms, names and languages.** `kit_reports.scope` with `kit_reports_by_scope` (filled in for the reports already stored), `kit_reports.entity_json`, `kit_mutes.block` and `kit_terms.match_mode`, described in the bullet above.
- **Shared pacing.** `kit_pace` is one row per room and person with the pacer's times and short fingerprints of the last lines (never text), swept after an hour (`kit_pace_by_touched`) and erased with the person.

## Links

- [Chatwarden on GitHub](https://github.com/hainix/chatwarden) and the [root README](https://github.com/hainix/chatwarden#readme)
- [`@chatwarden/core`](https://github.com/hainix/chatwarden/tree/main/packages/core): the engine that uses this store
- [`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http): routes for moderators and players
- [Report a problem](https://github.com/hainix/chatwarden/issues)
- [Licence: Apache-2.0](https://github.com/hainix/chatwarden/blob/main/LICENSE)
