# Appeals inbox and offensive names (0.1.8) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** an adopter can turn on in-kit appeals: a player files one capped statement against one sanction from its notice, a second
moderator uphold, reduces or revokes it from the Cases queue, the player is told through a new notice, and a granted appeal feeds the AI
(the original decision is marked reversed, a corrective example, a per-rule false-positive band). Names get a second check (profanity),
optional kept evidence, a way to require a rename, and are masked in the hub when flagged.

**Architecture:**
- `@chatwarden/core` gets `appeals.ts` and `names.ts` (settings, types), an appeal service behind `cw.appeals`, name additions behind
  `cw.names` and `cw.people.accountIds`, four new notice kinds, three audit actions, three events. Sanctions gain an internal `reportId`
  and `startsAt`. `profile.ts` gains the `appeals` and `names` sections; `retention.ts` gains three fields.
- Optional `Store` methods and SQLite migration 22 (appeals, blocked names, a rebuilt `kit_notices`, two ALTERs). Memory and SQLite, two
  contract suites.
- `@chatwarden/http` adds the player and staff appeal routes, one rename route, a blocked-names source, and fields on existing bodies.
- `@chatwarden/discord` gains two posts; webhooks gain `includeAccounts`. `@chatwarden/player-react` gains `AppealDialog`, the outcome
  notices and `nameReasonText`. `@chatwarden/hub-react` gains an Appeals view of the Cases queue, the appeal card, two Settings, Advanced
  panels, a rename choice in the Sanction form, and name masking.

**Spec:** `docs/design/2026-11-12-appeals-and-names.md` (section numbers below refer to it), including its closing Rulings section.
Also binding: `docs/design/2026-11-10-editable-ladder-and-roadmap.md` (Part 2) and `docs/design/2026-11-11-ai-levels-1-2.md`.

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly`, every time from the injected
  `Clock` (no `Date.now()`), synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn), test-first, targeted
  runs only, `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree: commit by pathspec,
  `git add` new files first.
- **Sequencing.** This release follows 0.1.7 (flood control and signals, migration 21), which followed 0.1.6 (AI levels 1 and 2,
  `core/src/ai`, migration 20, audit actions `ai.read`, `ai.rerun`, `ai.outcome`) and 0.1.5 (triage, migration 19). None of them is on
  `main` when this plan is written. **Step 0, before Task 1:** after 0.1.7 merges, rebase on `main` and confirm `POLICY_SECTIONS` ends
  `... 'ai', 'pace', 'signals'`, the newest migration is 21, and `cw.ai`, `cw.signals` and the Settings, Advanced section exist. Tasks
  marked **after 0.1.6** name the 0.1.6 files to read. Migration here is **22**. `AUDIT_ACTIONS` is append-only: the three new actions go
  after whatever is last at that point (0.1.7 added none, so after `ai.outcome`); `AUDIT_TARGET_TYPES` gains `'appeal'` last. Branch
  `appeals-names`, worktree `C:\dev\chatwarden-wt\appeals`.
- `@chatwarden/core` stays browser-safe and dependency-free: no `node:` import, no `fetch`. `scripts/browser-bundle.test.ts` budgets are
  re-checked.
- **Off means identical.** With `appeals` and `names` unset, every result, event and http body is what 0.1.7 sends (a snapshot test in Task
  15 pins the bodies; each core task keeps its own off-parity test). The one deliberate exception is name masking, default on, which
  changes only what the hub shows for a handle the matcher flags (Task 19 tests both settings).
- **The statement is the only new player free text.** It lives in `kit_appeals.statement` and nowhere else: not in an event, webhook,
  Discord post, notice, audit row, log line or AI prompt. A spy logger in Tasks 8 and 9 asserts event names and error classes only.
  A player-facing answer carries no staff ref, reason, sanction id or person id.
- A name is never logged and never echoed. `cw.names.check` stores nothing unless the name is blocked, `keepBlocked` is on, and the caller
  is a player-side check (Task 12 adds the evidence-free `flagged` read for staff paths).
- **Hub budget.** The hub-react first-load budget in `packages/hub-react/test/size.test.ts` (76,800 B gzip at 0.1.7; read the current
  value after the rebase) is near the limit: the appeal card, the Appeals list, both Settings panels and the rename form fields load on
  demand. Eager code is limited to types, client calls, `displayName`, the view switch and Simple's one line. `size.test.ts` runs in every
  hub task.
- **UI rule (clean core, power behind one door).** The only always-visible additions, each conditional on a setting: the Reports | Appeals
  switch in the queue filter row, and Simple's single "N appeals waiting" line. Everything else is in Settings, Advanced, the Person page's
  existing timeline and Sanction form, and the Blocked screen's filter row. No new colour; bands are words. Every string through `t()`.
  Check in a real browser at desktop and 360 px, light and dark, for Tasks 19 to 22.
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no site deploy without the maintainer's go-ahead.

## Review Focus
Five failure modes no task's happy-path tests would otherwise exercise; each has its test in the owning task.
1. **Hostile statements.** Bidi and zero-width characters, NUL, a lone surrogate, 1000 emoji (code points, not UTF-16 units), a statement
   that is only blank lines, and one that is a term from the matcher: normalized, counted correctly, rendered as text, masked in the hub,
   absent from every other output. Tasks 8 and 20.
2. **A reduction measured from the wrong start.** Reducing a 7-day ban given 6 days ago to "24 hours": the replacement keeps the original
   start (so the ladder does not restart) and must never end later than the original. Task 9.
3. **Sanction lifecycle races.** Decide against a sanction that was revoked a moment earlier, an appeal open while retention removes the
   sanction, two decides at once, and a permanent ban whose decided appeal row would be purged (letting the player appeal again). Tasks 5, 6 and 9.
4. **Widening `NoticeKind` and rebuilding `kit_notices`.** Every code path that filters or switches on notice kind
   (`record`, `pending`, `announce`, `mustAcknowledge`, purge, `isSanction`, the player tables, the hub), and a migration that must keep
   every old row, id, order and index, with and without the AI tables. Tasks 2 and 7.
5. **A raw handle that slips past masking, and name checks that write.** Toasts, the page title, aria labels, copy buttons, the command
   bar and audit labels; and staff paths that call a check which stores evidence for every list view. Tasks 12, 16 and 19.

## Order and parallelism
Step 0 (rebase) first. Tasks 1, 2, 3 and 4 are independent and can run at once. Task 5 follows 1, 2 and 4. Task 6 follows 4. Task 7
follows 4, 5 and 6 (**after 0.1.6**). Task 8 follows 1, 2, 4. Task 9 follows 6 and 8. Task 10 follows 9. Task 11 follows 9 and 10
(**after 0.1.6**). Tasks 12 and 13 follow 1, 2, 3, 4 (13 also follows 12). Task 14 follows 8. Task 15 follows 10 and 3. Task 16 follows
12, 13 and 15. Task 17 follows 3, 9 and 13. Task 18 follows 2 and can start early against the wire shapes. Task 19 follows 16. Tasks 20
and 21 follow 15 and 19. Task 22 follows 16 and 19. Tasks 23 and 24 are last.

---

### Task 1: Settings: `appeals` and `names`
Spec 4.1, 5.1. Needs Step 0.
- **Files:** `packages/core/src/appeals.ts` and `names.ts` (new; settings, `resolveAppeals`, `resolveNames`, `APPEAL_STATEMENT_MAX = 1000`,
  exports `@experimental`), `packages/core/src/profile.ts` (`TOP_KEYS` and optional keys gain both; `ModerationProfile.appeals?`, `names?`;
  `ResolvedProfile.appeals`, `names`; `PolicyLayer.appeals?`, `names?`; `POLICY_SECTIONS` appends `'appeals'` then `'names'`; `applyLayer`,
  `layerSections`, `changedSections` follow), `packages/http/src/admin/policyProfile.ts` (route comment), tests
  `packages/core/test/appeals-settings.test.ts`, `names-settings.test.ts`, `policy-layer-appeals.test.ts`, `packages/http/test/admin.policy-appeals.test.ts`.
- **Interfaces (Produces):** `AppealSettings`, `ResolvedAppeals { enabled; perPlayerPerWeek; allowSelfReview }` (defaults false, 3, false),
  `NameSettings`, `ResolvedNames { profanity; keepBlocked; renames; maskInHub }` (defaults false, false, false, **true**). Errors are
  `ProfileError` with the path (`appeals.perPlayerPerWeek`), never echoing the value.
- **Tests (names):**
  - `defaults: appeals off, perPlayerPerWeek 3, allowSelfReview false; names profanity, keepBlocked, renames off and maskInHub on`
  - `perPlayerPerWeek 1 and 20 accepted; 0, 21, 2.5, NaN, a string refused with the path`; `non-boolean flags refused`; `unknown keys refused with their path`
  - `presets ship both unset`; `a layer beats the code profile, which beats the defaults`; `reset("appeals") and reset("names") restore the base`
  - `changedSections lists the sections; a save audits policy.update with sections ["appeals"] and no values`; `agentBrief and policyJson are unchanged`
  - `with both unset cw.profile equals the 0.1.7 profile apart from the two new resolved fields`
  - http: `PUT /policy/profile with appeals and names: 200; 409 stale; 400 invalid_profile with layer.appeals.perPlayerPerWeek; DELETE ?section=appeals and names reset`
- **Run:** `npx vitest run packages/core/test/appeals-settings.test.ts packages/core/test/names-settings.test.ts packages/core/test/policy-layer-appeals.test.ts packages/core/test/policy-layer.test.ts packages/core/test/golden.test.ts packages/http/test/admin.policy-appeals.test.ts`

### Task 2: Four notice kinds
Spec 4.7 (consequences in code), 4.10. Core only; the SQLite table rebuild is Task 7.
- **Files:** `packages/core/src/types.ts` (`NoticeKind` gains `'rename_required' | 'appeal_upheld' | 'appeal_reduced' | 'appeal_revoked'`),
  `packages/core/src/notices.ts` (`SANCTION_NOTICE_KINDS` unchanged; `record` keeps sanction kinds only; message-kind notices are created
  through a new `createMessage(subject, kind, opts): string`; `mustAcknowledge` false for the four; `purgeNotices` rule below),
  `packages/store-memory/src/memoryStore.ts` (purge), tests `packages/core/test/notices-kinds.test.ts` and the existing notices tests untouched.
- **Interfaces (Produces):** `NoticeService.createMessage(subject: SubjectId, kind: 'rename_required' | 'appeal_upheld' | 'appeal_reduced' | 'appeal_revoked', opts: { rule?: RuleRef | null; refCode?: string | null }): string` (the notice id; no excerpt, no name).
- **Behaviour:** a seen message notice is removed after `noticesMs` like a seen report outcome; an unseen `rename_required` is kept until seen
  or withdrawn. They appear in `pending` and `announce`, never in `record` ("My record").
- **Tests (names):**
  - `createMessage writes a notice of each of the four kinds with an empty excerpt and no name`; `an unknown kind throws`
  - `pending lists a message notice; record never does`; `ack works; mustAcknowledge is false for all four`
  - `purge: a seen message notice goes after noticesMs; an unseen rename_required is kept past noticesMs; an unseen appeal outcome is removed on the report-outcome rule` (decide and pin)
  - `withdrawGroup and noticeIdForGroup ignore message notices`; `a notice of an unknown kind read from a store is skipped, not thrown` (older-tooling safety)
  - `the old kinds behave exactly as before` (existing suite green)
- **Run:** `npx vitest run packages/core/test/notices-kinds.test.ts packages/core/test/notices.test.ts packages/store-memory/test/notices.store.test.ts`

### Task 3: Vocabulary: audit actions, target type, events, permissions
Spec 4.5, 4.11, 5.4, 6.1.
- **Files:** `packages/core/src/audit.ts` (`AUDIT_ACTIONS` appends `'appeal.view'`, `'appeal.decide'`, `'name.rename_required'`;
  `AUDIT_TARGET_TYPES` appends `'appeal'`; `person` target for the rename), `packages/core/src/events.ts` (`KitEvent` and `KIT_EVENT_TYPES`
  append `appeal.created`, `appeal.decided`, `rename.required` with the exact shapes of spec 4.11 and 5.4), `packages/http/src/permissions.ts`
  (`PERMISSION_KEYS` and `PERMISSIONS` append `appeals.read: 'moderator'`, `appeals.decide: 'senior'`), `packages/hub-react/src/types.ts`
  (`PermissionKey`), `packages/hub-react/src/auditLabel.ts` (three labels), any store check of the audit action list and target types
  (SQLite `CHECK` or the contract suite), tests `packages/core/test/vocabulary-appeals.test.ts` and additions to the audit, events,
  permissions and `auditLabel` tests.
- **Tests (names):**
  - `the three actions are last in AUDIT_ACTIONS and the order-lock test allows the append`; `appeal.* needs an appeal target and name.rename_required a person target`; `no detail is allowed on appeal.view`
  - `AUDIT_TARGET_TYPES ends with appeal; old rows still list`
  - `KIT_EVENT_TYPES ends with the three new types; cw.on accepts them; an unknown type still throws`; `the new event shapes hold no statement, reason or handle` (type-level `expectTypeOf`)
  - `appeals.read defaults to moderator and appeals.decide to senior; the permissions option lowers either; an unknown key is still refused`
  - `GET /me can[] has both keys`; `the hub labels the three actions`; `the hub PermissionKey list matches the http list` (existing mirror test)
- **Run:** `npx vitest run packages/core/test/vocabulary-appeals.test.ts packages/core/test/audit.test.ts packages/core/test/events.test.ts packages/http/test/permissions.test.ts packages/hub-react/test/audit-label.test.ts`

### Task 4: Store interface, memory store, contract suites
Spec 4.7. Store methods are synchronous. The SQLite side is Task 7.
- **Files:** `packages/core/src/types.ts` (`AppealRow` as spec 4.7; `BlockedNameRow { id; subject: SubjectId | null; name; termId: string | null; reason: NameReason; at }`;
  optional `Store` methods exactly as spec 4.7, plus `statement` clearing through `decideAppeal`'s patch field `clearStatement?: boolean`; `SanctionRow.reportId: string | null`),
  `packages/store-memory/src/memoryStore.ts`, `test/contract/appeals.contract.ts` and `names.contract.ts` (registered in `test/contract/index.ts`),
  tests `packages/store-memory/test/appeals.store.test.ts`.
- **Behaviour:** `insertAppeal` false when the group already has one. `decideAppeal` moves only from `open`. `countSanctionsByRule`
  counts distinct subject sanction groups of kind warning, chat, area or ban, **excluding a group that is some appeal's
  `replacementGroupId`** (a reduction is one sanction, not two; see the hand-back); `appealCountsByRule` counts, by the sanction's rule, appealed,
  granted (**revoked only**) and lightened (reduced; owner ruling: a reduction is not a false positive, so it never counts as granted). `purgeAppeals(before)` deletes decided rows with `decided_at < before` **except a row whose
  sanction group is permanent and unrevoked** (otherwise the player could appeal a live permanent ban a second time). Every insert, decide and
  moot bumps `changeToken()`.
- **Tests (names):**
  - `insertAppeal is exclusive per group and returns false for a second`; `loadAppeal, listAppeals by status (open, decided, all), oldest first, cursor by (createdAt, id), limit`
  - `countAppealsBy counts across a person's aliases in the window and returns the oldest time; none gives { count: 0, oldestAt: null }`; `countOpenAppeals`
  - `decideAppeal from open succeeds once; from a decided or moot appeal returns false and changes nothing; clearStatement nulls the text`
  - `closeAppealsForGroup moves open to moot and returns the count; decided appeals are untouched`
  - `counts by rule: replacement groups are not double counted; notes and IP rows are not counted; uncovered and null rules group together; since is inclusive`
  - `clearAppealStatements nulls decided_at < before and keeps the row; an open appeal's statement survives`; `purgeAppeals strict edge; keeps a decided row for a permanent unrevoked sanction, deletes it once revoked`
  - `loadSanctionSubjectRow returns kind, actor, source, automated, start, end, rule, room, reportId, and null for an unknown group or an IP-only group`
  - `blocked names: insert, list since with limit newest first, purge strict edge, a null subject is allowed`
  - `every write moves changeToken`
- **Run:** `npx vitest run packages/store-memory/test/appeals.store.test.ts packages/store-memory/test/contract.test.ts`

### Task 5: Retention
Spec 6.3. Needs Tasks 1, 2 and 4.
- **Files:** `packages/core/src/retention.ts` (`appealStatementsMs` 90 days, `appealsMs` 365 days with a 90-day floor, `blockedNamesMs` 30 days in
  `RetentionPolicy`, `RETENTION_DEFAULTS`, `FIELDS`, `checkRetentionFloors`; `PurgeResult` gains `appeals`, `appealStatements`, `blockedNames`;
  `purge()` calls `clearAppealStatements`, `purgeAppeals`, `purgeBlockedNames` in its transaction, 0 for a store without them),
  `packages/core/test/retention.test.ts` additions.
- **Tests (names):**
  - `defaults are 90, 365 and 30 days`; `appealsMs below 90 days is refused naming retention.appealsMs; 90 days accepted`; `appealStatementsMs 0 and blockedNamesMs 0 accepted; NaN and Infinity refused`
  - `purge reports appeals, appealStatements and blockedNames; strict cutoffs: a row exactly on the line is kept`
  - `an open appeal's statement survives any purge; a decided one is nulled after appealStatementsMs and the row stays until appealsMs`
  - `a permanent unrevoked sanction's decided appeal survives appealsMs` (Review Focus 3); `a store without the methods purges the rest`
- **Run:** `npx vitest run packages/core/test/retention.test.ts`

### Task 6: Sanction plumbing: `reportId`, `startsAt`, the moot hook
Spec 4.3 (start time), 4.7 (`report_id`). Needs Task 4. Internal API only.
- **Files:** `packages/core/src/sanctions.ts` (`SanctionInput.startsAt?: number` marked `@internal`, accepted only when the caller passes the
  appeals token below; `SanctionInput.reportId?: string`; `writeSanction` stores both; `revokeSanction` calls
  `store.closeAppealsForGroup(groupId, actor, now)` inside its transaction when the store has it), `packages/core/src/decide.ts` (passes the
  decided report's id), `packages/store-memory/src/memoryStore.ts` (keeps `reportId`), tests `packages/core/test/sanction-plumbing.test.ts`.
- **Interfaces (Produces):** `SanctionRow.reportId` set by `decide`; `startsAt` accepted from the appeals service only (an internal symbol
  or flag, never an exported public input; a public caller passing `startsAt` is refused with `RangeError`).
- **Tests (names):**
  - `a moderator decision stores the decided report's id on every subject row of its group; an automatic or direct sanction stores null`
  - `startsAt from the appeals service sets the row's start; from a public call it is refused`; `a replacement's ladder step is computed from startsAt`
  - `revoking a group closes its open appeal as moot in the same transaction; a failed revoke leaves it open; an already decided appeal is untouched; no appeal means no extra write`
  - `existing sanction, revoke and decide tests unchanged` (existing suite green)
- **Run:** `npx vitest run packages/core/test/sanction-plumbing.test.ts packages/core/test/sanctions.test.ts packages/core/test/decide.test.ts`

### Task 7: SQLite migration 22 and the SQLite store (after 0.1.6 and 0.1.7)
Spec 4.7. Read first: `packages/store-sqlite/src/migrations.ts` (migrations 7, 11 and 17 for the rebuild and backfill style; 20 for
`kit_ai_outcomes`; 21), and the **current** `kit_notices` DDL and indexes (spec lists nine columns and three indexes; rebuild from the
live schema, not from the spec's copy). SQLite is the reference; when the suites disagree the memory store is wrong.
- **Files:** `packages/store-sqlite/src/migrations.ts` (version 22: the DDL of spec 4.7 verbatim, with comments in the existing style),
  `sqliteStore.ts` (prepared statements; `insertAppeal` is one `INSERT ... ON CONFLICT DO NOTHING`; `decideAppeal` one conditional
  `UPDATE ... WHERE status = 'open'`; `report_id` mapped on `SanctionRow`; the corrective column is wired in Task 11), tests
  `packages/store-sqlite/test/appeals.store.test.ts`, `appeals.migration.test.ts`; the contract suites run through `contract.test.ts`;
  `differential.test.ts` gains the methods.
- **Tests (names):**
  - `migration 22 from a version-21 database with notices of every old kind keeps each row with the same id, order and indexes; the new CHECK accepts the four kinds and refuses a fifth`
  - `the backfill links a moderator sanction to its decided report, leaves unmatched and automatic rows NULL, and is idempotent`
  - `from an empty database creates kit_appeals with four indexes and kit_blocked_names; with the AI tables adds kit_ai_outcomes.corrective defaulting to 0; a rerun is refused`
  - `rows already in kit_ai_outcomes stay readable`; `kit_appeals CHECKs refuse an unknown kind or status`
  - `EXPLAIN QUERY PLAN: open count and list use kit_appeals_by_status; countAppealsBy uses kit_appeals_by_subject; appealCountsByRule uses kit_appeals_by_rule; purgeBlockedNames uses kit_blocked_names_by_at`
  - `two connections insert an appeal for one group: exactly one wins; two decide one appeal: exactly one wins`
  - `the shared contract suites pass`; `memory and sqlite give the same answers on the differential script`
- **Run:** `npx vitest run packages/store-sqlite/test/appeals.store.test.ts packages/store-sqlite/test/appeals.migration.test.ts packages/store-sqlite/test/contract.test.ts`

### Task 8: Filing, the player side of `cw.appeals`
Spec 4.2. Needs Tasks 1, 2 and 4.
- **Files:** `packages/core/src/appealService.ts` (new), `appeals.ts` (types of spec 4.2, `normalizeStatement`), `chatwarden.ts`
  (`cw.appeals = { enabled, file, mine }`; `createChatwarden` throws a plain message when `profile.appeals.enabled` is true and the store
  lacks the methods; `enabled()` is false otherwise), `index.ts`, tests `packages/core/test/appeals-file.test.ts`.
- **Behaviour:** order of checks `off`, `not_found`, `not_appealable`, `statement_invalid`, `already_appealed`, `rate`; one store
  transaction; a refusal writes nothing. The caller is found (never created) from `RawWho`; the notice must belong to the caller's person
  across aliases. Appealable: a sanction-kind notice not withdrawn and inside the "My record" rule of `NoticeService.record`. The row copies
  the group's `rule`, `kind` and `reportId`. `normalizeStatement` trims, strips control, bidi and zero-width characters, collapses blank-line
  runs, then counts code points (refused, not cut, above 1000). A store failure is logged `chatwarden.appeal_failed` by class and answers
  `not_found`. The filed event `appeal.created` and a `changeToken` bump happen after the commit. `mine` omits `moot` appeals (a plan
  ruling: the player's notice was withdrawn, there is nothing to show), newest first, at most 50.
- **Tests (names):**
  - `happy path for warning, chat, area and ban`; `refusals in order: off, then not_found, then not_appealable, then statement_invalid, then already_appealed, then rate`
  - `another player's notice, an unknown id and a malformed id are all not_found with no difference in shape or time`; `a report_outcome, rename_required, appeal outcome and a withdrawn notice are not_appealable`
  - `statements: empty, whitespace-only, control-only and blank-lines-only are statement_invalid; 1000 code points accepted and 1001 refused; 1000 emoji accepted (code points, not UTF-16 units); a lone surrogate and NUL are stripped or refused without throwing` (Review Focus 1)
  - `bidi, zero-width and control characters are stripped; runs of blank lines collapse to one; the stored text is the normalized text`
  - `already_appealed on a second file for one sanction, after the first was decided, and from a merged alias`
  - `rate: the exact retryAfterMs at perPlayerPerWeek; accepted again once the oldest leaves the window; counted across aliases; a refusal writes no row`
  - `a reduced sanction's replacement can be appealed once; expired sanctions: a warning at 89 days appealable and at 91 not, a timed sanction ended 10 days ago appealable, a permanent ban appealable until revoked`
  - `two simultaneous files on one database leave one row; the loser is already_appealed`
  - `a spy logger sees event names and error classes only; the statement is absent from events, notices, audit rows and logs`; `appeal.created is emitted after commit once, with ids, codes and times only`
  - `a store failure answers not_found and logs by class`; `off: file and mine answer off or [] and write nothing; createChatwarden throws when enabled on a store without the methods`
- **Run:** `npx vitest run packages/core/test/appeals-file.test.ts packages/core/test/appeals-settings.test.ts`

### Task 9: Deciding: uphold, reduce, revoke
Spec 4.3, 4.5. Needs Tasks 6 and 8. The heart of Part A.
- **Files:** `packages/core/src/appealService.ts` (`decide`), `appeals.ts` (`APPEAL_OUTCOMES`, `AppealDecision`, `AppealDecideResult`, `SANCTION_KIND_ORDER`
  = warning, chat, area, ban), `chatwarden.ts` (`cw.appeals.decide`), tests `packages/core/test/appeals-decide.test.ts`.
- **Behaviour:** one transaction as spec 4.3, in order: conditional open to decided (zero rows is `already_decided`), independence, lighter
  check, revoke, replacement, notices. `reduce.to` is lighter when its kind is lower in `SANCTION_KIND_ORDER`, or the same kind and shorter
  (permanent longest); `warning` cannot be reduced; `to` with another outcome, a missing or over-500 reason, or an unknown outcome is
  `invalid`. **The replacement keeps the original start, rule and room and ends at `min(original end, start + to.durationMs)`**; when that
  is already in the past it is written already ended and still records the lighter kind. `includeIp` is false on the replacement. The
  replacement's actor is the deciding actor. `same_decider` when `actor` equals the group's subject-row actor, the row is not automated and
  `allowSelfReview` is off. `gone` when the sanction was already revoked. After the commit and each fenced: announce the player's notices,
  update the in-memory sanction index, `changeToken`, emit `appeal.decided` (not for `moot`), audit nothing here (the route audits). With
  `appealStatementsMs` 0 the statement is cleared in the decide transaction. The outcome notice carries the original rule and ref code and
  nothing else. The AI seam is Task 11; here the call goes through an optional `onGranted(appeal)` dep that is a no-op.
- **Tests (names):**
  - `uphold: status, an appeal_upheld notice, the sanction untouched`; `revoke: group revoked, original notice withdrawn, appeal_revoked notice, index updated so chat is accepted again at once`
  - `reduce: replacement has the original start, rule and room; a lighter kind accepted; the same kind and shorter accepted; equal, longer, heavier, note, and permanent-to-permanent refused invalid; permanent-to-24-hours accepted; reduce from a warning refused`
  - `reduce of a 7-day ban given 6 days ago to 24 hours writes a replacement ending at the original end or earlier, already ended when the new length has passed, never later than the original` (Review Focus 2)
  - `the ladder step after a reduce-to-warning is computed from the original start`; `the replacement's own notice and the outcome notice are both created and announced after commit`
  - `atomicity: a throwing store at each step leaves the appeal open, the sanction untouched and no notice`; `a second decide is already_decided; two concurrent decides leave one outcome`
  - `independence: the original actor gets same_decider; another actor passes; an automated sanction has no decider; allowSelfReview on passes; a webhook actor and a human differ; a direct cw.appeals.decide is refused too`
  - `gone: deciding after the sanction was revoked answers gone and the appeal is moot` (Review Focus 3); `an appeal open while retention removes its sanction can still be decided without throwing (gone)`
  - `moot: revoking elsewhere closes the appeal with no outcome notice, no appeal.decided event and no granted count`
  - `events: appeal.decided once, after commit, never on a refusal; no statement or reason in it`; `a failing listener or announce cannot fail the decision`
  - `a reduce and a revoke both call the AI seam, and a reduce is reported as lightened, never granted`; `appealStatementsMs 0 clears the statement in the decision`; `reason is required and private: it never appears in a player-facing value`
- **Run:** `npx vitest run packages/core/test/appeals-decide.test.ts packages/core/test/appeals-file.test.ts packages/core/test/sanction-plumbing.test.ts`

### Task 10: Staff reads and the false-positive stats
Spec 4.4 (rate), 4.6. Needs Task 9.
- **Files:** `packages/core/src/appealService.ts` (`list`, `get`, `openCount`, `stats`), `appeals.ts` (types, `APPEAL_STATS_MIN_SANCTIONS = 10`,
  `APPEAL_RATE_ELEVATED = 0.15`, `APPEAL_RATE_HIGH = 0.30`), `chatwarden.ts`, tests `packages/core/test/appeals-stats.test.ts`, `appeals-staff.test.ts`.
- **Behaviour:** `statementFlagged = matcher.match(statement) !== null` computed on read; a throwing matcher reads false, logged by class.
  `shown` is the notice excerpt's lines as kept. `get` returns the detail with `statement` null once purged. `list` defaults to open,
  oldest first, limit 1 to 200, opaque cursor. `stats` windows 30, 90 (default) or 365 days; `rate = granted / sanctions` where granted is **revoked only** (`AppealRuleStats` and `overall` gain `lightened`: reduced on appeal, shown beside the rate and never in it), null below 10
  sanctions; band `high` at or above 0.30, `elevated` at or above 0.15, else `normal`, null when rate is null; rules by number, `uncovered`
  last; `overall` sums.
- **Tests (names):**
  - `sanctions counted per rule (notes excluded, a reduction counted once); appealed; granted counts revoked only; lightened counts reduced only; upheld and moot count in neither; a reduce never moves the rate or its band`
  - `rate is null at 9 sanctions and exact at 10; bands at the exact edges 0.15 and 0.30; uncovered sorts last; window edges strict; an empty store gives zeros and null`
  - `list: open default oldest first, decided, all; cursor round trip; limit bounds; a bad cursor throws RangeError`
  - `get: statementFlagged reflects the matcher now (a term added tomorrow masks yesterday's text); a throwing matcher reads false; a purged statement is null; decided shows by, at, reason and replacementGroupId; unknown id is null`
  - `openCount tracks file, decide and moot`; `summary carries the staff ref of the person and decidedBy, never a handle`
  - `with appeals off every read is empty or null and touches no store method`
- **Run:** `npx vitest run packages/core/test/appeals-stats.test.ts packages/core/test/appeals-staff.test.ts`

### Task 11: What a granted appeal feeds the AI (after 0.1.6)
Spec 4.4. Read first, in the `ai-levels` merge: `packages/core/src/ai/types.ts` (`AIExample`, `AIReadInput`, `AI_PROMPT_VERSION`), `prompt.ts`
(`buildAIInput`, the stable text), `hash.ts` (`inputHash`), `casebook.ts` and `service.ts` (`markReversed`, `examplesFor`, the 30-row
threshold), `core/src/types.ts` (`AiOutcomeRow`, `markAiOutcome`, `aiExamples`, `aiTeachableCount`, `aiStats`), `store-memory/src/memoryStore.ts`
and `store-sqlite/src/sqliteStore.ts` (the same methods), and the 0.1.7 amendment to `prompt.ts` (the signals block). Needs Tasks 9, 10.
- **Files:** `core/src/ai/types.ts` (`AIExample.kind: 'standard' | 'corrective'`; `AIReadInput.cautions?: Array<{ rule: number; band: 'elevated' | 'high' }>`;
  `AI_PROMPT_VERSION` bumped by one), `prompt.ts` (one always-present stable paragraph about cautioned rules; the corrective example's fixed
  wording; `cautions` rendered in the variable part), `hash.ts` (the hash excludes `cautions`), `service.ts` (`markReversed(reportId, opts?: { corrective?: boolean })`,
  exposed on `cw.ai` if it is not already), `core/src/types.ts` and both stores (`markAiOutcome` patch gains `corrective?: true`;
  `AiOutcomeRow.corrective`; `aiExamples` returns a corrective row when it still has `example_json`, at most one per call and only once
  `aiTeachableCount` is met, without counting toward it), `appealService.ts` (`onGranted` calls `cw.ai.markReversed` for reduce and revoke,
  `{ corrective: true }` for **revoke only**; the false-positive rate behind `cautions` counts revokes only, reduces are "lightened"), the worker (fills `cautions` from `appeals.stats()` at the 90-day
  window), tests `packages/core/test/ai/appeals-feed.test.ts` and additions to `core/test/contract/ai.contract.ts`.
- **Behaviour:** no AI means every call is a no-op and nothing fails. A missing `reportId` (an old sanction) is skipped. A corrective
  example's lines are the pseudonymised lines already stored; the statement is never an input. Reduce marks the original decision reversed (kept out of
  the casebook as a positive example) and teaches nothing; it is not counted in the false-positive rate (owner ruling; the casebook labels
  cannot say "too heavy"). Only revoke adds the corrective example and counts toward the rate.
- **Tests (names):**
  - `revoke calls markReversed with corrective; reduce calls it without corrective and adds no example; uphold and moot do not call it`; `a missing report id is skipped; with no AI nothing fails`
  - `a reversed row is excluded from standard examples; a revoked-on-appeal row counts as an AI false positive in aiStats and a reduced one does not`
  - `a corrective row is used at most once per read, only past 30 teachable rows, never counted toward them, with no example text teaches nothing but a revoke still counts in the rate`
  - `AIExample.kind reaches the prompt with the fixed wording; a standard example is unchanged`
  - `cautions is driven by the revoke-only rate (a rule with many reduces and no revokes is not cautioned); it lists only rules at elevated and high, carries bands and rule numbers only, no number, no person; an empty list renders nothing`
  - `the input hash is unchanged by cautions; Read again takes a fresh copy; the stable paragraph is present with and without cautions so the cache prefix is stable`
  - `the statement is absent from every AI input` (scan the rendered prompt); `prompt.stable stays under the 9 000 character guard under each preset`
  - `the ceilings are untouched` (the 0.1.6 ceilings suite stays green)
  - store: `corrective defaults to 0; markAiOutcome with corrective persists; both stores agree on the contract suite`
- **Run:** `npx vitest run packages/core/test/ai/appeals-feed.test.ts packages/core/test/ai/prompt.test.ts packages/core/test/ai/hash.test.ts packages/core/test/ai/casebook.test.ts packages/store-memory/test/ai.store.test.ts packages/store-sqlite/test/ai.store.test.ts`

### Task 12: The name check, extended
Spec 5.1, 5.2. Needs Tasks 1, 3, 4.
- **Files:** `packages/core/src/names.ts` (`NameReason`, `NameCheckResult`, the hourly evidence caps), `packages/core/src/chatwarden.ts`
  (`names.check(text, opts?: { who?: RawWho })` extended compatibly; new `names.flagged(text: string): boolean`, matcher only, never stores,
  never throws; evidence writes via `insertBlockedName`), `index.ts`, tests `packages/core/test/names-check.test.ts`.
- **Behaviour:** unchanged contract with `names.profanity` off: same answer, same `rule`, fails open when the matcher throws, `TypeError`
  for a non-string. With it on, the profanity filter runs on the name and on the name with underscores and digits turned into spaces; a
  matcher hit wins over a profane hit; a throwing filter lets the name through (`chatwarden.names_filter_failed`). `name_profane` carries
  the same `rule` (the slur filter's `autoRestrictRule`) as the type requires. Evidence only when blocked and `keepBlocked`: at most 5 an
  hour per person (per `who`, or per name hash when there is none) and 200 an hour overall, in memory. `who` never changes the answer; the
  person is found, never created. `flagged` is the evidence-free read the staff routes use.
- **Tests (names):**
  - `unchanged: an allowed name; a name blocked by the matcher (Zorbak_99-style variants of the synthetic terms); no matcher; a throwing matcher lets it through; a non-string throws TypeError; the answer holds no name`
  - `profanity off by default; on: a profane name is name_profane, a clean one allowed, underscores and digits split, a throwing filter lets the name through, the matcher hit wins when both fire`
  - `nothing is stored by default (spy store)`; `blocked and keepBlocked stores one row with the name, term id, reason and the person when who finds one, null subject otherwise; an allowed name is never stored`
  - `the hourly caps hold at 5 per person and 200 overall, the check still answers past them, and the window resets with the clock`
  - `who never changes the answer; an unknown who creates no subject; a store failure is absorbed and logged by class only`
  - `flagged never writes, whatever keepBlocked says, and is false when the matcher throws` (Review Focus 5)
  - `no log line contains a name`
- **Run:** `npx vitest run packages/core/test/names-check.test.ts packages/core/test/names.test.ts`

### Task 13: Requiring a rename, and `people.accountIds`
Spec 5.3, 5.4. Needs Tasks 2, 3, 12.
- **Files:** `packages/core/src/chatwarden.ts` (`names.requireRename`, `pendingRename`, `renamed`; `people.accountIds(subject): string[]`),
  `packages/core/src/names.ts`, tests `packages/core/test/names-rename.test.ts`.
- **Interfaces (Produces):** exactly the signatures of spec 5.3 and `people.accountIds(subject: SubjectId): string[]` (sorted, folded across
  merged aliases from `SubjectIndex.identifiersOf`, `[]` for a guest, documented "server side only: never send to a player").
- **Behaviour:** `requireRename` is `off` while `names.renames` is false, `invalid` for a bad reason (1 to 500 characters) or rule, `not_found`
  for an unknown person, `pending` while an unreleased request exists; otherwise one `rename_required` notice (via `createMessage`, rule
  defaults to `autoRestrictRule`, no name, no excerpt), an announce and `rename.required` after commit. `pendingRename(who)` finds the
  person and is true until `renamed(who)` or withdrawal; `renamed` withdraws pending rename notices and returns whether it did.
- **Tests (names):**
  - `off, not_found, pending, invalid (empty reason, 501 characters, a non-integer rule), success: each result; one notice of kind rename_required with no excerpt and no name`
  - `rename.required after the commit once, carrying a staff ref, a time and a rule, no account id`
  - `pendingRename is true until renamed or the notice is withdrawn; renamed returns false when nothing was pending; an unknown who is false and creates no subject`
  - `the notice is not on My record, not appealable, not mustAcknowledge; a second request after renamed is allowed`
  - `people.accountIds folds aliases, sorts, is empty for a guest, and returns only the strings the game passed as accountId`
- **Run:** `npx vitest run packages/core/test/names-rename.test.ts packages/core/test/notices-kinds.test.ts`

### Task 14: HTTP, player routes
Spec 4.8 (player table). Needs Task 8.
- **Files:** `packages/http/src/player.ts` (`GET /appeals`, `POST /appeals`; `appealsRateLimit` option, default 10 per hour per identity, salted
  hash, the file's `Limiter`; `POST /names/check` passes `who` and returns the new reason), `packages/http/src/index.ts` (option type), route
  doc comment, tests `packages/http/test/player.appeals.test.ts`, `player.names.test.ts`, the existing `no-leak` suite.
- **Behaviour:** 404 `not_found` everywhere when appeals are off; `POST` answers 200 `{ appeal }`, 400 `invalid_statement`, 404 `not_found` (off,
  not yours, not appealable: one answer), 409 `already_appealed`, 429 `rate_limited` with `retry-after` in whole seconds (at least 1); malformed
  bodies count against the limiter; an unknown or IP-only identity gets `[]` on `GET`.
- **Tests (names):**
  - `GET returns only documented fields (id, noticeId, status, createdAt, decidedAt); empty for an unknown identity; 404 when off`
  - `POST: 200, 400, 404 for off, someone else's notice and a bad id with identical bodies, 409, 429 with retry-after`
  - `the request limiter: the 11th request in an hour is 429 even for malformed bodies; salted-hash keys; the key map is bounded`
  - `the response never holds a staff ref, reason, sanction id or person id` (no-leak); `names/check unchanged for a caller with the options off and returns name_profane with profanity on`
  - `retry-after rounds up`; `every response is no-store JSON`
- **Run:** `npx vitest run packages/http/test/player.appeals.test.ts packages/http/test/player.names.test.ts packages/http/test/no-leak.test.ts`

### Task 15: HTTP, staff appeals routes and existing bodies
Spec 4.8 (staff table, `/me`, `/changes`, history). Needs Tasks 3, 10.
- **Files:** `packages/http/src/admin/appeals.ts` (new `appealRoutes(ctx)`, static paths before `/appeals/:id`; registered in `admin/index.ts`),
  `validate.ts`, `me.ts` (`features: { appeals; renames }` only when either is on), the `GET /changes` handler (`appeals: number` only when
  on and the caller can read), `reports.ts` (`GET /people/:ref/history` gains `appeals` and `renames` only when features are on or there are
  any), route doc comments, tests `packages/http/test/admin.appeals.test.ts`, `admin.bodies-appeals-off.test.ts`, `admin.every-route.test.ts`.
- **Routes:** as the spec table: list/stats/detail need `appeals.read` and audit `appeal.view` (list and stats with no target, detail with the
  appeal as target, required); `POST /appeals/:id/decide` needs `appeals.decide`, audits `appeal.decide` best-effort after the write, maps
  `already_decided`, `same_decider`, `gone` to 409 with their codes, `invalid` to 400, and for `reduce` checks `to` against the profile's
  offered durations (`checkDurationsOffered`).
- **Tests (names):**
  - `permission boundaries at moderator, senior and owner for every route; appeals.decide lowered by the permissions option works`
  - `audit rows and modes: list, stats and detail required; decide best-effort; an audit failure on a required read fails the read`
  - `400 invalid_query for a bad status, cursor, limit and days; /appeals/stats is not captured by /appeals/:id; 404 for an unknown id`
  - `decide: 200 with replacementGroupId for reduce; 409 already_decided, same_decider, gone; 400 invalid for a to that is not lighter or not offered; the body never echoes the reason`
  - `appeals off: 404 on every route and GET /me, GET /changes, GET /people/:ref/history are byte-identical to 0.1.7` (snapshot)
  - `GET /me has features only when on; GET /changes has appeals only for a caller with appeals.read`
  - `history carries appeals and renames entries with dates and outcomes and no statement text`
  - `every route is no-store JSON; the every-route test lists the new routes`
- **Run:** `npx vitest run packages/http/test/admin.appeals.test.ts packages/http/test/admin.bodies-appeals-off.test.ts packages/http/test/admin.every-route.test.ts packages/http/test/permissions.test.ts`

### Task 16: HTTP, rename route, blocked names, flagged handles
Spec 4.8 (last rows), 5.5 (server). Needs Tasks 12, 13, 15.
- **Files:** `packages/http/src/admin/sanctions.ts` or a new `names.ts` (`POST /people/:ref/rename`), `blocked.ts` (`GET /blocked?source=name`),
  and the handlers of `GET /reports`, `GET /reports/:id`, `GET /people/:ref/history`, `GET /sanctions`, `GET /blocked`, `GET /appeals`
  (`handleFlagged?: boolean` beside each handle, true only when flagged and `names.maskInHub`, from `cw.names.flagged`), tests
  `packages/http/test/admin.names.test.ts`, `admin.flagged.test.ts`.
- **Tests (names):**
  - `POST /people/:ref/rename needs sanctions.apply, honours the claim gate (gateCase) and takeOver, audits name.rename_required best-effort, 404 when renames are off, 409 pending_rename, 400 for a bad reason`
  - `GET /blocked?source=name lists kept names with text as the name, needs blocked.read, audits blocked.view; the default source is unchanged; 404 or empty when keepBlocked is off`
  - `handleFlagged appears only when flagged and only with maskInHub; unflagged bodies are byte-identical to 0.1.7; a matcher failure reads as not flagged; listing 100 handles stores no evidence even with keepBlocked on` (Review Focus 5)
  - `no handle or name is logged`
- **Run:** `npx vitest run packages/http/test/admin.names.test.ts packages/http/test/admin.flagged.test.ts packages/http/test/admin.blocked.test.ts`

### Task 17: Webhooks and the Discord feed
Spec 4.11, 5.4. Needs Tasks 3, 9, 13.
- **Files:** `packages/http/src/webhooks/*` (`WebhookEndpoint.includeAccounts?: boolean`; `webhooksOut` takes `Pick<Chatwarden, 'on' | 'reports' | 'people'>`;
  the two appeal events and `rename.required` accepted in `events`; a `rename.required` delivery's `data.accounts` only with the flag),
  `packages/discord/src/feed.ts` (`onAppealCreated`, `onAppealDecided` posts to the person's thread through `hubLink('person', ref)`; `severeOnly`
  keeps only appeals on severe rules; `rename.required` ignored), tests `packages/http/test/webhooks.appeals.test.ts`, `packages/discord/test/feed.appeals.test.ts`.
- **Tests (names):**
  - `webhooksOut accepts the three types, signs them, and never adds a statement, reason or handle; includeAccounts is false by default, adds accounts only to rename.required, never to another type`
  - `an unknown event type in events is still refused`; `accounts are fetched when the event is raised, not cached`
  - `Discord posts "Appeal filed against a 24-hour chat restriction, Rule 2. Open in the hub." and "Appeal decided: lighter." style messages with no statement, handle or reason; severeOnly filters; the message fits the post limit; rename.required is ignored`
  - `a moot closure posts nothing`
- **Run:** `npx vitest run packages/http/test/webhooks.appeals.test.ts packages/discord/test/feed.appeals.test.ts`

### Task 18: player-react: appeals, outcome notices, name words
Spec 4.10, 5.7. Wire shapes only; can start early.
- **Files:** `packages/player-react/src/client.ts` (`appeals()`, `fileAppeal(noticeId, statement): Promise<FileAppealOutcome>` mapped from status codes; only
  documented fields kept), `AppealDialog.tsx` (new, exported `@experimental`, lazy if the budget needs it, built on `Dialog`, `Portal` and theming),
  `NoticeQueue.tsx`, `MyRecord.tsx`, `ui.tsx` (`titleKey`/`bodyKey` for the four kinds with a generic fallback, `isSanction` false for them),
  `i18n.ts` (every key of the spec's two word tables), `names.ts` (`nameReasonText(t, reason)`), README, tests `appeal-dialog.test.tsx`,
  `appeal-notices.test.tsx`, `name-text.test.ts`, `static.test.ts` export lock, `size.test.ts`.
- **Tests (names):**
  - `without the appeals prop NoticeQueue and MyRecord render exactly the appealUrl link of 0.1.7; with it a button opens the dialog and appealUrl is unused`
  - `the dialog counts code points against 1000, disables Send when empty, shows each refusal in words, returns focus, closes on Escape, and sends the text as typed`
  - `after a sent appeal the button is replaced by "Appeal sent <date>" and then the outcome in words`
  - `the four new notice kinds render with their titles and one "Got it", no referee card and no appeal link; an unknown kind falls back to the generic title; rename_required shows`
  - `nameReasonText covers name_not_allowed and name_profane; a missing key falls back to English`
  - `no identifier appears in any answer (no-leak); static.test.ts lists the new exports; size.test.ts budget holds`
- **Run:** `npx vitest run packages/player-react/test/appeal-dialog.test.tsx packages/player-react/test/appeal-notices.test.tsx packages/player-react/test/name-text.test.ts packages/player-react/test/no-leak.test.tsx packages/player-react/test/static.test.ts packages/player-react/test/size.test.ts`

### Task 19: hub-react: wire types, client, and name masking
Spec 5.5 (hub). Needs Task 16.
- **Files:** `packages/hub-react/src/types.ts` (appeal types, `handleFlagged?` on every payload type that carries a handle, `features` on `/me`,
  `appeals` count on `/changes`), `client.ts` (`appeals`, `appeal`, `decideAppeal`, `appealStats`, `rename`), `labels.ts` (`displayName(t, { handle, flagged, revealed })`
  beside `groupName`), `ui.tsx` (`PersonChip`), `case/Transcript.tsx` and `case/CaseContext.tsx` (`useCase().shows(handleKey)` extends the existing reveal
  state), the command bar entries and `SimpleNav`, `i18n.ts`, tests `names-mask.test.tsx`, `display-name.test.ts`, `api.test.ts`/`apiNames.ts`, `size.test.ts`.
- **Tests (names):**
  - `displayName shows a flagged handle as the hide label with a Show control; unflagged unchanged; maskInHub off shows names as before`
  - `every surface that renders a handle goes through displayName` (a grep-style test over `src/` for raw `.handle` rendering, with an explicit allow-list)
  - `masked in: queue rows, the case card, the transcript speaker, the Person page, toasts, the command bar, SimpleNav, the document title, aria-labels and copy actions` (Review Focus 5)
  - `Show reveals one place; "show all" reveals every flagged name in the case; revealing does not persist across cases`
  - `an older server that sends no handleFlagged shows names as before`; `size.test.ts budget holds`; `the public API snapshot is updated deliberately`
- **Run:** `npx vitest run packages/hub-react/test/names-mask.test.tsx packages/hub-react/test/display-name.test.ts packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task 20: hub-react: the Appeals view, the appeal card, Person entries
Spec 4.9. Needs Tasks 15 and 19.
- **Files:** `packages/hub-react/src/liveQueue.tsx` and the queue filter row (the Reports | Appeals switch, rendered only with `features.appeals` and
  `appeals.read`; swaps the list source to `GET /appeals?status=open`), `case/AppealCard.tsx` and the decision form (lazy via `screens/lazy.tsx`),
  `simple.ts`/Simple Cases list (one quiet line "N appeals waiting" when on, readable and above zero), `screens/Person.tsx` (appeal timeline
  entries, no referee card), `i18n.ts` (`hub.appeals.*`, `hub.person.appeal.*`), tests `appeals-queue.test.tsx`, `appeal-card.test.tsx`,
  `a11y-appeals.test.tsx`, `person-appeals.test.tsx`.
- **Behaviour:** the card shows the referee card of the sanction, rule chip, date, in Detailed who gave it, the statement as plain text in
  its own block (masked with the existing Show control and "show all" when `statementFlagged`), `shown` lines, a record line (Simple) or the
  Person link (Detailed), and three controls (Keep the decision, Make it lighter..., Remove it) with a required private reason and the saved-reason
  chips. "Make it lighter..." offers kinds below the original and lengths from `profile.durations` below the original's; disabled for a
  warning. Refusals come back in words with the typed text kept. No Undo hold. Deciding returns to the Appeals list. No claim chrome.
- **Tests (names):**
  - `the switch is absent with appeals off or without appeals.read (DOM snapshot of the queue pane unchanged from 0.1.7); present with both`
  - `Simple's line renders only with the feature on, readable and the count above zero; Simple's menu is unchanged (snapshot)`
  - `the card renders a <script> statement and a markdown link literally; a flagged statement is masked and revealed per statement and for all` (Review Focus 1)
  - `the reason is required with the decision bar's length rules; Make it lighter is disabled for a warning and offers only lighter choices from the profile's durations`
  - `same_decider, already_decided and gone show in words and keep what was typed; a decided appeal returns to the list; no Undo hold; no claim chrome`
  - `the Person page shows "Appeal: reduced" style entries in the timeline and no new element elsewhere`
  - `the card and list are lazy: the main chunk gains no appeal-card code`; `axe: no violations, light and dark; 360 px no sideways scroll`; `size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/appeals-queue.test.tsx packages/hub-react/test/appeal-card.test.tsx packages/hub-react/test/a11y-appeals.test.tsx packages/hub-react/test/person-appeals.test.tsx packages/hub-react/test/size.test.ts`

### Task 21: hub-react: Settings, Advanced, "Appeals"
Spec 4.9 (Settings). Needs Tasks 1, 15, 19. Read first: the 0.1.7 `screens/AdvancedSettings.tsx` and `PaceSettings.tsx` (the panel pattern and the
`policy/` hooks).
- **Files:** `packages/hub-react/src/screens/AppealSettings.tsx` (lazy panel), `screens/lazy.tsx`, `policyHooks.ts` (`layer.appeals`), `i18n.ts`
  (`hub.settings.appeals.*`), tests `appeal-settings.test.tsx`, `a11y-settings.test.tsx`, `api.test.ts`, `lazy-screens.test.tsx`, `size.test.ts`.
- **Behaviour:** switch on or off; "how many a player may file a week" (1 to 20); "Allow the moderator who made the decision to decide it" (off);
  the read-only statement limit; a "Mistakes by rule" disclosure (collapsed) with the per-rule table from `GET /appeals/stats` (sanctions,
  appealed, revoked on appeal, "made lighter on appeal" beside it (never in the rate), band in words "usually fine", "often reversed", "frequently reversed", and "not enough decisions yet" for a null rate).
  Owner edits; seniors and moderators read. Saving needs a reason and handles 409 with a reload offer.
- **Tests (names):**
  - `defaults to off`; `only the owner can save; others see values read-only`; `the weekly limit validates 1 to 20`; `saving sends the whole layer with appeals merged and a reason`; `a 409 offers to reload; reset restores the base`
  - `Mistakes by rule is collapsed by default and shows the table with bands as words and no number outside the table`; `a null rate reads "not enough decisions yet"`; `the made-lighter column shows reduces and does not change the band`
  - `no colour class carries a band`; `the panel is lazy`; `axe: no violations; 360 px no sideways scroll`; `size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/appeal-settings.test.tsx packages/hub-react/test/a11y-settings.test.tsx packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task 22: hub-react: names (rename option, Settings panel, Blocked choice)
Spec 5.6. Needs Tasks 16 and 19.
- **Files:** `packages/hub-react/src/person/SanctionForm.tsx` (`KINDS` gains a last option "Ask for a new name (no sanction)", present only with
  `features.renames` and `sanctions.apply`; choosing it hides length and IP fields and submits `POST /people/:ref/rename`; same claim rules and
  toast), `screens/NameSettings.tsx` (lazy panel under Advanced: four switches with one sentence each), `screens/Blocked.tsx` (a "Names" choice in the
  existing filter row when `keepBlocked`), `screens/Person.tsx` ("Asked to choose a new name" timeline entry with its date and pending state),
  `i18n.ts` (`hub.settings.names.*`), tests `person-rename.test.tsx`, `name-settings.test.tsx`, `blocked-names.test.tsx`, `a11y-settings.test.tsx`.
- **Tests (names):**
  - `the rename option is absent with renames off or without sanctions.apply (the form is byte-identical to 0.1.7 then); present with both`
  - `choosing it hides length and IP, keeps rule and reason, and submits to the rename route; a pending_rename refusal shows in words; the claim gate and takeOver behave as for a sanction`
  - `the panel shows four switches, each saved through the layer with a reason; only the owner edits; keepBlocked states the retention in words`
  - `Blocked shows the Names choice only with keepBlocked; no menu entry is added; Simple gets nothing new from names`
  - `lazy: no names-panel code in the main chunk`; `axe, 360 px, size budget`
- **Run:** `npx vitest run packages/hub-react/test/person-rename.test.tsx packages/hub-react/test/name-settings.test.tsx packages/hub-react/test/blocked-names.test.tsx packages/hub-react/test/a11y-settings.test.tsx packages/hub-react/test/size.test.ts`

### Task 23: Docs, example, gates
- **Files:** READMEs of `core` (appeals, names, the events, retention, "one login per person" advice for `same_decider`), `http` (routes, `permissions`,
  `appealsRateLimit`, `includeAccounts`), `player-react` (the `appeals` prop, the dialog, words), `hub-react`, `discord` (the two posts); the
  `@experimental` list in each (spec 10); the README note that a game must act on `rename.required` and call `renamed`; `docs/status.md`,
  `docs/plans/follow-ups.md` (the spec 9 list); `examples/tiny-chat` (`CW_DEMO_APPEALS=1` turns on appeals and renames; test `examples/tiny-chat/appeals.test.ts`);
  `scripts/readme.test.ts` expectations; core export snapshot; the `AUDIT_ACTIONS` order test and `KIT_EVENT_TYPES` lock updated by append. No site change.
- **Tests (names):** `tiny-chat with CW_DEMO_APPEALS files an appeal against a demo sanction, a second moderator reduces it, and the player sees the outcome notice`; `without the variable none of it exists`; `the readme checks pass`; `the browser bundle budget holds`.
- **Run:** `npx vitest run examples/tiny-chat/appeals.test.ts scripts/readme.test.ts scripts/browser-bundle.test.ts`, then `npm run lint` and `npm run typecheck`.

### Task 24: Release prep 0.1.8
See the Release section. Changeset, `npm run version`, peer floors by hand, `scripts/manifests.test.ts`, `npm run check:pack` after deleting `dist`,
`node scripts/smoke.mjs`. Publishing is the maintainer's.
- **Tests (names):** `manifests: the published set is still the ten, none private`; `the new floors are the ones in NEEDS_NEW_KIT`; `publish-order is unchanged`; `smoke: the consumer projects still install and the ESM, CommonJS and no-React checks pass`.
- **Run:** `npx vitest run scripts/manifests.test.ts scripts/publish-order.test.ts scripts/release-workflow.test.ts scripts/changelog.test.ts scripts/sync-version.test.ts`

---

## Release

**What ships:** a patch, 0.1.8, of the ten packages in the fixed group. No new package.

### Before the tag (all in the branch)
1. `npx changeset`: patch for the group. **The first line says it adds notice kinds and a one-way migration**: an adopter whose `switch (notice.kind)`
   ends in `assertNever` will not compile until it handles the four new kinds, and a database that has run migration 22 cannot be opened by
   0.1.7 (the notices table is rebuilt; take a backup first, as for 19). Then plain sentences: appeals, the false-positive band, names,
   renames, masking (the one default-on display change, with the switch that turns it off), the new permissions and their defaults, the
   `@experimental` names, and that an older player-react shows the generic title for the new kinds.
2. `npm run version` (bumps the ten, runs `sync-version`, refreshes the lockfile).
3. **Raise the peer floors by hand** (RELEASING.md "When a peer floor must rise"), only where a package uses a name new in 0.1.8:
   `store-memory` and `store-sqlite` on `@chatwarden/core` `^0.1.8` (the new `Store` methods and row types); `http` on core `^0.1.8` (`cw.appeals`,
   `cw.names` additions, `cw.people.accountIds`, the new event types); `discord` on core `^0.1.8` (the two new events); `hub-react` on core and http
   `^0.1.8` (the new wire fields and routes); `player-react` keeps its floor unless it imports a new core name (it takes `AppealRefusal` as a local
   type; confirm with a grep). `core`, `matcher`, `profanity` keep theirs; `hub-element` follows `peerRangeOf`. Run `npm install --package-lock-only`, change
   `NEEDS_NEW_KIT` in `scripts/manifests.test.ts` in the same commit, and name each package and API in the changeset.
4. `npm run check:pack` after deleting `dist`, and `node scripts/smoke.mjs`.
5. A dry run: `gh workflow run release.yml -f dry_run=true --ref appeals-names`.
6. Merge when CI is green. **Tag and push only on the maintainer's go-ahead.** The release publishes the ten through OIDC with provenance.

### What the adopter does (not part of the tag)
Nothing is on by default. Appeals: set `appeals.enabled` in the profile or in Settings, Advanced, then pass `appeals` to `NoticeQueue` and `MyRecord`
(until then the old `appealUrl` link works); a team of one also sets `allowSelfReview` or lowers `appeals.decide` through `permissions`. Names: turn on
what is wanted in Settings, Advanced; a game that wants renames listens for `rename.required`, reads `cw.people.accountIds` (or enables `includeAccounts` on
a webhook), holds the player with `pendingRename`, and calls `renamed` afterwards.

### Site and announcement
No site change (spec 9). The public site flips a promise only after the release is on npm and has run in Moxgate.

---

## Spec coverage (self-review)
4.1 to Task 1; 4.2 to 8; 4.3 and 4.5 to 6 and 9; 4.4 to 10 and 11; 4.6 to 10; 4.7 to 2, 4, 6 and 7; 4.8 to 14, 15 and 16; 4.9 to 20 and 21; 4.10 to 18; 4.11 to 3, 9 and 17;
5.1 to 1; 5.2 to 12; 5.3 and 5.4 to 13 and 17; 5.5 to 16 and 19; 5.6 to 22; 5.7 to 18; 6.1 to 3; 6.2 to the Global Constraints and 8, 9, 12, 14; 6.3 to 5; 7 to the
per-task tests (Rulings 1 to 11 each owned: 1 Task 8 off-parity, 2 Task 8, 3 Tasks 1 and 8, 4 Task 20, 5 Task 9, 6 Tasks 9 and 15, 7 Task 3, 8 Tasks 10 and 11, 9 Task 12, 10 Task 13,
11 Task 19); 10 to Tasks 23 and 24. Names used across tasks (`AppealRow`, `BlockedNameRow`, `NameReason`, `SANCTION_KIND_ORDER`, `createMessage`, `flagged`, `onGranted`,
`handleFlagged`, `displayName`, `features`) are defined once in the owning task and consumed under the same spelling.
