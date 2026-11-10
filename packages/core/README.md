# @chatwarden/core

The moderation engine of Chatwarden, the open-source chat moderation kit for games. You give it your chat lines, your reports
and a small description of how to tell players apart. It decides what to deliver, what to refuse, who to time out, and what a
moderator sees. It does not open sockets, serve HTTP or touch a disk: those are the other packages.

What it does:

- **Chat.** Checks each line against your matcher, a length and rate limit, and the sanctions in force. A line is delivered, or
  refused with a reason.
- **Reports.** Players report each other. The kit keeps the evidence, limits abuse of the report button, and builds the
  moderators' queue.
- **Decisions and sanctions.** A moderator decides a report. The kit writes the warnings, timeouts and bans, with a notice for
  the player and an audit row for the staff.
- **A written standard.** One preset (`relaxed`, `standard` or `strict`) sets the ladder, the starter Community Rules and the
  code of conduct players read.
- **Identity without identifiers.** Client keys and IP addresses are hashed on the way in, and people are tracked by an opaque
  subject id.

It has no runtime dependencies and imports no `node:` module, so it also runs in a browser.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/core
```

Core stores nothing itself. To run the quick start below you also need a store and a matcher:

```sh
npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher
```

`@chatwarden/store-sqlite` and `@chatwarden/matcher` (and the other kit packages) list `@chatwarden/core` as a peer dependency,
so your project has exactly one copy of it. Node 22.13 or newer. The package is ESM only; a CommonJS app can `require()` it on
Node 22.13 or newer (see the [root README](https://github.com/hainix/chatwarden#commonjs)).

## Quick start

Copy this, then change `platform.identify` to read your own connections.

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { openStore } from '@chatwarden/store-sqlite';

// What one of your connections looks like. Yours may be a socket, a session or a request.
interface Connection {
  playerToken: string; // a stable, secret per-player value (not shown to other players)
  remoteAddress: string; // the REAL client address; behind a proxy, parse X-Forwarded-For yourself
}

// How to find out who is behind a connection. Give raw values: the kit hashes them before it stores anything.
const platform: Platform = {
  identify: (ctx) => {
    const conn = ctx as Connection;
    return { clientKey: conn.playerToken, ip: conn.remoteAddress };
  },
};

const store = openStore({ path: './chatwarden.db' });

// The slur matcher. This demo uses the invented test words; use your own term pack in production.
const matcher = new LiveTerms({ store, pack: syntheticTermPack(), clock: { now: () => Date.now() } });
await matcher.load();

const cw = await createChatwarden({
  store,
  secret: process.env.CHATWARDEN_SECRET!, // 32+ random characters; keep it stable and private
  platform,
  matcher,
  profile: 'standard', // 'relaxed', 'standard' or 'strict'
});

// A player connects: seat them in a room under a display name.
const connection: Connection = { playerToken: 'token-from-your-login', remoteAddress: '203.0.113.7' };
cw.rooms.seatConnection('lobby', 'seat-1', connection, 'Ada');
cw.rooms.seat('lobby', 'seat-2', { clientKey: 'another-players-token', ip: '198.51.100.4' }, 'Bo'); // or by raw identity

// A chat line arrives: ask the kit what to do with it.
const result = cw.chat.accept('lobby', 'seat-1', 'hello everyone');
if ('deliver' in result) {
  console.log('send to the room:', result.deliver.text); // may be starred if you turned profanity starring on
} else {
  console.log('tell this player only:', result.refuse.reason); // 'blocked', 'rate', 'restricted', ...
}

// Ada reports Bo from inside your game.
const filed = await cw.reports.submit({
  roomId: 'lobby',
  reporterSeat: 'seat-1',
  targetSeat: 'seat-2',
  category: 'harassment',
  note: 'kept at it after I asked them to stop',
});
console.log(filed.ok ? `report ${filed.reportId} filed` : `not filed: ${filed.refused}`);

await cw.close(); // flushes background writes and closes the store; call it on shutdown
```

For the moderators' screens and the player's notices, mount the routes in
[`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http) rather than calling the facade by hand.

## What you get back

`createChatwarden` resolves to one object, `cw`, with these parts (the TypeScript types are the full reference):

| Part | What it is for |
| --- | --- |
| `cw.rooms` | `seat`, `seatConnection`, `unseat`, `close`: who is in which seat of which room. |
| `cw.chat.accept(room, seat, text)` | The answer for one line: `{ deliver }` or `{ refuse: { reason } }`. `visibleTo` applies a viewer's mutes. `restricted(who)` says whether a person is chat-restricted, for typing indicators. |
| `cw.mutes` | A player mutes another player for themselves only. |
| `cw.reports` | `submit` (players), `list` and `get` (staff). |
| `cw.decide(input)` | A moderator closes a report and writes the sanctions and notices in one transaction. Safe to send twice. |
| `cw.sanctions` | `apply` and `revoke`, for a moderator who acts without a report. |
| `cw.notices` | A player's pending notices, acknowledgements and "My record". Built so no identifier can leak. |
| `cw.doors` | `check` a person at the door (login, join) against bans. |
| `cw.names.check` | May a player use this as a name? |
| `cw.history`, `cw.suggest` | A person's recent record, and what the preset suggests as the next step. |
| `cw.rules`, `cw.profile`, `cw.limits`, `cw.summary`, `cw.documents` | The rules, standard and numbers in force, and the written code of conduct and guides. |
| `cw.gaps`, `cw.audit` | Rule gaps for the periodic review, and the staff audit trail. |
| `cw.on(type, listener)` | Events: `report.created`, `report.closed`, `sanction.applied`, `sanction.revoked`, `gap.created`, `auto.restricted`. |
| `cw.purge`, `cw.ready`, `cw.flush`, `cw.close` | Housekeeping. |

## Typing indicators

Do not show a "typing..." indicator for a player who cannot chat. `cw.chat.restricted(who, { roomId, seatId })` runs the
same decision as `accept` (a chat restriction, a ban, or the automatic timeout), without sending a line. It is
synchronous and has no side effects: it spends no rate budget and writes no evidence, strike, event or notice.

```ts
import type { Chatwarden, RawWho } from '@chatwarden/core';

// Call it when a client says "I am typing", after `cw.rooms.seat` for that seat. `who` is what your platform's
// `identify` returned for this connection on the server, never a key or account the client sent.
function relayTyping(cw: Chatwarden, who: RawWho, roomId: string, seatId: string, tell: () => void): void {
  const { restricted, until, kind } = cw.chat.restricted(who, { roomId, seatId });
  if (restricted) return; // drop it quietly: do not broadcast their typing
  tell();
  void until; // epoch ms when it ends (null = permanent), only for the person's own sanction
  void kind; // 'chat', 'ban' or 'auto' (the automatic timeout), only for their own sanction
}
```

With both `roomId` and `seatId` the answer equals what `accept` would say for that seat. Leave them out and an
automatic timeout that was kept only in memory (the store could not take it, or a guest with no key and no account earned
it) is looked up by person instead; a guest cannot be found that way, because one guest cannot be told from another.
The `gate` option is not consulted: a gate refusal is not a restriction.

It is safe to answer a player about themselves from their own client, because it reveals nothing about anyone else. A
player who is restricted only because they share an address with someone else's sanction gets
`{ restricted: true, until: null, kind: null }`: they cannot chat, and they are told nothing about the other person. The
address checked is the one `seat` last recorded for the person (as in `accept`), not `who.ip`, and an address alone finds
nobody. A lookup that fails reads as `restricted: false` and is logged at most once a minute (error class only, with a count of
the failures held back).

## Browser support

The package imports no `node:` module, so a bundler (esbuild, Vite, webpack) builds it for a browser with nothing external and no
polyfill. Pair it with [`@chatwarden/store-memory`](https://github.com/hainix/chatwarden/tree/main/packages/store-memory), which
is also browser-safe, and with `@chatwarden/matcher` for the live matcher. That is what the repository's CI bundles and runs,
in a context with no `process`, `Buffer` or `require`, through a full report, decision and notice flow.

The hashing of client keys and IP addresses uses `node:crypto` when the runtime offers it (looked up at run time through
`process.getBuiltinModule`, never imported) and a small pure-JS SHA-256 and HMAC-SHA256 where it does not. Both give the same
bytes, and they match the hashes of 0.1.0, so moving a store between a server and a browser build never unlinks a stored hash.
The pure-JS path is slower, which only matters for a very large number of lookups. A browser build is meant for tests, demos and
tools; the kit still decides on a server you control, because anything running on a player's machine can be changed by that
player. `cw.chat.restricted(who, { roomId, seatId })` (see "Typing indicators") is a plain synchronous call and works the same
in a browser.

## Options

`createChatwarden(options)`. Only `store`, `secret` and `platform` are required.

| Option | What it does |
| --- | --- |
| `store` | Where moderation state lives, for example `openStore(...)` from `@chatwarden/store-sqlite`. |
| `secret` | Keys the client-key and IP hashes. Keep it stable: changing it unlinks every stored hash. |
| `platform` | `identify(ctx)` returns `{ clientKey?, accountId?, ip? }` for a connection; optional `notify(subject, event)` tells you a player has notices waiting. |
| `matcher` | Your slur matcher (`LiveTerms` from `@chatwarden/matcher`). Without one, nothing is ever blocked. |
| `profanity` | A ready profanity filter. What happens to a profane line is the profile's call (`allow`, `star` or `refuse`). |
| `profanityPackage` | `{ createProfanityFilter }` from `@chatwarden/profanity`; the kit builds the filter from the profile. Not used when `profanity` is given. |
| `clock` | `{ now() }`. Defaults to the system clock; tests pass their own. |
| `enabled` | A kill switch, read on every call. Return false to stop enforcement and report intake. |
| `gate` | `(roomId, subject) => boolean`: who may chat. False refuses the line with `'gate'`. |
| `onReport` | Told once for each stored report. It carries subject ids and the evidence: staff channels only. |
| `onAutoRestrict` | Told when a blocked line earned an automatic timeout. The same moment is also the `auto.restricted` event. |
| `retention` | How long rows are kept and how often the purge runs (every 6 hours by default), or `false` to run `purge()` yourself. Defaults: reports 90 days, strikes 30, notices 90, audit 365. Floors apply. |
| `profile` | `'relaxed'`, `'standard'` (default), `'strict'`, or your own profile from `defineProfile`. |
| `overrides` | Changes to the profile, merged onto it (`{ profanity: { mode: 'allow' } }`). A list you give replaces the preset's list. |
| `limits` | The numbers the kit enforces: line length and rate, strikes and timeouts, report limits. Each must be a whole number above 0. |
| `logger` | `{ warn(event, detail?) }`. Defaults to `console.warn`. It only ever receives an event name and an error class. |
| `rules` | The numbered Community Rules, from `defineRules`. Defaults to the preset's starter set. |
| `autoRestrictRule` | The rule number the automatic slur filter cites (default 1). Must be an active rule. |

Bad options throw at creation (`ProfileError`, `RangeError`), before the store is touched.

## Security notes

- **What is hashed.** A client key and an IP address are hashed with HMAC-SHA256 under your `secret` (the first 128 bits, with a
  separate key space for each kind) before they are stored or compared. The raw values are never written. An account id is not
  hashed: it is stored exactly as you give it, so pass an opaque id, never an email address or a name.
- **The secret.** Keep `secret` out of your repository and your logs. Anyone who holds both the secret and the database can
  test a guessed IP address against the stored hashes. Changing it unlinks everyone's history, so rotate it on purpose, not by accident.
- **What is never logged.** The kit never logs chat text, a client key, an IP address, a hash, a subject id, a term or a reason.
  A log line carries an event name and, at most, the error class (`chatwarden.purge_failed`, `error: 'Error'`). A logger that
  throws is swallowed and never breaks chat.
- **Subject ids are staff-only.** A subject id names a person. It appears in staff reads (`cw.reports`, `cw.decide`, `cw.history`,
  `cw.on` events, `onReport`) and in `platform.notify`, where you use it only on the server to find that player's connection.
  Never send a subject id to a player, a public channel or a browser. Everything meant for a player (`cw.notices`, the code of
  conduct, a refusal) is built without one.
- **Chat text is kept in two places only.** An evidence buffer in memory (the last 100 lines or 15 minutes of each room), and the
  excerpt copied into a report or a notice when one is made. Reports and notices are deleted by retention. A player's notice
  quotes only their own lines.
- **Moderators' words stay with moderators.** A decision's reason, a gap note, a reporter's note and a moderator's identity are
  never shown to a player.
- **The kit enforces nothing about who may call it.** It has no login. Put your own authentication in front of every staff read,
  which is what the `authorize` hook of `@chatwarden/http` is for.

## Links

- [Chatwarden on GitHub](https://github.com/hainix/chatwarden) and the [root README](https://github.com/hainix/chatwarden#readme)
- [`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http): routes for moderators and players, health probes, webhooks
- [`@chatwarden/store-sqlite`](https://github.com/hainix/chatwarden/tree/main/packages/store-sqlite), [`@chatwarden/matcher`](https://github.com/hainix/chatwarden/tree/main/packages/matcher), [`@chatwarden/profanity`](https://github.com/hainix/chatwarden/tree/main/packages/profanity), [`@chatwarden/discord`](https://github.com/hainix/chatwarden/tree/main/packages/discord)
- [Report a problem](https://github.com/hainix/chatwarden/issues)
- [Licence: Apache-2.0](https://github.com/hainix/chatwarden/blob/main/LICENSE)
