# Urgent lane, a kinder desk, and rooms under attack (0.2.0) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** a moderator sees a threat (and, when the owner turns it on, a welfare report) before everything else, is shown the game's own
guidance and contact line, and can mark the case as passed to the game's safety team; the game's own process hears of it through an
ids-only event. A team can ask for a second look, escalate to the owner, keep a staff-only comment thread, hide excerpts until opened,
and read an Insights page. A moderator can lock a room, take a line back for everyone, and turn on an emergency mode that expires on its
own; new accounts can be held to slower chat; a report surge, a person's linked accounts and a gameplay evidence link show on a case.
The kit routes and surfaces: it never diagnoses, never contacts anyone, never forwards CSAM.

**Architecture:**
- `@chatwarden/core` gets three profile sections (`desk`, `safety`, `rooms`) and new fields on reporting reasons, `desk.ts`
  (settings), a case workflow service (comments, escalation, hand-off, urgent), `insights.ts`, `roomModes.ts`, probation in `pacing.ts`,
  a retract path through the evidence buffer, `cw.rooms.setMode/mode/list/postingState/retract`, `cw.cases.escalate/handoff/setUrgent`,
  `cw.comments`, `cw.insights`, `cw.people.links`, six audit actions and two more, five events, six permissions.
- Optional `Store` methods and the theme's block of SQLite **migration 26**, the one migration the whole 0.2.0 release shares. Memory
  and SQLite, one contract suite.
- `@chatwarden/http` adds staff routes for the urgent lane, workflow, insights, rooms and links, fields on existing bodies, chat wire
  version 2 (a `mode` and a `retract` frame, `staff` and `evidenceRef` on `ChatMember`), and a broadcaster that follows core events.
- `@chatwarden/discord` gains the urgent mention and `postDigest`. `@chatwarden/player-react` gains the thank-you
  resource list and the chat box's mode line, read-only composer and removed-message line. `@chatwarden/hub-react` gains the urgent
  chip, case strip and "What to do" panel, `CaseMenu`, the comment thread, the Insights screen, the Rooms panel, Safety and Desk panels,
  the careful view, and the surge, links and evidence lines.

**Spec:** `docs/design/2026-11-17-urgent-desk-and-rooms.md` (section numbers below refer to it), including its closing Rulings section.
Also binding: `docs/design/2026-11-17-moderation-coverage-audit.md` (G3, G6, G7, G8, G13, G14, G15, G20 and section 6, what the kit
must not do), `docs/design/2026-11-12-chat-box.md` (the wire and the box), `docs/design/2026-11-10-hub-workbench-and-teams.md` and
`docs/design/2026-11-10-hub-simple-mode-and-embedding.md` (the claims and Simple), and `docs/design/2026-11-12-k5-integrations.md`
(the Discord feed and `cw.links`).

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly`, every time from the injected
  `Clock` (no `Date.now()`), synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn), test-first, targeted
  runs only, `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree: commit by pathspec,
  `git add` new files first.
- **Release context.** One branch, 0.2.0, built in themed chunks; this plan is two of them (the other themes: names in reports and the
  player preview; filter rules and privacy; any server, many rooms, languages). The branch and worktree names are the maintainer's. There
  are no users yet, so **no backward-compatibility work**: no old-body snapshot tests, no shims. Every deliberate break is in spec
  section 19 and each task that makes one says so. All new names are `@experimental` until the release settles them.
- **One migration.** The release shares migration **26**. Task U3 owns this theme's block (spec section 13) inside the single
  `version: 26` entry in `packages/store-sqlite/src/migrations.ts`: if the entry does not exist when U3 lands, U3 creates it with this
  block; if it does, U3 appends its block with its own comment header and does not touch anyone else's. The migration test asserts this
  theme's columns and tables by name, never the full table list. `AUDIT_ACTIONS`, `AUDIT_TARGET_TYPES`, `KIT_EVENT_TYPES`,
  `PERMISSION_KEYS` and `POLICY_SECTIONS` are append-only; when another theme has appended first, append after theirs and update the
  order-lock tests by set membership plus "mine are contiguous and last of mine" rather than by absolute index.
- `@chatwarden/core` stays browser-safe and dependency-free: no `node:` import, no `fetch`. `scripts/browser-bundle.test.ts` budgets
  are re-checked in every core task that adds a file.
- **Text only, ids only.** No event, webhook, Discord post, audit row, log line, notice or AI prompt carries a chat line, a comment, a
  note, a statement, a handle, an evidence ref or `safety.contact`. Spy loggers in U4, U5, U6 and R1 assert event names and error
  classes only. The kit holds, fetches and previews no image or link target.
- **A person decides.** A room mode, a probation pace, a surge, a retraction and an urgent flag write no sanction and no strike. The AI
  never reads or writes `urgent`.
- **Hub budget.** The hub-react first-load budget in `packages/hub-react/test/size.test.ts` is near its limit (read the current value
  at the start of U8). Eager code is types, client calls, the chip, the row word, the `CaseMenu` shell and the careful-view reader; the
  "What to do" panel, thread, Insights screen, Rooms, Safety and Desk panels load on demand. `size.test.ts` runs in every hub task.
- **UI rule (clean core, power behind one door).** The only new always-visible element is the urgent chip, and it exists only while the
  open urgent count is above zero. A row word ("Urgent", and "Asked for a look" with workflow on) appears only on rows that have it. All
  else is in the case's `...` `CaseMenu`, Settings, Advanced panels, the Person page's `...` menu, and the existing Filters drawer.
  No new colour; states are words. Every string through `t()`. Check in a real browser at desktop and 360 px, light and dark, for
  U8, U10, U11, R5 and R6.
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no site deploy without the maintainer's go-ahead.

## Review Focus
Six failure modes no happy-path test would exercise; each has its test in the owning task.
1. **Urgent beating a claim, or being swept away.** Take-next stealing a held case, rank-down hiding an urgent report from a habitual
   reporter, a bulk dismiss closing one, a `bad_faith` verdict on a welfare report, a stale snapshot after a reason edit. Tasks U4, U5, U8.
2. **A welfare report leaking.** Into an event, a webhook body, the Discord post, a log, a comment's audit row, an AI input or an
   error message; a purge that skips the 30-day clock; the reason id in a Discord post. Tasks U4, U5, U6.
3. **A mode that lies about time or order.** A mode used after `until` because the timer was late, a lock checked after the matcher
   (so a slur in a locked room earns a strike), a `staff` flag taken from a request, two writers at once, `rooms.close` forgetting to
   clear, a restart. Tasks R1 and R3.
4. **A retraction that leaves the text behind.** In the broadcaster's ring, in a new joiner's hello, in a client's state, in a
   screen-reader live region, versus evidence that must stay, and a report on a retracted line. Tasks R3 and R5.
5. **Careful view that only looks hidden.** Text still in the DOM, a counter or a setting sent to the server, a reveal that survives
   the case, a break prompt that blocks. Task U11.
6. **One migration, two stores.** This theme's block inside a shared entry, the partial index, memory and SQLite giving the same
   answers, retention deleting comments with their report. Task U3.

## Order and parallelism
Tasks U1, U2 and U3 are independent and can run at once. U4 follows U1, U2 and U3. U5 follows U4. U6 follows U1, U2 and U3. U7 follows
U1, U2 and U3. R1 follows U1 and U2. R2 follows R1 and U3 (probation and surge read the settings; evidence ref and links need the
store). R3 follows R1 and U3. R4 follows R1, R2, R3 and U5 (it shares the case body with U5). R5 follows R3 (wire shapes only; can
start early against them). U8 follows U5. U9 follows U1 and U5. U10 follows U6, U7 and U8. U11 follows U8. R6 follows R4, R5 and U8
(it needs `CaseMenu`). U12 is last. Hub tasks U8, U10, U11 and R6 touch `case/` and `shell/` files in common; run them in the order
U8, U10, U11, R6 or resolve by pathspec.

---

### Task U1: Settings and reason fields
Spec 4. Read first: `core/src/reporting.ts`, `profile.ts` (`TOP_KEYS`, `POLICY_SECTIONS`, `applyLayer`, `layerSections`,
`changedSections`), `pace.ts` (the validation style: `plain`, `whole`, `ProfileError`), `retention.ts`.
- **Files:** `packages/core/src/desk.ts` (new: `DeskSettings`, `ResolvedDesk`, `resolveDesk`), `safety.ts` (new: `SafetySettings`,
  `resolveSafety`, `DEFAULT_SAFETY_GUIDANCE`), `roomSettings.ts` (new: `RoomsSettings`, `resolveRooms`), `reporting.ts` (`ReportReasonInput`
  and `ReportReason` gain `urgent`, `thanks`, `showResources`; `DEFAULT_REPORT_REASONS` makes `threat` urgent and adds a disabled
  `welfare` with no rules; `PlayerReporting.reasons[]` gains `thanks` and `showResources`, and `PlayerReporting` gains `resources`;
  `ReportingSettings.evidenceUrl`), `profile.ts` (`TOP_KEYS`, `ModerationProfile`, `ResolvedProfile`, `PolicyLayer`, `POLICY_SECTIONS`
  appends `'desk'`, `'safety'`, `'rooms'`), `retention.ts` (`welfareReportsMs` 30 days floor 1 day, `chatCountsMs` 400 days floor 31 days
  in `RetentionPolicy`, `RETENTION_DEFAULTS`, `FIELDS`, `checkRetentionFloors`; `PurgeResult` gains the two counts, set to 0 until U4 and
  U7), `packages/http/src/admin/policyProfile.ts` (route comment), tests `packages/core/test/desk-settings.test.ts`,
  `safety-settings.test.ts`, `room-settings.test.ts`, `reporting-urgent.test.ts`, `policy-layer-desk.test.ts`, and
  `packages/http/test/admin.policy-desk.test.ts`.
- **Interfaces (Produces):** `ResolvedDesk { workflow; insights; surge: { enabled; reports; windowMinutes; newAccountDays } }`;
  `ResolvedSafety { guidance: string; contact: string; resources: Array<{ label; detail; url: string | null }> }` (the default
  guidance when unset); `ResolvedRooms { defaultModeMs; emergency: { slowModeMs; newAccountDays }; probation: { enabled; ageDays;
  slowModeMs }; unknownAge: 'allow' | 'treat_as_new' }`. Errors are `ProfileError` with the path, never echoing the value.
- **Tests (names):**
  - `defaults: workflow and insights off; surge off at 5 reports, 10 minutes, 2 days; rooms defaults 30 minutes, emergency 30 s and 7 days, probation off at 2 days and 5 s, unknownAge allow`
  - `ranges accepted at both edges and refused one outside (surge.reports 3 and 100, windowMinutes 1 and 120, ageDays 1 and 30, defaultModeMs 60 000 and 86 400 000, emergency.slowModeMs 1 000 and 600 000, newAccountDays 0 and 30); 2.5, NaN and a string refused with the path`
  - `safety: guidance over 1500 characters, contact over 300, more than 5 resources, a label over 60, a detail over 200, an http url, a javascript url, a url with credentials, a url with a space: each refused with its path`
  - `safety.guidance counted in code points; control, bidi and zero-width characters stripped; blank lines kept as paragraph breaks; unset reads the default guidance`
  - `reporting.evidenceUrl needs https, exactly one {ref}, at most 300 characters, no credentials; two placeholders, none and http refused`
  - `default reasons: threat is urgent; welfare exists, is disabled, urgent, showResources and has no rule; every other default is not urgent; the list still has other enabled`
  - `a reason's thanks over 300 refused; urgent and showResources must be booleans; unknown reason keys still refused`
  - `PlayerReporting carries per-reason thanks and showResources and the top-level resources, and never safety.guidance, safety.contact or the staff rule mapping` (no-leak)
  - `presets ship all three sections unset`; `a layer beats the code profile, which beats the defaults`; `reset("desk"), reset("safety") and reset("rooms") restore the base`
  - `changedSections lists the sections; a save audits policy.update with sections only and no values`
  - `retention: welfareReportsMs below 1 day and chatCountsMs below 31 days refused naming the field; 0 is refused for both (a floor, not off); NaN refused`
  - http: `PUT /policy/profile with the three sections: 200; 409 stale; 400 invalid_profile with layer.rooms.emergency.slowModeMs; DELETE ?section= resets`
- **Run:** `npx vitest run packages/core/test/desk-settings.test.ts packages/core/test/safety-settings.test.ts packages/core/test/room-settings.test.ts packages/core/test/reporting-urgent.test.ts packages/core/test/policy-layer-desk.test.ts packages/core/test/policy-layer.test.ts packages/core/test/retention.test.ts packages/core/test/golden.test.ts packages/http/test/admin.policy-desk.test.ts`

### Task U2: Shared vocabulary
Spec 12.3, 12.2, 19 (item 8). Needs nothing; every other task reads it.
- **Files:** `packages/core/src/audit.ts` (`AUDIT_ACTIONS` appends `'report.urgent'`, `'report.handoff'`, `'report.comment'`,
  `'report.comment_remove'`, `'report.escalate'`, `'room.mode'`, `'room.retract'`, `'insights.view'`; `AUDIT_TARGET_TYPES` appends `'room'`;
  the report-target and `TARGET_REQUIRED` lists; a helper `roomAuditRef(roomId, hasher)` returning the id itself when it fits the
  audit ref charset and a `h-` plus 16-hex keyed hash otherwise), `packages/core/src/events.ts` (`KitEvent` and `KIT_EVENT_TYPES`
  append `report.handoff`, `case.escalated`, `room.mode`, `line.retracted`, `insights.digest`; `report.created` gains `urgent: boolean`
  and `reportedReason` becomes required), `packages/http/src/permissions.ts` (append `reports.urgent`, `reports.handoff`,
  `reports.comment`, `reports.escalate`, `insights.read`, `rooms.read`, `rooms.manage`, each `moderator`), `packages/hub-react/src/types.ts`
  (`PermissionKey`), `auditLabel.ts` (eight labels), any store check of the action and target lists, tests
  `packages/core/test/vocabulary-desk.test.ts` and additions to the audit, events, permissions and `auditLabel` tests.
- **Tests (names):**
  - `the eight actions are appended in order and the order-lock allows the append`; `report.* actions need a report target, room.* a room target, insights.view none; no detail is allowed on any of them`
  - `AUDIT_TARGET_TYPES ends with room; a room id with a space, a slash or 80 characters is recorded as an h- keyed hash and the same id always maps to the same ref; a fitting id is kept as is`
  - `KIT_EVENT_TYPES contains the five new types; cw.on accepts them; an unknown type still throws`; `report.created has urgent and a required reportedReason` (type-level `expectTypeOf`)
  - `the new event shapes hold no text, handle, note, reason, evidence ref or staff id` (type-level, key list pinned)
  - `the seven permissions default to moderator; the permissions option raises any of them; an unknown key is still refused`
  - `GET /me can[] has the seven keys`; `the hub labels the eight actions`; `the hub PermissionKey list matches the http list` (existing mirror test)
- **Run:** `npx vitest run packages/core/test/vocabulary-desk.test.ts packages/core/test/audit.test.ts packages/core/test/events.test.ts packages/http/test/permissions.test.ts packages/hub-react/test/audit-label.test.ts`

### Task U3: Store interface, memory store, SQLite migration 26 (this theme's block)
Spec 13. Read first: `store-sqlite/src/migrations.ts` (migrations 17, 20, 24, 25 for the ALTER and index style), the live `kit_reports`
DDL, `core/src/types.ts` (`StoredReport`, `ReportRecord`, `OpenReportQuery`, `ReportListQuery`, `purgeReports`). SQLite is the
reference; when the suites disagree the memory store is wrong.
- **Files:** `packages/core/src/types.ts` (`StoredReport` gains required `urgent: boolean` and `evidenceRef: string | null`;
  `ReportRecord` gains `handoffAt`, `handoffBy`, `escalatedTo`, `escalatedBy`, `escalatedAt` (all nullable) and its `reportedReason` and
  `detailAt` become required; `OpenReportQuery.urgent?` and `ReportListQuery.urgent?`; `CommentRow`, `ChatDayRow`, `InsightRow`; optional
  `Store` methods: `setReportUrgent(id, on): boolean`, `setHandoff(id, by, at): boolean`, `setEscalation(id, patch | null): boolean`,
  `countOpenUrgent(): number`, `countOpenEscalated(): Record<'senior' | 'owner', number>`, `insertComment`, `listComments(reportId)`,
  `deleteComment(id): boolean`, `countComments(reportId)`, `purgeReportsByReason(reason, before): number`, `addChatCounts(day, delivered,
  refused)`, `chatCounts(fromDay, toDay): ChatDayRow[]`, `purgeChatCounts(beforeDay): number`, `insightRows(since, limit): InsightRow[]`;
  `purgeReports` also deletes comments of the reports it deletes), `packages/store-memory/src/memoryStore.ts`,
  `packages/store-sqlite/src/migrations.ts` (migration 26, this theme's block: the DDL of spec 13 verbatim, with comments in the
  existing style), `sqliteStore.ts`, contract suite `test/contract/desk.contract.ts` (registered in `test/contract/index.ts`), tests
  `packages/store-memory/test/desk.store.test.ts`, `packages/store-sqlite/test/desk.store.test.ts`, `desk.migration.test.ts`.
- **Behaviour:** `setHandoff` keeps the first caller (a second call returns false and changes nothing). `setReportUrgent` and
  `setEscalation` act on open reports only. `insertComment` refuses the 51st comment of a report. `purgeReportsByReason` and
  `purgeReports` delete the report's comments, AI reads and decisions in one transaction. Every report write that changes the open
  count, the urgent count or a comment moves `changeToken()`. `addChatCounts` is additive (two connections add correctly).
  `insightRows` returns `{ createdAt, actionedAt, status, reportedReason, urgent, badFaith }` for reports created at or after `since`,
  newest first, at most `limit`.
- **Tests (names):**
  - `insertReport round-trips urgent and evidenceRef; a report with neither reads urgent false and evidenceRef null`
  - `listOpenReports with urgent true returns only open urgent reports oldest first with the keyset cursor; listReports urgent filters; countOpenUrgent tracks insert, decide and setReportUrgent`
  - `setHandoff first wins and returns false afterwards; setReportUrgent and setEscalation on a decided report return false and change nothing; setEscalation null clears the three columns; an escalation to anything but senior or owner is refused by the CHECK`
  - `comments: insert, list oldest first, delete one, the 51st insert refused, a comment of an unknown report refused`
  - `purgeReports and purgeReportsByReason delete the comments of the deleted reports and none other; strict cutoffs: a row exactly on the line is kept; welfare purge leaves a non-welfare report of the same age`
  - `addChatCounts adds, never replaces; two connections adding concurrently sum; chatCounts is inclusive of both days; purgeChatCounts strict`
  - `insightRows respects since and limit and carries no text, subject, handle or actor` (Review Focus 2)
  - sqlite: `migration 26 from a version-25 database with reports of every status keeps each row and id, adds the columns with urgent 0 and the others NULL, and creates the comments table, kit_chat_days and kit_reports_urgent_open`; `a rerun is refused`; `this block does not touch any other theme's tables` (a table-list diff scoped to the names in spec 13)
  - sqlite: `EXPLAIN QUERY PLAN: the urgent open scan uses kit_reports_urgent_open; listComments uses its (report_id, at, id) index`; `kit_report_comments CHECK refuses an unknown kind`
  - `memory and sqlite give the same answers on the differential script`; `every write moves changeToken`; `the shared contract suite passes on both`
- **Run:** `npx vitest run packages/store-memory/test/desk.store.test.ts packages/store-sqlite/test/desk.store.test.ts packages/store-sqlite/test/desk.migration.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/contract.test.ts packages/store-sqlite/test/differential.test.ts`

### Task U4: The urgent lane in core
Spec 5.1, 5.2, 3. Needs U1, U2 and U3. Read first: `reports.ts` (intake, `onReport`), `team.ts` (`next`, `tryClaim`), `dismissMany.ts`,
`decide.ts`, `reporterAccuracy.ts`, `retention.ts` (`purge`), the facade's `cases` and `reports` objects.
- **Files:** `packages/core/src/reports.ts` (intake stores `urgent` from the resolved reason flag and `evidenceRef` unchanged;
  `ReportInput.urgent?` is accepted **only** through an internal option object marked `@internal`, never the public input; the event
  carries `urgent`), `team.ts` (`next` runs an urgent pass first with the caller's category and reason filters, ignoring
  `rankDownHabitual` and `signalBoost`, then the existing scan), `caseWorkflow.ts` (new: `setUrgent(reportId, actor, on)`,
  `handoff(reportId, actor)`; results `{ ok: true } | { ok: false; refused: 'not_found' | 'closed' }`), `dismissMany.ts` (urgent open
  reports are skipped, counted in `skipped.urgent`), `decide.ts` (`bad_faith` on a `welfare` report is `invalid`; a welfare report
  closes without a rule and writes no gap row), `reporterAccuracy.ts` (welfare reports are excluded from the numbers and the ranking),
  `retention.ts` (`purge` calls `purgeReportsByReason('welfare', now - welfareReportsMs)` before the general purge, 0 for a store without
  it), `chatwarden.ts` (`cw.cases.setUrgent`, `cw.cases.handoff`, `cw.cases.urgentCount()`), `index.ts`, tests
  `packages/core/test/urgent-intake.test.ts`, `urgent-next.test.ts`, `urgent-dismiss.test.ts`, `urgent-decide.test.ts`,
  `case-handoff.test.ts`, `welfare-retention.test.ts`.
- **Behaviour:** `urgent` is a snapshot. `next` skips an urgent case another moderator holds and falls through to the ordinary scan
  when no urgent case is free. `handoff` records who and when once, emits `report.handoff` after the commit, writes nothing to the
  person, and is allowed on an urgent or an ordinary open report. Events are announced after the commit and fenced.
- **Tests (names):**
  - `a report under threat is stored urgent; under welfare (enabled) urgent; under harassment not; under a reason the owner flagged urgent; the flag turned off later does not change reports already filed` (snapshot, Review Focus 1)
  - `report.created carries urgent and the reason id and no note, handle or text; a spy logger sees event names and error classes only` (Review Focus 2)
  - `a public submit with an urgent field is ignored; the internal option sets it`
  - `next returns the oldest free urgent case first, under a category filter and under a reason filter; an urgent case held by another moderator is skipped; with only held urgent cases the ordinary scan runs; with none urgent the order equals the ordinary order`
  - `next ignores the habitual-reporter rank-down for an urgent case and still ranks down ordinary ones; signalBoost does not reorder the urgent pass`
  - `two moderators calling next at once get two different urgent cases or one falls through, never the same`
  - `dismissMany by person and by reporter leaves urgent open reports open and counts skipped.urgent; a dry run counts them; the single dismissal of an urgent report is allowed`
  - `bad_faith on a welfare report is invalid and the report stays open; a decided welfare report is not in the reporter's accuracy and does not make a habitual reporter; a welfare report closes with no rule and writes no rule-gap row`
  - `setUrgent on and off by a moderator, not_found for an unknown id, closed for a decided one; urgentCount follows`
  - `handoff: first call records actor and time and emits report.handoff once; the second is ok and changes nothing and emits nothing; closed and not_found refusals; the event holds ids and a time only`
  - `purge deletes welfare reports older than welfareReportsMs (strict) and keeps younger ones, and ordinary reports follow reportsMs as before; a store without the method purges the rest`
  - `the AI never reads or writes urgent: the AI brief and the AI input hash are unchanged by it` (scan the rendered prompt)
- **Run:** `npx vitest run packages/core/test/urgent-intake.test.ts packages/core/test/urgent-next.test.ts packages/core/test/urgent-dismiss.test.ts packages/core/test/urgent-decide.test.ts packages/core/test/case-handoff.test.ts packages/core/test/welfare-retention.test.ts packages/core/test/team.test.ts packages/core/test/dismiss-many.test.ts packages/core/test/reports.test.ts`

### Task U5: The urgent lane over HTTP, webhooks and Discord
Spec 5.2, 12.2, 12.3. Needs U4.
- **Files:** `packages/http/src/admin/reports.ts` (`ReportSummary` gains `urgent?: true`, `handoffAt?`; `GET /reports?urgent=1` with
  `status=open`; `GET /reports/:id` gains `urgent`, `handoff: { at, by } | null`; `POST /reports/:id/urgent { on }`; `POST /reports/:id/handoff`
  claim-gated by `gateCase`), `team.ts` (`GET /changes` gains `urgent`), `validate.ts`, `admin/index.ts`, `packages/http/src/webhooks/*`
  (`report.handoff` accepted in `events`), `packages/discord/src/feed.ts` (`urgentMention?: string` role id, validated as a snowflake;
  an urgent report posts "Urgent report. Open in the hub." with the role mention, never the reason; `report.handoff` posts nothing), tests
  `packages/http/test/admin.urgent.test.ts`, `webhooks.urgent.test.ts`, `packages/discord/test/feed.urgent.test.ts`, route lists in
  `admin.every-route.test.ts`.
- **Tests (names):**
  - `permission boundaries: reports.urgent and reports.handoff at moderator, raised by the permissions option; every route is no-store JSON; the every-route test lists them`
  - `GET /reports?urgent=1 returns only open urgent summaries, older ones past the first page included; a bad value is 400 invalid_query; urgent=1 with status=actioned is 400`
  - `ReportSummary carries urgent only when true and no excerpt, note, handle or text; GET /changes carries urgent as a count and the count follows setUrgent and decide`
  - `POST urgent: 200, 404 unknown, 409 closed, 400 for a non-boolean; audit report.urgent best-effort after the write; the body never echoes anything`
  - `POST handoff: honours the claim gate and takeOver exactly like a decision; 200 idempotent; audit report.handoff best-effort; 409 closed`
  - `webhooksOut signs report.created with urgent true and report.handoff with ids and a time, and never a note, text or handle; an endpoint that did not list report.handoff does not get it`
  - `Discord: an urgent post has the role mention, "Urgent report", the hub link and nothing else; a welfare report's post names no reason; a non-urgent post is as before; a malformed urgentMention is refused at creation; the post fits the length limit; handoff posts nothing` (Review Focus 2)
- **Run:** `npx vitest run packages/http/test/admin.urgent.test.ts packages/http/test/webhooks.urgent.test.ts packages/http/test/admin.every-route.test.ts packages/discord/test/feed.urgent.test.ts`

### Task U6: Staff workflow: comments, a second look, escalation
Spec 6. Needs U1, U2 and U3. Read first: how `REPORT_NOTE_MAX`, `cleanNote` and the appeal `normalizeStatement` strip text; reuse the
latter's function, do not copy it.
- **Files:** `packages/core/src/commentService.ts` (new: `cw.comments.add(reportId, actor, role, text)`, `list`, `remove`;
  `cw.cases.escalate(reportId, actor, role, { to, note? })`, `clearEscalation`), `chatwarden.ts` (the objects; `createChatwarden` throws a
  plain message when `desk.workflow` is on and the store lacks the methods; `cw.desk.workflowEnabled()`), `types.ts` (`ReportComment`),
  `packages/core/src/decide.ts` (closing a report clears its escalation in the same transaction), `packages/http/src/admin/workflow.ts`
  (new `workflowRoutes(ctx)`), `reports.ts` (`GET /reports/:id` gains `comments` and `escalation`; summaries gain `escalatedTo?`),
  `team.ts` (`GET /changes` gains `asked: { senior, owner }` counts only with workflow on), tests
  `packages/core/test/comments.test.ts`, `escalate.test.ts`, `packages/http/test/admin.workflow.test.ts`.
- **Behaviour:** comments are trimmed, control, bidi and zero-width characters and NUL removed, counted in code points (1 to 500), at
  most 50 per report. A moderator removes their own comment, a senior any. `escalate` validates `to`, the report open, the role order
  (a moderator may ask senior or owner; a senior senior or owner; an owner no one: `not_allowed`), writes the columns and an `ask` or
  `escalate` thread entry, emits `case.escalated` after the commit, and never touches the claim. `clearEscalation` by the asker or
  anyone at or above the target. Off: every route 404.
- **Tests (names):**
  - `comments: add, list oldest first, 500 code points accepted and 501 refused, 1000 emoji counted as code points, empty and whitespace-only refused, a lone surrogate and NUL stripped, bidi and zero-width stripped, a term from the matcher stored as typed` (Review Focus 2)
  - `the 51st comment refused; removal by the author, by a senior, refused for another moderator; an unknown id is 404 with the same body as someone else's`
  - `comments are not in events, webhooks, Discord posts, audit rows, notices, AI inputs or logs` (scan each output with a sentinel); `deleting a report deletes its comments`
  - `escalate: each allowed pair; an owner escalating, an unknown role and a missing to refused; a decided report is closed; the claim is untouched; a note becomes a thread entry; case.escalated holds ids, the target role and a time`
  - `deciding the report clears the escalation in the same transaction; clearEscalation by the asker, by a senior for a senior ask, refused for an unrelated moderator; a second clear is a no-op`
  - `comments and escalation are never claim-gated: a moderator who does not hold the case can comment`
  - http: `with desk.workflow off every workflow route is 404 and GET /reports/:id has no comments or escalation keys and /changes no asked; on: permission boundaries at moderator and senior; audit report.comment, report.comment_remove and report.escalate best-effort; the audit row holds the report target and no text`
  - `GET /changes asked counts per target role only; the summary carries escalatedTo only when set on an open report`
  - `createChatwarden throws a plain message when workflow is on and the store lacks the methods`
- **Run:** `npx vitest run packages/core/test/comments.test.ts packages/core/test/escalate.test.ts packages/http/test/admin.workflow.test.ts packages/core/test/decide.test.ts packages/http/test/admin.every-route.test.ts`

### Task U7: Insights
Spec 8, 14 (insights edges). Needs U1, U2 and U3. Read first: `core/src/chat.ts` (`accept`, the hot path), `appealService.ts` (`stats`).
- **Files:** `packages/core/src/insights.ts` (new: `computeInsights(rows, counts, sanctionsByRule, now, days)`, percentile and bucket
  helpers, `INSIGHTS_MIN_DECIDED = 5`, `INSIGHTS_MIN_URGENT = 3`, `INSIGHTS_ROW_CAP = 20000`), `chatCounter.ts` (new: in-memory
  delivered and refused counters per UTC day, flushed to `addChatCounts` when the minute changes or at `flush()`, only while
  `desk.insights` is on), `chat.ts` (the counter is told once per `accept` result, never throws, never delays), `chatwarden.ts`
  (`cw.insights = { enabled, read(days), digest(days), emitDigest(days), flush }`), `retention.ts` (`purge` calls `purgeChatCounts`),
  `packages/http/src/admin/insights.ts` (new: `GET /insights?days=`), `packages/discord/src/feed.ts` (`postDigest(days = 7)`), webhook
  events accept `insights.digest`, tests `packages/core/test/insights.test.ts`, `chat-counter.test.ts`, `packages/http/test/admin.insights.test.ts`,
  `packages/discord/test/feed.digest.test.ts`.
- **Tests (names):**
  - `median, p90, longest open wait and the five backlog buckets on a fixture with exact edges (1 h, 4 h, 1 d, 3 d); medianMs is null at 4 decided and exact at 5; urgent medianMs null at 2 and exact at 3`
  - `volume by reason includes "none"; by outcome counts actioned, dismissed and bad-faith; by rule from the sanctions in the window with uncovered last; an empty store gives zeros and nulls and never NaN`
  - `actionedBy, subject ids, handles and text never appear in the result` (key scan); `the result has no per-person field of any kind`
  - `reports at the 20 000 cap set partial true; days other than 7, 30, 90 are invalid`
  - `chat counts: delivered and refused per UTC day; a minute roll flushes once; a crash loses at most the current minute (flush not called); counting is off when desk.insights is off and the store sees no write; two processes add correctly`
  - `reportsPer1000 is reports over delivered lines times 1000; null when delivered is 0 or when counting began inside the window`
  - `accept is as fast with the counter on (a spy store sees at most one write a minute)`
  - `digest returns counts and times only; emitDigest raises insights.digest once; postDigest posts one message under the post limit with no names; a failing post is logged by class and does not throw`
  - http: `GET /insights needs insights.read, audits insights.view best-effort, is 404 when off, 400 invalid_query for a bad days; no-store JSON`
- **Run:** `npx vitest run packages/core/test/insights.test.ts packages/core/test/chat-counter.test.ts packages/core/test/chat.test.ts packages/http/test/admin.insights.test.ts packages/discord/test/feed.digest.test.ts packages/core/test/retention.test.ts`

### Task R1: Room modes in core
Spec 9.1. Needs U1 and U2. Read first: `chatwarden.ts` (`rooms`, `setPace`, the room override map), `chat.ts` (`run`, the order of checks),
`pacing.ts`, `evidence.ts` (`RoomRoster`).
- **Files:** `packages/core/src/roomModes.ts` (new: `RoomModeState`, the per-process map with the injected clock, `until` and lazy
  expiry, `defaultModeMs`), `chat.ts` (`accept` takes `opts.staff?: boolean`; after the person's own restriction check and before the
  matcher it refuses `locked` for a non-staff caller and `new_account` in emergency for an account under `emergency.newAccountDays`
  per `rooms.unknownAge`; `RefuseReason` gains `locked` and `new_account` with `until`), `pacing.ts`/`chatwarden.ts`
  (`rooms.pace(roomId)` takes the stricter of the room's pace and emergency's `slowModeMs` while the mode is emergency), `roster`
  listing (`RoomRoster.rooms()`), `chatwarden.ts` (`rooms.setMode`, `mode`, `list`, `postingState`; `rooms.close` clears the mode;
  `room.mode` event), tests `packages/core/test/room-modes.test.ts`, `room-modes-accept.test.ts`, `room-list.test.ts`.
- **Interfaces (Produces):** `rooms.setMode(roomId, mode: 'normal' | 'locked' | 'emergency', opts?: { forMs?: number }): RoomModeState`
  (`{ mode, since, until }`; `normal` clears; a second call replaces whole and restarts the clock); `rooms.mode(roomId)`;
  `rooms.list(): Array<{ roomId; tags; seated: number; mode; until }>` (500 at most, most seated first, no seat ids or handles);
  `rooms.postingState(roomId, seatId): 'ok' | 'locked' | 'new_account'` (pure read).
- **Tests (names):**
  - `setMode locked and emergency with the default length and with forMs at 60 000 and 86 400 000; 59 999, 86 400 001, 2.5, NaN and a string throw RangeError and change nothing; an unknown mode throws`
  - `a locked room refuses a non-staff line with locked and until; a staff caller is delivered; history, mute and report still work; normal clears at once`
  - `the lock is checked before the matcher: a synthetic slur line in a locked room is refused locked, earns no strike and no automatic timeout and no evidence line is blocked-flagged` (Review Focus 3)
  - `the order is empty, length, the person's own restriction, locked, new_account, then matcher, then pace`
  - `emergency: slow mode is the stricter of the room's pace and 30 s; an account under 7 days is refused new_account with until; an account of 8 days is delivered; unknownAge allow lets an unknown age through and treat_as_new refuses it; newAccountDays 0 turns the read-only off`
  - `expiry: a mode at until reads as normal on the very next accept with the broadcaster not running; the expiry raises room.mode once with expired true; a clock that steps back does not extend it`
  - `staff comes from the facade option only: accept ignores a staff flag buried in the line text, and the broadcaster passes member.staff (R3)`
  - `rooms.close clears the mode and the pace override; a restart is a fresh map; two setMode calls at once leave the later one and raise two events`
  - `list: most seated first, capped at 500, includes a room with a mode and no seats, never a seat id or handle; postingState follows the same decision as accept for the seat`
  - `room.mode holds the room id, mode, until, a time and expired; nothing else`
  - `with no mode set and rooms defaults, accept answers exactly as before` (an off-parity guard for this theme's own change)
- **Run:** `npx vitest run packages/core/test/room-modes.test.ts packages/core/test/room-modes-accept.test.ts packages/core/test/room-list.test.ts packages/core/test/chat.test.ts packages/core/test/pacing.test.ts`

### Task R2: Probation, surge, linked accounts, evidence ref (core)
Spec 9.3, 9.4, 10, 11. Needs R1 and U3. Read first: `pacing.ts`, the `accountAgeDays` plumbing in `signals.ts`/`chatwarden.ts`, `staffViews.ts`,
`subjects.ts` (`identifiersOf`, `aliasesOf`), `sanctions.ts` (`SanctionIndex`), `doors.ts`.
- **Files:** `packages/core/src/pacing.ts` (a probation floor: for a person whose age is under `ageDays` the effective `slowModeMs` is
  at least `probation.slowModeMs`, the refusal is `probation` with `retryAfterMs`; age cached 10 minutes per person; `PACE_REASONS`
  appends `probation`), `packages/core/src/surge.ts` (new: `surgeOf(person, now, settings, deps)`; reads `listReportsByPerson` for the
  window, caps at 200 reports and 100 reporters, ages through `accountAgeDays` over each reporter's account ids), `staffViews.ts` or
  `staffReports.ts` (`StaffReport` gains `surge?` and `evidence?`), `reports.ts` (`ReportInput.evidenceRef` validated to 1 to 128 of
  `[A-Za-z0-9_:-]`; an invalid one is dropped, logged by class, the report is taken), `evidence.url` helper in `reporting.ts`
  (`evidenceLink(settings, ref)`), `chatwarden.ts` (`cw.people.links(subject)`), tests `packages/core/test/probation.test.ts`,
  `surge.test.ts`, `people-links.test.ts`, `evidence-ref.test.ts`.
- **Behaviour:** probation is a pace floor and nothing else: no strike, notice, audit row or record. `links` returns counts only
  (`accounts`, `devices`, `merged`, `firstLinkedAt?`, `inForceOnLinked: { ban, area, chat }`), never an id, key, hash or IP, and
  never reads `ips`. Surge appears only when enabled and over the threshold; `newAccounts` is null when no hook is wired.
- **Tests (names):**
  - `probation off: no change; on: a player of 1 day gets at least 5 s between lines in a room with no slow mode, a player of 3 days does not; the stricter of room slow mode and probation wins; the refusal is probation with retryAfterMs`
  - `age cached for 10 minutes then asked again; a throwing hook reads unknown; unknownAge allow and treat_as_new; a guest with no account follows unknownAge`
  - `probation writes no strike, notice, audit row, signal or record, and never appears on My record` (a pause, not a sanction)
  - `surge: below the threshold nothing; at 5 reports in 10 minutes it appears with reports, distinct reporters, window and newAccounts; the window edge is inclusive; 200 reports and 100 reporters caps; disabled gives no key; no age hook gives newAccounts null; a merged alias counts as one person`
  - `surge never changes an order, a decision input, an event or a refusal; a report from a new account is stored exactly like any other`
  - `links: a person with 2 accounts, 1 key and 1 merged alias returns 2, 1, 1; a guest and an unknown subject return zeros; inForceOnLinked counts a ban placed on a merged alias and not one on the person's own subject; IPs are never counted; the result has no string values other than kinds` (key scan)
  - `door: a new account merged into a banned person is refused with the ban's own refCode; an unrelated new account is allowed` (pins existing behaviour)
  - `evidenceRef: 128 characters accepted, 129 dropped; a dot, slash, space, emoji and NUL dropped with the report still taken; null and absent read null; it is absent from events, summaries and logs`
  - `evidenceLink replaces {ref} with encodeURIComponent(ref) only for an https template with one placeholder; no template gives null; a template edited to http after the fact gives null at read`
- **Run:** `npx vitest run packages/core/test/probation.test.ts packages/core/test/surge.test.ts packages/core/test/people-links.test.ts packages/core/test/evidence-ref.test.ts packages/core/test/pacing.test.ts packages/core/test/doors.test.ts`

### Task R3: Retraction, broadcaster and chat wire 2
Spec 9.2, 12.1. Needs R1 and U3. Read first: `http/src/chat/broadcaster.ts` (`session`, `noticePending`, the ring, hello building at
`CHAT_WIRE_VERSION`), `chat/history.ts`, `chat/wire.ts`, `chat/routes.ts`, and `core/src/evidence.ts`.
- **Files:** `packages/core/src/evidence.ts` (`EvidenceLine.retracted?`, `EvidenceBuffer.retract(roomId, lineId, opts)` returning the
  ids changed), `types.ts` (`ReportExcerptLine.retracted?`), `chatwarden.ts` (`rooms.retract(roomId, lineId, { allFromAuthor? })`:
  `{ ok: true; lineIds: string[] } | { ok: false; refused: 'not_found' }`, raises `line.retracted`), `packages/http/src/chat/wire.ts`
  (`CHAT_WIRE_VERSION = 2`, `hello.mode`, `you.readOnly`, the `mode` and `retract` frames, `WireRefusal.reason` docs, `refusalOf` keeps
  `until` for the two mode reasons), `history.ts` (`Ring.remove(ids)`), `broadcaster.ts` (`ChatMember.staff`, `ChatMember.evidenceRef`;
  subscribes to `room.mode` and `line.retracted` with `cw.on`, unsubscribes on `close`; a per-room timer through `schedule` at `until`;
  per-stream `readOnly` from `postingState`; `hello` excludes retracted lines; `session.report` passes `member.evidenceRef`; `send`
  passes `staff`), `routes.ts` (no request field ever sets `staff` or `evidenceRef`), `packages/player-react/src/chat/wire.ts` copy
  (type lock only here; behaviour in R5), tests `packages/core/test/retract.test.ts`, `packages/http/test/chat.retract.test.ts`,
  `chat.mode.test.ts`, `chat.wire2.test.ts`, the existing wire-assignability test.
- **Tests (names):**
  - `retract flags the evidence line and keeps its text; a report filed after carries retracted true on that excerpt line; a report already filed keeps its excerpt unchanged; a report on a retracted line is accepted`
  - `allFromAuthor retracts every line of the same occupant still in the buffer, follows the occupant at the time of each line when the seat changed hands, and leaves other players' lines`
  - `retract of a line older than 15 minutes, of a line past the 100-line cap, and of an unknown id is not_found with the same shape; line.retracted holds the room, the ids and a time and no text or seat`
  - `retraction writes no sanction, notice or strike and tells the author nothing` (Review Focus 4)
  - `the broadcaster removes the text from its ring, sends one retract frame to every stream including the author's, and a new joiner's hello has no retracted line (id or text)`
  - `a game's own socket gets the same through cw.on; closing the broadcaster unsubscribes both listeners`
  - `mode: setMode sends a mode frame to every open stream with readOnly computed per viewer (a staff member false, an account of 1 day in emergency new_account, in a locked room locked); hello carries mode and readOnly; the timer at until sends a normal mode frame; a late timer cannot make a refusal wrong because accept checks the clock`
  - `member.staff is passed to accept and a request body field named staff is ignored; evidenceRef from the join hook reaches a chat-box report and a body field named evidenceRef is ignored`
  - `CHAT_WIRE_VERSION is 2; a hello with v 1 is refused by the client type lock; WireRefusal accepts locked, new_account and probation; refusalOf keeps until for the two mode reasons and retryAfterMs for probation and drops unknown keys`
  - `the player-react wire copy is assignable both ways` (existing test updated)
- **Run:** `npx vitest run packages/core/test/retract.test.ts packages/http/test/chat.retract.test.ts packages/http/test/chat.mode.test.ts packages/http/test/chat.wire2.test.ts packages/http/test/chat.wire.test.ts packages/http/test/chat.broadcaster.test.ts`

### Task R4: HTTP: rooms, links, case body additions
Spec 12.2, 9.4, 10, 11. Needs R1, R2, R3 and U5.
- **Files:** `packages/http/src/admin/rooms.ts` (new `roomRoutes(ctx)`: `GET /rooms`, `POST /rooms/:room/mode`, `POST
  /rooms/:room/lines/:line/retract`), `people.ts` (`GET /people/:ref/links`), `reports.ts` (`GET /reports/:id` gains `surge` and
  `evidence: { ref, url } | null`; excerpt lines gain `retracted` and `removable: boolean` (still in the buffer) for staff),
  `validate.ts` (`bodyMode`, `bodyForMs`, room and line param checks), `admin/index.ts`, `me.ts` (`features` gains `rooms`, `workflow`,
  `insights` booleans), tests `packages/http/test/admin.rooms.test.ts`, `admin.links.test.ts`, `admin.case-extras.test.ts`.
- **Behaviour:** the `room.mode` and `room.retract` audit rows are `required`, written **before** the change for a lock and an
  emergency and before the retraction (a failed audit write fails the call and changes nothing); the target is the room, by
  `roomAuditRef`. `POST mode` with `normal` is audited too and needs no `forMs`.
- **Tests (names):**
  - `permission boundaries: rooms.read and rooms.manage at moderator and raised by the permissions option; GET /rooms is no-store JSON with no seat id or handle`
  - `POST mode: 200 with the new state; 400 invalid_mode, a bad forMs and a bad room id; the audit write comes first and a failing audit leaves the room unchanged; a room with an awkward id is audited by hash`
  - `POST retract: 200 with the count; 404 not_found for an old line; allFromAuthor honoured; audit room.retract required; the body holds no text`
  - `GET /people/:ref/links needs history.read, audits history.view, returns counts only (key scan: no ids, keys, hashes or ips), 404 for an unknown ref`
  - `GET /reports/:id has surge only when enabled and over the threshold, evidence null with no ref and a url only for an https template, excerpt lines carry retracted and removable; the queue summary carries none of them`
  - `GET /me features has rooms, workflow and insights as booleans; the every-route test lists every new route`
- **Run:** `npx vitest run packages/http/test/admin.rooms.test.ts packages/http/test/admin.links.test.ts packages/http/test/admin.case-extras.test.ts packages/http/test/admin.every-route.test.ts packages/http/test/permissions.test.ts`

### Task R5: player-react: the chat box under a mode
Spec 12.1, 16, 18. Wire shapes only; can start early. Read first: `chat/ChatBox.tsx`, `state.ts`, `status.ts`, `words.ts`,
`Composer.tsx`, `chat-pace.test.tsx`.
- **Files:** `packages/player-react/src/chat/wire.ts` (the v2 types), `state.ts` (reduce `mode` and `retract` frames, `hello.mode`,
  `you.readOnly`; a retract replaces the line with a tombstone and drops its text), `ChatBox.tsx` and `Composer.tsx` (one status
  line above the composer while the mode is not normal; read-only disables the composer with `aria-disabled` and the line as its
  description), `status.ts`/`words.ts` (`enChat` keys `chat.locked`, `chat.readOnlyNew`, `chat.probation`, `chat.removed`,
  `chat.modeEmergency`; refusal text for `locked`, `new_account`, `probation`), `ReportDialog.tsx` and the thank-you screen (the
  reason's `thanks`, then the `resources` list when `showResources`; links `https` only through `safeHref`), `i18n.ts` (`report.resources`),
  README, tests `chat-mode.test.tsx`, `chat-retract.test.tsx`, `report-thanks.test.tsx`, `chat-a11y.test.tsx`, `chat-wire.test.ts`,
  `chat-static.test.ts`, `chat-size.test.ts`, `no-leak.test.tsx`.
- **Tests (names):**
  - `a locked hello disables the composer with aria-disabled and the line "Chat is locked until 14:30" as its description, the composer stays in the tab order; a mode frame back to normal removes both; a staff viewer (readOnly absent) can type`
  - `emergency shows "Slow mode is on." and, for a read-only new account, "New accounts can only read right now."; a refusal of locked, new_account and probation shows its own words with the time or the wait; an unknown reason falls back to the generic line`
  - `a retract frame replaces the line in place with "Message removed by a moderator." and deletes its text from state (assert by scanning the rendered tree and the reducer state for the sentinel); the placeholder takes no focus; a line retracted before it was ever rendered never renders`
  - `mode and retract announcements go to the polite live region once per change and a retract of several lines is one announcement; nothing is assertive` (Review Focus 4)
  - `a v1 hello is refused as an unsupported server with the existing offline wording`
  - `the thank-you shows the reason's thanks, else the global one; a showResources reason lists the resources with an https link that opens with rel="noopener noreferrer"; a resource with no url is plain text; a reason without showResources shows none; the dialog never says anyone was alerted`
  - `no identifier or staff field appears in any answer (no-leak); chat-static lists the new exports; size budgets hold`
- **Run:** `npx vitest run packages/player-react/test/chat-mode.test.tsx packages/player-react/test/chat-retract.test.tsx packages/player-react/test/report-thanks.test.tsx packages/player-react/test/chat-a11y.test.tsx packages/player-react/test/chat-wire.test.ts packages/player-react/test/chat-static.test.ts packages/player-react/test/chat-size.test.ts packages/player-react/test/no-leak.test.tsx`

### Task U8: hub-react: the urgent chip, case strip and `CaseMenu`
Spec 5.2, 5.3, 16. Needs U5. Read first: `liveQueue.tsx`, `headless/liveQueue.ts`, `queue.ts` (`QueueGroup`, the sorts), `shell/QueuePane.tsx`,
`shell/SimpleNav.tsx`, `screens/SimpleHome.tsx`, `case/CaseCard.tsx`, `case/AiDetails.tsx` (the `...` pattern), and the current
`size.test.ts` budget.
- **Files:** `packages/hub-react/src/types.ts` (summary and detail types), `client.ts` (`urgentReports`, `setUrgent`, `handoff`),
  `queue.ts` (`QueueGroup.urgent`, the pin applied after every sort), `headless/liveQueue.ts` (the urgent count from `GET /changes`,
  `GET /reports?urgent=1` merged into the list; an arrival announcement), `shell/UrgentChip.tsx` (new), `shell/QueuePane.tsx`,
  `screens/SimpleHome.tsx`, `QueueRow.tsx` (the "Urgent" `Tag`), `case/CaseMenu.tsx` (new: a `...` disclosure that renders nothing
  when it has no item; this task adds "Mark as urgent" and "Not urgent"), `case/UrgentStrip.tsx` and `case/WhatToDo.tsx` (lazy: the
  strip is eager and tiny, the panel lazy through `screens/lazy.tsx`), `i18n.ts` (`hub.urgent.*`, `hub.safety.*`), tests
  `urgent-chip.test.tsx`, `urgent-sort.test.ts`, `what-to-do.test.tsx`, `case-menu.test.tsx`, `a11y-urgent.test.tsx`, `size.test.ts`.
- **Behaviour:** the chip is one button, "2 urgent, oldest 14 min", present only when the count is above zero; it opens the oldest
  free urgent case (or the oldest if all are held) and the label says "held by <name>" when it is. The pin puts urgent groups above
  every other group in every sort and the `rankedLow` mark never applies to them. "What to do" renders the profile's `safety.guidance`
  paragraphs as text, `safety.contact` when set, the two buttons, and the one-line limits sentence of spec 3. "I passed this to our
  safety team" calls `handoff`, shows the time and who in the strip, and survives a reload; claim refusals show in words and keep the
  panel.
- **Tests (names):**
  - `the chip is absent at zero and in the loading state, present with the count and the oldest wait, one element not one per case, a button with a name; clicking opens the oldest free urgent case; with all held the label names who holds it` (Review Focus 1)
  - `a new urgent report announces "An urgent report arrived" once through the polite live region on 0 to 1 and on an increase, not on a poll that changes nothing, never assertively`
  - `an urgent group sorts first under newest, oldest, most reports and priority; a rankedLow habitual reporter does not demote it; an urgent report older than the loaded pages is fetched by urgent=1 and shown`
  - `the row word is the text "Urgent" and not a colour; a non-urgent row is unchanged (DOM snapshot of a queue with no urgent report equals the snapshot without this feature)`
  - `the strip shows the reason label; the panel renders the owner's guidance as plain text (a <script> and a markdown link render literally) and the studio contact; the default guidance shows when unset; the limits sentence is always there`
  - `hand-off: records and shows who and when, is idempotent, honours the claim gate in words, keeps what was open; Mark as urgent from CaseMenu works for a moderator and shows in the queue at once`
  - `CaseMenu renders nothing when it has no item, is a disclosure with aria-expanded, closes on Escape and returns focus, and its Escape does not also leave the case`
  - `Simple mode shows the chip above Cases and the strip and panel on its case card; Simple's menu is otherwise unchanged`
  - `the panel and the strip's lazy code are not in the main chunk; axe: no violations light and dark; 360 px no sideways scroll; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/urgent-chip.test.tsx packages/hub-react/test/urgent-sort.test.ts packages/hub-react/test/what-to-do.test.tsx packages/hub-react/test/case-menu.test.tsx packages/hub-react/test/a11y-urgent.test.tsx packages/hub-react/test/live-queue.test.tsx packages/hub-react/test/size.test.ts`

### Task U9: Reporting reasons and the Safety panel
Spec 4, 5.2 (reporter), 17. Needs U1 and U5. Read first: `screens/ReportingSettings.tsx`, `pieces/ReportingSettings.tsx`, the 0.1.14
`PaceSettings.tsx` panel pattern, `policyHooks.ts`.
- **Files:** `packages/hub-react/src/screens/ReportingSettings.tsx` (per reason: an "Urgent" checkbox, a "Thank-you for this reason" field,
  a "Show help resources" checkbox, under each reason's existing disclosure; `welfare` is listed disabled with a one-line help), 
  `screens/SafetySettings.tsx` (new lazy panel under Advanced: the guidance text (with the default shown as the placeholder and a
  "not legal advice" note), the studio contact line, up to five resources with label, detail and https url, and the limits sentence),
  `screens/AdvancedSettings.tsx`, `lazyParts.tsx`, `policyHooks.ts` (`layer.safety`), `i18n.ts` (`hub.settings.safety.*`,
  `hub.settings.reporting.urgent*`), tests `reporting-urgent-fields.test.tsx`, `safety-settings.test.tsx`, `a11y-settings.test.tsx`,
  `lazy-screens.test.tsx`, `api.test.ts`, `size.test.ts`.
- **Behaviour:** owner edits, seniors and moderators read. Saving needs a reason and handles a 409 with a reload offer. The reporting
  preview from the names-in-reports theme renders the reason's player view from the server's `PlayerReporting` (spec 17); until that
  lands the panel shows the thank-you text in a plain read-only box.
- **Tests (names):**
  - `the three per-reason fields appear in each reason's disclosure; the Urgent box is checked for threat and welfare by default; welfare shows disabled with its help; a thank-you over 300 characters shows the count and refuses to save; switching urgent off warns "reports already filed stay urgent"`
  - `the Safety panel is collapsed by default, lazy, owner-editable and read-only for others; guidance over 1500 characters, contact over 300, a sixth resource and a non-https url are refused in words with the path`
  - `saving sends the whole layer with safety merged and a reason; a 409 offers to reload; reset restores the base; the panel never shows safety.contact to a role without policy.read`
  - `the default guidance is shown as the placeholder and is not saved unless edited`
  - `axe: no violations; 360 px no sideways scroll; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/reporting-urgent-fields.test.tsx packages/hub-react/test/safety-settings.test.tsx packages/hub-react/test/a11y-settings.test.tsx packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task U10: hub-react: the desk (thread, a second look, Desk panel, Insights)
Spec 6, 8. Needs U6, U7 and U8.
- **Files:** `packages/hub-react/src/client.ts` (`comments`, `addComment`, `removeComment`, `escalate`, `clearEscalation`, `insights`),
  `case/CommentThread.tsx` (lazy), `case/CaseMenu.tsx` (adds "Ask a senior to look" and "Escalate to the owner", each with an optional
  note, only with `features.workflow` and the permission), `QueueRow.tsx` (the "Asked for a look" word), the queue Filters drawer
  (one option, "Asked for a look", only with workflow on), `screens/Overview.tsx` (the conditional line "N cases waiting for a senior
  look" and the "Insights" link, each only when on, permitted and above zero), `screens/Insights.tsx` (lazy; route `insights`),
  `router.ts`/`nav.ts` (`{ name: 'insights' }`, permission `insights.read`, not a rail tab), `commands.ts` (an "Insights" entry),
  `screens/DeskSettings.tsx` (lazy Advanced panel: Workflow, Insights and Surge switches with one sentence each, the surge numbers),
  `i18n.ts` (`hub.desk.*`, `hub.insights.*`), tests `comment-thread.test.tsx`, `ask-look.test.tsx`, `insights-screen.test.tsx`,
  `desk-settings.test.tsx`, `a11y-desk.test.tsx`, `lazy-screens.test.tsx`, `size.test.ts`.
- **Behaviour:** the thread shows staff names and times, plain text, a remove link on the caller's own comments (and any for a senior),
  a 500-character counter in code points, and the line "Do not paste chat here." Asking for a look shows "Asked for a look by <name>,
  <time>" on the case with "Looked at" for anyone allowed. Insights is a read-only page: counts and times in tables with captions,
  the median beside the longest wait, a note "counted from <date>" when relevant, a "partial" notice, no chart, no export, no names.
- **Tests (names):**
  - `with workflow off none of it renders (the DOM of the case, the menu and the queue equals the snapshot without this feature); on: the thread and the menu items appear for a moderator`
  - `the thread renders a <script> and a markdown link literally, strips nothing the server kept, counts 1000 emoji as code points and refuses 501; remove shows on own comments for a moderator and on all for a senior`
  - `ask and escalate send to the right target with the note; the case shows who asked; Looked at clears it for the asker and for a senior and is absent for an unrelated moderator; deciding the case clears the line`
  - `the queue row word and the Filters option exist only with workflow on; the Filters option lists only cases addressed to the caller's role or lower; escalation does not change the order`
  - `Overview's line and Insights link render only when on, permitted and above zero`
  - `the Insights page renders each number from a fixture, never a per-person figure (assert no staff name in the DOM), shows null medians as "not enough decisions yet", partial and counted-from notes, and tables have captions and header cells`
  - `the Desk panel saves the three switches through the layer with a reason; only the owner edits; the surge fields validate their ranges in words`
  - `the thread, Insights and Desk panel are lazy; axe: no violations light and dark; 360 px no sideways scroll; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/comment-thread.test.tsx packages/hub-react/test/ask-look.test.tsx packages/hub-react/test/insights-screen.test.tsx packages/hub-react/test/desk-settings.test.tsx packages/hub-react/test/a11y-desk.test.tsx packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/size.test.ts`

### Task U11: hub-react: the careful view
Spec 7, 16. Needs U8. Read first: `mode.tsx` (the `localStorage` pattern with try/catch), `case/Transcript.tsx`, `case/CaseContext.tsx`
(`reveal`), `case/AiStrip.tsx`, `case/AppealCard.tsx`, `screens/AdvancedSettings.tsx`.
- **Files:** `packages/hub-react/src/care.ts` (new: `readCare`/`writeCare` for `hideExcerpts`, `countOpened`, `breakAfter`, and the day's
  counter keyed by the browser's local date; every access in `try/catch`; eager and tiny), `case/CaseContext.tsx` (a `care` slice: the
  case's excerpt is hidden until `openExcerpt()`; opening counts once per case), `case/Transcript.tsx` and the Simple card's line list,
  `case/AiStrip.tsx`/`AiRead.tsx`, `case/AppealCard.tsx`, and the reporter-note block (each renders `<HiddenExcerpt lines=n>` instead of
  its text while hidden), `case/HiddenExcerpt.tsx` (new), `case/BreakNote.tsx` (new: `role="status"`, dismissable, non-modal),
  `screens/YourView.tsx` (new, rendered first in Advanced with no data loading: two switches and a select, a one-sentence honest help
  "This hides text in your browser. It is care, not protection."), `commands.ts` (a toggle entry), `i18n.ts` (`hub.care.*`), tests
  `care-hide.test.tsx`, `care-count.test.tsx`, `care-storage.test.ts`, `a11y-care.test.tsx`, `size.test.ts`.
- **Tests (names):**
  - `hidden: the transcript, reporter note, AI summary and lines and an appeal statement are not in the DOM at all (query the container for the sentinel text and for any element whose text contains it); the button says "Show the chat (12 lines)"; opening shows all of them; the blocked-word masking still applies inside` (Review Focus 5)
  - `opening applies to the whole case for the visit and does not survive leaving the case or a reload; a second case is hidden again`
  - `off by default in every mode and for urgent cases; turning it on in Advanced or the command bar applies at once`
  - `the setting, the counter and the break choice are read and written through localStorage in try/catch; a throwing storage leaves the setting for the visit and nothing breaks; no network request carries any of them (spy on the transport)`
  - `the counter counts one per case opened, resets at the browser's local midnight (fake clock), is shown only in the panel, and with counting off nothing is stored`
  - `the break note appears at N, again at 2N, never before, is role="status", does not take focus, does not block the case, closes with Escape or its button`
  - `axe: no violations light and dark; 360 px no sideways scroll; focus returns to the Show button's position after opening; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/care-hide.test.tsx packages/hub-react/test/care-count.test.tsx packages/hub-react/test/care-storage.test.ts packages/hub-react/test/a11y-care.test.tsx packages/hub-react/test/transcript.test.tsx packages/hub-react/test/size.test.ts`

### Task R6: hub-react: Rooms panel, surge, links, evidence
Spec 9, 9.4, 10, 11, 16. Needs R4, R5 and U8 (`CaseMenu`).
- **Files:** `packages/hub-react/src/client.ts` (`rooms`, `setRoomMode`, `retractLine`, `personLinks`), `screens/RoomsSettings.tsx` (new lazy
  Advanced panel: the list from `GET /rooms` with a labelled radio group Normal, Locked, Emergency per room, a duration select (15
  minutes, 30 minutes default, 1 hour, 4 hours) shown when choosing a restrictive mode, a plain "This server only" line, a "capped at 500"
  note, the expiry shown as a time), `case/CaseMenu.tsx` (adds "Lock this room" and "Emergency mode" for the report's room when the
  caller has `rooms.manage`), `case/Transcript.tsx` (a per-line "Remove from the room" in the line's own `...` only when the server says
  `removable` and the caller has `rooms.manage`, with "Remove all recent lines from this player"; a line with `retracted` shows the
  word "Removed from the room"), `case/SurgeLine.tsx` (one line on the case when `surge` is present), `case/EvidenceRow.tsx` (one row
  "Match or replay" with a link only for an https url, `rel="noopener noreferrer"`, through `safeHref`), `screens/Person.tsx` (the
  `...` menu gains "Linked accounts", which loads `personLinks` and shows one line), `i18n.ts` (`hub.rooms.*`, `hub.case.surge`,
  `hub.case.evidence`, `hub.person.links.*`), tests `rooms-panel.test.tsx`, `case-room-actions.test.tsx`, `surge-evidence.test.tsx`,
  `person-links.test.tsx`, `a11y-rooms.test.tsx`, `lazy-screens.test.tsx`, `size.test.ts`.
- **Tests (names):**
  - `the panel lists rooms with no seat ids or handles, shows the capped note at 500, an empty state in words, and per room a radio group; choosing Locked or Emergency asks for a duration and Cancel changes nothing; choosing Normal needs no confirmation and is immediate`
  - `the expiry time is shown, and a mode that expired on the server reads Normal at the next refresh; a failed save keeps the control on its old value and says why in words`
  - `CaseMenu shows Lock this room and Emergency mode only with rooms.manage and a room on the report; a report with no room has neither; the confirm names the duration`
  - `Remove from the room appears only on a removable line for rooms.manage, sends allFromAuthor when chosen, shows "Removed from the room" afterwards, and a 404 says the line is too old in words` (Review Focus 4)
  - `the surge line renders with the numbers and the hint "A hint, not a reason to set reports aside." only when the case has surge; newAccounts null drops the second half; nothing appears in the queue`
  - `the evidence row renders a link only for an https url, a plain ref otherwise, and nothing with no ref; a javascript: url from a bad server renders as text`
  - `Linked accounts: the Person ... menu loads on demand, shows counts and the shared-device hint, shows "none linked" for zeros, and never renders an id; the menu has no new always-visible element`
  - `without rooms.manage, rooms.read or the data none of it renders (the case, queue and Person DOM equal the snapshot without this theme)`
  - `the panel is lazy; axe: no violations light and dark; 360 px no sideways scroll; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/rooms-panel.test.tsx packages/hub-react/test/case-room-actions.test.tsx packages/hub-react/test/surge-evidence.test.tsx packages/hub-react/test/person-links.test.tsx packages/hub-react/test/a11y-rooms.test.tsx packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/size.test.ts`

### Task U12: Docs, recipes, example, gates
- **Files:** READMEs of `core` (urgent, hand-off, workflow, insights, room modes, retraction, probation, `links`, the events, retention,
  the "kit limits" statement of spec 3 near the top of the safety section), `http` (routes, permissions, chat wire 2, `ChatMember.staff`
  and `evidenceRef`), `player-react` (the chat box mode line, the thank-you resources), `hub-react`, `discord` (`urgentMention`,
  `postDigest`); `docs/recipes/` gains `urgent-and-welfare.md` (an adopter guide: what the kit does and
  does not do, wiring `report.created` with `urgent` to an on-call tool, the studio contact and resource text, retention, who is told
  what, a "not legal advice" note, and the CSAM line: stop, do not copy, follow your legal procedure), `raids.md` (lock, emergency,
  retraction, probation, the per-process limit, a restart) and `digest.md` (a cron or timer calling `cw.insights.emitDigest`);
  `docs/status.md`, `docs/plans/follow-ups.md` (the spec's open items: a per-moderator break reminder syncing, export of insights,
  unlink for linked accounts, a pager integration); `examples/tiny-chat` (`CW_DEMO_ROOMS=1` turns on a lock button and a retractable
  line; test `examples/tiny-chat/rooms.test.ts`); `scripts/readme.test.ts` expectations; the export snapshots; the append-only order
  tests. No site change.
- **Tests (names):** `tiny-chat with CW_DEMO_ROOMS locks a room, a non-staff line is refused locked, a staff line is delivered, the lock expires on the fake clock, a retracted line disappears from a second client and stays in a later report's excerpt`; `without the variable none of it exists`; `the readme checks pass`; `the recipes mention each of the kit's limits of spec 3 (a content check on the three recipe files)`; `the browser bundle budget holds`.
- **Run:** `npx vitest run examples/tiny-chat/rooms.test.ts scripts/readme.test.ts scripts/browser-bundle.test.ts`, then `npm run lint` and `npm run typecheck`.

---

## Release
No release-prep task here. This theme hands the release the following: the migration 26 block is in place (U3); the changeset must say
that 0.2.0 settles the `@experimental` names, lists the breaking changes of spec 19 (the chat wire version, the widened refusal and pace
reason lists, the required event and record fields, `threat` urgent by default), and notes the one default-on behaviour (urgent first
in take-next); the peer floors rise by hand only where a package uses a new name (`http` and `discord` and `hub-react` on the new core
names, `player-react` on the wire 2 types it copies). Publishing is the maintainer's.

### What the adopter does (not part of the tag)
Nothing is on by default except the urgent lane for `threat`. To use the desk: set `desk.workflow` and `desk.insights` in Settings,
Advanced; for welfare, enable the `welfare` reason, write `safety.guidance`, `safety.contact` and `safety.resources`, and wire
`report.created` with `urgent` to the game's own safety process. For rooms: have the `join` hook set `ChatMember.staff` for moderators,
and (optional) `evidenceRef`; turn on `rooms.probation` if wanted; give `accountAgeDays` a hook so probation, emergency and surge can
read ages. Room modes are per process.

---

## Spec coverage (self-review)
1 and 2 to the Goal and Global Constraints; 3 to U4, U8, U9 and U12; 4 to U1; 5.1 and 5.2 to U4 and U5 and U8; 5.3 to U8 and U9; 6 to U6 and U10;
7 to U11; 8 to U7 and U10; 9.1 to R1; 9.2 to R3; 9.3 and 9.4 to R2; 10 to R2 and R6; 11 to R2, R3 and R6; 12.1 to R3 and R5; 12.2 to U5, U6, U7
and R4; 12.3 to U2; 13 to U3; 14 to the per-task tests (urgent and claims U4, snapshot U4, mode expiry R1, retract R3, comments U6, insights U7,
rooms list R1); 15 to Global Constraints and U4, U6, U7; 16 to U8, U10, U11, R5 and R6; 17 to U9 (preview), R1 (filters), U4 (purge), R3 and R4
(scope), U12; 18 to U8, U10, R5, R6; 19 to the tasks that make each break (1 R3, 2 R1 and R2, 3 U2 and U3, 4 U1 and U4, 5 U4, 6 R3, 7 R3, 8 U2, 9 U5
and U6); 20 (Rulings 1 to 23) each owned: 1 U4, 2 U4 and U5, 3 U4, 4 U4, 5 U4, 6 U4 and U8, 7 U4, 8 U4, 9 U6, 10 U1 and U6, 11 U11, 12 U3 and
U7, 13 R1, 14 R1, 15 R3, 16 R2, 17 R2 and R6, 18 R2, 19 R3 and R2, 20 U2, 21 R3, 22 U10, 23 U8. Names used across tasks (`CaseMenu`,
`roomAuditRef`, `postingState`, `RoomModeState`, `evidenceLink`, `surgeOf`, `HiddenExcerpt`, `UrgentChip`) are defined once in the owning task
and consumed under the same spelling.
