# Chatwarden K2: Community Rules, Warning, ladder, decisions, player notices. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The domain layer for moderator decisions and player transparency:
- numbered Community Rules with a rule-gap loop
- a Warning action and an escalation-ladder suggestion
- one `decide` path that closes a report, sanctions, and notifies
- player notices with an own-lines excerpt, reporter feedback and a "My record" view
- refusals that cite the rule

All of it is in `@chatwarden/core` + `@chatwarden/store-sqlite`, wired into the facade and tiny-chat.

**Architecture:**
- Pure functions (rules registry, ladder) plus services over the existing `Store` seam (sync store methods inside `transaction`, R11/R24), following the K1 patterns.
- The HTTP admin and player APIs, the Discord feed and the AI read are K3, and the React UI is K4. This plan exposes everything they need as facade methods.

**Tech Stack:** as K1. TypeScript strict ESM, Node ≥ 22.13, `node:sqlite`, vitest, `obscenity` (matcher only).

**Spec:**
- `docs/design/2026-11-09-chatwarden-design.md` ("Additions from the industry survey" 1-6, "Roles", K2)
- `docs/design/2026-11-09-feature-contract-from-moxgate.md` parts B and C (Community Rules, Warning, ladder, notices) with the owner answers at its end.

**Builds on (as merged in `7221763`):**
- core: `SubjectIndex`, `RoomRoster`, `EvidenceBuffer`, `SanctionIndex` / `applySanction` / `revokeSanction`, `MuteService`, `StrikeService`, `ChatService`, `ReportService`, `DoorService`, `purge`, `createChatwarden`
- `packages/core/test/memoryStore.ts`, the journaled in-memory Store
- store-sqlite migrations 1-6

## Global Constraints

Everything in K1's Global Constraints still binds (`docs/plans/2026-11-09-k0-k1-foundation.md`). In particular:
- no real slur in the repo
- no identifier in a player-facing value or log
- IP never links or delivers a notice
- injected Clock
- core imports only `node:crypto`
- targeted local test runs only
- `git commit -s` with the Co-Authored-By trailer

Plus these:
- **Rule numbers are never reused or renumbered.** A retired rule stays in the registry with `retired: true`.
- **The moderator's free-text `reason` is never shown to the player.** Neither is the rule-gap note, the moderator's identity, the reporter's identity, another player's line or handle, the room id, or any AI output.
- **A notice excerpt contains only lines written by the person being acted on**, at most 5. A blocked line has every matched term masked. The date is shown as a day only (`YYYY-MM-DD`, UTC).
- **Warnings and notices never refuse at a door and never restrict chat.** A pending Warning blocks only the adopter's own "start next game" step, through the client. The kit just reports it in `notices.pending`.
- **Exact values:**
  - ladder lookback 90 days, measured from `starts_at`
  - excerpt cap 5 lines
  - reporter-feedback copy key `report.actioned`
  - reference id format `M-` + 5 characters (K1 `refCode`)
  - starter rules CR 1-8 with the titles in Task 2
  - retention timer `everyMs` maximum 2_147_483_647

## Review Focus

1. **A notice must never leak another player.** For example: an excerpt line id belonging to someone else is submitted, or a report's `people` index points at a merged alias. Both must be refused or filtered (Task 6, Task 7).
2. **Idempotent decisions.** Calling `decide` twice for the same report (a double click, or a Coop retry later) must not sanction twice or send two notices (Task 7).
3. **Revoke after notice.** Revoking a sanction withdraws its notice. An unseen withdrawn notice is never shown, and a seen one leaves the "My record" view (Task 6, Task 7).
4. **Merge after notice.** A notice for subject A is still pending for A's browser after A links to an account, so it merges into B (Task 6).
5. **A logger or hook that throws** in the new paths (the timer, the notice push, the decide hooks) never crashes the process or rejects a player-facing call (Task 1, Task 6, Task 7).

---

## File structure

```
packages/core/src/
  rules.ts        CommunityRule, defineRules, STARTER_RULES, ruleLabel, NOT_COVERED
  ladder.ts       actionStep, recordStep, suggestAction
  notices.ts      NoticeService (create, pending, ack, record, withdraw), Masker
  decide.ts       DecisionService.decide (verdict + actions + close + notices + feedback, idempotent)
  sanctions.ts    (+ 'warning' kind, rule + gap note, applyWarning)
  chat.ts         (+ rule / noticeId on refusals)
  doors.ts        (+ noticeId on refusals)
  retention.ts    (+ notices purge, bad-faith marks kept)
  chatwarden.ts   (+ rules, notices, decide, ladder, gaps, history; timer hardening)
packages/matcher/src/spans.ts   findSpans(text) for masking
packages/store-sqlite/src/      migration 7 (sanctions kind widened, rule_gap columns, kit_notices, kit_decisions)
examples/tiny-chat/             notice frames, ack, record endpoint
```

---

### Task 1: Retention timer hardening

**Files:**
- Modify: `packages/core/src/chatwarden.ts`
- Test: `packages/core/test/chatwarden.test.ts`

**Interfaces:**
- Produces: no API change. `retention.everyMs` above 2_147_483_647 throws `RangeError('retention.everyMs must be at most 2147483647')` at creation.

- [ ] **Step 1: Write failing tests:**
  - `a throwing logger inside the purge failure path never produces an unhandledRejection`: `store.purgeReports` throws, the logger throws, `everyMs` is 10 ms, and a `process.on('unhandledRejection')` spy stays empty after 3 ticks.
  - `a throwing clock inside the timer is caught`
  - `everyMs 2_147_483_648 throws RangeError`
  - `everyMs 2_147_483_647 is accepted`
  - `the no_matcher warning with a throwing logger does not reject createChatwarden`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/chatwarden.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Wrap the whole interval callback, `clock.now()` included, in try/catch.
  - Fence every `log.warn` with the same safe-warn helper the services use. Export one `safeWarn(logger, event, detail)` from `types.ts` or a small `log.ts`, and replace the duplicated default loggers with it (the K1 minors).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): fence the retention timer and cap everyMs`.

### Task 2: Community Rules registry

**Files:**
- Create: `packages/core/src/rules.ts`
- Test: `packages/core/test/rules.test.ts`

**Interfaces:**
- Produces:
  - `interface CommunityRule { number: number; title: string; text: string; retired?: boolean }`
  - `type RuleRef = number | 'uncovered'`
  - `class CommunityRules { constructor(rules: readonly CommunityRule[]); get(n: number): CommunityRule | undefined; active(): CommunityRule[]; all(): CommunityRule[]; isCitable(ref: RuleRef): boolean; label(ref: RuleRef): string }`
    - `label(3)` → `'Community Rule 3: <title>'`
    - `label('uncovered')` → `'Not covered by a rule yet'`
  - `defineRules(rules)` → `CommunityRules`. It validates and throws `RulesError` on:
    - duplicate numbers
    - a non-positive or non-integer number
    - an empty title or text
  - `defineRules(next, { previous })` additionally refuses a number in `previous` that is missing from `next`, so a rule can be retired but never removed or renumbered.
  - `STARTER_RULES: CommunityRule[]`. Titles verbatim:
    1. `No slurs or hate aimed at who someone is`
    2. `No insulting, threatening or targeting another player`
    3. `No sexual messages`
    4. `No spam, flooding or advertising`
    5. `No cheating or exploiting`
    6. `No throwing, stalling or ruining games on purpose`
    7. `No offensive names`
    8. `No false reports`

    Each `text` is one or two plain sentences. Write them per the copy rules: plain, short, not a lecture.
  - `CATEGORY_TO_RULE: Record<ReportCategory, RuleRef>` = `{ hate: 1, harassment: 2, spam: 4, cheating: 5, disruption: 6, other: 'uncovered' }`
  - `rulesPolicyText(rules): string`, a numbered plain-text rendering (the AI read uses it in K3)
  - `isCitable(ref)` is true for an active rule number and for `'uncovered'`; a retired rule is false

- [ ] **Step 1: Write failing tests** covering:
  - every validation error
  - retired rules kept and not citable
  - removal refused against `previous`
  - the labels
  - the `CATEGORY_TO_RULE` map
  - the `rulesPolicyText` format: one line per active rule, `CR n. Title: text`
  - the starter titles exact
- [ ] **Step 2: Run** `npx vitest run packages/core/test/rules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pure, no IO.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): numbered Community Rules registry`.

### Task 3: Warning kind, rule and gap note on sanctions

**Files:**
- Modify: `packages/core/src/{types.ts,sanctions.ts}`, `packages/core/test/memoryStore.ts`, `packages/store-sqlite/src/{migrations.ts,sqliteStore.ts}`
- Test: `packages/core/test/sanctions.test.ts`, `packages/store-sqlite/test/sanctions.store.test.ts`

**Interfaces:**
- Consumes: `RuleRef` (Task 2).
- Produces:
  - `SanctionKind = 'chat' | 'area' | 'ban' | 'warning'`
  - `SanctionInput` gains:
    - `rule?: RuleRef`. Stored as TEXT: the number as a string, or `'uncovered'`. It defaults to `'uncovered'` when absent.
    - `gapNote?: string`. Required (non-empty, ≤ 500) when `rule === 'uncovered'` and `source === 'moderator'`. Otherwise it must be absent.
  - `applySanction` with `kind: 'warning'`:
    - requires `durationMs === null`
    - forbids `includeIp`
    - writes one subject row with `ends_at = starts_at`
  - `SanctionIndex.load` and `active` never return a warning. Tests prove this at every door kind and in chat.
  - Migration 7 (part 1):
    - rebuild `kit_sanctions` with the kind CHECK widened
    - add `gap_note TEXT`, `gap_status TEXT CHECK (gap_status IN ('open','ruled','not_a_rule'))` and `gap_ref TEXT`
    - copy every row
  - `SanctionRow` gains `gapNote: string | null` and `gapStatus: 'open' | 'ruled' | 'not_a_rule' | null`.
  - Store additions:
    - `listGaps(): SanctionRow[]`: subject rows with `gap_note` not null, newest first
    - `closeGap(groupId, status: 'ruled' | 'not_a_rule', ref: string | null, actor, at): boolean`
  - `ChatService`'s auto timeout writes `rule: '1'`.

- [ ] **Step 1: Write failing tests:**
  - warning shape (no end, no IP, ends = starts)
  - never refuses (chat, the four doors)
  - rule defaults to uncovered
  - a gapNote is required for moderator plus uncovered
  - a gapNote is refused with a cited rule
  - an auto timeout carries rule 1
  - migration 7 keeps existing rows, and the widened CHECK accepts 'warning'
  - listGaps / closeGap
- [ ] **Step 2: Run** `npx vitest run packages/core/test/sanctions.test.ts packages/store-sqlite/test/sanctions.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `SANCTION_KINDS` and the CHECK in sync. Add a test that asserts they match.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Warning kind, cited rule and rule-gap note on sanctions`.

### Task 4: History and the escalation ladder

**Files:**
- Create: `packages/core/src/ladder.ts`
- Modify: `packages/core/src/types.ts` (Store `loadSubjectActions`), memoryStore, sqliteStore
- Test: `packages/core/test/ladder.test.ts`

**Interfaces:**
- Produces:
  - Store `loadSubjectActions(since: number): SanctionRow[]` (subject rows only)
  - `interface ActionRecord { kind: SanctionKind; durationMs: number | null; startsAt: number; revoked: boolean; automated: boolean }`
  - `historyOf(store, subjects, subject, now): ActionRecord[]`: the canonical person across aliases, `starts_at >= now - 90 days`, revoked rows included but flagged
  - `actionStep(a: ActionRecord): 1 | 2 | 3 | 4 | 5`. Revoked rows are ignored by `recordStep`. The mapping comes verbatim from the feature contract's step table:
    - a warning is 1
    - chat or area under 7 d (auto timeouts included) is 2
    - chat or area of 7 d or more, or a ban under 7 d, is 3
    - a ban of 7 d up to under 30 d is 4
    - a ban of 30 d or more, or anything permanent, is 5
  - `recordStep(records): 0..5`: the max of `actionStep` over non-revoked records, with the rule that two or more non-revoked warnings make step 2
  - `type Severity = 'high' | 'medium' | 'low' | 'none'`
  - `suggestAction(step, severity: Severity | null, rule: RuleRef): { kind: SanctionKind; durationMs: number | null; label: string }`
    - Exact cells come from the feature contract table.
    - A null severity is treated as `medium`, or as `high` when the rule is 1.
    - Rules 5 and 6 turn a chat suggestion into `area` at the same length.
    - The label is e.g. `'Restrict chat 24 hours'`.
  - `LADDER_TABLE`, exported for the Guide to render.

- [ ] **Step 1: Write failing tests:**
  - every `actionStep` mapping and its boundaries (7 d exactly, 30 d exactly, permanent)
  - two warnings make step 2
  - revoked records are ignored
  - the 90-day lookback boundary is inclusive
  - aliases fold
  - every one of the 12 ladder cells
  - null severity defaults
  - the CR 5 / CR 6 area swap
- [ ] **Step 2: Run** `npx vitest run packages/core/test/ladder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): action history and escalation ladder suggestion`.

### Task 5: Matcher spans for masking

**Files:**
- Create: `packages/matcher/src/spans.ts`
- Modify: `packages/matcher/src/{matcher.ts,liveTerms.ts,index.ts}`
- Test: `packages/matcher/test/spans.test.ts`

**Interfaces:**
- Produces:
  - `Matcher` gains an optional `spans?(text: string): Array<{ start: number; end: number; termId: string }>`. The ranges are on the ORIGINAL text, end exclusive.
  - `buildMatcher` and `LiveTerms` implement it, with the same semantics as `match`: both passes, exceptions honoured, invisible characters inside a span included in it.
  - Core's structural `Matcher` (R6) gains the same optional method.
  - `maskSpans(text, spans): string` (in core) replaces each span with `*` × its length.

- [ ] **Step 1: Write failing tests** with the synthetic terms:
  - a plain hit
  - two hits
  - a glued-punctuation hit (the range covers the word, not the punctuation)
  - a zero-width joiner inside a term (the span covers it)
  - an excepted phrase gives no span
  - `spans` is empty exactly when `match` is null, checked over every positive and negative line in the pack
- [ ] **Step 2: Run** `npx vitest run packages/matcher/test/spans.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - obscenity's `getAllMatches` reports ranges against its input.
  - `stripInvisible` changes indices, so keep a map from stripped index to original index (the matcher already folds text for exceptions in a similar way).
  - Merge overlapping spans.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(matcher): spans on the original text for masking`.

### Task 6: Notices

**Files:**
- Create: `packages/core/src/notices.ts`
- Modify: `types.ts` (Store notice methods), memoryStore, sqliteStore (migration 7 part 2: `kit_notices`), `retention.ts`
- Test: `packages/core/test/notices.test.ts`, `packages/store-sqlite/test/notices.store.test.ts`

**Interfaces:**
- Consumes:
  - `SubjectIndex.canonical`
  - `CommunityRules.label` (Task 2)
  - `maskSpans` + `Matcher.spans` (Task 5)
  - `StoredReport.excerpt` / `people` (K1)
- Produces:
  - `type NoticeKind = 'warning' | 'chat' | 'area' | 'ban' | 'report_outcome'`
  - `interface PlayerNotice { id: string; kind: NoticeKind; rule: RuleRef | null; ruleLabel: string | null; until: number | null; refCode: string | null; excerpt: Array<{ text: string; day: string }>; createdAt: number; mustAcknowledge: boolean }`
    - This is the ONLY shape that leaves the kit for a player.
    - `mustAcknowledge` is true for `warning`.
    - `report_outcome` has `rule`, `refCode`, `until` and `excerpt` empty or null.
  - `kit_notices`:
    - `id`, `subject_id`, `group_id NULL`, `kind`, `rule`, `until`, `ref_code`, `excerpt_json`, `created_at`
    - `acked_at NULL`, `withdrawn_at NULL`
    - index `(subject_id, acked_at, withdrawn_at)`
  - `class NoticeService { constructor(deps: { store; subjects; rules: CommunityRules; clock; matcher?: Matcher; logger?; notify?: (subject: SubjectId, event: { type: 'notice_pending'; count: number }) => void }) }`, with methods:
    - `createForSanction(group: { groupId; refCode; kind; until; rule; subject }, excerptLines?: ReportExcerptLine[]): string`. Returns the notice id. `excerptLines` must already be filtered to the target's own lines, at most 5, masked if blocked.
    - `createReportOutcome(reporter: SubjectId): string`
    - `pending(subject): PlayerNotice[]`: unacked, unwithdrawn, oldest first, across canonical aliases
    - `ack(subject, id): boolean`: only a target person (canonical match) may ack, and acking twice is fine
    - `record(subject): PlayerNotice[]`: "My record". Unwithdrawn sanction notices whose group is active, or that started within 90 days. Each has its refCode and until. Report outcomes are excluded.
    - `withdrawGroup(groupId): number`
    - `pendingWarning(subject): boolean`
  - `notify` is fenced against sync and async throws, and is called after the create commits.
  - `ownLines(report: StoredReport, subject, lineIds: string[]): ReportExcerptLine[]` (exported)
    - It keeps only lines whose `people[p]` canonicalises to `subject`, preserving order.
    - It throws `ExcerptError('foreign_line')` if any requested id isn't the target's own, and `ExcerptError('too_many')` above 5.
    - Ids absent from the excerpt also throw `foreign_line`.
  - Day formatting is `new Date(ts).toISOString().slice(0, 10)`. A blocked line's text is `maskSpans(raw, matcher.spans(raw))`. With no `spans` support it is fully masked (`*` × length).
  - Retention: `purge` also deletes notices `created_at < now - 90d` that are acked or withdrawn, and unacked notices whose group's sanction row was purged. Add the count to `PurgeResult.notices`.

- [ ] **Step 1: Write failing tests:**
  - shape (keys exactly per `PlayerNotice`)
  - no identifier anywhere in a `PlayerNotice` (the regex scan from tiny-chat)
  - `ownLines` filters, keeps order, and throws for foreign lines (Review Focus 1), including a merged alias's line, which IS own
  - the cap of 5
  - blocked lines are masked so no synthetic term remains
  - day format
  - pending across merge (Review Focus 4)
  - only the target can ack
  - withdraw hides pending and removes from record (Review Focus 3)
  - record excludes report outcomes
  - `pendingWarning`
  - `notify` called once after commit, a throwing or async-rejecting notify fenced (Review Focus 5)
  - purge counts
- [ ] **Step 2: Run** `npx vitest run packages/core/test/notices.test.ts packages/store-sqlite/test/notices.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): player notices with own-lines excerpt, ack, record, withdraw`.

### Task 7: Decide (one path for every moderator decision)

**Files:**
- Create: `packages/core/src/decide.ts`
- Modify: `types.ts` (Store `loadReport`, `closeReport`, `insertDecision`, `findDecision`), memoryStore, sqliteStore (migration 7 part 3: `kit_decisions`), `retention.ts` (spare bad-faith marks)
- Test: `packages/core/test/decide.test.ts`

**Interfaces:**
- Consumes: `applySanction`, `revokeSanction`, `NoticeService`, `ownLines`, `CommunityRules`, `SanctionIndex`, and `historyOf` / `recordStep` / `suggestAction`.
- Produces:
  - `interface DecisionAction { subject: SubjectId; kind: SanctionKind; durationMs: number | null; rule: RuleRef; gapNote?: string; includeIp?: boolean; lineIds?: string[] }`
  - `interface DecisionInput { reportId: string; verdict: 'fair' | 'unfair' | 'bad_faith'; actions: DecisionAction[]; actor: string; reason: string; source?: Source }`. `source` defaults to `'moderator'`.
  - `class DecisionService { decide(input): Promise<{ ok: true; groups: Array<{ subject; groupId; refCode; noticeId }>; replay: boolean } | { ok: false; error: 'not_found' | 'already_decided' | 'invalid' }> }`
  - Rules:
    - `reason` is required (trimmed, non-empty, ≤ 500).
    - Each action's `rule` must be `isCitable`.
    - `lineIds` is validated with `ownLines` against the report (any `ExcerptError` → `invalid`).
    - `unfair` and `bad_faith` may carry actions only against the reporter or other people in `people` (acting on the reporter is a normal action), never against the reported target.
    - Status: `fair` → `actioned`. `unfair` → `dismissed`. `bad_faith` → `dismissed` with `bad_faith = 1`.
    - `actioned_at` / `actioned_by` / `mod_note` = now / actor / reason.
  - Atomic: the report close, every sanction and every notice are written in ONE `store.transaction`. Index updates and `notify` calls happen after the commit.
  - Idempotent (Review Focus 2):
    - `kit_decisions(key PRIMARY KEY, report_id, at, result_json)`, where `key = sha256(reportId + verdict + canonical JSON of actions sorted by subject)`.
    - The same key again → `{ ok: true, replay: true }` with the stored result, and nothing new is written.
    - A different decision on an already-closed report → `already_decided`.
  - Reporter feedback: when `verdict === 'fair'` and at least one action was applied, create a `report_outcome` notice for the reporter. Never on dismissals.
  - Revoke: the facade's `sanctions.revoke` now also calls `notices.withdrawGroup`.
  - Retention fix (K1 T13 minor): `purgeReports` keeps reports with `bad_faith = 1 AND actioned_at >= now - 30d`, even past the 90-day `created_at` cutoff.

- [ ] **Step 1: Write failing tests:**
  - fair plus a warning: the report is actioned, a notice exists with `mustAcknowledge`, and the reporter gets `report_outcome`
  - unfair: dismissed, no reporter feedback
  - bad_faith: `bad_faith = 1`, three of them suspend the reporter (via K1 `submit`)
  - acting on the reporter under bad_faith
  - an action against the target under unfair → invalid
  - a foreign lineId → invalid, and nothing written (Review Focus 1)
  - a retired rule → invalid
  - uncovered without a gapNote → invalid
  - replay returns the same groups with no second notice or sanction (Review Focus 2)
  - a different decision after close → already_decided
  - atomicity: a store throw on the second action leaves no report change, sanction or notice
  - revoke withdraws the notice
  - the purge keeps live bad-faith marks
- [ ] **Step 2: Run** `npx vitest run packages/core/test/decide.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `createHash('sha256')` from `node:crypto`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): one idempotent decide path for moderator decisions`.

### Task 8: Refusals cite the rule; notices at the doors

**Files:**
- Modify: `packages/core/src/{chat.ts,doors.ts}`
- Test: `packages/core/test/chat.test.ts`, `packages/core/test/doors.test.ts`

**Interfaces:**
- Produces:
  - The `ChatResult` refusal gains `rule?: number` and `noticeId?: string`.
    - `'blocked'` → `rule: 1` (explain at the point of block).
    - `'restricted'` → the active sanction's rule (when it is a number) and its group's unacked or latest notice id, when one exists.
  - `DoorRefusal` gains `noticeId?: string`.
  - `ChatService` and `DoorService` take an optional `notices?: NoticeService` to look the id up.
  - Lookup failures are fail-open for the extra fields only: they are omitted, never thrown.

- [ ] **Step 1: Write failing tests:**
  - a blocked refusal carries `rule: 1`
  - a restricted refusal carries the rule and the noticeId
  - an auto timeout has rule 1 and a notice
  - a door refusal carries the noticeId
  - a broken notices lookup still refuses correctly, without the extras
  - no identifier in any refusal
- [ ] **Step 2: Run** `npx vitest run packages/core/test/chat.test.ts packages/core/test/doors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The auto-timeout path in `ChatService` also creates a notice (kind `chat`, rule 1) with the blocked line that triggered it, masked.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): refusals cite the rule and point at the notice`.

### Task 9: Facade and tiny-chat

**Files:**
- Modify: `packages/core/src/chatwarden.ts`, `packages/core/src/index.ts`, `examples/tiny-chat/{server.ts,tiny-chat.test.ts,README.md}`
- Test: `packages/core/test/chatwarden.test.ts`, `examples/tiny-chat/tiny-chat.test.ts`

**Interfaces:**
- Produces, on the facade:
  - options: `rules?: CommunityRules` (default `defineRules(STARTER_RULES)`)
  - `platform.notify?(who: SubjectId, event)`, which feeds `NoticeService.notify`
  - `rules`: the registry
  - `notices: { pending(who: RawWho): PlayerNotice[]; ack(who: RawWho, id: string): boolean; record(who: RawWho): PlayerNotice[]; pendingWarning(who: RawWho): boolean }`. These are player-facing, take `RawWho` and use `lookup` (never create).
  - `decide(input: DecisionInput)`
  - `history(subject)` and `suggest(subject, severity, rule)`, server-side
  - `gaps: { list(): GapRow[]; close(groupId, status, ref, actor): boolean }`. `GapRow` = `{ groupId, refCode, at, actor, note, rule: 'uncovered', status }`, with no subject id.
- tiny-chat:
  - on connect, push `{type:'notices', items}` if any are pending
  - `{type:'ack', id}` in
  - `GET /record?key=`, demo only, with a README warning that a real app authenticates
  - an integration test: report → decide a warning with the reported line → the target receives the notice with the excerpt (own line only) → ack → gone → record lists it; reporter receives `report_outcome`
  - a leak scan over every frame and response

- [ ] **Step 1: Write failing tests** (facade unit tests plus the integration flow above).
- [ ] **Step 2: Run** `npx vitest run packages/core/test/chatwarden.test.ts examples/tiny-chat/tiny-chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. `npm run typecheck` and `npm run lint` are clean.
- [ ] **Step 5: Commit and push** `feat: rules, decisions and notices in the facade and tiny-chat`. CI must be green on both Node legs.
