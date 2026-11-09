# Chatwarden K3a: moderation standards, presets and configuration. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-game moderation profiles. A one-line preset choice (`relaxed`, `standard` or `strict`) with
good defaults, and every value overridable underneath. Conduct levels, the Note outcome, clearer verdicts, a
profile-driven suggestion, a configurable profanity package, configurable limits, and the staff report queue
methods K3b's HTTP layer needs.

**Architecture:**
- `ModerationProfile` is plain data: presets plus `resolveProfile(preset, overrides)` and `defineProfile(full)`,
  both strictly validated.
- The facade resolves one profile and hands each service the slice it needs.
- Profanity is a separate optional package that implements a small core `ProfanityFilter` interface.

**Tech Stack:** as K2. Adds `@chatwarden/profanity`, which depends on `obscenity`.

**Spec:**
- `docs/design/2026-11-09-moderation-standards.md` (approved 2026-11-09; all recommendations accepted)
- `docs/design/2026-11-09-chatwarden-design.md`

**Builds on (main `21c24fd`):**
- core: rules, ladder (`Severity`, `suggestAction`, `LADDER_TABLE`), decide (verdicts fair/unfair/bad_faith),
  sanctions (`warning` kind), notices, chat (`Starrer`, `MAX_LEN` 200, rate 3 per 5 s), strikes (constants),
  reports (`SUSPEND_AFTER` 3, 10 reports/day), retention
- store-sqlite migrations 1-9

## Global Constraints

Everything in the K1 and K2 Global Constraints still binds:
- `docs/plans/2026-11-09-k0-k1-foundation.md`
- `docs/plans/2026-11-09-k2-rules-warnings-notices.md`

Plus these:
- **Presets are complete and valid on their own.** `resolveProfile` validates the MERGED result. Errors are
  `ProfileError` with a plain message naming the field path (e.g. `profile.repeat.windowDays must be a whole number
  of days ≥ 1`), and never echo chat text.
- **Exact preset values** come from the standards doc tables, verbatim:
  - the `summary` strings
  - first-offense outcomes
  - the repeat rules:
    - relaxed: 2 notes in 30 d, from distinct games
    - standard: 2 notes in 30 d
    - strict: 1 note
  - profanity modes: star / star / refuse
  - AI auto-act levels: `['severe']` / `['severe']` / `['hostile', 'severe']`
- **Configurable defaults are unchanged from K1/K2:**
  - chat length 200, rate 3 per 5 000 ms
  - strikes 3 per 1 h → 30 min, a repeat within 7 d → 24 h
  - reports 10 per 24 h, suspension after 3 bad-faith in 30 d
  - retention defaults
  - Moxgate's behaviour under `relaxed` with no overrides is the K2 behaviour plus the K3a additions
- **Floors:**
  - retention `sanctionAfterEndMs` and `noticesMs` ≥ 90 d (the ladder lookback and the record)
  - `badFaithMs` ≥ the suspension window
  - strike / rate / length values must be positive integers
  - violations throw at creation
- **Profanity is never a rule violation.** A profanity refusal or starring never creates a strike, note,
  sanction or notice.
- **No real slur in the repo** (K1 rule). Ordinary profanity may appear ONLY inside
  `packages/profanity/test/**`, and only as needed.

## Review Focus

1. **A deep-merge footgun.** Overriding one nested field (e.g. `firstOffense.rude`) must keep the preset's
   other fields. Overriding an array (`aiAutoAct`, `profanity.add`) replaces it rather than concatenating, and the
   docs say so (Task 3).
2. **`banter` never punishes.** Under every preset and every override, `suggest` for `banter` returns `none`, and
   AI auto-act can never include banter or rude. Validation enforces it (Tasks 3, 4).
3. **The note escalation boundary.** Exactly 2 notes in 30 d from distinct games under relaxed → warning. Two notes
   from the same game don't count. Note 1 at 30 d + 1 ms has aged out (Task 4).
4. **Renamed verdicts.** Old callers passing `'fair'` fail loudly with `invalid`. Stored decisions and reports
   from K2 keep working (Task 1).
5. **Profanity `remove` / `only` / `add` interplay** with evasion handling (leetspeak, invisible characters,
   punctuation) (Task 6).

---

### Task 1: Conduct levels, renamed verdicts, bad-faith evidence

**Files:**
- Modify: `packages/core/src/{types.ts,ladder.ts,decide.ts,chatwarden.ts,index.ts}`, `packages/core/test/memoryStore.ts`,
  `packages/store-sqlite/src/{migrations.ts,sqliteStore.ts}`, `examples/tiny-chat/server.ts`
- Test: `packages/core/test/{ladder,decide,chatwarden}.test.ts`, `packages/store-sqlite/test/decisions.store.test.ts`,
  `examples/tiny-chat/tiny-chat.test.ts`

**Interfaces:**
- Produces:
  - `type ConductLevel = 'banter' | 'rude' | 'hostile' | 'severe'`, which replaces `Severity`. Remove `Severity`
    (unreleased). The ladder maps the old values: none → banter, low → rude, medium → hostile, high → severe.
  - `CONDUCT_LEVELS` (ordered).
  - `DecisionInput.verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith'`.
    - `upheld` closes the report as `actioned`.
    - `noted` closes it as `actioned` and requires ≥ 1 action, all of kind `note` (the kind arrives in Task 2;
      until then `noted` with any action is invalid).
    - `no_action` closes as `dismissed`.
    - `bad_faith` closes as `dismissed` with `bad_faith = 1`.
  - The `upheld` / `noted` scope rules = the old `fair` rules. The `no_action` / `bad_faith` rules = the old
    `unfair` / `bad_faith` rules.
  - `DecisionInput.evidence?: string`. Required (trimmed, 1..500) when `verdict === 'bad_faith'`, otherwise
    forbidden. It is stored on the report as `bad_faith_evidence` (migration 10 adds the column).
  - Staff-only: it is returned by `loadReport`, and never in any player value.
  - Reporter feedback: only on `upheld` with ≥ 1 non-note action.
  - The idempotency key includes the new verdict names. K2 stored decisions still replay, because their keys
    used the old names and are compared only by exact key.

- [ ] **Step 1: Write failing tests:**
  - every verdict's status and bad_faith
  - `fair` / `unfair` → invalid (Review Focus 4)
  - bad_faith without evidence → invalid
  - evidence with another verdict → invalid
  - evidence is never in any notice or player-facing value
  - migration 10 adds the column and keeps rows
  - ladder tests renamed to conduct levels with the same cells
  - the tiny-chat `/decide` route accepts the new verdicts
- [ ] **Step 2: Run** `npx vitest run packages/core/test/ladder.test.ts packages/core/test/decide.test.ts packages/store-sqlite/test/decisions.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those files plus `packages/core/test/chatwarden.test.ts examples/tiny-chat/tiny-chat.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): conduct levels, clearer verdicts, evidence for bad faith`.

### Task 2: The Note outcome

**Files:**
- Modify: `packages/core/src/{types.ts,sanctions.ts,ladder.ts,decide.ts,notices.ts,retention.ts}`, memoryStore,
  `packages/store-sqlite/src/{migrations.ts,sqliteStore.ts}` (migration 11: `kit_sanctions` kind CHECK adds `'note'`)
- Test: `packages/core/test/{sanctions,decide,ladder}.test.ts`, `packages/store-sqlite/test/sanctions.store.test.ts`

**Interfaces:**
- Produces:
  - `SanctionKind` gains `'note'`, stored exactly like a warning: one subject row, `ends_at = starts_at`, no IP, a
    rule required.
  - A note is never indexed and never refuses (all doors and chat).
  - `decide` creates NO notice for a note, and no reporter feedback.
  - `ActionRecord` and `historyOf` include notes. `actionStep(note) = 0`, so notes don't move the K2 step. Task 4
    counts them for "repeated".
  - `ActionRecord` gains `roomId: string | null` (from the decided report's room; `historyOf` joins via the
    decision → report, or stores `room_id` on the sanction row in migration 11). Pick the simpler and state it.
    The "distinct games" repeat rule needs it.
  - Retention: notes purge on the warning rule (90 d after start).
  - `record()` excludes notes (notices never exist for them anyway).

- [ ] **Step 1: Write failing tests:**
  - note shape
  - never refuses (chat plus the 4 doors)
  - `decide` noted → no notice, no feedback, report actioned
  - a note in `historyOf` with its roomId
  - `actionStep(note)` is 0
  - migration 11 keeps rows and accepts 'note'
  - the CHECK and `SANCTION_KINDS` stay in sync
- [ ] **Step 2: Run** the listed tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Note outcome: on the record, never punishing`.

### Task 3: ModerationProfile, presets, resolve and define

**Files:**
- Create: `packages/core/src/profile.ts`
- Test: `packages/core/test/profile.test.ts`

**Interfaces:**
- Produces:
  - `type Outcome = 'none' | 'note' | 'warning' | { kind: 'chat' | 'area' | 'ban'; durationMs: number | null }`
  - `interface ModerationProfile`, the standards doc's shape plus:
    - `levels: Record<ConductLevel, { meaning: string; examples: string[] }>`
    - `repeat: { windowDays; notes; distinctGames }`
    - `ladder: readonly LadderRow[]`
    - `profanity: ProfanityConfig`
    - `rules: 'relaxed' | 'standard' | 'strict'`, the starter-rules flavour (Task 5)
  - `interface ProfanityConfig { mode: 'allow' | 'star' | 'refuse'; style: 'full' | 'keepFirst' | 'grawlix'; add: string[]; remove: string[]; only: string[] | null; languages: string[] }`
  - `PRESETS: Record<'relaxed' | 'standard' | 'strict', ModerationProfile>`, verbatim from the standards doc tables.
    The `levels` meanings and examples come from its conduct table. The examples are plain and contain no slur.
  - `type ProfileOverrides = DeepPartial<ModerationProfile>` (arrays replace).
  - `resolveProfile(preset: ModerationProfile | keyof typeof PRESETS, overrides?: ProfileOverrides): ModerationProfile`
    deep-merges onto a frozen deep copy, then validates.
  - `defineProfile(p: ModerationProfile): ModerationProfile` only validates.
  - Validation, each failure → `ProfileError` with the field path:
    - unknown keys at any depth
    - every level present
    - `firstOffense.banter === 'none'`
    - `aiAutoAct` ⊆ {hostile, severe}
    - durations positive or null
    - `repeat.notes` integer ≥ 1, `windowDays` integer ≥ 1
    - ladder rows 0..5, each with valid cells
    - profanity enums valid; word lists of plain strings, each 1..40 characters with no whitespace
  - The resolved profile is deep-frozen.

- [ ] **Step 1: Write failing tests:**
  - each preset equals the doc tables, cell by cell
  - presets validate
  - a nested override keeps siblings (Review Focus 1)
  - an array override replaces
  - unknown key → error with the path
  - `firstOffense.banter = 'warning'` → error (Review Focus 2)
  - `aiAutoAct` containing rude → error
  - the frozen result can't be mutated
  - a custom `defineProfile` round-trip
  - errors never echo values that could be chat text
- [ ] **Step 2: Run** `npx vitest run packages/core/test/profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): moderation profiles with presets, overrides and validation`.

### Task 4: Profile-driven suggestion

**Files:**
- Modify: `packages/core/src/{ladder.ts,chatwarden.ts}`
- Test: `packages/core/test/ladder.test.ts`, `packages/core/test/chatwarden.test.ts`

**Interfaces:**
- Consumes: `ModerationProfile` (Task 3), `historyOf` with notes and roomId (Task 2).
- Produces:
  - `suggest(profile, records: ActionRecord[], level: ConductLevel, rule: RuleRef, now: number): { outcome: Outcome; label: string; why: string }`
  - The algorithm:
    1. `banter` → none.
    2. `severe` → step = max(recordStep, the first-offense step); take the profile ladder's `high` column, which
       is severe, never lower than `firstOffense.severe`.
    3. Otherwise:
       - With a clean record (step 0, no qualifying notes), the result is `firstOffense[level]`.
       - Counting this incident as a note: if `repeat` is met over non-revoked notes within `windowDays` (distinct
         `roomId`s if `distinctGames`), escalate to `warning`, or to the ladder's next step when the record
         already has a warning or more.
       - With a record (step ≥ 1), use the profile ladder: hostile → the high column, rude → the low column.
  - The CR 5/6 area swap is kept but driven by the profile: `areaRules: number[]`, default [5, 6].
  - The CR 1 high column is driven by `severeRules: number[]`, default [1].
  - `why` is a plain sentence citing the profile, e.g. `'First rude message with a clean record: relaxed notes it.'`
  - The facade's `suggest(subject, level, rule)` uses the resolved profile.
  - Remove the old `suggestAction` export (unreleased).

- [ ] **Step 1: Write failing tests:**
  - under relaxed, the moderator's scenarios:
    - "loser" (banter) → none
    - a first "go f— yourself" (rude) → note
    - a second rude in another game within 30 d → warning
    - a second rude in the SAME game → note (Review Focus 3)
    - the 30 d boundary
    - rude after a warning → ladder
    - severe on a clean record → chat 7 d
  - standard and strict, a few key cells each
  - a custom profile with an overridden `firstOffense.rude`
  - `areaRules` / `severeRules` overrides
  - `why` is non-empty and has no identifier
- [ ] **Step 2: Run** `npx vitest run packages/core/test/ladder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus `packages/core/test/chatwarden.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): profile-driven suggestion with notes and repeat rule`.

### Task 5: Starter rules per profile, summary, and configurable limits

**Files:**
- Modify: `packages/core/src/{rules.ts,chat.ts,strikes.ts,reports.ts,retention.ts,decide.ts,chatwarden.ts}`
- Test: matching test files

**Interfaces:**
- Produces:
  - `starterRules(flavour: 'relaxed' | 'standard' | 'strict'): CommunityRule[]`. Numbers and titles stay
    identical except where the doc gives profile text. CR 2 relaxed:
    - title `No harassment or threats`
    - text: "Trash talk about the game and each other's play is fine. Harassing, threatening or personally
      attacking someone, again and again, is not."

    Strict CR 3 also covers swearing at people. The guard test (no single-game vocabulary) applies to every flavour.
  - `STARTER_RULES` = `starterRules('standard')`, for compatibility.
  - `ChatwardenOptions` gains:
    - `profile?: keyof PRESETS | ModerationProfile` (default `'standard'`) and `overrides?: ProfileOverrides`
    - `limits?: Partial<Limits>`, where `Limits = { chatMaxLength: 200; chatRate: { count: 3; windowMs: 5000 }; strikes: { count: 3; windowMs: 3_600_000; firstMs: 1_800_000; repeatMs: 86_400_000; repeatLookbackMs: 604_800_000 }; reports: { perDay: 10; suspendAfter: 3; suspendWindowMs: 2_592_000_000 }; reporterFeedback: true }`

    Each value is validated (positive integers). They thread into ChatService, StrikeService, ReportService
    and DecisionService.
  - Retention floors: `sanctionAfterEndMs` and `noticesMs` ≥ 90 d, `badFaithMs` ≥ `limits.reports.suspendWindowMs`.
    Violations → `ProfileError`/RangeError at creation, naming the field.
  - The facade exposes `cw.profile` (resolved, frozen), `cw.limits` and `cw.summary` (= `profile.summary`). The
    rules default to `defineRules(starterRules(profile.rules))` unless `rules` is passed.

- [ ] **Step 1: Write failing tests:**
  - each flavour's rules: CR 2 relaxed text verbatim, and the guard
  - every limit honoured when overridden (chat length 50, rate 1, strikes 2, reports 3/day, feedback off)
  - defaults unchanged with no overrides
  - each floor violation throws with the field named
  - `cw.summary` per preset
- [ ] **Step 2: Run** the listed tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): starter rules per profile and configurable limits with floors`.

### Task 6: `@chatwarden/profanity`

**Files:**
- Create: `packages/profanity/{package.json,tsconfig.json,src/index.ts,src/filter.ts,test/filter.test.ts}`
- Modify: `packages/core/src/{chat.ts,types.ts}`, root `tsconfig.json` and the vitest config
- Test: `packages/profanity/test/filter.test.ts`, `packages/core/test/chat.test.ts`

**Interfaces:**
- Produces:
  - In core, `interface ProfanityFilter { apply(text: string): { hit: boolean; text: string } }`. It replaces
    `Starrer`. Keep a `Starrer` type alias deprecated for one release, or remove it if nothing outside core uses
    it. The facade option is `profanity?: ProfanityFilter`.
  - ChatService behaviour, from `profile.profanity.mode`:
    - `allow` → the filter is not called
    - `star` → deliver `apply().text`
    - `refuse` → `{ refuse: { reason: 'profanity' } }` when `hit`
  - Never a strike, note or sanction (test it). The `'profanity'` reason is added to `ChatResult`.
  - In the profanity package, `createProfanityFilter(config: ProfanityConfig): ProfanityFilter`:
    - built on obscenity's English dataset plus `englishRecommendedTransformers`
    - `remove` drops dataset words (by matching the dataset's original word metadata)
    - `add` adds whole-word patterns with the same transformers
    - `only` builds from exactly those words, plus `add`, minus `remove`
    - `style`: `full` → `*` × length; `keepFirst` → first letter + `*`; `grawlix` → a cycle of `#$%@!&` × length
    - `languages`: only `'en'` today; an unknown language throws
  - The facade builds the filter automatically when `@chatwarden/profanity` is passed as
    `profanityPackage: { createProfanityFilter }`. That keeps core free of the dependency. Otherwise the adopter
    passes a ready filter.

- [ ] **Step 1: Write failing tests:**
  - each mode in ChatService, with no strikes on refuse
  - each style
  - `remove` lets a dataset word through
  - `add` catches a custom word, including leetspeak and invisible-character variants (Review Focus 5)
  - `only` restricts to the listed words
  - an unknown language throws
  - the facade wiring with `profanityPackage`
  - ordinary profanity stays inside the profanity package tests only
- [ ] **Step 2: Run** `npx vitest run packages/profanity/test packages/core/test/chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(profanity): configurable profanity filter package`.

### Task 7: Staff report queue on the facade

**Files:**
- Modify: `packages/core/src/{types.ts,chatwarden.ts}`, memoryStore, sqliteStore
- Test: `packages/core/test/chatwarden.test.ts`, `packages/store-sqlite/test/reports.store.test.ts`

**Interfaces:**
- Produces:
  - Store `listReports(q: { status?: 'open' | 'actioned' | 'dismissed'; before?: number; limit: number }): ReportRecord[]`:
    newest first, `limit` ≤ 200.
  - Facade `reports.list(q)` and `reports.get(id)`. Staff-only, with that TSDoc.
  - They return `StaffReport = ReportRecord` plus `targetPerson`, `reporterPerson` and `people` as STAFF REFS:
    stable opaque per-person strings for the hub. Use the canonical subject id itself; it's staff-only and the
    K2 rule allows subject ids in staff channels. Say so in the TSDoc.
  - `get` also returns `ownLineIds: Record<staffRef, string[]>` (each person's own line ids), so the hub can offer
    the excerpt picker without recomputing it.

- [ ] **Step 1: Write failing tests:**
  - list ordering, status filter and pagination via `before`
  - the limit cap
  - get unknown → null
  - `ownLineIds` matches `ownLines` for every person, including merged aliases
  - both stores agree
- [ ] **Step 2: Run** the listed tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): staff report queue on the facade`.

### Task 8: Wire it together in the facade and tiny-chat

**Files:**
- Modify: `packages/core/src/chatwarden.ts`, `examples/tiny-chat/{server.ts,tiny-chat.test.ts,README.md}`, root README
- Test: `packages/core/test/chatwarden.test.ts`, `examples/tiny-chat/tiny-chat.test.ts`

**Interfaces:**
- Produces:
  - The full facade integration test under each preset: the same scripted conversation (banter, then rude, then
    rude in a second game) yields the profile's suggestions.
  - tiny-chat runs `profile: 'relaxed'` with `profanityPackage`.
  - Its welcome frame carries `summary` so the client can show "Trash talk is part of the game. Harassment,
    threats and hate are not." above the chat.
  - `/decide` accepts `noted` with a note action.
  - The README shows the one-line preset and an overrides example:
    `overrides: { profanity: { mode: 'allow' } }` and `{ profanity: { remove: ['damn', 'hell'] } }`.

- [ ] **Step 1: Write failing tests:**
  - the per-preset scripted suggestions
  - the tiny-chat welcome summary
  - a noted decision through `/decide` creates no notice
  - starring active in tiny-chat by default (with a word only in the profanity package's own fixtures, imported)
  - an overrides example works end to end
- [ ] **Step 2: Run** `npx vitest run packages/core/test/chatwarden.test.ts examples/tiny-chat/tiny-chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck and lint are clean.
- [ ] **Step 5: Commit and push** `feat: profiles, profanity and staff queue in the facade and tiny-chat`. CI is green on both legs.
