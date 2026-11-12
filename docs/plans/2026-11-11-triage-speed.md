# Triage speed (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. Steps are test-first: write the failing test, see it red, make
> it green. Run targeted tests only (by file path); never a root `vitest run`. The package gate (`npx vitest run packages/<pkg>`) runs
> once at the end of a task, as CLAUDE.md allows. Tasks are ordered; the dependency line under each says what must be merged first.

**Goal:** a moderator clears hundreds of reports without typing a reason, without the mouse and without losing the ability to take a
click back. Four approved items, all additive, released as a PATCH (0.1.5):
1. Dismiss and auto-advance: a one-click "Nothing wrong here" in every mode with no typed reason, every quick action moves on to the
   next case, and Undo still works after the move.
2. Bulk dismiss: all open reports about one person (their case), or all open reports from one reporter, in one confirmed action.
3. Reporter accuracy: each reporter's false-report rate over a window with a minimum sample, shown on the case, used to rank their
   reports lower and never to hide one.
4. Keyboard queue mode: J/K and arrows move, 1/2/3 act, U undoes, so the mouse is optional.

**Architecture:** the rules live in core, the routes in http, and the hub only presents them. Nothing is forked.
- **Core** gets: a standard reason for a dismissal with no typed reason (`decide.ts`); a reporter-accuracy read built from one grouped
  store query (`reporterAccuracy.ts`, a new optional store method `reporterOutcomes`, SQLite migration 19); a bulk dismissal built on
  the same `DecisionService` path as a single decision (`cw.reports.dismissMany`); and an opt-in "rank habitual reporters lower" mode
  in take-next. All new store methods are OPTIONAL on `Store`, so a custom store keeps working (the features degrade).
- **http** gets one route `POST /reports/dismiss-open`, one permission `reports.decide.bulk`, two audit actions, an accuracy field on
  the open rows of `GET /reports`, and the relaxed `reason` on `POST /reports/:id/decide`.
- **hub-react** extends what is there: `useQuickActions` is CaseCard's logic lifted out and shared (CaseCard and the Detailed
  DecisionBar both use it); `keyScope.ts`, `shortcuts.ts` and the shortcut sheet are extended; the decision store gains
  `undoLatest` and `dismissOpen`; `groupQueue` gains a ranking option. Bulk dismiss and the reporter line sit behind the existing
  "Something else..." disclosure (Simple) and the decision bar (Detailed). No new always-visible control except one button,
  "Nothing wrong here", in the Detailed bar's existing button row.

**Spec:** this brief, plus the binding design notes.
- The owner, 2026-11-11: "the very common behavior pattern is someone just like incorrectly reports something, but now requires me to
  like read the report and type in a manual reason to dismiss the report. So there should be a pretty easy one click, like nothing
  happened here wrong, dismiss. And same for like if I'm handling hundreds of reports or going through so many queues, reports in the
  queue, it should be pretty seamless and quick for me to go through them. So yeah, quicker actions."
- The four approved items above (the owner approved all four).
- `docs/design/2026-11-10-hub-simple-mode-and-embedding.md`: Simple/Detailed modes; the four adoption paths (drop-in, pieces, hooks,
  headless controller); the public API lock (a test snapshots every export name; changing it is a deliberate snapshot edit and the
  changeset says which way); unstable pieces are `@experimental`; the i18n catalogue stays one flat key map. Simple's keys are N, J/K,
  1 (primary), 2 (No action needed) and Ctrl+Enter.
- `docs/design/2026-11-10-hub-workbench-and-teams.md`: one case per person; claims are soft locks (a senior may take over, audited);
  "filters, not routed queues"; the 5 second client-held Undo; verdict keys 1/2/3 in the Detailed bar; J/K, N, Ctrl+K, `?`; colour only
  where it means something; no per-person leaderboard (so no screen ranks reporters by name, see Task 10).
- Owner UI rule (2026-11-11): clean core, power behind one "advanced" door. Advanced features go behind an existing disclosure.

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`:
  - test-first; cover variants and edge cases, not one happy path
  - synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn)
  - targeted runs only; `npm run lint` and `npm run typecheck` before every push
  - every time from the injected `Clock` / the hub's `now`; no `Date.now()` in package code
  - no identifier in anything a player receives: the accuracy, the dismissals and the audit rows stay on staff channels
  - every hub string through `t()`; check the UI in a real browser at desktop and 360 px, light and dark (Task 12)
  - Playwright tests skip when Chromium is missing and fail only under `CW_REQUIRE_BROWSER=1`
- No breaking change to any exported API. New exports are `@experimental` in TSDoc and the hub-react API lock
  (`packages/hub-react/test/api.test.ts`) is updated in the same task that adds them. New `Store` methods are optional. New fields on
  exported output types are optional (precedent: `reportedReason?` in `ReportRecord`). `DecisionInput.reason` and `DecideInput.reason`
  become optional (a widening: every existing call still type-checks). `PermissionKey` gains one member (a widening, precedent
  `claims.override` in 0.1.2); the changeset says so.
- Budgets (bundle sizes) may only go down apart from a stated reason. This plan adds code to hub-react, so Task 13 records gzip
  before and after and raises each affected budget to the new size plus about 5%, with the reason in the commit.
- Constants are named and exported (core ones `@experimental`); no magic numbers in components.
- Branch `triage-speed`, worktree `C:\dev\chatwarden-wt\triage`, from main `b8074bc`. With more than one agent in the worktree:
  commit by pathspec (`git commit -s -- <paths>`), `git add` new files first, never delete `index.lock`, never stash. Commit trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the model that wrote the commit).
- Do not push or publish. Publishing follows RELEASING.md and only on the maintainer's go-ahead.

## Review Focus
The five failure modes most likely to bite. Every review reads these first.
1. **A dismissal lands on the wrong case.** Auto-advance plus a held key (`e.repeat`), a double tap, or a card that rendered under the
   finger can dismiss a case nobody read. Guards: act keys ignore `e.repeat`; a case accepts a quick key only after it is loaded and
   fresh and `QUICK_ACT_COOLDOWN_MS` after it appeared; a decision already waiting for the same report is ignored (the store does
   this); the dismissal is always held for the Undo window. Verify each guard has a test that fails without it.
2. **Undo after the move.** Rapid decisions stack several held decisions; the toast store caps at 3 toasts and today commits the oldest
   early, silently ending its Undo. Undo must also not strand claims (the case's claim is given back) and a send that fails after
   the moderator has left must still surface (existing "failed away" toast). Verify with 6 decisions inside 5 seconds.
3. **Bulk dismiss blast radius.** Wrong scope or stale count, an alias missed (a merged person's reports), another moderator's claim
   ignored, a bulk that can never mark bad faith but does, an audit trail with a gap (the summary row missing, or the per-report rows
   missing), a partial failure that leaves the caller unsure what happened, and `dryRun` that writes anything. The server decides on
   the live set at confirm time; the confirm count is only a preview.
4. **Reporter accuracy: integrity and privacy.** Off-by-one at the sample minimum and the window edge; open reports counted; bad-faith
   not counted as unfounded; aliases not folded; a feedback loop (bulk dismissals inflate a rate, which is intended, but must never
   suspend anyone); a real serious report from a habitual reporter buried (the all-reporters rule and the 24 hour lapse are the
   safety); the figure leaking to a player route, a webhook, an event, a log line, or a role without `history.read`.
5. **Keys, modes and older servers.** Detailed's 1/2/3 select a verdict today: making them act must be a choice the moderator makes,
   never a surprise. Ctrl+K vs K; selects (type-ahead eats J/K/U) and every other typing target; IME composition; a hub inside a
   shadow root; two hubs on one page; screen readers' browse mode. A new hub against an older `http` (empty reason refused 400) is
   handled by raising the peer floors (Task 13), and a missing `can['reports.decide.bulk']` hides bulk.

## Decisions (each with its reason)

### D1. A dismissal with no typed reason: core stores a standard reason (the hub sends none)
Chosen: core accepts an omitted or blank `reason` ONLY for `verdict: 'no_action'` with zero actions, and stores the constant
`NO_ACTION_DEFAULT_REASON = 'No action needed'` as the report's `modNote`. The hub's quick dismiss sends no `reason` at all. Every
other verdict, and a `no_action` that acts on someone, still needs a real reason.

Why this, and not "the hub always sends a preset":
- **The audit trail stays honest.** A preset sent by the hub is stored as if a moderator wrote it, in whatever language that hub was in
  ("No rule was broken", "Keine Regel verletzt", ...). A core constant is one recognisable value: "a human dismissed it and gave no
  reason" is distinguishable from a considered note (`isDefaultNoActionReason`). The K3c casebook can then skip the reason as a
  rationale while still taking the verdict as a label.
- **The API is cleaner.** One rule in one place (core), shared by the staff route, the signed incoming webhook and every other server.
  The alternative scatters a preset string over every client, and a client that forgets it gets a 400 for the most common action.
- **Display stays local.** The hub shows the stored default in the moderator's language (`hub.decided.reason.default`).
- The constraint "no actions" keeps the standard text out of a sanction record (a sanction's `reason` would otherwise read "No action
  needed" on a warning to the reporter).
- Idempotency is unchanged: the decision key excludes the actor and the reason, so a quick dismiss and a later typed dismiss of the
  same report are one decision (a replay).
- Cost: older servers answer 400 to a reasonless dismissal. Handled by the peer floors (Task 13), not by a client retry.

### D2. Bulk dismiss: one decision per report, one summary audit row, client-held Undo, no server reopen
- Each report is closed by the same `DecisionService` path as a single decision (`no_action`, no actions, standard reason, actor from
  the auth hook, `source: 'moderator'`), each in its own transaction, so every invariant of `decide` holds and each report gets its
  `report.closed` event. A bulk never uses `bad_faith`: that needs written evidence and counts toward a suspension.
- **Audit: both.** First one summary row (`report.dismiss_case` or `report.dismiss_reporter`, target the person or reporter ref),
  written in `required` mode BEFORE anything is closed, like `case.takeover` (a bulk that cannot be recorded does not happen). Then
  one `report.decide` row per report closed, `best-effort` (the decision has committed). "Who closed report X?" keeps working; "who
  swept this person's reports?" has one answer.
- **Permission:** new `reports.decide.bulk`, default `moderator` (the same people may already dismiss each report one by one; a
  separate key lets an adopter raise it to `senior`). Owner question 1.
- **Claims:** person scope behaves like `decide`: another moderator's live claim is 409 `claimed` unless `takeOver: true` and the
  caller holds `claims.override` (audited `case.takeover`, first). Reporter scope spans many cases and never takes over: cases held
  by someone else are skipped and counted.
- **Undo:** the hub holds the request for the same 5 second Undo window as a decision (confirm first, then hold, then send). After it
  is sent there is no server undo (the kit has no reopen). That is acceptable because a dismissal changes nothing for anyone: a
  wrongly dismissed player can still be sanctioned from their person page. A server-side reopen is parked (Not in this plan).
- **Size:** at most `BULK_DISMISS_MAX = 200` reports a call; the answer says `more: true` and the toast offers to run it again.
  Retrying a request is safe: a closed report is a replay, counted as `replayed`.

### D3. Reporter accuracy: computed in core from one grouped query, deliberately cheap, window by filing time
- `decided = actioned + noAction + badFaith` over the reporter's reports filed in the last `REPORTER_ACCURACY_WINDOW_MS` (30 days) that
  are no longer open. `unfounded = noAction + badFaith` (`dismissed`, with and without the bad-faith mark). `falseRate = unfounded /
  decided`, or `null` below `REPORTER_ACCURACY_MIN_DECIDED`. A bad-faith dismissal is the strongest false report; leaving it out of the
  numerator would let it dilute the rate. `noted` and `upheld` are both `actioned`: something was found.
- The window is on `created_at` (filing time), not decision time: it uses the existing reporter index and a report is decided within
  days of filing. Reporters are limited to 10 reports a day, so one reporter has at most about 300 rows in the window.
- Bulk dismissals count like any other dismissal: the moderator judged them. This is a feedback loop by design (sweeping a reporter's
  reports raises their rate); it only ever re-orders, and only after the minimum sample.
- It is a RANKING hint and a line on the case. It never refuses a report, never counts toward suspension, never reaches a player.

### D4. Quick keys: one preference, defaulting to what each mode does today
Simple already acts on 1/2/3. Detailed selects a verdict with them. Rather than silently change Detailed, "Quick keys" is a per-moderator
preference (browser storage, like the mode) in the shortcut sheet: ON means 1/2/3 act at once and J/K/arrows open the case they move
to. Default ON in Simple, OFF in Detailed. Owner question 2.

## The keyboard map (Task 8 implements it; this is the spec)

Heard on the hub root through `keyScope.ts` (a key pressed with focus inside the hub, or with nothing focused through the page's one
listener in `dom.ts`). Never while typing (`isTypingTarget`), while an input method composes, under a window (`modalIn`), with
Ctrl/Cmd/Alt (except the two combinations below), or when the adopter set `shortcuts` to false.

| Keys | Action | Where | Notes |
| --- | --- | --- | --- |
| J, Down arrow | next case | queue | Today: moves focus to the next row; Enter opens. Quick keys on: also opens it after `QUEUE_OPEN_DELAY_MS` (200 ms) so a held key does not claim every case it passes. Repeat allowed (it only moves). |
| K, Up arrow | previous case | queue | As above. |
| N | take the next unclaimed case | anywhere | Existing. Ignores repeat. |
| 1 | the suggested step (primary), then the next case | case | Simple: existing, now advances. Detailed: only with Quick keys on (else it selects the "Fair" verdict, as today). |
| 2 | Nothing wrong here, then the next case | case | Same rule. Detailed with Quick keys off: selects "Not a problem"; Ctrl+Enter then dismisses with no reason typed. |
| 3 | a warning (offered only when the ladder suggests more), then the next case | case | Same rule. In Detailed with Quick keys off it selects "Bad faith" (which needs written evidence, so it never acts at once). |
| Ctrl/Cmd+Enter | primary, then the next case | case | Existing; now the same as 1. Works while typing (made for the reason box). |
| U | undo the newest waiting decision, and show its case | anywhere | New (`ShortcutAction` gains `'undo'`). Ignores repeat. |
| Ctrl/Cmd+K | command bar | anywhere | Existing; the only Ctrl/Cmd letter we take. |
| ? | the shortcut sheet | anywhere | Existing. |
| Esc | close a window, or back to the queue | anywhere | Existing. |

Conflicts and how each is resolved:
- **Arrow keys scroll the page.** They move cases only when focus is on a queue row (`.cw-queue .cw-case-link`) or on the case's own
  title (`.cw-screen-title`, where the hub puts focus on arrival), and never inside `.cw-transcript` (its scroller), a field, a
  select, a menu or a window. Everywhere else they scroll as usual. J/K work wherever the other keys do.
- **Ctrl+K vs K.** `shortcutFor` already checks modifiers first: Ctrl/Cmd+K is the command bar and plain K is previous. Unchanged, and
  a test table holds it (with Caps Lock / Shift+K too).
- **Typing targets.** Inputs, textareas, selects, `contenteditable`, `role` textbox/combobox/searchbox. The one exception that exists
  today stays and is narrowed: the rule field (a select) still lets the digits 1, 2, 3 through (a digit cannot type into a select) and
  nothing else. J, K, U on a select would type-ahead an option, so they stay blocked there.
- **Detailed 1/2/3 (verdict select) vs queue mode (act).** The DecisionBar stands down its 1/2/3 handler exactly when Quick keys are on in
  Detailed; CaseCard/`QuickKeys` own the digits then. With "Something else..." open in Simple the card's digit handler stands down and
  the bar's verdict keys apply (existing behaviour, kept).
- **Held keys and double taps.** Act keys and U ignore `e.repeat`; a case accepts an act key only `QUICK_ACT_COOLDOWN_MS` (300 ms)
  after it became usable, so the second tap of a double tap, meant for the case just closed, cannot act on the next one.
- **Layouts.** Digits are matched on `e.key` (as today), so Shift+digit on AZERTY still works. `?` is matched on `e.key`.
- **Screen readers.** Browse mode swallows single keys; the keys are an accelerator only. Every key has a button, and `shortcuts={false}`
  (or `shortcuts="false"` on the element) turns them all off.
- **Shadow DOM and two hubs.** Unchanged mechanism (`useKeyListener`, `registerHub`); the new handlers register through the same bus,
  never on `window`. A test mounts two hubs and one shadow root.

The shortcut sheet (`?`) becomes three groups, each row a list of key caps and a catalogue line, plus one switch:
- **Move:** J / Down, K / Up, N.
- **Act on a case:** 1, 2, 3, Ctrl+Enter, U.
- **Anywhere:** Ctrl+K, ?, Esc.
- **Quick keys** switch (`role="switch"`, remembered): "With quick keys on, 1, 2 and 3 act at once and J, K and the arrow keys open
  the case they move to." Rows that only apply with quick keys on say so.

---

### Task 1: A dismissal with no reason (core, http)
Depends on: nothing.

**Files**
- Modify `packages/core/src/decide.ts`, `packages/core/src/index.ts` (exports), `packages/core/src/chatwarden.ts` (docs on `decide`).
- Modify `packages/http/src/admin/apply.ts` (`parseDecision`, `ParsedDecision.reason?`, `applyDecision`), `packages/http/src/admin/reports.ts`
  (route doc), `packages/http/README.md`, `packages/core/README.md`.
- Create `packages/core/test/decide-default-reason.test.ts`, `packages/http/test/admin.quick-dismiss.test.ts`.

**Interfaces**
```ts
// decide.ts
/** @experimental */
export const NO_ACTION_DEFAULT_REASON = 'No action needed';
/** @experimental. True for the standard reason (trimmed); false for anything else, including null. */
export function isDefaultNoActionReason(reason: string | null | undefined): boolean;
// DecisionInput
/**
 * Private; at most 500 characters after trimming. Required, except for a `no_action` decision with NO actions, where an absent or
 * blank reason is stored as NO_ACTION_DEFAULT_REASON.
 */
reason?: string;
// http ParsedDecision
reason?: string;   // parseDecision omits it when the body has none; bodyText still checks a given one
```
`normalize`: a `reason` that is neither undefined nor a string is `invalid` for every verdict; trim; blank becomes the default only
for `no_action` with `actions.length === 0`, otherwise `invalid`; the 500 character cap is checked after substitution.

**Tests** (core `decide-default-reason.test.ts`)
- `a no_action decision with no reason closes the report and stores the standard reason as modNote`
- `a blank or whitespace-only reason is the same as none for no_action`
- `a typed reason on no_action is kept exactly as typed (trimmed)`
- `no_action that acts on the reporter still needs a reason`
- `upheld, noted and bad_faith refuse an absent reason and a blank reason` (table of the three verdicts x absent, '', '   ')
- `a reason that is not a string is invalid for every verdict` (number, null, object, array)
- `a reason over 500 characters is still refused, with and without the default`
- `the same dismissal with and without a reason is one decision: the second is a replay`
- `a reasonless dismissal makes no notice, no sanction and no reporter outcome notice` (player-side leak guard)
- `isDefaultNoActionReason matches the constant, trimmed, and nothing else`
- `decisionKey is the same for a reasonless and a reasoned no_action`

(http `admin.quick-dismiss.test.ts`)
- `POST /reports/:id/decide accepts no_action with no reason key`
- `... accepts no_action with reason ""`
- `... refuses upheld, noted and bad_faith with no reason (400 invalid_request)`
- `... refuses no_action with actions and no reason (400)`
- `the signed incoming webhook takes a reasonless no_action by the same rule` (uses `applyDecision`)
- `one report.decide audit row is written, and a replay writes one more, as before`

**Steps:** red tests in core, then `normalize`; red tests in http, then `parseDecision`; update the route and README text.
**Run:** `npx vitest run packages/core/test/decide-default-reason.test.ts packages/core/test/decide.test.ts packages/http/test/admin.quick-dismiss.test.ts packages/http/test/admin.reports.test.ts`; then `npx vitest run packages/core packages/http` once.

---

### Task 2: Reporter accuracy in core and both stores (migration 19)
Depends on: nothing (parallel with Task 1).

**Files**
- Create `packages/core/src/reporterAccuracy.ts`; modify `packages/core/src/types.ts` (`ReporterOutcomeRow`, optional `Store.reporterOutcomes`),
  `packages/core/src/staffViews.ts` (`ReporterRecord.accuracy?`, `reporterRecord`), `packages/core/src/chatwarden.ts`
  (`reports.reporterAccuracy`), `packages/core/src/index.ts`.
- Modify `packages/store-memory/src/memoryStore.ts`, `packages/store-sqlite/src/sqliteStore.ts`, `packages/store-sqlite/src/migrations.ts`
  (migration 19).
- Modify `test/contract/reports.contract.ts`. Create `packages/core/test/reporter-accuracy.test.ts`,
  `packages/store-sqlite/test/reporter-outcomes.store.test.ts`.

**Interfaces**
```ts
// reporterAccuracy.ts: named thresholds, all @experimental
export const REPORTER_ACCURACY_WINDOW_MS = 30 * 86_400_000;  // 30 days, the same as SUSPEND_WINDOW_MS
export const REPORTER_ACCURACY_MIN_DECIDED = 5;              // fewer decided reports: no rate, nobody ranked down
export const REPORTER_FALSE_RATE_NOTICEABLE = 0.6;           // the case shows a line from here
export const REPORTER_FALSE_RATE_HABITUAL = 0.8;             // reports rank lower from here
export const REPORTER_ACCURACY_BATCH_MAX = 200;              // people per call; more is RangeError
export interface ReporterAccuracy {
  decided: number;            // actioned + noAction + badFaith
  noAction: number;           // dismissed, not marked bad faith
  badFaith: number;           // dismissed with the bad-faith mark
  unfounded: number;          // noAction + badFaith
  falseRate: number | null;   // unfounded / decided; null below REPORTER_ACCURACY_MIN_DECIDED
  noticeable: boolean;        // falseRate >= REPORTER_FALSE_RATE_NOTICEABLE
  habitual: boolean;          // falseRate >= REPORTER_FALSE_RATE_HABITUAL
  windowMs: number;           // REPORTER_ACCURACY_WINDOW_MS, so a screen can say "in the last 30 days"
}
export function summarizeOutcomes(c: { actioned: number; noAction: number; badFaith: number }): ReporterAccuracy;
export function reporterAccuracyFor(store: Store, subjects: SubjectIndex, people: readonly SubjectId[], now: number): Map<SubjectId, ReporterAccuracy>;
// types.ts
/** One reporter's decided reports (filed at or after `since`) by outcome, for reporterOutcomes. `reporter` is as stored. */
export interface ReporterOutcomeRow { reporter: SubjectId; actioned: number; noAction: number; badFaith: number }
// Store (OPTIONAL, like loadReporterDecisions)
reporterOutcomes?(reporters: readonly SubjectId[], since: number): ReporterOutcomeRow[];
// ReporterRecord
accuracy?: ReporterAccuracy | null;   // null when the store has no reporterOutcomes; always set by this version
// facade (cw.reports)
reporterAccuracy(people: readonly SubjectId[]): Map<SubjectId, ReporterAccuracy>;  // keyed by canonical person; people with no decided reports absent
```
`reporterAccuracyFor`: canonicalise each person, expand to `subjects.aliasesOf`, one `store.reporterOutcomes(allAliases, now - window)`
call, fold rows by `subjects.canonical(row.reporter)`, summarise. A store without the method gives an empty map. The facade method
documents "staff only: never send to a player".

**The store queries**
- SQLite (`reporterOutcomes`), chunked at 500 variables like `loadReporterDecisions`:
  ```sql
  SELECT reporter_subject AS reporter,
         SUM(status = 'actioned')                    AS actioned,
         SUM(status = 'dismissed' AND bad_faith = 0) AS no_action,
         SUM(status = 'dismissed' AND bad_faith = 1) AS bad_faith
  FROM kit_reports
  WHERE reporter_subject IN (?, ...) AND created_at >= ? AND status != 'open'
  GROUP BY reporter_subject
  ```
- Memory: one pass over `this.reports`, same predicate and grouping (O(reports); the memory store is for tests and demos).
- **Migration 19** (the first after 18), one statement, an index only, no table or row change:
  ```sql
  CREATE INDEX kit_reports_by_reporter_outcome ON kit_reports (reporter_subject, created_at, status, bad_faith);
  ```
  Why: `kit_reports_by_reporter (reporter_subject, created_at)` finds the rows but every row then needs a table read for `status` and
  `bad_faith`; a queue page asks for up to 200 reporters x up to ~300 rows each. With the two extra columns the grouped query is
  answered from the index alone (a covering index), and Task 3's "open reports by reporter" reads `status` from the index before it
  touches the table. The older index is now a prefix of the new one; it is kept in this patch (dropping is parked, see Not in this plan).
  The migration comment states this in the style of migrations 17 and 18.

**Tests**
- (core pure) `below the minimum sample the rate is null, and the reporter is neither noticeable nor habitual`; `exactly the minimum
  counts`; `no_action and bad_faith are unfounded, actioned (upheld and noted) is founded`; `habitual at exactly 0.8 and not at 7 of 9`;
  `noticeable at exactly 0.6`; `all upheld gives falseRate 0`.
- (service, memory store) `open reports are not counted`; `a report filed exactly at the window start counts and one a millisecond
  earlier does not`; `merged aliases are one reporter`; `people with no decided reports are absent`; `a batch is one store call`
  (spy); `more than REPORTER_ACCURACY_BATCH_MAX people is a RangeError`; `a store without reporterOutcomes gives an empty map and
  reporterRecord.accuracy is null`; `reporterRecord carries accuracy and its other counts are unchanged`.
- (contract, both stores) `reporterOutcomes splits decided reports by outcome`; `... excludes open`; `... honours since`; `... empty
  list gives []`; `... bad-faith dismissals are badFaith, not noAction`; `... one row per stored reporter id`.
- (sqlite) `migration 19 creates the index`; `upgrading a database at version 18 with rows keeps every row and is idempotent`;
  `EXPLAIN QUERY PLAN of the real reporterOutcomes SQL shows USING COVERING INDEX kit_reports_by_reporter_outcome and no SCAN of
  kit_reports` (record the prepared SQL as `indexes.store.test.ts` does); `a 501-reporter call is chunked and totals match the memory
  store` (differential).

**Run:** `npx vitest run packages/core/test/reporter-accuracy.test.ts packages/core/test/staffViews.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/contract.test.ts packages/store-sqlite/test/reporter-outcomes.store.test.ts packages/store-sqlite/test/differential.test.ts packages/store-sqlite/test/open.test.ts`.

---

### Task 3: Bulk dismiss in core
Depends on: Task 1 (standard reason). Task 2 for the index only.

**Files**
- Create `packages/core/src/dismissMany.ts`. Modify `packages/core/src/chatwarden.ts` (extract the body of `decide` into a local
  `decideAnnounced(input)` that `decide` and `dismissMany` both call, so events are emitted identically), `packages/core/src/types.ts`
  (optional `Store.listOpenReportsByReporter`), `packages/core/src/audit.ts` (`AUDIT_ACTIONS`), `packages/core/src/index.ts`.
- Modify both stores and the contract (`test/contract/reports.contract.ts`).
- Create `packages/core/test/dismiss-many.test.ts`.

**Interfaces**
```ts
/** @experimental. The most reports one dismissMany call closes. */
export const BULK_DISMISS_MAX = 200;
/** @experimental. Reports read when a store cannot list a reporter's open reports and the scan fallback is used. */
export const BULK_REPORTER_SCAN_MAX = 5_000;
/** @experimental */
export type DismissScope = { person: SubjectId } | { reporter: SubjectId };
/** @experimental */
export interface DismissManyInput {
  scope: DismissScope;                // a staff ref; aliases are folded
  actor: string;                      // the audit trail's actor rule (RangeError otherwise, as cases.*)
  reason?: string;                    // optional; absent or blank is NO_ACTION_DEFAULT_REASON
  dryRun?: boolean;                   // count only; nothing is written
  ignoreClaims?: boolean;             // default false. For the staff layer only, after it has checked who may take a case over
  limit?: number;                     // default and maximum BULK_DISMISS_MAX; a non-integer or < 1 is invalid
}
/** @experimental. Carries subject ids: staff channels only, never send to a player. */
export type DismissManyResult =
  | {
      ok: true;
      dryRun: boolean;
      open: number;                   // open reports in scope that this call would close (after claim exclusion), up to limit
      dismissed: number;              // closed by THIS call
      replayed: number;               // already closed by an identical earlier dismissal
      skipped: { claimed: number; decided: number };  // held by another moderator / closed meanwhile by a different decision
      more: boolean;                  // more open reports in scope than limit
      reportIds: string[];            // dismissed + replayed, for the staff layer's audit rows
      targets: SubjectId[];           // canonical people whose reports were closed, for releasing the actor's claims
    }
  | { ok: false; error: 'invalid' };
// facade
cw.reports.dismissMany(input: DismissManyInput): Promise<DismissManyResult>;
// Store (OPTIONAL)
listOpenReportsByReporter?(reporters: readonly SubjectId[], limit: number): ReportRecord[];  // newest first, like listOpenReportsByPerson; limit clamped 1..201
// audit.ts: two new closed-list names
'report.dismiss_case' | 'report.dismiss_reporter'
```
Algorithm: validate everything up front (actor, scope, reason, limit) so a bad input writes nothing; read `limit + 1` open reports
(person: `listOpenReportsByPerson(aliasesOf(person))`; reporter: `listOpenReportsByReporter`, else a bounded scan of `listOpenReports`
keyed pages, `BULK_REPORTER_SCAN_MAX` reports at most); `more = rows.length > limit`; unless `ignoreClaims`, one `cases.holders(targets)`
read excludes reports whose target person is held by someone other than `actor` (counted `skipped.claimed`); then for each remaining
report call `decideAnnounced({ reportId, verdict: 'no_action', actions: [], actor, reason, source: 'moderator' })` one after another:
`ok && !replay` is dismissed, `ok && replay` is replayed, `already_decided` and `not_found` are `skipped.decided`. A store failure
rejects; reports closed before it stay closed, and running the call again finishes the rest (idempotent).
`dryRun` does the reads and the claim exclusion and returns `dismissed: 0`.

**Index needs (sqlite `listOpenReportsByReporter`):** `WHERE reporter_subject IN (...) AND status = 'open' ORDER BY created_at DESC, id
DESC LIMIT ?`, served by `kit_reports_by_reporter_outcome` (Task 2). The EXPLAIN test is in this task.

**Tests** (`dismiss-many.test.ts`)
- `person scope closes every open report about the person, merged aliases included`
- `reporter scope closes every open report the reporter filed, against different people`
- `each closed report is a no_action decision with the standard reason, no actions, no notice and no reporter outcome notice`
- `a bulk never marks bad faith: the reporter's suspension count and the bad-faith marks are unchanged`
- `reports already decided are untouched`; `a report closed by a different decision in between is counted skipped.decided`
- `a case another moderator holds is skipped and counted skipped.claimed; the actor's own claim is not`
- `ignoreClaims closes a claimed case`
- `dryRun writes nothing (reports, decisions, audit untouched, change token unchanged) and reports open and claimed counts`
- `limit: exactly BULK_DISMISS_MAX are closed and more is true; a second call closes the rest and more is false`
- `running it twice is safe: the second call dismisses 0 and replays 0 when nothing is open; an identical retry replays`
- `a store failure on the fourth report rejects, the first three stay closed, and a rerun closes the remaining ones`
- `invalid input writes nothing`: unknown scope, both scopes, blank subject, non-integer limit, limit 0, blank or invalid actor, reason over 500
- `a store without listOpenReportsByReporter uses the scan and gives the same result`
- `report.closed is emitted once per dismissed report and never for a replay or a skip`
- contract (both stores): `listOpenReportsByReporter returns only open reports of those reporters, newest first, limit clamped`
- sqlite: `EXPLAIN QUERY PLAN for listOpenReportsByReporter uses the reporter index and does not SCAN kit_reports`
- audit: `AUDIT_ACTIONS lists the two new names; cw.audit.record accepts them with a person target and refuses a detail`

**Run:** `npx vitest run packages/core/test/dismiss-many.test.ts packages/core/test/audit.test.ts packages/core/test/events.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/contract.test.ts packages/store-sqlite/test/reporter-outcomes.store.test.ts`.

---

### Task 4: Take-next ranks habitual reporters lower (core)
Depends on: Task 2.

**Files:** modify `packages/core/src/team.ts` (`CaseDesk.next`, `TeamDeps.accuracy?`), `packages/core/src/chatwarden.ts` (pass the accuracy
reader to the desk; `cases.next` filter), `packages/core/src/reporterAccuracy.ts` (constants); create `packages/core/test/team-rankdown.test.ts`.

**Interfaces**
```ts
/** @experimental. A case that has waited this long ranks normally whoever reported it (the hub's "overdue" line, 24 h). */
export const REPORTER_RANK_LAPSE_MS = 24 * 3_600_000;
/** @experimental. Open reports read, at most, while looking for a case that is not ranked down. */
export const RANK_DOWN_SCAN_MAX = 1_000;
// cw.cases.next(actor, filter?: { category?; reason?; rankDownHabitual?: boolean })   // default false: behaviour unchanged
```
Rule: with `rankDownHabitual`, a candidate case is "ranked down" when it has no open report older than `REPORTER_RANK_LAPSE_MS` and EVERY
open report against the person was filed by a reporter whose `ReporterAccuracy.habitual` is true (one ordinary reporter, or no
accuracy data, keeps it normal). The scan claims the first normal case in oldest-first order; ranked-down candidates are remembered
in order and, when the scan ends (end of queue, or `RANK_DOWN_SCAN_MAX` reports read), the oldest of them is claimed. Nothing is
skipped for good: a queue holding only habitual cases still serves them, oldest first. Accuracy for a page's candidates is one
`reporterAccuracyFor` call; each candidate's open reports are one `listOpenReportsByPerson` read, only when the mode is on.

**Tests:** `default behaviour is unchanged: oldest case first` (the existing `team.test.ts` cases still pass untouched);
`a case whose only reporters are habitual is served after a newer normal case`; `a case with one habitual and one ordinary reporter is
not ranked down`; `a case waiting longer than the lapse is not ranked down (23:59:59 vs 24:00:01 on the injected clock)`;
`only habitual cases left: they are all served, oldest first`; `below the minimum sample nobody is ranked down`; `a ranked-down case
held by another moderator is skipped without a write`; `the scan stops at RANK_DOWN_SCAN_MAX and serves the oldest ranked-down case`;
`two moderators racing never get the same case in either mode`; `the category and reason filters still apply`; `a store with no
reporterOutcomes ranks nobody down`.
**Run:** `npx vitest run packages/core/test/team-rankdown.test.ts packages/core/test/team.test.ts packages/store-sqlite/test/team.store.test.ts`.

---

### Task 5: http: the bulk route, the permission, the accuracy field
Depends on: Tasks 1, 2, 3, 4.

**Files**
- Modify `packages/http/src/permissions.ts`, `packages/http/src/admin/reports.ts` (+ `ReportSummary.reporterAccuracy`), `packages/http/src/admin/team.ts`
  (`POST /cases/next` passes `rankDownHabitual: true`), `packages/http/src/admin/validate.ts` (`bodyDismissOpen`), `packages/http/README.md`.
- Create `packages/http/test/admin.dismiss-open.test.ts`; extend `packages/http/test/permissions.test.ts`, `admin.me.test.ts`,
  `admin.every-route.test.ts`, `admin.reports.test.ts`, `admin.team.test.ts`.

**Interfaces**
```ts
// permissions.ts: PERMISSION_KEYS gains 'reports.decide.bulk'; PERMISSIONS['reports.decide.bulk'] = 'moderator'
// POST /reports/dismiss-open   (permission reports.decide.bulk)
// body:  { scope: 'person' | 'reporter', ref: string, takeOver?: boolean, dryRun?: boolean }
//        (reason is deliberately NOT accepted: a sweep always carries the standard reason; unknown keys are 400 forbidden_key)
// 200:   { ok: true, dryRun: boolean, open: number, dismissed: number, replayed: number,
//          skipped: { claimed: number, decided: number }, more: boolean }
// 400 invalid_request | 403 forbidden | 409 claimed (person scope, held by someone else, no takeover)
// ReportSummary (GET /reports), open rows only, only for callers whose role holds history.read, else null:
reporterAccuracy: { decided: number; unfounded: number; falseRate: number | null; habitual: boolean } | null;
```
Route order (non-dry run): parse and validate; `need` is the route permission; person scope runs `gateCase(ctx, c, person, takeOver)`;
write the summary audit row (`report.dismiss_case` target `{type:'person', ref}` or `report.dismiss_reporter`) in `required` mode;
call `cw.reports.dismissMany({ scope, actor: c.authz.actor, ignoreClaims: scope === 'person', limit: BULK_DISMISS_MAX })`; write one
`report.decide` row per `reportIds` entry that was dismissed (not replayed), `best-effort`; for each `targets` person call
`cw.cases.releaseWhenDone(person, actor)` in a try/catch like `decide`. A `dryRun` runs the same validation, writes no audit row, takes
no case over and returns counts only. The response never carries report ids or subject ids. Unknown refs answer 200 with zeros (no
existence leak). Only `GET /reports` open rows get `reporterAccuracy`; the history route already carries `asReporter.accuracy`.

**Tests** (`admin.dismiss-open.test.ts` unless noted)
- `a moderator dismisses all open reports about a person: each is no_action with the standard reason`
- `audit: one report.dismiss_case row first, then one report.decide row per dismissed report, in that order`
- `the summary row is required: when it cannot be written the answer is 500 and nothing is dismissed`
- `a failing per-report audit row is logged and the answer stays 200`
- `reporter scope: report.dismiss_reporter, reports against different people closed, other reporters' reports untouched`
- `dryRun counts, writes no audit row, closes nothing and takes no case over`
- `person scope: another moderator's claim is 409 claimed; a moderator's takeOver is 409; a senior's takeOver audits case.takeover first and dismisses`
- `reporter scope skips cases held by others and says how many; takeOver is refused as an unknown key`
- `the caller's own claim is released when no open report is left, and kept while one is`
- `permissions: reports.decide.bulk raised to senior gives a moderator 403 and changes nothing; a reports.read-only caller is 403; an unauthenticated one 401`
- `bad bodies are 400: unknown scope, missing ref, ref not a string, ref over 128 characters, takeOver or dryRun not a boolean, extra keys, array body`
- `more is true past 200 and a second call finishes; a retried identical request replays and dismisses 0`
- `the response and the error bodies contain no report id, subject id or reporter ref`
- `GET /reports gives open rows reporterAccuracy for a history.read caller and null without it; decided rows are null` (admin.reports)
- `GET /me .can has reports.decide.bulk` (admin.me); `every admin route is audited or exempt` (admin.every-route lists the new route)
- `POST /cases/next serves an ordinary case before a habitual-reporter case` (admin.team)
- leak guard: `no player route, webhook payload (out or in) or event carries reporterAccuracy, unfounded, falseRate or habitual`

**Run:** `npx vitest run packages/http/test/admin.dismiss-open.test.ts packages/http/test/permissions.test.ts packages/http/test/admin.me.test.ts packages/http/test/admin.every-route.test.ts packages/http/test/admin.reports.test.ts packages/http/test/admin.team.test.ts packages/http/test/exports.test.ts`; then `npx vitest run packages/http` once.

---

### Task 6: hub-react data layer (client, types, form rules, ranking, decision store)
Depends on: Task 5's interfaces (types can be written against them while Task 5 is in review).

**Files**
- Modify `packages/hub-react/src/types.ts`, `client.ts`, `decision.ts`, `simple.ts`, `queue.ts`, `headless/decisions.ts`,
  `headless/toasts.ts`, `headless/liveQueue.ts`, `headless/index.ts`, `index.ts`, `decisions.tsx` (React binding), `toasts.tsx` (UI).
- Modify `packages/hub-react/test/api.test.ts` (inline snapshots).
- Create/extend `packages/hub-react/test/decision.test.ts`, `queue-rank.test.ts`, `headless/decisions-dismiss.test.ts`, `headless/toasts-held.test.ts`, `client.test.ts`.

**Interfaces**
```ts
// types.ts
/** @experimental */ export interface ReporterAccuracySummary { decided: number; unfounded: number; falseRate: number | null; habitual: boolean }
ReportSummary.reporterAccuracy?: ReporterAccuracySummary | null;      // optional: an older server sends none
ReporterRecord.accuracy?: ReporterAccuracy | null;                    // re-exported kit type
DecideInput.reason?: string;
/** @experimental */ export interface DismissOpenInput { scope: 'person' | 'reporter'; ref: string; takeOver?: boolean; dryRun?: boolean }
/** @experimental */ export interface DismissOpenResult { ok: true; dryRun: boolean; open: number; dismissed: number; replayed: number; skipped: { claimed: number; decided: number }; more: boolean }
// client.ts
dismissOpen(input: DismissOpenInput): Promise<DismissOpenResult>;      // POST /reports/dismiss-open   (@experimental, on the already experimental HubClient)
// decision.ts
// validate(): reason is required unless verdict === 'not_a_problem' and there are no actions; a given reason is still capped at REASON_MAX.
// toInput(): omits `reason` when it is blank, the verdict is 'not_a_problem' and there are no actions.
// simple.ts
export function noActionForm(reason?: string): DecisionForm;           // no reason by default: the dismissal the kit stores the standard reason for
// queue.ts
groupQueue(items, options?: { sort?: QueueSort; rankDown?: { now: number } }): QueueGroup[]
QueueGroup.rankedLow?: boolean;   // true when rankDown was asked and the case is ranked down (same rule as core Task 4)
// headless/decisions.ts: DecisionStore gains (all @experimental)
undoLatest: () => string | null;   // undoes the newest HELD decision, answers its report id (the case is shown again, as Undo does), else null
dismissOpen: (request: DismissOpenRequest, options?: DecideOptions) => Promise<DismissOpenOutcome>;
previewDismiss: (scope: 'person' | 'reporter', ref: string) => Promise<DismissOpenResult>;   // dryRun call, no hold
export interface DismissOpenRequest { scope: 'person' | 'reporter'; ref: string; person: string; name: string; reportIds: readonly string[]; takeOver?: boolean }
export type DismissOpenOutcome =
  | { status: 'done'; result: DismissOpenResult }
  | { status: 'failed'; error: HubError }
  | { status: 'undone' };
// headless/toasts.ts
export const TOAST_HELD_MAX = 10;   // @experimental
```
Behaviour:
- `reporterAccuracy` flows from `ReportSummary` into `groupQueue`: `rankedLow` is true when `rankDown` is given, the group has an open
  report, EVERY open report has `reporterAccuracy?.habitual === true`, and the oldest open report is younger than
  `REPORTER_RANK_LAPSE_MS` (imported from core, one source of truth). The result is a stable partition of the chosen sort: ordinary
  cases first, ranked-low cases after, each keeping its sort order. Nothing is removed. `liveQueue.ts` passes `rankDown: { now: now() }`.
  Because `reconcile` keeps on-screen order and `adopt` applies a new order only on first load or "N new", ranking never moves a row
  under the pointer or focus.
- Toasts: `capped()` counts only non-held toasts against `TOAST_MAX` (3); held toasts are capped separately at `TOAST_HELD_MAX`
  (10, the oldest committed early beyond that). The toast host shows the newest held toast in full with Undo, and one line
  "N earlier decisions waiting" for the rest (their timers keep running).
- `dismissOpen`: for person scope, each id in `reportIds` is entered in the store as a held entry (so the case leaves the queue and
  `decidedIds()` covers it exactly like a single decision, and Undo gives the claim back); for reporter scope nothing is hidden in
  advance. One hold (the same `UNDO_MS`) with the text `hub.bulk.held`, then one `client.dismissOpen`; on success the held entries
  become done, a toast says `hub.bulk.done` and, when `skipped.claimed > 0` or `more`, the matching line; the queue reloads. A 409
  `claimed` marks the entries failed and puts the claim holder in the queue as `send` does today.
- `undoLatest` walks `holds` newest first and calls `undo()` on the first one still held.

**Tests**
- `decision.test.ts`: `not_a_problem with a blank reason validates and toInput omits reason`; `not_a_problem with a reason keeps it`; `fair, bad_faith and any verdict with actions still require a reason`; `a 501 character reason is refused for not_a_problem too`; `noActionForm() has no reason`.
- `queue-rank.test.ts`: `a case whose open reports are all from habitual reporters sorts after ordinary cases in every sort`; `one ordinary reporter keeps it normal`; `a report waiting 24 h or more is not ranked low (boundary, injected now)`; `no rankDown option: order identical to today`; `a missing reporterAccuracy (older server) ranks nobody low`; `nothing is dropped: the output has the input's cases`; `sorting is stable and deterministic across input order`.
- `live-ranking.test.ts` (extends `live.test.ts`): `a row ranked low by a refresh does not move while the pointer or focus is in the list; it moves on "N new"`.
- `decisions-dismiss.test.ts`: `undoLatest undoes the newest held decision and returns its id; again, the next; null when none`; `undoLatest after the moderator has gone on shows the undone case`; `six decisions in five seconds are all undoable` (with `TOAST_MAX` 3); `a held toast is not pushed off by news toasts`; `the 11th held decision commits the oldest`; `dismissOpen holds, then sends once, then reloads the queue`; `Undo before the send sends nothing and gives the claim back`; `reporter scope hides nothing in advance`; `409 claimed fails the entries and reports who holds it`; `previewDismiss sends dryRun and holds nothing`; `pagehide flushes a held dismissOpen`.
- `client.test.ts`: `dismissOpen posts JSON with the write header and returns the typed result`; `reporterAccuracy passes through listReports`.
- API lock: the added type names `ReporterAccuracySummary`, `DismissOpenInput`, `DismissOpenResult`, `DismissOpenRequest`, `DismissOpenOutcome` and the value `TOAST_HELD_MAX` appear in the snapshots, marked experimental.

**Run:** `npx vitest run packages/hub-react/test/decision.test.ts packages/hub-react/test/queue-rank.test.ts packages/hub-react/test/live.test.ts packages/hub-react/test/headless packages/hub-react/test/client.test.ts packages/hub-react/test/api.test.ts packages/hub-react/test/headless-types.test.ts`.

---

### Task 7: Quick actions and auto-advance (Simple card and Detailed bar)
Depends on: Task 6.

**Files**
- Create `packages/hub-react/src/case/useQuickActions.ts`, `packages/hub-react/src/case/QuickKeys.tsx`.
- Modify `case/CaseCard.tsx` (use the hook; delete the logic it replaces), `case/DecisionBar.tsx` (one button, stand-down rule),
  `case/Decided.tsx` and `case/DecisionResult.tsx` (show the standard reason in words), `labels.ts`, `i18n.ts`, `styles.css`.
- Tests: extend `case-decide.test.tsx`, `case-fixes.test.tsx`, `decide-e2e.test.tsx`, `keys-after-load.test.tsx`; create `quick-actions.test.tsx`, `decided-default-reason.test.tsx`.

**Interfaces**
```ts
/** @experimental. A case accepts a quick key only this long after it became usable. */
export const QUICK_ACT_COOLDOWN_MS = 300;
export interface QuickActions {
  usable: boolean;                     // the case is open, loaded, fresh, editable, not read-only, nothing waiting
  primary: OneClick | null;
  warning: OneClick | null;
  sendPrimary(): void;                 // 1 and Ctrl+Enter
  sendDismiss(): void;                 // 2 and the button: noActionForm(), no reason
  sendWarning(): void;                 // 3
}
export function useQuickActions(options?: { enabled?: boolean }): QuickActions;   // reads useCase(), useDecisions(), useCaseActions()
```
Every `send*` does `decisions.submit(...)` and then `void actions.continueFrom({ reportId, person })`: the same person's next open
report, else Take next, else the team view when nobody waits. Nothing else in the send path changes (hold, Undo, claim give-back).
`QuickKeys` is a renderless component that registers the digit and Ctrl+Enter handler through `useKeyListener` for the case it is
inside, with the guards (`!e.repeat`, no modifiers other than the Ctrl/Cmd+Enter pair, not a typing target except the rule select
for digits, `modalIn(hub) === null`, cooldown, `usable`). CaseCard renders it (Simple); the Detailed case panel renders it only when
Quick keys are on (Task 8 supplies the flag). The Detailed bar gets one extra button, "Nothing wrong here" (`hub.quick.dismiss`),
in its `.cw-submit` row beside "Decide and take next"; its click is `sendDismiss()`. The bar's verdict-key handler stands down when
Quick keys are on in Detailed. The "Decided" view and the result show `hub.decided.reason.default` in place of the stored text when
`isDefaultNoActionReason(modNote)` is true.

**Tests** (`quick-actions.test.tsx` unless noted)
- `2 dismisses with no reason: the decide body has no reason key` (assert the fetched body), Simple and Detailed (Quick keys on)
- `1, 2 and 3 each submit, then open the next case` (same-person next report first; else take-next; else the team view)
- `the primary button, No action needed and the warning button advance too (click, not only keys)`
- `Ctrl+Enter is the same as 1`
- `a held key is one action: repeat events are ignored`
- `a second tap within QUICK_ACT_COOLDOWN_MS of the next case appearing does nothing; after it, it acts` (injected `now`)
- `a key pressed while the next case is still loading does nothing`
- `a key pressed while a decision for this report waits is ignored (no double submit)`
- `a read-only case (held by another moderator), a closed case, a role without reports.decide: keys do nothing`
- `typing in the reason box, a note field or a select: digits do nothing (except the rule select, digits only)`
- `with Something else open (Simple) the digits select verdicts in the bar, as before`
- `Detailed, Quick keys off: 2 selects Not a problem; Ctrl+Enter then dismisses with no reason typed; the Nothing wrong here button dismisses at once`
- `Detailed, Quick keys on: 1, 2, 3 act and the bar's handler is silent` (no double handling: exactly one submit)
- `Undo after advance: press 2 on A, advance to B, Undo on A's toast: A is shown again with its claim, nothing was sent for A`
- `Undo after advance: six quick dismissals in five seconds, U six times, all six cases come back newest first`
- `a send that fails after the move shows the "failed away" toast with a way back`
- `focus: after the move the new case's title has focus; after Undo the button that sent it has focus`
- `a11y: the new button has an accessible name and aria-keyshortcuts only when shortcuts are on` (extend the a11y suites; axe clean)
- `decided-default-reason.test.tsx`: `the Decided view shows "No reason given" in the viewer's language for the standard reason and the typed text otherwise`.
- Piece check (`pieces.test.tsx`): `CaseCard as a piece: keys still work only with focus inside the card; with no onOpenReport and no onOpenCase, 2 dismisses and does not take a case nothing would show`.

**Run:** `npx vitest run packages/hub-react/test/quick-actions.test.tsx packages/hub-react/test/case-decide.test.tsx packages/hub-react/test/case-fixes.test.tsx packages/hub-react/test/decide-e2e.test.tsx packages/hub-react/test/keys-after-load.test.tsx packages/hub-react/test/decided-default-reason.test.tsx packages/hub-react/test/pieces.test.tsx packages/hub-react/test/a11y-report.test.tsx`.

---

### Task 8: Keyboard queue mode
Depends on: Task 7 (QuickKeys) and Task 6 (`undoLatest`).

**Files**
- Create `packages/hub-react/src/quickKeys.ts` (preference).
- Modify `shortcuts.ts`, `Hub.tsx` (`Shortcuts`), `shell/ShortcutSheet.tsx`, `shell/QueuePane.tsx` (nothing visible; `aria-keyshortcuts` only),
  `commands.ts` (one command: "Undo the last decision" when one is waiting; no change to ranking), `dom.ts` (a `closestIn` helper only if
  needed), `i18n.ts`, `styles.css`, `index.ts` (`ShortcutAction` already exported).
- Tests: extend `shortcuts.test.ts` (or create), `command-bar.test.tsx`, `keys-after-load.test.tsx`, `multi-hub.test.tsx`, `mode.test.tsx`;
  create `quick-keys.test.tsx`, `shortcut-sheet.test.tsx`.

**Interfaces**
```ts
// shortcuts.ts
export type ShortcutAction = 'next' | 'previous' | 'takeNext' | 'command' | 'help' | 'escape' | 'undo';   // 'undo' is new
// shortcutFor additions: 'u'/'U' -> 'undo' (not on repeat); ArrowDown/ArrowUp -> 'next'/'previous' only when arrowsMoveCases(e)
export function arrowsMoveCases(e: KeyLike): boolean;     // origin is in .cw-queue .cw-case-link or is .cw-screen-title; never in .cw-transcript, a typing target or a window
/** @experimental. How long after a move the case under the cursor is opened, with Quick keys on. */
export const QUEUE_OPEN_DELAY_MS = 200;
// quickKeys.ts
export const QUICK_KEYS_KEY = 'chatwarden.hub.quickKeys';            // 'on' | 'off'
export function readQuickKeys(mode: HubMode): boolean;               // stored value, else true for simple and false for detailed; storage errors fall back to the default
export function writeQuickKeys(on: boolean): void;                   // guarded like writeMode
export function useQuickKeys(): { on: boolean; set: (on: boolean) => void };
```
`Shortcuts` in `Hub.tsx` handles `undo` by calling `decisions.undoLatest()` (a toast says `hub.toast.undone` when something was undone; with nothing waiting the key does nothing and says nothing). For `next`/`previous` with Quick keys on, after
the focus move it schedules `QUEUE_OPEN_DELAY_MS` and then activates the focused row's link, cancelling the timer if another move,
a click, Escape or unmount comes first. The sheet is restructured into the three groups above and gains the switch. Quick keys on in
Detailed also mounts `QuickKeys` in the case panel (Task 7).

**Tests**
- `shortcuts.test.ts`: a table of key x modifiers x target kinds: `j, J, k, K, ArrowDown, ArrowUp, n, u, ?, Escape` act on a plain target; `Ctrl+K` and `Meta+K` are the command bar and `k` alone is previous; `Ctrl+J`, `Ctrl+U`, `Alt+ArrowDown` and `Meta+ArrowDown` do nothing; Shift+K (caps lock) is previous; `u` and `n` ignore repeat while `j` and `k` do not; nothing fires with `isComposing`, `defaultPrevented`, or from input, textarea, select, contenteditable, `role=textbox/combobox/searchbox`.
- `arrowsMoveCases`: true on a queue row and on the case title; false in the transcript, on a button in the decision bar, in a select, in a dialog.
- `quick-keys.test.tsx`: `defaults: on in Simple, off in Detailed`; `the choice is remembered per browser and survives a reload`; `blocked storage falls back to the default and the switch still works for the visit`; `on: J moves and opens the case after QUEUE_OPEN_DELAY_MS`; `holding J through five rows opens only the last`; `off: J moves focus and does not open (Enter opens), as today`; `U undoes the newest held decision and shows its case; U with nothing waiting is silent`; `U inside the reason box types a u`; `Escape cancels a pending open and goes back to the queue`.
- `multi-hub.test.tsx`: `with two hubs on a page, a key pressed in one is answered once, by that one`; shadow-root case: `<chatwarden-hub> hears J, 2 and U with the real target`.
- `shortcut-sheet.test.tsx`: `lists every binding in its group with the right key caps (Ctrl on Windows and Linux, the Cmd glyph on a Mac)`; `the switch toggles the preference and announces it`; `the sheet is a labelled modal that closes with Escape and returns focus`; axe clean at both modes.
- `command-bar.test.tsx`: `Ctrl+K opens the bar from the case card, the queue and the body; while the bar is open, J, K, U and the digits type into its input and act on nothing`.

**Run:** `npx vitest run packages/hub-react/test/shortcuts.test.ts packages/hub-react/test/quick-keys.test.tsx packages/hub-react/test/shortcut-sheet.test.tsx packages/hub-react/test/command-bar.test.tsx packages/hub-react/test/keys-after-load.test.tsx packages/hub-react/test/multi-hub.test.tsx packages/hub-react/test/mode.test.tsx packages/hub-react/test/dom.test.ts packages/hub-react/test/dom-registry.test.ts packages/hub-element/test`.

---

### Task 9: Bulk dismiss in the hub (confirm, hold, Undo)
Depends on: Tasks 6, 7 (continueFrom after the sweep), 5 (shapes).

**Files**
- Create `packages/hub-react/src/case/BulkDismiss.tsx` (the disclosure, the confirm window and the wiring).
- Modify `case/DecisionBar.tsx` (render `<BulkDismiss />` as the last block of the form, only when the caller may), `case/CaseCard.tsx`
  (nothing: it reaches BulkDismiss through the opened bar), `screens/Audit.tsx` and `auditLabel.ts` (labels for the two new actions),
  `i18n.ts`, `styles.css`.
- Tests: create `bulk-dismiss.test.tsx`; extend `audit.test.tsx`, `a11y-report.test.tsx`.

**UI (the "one advanced door")**
- Simple: inside "Something else..." (the bar already opened in place). Detailed: in the bar. In both, a collapsed
  `<details>`-style disclosure at the bottom, "Close more reports at once" (`hub.bulk.open`), closed by default, so the clean core
  gains nothing visible.
- Two rows when opened: "Dismiss all N open reports about {name}" (N from the queue group's `open`; hidden when N < 2) and "Dismiss all
  open reports from {reporter}" (always offered; carries the line "Most of their recent reports were dismissed." when the
  reporter's accuracy is noticeable). Shown only when `can('reports.decide.bulk')` and `can('reports.decide')`.
- Choosing a row opens a confirm window (the hub's `Dialog`, `aria-modal`, initial focus on Cancel): it calls
  `decisions.previewDismiss` and shows "Counting the open reports..." and then the title "Dismiss {count} reports about {name}?" (or
  "from {name}"), the body "Nothing happens to anyone. Reporters are not told and are not marked as acting in bad faith. You can
  undo for 5 seconds.", the count of any held by another moderator ("{count} are held by another moderator and stay open"), and
  two buttons, "Dismiss {count} reports" and Cancel. With zero open: only the "no open reports" line and Close. Enter does nothing
  by itself on the confirm button (focus starts on Cancel); no key shortcut triggers a bulk.
- Confirm calls `decisions.dismissOpen`, then `actions.continueFrom(...)` for person scope (the case is gone) and does nothing for
  reporter scope unless the open case is among the swept ones (the queue reload then moves the moderator on, as for any closed case).
- The reporter's name is shown the way the hub already shows reporters (handle or the short tag); no ref, hash or id appears.

**Tests**
- `the disclosure is closed by default, labelled, and absent without reports.decide.bulk, without reports.decide, and for a person with one open report (person row only)`
- `choosing a row opens the confirm window with the live count from a dryRun call and focus on Cancel`
- `Cancel and Escape send nothing and return focus to the disclosure`
- `confirming holds for 5 seconds with Undo; Undo sends nothing and the case returns with its claim`
- `after the hold exactly one POST /reports/dismiss-open is sent with scope, ref and dryRun false (no reason key)`
- `person scope: the case leaves the queue at once and the next case opens; reporter scope: nothing leaves until the reload`
- `held by another moderator: the confirm window says how many stay open and the result toast repeats it`
- `more: the result toast offers "Dismiss more" and sending it runs the call again`
- `409 claimed: shows who holds it; a senior sees Take over and the call is repeated with takeOver true`
- `a server without the permission key in /me hides bulk entirely (older server)`
- `the page hiding during the hold sends it at once`
- `no key, including Enter on the page and the digits, can start or confirm a bulk`
- `audit screen: report.dismiss_case and report.dismiss_reporter have labels in the catalogue (no raw action name is shown)`
- a11y: window labelled, focus trapped and restored; axe clean in Simple and Detailed, 360 px layout test in `layout.test.tsx` (no horizontal scroll).

**Run:** `npx vitest run packages/hub-react/test/bulk-dismiss.test.tsx packages/hub-react/test/audit.test.tsx packages/hub-react/test/audit-label.test.ts packages/hub-react/test/a11y-report.test.tsx packages/hub-react/test/layout.test.tsx packages/hub-react/test/dialog-focus.test.tsx`.

---

### Task 10: Reporter accuracy on the case and in the queue
Depends on: Tasks 5, 6.

**Files:** modify `case/CaseCard.tsx` (`ReporterWarning`), `case/ReporterStanding.tsx`, `simple.ts` (`reporterWarrants` kept for older
servers), `liveQueue.tsx` / `headless/liveQueue.ts` (already passes `rankDown`, Task 6), `shell/QueuePane.tsx` (a `data-ranked` attribute and
screen-reader-only text only), `i18n.ts`; tests `reporter-accuracy-ui.test.tsx`, extend `case-pane.test.tsx`, `a11y-shell.test.tsx`.

**Behaviour**
- The reporter line on a case: when `record.accuracy?.noticeable`, the existing warning notice reads "{name}: most of their recent
  reports were dismissed ({unfounded} of {decided} in the last {days} days)." and, when `habitual`, adds "Their reports are listed
  lower in the queue. None is hidden." (`hub.reporter.rate.line`, `hub.reporter.rate.ranked`). Without `accuracy` (an older kit, or a
  store that cannot) the existing all-time rule `reporterWarrants` and its line apply, unchanged.
- The Detailed reporter rows (`ReporterStanding`) show the same figure under the meter, in the same words.
- **Privacy:** it is the reporter's own count, shown only on a case they appear in, to roles with `history.read`; the same name the hub
  already uses for that reporter; no ref, no list of their reports, no screen that lists reporters by rate (the 2026-11-10 note: no
  leaderboard). The Overview and the queue rows show nothing new. A queue row ranked low carries `data-ranked="low"` and one
  screen-reader-only phrase (`hub.queue.row.rankedLow`: "Listed lower: most of the reporter's recent reports were dismissed."); no
  badge, no colour.
- Colour: the line uses the existing warning tone, because it means something (check the reports); nothing else changes colour.

**Tests:** `a reporter below the minimum sample shows no line`; `noticeable shows the line with the right counts and days`; `habitual adds the ranking sentence, noticeable alone does not`; `an older kit (no accuracy) falls back to the all-time rule`; `a role without history.read sees no line and the queue rows still rank (ranking uses the summary field only when the server sent it)`; `a queue row ranked low has data-ranked and the sr text and no visible badge`; `the figure appears only for a reporter of an open report in this case (another reporter's figure never shows)`; `counts follow the viewer's locale and plural forms (1 of 5, 4 of 5)`; `player-react renders and imports nothing named accuracy` (the hub is staff only, so this is a source-level guard).
**Run:** `npx vitest run packages/hub-react/test/reporter-accuracy-ui.test.tsx packages/hub-react/test/case-pane.test.tsx packages/hub-react/test/a11y-shell.test.tsx packages/hub-react/test/overview.test.tsx packages/player-react/test`.

---

### Task 11: i18n, docs, API lock, the site demo
Depends on: Tasks 6 to 10 merged.

**i18n.** Every key below is added to `en` in `packages/hub-react/src/i18n.ts` (flat map, `hub.<area>.<thing>`; plurals as `.one` /
`.other`). A missing key in a partial catalogue falls back to English (`createT({ ...en, ...de })`), so nothing breaks, but
**translators must add these keys**: list them in the README's translation section and in the changeset.

| Key | English |
| --- | --- |
| `hub.quick.dismiss` | Nothing wrong here |
| `hub.quick.dismiss.hint` | Closes the report with no action. Nobody is told and nobody is marked. |
| `hub.quick.held` | Dismissing {who} in {seconds} s. |
| `hub.decided.reason.default` | No reason given |
| `hub.decide.reason.hint.dismissal` | Optional for "Not a problem". |
| `hub.toast.undone` | Undid the decision on {who}. |
| `hub.toast.waiting.one` / `.other` | {count} earlier decision waiting. / {count} earlier decisions waiting. |
| `hub.key.up` / `hub.key.down` | Up arrow / Down arrow |
| `hub.shortcuts.group.move` / `.act` / `.general` | Move / Act on a case / Anywhere |
| `hub.shortcuts.nextArrow` | Move to the next case |
| `hub.shortcuts.previousArrow` | Move to the previous case |
| `hub.shortcuts.primary` | Apply the suggested step and go to the next case |
| `hub.shortcuts.dismiss` | Nothing wrong here, then the next case |
| `hub.shortcuts.warning` | Send a warning, then the next case (when offered) |
| `hub.shortcuts.undo` | Undo the newest waiting decision |
| `hub.shortcuts.quickKeys.label` | Quick keys |
| `hub.shortcuts.quickKeys.hint` | With quick keys on, 1, 2 and 3 act at once, and J, K and the arrow keys open the case they move to. |
| `hub.shortcuts.quickKeys.only` | Needs quick keys |
| `hub.bulk.open` | Close more reports at once |
| `hub.bulk.person.one` / `.other` | Dismiss the open report about {name} / Dismiss all {count} open reports about {name} |
| `hub.bulk.reporter` | Dismiss all open reports from {name} |
| `hub.bulk.reporter.habitual` | Most of their recent reports were dismissed. |
| `hub.bulk.confirm.counting` | Counting the open reports... |
| `hub.bulk.confirm.title.person.one` / `.other` | Dismiss {count} report about {name}? / Dismiss {count} reports about {name}? |
| `hub.bulk.confirm.title.reporter.one` / `.other` | Dismiss {count} report from {name}? / Dismiss {count} reports from {name}? |
| `hub.bulk.confirm.body` | Nothing happens to anyone. Reporters are not told and are not marked as acting in bad faith. You can undo for {seconds} seconds. |
| `hub.bulk.confirm.claimed.one` / `.other` | {count} is held by another moderator and stays open. / {count} are held by another moderator and stay open. |
| `hub.bulk.confirm.none` | There are no open reports to dismiss. |
| `hub.bulk.confirm.go.one` / `.other` | Dismiss {count} report / Dismiss {count} reports |
| `hub.bulk.confirm.cancel` | Cancel |
| `hub.bulk.held.one` / `.other` | Dismissing {count} report in {seconds} s. / Dismissing {count} reports in {seconds} s. |
| `hub.bulk.done.one` / `.other` | Dismissed {count} report. / Dismissed {count} reports. |
| `hub.bulk.skipped.claimed.one` / `.other` | {count} stays open: another moderator is handling it. / {count} stay open: another moderator is handling them. |
| `hub.bulk.more` | There are more open reports. |
| `hub.bulk.more.again` | Dismiss more |
| `hub.bulk.failed` | The reports could not be dismissed. Nothing was changed. |
| `hub.reporter.rate.line` | {name}: most of their recent reports were dismissed ({unfounded} of {decided} in the last {days} days). |
| `hub.reporter.rate.ranked` | Their reports are listed lower in the queue. None is hidden. |
| `hub.queue.row.rankedLow` | Listed lower: most of the reporter's recent reports were dismissed. |
| `hub.audit.label.report.dismiss_case` | Dismissed all open reports about a person |
| `hub.audit.label.report.dismiss_reporter` | Dismissed all open reports from a reporter |

Also retire nothing: `hub.simple.noAction.reason` stays in the catalogue (deprecated; no longer sent), per the 0.1.3 rule that
nothing is removed from the exported catalogues.

**Docs.** `packages/hub-react/README.md` (keyboard table, Quick keys, bulk dismiss, the experimental list, the translation keys),
`packages/http/README.md` (the route, the permission, the audit actions, `reporterAccuracy`, the relaxed `reason`),
`packages/core/README.md` (`NO_ACTION_DEFAULT_REASON`, `dismissMany`, `reporterAccuracy`, the thresholds table, `rankDownHabitual`),
`docs/status.md` (a "Triage speed" row under Shipped when merged, an `0.1.5` section like the 0.1.3 one, the parked items below).
`packages/hub-react/test/readme-core.test.ts` keeps README and exports in step: run it.

**API lock.** `packages/hub-react/test/api.test.ts` and `apiNames.ts` snapshots updated by the tasks that added exports; this task
reads the diff once and confirms: only additions, every addition `@experimental`, no removals. hub-react `/headless` gains types only.
`packages/hub-element/test/api.test.ts` unchanged (the element's exports are unchanged; the bundle carries the new code).

**Site.** `site/src/demo/Demo.tsx` and `site/test/demoHub.test.tsx` mention "No action needed": check the demo's mock server (it
runs the real kit, so the standard reason and `dismissOpen` come with the kit) and its tour copy; add a demo test that key `2` on the
live demo dismisses with no reason. No site deploy: site deploys follow `site/README.md` and the maintainer's go-ahead.
**Run:** `npx vitest run packages/hub-react/test/readme-core.test.ts packages/hub-react/test/i18n.test.ts packages/hub-react/test/api.test.ts packages/http/test/readme.test.ts`; `npm test --workspace @chatwarden/site -- demoHub`.

---

### Task 12: Verify in a real browser
Depends on: Tasks 7 to 11.

Run the hub on the live-kit demo or `examples/tiny-chat` and look, at desktop and 360 px, light and dark, Simple and Detailed:
- the Detailed bar with the new button (no crowding; the row wraps at 360 px), the "Close more reports at once" disclosure closed and
  open, the confirm window, the toast stack with several held decisions and its "N earlier decisions waiting" line, the shortcut sheet
  with its three groups and the switch, the reporter line and the screen-reader-only phrase on a ranked row (screen reader pass: NVDA
  or VoiceOver; browse mode is expected to swallow single keys, and the buttons must be enough).
- Drive it with the keyboard only: 40 seeded reports (a mix of one habitual reporter, one person with 12 reports, ordinary cases):
  clear them with 2, 1 and 3, U to take two back, J/K/arrows, N; then bulk dismiss the habitual reporter's reports and Undo once.
- Write a Playwright spec `packages/hub-react/e2e/triage-speed.spec.ts` (skips without Chromium, fails under `CW_REQUIRE_BROWSER=1`),
  following the existing browser tests' setup.
- Record what was seen and any fix in the PR description.

**Run:** `CW_REQUIRE_BROWSER=1 npx playwright test packages/hub-react/e2e/triage-speed.spec.ts` (Chromium installed), and the same without the variable to see it skip.

---

### Task 13: Release prep 0.1.5
Depends on: Tasks 1 to 12.

All changes are additive, so the release is a PATCH: **0.1.5**. A minor (0.2.0) would fall outside every `^0.1.x` peer range and make
every dependent a major bump (RELEASING.md, step 1).

**Changeset** (`npx changeset`, all ten packages move as one fixed group; text for the `CHANGELOG.md` of each):
```md
---
'@chatwarden/core': patch
'@chatwarden/store-memory': patch
'@chatwarden/store-sqlite': patch
'@chatwarden/http': patch
'@chatwarden/hub-react': patch
'@chatwarden/hub-element': patch
---

Faster report triage.

- One click, "Nothing wrong here", dismisses a report in Simple and Detailed with no reason typed. The kit stores the standard reason
  "No action needed" (core: `NO_ACTION_DEFAULT_REASON`; `reason` is optional only for a `no_action` decision with no actions).
  Every quick action (the suggested step, a warning, a dismissal) moves on to the next case, and Undo still works after the move.
  `U` undoes the newest waiting decision.
- Bulk dismiss: one confirmed action closes all open reports about one person, or all open reports from one reporter
  (`cw.reports.dismissMany`, `POST /reports/dismiss-open`, new permission `reports.decide.bulk` for moderators by default; two new
  audit actions, `report.dismiss_case` and `report.dismiss_reporter`, plus one `report.decide` row per report). It never marks bad faith.
- Reporter accuracy: the share of a reporter's decided reports in the last 30 days that were dismissed, with a minimum of 5. The case shows it
  and the queue and take-next list reports from habitual false reporters (80% or more) lower. No report is hidden, and a report older than 24 hours
  ranks normally. Staff only.
- Keyboard queue mode: J/K and the arrow keys move between cases, 1/2/3 act, U undoes. "Quick keys" (in the `?` sheet) is on in Simple and
  off in Detailed by default.
- SQLite: migration 19 adds one index (`kit_reports_by_reporter_outcome`), applied when the store opens.

Upgrade notes: `hub-react`, `http`, `store-memory`, `store-sqlite` and `hub-element` now need `@chatwarden/core` and `@chatwarden/http` 0.1.5
(a hub 0.1.5 against an older `http` is refused 400 on a dismissal with no reason, and has no bulk dismiss). `PermissionKey` has one more
member, so a `Record<PermissionKey, ...>` you wrote by hand needs `reports.decide.bulk`. `POST /cases/next` now serves reports from habitual
false reporters last; nothing else about take-next changed. New names are `@experimental`. Translators: add the new `hub.quick.*`,
`hub.bulk.*`, `hub.reporter.*`, `hub.shortcuts.*` and audit-label keys (a missing key shows English).
```

**RELEASING.md order** (the file's own steps, with this plan's specifics):
1. Describe the change: the changeset above, in the PR that changes a package (done per task as it lands; one file is enough).
2. Prepare the release on a clean `main`: `npm run version` (bumps the ten packages to 0.1.5, syncs each `VERSION`, refreshes the lock).
   Check `examples/tiny-chat/package.json` versions equal 0.1.5; run `npm install` once more.
3. **Raise the peer floors by hand** (RELEASING.md, "When a peer floor must rise"; `onlyUpdatePeerDependentsWhenOutOfRange` will not do it):
   - `@chatwarden/http`, `@chatwarden/store-memory`, `@chatwarden/store-sqlite`, `@chatwarden/hub-react`: peer `@chatwarden/core` `^0.1.5`
     (they use `dismissMany`, `reporterAccuracy`, the standard reason and the new store types). `player-react` stays `^0.1.2`.
   - `@chatwarden/hub-react`: peer `@chatwarden/http` `^0.1.5` (the route and the reasonless dismissal).
   - `@chatwarden/hub-element` stays unpeered (it bundles hub-react); its optional hub-react peer for types follows the hub-react floor.
   - `core`, `matcher`, `profanity`, `discord` unchanged (`^0.1.0`).
   - Run `npm install --package-lock-only`; edit `scripts/manifests.test.ts` in the same commit (split `NEEDS_NEW_KIT` into the
     0.1.5 set and the 0.1.2 set, add a `NEW_KIT_RANGE_0_1_5 = '^0.1.5'`, update the hub-react to http expectation), so the floors are a written decision. Name each package and the API that forced it in the changeset (done above).
4. Gates: `npm run typecheck`, `npm run lint`; `npm run check:pack` after deleting `dist`; `node scripts/smoke.mjs`; the bundle budgets (record gzip before and after; raise each affected budget to the new size plus about 5%, with the reason in the commit, never silently).
5. Merge: open a pull request with the version commit; `if gh pr checks <n> --watch --fail-fast; then gh pr merge <n> ...; fi`.
6. Dry run (recommended): RELEASING.md "Running a dry run".
7. Tag and push on the merged `main`, once CI is green: `git tag v0.1.5` then `git push origin v0.1.5`. Only on the maintainer's go-ahead.
8. Watch the Release run (publishes in order: core, store-memory, matcher, store-sqlite, profanity, http, discord, hub-react, player-react,
   hub-element); check provenance on each package page. The site is separate (`site/README.md`) and deploys only on the maintainer's go-ahead.

---

## Order and parallelism
- Parallel from the start: Task 1 and Task 2. Then Task 3 (needs 1), Task 4 (needs 2). Task 5 needs 1 to 4.
- The hub can start Task 6 against the interfaces written above while Task 5 is in review; Tasks 7 and 8 follow 6; Task 9 and 10 follow 6
  and 7. Task 11 to 13 are last and serial.
- One implementer and one review per task; a whole-branch review at the end reads the Review Focus first.

## Not in this plan (parked, add to `docs/plans/follow-ups.md`)
- A server-side reopen of a dismissed report (the bulk Undo is client-held, before the send).
- Dropping `kit_reports_by_reporter`, now a prefix of `kit_reports_by_reporter_outcome`, in a minor.
- Putting the thresholds (window, minimum sample, 0.6, 0.8) in `limits.reports` so an adopter can tune them.
- A reporter-accuracy view for owners (a per-reporter list). Deliberately not built: the workbench note forbids per-person
  leaderboards.
- Bulk by room, by reason, or by a selection of cases.
- Serving J/K "open on move" in the `CaseList` piece (it has no router; pieces keep focus-only movement).
