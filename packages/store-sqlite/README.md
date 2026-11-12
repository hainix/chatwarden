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
- **Reporter outcomes.** Migration 19 adds one index, `kit_reports_by_reporter_outcome (reporter_subject, created_at, status, bad_faith)`, and nothing else: no table, column or row changes. It lets `reporterOutcomes` (how a reporter's recent reports turned out, one grouped read for a whole queue page) be answered from the index alone. An existing database upgrades in place.
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
  audit rows and webhook keys. The subject tables (`kit_subjects`, `kit_subject_ids`), the Discord thread map
  (`kit_discord_threads`) and the claim table (`kit_claims`, one row per person ever claimed) are not purged, because the ladder and a returning player's record depend on knowing who is who. They
  hold hashes and ids, not chat. If your privacy policy needs a person erased, that is a separate step you run on the database, and it must clear `kit_claims` too.
- **Encryption at rest is yours.** SQLite does not encrypt the file. Put it on an encrypted disk if the hashes and the moderators'
  excerpts need that.

## Links

- [Chatwarden on GitHub](https://github.com/hainix/chatwarden) and the [root README](https://github.com/hainix/chatwarden#readme)
- [`@chatwarden/core`](https://github.com/hainix/chatwarden/tree/main/packages/core): the engine that uses this store
- [`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http): routes for moderators and players
- [Report a problem](https://github.com/hainix/chatwarden/issues)
- [Licence: Apache-2.0](https://github.com/hainix/chatwarden/blob/main/LICENSE)
