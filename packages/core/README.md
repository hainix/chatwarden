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
| `cw.rooms` | `seat`, `seatConnection`, `unseat`, `close`: who is in which seat of which room. `setPace(roomId, pace)` and `pace(roomId)` (`@experimental`) give one room its own slow mode, burst limit and repeat rule, in this process only. See "Slow mode and flood control". |
| `cw.chat.accept(room, seat, text)` | The answer for one line: `{ deliver }` or `{ refuse: { reason } }`. `visibleTo` applies a viewer's mutes. `restricted(who)` says whether a person is chat-restricted, for typing indicators; `restrictedBySubject(subject)` (`@experimental`) says the same for a subject id from `cw.rooms.subjectAt`, so a server that keeps a connection open need not keep the player's key to ask again. |
| `cw.mutes` | A player mutes another player for themselves only. |
| `cw.signals` | `@experimental`. What your game records about a player, counted by distinct source: `record`, `counts`, `kinds`, `boosted`, `forRecord`. See "Signals". |
| `cw.reports` | `submit` and `addDetail` (players; see "Reporting settings"), `list`, `get` and `reporterRecord` (staff). `reporterRecord(person)` is how the reports a person filed stand: `{ reports, open, actioned, dismissed, badFaith, suspendedUntil, reasonMatched, reasonDecided, accuracy }`. `reporterAccuracy(people)` is how often each person's recent reports turned out to be unfounded (see "Reporter accuracy"). |
| `cw.decide(input)` | A moderator closes a report and writes the sanctions and notices in one transaction. Safe to send twice. `reason` is required, except for a `no_action` with no actions (a one-click dismissal): leave it out and the standard reason `NO_ACTION_DEFAULT_REASON` (`No action needed`) is stored. |
| `cw.sanctions` | `apply` and `revoke`, for a moderator who acts without a report. `forPerson(subject)` and `list({ cursor?, limit?, source? })` (staff) read sanctions as `SanctionGroupView`s: one per group, built from the person's own row, so no IP, hash or stored value is in them. |
| `cw.blocked` | `list({ days })` and `countsByTerm({ days })` (staff), with `days` 1, 7 or 30: the lines the slur filter blocked, with the raw text, and the strikes per term. `names({ days })` (`@experimental`) lists the blocked names kept as evidence with `names.keepBlocked`. |
| `cw.reports.dismissMany(input)` | Staff, `@experimental`. "Nothing wrong here" for every open report about one person (`scope: { person }`, merged aliases included) or from one reporter (`scope: { reporter }`) in one call: at most 200 (`BULK_DISMISS_MAX`), `more: true` when there are more. Each report is closed like a single `no_action` decision with no actions and the standard reason (its own transaction, its own `report.closed` event); a bulk never marks bad faith and never counts toward a suspension. A case another moderator holds is skipped and counted unless `ignoreClaims`; `dryRun` counts and writes nothing. It writes no audit row: the staff layer does. Safe to run again. |
| `cw.cases` | The team workbench (staff): `claim(person, actor, { takeOver? })` and `release` a soft claim on a person's case (`releaseWhenDone` is what a decision does: it ends the claim only when the person has no other open report, so one case per person is held until its last report is decided), `next(actor, { category?, reason?, rankDownHabitual? })` to claim the oldest open case nobody holds (with `rankDownHabitual`, a case whose open reports all come from habitual false reporters and none has waited 24 hours is served after the ordinary ones, never skipped for good), `holder` / `holders` to read claims, and `view` / `viewers` for who has a case open. A claim lasts 10 minutes from the last beat on your clock, lives in the store (so several server processes on one database agree, and two moderators racing for one case never both win), and is a courtesy: the core never refuses a decision because of one (the HTTP routes do). Viewing is a 30 second hint kept in this process's memory and never stored; it tracks only people with an open report, and one actor keeps at most 20 cases open. A claimer that loses a database lock race to another process is retried (3 attempts) and gets the normal "claimed" answer. |
| `cw.changes.token()` | A cheap, opaque change token for the queue. It differs after any report filed or decided, sanction applied or revoked, rule gap closed, claim taken, taken over or released, or saved reason changed, and is the same otherwise (a claim heartbeat does not move it). It is kept in the store, so a restart does not rewind it (the in-memory store is the exception: it starts again at "0"). |
| `cw.reasons` | Saved decision reasons (staff): `list`, `add({ label, text })`, `update(id, patch)` and `setActive(id, active)`. A label is up to 40 characters, a text up to 500 (counted as characters, an emoji is one), at most 200 reasons; a label holds no control character, a text none but a newline. |
| `cw.notices` | A player's pending notices, acknowledgements and "My record". Built so no identifier can leak. |
| `cw.doors` | `check` a person at the door (login, join) against bans. |
| `cw.names` | `check(text, opts?)`: may a player use this as a name? (`name_not_allowed`, and `name_profane` with `names.profanity`). `@experimental` since 0.1.9: `flagged`, `requireRename`, `pendingRename`, `renamed`, `renamesEnabled`, `renamesOf`. See "Names". |
| `cw.appeals` | `@experimental`. Appeals against sanctions: `file`, `mine` (players), `list`, `get`, `decide`, `stats`, `openCount`, `forPerson` (staff). Off until `appeals.enabled`. See "Appeals". |
| `cw.people` | `canonical`, `aliases`, and `accountIds(subject)` (`@experimental`, staff, server side only): the account ids you passed as `RawWho.accountId` for that person, so a game can find the player to rename. |
| `cw.history`, `cw.suggest` | A person's recent record, and what the preset suggests as the next step. |
| `cw.rules`, `cw.profile`, `cw.limits`, `cw.summary`, `cw.documents` | The rules, standard and numbers in force, and the written code of conduct and guides. `cw.profile` and `cw.summary` are read live: the profile in force is your code's profile with the owner's stored edits on top (see "The editable profile"), so read it when you need it and never keep it. |
| `cw.policy` | The editable profile: `get` (it also reports `limits`, read only: the chat rate in force and the signals retention), `save`, `preview`, `reset` and `refresh`. The lengths a moderator is offered, the ladder, the first offences, the repeat rule, the area and severe rules and the guideline outcome texts can be edited at runtime and are stored in your store. |
| `cw.gaps`, `cw.audit` | Rule gaps for the periodic review, and the staff audit trail. |
| `cw.on(type, listener)` | Events: `report.created`, `report.closed`, `sanction.applied`, `sanction.revoked`, `gap.created`, `auto.restricted`, and, new in 0.1.9, `appeal.created`, `appeal.decided` and `rename.required` (`@experimental`; ids, codes and times only, never a statement, a reason or a name). |
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
  `layer` is the layer in force: a stored signal feed that can no longer be used (its kind is no longer declared in code, or its window is longer
  than `retention.signalsMs` now allows) is dropped alone, the rest of the layer stays, and `dropped` (`[{ feed, reason }]`, a feed name and a reason
  code, never a kind or a rule id; `@experimental`) says what went. Send `layer` back to `save` and it is accepted and repairs the stored row.
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

## What is experimental in 0.1.8

These may change before 0.2, and are marked `@experimental` in the types: `PaceSettings`, `ResolvedPace`, `resolvePace`, `mergePace`, `checkPace`,
`PACE_SUGGESTIONS`, `cw.rooms.setPace`, `cw.rooms.pace`, `cw.signals` and every signal type (`SignalInput`, `SignalCount`, `SignalSettings`, the feeds,
`PolicyDropped`, `PolicyLimits`, `PolicyState.limits` and `.dropped`), `SuggestContext.hideSignalText`, `Suggestion.signals`, `signalBoost` in
`cw.cases.next`, `BUILTIN_SIGNAL_KINDS`, `withMemorySignals`, the `pace` prop of `RestrictedChatLine` and `secondsLeft` in `@chatwarden/player-react`.

## What is experimental in 0.1.9

These may change before 0.2, and are marked `@experimental` in the types: `AppealSettings`, `ResolvedAppeals`, `resolveAppeals`, `cw.appeals` and every appeal type
(`PlayerAppeal`, `AppealFileResult`, `AppealRefusal`, `AppealDecision`, `AppealDecideResult`, `AppealSummary`, `AppealDetail`, `AppealPage`, `AppealStats`,
`AppealRuleStats`, `AppealRow`), `normalizeStatement`, `NameSettings`, `ResolvedNames`, `resolveNames`, `cw.names.flagged`, `cw.names.requireRename`,
`cw.names.pendingRename`, `cw.names.renamed`, `cw.names.renamesEnabled`, `cw.names.renamesOf`, `cw.blocked.names`, `BlockedNameRow`, `cw.people.accountIds`,
the `appeals` and `names` profile sections, the events `appeal.created`, `appeal.decided` and `rename.required`, the optional `Store` methods for appeals,
blocked names and `withdrawNotice`, `withMemoryAppeals` and `withMemoryNames`, and, in the other packages, `AppealDialog`, `nameReasonText` and the
`appeals` prop of `NoticeQueue` and `MyRecord` in `@chatwarden/player-react`, `appealsRateLimit` and `includeAccounts` in `@chatwarden/http`, and the
Appeals and Names screens of `@chatwarden/hub-react`. The names a game already used (`cw.names.check` and its reasons, `cw.notices`, `cw.sanctions`) are
not experimental, but some of their unions are wider now: see "Upgrading to 0.1.9".

## Slow mode and flood control

Optional and off until you set it, `@experimental` until 0.2 and new in 0.1.8. Three checks pace one player's lines in one room: **slow mode**
(at least `slowModeMs` between lines, 500 to 600 000), a **burst limit** (at most `burst.lines` lines in any `burst.windowMs`: 2 to 100 lines
in 1 000 to 600 000 ms) and **repeats** (the same line again inside `duplicateWindowMs`, 1 000 to 3 600 000, is refused). Set them in code with
`overrides.pace`, or the owner sets them in the hub (Settings, Advanced, "Slow mode and flooding"); the stored layer wins over code. The presets set
nothing, so no install changes by itself.

```ts
import { createChatwarden } from '@chatwarden/core';
import { createMemoryStore } from '@chatwarden/store-memory';

const cw = await createChatwarden({
  store: createMemoryStore(),
  secret: 'a-long-random-secret',
  platform: { identify: (ctx) => ctx as { clientKey: string } },
  overrides: { pace: { slowModeMs: 2000, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: 15_000 } },
});

// One room that differs, in this process, until the room closes: a tournament final is slower, a practice room is not paced at all.
cw.rooms.setPace('tournament:final', { slowModeMs: 3000 });
cw.rooms.setPace('practice', { slowModeMs: null, burst: null, duplicateWindowMs: null });
console.log(cw.rooms.pace('tournament:final')); // the pace in force there: the defaults with the override on top
```

- **A refusal, not a sanction.** `cw.chat.accept` answers `{ refuse: { reason, retryAfterMs } }` with `reason` `'slow_mode'`, `'flood'` or
  `'duplicate'`, and `retryAfterMs` (at least 1) is when the same player may try again, in milliseconds from now. There is no rule, no notice and no
  text with it. **A new refusal reason**: a `switch (reason)` that ends in `assertNever` will not compile until it handles the three, though a kit
  can only send them after you turn pacing on. The staff routes and the chat box carry them through (`@chatwarden/http`, `@chatwarden/player-react`).
- **The order.** After the length check and before the fixed rate limit, so a player hammering a slow-mode room reads "slow mode" and not "too fast". A
  line the fixed rate refuses does not count toward pacing, and a refusal never changes pacing state (repeating a refused line cannot extend its own
  block). Repeats compare the line with letters and digits only, case and width folded and combining marks kept, so `gg` and `ok` (under three
  characters) are never repeats; only a short digest is kept, never the text.
- **Per process.** Pacing state lives in memory in the process that serves the room and is lost on restart, like the fixed rate limit. Route a room's
  chat to one process for the full effect; send one player's lines to several and the effective limit is up to that many times looser. Nothing is shared
  or written, by design: a store round trip per line is the cost this exists to avoid. At most 50 000 (room, player) states are kept (`PACE_KEYS_MAX`).
  `cw.rooms.setPace` is per process as well: call it where you create the room, in each process that serves it.
- **A burst looser than the fixed limit never triggers.** `limits.chatRate` (3 per 5 seconds by default) answers first inside the same window; the hub
  says so beside the field, with the real numbers (`cw.policy.get().limits.chatRate`).
- **Flooding is remembered.** When the burst limit trips, the built-in signal `flood_triggered` ("Flooded the chat") is recorded for that player in that
  room, at most once a window, whether or not you declared any signals (see "Signals"). It needs a store with the signal methods, else it is skipped.
- **Suggested values.** `PACE_SUGGESTIONS` (relaxed: burst 10 in 10 s, repeats 10 s; standard: 6 in 10 s, 15 s; strict: slow mode 2 s, 5 in 10 s, 30 s) is
  what the hub's "Use suggested values" button fills in; nothing applies them by itself. `resolvePace`, `mergePace` and `checkPace` validate and merge.
- **To try it**, run `examples/tiny-chat` with `CW_DEMO_PACE=1` (a 2 second slow mode) and open the page.

## Signals

Optional, `@experimental` until 0.2 and new in 0.1.8. A signal is one fact your game records about a player ("muted by another player", "kicked from a
room", "left mid-game"). The kit counts them by distinct source and shows the counts where a profile rule says so. **A signal never acts on its own: it
never writes a sanction, a mute or a notice, and a person always decides.** Nothing is recorded or shown until you declare kinds and switch a feed on.

```ts
import { createChatwarden } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';

const cw = await createChatwarden({
  store: openStore({ path: './chatwarden.db' }),
  secret: process.env.CHATWARDEN_SECRET!,
  platform: { identify: (ctx) => ctx as { clientKey: string } },
  overrides: {
    signals: {
      kinds: {
        muted_by_player: { label: 'Muted by other players', polarity: 'negative' },
        kicked_from_room: { label: 'Kicked from a room', polarity: 'negative', weight: 2 },
        commended: { label: 'Commended by other players', polarity: 'positive' },
      },
      feeds: { record: { kinds: '*', windowDays: 14 } },
    },
  },
});

// From the game's own events, never from every chat line: one small write each.
const player = { clientKey: 'a-client-key' };
const muter = { clientKey: 'another-client-key' };
cw.signals.record({ kind: 'muted_by_player', subject: player, by: muter, roomId: 'lobby-7' });
console.log(cw.signals.counts(cw.rooms.subjectAt('lobby-7', 'p1') ?? 's_unknown'));
```

- **Kinds are code.** A kind id is a lower-case slug (`muted_by_player`); the label is plain text, 1 to 60 characters; `polarity` is `'negative'` or `'positive'`;
  `weight` is 0 to 10 (default 1). The kit declares one itself, `flood_triggered`, which you may relabel or re-weight but not make positive.
- **`cw.signals.record(input)`** is synchronous, fenced and never throws: it returns `true` when a row was written and `false` for any refusal
  (logged by reason code, at most once a minute, never an id). `subject` and `by` are a subject id the kit already knows or a `RawWho`
  (`{ clientKey?, accountId?, ip? }`, each under 513 characters) that it has already seen: a stranger is refused, never created. `by`, `roomId` and `at`
  may be left out or `null`. A player cannot signal themselves (also across a merge), `at` may not be more than 5 minutes ahead or older than the
  retention, and `roomId` is the game's own id: 1 to 64 of `A-Z a-z 0-9 _ . : -` (the built-in flood row uses a digest of a room id that does not fit).
- **Events, not lines.** Record what happens in your game (a mute, a kick), not every chat line: each record is a store write.
- **Counting is by distinct source.** A source is the `by` player; with no `by`, the room; with neither, the UTC day. A thousand mutes from one
  player are one source. At most one row per kind, subject and source per `guards.perByWindowMs` (a day by default): the cap is a calendar bucket
  (`floor(at / perByWindowMs)`), not a rolling window, so two rows a millisecond apart across a bucket edge both count, and changing the window later
  re-buckets old rows. The optional `signals.accountAgeDays` hook (asked at most once a minute per player) with `guards.newAccount` makes a new account
  count for a fraction of one. What this cannot stop is several real accounts that agree to signal one player: that is why a signal never acts.
- **Four feeds** (`profile.signals.feeds`, each off until set, editable in the hub: Settings, Advanced, "Signals"; a layer's `feeds` replaces the code's
  wholesale): **`record`** (counts on the Person page), **`queue`** (a person who meets a threshold is taken ahead of older ordinary cases, capped, and an
  overdue case still comes first), **`ladder`** (rules that add a sentence to the suggested step, or raise it one step; negative kinds only for a raise)
  and **`ai`** (the counts as background for the AI read). A threshold is `kinds`, `minDistinct` (1 to 50), `windowDays` (1 to 90 and not above
  `retention.signalsMs`) and an optional `minWeight`.
- **Retention.** Signal rows are kept 90 days by default (`retention.signalsMs`, never less than 14); a feed window longer than that is refused, in code
  and in the hub, which reads the number from `cw.policy.get().limits.signalsMs`. A stored feed that can no longer be used (its kind is gone, or its window
  is now too long) is dropped alone and reported as `dropped` on `cw.policy.get()`; the rest of the layer stays.
- **Your store needs the signal methods** (`insertSignal`, `listSignalSources`, `purgeSignals`, optional on `Store`). The SQLite store has them (migration 21,
  one-way: back up the database before upgrading, since 0.1.7 and older tools cannot read a database 0.1.8 has opened); the in-memory store has them only through
  `withMemorySignals(store)`. Without them `record` answers `false` and logs `chatwarden.signals_store_unsupported` once, and declaring kinds or feeds throws at
  creation. The kit loads the signal code only for a store that has the methods.
- **Reads** (staff only, never to a player): `cw.signals.counts(subject, { windowDays?, kinds? })`, `kinds()`, `boosted(people)` and `forRecord(subject)`.
  The `@chatwarden/http` routes read them for you and show a count only to a role that holds `history.read`.

## Appeals

Optional and off until you turn it on, `@experimental` until 0.2 and new in 0.1.9. A player who thinks a sanction was a mistake asks for a second look from
the notice they were sent. A moderator reads what they wrote and keeps the decision, makes it lighter or removes it, and the player gets a plain message with
the outcome. Appeals are not a second queue: in the hub they are a view of the Cases screen.

```ts
import { createChatwarden, type RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';

const cw = await createChatwarden({
  store: openStore({ path: './chatwarden.db' }),
  secret: process.env.CHATWARDEN_SECRET!,
  platform: { identify: (ctx) => ctx as RawWho },
  overrides: { appeals: { enabled: true, perPlayerPerWeek: 3 } },
});

// The player files from one of their own sanction notices. `who` is what your game knows about them.
const who: RawWho = { clientKey: 'a-client-key' };
const notice = cw.notices.pending(who).find((n) => n.kind === 'chat');
if (notice !== undefined) {
  const filed = cw.appeals.file(who, { noticeId: notice.id, statement: 'It was a joke between friends, and we had stopped.' });
  console.log(filed.ok ? 'sent' : filed.refused);
}

// A different moderator decides: uphold, reduce (with the lighter outcome in `to`) or revoke. The reason is private.
const waiting = cw.appeals.list({ status: 'open' }).items[0];
if (waiting !== undefined) {
  const result = await cw.appeals.decide({
    appealId: waiting.id,
    outcome: 'reduce',
    actor: 'second.moderator@example.com',
    reason: 'A warning is enough for a first offence.',
    to: { kind: 'warning', durationMs: null },
  });
  console.log(result.ok ? result.status : result.error);
}
```

- **Turning it on.** `overrides.appeals` takes `enabled` (default `false`), `perPlayerPerWeek` (1 to 20, default 3) and `allowSelfReview` (default `false`), or
  the owner sets them in the hub (Settings, Advanced). With appeals off every appeal route answers as if it did not exist, a notice keeps the old
  `appealUrl` link if you gave one, and no response body changes. `appeals.enabled: true` over a store with no appeal methods throws when the kit is created.
- **What can be appealed.** A warning, a chat restriction, an area ban or a full ban that is in the player's record (the same 90-day rule "My record" uses), from
  its notice. A report outcome, a note and the four message notices (below) cannot. There is one appeal for each sanction for as long as it is kept. A sanction
  made lighter on appeal is a new sanction with its own notice, and can be appealed once.
- **The statement.** It is the one new free text a player writes: at most `APPEAL_STATEMENT_MAX` (1000) characters, refused when over and never cut. The kit
  cleans it first (`normalizeStatement`: control, bidirectional, zero-width and other invisible characters and stray surrogates are removed, blank-line runs
  collapse, the text is trimmed) and counts what is left in code points. It is kept in the appeal row and nowhere else: never in an event, a webhook, a
  Discord post, a log line, an audit row or an AI prompt. Staff read it only through `cw.appeals.get`, which the staff routes audit, and the hub masks it
  when it trips the term filter. It is cleared 90 days after the decision (`retention.appealStatementsMs`; 0 clears it at the decision) and the row is deleted
  after 365 days (`retention.appealsMs`, never less than 90). An open appeal keeps its statement until it is decided.
- **Filing.** `cw.appeals.file(who, { noticeId, statement })` answers `{ ok: true, appeal }` or `{ ok: false, refused }`, with `refused` one of `off`,
  `not_found` (one answer for a notice that is not theirs and one that does not exist), `not_appealable`, `statement_invalid`, `already_appealed` and `rate`
  (with `retryAfterMs`), checked in that order. A refusal writes nothing. `cw.appeals.mine(who)` lists the player's own appeals, newest first. What a player
  gets back is an id, the notice id, a status and two times: no staff ref, no reason and no sanction or person id.
- **Deciding.** `cw.appeals.decide({ appealId, outcome, actor, reason, to? })` is one transaction. `uphold` keeps the sanction. `revoke` lifts it and withdraws
  its notice. `reduce` needs `to`: a lower kind, or the same kind and shorter (permanent is the longest), and the replacement keeps the original start time, so
  the ladder's 90-day lookback does not restart. Each outcome tells the player through a notice of kind `appeal_upheld`, `appeal_reduced` or `appeal_revoked`
  (`reduce` also sends the replacement's own notice). It answers `{ ok: true, status, replacementGroupId? }` or `{ ok: false, error }` with `error` one of
  `not_found`, `already_decided` (a second call, or the loser of a race, writes nothing), `invalid`, `same_decider` and `gone`. An appeal whose sanction someone
  else revoked while it was open is closed as `moot`: nobody ruled on it, the player is sent nothing more, and a decide on it answers `gone`.
- **One login per person.** The kit refuses `same_decider` when `actor` is the staff ref that made the original decision, unless `appeals.allowSelfReview` is on.
  It compares staff refs, so a team that shares one login looks like a team of one and the rule cannot hold: give each moderator their own login and `actor`.
  A sanction the kit gave by itself (an automatic timeout) has no human decider and any holder of the permission may decide its appeal. A team of one sets
  `allowSelfReview`, or lowers who may decide with `permissions` in `@chatwarden/http`.
- **The mistake rate.** `cw.appeals.stats({ days })` (30, 90 or 365; 90 by default) gives, for each rule, the sanctions given, the appeals filed, how many were
  revoked (`granted`), how many were reduced (`lightened`), a `rate` and a `band`. **A reduction is not a false positive**: it disputes how severe a sanction
  was, not whether it was right, so it is counted as `lightened`, shown beside the rate and never inside it. `rate` is `granted` over `sanctions`, and is
  `null` below `APPEAL_STATS_MIN_SANCTIONS` (10) sanctions. The band is `elevated` from `APPEAL_RATE_ELEVATED` (0.15) and `high` from `APPEAL_RATE_HIGH` (0.30). The
  hub shows it only behind Settings, Advanced, "Mistakes by rule", never on a queue or a card.
- **What a decided appeal teaches the AI.** All of it is a no-op without `ai`. A reduce or a revoke marks the original decision reversed, so it stops being a
  standard example. A revoke also keeps the decision's pseudonymised lines as one corrective example (the opposite sign: "a moderator acted on this, and a
  second moderator decided on appeal that it was not a violation"). The stats of `cw.ai.stats()` change with it: **an AI false positive is a recommendation to
  act where the moderator chose no action or a revoke corrected it; a reduce is not one.** Rules at the elevated or high band are given to the read as a caution
  (the rule number and the band word, never a rate, a count or a person), outside the input hash. The statement never reaches the AI. This changes the prompt
  (version 4): see "The AI (levels 1 and 2)" for what that costs once, on upgrade.
- **Events.** `appeal.created` and `appeal.decided` are announced after the commit, never for a refusal and never for a `moot` closure. Like `report.created`
  they carry ids, codes and times, and never the statement, the reason or the player's handle. `@chatwarden/http` can send them as webhooks and
  `@chatwarden/discord` posts them.
- **Your store needs the appeal methods.** The SQLite store has them (migration 22, which is one-way: back up the database before upgrading, since 0.1.8
  and older tools cannot read a database 0.1.9 has opened); the in-memory store has them only through `withMemoryAppeals(store)`. For a store you wrote:
  every appeal method is optional on `Store`. Also optional, and worth adding: `closeOrphanAppeals` (without it an appeal whose sanction rows retention removed
  stays open and cannot be decided), the trailing `clearStatement` argument of `decideAppeal` and `closeAppealsForGroup` (without it a statement is cleared at
  the next purge, not at the decision), and the second argument of `purgeNotices(before, unseen?)`, the ceiling for an unseen message notice (a store that
  ignores it keeps an unseen appeal outcome or rename request until the player sees it).

## Names

Optional, `@experimental` until 0.2 and new in 0.1.9, except that `cw.names.check` has been here since 0.1.0 and keeps its contract. This part checks a name
more closely, can keep a blocked name as evidence, lets a moderator ask a player to choose a new name, and hides a name the word list flags in the hub.

```ts
import { createChatwarden, type RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';

const cw = await createChatwarden({
  store: openStore({ path: './chatwarden.db' }),
  secret: process.env.CHATWARDEN_SECRET!,
  platform: { identify: (ctx) => ctx as RawWho },
  overrides: { names: { profanity: true, keepBlocked: true, renames: true } },
});

// At sign-up: may this be a name? `who` is only used to tie kept evidence to a person; it never changes the answer.
const who: RawWho = { clientKey: 'a-client-key', accountId: 'acct-1042' };
const checked = cw.names.check('big_snerp_99', { who });
if (!checked.ok) console.log(checked.reason, checked.rule); // 'name_not_allowed' or 'name_profane', and the Community Rule

// A moderator asked for a new name. The game hears it, finds its player and sends them to its own rename screen.
cw.on('rename.required', (event) => {
  for (const accountId of cw.people.accountIds(event.target)) console.log('rename screen for', accountId);
});

// At login: is the player still held at the rename screen? After they chose a new name, say so.
if (cw.names.pendingRename(who)) console.log('hold at the rename screen');
cw.names.renamed(who);
```

- **Settings.** `overrides.names` takes `profanity` (default `false`), `keepBlocked` (default `false`), `renames` (default `false`) and `maskInHub` (default
  `true`), or the owner sets them in the hub (Settings, Advanced, Names).
- **The check.** `cw.names.check(text, opts?)` is synchronous, keeps no state and never echoes the name. The answer is `{ ok: true }` or
  `{ ok: false, reason, rule }`, with `reason` `'name_not_allowed'` (the matcher's name rules) or `'name_profane'` (the profanity filter, only with
  `names.profanity`, on the name and on the name with underscores and digits read as spaces). A matcher or filter that throws lets the name through. `name_profane` is
  a new value of `reason`: a `switch` that ends in `assertNever` will not compile until it handles it, though a kit never sends it with `names.profanity` off.
  `cw.names.flagged(text)` is the staff-side read that asks only the matcher and stores nothing.
- **Evidence, only if you opt in.** With `names.keepBlocked` a blocked name is kept with the term it hit and, when `who` finds one, the person: at most 5 an hour
  per person and 200 an hour overall (in memory, per process), after which the check still answers and keeps nothing more. An allowed name is never stored and a
  name is never logged. Kept names are deleted after 30 days (`retention.blockedNamesMs`) and read by staff with `cw.blocked.names({ days })`. They need a store
  with the blocked-name methods (SQLite, or `withMemoryNames(store)`).
- **Asking for a new name.** `cw.names.requireRename({ subject, actor, reason, rule? })` is for staff and needs `names.renames`. It writes one notice of kind
  `rename_required` (it names no name, no reason and no excerpt; it is not a sanction, is not on "My record" and needs no acknowledgement) and then emits
  `rename.required`. It answers `{ ok: true, noticeId }` or `{ ok: false, error }` with `error` `off`, `not_found`, `pending` (a request is already waiting) or
  `invalid`. `cw.names.renamesEnabled()` says whether it can work now (the setting is on and the store can release a rename), and `cw.names.renamesOf(subject)`
  lists a person's requests for the hub.
- **A game must act on `rename.required` and call `renamed`.** The kit cannot make a game rename anyone. It never learns the new name and never checks that one was
  chosen. Listen for the event (or take it by webhook with `includeAccounts`, see `@chatwarden/http`), find the player with `cw.people.accountIds(event.target)`
  (the account ids you passed as `RawWho.accountId`; a guest has none; server side only), hold them with `cw.names.pendingRename(who)` at login, and call
  `cw.names.renamed(who)` when they have a new name. That withdraws the notice and answers `true`. A game that ignores the event leaves a notice nobody acts on,
  and a player stays pending until the game calls `renamed`.
- **Hiding names in the hub is on by default.** This is the one default-on display change of 0.1.9. With `names.maskInHub` (default `true`), a handle the matcher
  flags is shown in the hub as "Blocked words, hidden" until a moderator chooses Show, in queue rows, the case, the Person page, the transcript, the command bar and
  the appeals. It changes only what the hub shows, only for flagged handles. To show names as before, set `overrides.names.maskInHub: false` or switch it off in
  Settings, Advanced, Names. `@chatwarden/http` marks a flagged handle with `handleFlagged` in its staff bodies.
- **Your store.** The blocked-name methods are optional on `Store`. So is `withdrawNotice(id, at)`, which releases a rename notice (it has no sanction group): a
  store without it cannot release a rename, `renamesEnabled()` is `false` and `requireRename` answers `off`. The SQLite store has all of them; the in-memory store
  has `withdrawNotice` built in and the blocked-name methods through `withMemoryNames(store)`.

## Upgrading to 0.1.9

- **From 0.1.8.** SQLite migration 22 is one-way: a database it has run on cannot be opened by 0.1.8 or older. Back it up first.
- **Unions are wider.** `NoticeKind` gains `rename_required`, `appeal_upheld`, `appeal_reduced` and `appeal_revoked`; `NameReason` gains `name_profane`;
  `AUDIT_ACTIONS` gains `appeal.view`, `appeal.decide` and `name.rename_required` and `AUDIT_TARGET_TYPES` gains `appeal`; `KIT_EVENT_TYPES` gains
  `appeal.created`, `appeal.decided` and `rename.required`. Code with a `switch` that ends in `assertNever` will not compile until it handles them, though none
  of the new values is sent until you turn the feature on.
- **Types you build by hand.** `RetentionPolicy` gains `appealStatementsMs`, `appealsMs` and `blockedNamesMs`; `PurgeResult` gains `appeals`, `appealStatements`,
  `blockedNames` and `appealsClosed`; `ResolvedProfile` gains `appeals` and `names`; `POLICY_SECTIONS` gains `appeals` and `names`; `AiOutcomeRow` gains `corrective`.
- **A false positive means something different.** A reduction on appeal is not a false positive. `AppealRuleStats.granted` counts revokes only, and the AI's
  `falsePositives` counts a recommendation to act that the moderator dismissed, or that a revoke corrected.
- **The AI re-reads once.** The prompt version is now 4, with appeals on or off: every stored read is marked stale and read again, once per open report. See "The AI
  (levels 1 and 2)".
- **A custom `Store`.** Everything new is optional and its absence turns the feature off (appeals need their methods, renames need `withdrawNotice`, kept names need the
  blocked-name methods). `purgeNotices` has an optional second argument.

## The AI (levels 1 and 2)

Optional help for the moderator, `@experimental` until 0.2 and new in 0.1.7. With an adapter, the kit reads each new report after the player's
ack, in the background, and the hub shows what it found (level 1, Read); at level 2 (Recommend) the decision form opens pre-filled with a mild
suggestion that the moderator accepts or edits. It is off until you give it an adapter, and the level is then the owner's to set in the hub
(Settings > AI): 0 by default, held to the `maxLevel` you pass.

```ts
import { createChatwarden, createFakeModerationAI } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';

// A scripted fake for a first look: it reads a report by simple rules, with no key and no network.
// A real adapter is any object with an `id` and a `read` function (the `ModerationAI` type).
const adapter = createFakeModerationAI([], { id: 'demo-fake' });

const cw = await createChatwarden({
  store: openStore({ path: './chatwarden.db' }),
  secret: process.env.CHATWARDEN_SECRET!,
  platform,
  ai: { adapter, maxLevel: 2, dailyBudgetMicros: 1_000_000 },
});
console.log(cw.ai.status()); // { available: true, level: 0, maxLevel: 2, state: 'ok', ... }
```

- **The adapter only sends.** The kit chooses and redacts the lines, renders the prompt, checks the model's answer against the rules and
  the ceilings, and stores it. Your `read(input, { signal })` sends `input.prompt` and returns `{ output, usage }`; anything it throws must
  be an `AIError` (`'declined'`, `'fatal'`, `'timeout'`, `'retryable'`). `examples/ai-anthropic` is a copy-and-own adapter for Anthropic, and
  `docs/adoption/moxgate.md` has the steps for turning it on.
- **It advises; it never acts.** The AI never writes a sanction, a strike, a mute or a notice: nothing under `core/src/ai` imports the modules
  that do (a lint rule and a test hold that). The one-key accept never fills in a ban, an area ban or anything longer than 24 hours
  (`AI_MAX_PREFILL_MS`), and a suggestion to uphold or note needs a cited line by the reported person.
- **What leaves your server.** Only the chosen lines of the report with the speakers replaced by `P1`, `P2`, ..., the reporter's reason and
  note (redacted), your Community Rules and the standard. Flags, mutes and report counts are never sent, nor any id, handle, IP, hash, room or
  tag. The one exception is the signal feed `feeds.ai` (`profile.signals`, off unless you set it): the counts you chose about the reported player
  only are sent as one last row, a label, a number of players and a number of days, and the read records what it was shown (shown to moderators as
  "Context included: N signal counts"). The prompt version is 4 for everyone (3 in 0.1.8), whether or not you use signals or appeals: the stable part of the prompt gained a short paragraph about appeal cautions and corrective examples, so it changes the input hash, and after upgrading from 0.1.8 every stored read is marked stale and read again, once per open report, the first time its case is opened or when the background sweep reaches it. Those reads spend your daily call and money caps, and your provider's prompt cache starts cold. A line the word filter blocked is sent as typed unless you set `blockedLines: 'mask'`: the model needs the words to judge intent.
- **What it costs.** `dailyBudgetMicros` (default $1.00 a UTC day) is set in code and a hub cannot raise it. The owner also sets a ceiling on
  calls a day (`profile.ai.dailyCalls`, default 5 000), so an adapter that reports no cost still cannot run unbounded. There are at most 30 calls
  a minute and 2 at once, a hard deadline per call (`timeoutMs`) and a breaker that opens after repeated failures. At a limit, reads pause. A call that a shutdown aborts books nothing, so a restart loop around a slow provider can under-count the day's money; the call ceiling still bounds it.
- **Learning.** With `profile.ai.learn` off no example is sent and no new example text is kept, but text already stored stays until its 180 days are up or
  a senior marks the case "don't teach".
- **It cannot get in the way.** A failing, slow, refusing or garbage-returning provider changes nothing else: the player's ack does not wait for
  the provider, the queue and the case page answer exactly as with the AI off, and a read that fails shows nothing.
- **Your store needs the AI methods.** The SQLite store has them (it adds three tables in migration 20, which is one-way: back up the database before upgrading); the in-memory store has them only
  through `withMemoryAi(store)`. A store without them leaves the AI inert: `createChatwarden` logs `chatwarden.ai_store_unsupported` once and
  carries on (a bad `ai` option still throws).
- **`cw.ai`** is always there: `level()`, `status()`, `read(reportId)`, `expected(reportId)` (whether a read of that report is on its way now: the level is 1 or 2, an adapter is set up, the breaker is closed, neither daily limit is reached and its read has not ended without an answer), `readAgain(reportId, actor)`, `stats()` (the casebook counts) and `idle()`.
  Without an adapter it answers as if the AI were off. The kit loads the AI code only when you pass `ai`, so a bundler can leave it out of a
  browser build that never does.
- **To try it with no key**, run `examples/tiny-chat` with `CW_DEMO_AI=1`; tests use `createFakeModerationAI` and never need a network.

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
| `retention` | How long rows are kept and how often the purge runs (every 6 hours by default), or `false` to run `purge()` yourself. Defaults: reports 90 days, strikes 30, notices 90, audit 365, signals 90 (`signalsMs`, never less than 14), appeal statements 90 (`appealStatementsMs`, may be 0), appeals 365 (`appealsMs`, never less than 90), kept blocked names 30 (`blockedNamesMs`, may be 0). Floors apply. |
| `profile` | `'relaxed'`, `'standard'` (default), `'strict'`, or your own profile from `defineProfile`. |
| `overrides` | Changes to the profile, merged onto it (`{ profanity: { mode: 'allow' } }`). A list you give replaces the preset's list. |
| `limits` | The numbers the kit enforces: line length and rate, strikes and timeouts, report limits. Each must be a whole number above 0. |
| `logger` | `{ warn(event, detail?) }`. Defaults to `console.warn`. It only ever receives an event name and an error class. |
| `rules` | The numbered Community Rules, from `defineRules`. Defaults to the preset's starter set. |
| `autoRestrictRule` | The rule number the automatic slur filter cites (default 1). Must be an active rule. |
| `ai` | `{ adapter, maxLevel?, dailyBudgetMicros?, ... }`: turns on AI reads (levels 1 and 2). Off without it. See "The AI (levels 1 and 2)" below. |
| `signals` | `{ accountAgeDays? }`: the one hook the profile cannot hold (how old a player's account is, for the new-account guard). The kinds, guards and feeds are in `profile.signals`. Needs a store with the signal methods (SQLite; `withMemorySignals(store)` for the in-memory store). `@experimental`. |

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
- **Two more kinds of player text, both opt-in.** An appeal statement (at most 1000 characters, only when appeals are on) is kept in the appeal row and cleared 90 days after
  the decision. A blocked name (only with `names.keepBlocked`) is kept for 30 days. Neither is ever logged, sent in an event, a webhook or a Discord post, or shown to
  another player, and a statement never reaches the AI.
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
