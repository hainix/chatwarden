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
  reason: 'harassment', // optional: a one-tap report with no reason is fine (see "Reporting settings")
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
| `cw.reports` | `submit` and `addDetail` (players; see "Reporting settings"), `list`, `get` and `reporterRecord` (staff). `reporterRecord(person)` is how the reports a person filed stand: `{ reports, open, actioned, dismissed, badFaith, suspendedUntil, reasonMatched, reasonDecided, accuracy }`. `reporterAccuracy(people)` is how often each person's recent reports turned out to be unfounded (see "Reporter accuracy"). |
| `cw.decide(input)` | A moderator closes a report and writes the sanctions and notices in one transaction. Safe to send twice. `reason` is required, except for a `no_action` with no actions (a one-click dismissal): leave it out and the standard reason `NO_ACTION_DEFAULT_REASON` (`No action needed`) is stored. |
| `cw.sanctions` | `apply` and `revoke`, for a moderator who acts without a report. `forPerson(subject)` and `list({ cursor?, limit?, source? })` (staff) read sanctions as `SanctionGroupView`s: one per group, built from the person's own row, so no IP, hash or stored value is in them. |
| `cw.blocked` | `list({ days })` and `countsByTerm({ days })` (staff), with `days` 1, 7 or 30: the lines the slur filter blocked, with the raw text, and the strikes per term. |
| `cw.reports.dismissMany(input)` | Staff, `@experimental`. "Nothing wrong here" for every open report about one person (`scope: { person }`, merged aliases included) or from one reporter (`scope: { reporter }`) in one call: at most 200 (`BULK_DISMISS_MAX`), `more: true` when there are more. Each report is closed like a single `no_action` decision with no actions and the standard reason (its own transaction, its own `report.closed` event); a bulk never marks bad faith and never counts toward a suspension. A case another moderator holds is skipped and counted unless `ignoreClaims`; `dryRun` counts and writes nothing. It writes no audit row: the staff layer does. Safe to run again. |
| `cw.cases` | The team workbench (staff): `claim(person, actor, { takeOver? })` and `release` a soft claim on a person's case (`releaseWhenDone` is what a decision does: it ends the claim only when the person has no other open report, so one case per person is held until its last report is decided), `next(actor, { category? })` to claim the oldest open case nobody holds, `holder` / `holders` to read claims, and `view` / `viewers` for who has a case open. A claim lasts 10 minutes from the last beat on your clock, lives in the store (so several server processes on one database agree, and two moderators racing for one case never both win), and is a courtesy: the core never refuses a decision because of one (the HTTP routes do). Viewing is a 30 second hint kept in this process's memory and never stored; it tracks only people with an open report, and one actor keeps at most 20 cases open. A claimer that loses a database lock race to another process is retried (3 attempts) and gets the normal "claimed" answer. |
| `cw.changes.token()` | A cheap, opaque change token for the queue. It differs after any report filed or decided, sanction applied or revoked, rule gap closed, claim taken, taken over or released, or saved reason changed, and is the same otherwise (a claim heartbeat does not move it). It is kept in the store, so a restart does not rewind it (the in-memory store is the exception: it starts again at "0"). |
| `cw.reasons` | Saved decision reasons (staff): `list`, `add({ label, text })`, `update(id, patch)` and `setActive(id, active)`. A label is up to 40 characters, a text up to 500 (counted as characters, an emoji is one), at most 200 reasons; a label holds no control character, a text none but a newline. |
| `cw.notices` | A player's pending notices, acknowledgements and "My record". Built so no identifier can leak. |
| `cw.doors` | `check` a person at the door (login, join) against bans. |
| `cw.names.check` | May a player use this as a name? |
| `cw.history`, `cw.suggest` | A person's recent record, and what the preset suggests as the next step. |
| `cw.rules`, `cw.profile`, `cw.limits`, `cw.summary`, `cw.documents` | The rules, standard and numbers in force, and the written code of conduct and guides. `cw.profile` and `cw.summary` are read live: the profile in force is your code's profile with the owner's stored edits on top (see "The editable profile"), so read it when you need it and never keep it. |
| `cw.policy` | The editable profile: `get`, `save`, `preview`, `reset` and `refresh`. The lengths a moderator is offered, the ladder, the first offences, the repeat rule, the area and severe rules and the guideline outcome texts can be edited at runtime and are stored in your store. |
| `cw.gaps`, `cw.audit` | Rule gaps for the periodic review, and the staff audit trail. |
| `cw.on(type, listener)` | Events: `report.created`, `report.closed`, `sanction.applied`, `sanction.revoked`, `gap.created`, `auto.restricted`. |
| `cw.purge`, `cw.ready`, `cw.flush`, `cw.close` | Housekeeping. |

## Deciding a report

A moderator reads a report and decides it with one call. `cw.decide` closes the report, writes the sanction, writes the player's
notice and tells the people involved, all in one transaction, and sending the same decision twice applies nothing twice.

```ts
import type { DecisionResult } from '@chatwarden/core';

// The moderator decides the open report: a warning that shows the player their latest line.
const report = cw.reports.list({ status: 'open' }).items[0]!;
const decided: DecisionResult = await cw.decide({
  reportId: report.id,
  verdict: 'upheld', // 'noted', 'no_action' and 'bad_faith' are the others
  actor: 'moderator@example.com', // who decided, for the audit trail
  reason: 'kept insulting a teammate', // private: a player never sees it
  actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 2, lineIds: report.ownLineIds[report.targetPerson]?.slice(-1) }],
});
console.log(decided.ok ? `applied ${decided.groups.length} action` : `not applied: ${decided.error}`);
```

`subject` is the staff reference the report names (`report.targetPerson`); it never goes to a player. `rule` must be an active Community
Rule, or `'uncovered'` with a `gapNote`. `lineIds` picks up to five of that player's own lines in the report to quote in their notice,
with blocked words starred out. A timeout is `kind: 'chat'` with `durationMs`. `cw.suggest(subject, level, rule)` says what the preset
would do next, for a moderator who wants a starting point. A failing store rejects the call, so catch it.

## The editable profile

The profile you give `createChatwarden` (a preset and `overrides`) is the **base**. An owner can change part of it while the game
runs: the lengths a moderator is offered (`durations`, and whether `customDuration` is allowed), the escalation `ladder`, the
`firstOffense` per conduct level, the `repeat` rule, `areaRules` and `severeRules`, and the outcome text of each written guideline
tier, and the reporting settings (see "Reporting settings"). The edits are a validated, versioned **layer** kept in your store, and `cw.profile` is the base with that layer on top.
Profanity handling is not editable: it stays in your code. Sanctions already given are not touched.

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { createMemoryStore } from '@chatwarden/store-memory';

const platform: Platform = { identify: (ctx) => ctx as { clientKey: string } };
const cw = await createChatwarden({ store: createMemoryStore(), secret: 'a-long-random-secret', platform, retention: false });

const HOUR = 3_600_000;
const { version } = cw.policy.get(); // 0 until something is saved

// What would this suggest for a clean record, a warning, a 24 hour restriction and a 7 day ban? Nothing is saved.
const layer = { durations: [HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR], firstOffense: { rude: { kind: 'chat' as const, durationMs: 6 * HOUR } } };
const preview = cw.policy.preview(layer);
if (preview.ok) console.log(preview.samples.clean.rude); // { label: 'Restrict chat 6 hours', kind: 'chat', durationMs: 21600000 }

// Save it. `version` is the one you loaded: if someone saved since, the answer is { ok: false, error: 'conflict' }.
const saved = cw.policy.save(layer, { version, actor: 'owner@example.com', reason: 'offer shorter timeouts' });
if (saved.ok) console.log(cw.profile.durations, saved.changed); // in force at once, here

cw.policy.reset('durations'); // put one section back to the base; reset() puts everything back
```

- **`cw.policy.get()`** returns `{ effective, base, layer, version, canSave }`. `layerError` (`{ path, kind }`) is also there when the stored layer
  cannot be used: it is then ignored, the base stays in force, and one `chatwarden.policy_layer_invalid` line is logged. `kind` is `'unreadable'`
  when the stored text could not be read at all (corrupted, not JSON, not an object), so the owner's edits are gone until they save again, and
  `'invalid'` when it was read but a setting is not valid (a field from a newer kit, say). A save or a full `reset()` repairs either.
- **`save(layer, { version, actor, reason })`** stores the whole layer: a section you leave out goes back to the base. It answers
  `{ ok: true, version, changed }`, `{ ok: false, error: 'conflict' }` for a stale `version` (nothing is written),
  `{ ok: false, error: 'invalid', path }` for a layer that touches a setting that is not editable or would make the profile invalid
  (`path` names the field, such as `layer.profanity` or `layer.ladder[2].high.durationMs`; no value), and
  `{ ok: false, error: 'unsupported' }` when the store has no `loadPolicyLayer` and `savePolicyLayer`. `actor` and `reason` are
  checked here; `@chatwarden/http` writes them to the audit trail.
- **`guidelines` is positional.** Entry `i` of the layer's `guidelines` list is the new `outcome` text for tier `i` of the profile's
  own `guidelines` (`null` leaves a tier alone). If you reorder or add tiers in the profile in your code, stored texts keep their
  positions, so they land on the wrong tiers: reset `guidelines` (or save it again) after such a change. A stored list longer than the
  profile's tiers is unusable and reported as `layerError`.
- **Whole outcomes.** An outcome written as an object in a layer (`firstOffense`, `repeat.outcome`) needs both `kind` and `durationMs`, so a
  stored layer never changes meaning when your base profile does. `areaRules` and `severeRules` list at most 100 rule numbers each.
- **Types.** `ModerationProfile` is what you write; `durations` and `customDuration` are optional in it, so a profile written for 0.1.1 still
  compiles and works everywhere (`validateProfile`, the document functions, `defineProfile`, `createChatwarden`). What the kit hands back
  (`cw.profile`, `cw.policy.get()`, `defineProfile`, `resolveProfile`) is a `ResolvedProfile` with both filled in, and `cw.documents.policyJson()`'s
  `profile` therefore has the two keys even for a profile that had none.
- **Audit.** A save and a reset are recorded by `@chatwarden/http` as `policy.update` and `policy.reset` rows whose `detail` is
  `{ sections, reason? }`. If you write your own `Store`, keep and return that `detail` from `insertAudit` and `listAudit`.
- **A ladder cell without a `label`** gets one from its kind and length: "Restrict chat 6 hours", "Ban from public rooms 12 hours",
  "Full ban 3 days", "Full ban permanent".
- **`durations`** is a sorted list of lengths, each from 1 millisecond to 365 days, at most 50. It is only the list a moderator is offered:
  `cw.decide` and `cw.sanctions.apply` still accept any valid length. The staff routes in `@chatwarden/http` refuse a length outside
  the list (400 `duration_not_offered`) when `customDuration` is false.
- **Other processes** see a save within 10 seconds: a read of the profile looks at the stored version at most that often, on your
  `clock`. `cw.policy.refresh()` looks now.
- **Your own store.** `loadPolicyLayer()` and `savePolicyLayer(layer, expectedVersion)` are optional on `Store`. The second must be
  one atomic conditional write that returns the new version, or `null` when the stored version is not `expectedVersion`. A store
  without them still works; `save` and `reset` answer `unsupported` and the profile stays code-only.

## Reporting settings

How players report is part of the profile, so it has defaults and an owner can edit it with the rest (`cw.policy`, section `reporting`). Nothing
is required: a profile that says nothing about reporting gets the defaults.

- **`flow`**: `'one_tap'` (the default: one step, where the player may pick a reason and add a note in the same dialog and neither is needed), `'reason_first'`
  (the screen asks for a reason first; the kit takes a report with no reason all the same, only the screen differs) or `'reason_required'`
  (a report with no reason is refused `reason_required`).
- **`reasons`**: the ordered list a player picks from, 1 to 20 of them. Each is `{ id, label, hint, group, rules, asksNote, enabled }`; only
  `id` (a unique lowercase slug) and `label` are needed when you write one. `rules` are the Community Rule numbers the reason usually
  means: the first citable one is the rule a moderator is suggested, and a decision under any of them counts as "matched" for the reporter's
  accuracy. At least one reason must be on, and `other` can be relabelled and re-mapped but not removed or switched off. The defaults, in
  order: **Chat**: `harassment` (Insults or harassment, CR 2), `hate` (Hate, CR 1), `sexual` (Sexual content, CR 3), `threat` (Threats, CR 2),
  `spam` (Spam or ads, CR 4), `personal_info` (Sharing personal info, CR 2); **Gameplay**: `cheating` (Cheating, CR 5), `griefing` (Throwing or
  griefing, CR 6), `afk` (Leaving or AFK, CR 6); then `other` (Something else, asks for a note).
- **`thanks`**: what the reporter is told afterwards. Default "Thanks for the report. We'll look into it."

```ts
// One tap, no reason: accepted. (This is the default flow.)
await cw.reports.submit({ roomId: 'lobby', reporterSeat: 'seat-1', targetSeat: 'seat-2' });

// A reason the studio did not list, or switched off, is refused in every flow.
await cw.reports.submit({ roomId: 'lobby', reporterSeat: 'seat-1', targetSeat: 'seat-3', reason: 'not_a_reason' }); // { ok: false, refused: 'reason_unknown' }

// A follow-up of your own (the kit's dialog sends the reason and note with the report): add them to an existing report.
const res = await cw.reports.addDetail(reportId, 'seat-1', { reason: 'cheating', note: 'speed hacking in the last round' });
// { ok: true }, or { ok: false, refused: 'not_found' | 'not_reporter' | 'too_late' | 'already_added' | 'reason_unknown' | 'off' }
```

- **The reason is a hint, never the truth.** It is stored as `reportedReason` (a reason id, or null). What settles a case is the moderator's decision,
  or later the AI read. The staff views show it as "Reported as ..." or "No reason given", and a report with no reason shows the lines and asks the
  moderator which rule applies.
- **`submit` refusals**, in order: `off`, `reason_required`, `reason_unknown`, `not_player`, `self`, `suspended`, `rate`, `duplicate`. A refused reason
  counts against nothing. The reason is read from the profile at that moment, so an edit applies to the next report.
- **`addDetail(reportId, reporterSeat, { reason?, note? })`** attaches the follow-up to the report. Only the reporter can add it: `reporterSeat` must be
  the seat the report was filed from and must still hold the reporter in that room. It works once, within ten minutes of the report (exactly ten is
  in time), and only while the report is open. It never changes the target or the excerpt. A reason given replaces the reported reason; a note replaces the
  note; one left out keeps what was there. Refusals: `off` (the kit is off, your store does not support follow-ups because it has no `addReportDetail`, or the store failed), `not_found`, `not_reporter`,
  `too_late`, `already_added`, `reason_unknown`. A call that gives neither a reason nor a note answers `ok: true` and does not use up the one allowed.
- **The kit has no player report route.** You call `cw.reports.submit` from your own route, and you do the same for `addDetail`: take the reporter's
  seat from your own session (never from the request body) and the report id from what `submit` answered, and pass the player's choice through. The
  player route `GET /rules` in `@chatwarden/http` hands the report screen its flow, enabled reasons and thank-you.
- **Reporter false-report rate.** `cw.reports.reporterAccuracy(people)` (and `reporterRecord(person).accuracy`) reads the reports a person filed in the last 30 days (by filing time) that are no longer open: `decided` is upheld or noted (`actioned`) plus dismissed (`noAction`) plus dismissed with the bad-faith mark (`badFaith`), `unfounded` is `noAction + badFaith`, and `falseRate` is `unfounded / decided`, or null below 5 decided reports. `noticeable` is a rate of 0.6 or more and `habitual` 0.8 or more. It is one grouped store read for up to 200 people (a store that leaves out `reporterOutcomes` shows none). It is a ranking hint and a line on the case, never a reason to refuse a report or to suspend anyone, and it is staff only: it never reaches a player.
- **Reporter accuracy.** `cw.reports.reporterRecord(person)` adds `reasonDecided` (decided reports they filed that named a reason) and `reasonMatched` (those
  where the decision cited, against the reported person, a rule in the reason's `rules`). A dismissal never matches. A reason that is no longer in the
  list, and one that maps to no rule (`other` by default, so an honest "Something else" is never counted as inaccurate), cannot be judged and are left out; a
  switched-off one still counts. It reads the newest 200 decided reports. It is read against the reasons in force now. It is a signal for moderators
  and is never used to refuse a report.
- **From 0.1.1.** `ReportInput.category` is still accepted as an alias of `reason` (the six old ids are valid reasons, `disruption` reads as `griefing`),
  and `reason` wins when both are given; a blank `reason` falls back to `category`. A report's stored `category` is still one of the six old ids, derived from its reason (`'other'` when none), so
  code that reads it keeps working; `ReportCategory` is unchanged. The alias keeps its 0.1.1 leniency: a `category` that is not an enabled reason (unknown, not text, or switched off) is taken and stored as
  `'other'`, as before. Only the new `reason` field is refused (`reason_unknown`). Reports stored before 0.1.2 read their old category as their `reportedReason`.
  **Upgrading:** `ReportRefusal` has two new members (`reason_required`, `reason_unknown`), `addDetail` has its own result type, and `layerError` gains a required
  `kind`; an exhaustive `Record<ReportRefusal, ...>` or a `switch` with a `never` check over them needs the new cases to compile.
- **Your own store.** `addReportDetail` and `loadReporterDecisions` are optional on `Store`. Without the first, `addDetail` answers `off`; without the
  second, the accuracy counts are 0. `insertReport` must keep `reportedReason`, and `listReports` must apply the `reason` filter (`null` means none).

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
