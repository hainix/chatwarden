# @chatwarden/core

## 0.1.9

### Patch Changes

- Adds notice kinds and a one-way migration, then two optional features: appeals, and tools for offensive names. **Four notice kinds are new: `rename_required`, `appeal_upheld`, `appeal_reduced` and `appeal_revoked` join `NoticeKind`.** An adopter whose `switch (notice.kind)` ends in `assertNever` will not compile until it handles them, though a kit only sends them after you turn a feature on. **SQLite migration 22 is one-way: the notices table is rebuilt, so a database 0.1.9 has opened cannot be opened by 0.1.8 or older. Take a backup before upgrading, as for migrations 19, 20 and 21.** Upgrading from 0.1.8: every other change is off by default, except one display setting in the hub (names masking, below) and the AI prompt version (below).
  
  - **Appeals** (`@chatwarden/core`, `@chatwarden/http`, `@chatwarden/player-react`, `@chatwarden/hub-react`, `@chatwarden/discord`, both stores): a player asks for a second look at a sanction from its notice (a warning, a chat restriction, an area ban or a full ban; one appeal for each sanction; a statement of up to 1000 characters). A different moderator keeps the decision, makes it lighter or removes it, and the player gets a plain message. Off until `profile.appeals.enabled` (or the owner switches it on in the hub, Settings, Advanced); with it off every appeal route answers 404 and no body changes. `cw.appeals` has `file`, `mine`, `list`, `get`, `decide`, `stats`, `openCount` and `forPerson`. The core refuses `same_decider` to the moderator who made the original decision, unless `appeals.allowSelfReview` is on: give each moderator their own login, because a team that shares one looks like a team of one. The statement is kept only in the appeal row (never in an event, a webhook, a Discord post, a log or an AI prompt) and cleared 90 days after the decision (`retention.appealStatementsMs`); the row goes after 365 days (`appealsMs`, never less than 90). In the hub an appeal is a view of the Cases queue, with a card to decide it, a Person page timeline entry and, in Simple, one quiet "N appeals waiting" line.
  - **The false-positive rate, and what counts as one.** `cw.appeals.stats` and `GET /appeals/stats` give each rule's sanctions, appeals, revokes (`granted`), reductions (`lightened`), a rate and a band (`elevated` from 0.15, `high` from 0.30, no rate below 10 sanctions), shown only behind Settings, Advanced, "Mistakes by rule". **A reduction on appeal is not a false positive**: the rate counts revokes only, and `lightened` sits beside it. In `cw.ai.stats()` a false positive is now a recommendation to act that the moderator dismissed (`no_action`) or that a revoke corrected. A revoke also keeps the original decision as one corrective example for the AI (the opposite sign); a reduce only keeps it from teaching. Rules at the elevated or high band are passed to the AI read as a caution (the rule and a band word, never a rate or a person). All of it is a no-op without `ai`.
  - **Names** (`@chatwarden/core`, `@chatwarden/http`, `@chatwarden/hub-react`, `@chatwarden/player-react`): `cw.names.check` keeps its contract and gains an optional profanity pass (`names.profanity`, reason `name_profane`) and an optional `who` that ties kept evidence to a person (`names.keepBlocked`, 30 days, `cw.blocked.names`, `GET /blocked?source=name`). **Renames:** with `names.renames`, a moderator asks a player to choose a new name (the Sanction form on the Person page, or `POST /people/:ref/rename`); the player gets a `rename_required` notice that names no name, and `rename.required` is emitted. **A game must act on it**: listen for the event (or take it by webhook with `includeAccounts: true`), find the player with `cw.people.accountIds(subject)`, hold them with `cw.names.pendingRename(who)` and call `cw.names.renamed(who)` once they have a new name. The kit never learns the new name. `player-react` gains `nameReasonText` for a sign-up screen.
  - **Hiding flagged names in the hub is on by default.** This is the one default-on display change in this release: with `names.maskInHub` (default `true`), a handle the word list flags is hidden in the hub until a moderator shows it. It changes only what the hub shows, only for flagged handles. Turn it off with `overrides.names.maskInHub: false` or in Settings, Advanced, Names. `@chatwarden/http` marks a flagged handle with `handleFlagged` (and `targetHandleFlagged`, `reporterHandleFlagged`), present only when true, so every other body is what 0.1.8 sent.
  - **New permissions.** `appeals.read` (default `moderator`: the inbox, one appeal and the numbers) and `appeals.decide` (default `senior`). A team of moderators lowers it: `permissions: { 'appeals.decide': 'moderator' }`. `POST /people/:ref/rename` uses `sanctions.apply`, and `GET /blocked?source=name` uses `blocked.read`. `appealsRateLimit` (default 10 an hour per identity) limits `POST /appeals` in front of the weekly cap (`appeals.perPlayerPerWeek`, default 3). Audit actions `appeal.view`, `appeal.decide` and `name.rename_required` are appended, with the target type `appeal`. `GET /me` gains `features` and `GET /changes` gains `appeals`, each only when the feature is on; `MeFeatures` is exported from `@chatwarden/http` and `@chatwarden/http/admin`.
  - **Events and posts.** `appeal.created`, `appeal.decided` and `rename.required` are appended to `KitEvent` and `KIT_EVENT_TYPES` (ids, codes and times only; `webhooksOut` accepts them). `@chatwarden/discord` posts the first two into the person's thread ("Appeal filed against a 24-hour chat restriction, Rule 2." and "Appeal decided: lighter."), and `severeOnly` limits them to severe rules.
  - **`@experimental` until 0.2:** `AppealSettings`, `ResolvedAppeals`, `cw.appeals` and its types, `normalizeStatement`, `NameSettings`, `ResolvedNames`, `cw.names.flagged`, `requireRename`, `pendingRename`, `renamed`, `renamesEnabled` and `renamesOf`, `cw.blocked.names`, `cw.people.accountIds`, `withMemoryAppeals`, `withMemoryNames`, `AppealDialog` and the `appeals` props of `NoticeQueue` and `MyRecord`, `nameReasonText`, `appealsRateLimit` and `includeAccounts`, the appeal and rename routes, and the Appeals and Names screens of the hub. They are listed in each README.
  - **An older player-react shows the generic title** ("A message from the moderators") for the four new notice kinds. `@chatwarden/player-react` 0.1.9 adds 28 keys to the English catalog (18 `player.appeal.*`, 2 `player.name.*`, and a title and a body for each new notice kind); a host with its own translations needs to add them. `@chatwarden/hub-react` adds 136 hub keys; a key a host leaves out reads in English. The size budgets were raised for this release, and none of it is a regression: the player-react bundle from 11 KB to 14 KB gzipped (the appeal dialog and the new words), and the hub's first load from 82 KB to 88 KB gzipped (the wire types and the appeal and name parts).
  - **SQLite migration 22 and retention.** It adds `kit_appeals` and `kit_blocked_names`, a nullable `kit_sanctions.report_id` (filled in for existing moderator sanctions where the decision can be found), `kit_ai_outcomes.corrective`, and rebuilds `kit_notices`. `RetentionPolicy` gains `appealStatementsMs` (90 days, may be 0), `appealsMs` (365 days, never less than 90) and `blockedNamesMs` (30 days, may be 0), and `PurgeResult` gains `appeals`, `appealStatements`, `blockedNames` and `appealsClosed`. The in-memory store opts in with `withMemoryAppeals(store)` and `withMemoryNames(store)`.
  - **Upgrade notes, the AI after upgrading.** The AI prompt version is now 4 for everyone, whether or not you use appeals: the stable part of the prompt gained a short paragraph about appeal cautions and corrective examples, which changes the input hash, so after upgrading from 0.1.8 every stored read is marked stale and is read again, once per open report, the first time its case is opened or when the background sweep reaches it. Those reads count against your daily call and money caps, and your provider's prompt cache starts cold.
  - **Upgrade notes, peer floors raised on purpose.** `@chatwarden/store-memory` and `@chatwarden/store-sqlite` now need `@chatwarden/core` `^0.1.9` (the optional appeal and blocked-name `Store` methods, `withdrawNotice`, and the `AppealRow` and `BlockedNameRow` types), `@chatwarden/http` needs core `^0.1.9` (`cw.appeals`, the `cw.names` and `cw.people.accountIds` additions, `cw.blocked.names` and the three new event types), `@chatwarden/discord` needs core `^0.1.9` (the two appeal events), `@chatwarden/hub-react` needs core `^0.1.9` (`APPEAL_STATEMENT_MAX`, the `appeals` and `names` profile sections and the new types) and `@chatwarden/http` `^0.1.9` (the new routes and wire fields), and `@chatwarden/player-react` needs core `^0.1.9` (it imports the types `AppealRefusal`, `PlayerAppeal` and `NameReason`). `@chatwarden/hub-element` keeps its optional hub-react peer at `^0.1.5`, and `@chatwarden/core`, `@chatwarden/matcher` and `@chatwarden/profanity` keep their floors. Install the group together.
  - **Upgrade notes, types and unions.** Code with a `switch` that ends in `assertNever` needs cases for the new values: `NoticeKind` (four), `NameReason` (`name_profane`), `AUDIT_ACTIONS` (three) and `AUDIT_TARGET_TYPES` (`appeal`), `KIT_EVENT_TYPES` and `KitEvent` (three), `POLICY_SECTIONS` (`appeals`, `names`) and the http `ErrorCode` (`invalid_statement`, `already_appealed`, `same_decider`, `gone`, `pending_rename`). `ResolvedProfile` gains the required `appeals` and `names`, `AiOutcomeRow` gains `corrective` and `AIExample` an optional `kind`, `SanctionRow` an optional `reportId`, and `RetentionPolicy` and `PurgeResult` the fields above, so code that builds these by hand needs the new members.
  - **Upgrade notes, a custom `Store`.** Everything new is optional, and its absence turns a feature off. A store without the appeal methods cannot enable appeals (`createChatwarden` throws a plain message when `appeals.enabled` is true), and one without the blocked-name methods keeps no names. **`withdrawNotice(id, at)` is new and optional: it releases a rename notice, which has no sanction group, so a custom store without it has renames off** (`renamesEnabled()` is false and `requireRename` answers `off`). `closeOrphanAppeals` is optional (without it an appeal whose sanction rows retention removed stays open and cannot be decided), `decideAppeal` and `closeAppealsForGroup` take an optional trailing `clearStatement` (without it a statement is cleared at the next purge, not at the decision), and `purgeNotices(before, unseen?)` takes an optional second argument, the ceiling for an unseen message notice (a store that ignores it keeps an unseen appeal outcome or rename request until the player sees it).
  - **No new package is published.**

## 0.1.8

### Patch Changes

- Adds a new refusal reason, then two optional features: slow mode and flood control, and signals. **A refusal reason is new: `slow_mode`, `flood` and `duplicate` join `RefuseReason`, and a refusal can carry an optional `retryAfterMs`.** An adopter whose `switch (reason)` ends in `assertNever` will not compile until it handles them, though a kit can only send them after pacing is turned on. Everything else is off by default and `@experimental` until 0.2.
  
  - **Slow mode, a burst limit and repeat refusal** (`@chatwarden/core`, `@chatwarden/hub-react`, `@chatwarden/player-react`, `@chatwarden/http`): a profile `pace` section (`slowModeMs`, `burst`, `duplicateWindowMs`), set in code or by the owner in the hub (Settings, Advanced, "Slow mode and flooding"), per room and player, with `cw.rooms.setPace` and `cw.rooms.pace` for one room that differs. The check runs after the length check and before the fixed rate limit. Pacing state is per process and lost on restart, like the fixed rate limit: route a room's chat to one process, or accept the looser effective limit. The chat box and `RestrictedChatLine` (new `pace` prop) word the three reasons; `secondsLeft` turns a wait into a bare duration, and every wait sentence says `in {left}` itself. `examples/tiny-chat` shows it with `CW_DEMO_PACE=1`.
  - **Signals** (`@chatwarden/core`, `@chatwarden/store-memory`, `@chatwarden/store-sqlite`, `@chatwarden/http`, `@chatwarden/hub-react`): `cw.signals` (`record`, `counts`, `kinds`, `boosted`, `forRecord`) keeps what a game records about a player and counts it by distinct source, with a per-source cap and an optional new-account weighting. The kit records the built-in `flood_triggered` itself when the burst limit trips. A signal never acts on its own; it feeds four switches, each off until set: the Person page record, the queue order (`boosted` on queue rows, `signalBoost` on take-next), the ladder suggestion (`signals` on a suggestion, with the sentence shown only to a role that holds `history.read`) and the AI read's context (the AI prompt version is now 3 for everyone, see the upgrade notes). The in-memory store opts in with `withMemorySignals(store)`, and `retention.signalsMs` (90 days, never less than 14) keeps the rows.
  - **SQLite migration 21 adds one table (`kit_signals`) and one nullable column on `kit_ai_reads`. It is one-way: a database 0.1.8 has opened is not readable by 0.1.7 or older tools. Back up the database before upgrading.**
  - **`@chatwarden/http`**: `GET /policy/profile` (and the answers to `PUT` and `DELETE`) also carry a read-only `limits` object, `{ chatRate: { count, windowMs }, signalsMs }`, the chat rate limit in force and the signals retention window; the hub uses it for its built-in limit hint and the feed window cap, and falls back to the old numbers on a server without it. Every other body is unchanged with the new features off.
  - **`@chatwarden/hub-react`** and **`@chatwarden/hub-element`**: Settings, Advanced with two lazy panels, "Slow mode and flooding" and "Signals" (including a list of what the kit left out of the saved settings and a way to remove it), the signal lines on the Person page and a small queue boost. Nothing is added to the queue, the case card or Simple mode.
  - **Upgrade notes, peer floors raised on purpose.** `@chatwarden/store-memory` and `@chatwarden/store-sqlite` now need `@chatwarden/core` `^0.1.8` (the three optional signal `Store` methods and the `SignalRow` and `SignalSourceRow` types), `@chatwarden/http` needs core `^0.1.8` (`cw.signals.boosted` and `forRecord`, `signalBoost`, `hideSignalText`, `PolicyState.limits`), and `@chatwarden/hub-react` needs core `^0.1.8` (`BUILTIN_SIGNAL_KINDS`, `PACE_SUGGESTIONS`, `PaceSettings` and the `pace` and `signals` profile sections) and `@chatwarden/http` `^0.1.8` (the new wire fields). `@chatwarden/player-react` keeps core `^0.1.2` (its `pace` prop uses its own literal union), `@chatwarden/hub-element` keeps its optional hub-react peer at `^0.1.5`, and `@chatwarden/core`, `@chatwarden/matcher`, `@chatwarden/profanity` and `@chatwarden/discord` keep their floors. Install the group together.
  - **Upgrade notes, types.** `ResolvedProfile` gains the required fields `pace` and `signals`, `PolicyState` gains the required `limits`, `AiReadRow` (the stored AI read row) gains the required `signals` (`readonly AISignal[] | null`), so a custom `Store` that implements the AI methods must return it (the kit tolerates `undefined` at run time), `RetentionPolicy` gains `signalsMs` and `PurgeResult` gains `signals`, and `POLICY_SECTIONS` gains `'pace'` and `'signals'`, so code that builds these by hand or switches over them needs the new members. `SignalInput` accepts `null` for `by`, `roomId` and `at`.
  - **Upgrade notes, the AI after upgrading.** The AI prompt version is now 3 for everyone, whether or not you use signals: the stable part of the prompt gained a short paragraph about context, which changes the input hash, so after upgrading from 0.1.7 every stored read is marked stale and is read again, once per open report, the first time its case is opened or when the background sweep reaches it. Those reads count against your daily call and money caps, and your provider's prompt cache starts cold.
  - **No new package is published**, and no audit action, event or webhook is added.

## 0.1.7

### Patch Changes

- Adds optional AI help, levels 1 and 2 (read, then recommend). It is off by default and `@experimental`. It never writes a sanction, a strike, a mute or a notice: a moderator still decides, and a one-key accept never fills in a ban, an area ban or anything longer than 24 hours.
  
    - **`@chatwarden/core`**: `createChatwarden({ ai: { adapter, maxLevel, dailyBudgetMicros } })` and `cw.ai` (`level`, `status`, `read`, `expected`, `readAgain`, `briefs`, `stats`, `dontTeach`, `idle`), the `ModerationAI` adapter contract with `AIError`, `createFakeModerationAI`, `validateAIOutput` and `assertWithinCeilings` with `AI_MAX_PREFILL_MS`. The profile gets an `ai` section (`level`, `learn`, `dailyCalls`) that the owner edits in the hub (`POLICY_SECTIONS` gains `'ai'`). Retention gains `aiOutcomesMs` and `aiExamplesMs`, and the audit trail gains `ai.read`, `ai.rerun` and `ai.outcome`. The model is told only the chosen chat lines with aliases, the reason, a redacted note and your rules: never an id, a handle, an IP, a hash or a history. The reads fail soft: a slow, refusing or broken provider changes nothing else.
    - **`@chatwarden/store-memory`** and **`@chatwarden/store-sqlite`**: optional AI methods on `Store`. SQLite migration 20 adds three tables (`kit_ai_reads`, `kit_ai_spend`, `kit_ai_outcomes`) and five indexes and touches no existing table. **Migration 20 is one-way: a 0.1.6 build refuses a version 20 database, so back up the database before you upgrade.** The plain in-memory store has no AI methods; `withMemoryAi(store)` adds them, and a kit given `ai` over a store without them stays inert and logs `chatwarden.ai_store_unsupported`.
    - **`@chatwarden/http`**: `GET /ai/status`, `POST /reports/:id/ai/read` and `POST /reports/:id/ai/dont-teach`; an `ai` brief on each open queue row; `ai` and `aiExpected` on `GET /reports/:id`; an optional `ai` echo on `POST /reports/:id/decide`; the error codes `ai_off`, `ai_final`, `ai_budget` and `ai_unavailable` (with `AiUnavailableError`).
    - **`@chatwarden/hub-react`** and **`@chatwarden/hub-element`**: the read on the case card, the pre-filled decision with a one-key accept (A, with E to edit), a queue chip and a `priority` order, Settings > AI, `HubClient.readAgain`, `aiStatus` and `dontTeach`, `loadAiWords` and `loadAiRank`. The AI code is loaded only when the AI is on. The first load budget is 77 KB, and the `hub-element` script is 202 KB because it holds the lazy AI code too.
    - **Upgrade notes, peer floors raised on purpose.** `@chatwarden/store-memory` and `@chatwarden/store-sqlite` now need `@chatwarden/core` `^0.1.7` (the new optional `Store` methods and `Ai*` row types), `@chatwarden/http` needs core `^0.1.7` (`cw.ai`; the queue and the case page call it), and `@chatwarden/hub-react` needs core `^0.1.7` (`assertWithinCeilings`) and `@chatwarden/http` `^0.1.7` (the `AiReadAgainBody` type). `@chatwarden/hub-element` stays on `@chatwarden/hub-react` `^0.1.5`; the other packages keep their floors.
    - **Upgrade notes, types and one behaviour change.** `ResolvedProfile.ai` is a new required field; `RetentionPolicy` gains two required fields and `PurgeResult` two; `AUDIT_ACTIONS`, `POLICY_SECTIONS`, `SettingsSection`, `ErrorCode` and `QueueSort` each gain members, so a `switch` over them needs a new case. The `ai:` actor prefix is reserved: `audit.record` now refuses any actor that starts with `ai:` (and any `ai.read` row from another actor), so an http auth hook that returns a staff actor starting with `ai:` makes its requests fail their audit.
    - **No new package is published.** The Anthropic adapter is the private example `examples/ai-anthropic`: copy it into your server as `docs/adoption/moxgate.md` section 9 describes. The default model is `claude-haiku-5-5`.

## 0.1.6

### Patch Changes

- Adds a chat box and a room broadcaster: a game with no chat can add moderated chat in minutes.
  
  - **`@chatwarden/http/chat`** (also exported from `@chatwarden/http`): `createRoomBroadcaster` keeps a bounded in-memory history for late joiners and writes frames to the players' streams, and `chatRoutes` mounts four routes (a Server-Sent Events stream down, `POST` lines, mutes and reports up). Every line goes through `cw.chat.accept` and nothing else decides delivery; a refusal is shown only to its author, a mute is silent to the muted player, and no seat, subject, key, address or hash is ever sent or logged. The subpath imports no `node:` module, so it runs in a browser tab too. `KitResponse` gains an optional `stream` (`KitStream`) that `toExpress` handles; an adapter author for another framework may implement it. A player may have 3 streams (tabs) open in a room (`maxStreamsPerMember`): a fourth ends the oldest, with a `replaced` goodbye, so a connection that died without a word never locks them out.
  - **`@chatwarden/player-react/chat`** and **`@chatwarden/player-react/chat.css`**: `<ChatBox>` (the list, one input and Send, with Report and Mute behind one small control per line and a single Chat options door), `sseTransport` (reads the stream with `fetch`, so your header-based auth works, and reconnects with back-off), and `enChat`, the English words (every string goes through `t()`). It is a separate lazy entry: the main entry and its size are unchanged.
  - **`@chatwarden/core`**: `cw.chat.restrictedBySubject(subject, opts)` (`@experimental`) reads `cw.chat.restricted` from a subject id, so a server that keeps a connection open does not have to keep the player's client key or address to ask again.
  - **One upgrade note: `@chatwarden/http` now needs `@chatwarden/core` `^0.1.6`.** The broadcaster uses `cw.chat.restrictedBySubject`, so the peer range on core moves from `^0.1.5` to `^0.1.6` and `createRoomBroadcaster` throws a `TypeError` on an older core. Install `@chatwarden/http` and `@chatwarden/core` from the same release. `@chatwarden/player-react`, `hub-react` and `hub-element` keep their ranges.
  - **More than one process.** Route a room's connections, and its posts, to one process (sticky rooms); the history, the rate limits and the roster are per process. A pub/sub hook between processes is not shipped.
  - Every new name is `@experimental` until 0.2. There is no migration and no store change.

## 0.1.5

### Patch Changes

- Faster report triage: a moderator can clear hundreds of reports without typing a reason and without the mouse.
  
  What changes for a game studio and its moderators:
  
  - **One-click dismiss, in every mode.** "Nothing wrong here" closes a report with no action and no typed reason. Nobody is told and
    nobody is marked. Simple has it as "No action needed" (key `2`); Detailed gets one new button, "Nothing wrong here", in the decision
    bar. The kit stores one standard reason, "No action needed" (core: `NO_ACTION_DEFAULT_REASON`, `isDefaultNoActionReason`), so a
    dismissal nobody wrote about is easy to tell from a considered note. A reason is now optional only for a "Not a problem" decision
    that acts on nobody; every other decision still needs a real one.
  - **Auto-advance.** Every quick action (the suggested step, a warning, a dismissal) moves straight on to the next case. Undo still works
    after the move, for the same five seconds, and several decisions can wait at once: the newest shows with its Undo button and the
    rest collapse into one line ("2 earlier decisions waiting").
  - **Bulk dismiss.** One confirmed action closes every open report about one person, or every open report from one reporter
    (`cw.reports.dismissMany`, `POST /reports/dismiss-open`). It sits behind "Close more reports at once" under the decision bar, shows
    a live count, can be undone for five seconds, and never marks bad faith. At most 200 reports a call; another moderator's claim is
    respected (a senior can take over). New permission `reports.decide.bulk`, moderator by default (raise it to `senior` to keep sweeps
    for seniors). The audit log gets one summary row per sweep (`report.dismiss_case` or `report.dismiss_reporter`) and one
    `report.decide` row for every report closed.
  - **Reporter accuracy and the habitual-reporter ranking.** `cw.reports.reporterAccuracy` is the share of a reporter's decided
    reports from the last 30 days that were dismissed (at least 5 decided reports). The case says so ("most of their recent reports were
    dismissed, 6 of 6 in the last 30 days"), and reporters whose reports are dismissed 80% of the time or more are listed lower in the
    queue and in Take next. It is on by default in take-next (`POST /cases/next`); in core it is `cases.next(actor, { rankDownHabitual:
    true })`, off unless you ask. Nothing is ever hidden or refused, a report older than 24 hours ranks as usual, a person with more
    than 200 open reports is never pushed down, and the figure is for staff only (`history.read`): it never reaches a player.
  - **Keyboard queue mode.** `J` / `K` and the arrow keys move between cases, `1` / `2` / `3` act (the suggested step, nothing wrong
    here, a warning), `U` undoes the newest waiting decision. A new "Quick keys" switch in the `?` sheet turns the acting on: on in
    Simple, off in Detailed (where `1` / `2` / `3` have always picked a verdict, so nothing changes by surprise). A held key is one
    action, and a case takes an act key only 300 ms after it appeared, so a double tap cannot close the next case.
  - **SQLite migration 19** adds one index (`kit_reports_by_reporter_outcome`) and changes no table or row. It runs when the store opens. It is one-way: once 0.1.5 has opened a database, 0.1.4 will not open it
    (it reports a schema version newer than it supports), so back up the database file before you upgrade if you might roll back.
  - **Type widenings and one new key.** `DecisionInput.reason` and `DecideInput.reason` are optional (every existing call still
    compiles). `PermissionKey` gains `reports.decide.bulk`, so a `Record<PermissionKey, ...>` you wrote by hand needs it. `AuditAction`
    gains the two sweep actions, `ReporterRecord` and the open rows of `GET /reports` gain an optional accuracy figure, and the store
    gains two optional methods (`reporterOutcomes`, `listOpenReportsByReporter`), so a custom store keeps working with these features
    off. New names are `@experimental`.
  - **Three contract changes to check if you wrote your own pieces.** A custom store's `listOpenReportsByPerson` must accept a limit up to
    201 (the bulk dismissal asks for one more than its 200 cap to know there are more; a store that clamps at 200 makes it under-report).
    `HubClient` gains a required `dismissOpen` method, so a hand-written client or test double needs it. The signed incoming webhook's
    `decide` action now accepts a dismissal (`no_action`, no actions) with no `reason`, as the staff route does.
  
  Upgrade notes:
  
  - Peer floors rise. `store-memory`, `store-sqlite`, `http` and `hub-react` now need `@chatwarden/core` 0.1.5 (they use `dismissMany`,
    `reporterAccuracy`, the standard reason and the new store types); `hub-react` also needs `@chatwarden/http` 0.1.5 (the sweep route
    and the dismissal with no reason: a hub 0.1.5 against an older `http` is refused 400 on a dismissal with no reason, and has no bulk
    dismiss), and `hub-element`'s optional `hub-react` peer is `^0.1.5` to match. `player-react`, `discord`, `matcher` and `profanity`
    keep their floors.
  - `POST /cases/next` now serves reports from habitual false reporters last. Nothing else about take-next changed.
  - The hub's first load is still under its size budget (the command bar, the shortcut sheet and the bulk window load on demand).
  - Translators: add these words (a key you leave out shows English). Plural pairs need `.one` and `.other`. `hub.quick.dismiss`,
    `hub.quick.dismiss.hint`, `hub.quick.held`, `hub.decided.reason.default`, `hub.decide.reason.hint.dismissal`, `hub.toast.undone`,
    `hub.toast.waiting` (plural), `hub.window.failed`, `hub.key.up`, `hub.key.down`, `hub.command.undo`, `hub.shortcuts.group.move`,
    `hub.shortcuts.group.act`, `hub.shortcuts.group.general`, `hub.shortcuts.primary`, `hub.shortcuts.dismiss`,
    `hub.shortcuts.warning`, `hub.shortcuts.decide`, `hub.shortcuts.or`, `hub.shortcuts.undo`, `hub.shortcuts.quickKeys.label`,
    `hub.shortcuts.quickKeys.hint`, `hub.shortcuts.quickKeys.on`, `hub.shortcuts.quickKeys.off`, `hub.shortcuts.quickKeys.only`,
    `hub.bulk.open`, `hub.bulk.person` (plural), `hub.bulk.reporter`, `hub.bulk.reporter.habitual`, `hub.bulk.confirm.counting`,
    `hub.bulk.confirm.title.person` (plural), `hub.bulk.confirm.title.reporter` (plural), `hub.bulk.confirm.body`,
    `hub.bulk.confirm.claimed` (plural), `hub.bulk.confirm.heldBy`, `hub.bulk.confirm.takeOver` (plural), `hub.bulk.confirm.none`,
    `hub.bulk.confirm.go` (plural), `hub.bulk.confirm.cancel`, `hub.bulk.confirm.close`, `hub.bulk.held` (plural), `hub.bulk.done`
    (plural), `hub.bulk.skipped.claimed` (plural), `hub.bulk.more`, `hub.bulk.more.again`, `hub.bulk.failed`,
    `hub.bulk.failed.claimed`, `hub.reporter.rate.line`, `hub.reporter.rate.ranked`, `hub.queue.row.rankedLow`,
    `hub.audit.label.report.dismissCase`, `hub.audit.label.report.dismissReporter`. `hub.simple.noAction.reason` stays in the
    catalogue, deprecated and no longer sent.

## 0.1.4

No changes in this release.

## 0.1.3

### Patch Changes

- A hardening release: smaller browser bundles, a faster SQLite store, a hub that loads its settings screens on demand, and players report in one step. All ten packages move to 0.1.3 together. Back up your SQLite database before you upgrade (see SQLite below); nothing else needs migrating.
  
  **Browser bundles**
  
  - `@chatwarden/matcher` no longer ships obscenity's English word list to browsers (issue #8). Before, anyone who bundled the matcher for a web page carried that ready-made list, real slurs included, even though the matcher never used it. The matcher now carries only the few pieces of obscenity it needs, so those bundles are smaller and the matcher gives the same verdicts as before (it is tested word for word against obscenity's own engine). `obscenity` is no longer installed with `@chatwarden/matcher`. `@chatwarden/profanity` still uses it.
  
  **SQLite**
  
  - `@chatwarden/store-sqlite` runs migration 18 when it opens. It adds indexes on `kit_sanctions(starts_at)` and `kit_strikes(at)`, so the history and strike-window queries stay fast as the tables grow. It is applied automatically and changes no row. It is one-way: once 0.1.3 has opened a database, 0.1.2 will not open it (it reports a schema version newer than it supports), so back up the database file before you upgrade if you might roll back.
  
  **Moderator hub**
  
  - The hub's settings and admin screens (Steps and ladder, Reporting, Terms, Blocked, Rule gaps, Audit, Guide and All actions) load when they are first opened. The hub's first load is about a fifth smaller. `<chatwarden-hub>` is still one self-contained script with no extra request.
  - Experimental: `<Hub onController={...}>` hands you the hub's controller, and `controller.refresh()` reads the queue's change token now instead of at the next poll. Use it when your game has just filed a report and you want the moderator to see it at once. It only reads: it adds nothing to the audit trail and changes no permission. It is rate-limited to one read a second, so do not call it in a loop. Both may change in a later release. `HubController` and `LiveQueueStore` (from `/headless`) gain a `refresh()` member, so a hand-written test double of either needs a no-op `refresh()`.
  - The "What players see" picture on the Reporting settings screen now shows the one-step dialog below.
  
  **Players report in one step**
  
  - The report dialog is one step: "Report this message?", the line, an optional "Why?" list of reasons, a note behind "Add a note", then Report. After sending it says "Report sent" and the thank-you. The reason and the note go in the one report, so there is no "Add a reason" second step. When your studio's setting is "reason required", the "Why?" list is required and Report asks for a reason.
  - `onAddDetail` on `ReportDialog` is deprecated. It is still accepted but is no longer called. `cw.reports.addDetail` is still in the kit for a follow-up of your own.
  - Experimental: `ReportDialog` has an `extra` slot for your own controls (for example an "Also mute this player" checkbox). It sits inside the form, so give your buttons `type="button"`.
  - If the reasons change while the dialog is open and the one a player chose is gone, the dialog no longer sends the old reason. The "Add a note" button is now a full-size touch target on phones.
  - If you translate the dialog, add the new words: `player.report.why`, `whyRequired`, `choose`, `chooseRequired` and `addNote`, and check the changed `intro` and `note`. The hub has new words too: the seven `hub.reporting.preview.*` words, `hub.state.what.reportingSettings` and `hub.state.reloadHint`. A word missing from your catalogue shows as its raw key, so spread `en` under your own words to fall back to English.
  - The dialog's inner class names changed (the radio list and its fieldset are gone). If you restyled them, restyle through the tokens in the README's theming section instead.
  - Nothing is removed from `en` and `PlayerText` in `@chatwarden/player-react`: the words the dialog no longer uses are kept and marked `@deprecated`, and go in a later minor. The same goes for six words of the hub's reporting preview.
  
  **Site demo**
  
  - The chatwarden.dev demo follows the one-step dialog (its tour copy and tests), its chat box no longer cuts Send off, and the page no longer scrolls sideways on a 320 px phone.

## 0.1.2

### Patch Changes

- The moderator hub, a player UI, and a profile and reporting setup that moderators can edit without a deploy. All ten packages move to 0.1.2 together.
  
  **New packages**
  
  - `@chatwarden/hub-react` is the moderator hub as a React component. It opens in Simple mode, one card per case, for a team of one or two; Detailed is the full workbench for a bigger team, with the queue, the person's record, the blocked words, rule gaps, the audit trail and the guide. Moderators on a team claim a case so two of them do not decide it at once, and see who is on what. There are four ways to adopt it: drop in `<Hub>`; place single pieces (queue, case, person, settings) in your own dashboard; use the headless hooks or controller, which need no React (`@chatwarden/hub-react/headless`); or use the custom element below.
  - `@chatwarden/player-react` is what a player sees: the notice queue (a warning to acknowledge, a restriction, a ban), "My record", the rules page, the report dialog and the line that tells a restricted player what is limited. It follows the reporting setup the kit hands it.
  - `@chatwarden/hub-element` is the hub as `<chatwarden-hub>`, one script tag and one element, for plain HTML, Vue, Svelte or a server-rendered admin page. React is inside the script, so the page needs no build step.
  
  **Kit**
  
  - The warning steps and the ladder of sanctions are editable. An owner changes them in the hub (or through the new `GET /policy/profile` and `PUT /policy/profile` staff routes) and the kit uses the change straight away, with a saved version, a conflict check and a reset to the preset. `cw.policy` reads, previews, saves and resets the editable layer, and `cw.profile` is always the live result.
  - Reporting is configurable, and one tap is the default. A profile can set the flow (one tap, pick a reason first, or reason required), the list of reasons (their names, hints and the Community Rules they map to), and the thank-you text. A report records the reason the player gave as `reportedReason`, and the hub shows it beside the case, filters the queue by it, and says how often a reporter's reasons matched the decision. After a one-tap report the player can add a reason or a note once, within 10 minutes (`cw.reports.addDetail`); a filed report now answers with `detailUntil`, the moment that window ends, so a screen can stop offering the follow-up. Reports about the same person are one case: deciding one keeps the moderator's claim while others are open, and deciding the last one ends it (`cw.cases.releaseWhenDone`).
  - Moderators keep saved reasons for their decisions, and claim cases so two of them do not decide the same person. `POST /cases/next` takes an optional `reason` (a reason id, or `none`), so Take next can hand out the next case a reporter filed under one reason.
  - `GET /policy/profile` (and `cw.policy.get()`) carries `layerError` when the stored layer cannot be read or is invalid. The kit ignores that layer and keeps running on the preset until an owner saves a good one.
  - The SQLite and in-memory stores keep the editable layer, saved reasons, claims and the reason and follow-up of each report. Both stores and `@chatwarden/http` now need core 0.1.2 or newer (see the upgrade notes).
  
  **Upgrade notes**
  
  - Profiles you wrote for 0.1.1 still work as they are. The editable layer sits on top of the profile you pass to `createChatwarden`; nothing is rewritten.
  - `ReportRefusal` gained members, `reason_required` and `reason_unknown`. If you switch on the refusal with an exhaustive `never` check, add the two cases; otherwise nothing changes.
  - `category` is still accepted when a report is filed. It is read as the reason with the same name, and a report still records the 0.1.1 category it belongs to.
  - The hub's keyboard shortcuts answer when focus is inside the hub. On the page body they answer only when that is the only hub on the page, or the one marked `primary`.
  - The SQLite store runs migrations 15, 16 and 17 when it opens: claims and saved reasons (15), the editable profile layer (16), and the reason and follow-up columns on reports, with the old category copied into the reason (17). They run automatically, keep every existing row, and need nothing from you; keep a backup before the first start on a database you care about.
  - `@chatwarden/http`, `@chatwarden/store-memory`, `@chatwarden/store-sqlite`, `@chatwarden/hub-react` and `@chatwarden/player-react` now peer on `@chatwarden/core` `^0.1.2` (and `hub-react` on `@chatwarden/http` `^0.1.2`), because they use what is new in 0.1.2. `core`, `matcher`, `profanity` and `discord` keep their `^0.1.0` ranges.
  - The `Store` interface in `@chatwarden/core` gained 14 required methods: `listSubjectSanctions`, `listStrikes`, `countStrikesByTerm`, `listOpenReports`, `listOpenReportsByPerson`, `reporterTally`, `changeToken`, `claimCase`, `releaseClaim`, `loadClaims`, `listReasons`, `insertReason`, `updateReason` and `setReasonActive`. It also gained four optional ones: `addReportDetail`, `loadPolicyLayer`, `savePolicyLayer` and `loadReporterDecisions`. `@chatwarden/store-memory` and `@chatwarden/store-sqlite` have all of them. If you wrote your own `Store`, it no longer type-checks against 0.1.2 until you add the 14 required methods. Run the store contract suite (`test/contract` in the Chatwarden repository) against it to check each one.
  - New subpath `@chatwarden/http/admin`: the staff routes (`adminRoutes`, `createRouter`, the errors, roles and permissions) without the player routes, the webhooks or the Express adapter. It imports no Node builtin, so a browser or edge bundle can run the staff routes. `@chatwarden/http` itself is unchanged.

## 0.1.1

### Patch Changes

- Runs in a browser: the hashing and random ids no longer import any node: module (node:crypto is used when the runtime has it, a pure-JS SHA-256 and HMAC-SHA256 otherwise), and hashes are byte-identical to 0.1.0. Adds cw.chat.restricted(who, { roomId, seatId }), the same decision as accept without sending a line, for typing indicators. Exports the RestrictedAnswer type for it. A failing restriction lookup on that path is logged at most once a minute.

## 0.1.0

### Minor Changes

- First public release.
