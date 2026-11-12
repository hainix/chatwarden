# @chatwarden/store-sqlite

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

- No functional change. It now passes the same store contract suite as the new in-memory store, and keeps reading audit rows written under either the old term audit names or the new term.* and exception.* names.
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
