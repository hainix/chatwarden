# @chatwarden/profanity

## 0.1.8

### Patch Changes

- Adds a new refusal reason, then two optional features: slow mode and flood control, and signals. **A refusal reason is new: `slow_mode`, `flood` and `duplicate` join `RefuseReason`, and a refusal can carry an optional `retryAfterMs`.** An adopter whose `switch (reason)` ends in `assertNever` will not compile until it handles them, though a kit can only send them after pacing is turned on. Everything else is off by default and `@experimental` until 0.2.
  
  - **Slow mode, a burst limit and repeat refusal** (`@chatwarden/core`, `@chatwarden/hub-react`, `@chatwarden/player-react`, `@chatwarden/http`): a profile `pace` section (`slowModeMs`, `burst`, `duplicateWindowMs`), set in code or by the owner in the hub (Settings, Advanced, "Slow mode and flooding"), per room and player, with `cw.rooms.setPace` and `cw.rooms.pace` for one room that differs. The check runs after the length check and before the fixed rate limit. Pacing state is per process and lost on restart, like the fixed rate limit: route a room's chat to one process, or accept the looser effective limit. The chat box and `RestrictedChatLine` (new `pace` prop) word the three reasons; `secondsLeft` turns a wait into a bare duration, and every wait sentence says `in {left}` itself. `examples/tiny-chat` shows it with `CW_DEMO_PACE=1`.
  - **Signals** (`@chatwarden/core`, `@chatwarden/store-memory`, `@chatwarden/store-sqlite`, `@chatwarden/http`, `@chatwarden/hub-react`): `cw.signals` (`record`, `counts`, `kinds`, `boosted`, `forRecord`) keeps what a game records about a player and counts it by distinct source, with a per-source cap and an optional new-account weighting. The kit records the built-in `flood_triggered` itself when the burst limit trips. A signal never acts on its own; it feeds four switches, each off until set: the Person page record, the queue order (`boosted` on queue rows, `signalBoost` on take-next), the ladder suggestion (`signals` on a suggestion, with the sentence shown only to a role that holds `history.read`) and the AI read's context (the AI prompt version is now 3 for everyone, see the upgrade notes). The in-memory store opts in with `withMemorySignals(store)`, and `retention.signalsMs` (90 days, never less than 14) keeps the rows.
  - **SQLite migration 21 adds one table (`kit_signals`) and one nullable column on `kit_ai_reads`. It is one-way: a database 0.1.8 has opened is not readable by 0.1.7 or older tools. Back up the database before upgrading.**
  - **`@chatwarden/http`**: `GET /policy/profile` (and the answers to `PUT` and `DELETE`) also carry a read-only `limits` object, `{ chatRate: { count, windowMs }, signalsMs }`, the chat rate limit in force and the signals retention window; the hub uses it for its built-in limit hint and the feed window cap, and falls back to the old numbers on a server without it. Every other body is unchanged with the new features off.
  - **`@chatwarden/hub-react`** and **`@chatwarden/hub-element`**: Settings, Advanced with two lazy panels, "Slow mode and flooding" and "Signals" (including a list of what the kit left out of the saved settings and a way to remove it), the signal lines on the Person page and a small queue boost. Nothing is added to the queue, the case card or Simple mode.
  - **Upgrade notes, peer floors raised on purpose.** `@chatwarden/store-memory` and `@chatwarden/store-sqlite` now need `@chatwarden/core` `^0.1.8` (the three optional signal `Store` methods and the `SignalRow` and `SignalSourceRow` types), `@chatwarden/http` needs core `^0.1.8` (`cw.signals.boosted` and `forRecord`, `signalBoost`, `hideSignalText`, `PolicyState.limits`), and `@chatwarden/hub-react` needs core `^0.1.8` (`BUILTIN_SIGNAL_KINDS`, `PACE_SUGGESTIONS`, `PaceSettings` and the `pace` and `signals` profile sections) and `@chatwarden/http` `^0.1.8` (the new wire fields). `@chatwarden/player-react` keeps core `^0.1.2` (its `pace` prop uses its own literal union), `@chatwarden/hub-element` keeps its optional hub-react peer at `^0.1.5`, and `@chatwarden/core`, `@chatwarden/matcher`, `@chatwarden/profanity` and `@chatwarden/discord` keep their floors. Install the group together.
  - **Upgrade notes, types.** `ResolvedProfile` gains the required fields `pace` and `signals`, `PolicyState` gains the required `limits`, `AIStoredRead` (the stored AI read row) gains the required `signals` (`readonly AISignal[] | null`), so a custom `Store` that implements the AI methods must return it (the kit tolerates `undefined` at run time), `RetentionPolicy` gains `signalsMs` and `PurgeResult` gains `signals`, and `POLICY_SECTIONS` gains `'pace'` and `'signals'`, so code that builds these by hand or switches over them needs the new members. `SignalInput` accepts `null` for `by`, `roomId` and `at`.
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

No changes in this release.

## 0.1.5

No changes in this release.

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

- No functional change. Released with the rest of the fixed version group at 0.1.1.
- Updated dependencies
- Updated dependencies
  - @chatwarden/core@0.1.1
  - @chatwarden/matcher@0.1.1

## 0.1.0

### Minor Changes

- First public release.

### Patch Changes

- Updated dependencies
  - @chatwarden/core@0.1.0
  - @chatwarden/matcher@0.1.0
