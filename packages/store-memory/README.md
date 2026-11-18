# @chatwarden/store-memory

The in-memory store for Chatwarden, the open-source chat moderation kit for games. It keeps everything the kit stores (people as
hashed identifiers, reports, sanctions, strikes, mutes, notices, decisions, the audit trail, moderators' claims and saved reasons) in plain JavaScript objects inside
your process. Nothing is written to disk.

**It is memory only. Everything is lost when the process restarts, exits or stops.** It is for tests, demos and single-process
prototypes. Do not use it in production: a restart would forget every report, every ban and every strike. For anything that must
survive a restart, use [`@chatwarden/store-sqlite`](https://github.com/hainix/chatwarden/tree/main/packages/store-sqlite).

Use it with `@chatwarden/core`: `createMemoryStore()` returns the `store` that `createChatwarden` asks for.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/store-memory @chatwarden/core
```

`@chatwarden/core` is a peer dependency, so your project has exactly one copy of it. Node 22.13 or newer. The package imports no
`node:` module and has no dependencies, so it also bundles for a browser.

## Quick start

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { createMemoryStore } from '@chatwarden/store-memory';

// A fresh, empty store. There is nothing to open, configure or close on disk.
const store = createMemoryStore();

const platform: Platform = {
  identify: (ctx) => {
    const conn = ctx as { playerToken: string; remoteAddress: string };
    return { clientKey: conn.playerToken, ip: conn.remoteAddress };
  },
};

const cw = await createChatwarden({ store, secret: 'a-long-random-secret-for-this-run', platform, retention: false });

// ... run your test or demo ...

await cw.close(); // flushes pending writes; the store's contents are then simply dropped
```

In a test you can also read back what was stored, or make the store fail on purpose. `MemoryStore` is a class; subclass it and
override one method to inject a failure:

```ts
import { MemoryStore } from '@chatwarden/store-memory';
import type { StrikeRow } from '@chatwarden/core';

class FullDisk extends MemoryStore {
  override insertStrike(_row: StrikeRow): void {
    throw new Error('disk full');
  }
}

const store = new FullDisk();
console.log(store.rawReports().length); // 0: a copy of every stored report, for assertions
```

## The AI methods (opt-in)

The kit's AI needs optional store methods (the reads, the spend ledger and the casebook). `createMemoryStore()` does not carry them, so an
app that never turns the AI on does not bundle them. To use the AI over the in-memory store, add them with `withMemoryAi(store)`
(new in 0.1.7). It returns the same store; a method the store already has (a subclass's override) is kept, and calling it
twice changes nothing. The SQLite store has them built in.

```ts
import { createChatwarden, createFakeModerationAI, type Platform } from '@chatwarden/core';
import { createMemoryStore, withMemoryAi } from '@chatwarden/store-memory';

declare const platform: Platform;

const store = withMemoryAi(createMemoryStore());
const cw = await createChatwarden({ store, secret: 'a-long-random-secret-for-this-run', platform, retention: false, ai: { adapter: createFakeModerationAI() } });
```

Without `withMemoryAi`, a kit created with `ai` leaves the AI inert and logs `chatwarden.ai_store_unsupported` once; nothing else changes.

## The signal methods (opt-in)

Signals (what a game records about a player: muted by others, kicked, `flood_triggered`) need three optional store methods
(`insertSignal`, `listSignalSources`, `purgeSignals`). `createMemoryStore()` does not carry them, so an app that never records a signal
does not bundle them. To use signals over the in-memory store, add them with `withMemorySignals(store)` (new in 0.1.8). It
returns the same store; a method the store already has is kept, and calling it twice changes nothing. The SQLite store has them built in.

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { createMemoryStore, withMemorySignals } from '@chatwarden/store-memory';

declare const platform: Platform;

const store = withMemorySignals(createMemoryStore());
const cw = await createChatwarden({
  store,
  secret: 'a-long-random-secret-for-this-run',
  platform,
  retention: false,
  overrides: { signals: { kinds: { muted_by_player: { label: 'Muted by other players', polarity: 'negative' } } } },
});
```

A kit that declares signal kinds or feeds over a store without the methods is refused when it is created. A kit that declares none starts, and
`cw.signals.record` answers false and logs `chatwarden.signals_store_unsupported` once.

## The appeal and name methods (opt-in)

Appeals need optional store methods (`insertAppeal`, `loadAppeal`, `listAppeals`, `decideAppeal`, the counts the weekly cap and the mistake rate read, the
purges and a few more). Blocked names kept as evidence (`names.keepBlocked`) need three (`insertBlockedName`, `listBlockedNames`, `purgeBlockedNames`).
`createMemoryStore()` carries neither, so an app that uses neither does not bundle them. To use appeals over the in-memory store, add them with
`withMemoryAppeals(store)`, and for kept names `withMemoryNames(store)` (both new in 0.1.9). Each returns the same store; a method the store
already has is kept, and calling one twice changes nothing. The SQLite store has them built in. `withdrawNotice`, which lets a game release a required
rename, is already on `MemoryStore`.

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { createMemoryStore, withMemoryAppeals, withMemoryNames } from '@chatwarden/store-memory';

declare const platform: Platform;

const store = withMemoryNames(withMemoryAppeals(createMemoryStore()));
const cw = await createChatwarden({
  store,
  secret: 'a-long-random-secret-for-this-run',
  platform,
  retention: false,
  overrides: { appeals: { enabled: true }, names: { renames: true, keepBlocked: true } },
});
```

A kit created with `appeals.enabled` in its profile over a store without the appeal methods is refused when it is created (an owner's saved setting is refused when saved, or left off with a warning if it was stored before). Kept names over a store without the name
methods are simply not kept.

## The test kit (`@chatwarden/store-memory/testing`, for tests only)

Not for production: it is built for your own tests, over this memory store, with a fake clock and a public test secret. `@chatwarden/store-memory/testing` is a
separate entry (the main entry does not import it), has no `node:` import, needs no test runner (a failed expectation throws a plain `ScriptMismatch` error and
outcomes are plain strings, so it reads the same in Vitest, Jest and `node:test`), and its names are part of the API.

`createTestKit` builds a kit (`retention: false`, the standard profile, no matcher) and `kit.play` runs a script: a table of players, lines, reports, mutes,
waits and suggestions that reads as a specification. `blocked` and `swears` are word lists for the stand-in matcher and filter (whole words, ignoring case; pass
your own `matcher` to test your own term list). Nothing moves the clock but a `wait` or `kit.clock.advance`, so a test is the same on every run. The words below
are invented.

```ts
import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';

const kit = await createTestKit({ profile: 'strict', blocked: ['zorbak'], swears: ['snerp'] });
const run = await kit.play([
  { player: 'tarvo', say: 'good game', expect: 'delivered' },
  { player: 'fenrisk', say: 'snerp that', expect: 'refused:profanity' },
  { player: 'fenrisk', say: 'zorbak', expect: 'refused:blocked' },
  { wait: '10m' },
  { player: 'fenrisk', say: 'you zorbak', expect: 'refused:blocked' },
  { player: 'fenrisk', say: 'zorbak zorbak', expect: 'refused:blocked' },
  { player: 'fenrisk', say: 'hello', expect: 'refused:restricted' },
  { suggest: 'fenrisk', level: 'hostile', expect: 'Full ban 7 days' },
]);
expectOutcomes(run, ['delivered', 'refused:profanity', 'refused:blocked', 'refused:blocked', 'refused:blocked', 'refused:restricted']);
```

A line is `delivered`, `starred` (delivered with different text) or `refused:<reason>` with the kit's own reason (`length`, `rate`, `gate`, `restricted`,
`blocked`, `profanity`, `empty`, and `slow_mode`, `flood` and `duplicate` when the room paces). The third blocked line in an hour earns an automatic timeout,
and the outcome says so (`autoRestricted`: `'first'`, then `'second'`). `kit.room()` is the same thing for a hand-written test (`say`, `report`, `mute`,
`sees`, `leave`), `checkLines(options, [{ text, expect }])` checks a table of independent lines on a fresh kit each, and `kit.cw` is the whole kit when a test
needs more. It does not run HTTP, make moderator decisions or take the real matcher's place.

The names in this entry: `createTestKit`, `checkLines`, `createFakeClock`, `durationMs`, `wordFilter`, `wordMatcher`, `expectOutcomes` and
`ScriptMismatch`, and the types `TestKit`, `TestKitOptions`, `TestRoom`, `FakeClock`, `Duration`, `Step`, `Run`, `SayLabel`, `SayOutcome`, `ReportLabel` and `ReportOutcome`.

## Options

`createMemoryStore()` and `new MemoryStore()` take no options. The inspection helpers below return copies, so changing what they
return changes nothing in the store.

| Method | What it returns |
| --- | --- |
| `rawReports()` | Every stored report, with its decision columns. |
| `rawSanctions()` | Every sanction row, revoked ones included. |
| `rawNotices()` | Every player notice, seen, unseen and withdrawn. |
| `rawDecisions()` | Every recorded moderator decision. |
| `rawStrikes()` | Every strike. |
| `rawMutes()` | Every mute. |

How it behaves:

- **Transactions are real.** The kit's multi-step writes (a decision that closes a report, writes a sanction and a notice) run in
  `store.transaction(fn)`. Every write inside is journaled; if `fn` throws, they are undone in reverse order and the error is
  rethrown. Calls nest: an inner failure the outer function catches undoes only the inner writes.
- **Same behaviour as the SQLite store.** Both stores run one shared store contract suite (ordering, paging, uniqueness, rollback,
  what each purge deletes). Where they ever disagree, the SQLite store is the reference and this one is the bug.
- **The editable profile.** It implements `loadPolicyLayer` and `savePolicyLayer`, so `cw.policy.save` works. The stored layer lives in
  the heap with everything else: it is lost when the process ends, so a profile edited at runtime goes back to your code's profile
  on restart. Use the SQLite store (or your own) for edits that must last.
- **One process, one thread.** It is a set of objects in your heap. Two processes, or two workers, each get their own empty store.
- **No size limit.** Memory grows with what you store until the retention purge runs or the process ends.

## Security notes

- **What it holds.** The same things the SQLite store holds: subject ids, keyed hashes of client keys and IP addresses, account ids
  exactly as your app gave them, reports with an excerpt of the conversation, sanction reasons and moderator notes. The raw client
  key and raw IP address never reach any store; hashing happens in `@chatwarden/core` first. Pass an opaque account id, not an
  email address.
- **Subject ids are staff-only.** `rawReports()` and the other helpers return subject ids and chat excerpts. Use them in tests and
  staff tooling only; never send their output to a player.
- **Nothing is logged.** The store never logs anything. Errors it throws are plain `Error`s with no values in them; the kit logs only an
  event name and the error class.
- **Retention is core's call, not the store's.** The store has no timer and nothing purges by itself. The purge methods
  (`purgeReports`, `purgeSanctions`, `purgeNotices` and the rest) delete exactly what the SQLite store would (both pass the same
  store contract suite), and run only when
  `@chatwarden/core` calls them: its built-in retention timer, or `cw.purge()`. With `retention: false` and no `cw.purge()`
  call, nothing is ever deleted until the process ends. The subject records, and the Discord thread map, are never purged, as in
  the SQLite store.
- **Everything is lost on restart, and that is the whole point.** There is no file to protect, no backup to leak and no
  encryption question; the flip side is no durability at all.

## Links

- [Chatwarden on GitHub](https://github.com/hainix/chatwarden) and the [root README](https://github.com/hainix/chatwarden#readme)
- [`@chatwarden/core`](https://github.com/hainix/chatwarden/tree/main/packages/core): the engine that uses this store
- [`@chatwarden/store-sqlite`](https://github.com/hainix/chatwarden/tree/main/packages/store-sqlite): the store for anything that must survive a restart
- [`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http): routes for moderators and players
- [Report a problem](https://github.com/hainix/chatwarden/issues)
- [Licence: Apache-2.0](https://github.com/hainix/chatwarden/blob/main/LICENSE)
