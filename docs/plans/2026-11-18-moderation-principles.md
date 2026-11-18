# Moderation principles, team notes and recommended setup (0.2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Test-first, seen red, then green. Targeted test runs only (by file path); never a full suite. One implementer per chunk; the per-task briefs (`.superpowers/sdd/principles-022/task-P<N>-brief.md`) hold the full test lists and commands; this document holds the decisions.

**Goal:** a team starts from recommended moderation principles chosen by the kind of game, edits every part of them in the hub, keeps staff-only working notes beside them, and what it writes reaches the moderator guide, the agent brief, the case view and the AI read's prompt, but never a player.

**Architecture:** `profile.guidelines` (the tiers) stays; the policy layer learns a whole form `{ tiers }` next to the 0.2.1 positional shape, plus two new sections, `teamNotes` and `aiContext`. A pure `promptPrinciples` function builds the prompt lines (no outcomes, capped, injection-screened) and the same function says what was left out (`PolicyState.promptExcluded`). Recommendations are fixed data in core (`recommendFor`), applied by one versioned save. A setup flag is a new optional Store pair over `kit_meta`. http adds the setup routes and `init --game`; the hub adds the editors, the first-run panel and a case-view disclosure. Everything is additive on the published 0.2.1, apart from `AI_PROMPT_VERSION` 5 to 6.

**Tech Stack:** TypeScript (ESM, Node >= 22.13), vitest, `node:sqlite`, React 18/19, no new runtime dependency.

**Spec:** `docs/design/2026-11-18-moderation-principles.md`, including section 5 (the builder-check rulings, which override sections 1 to 4). Also in force: `AGENTS.md`, `RELEASING.md`, `.superpowers/sdd/principles-022/rules.md`. Section numbers below refer to the spec.

## Global Constraints

- **Additive on published 0.2.1 (5.2, 5.3).** No breaking change to any public type, route or store contract: new fields, sections, routes and Store methods are optional. The one documented movement is the prompt: `AI_PROMPT_VERSION` goes from 5 to 6, stored reads become stale and are re-read on demand within the daily call and spend caps, and the changelog says so.
- **No migration (5.5).** The setup flag lives in `kit_meta` (key `setup_state`, a JSON value), so migration 28 is not created; 27 stays the latest. If a task finds it needs schema after all, it appends to a migration 28 and never adds 29.
- **Names stay (3.1).** The tiers are `profile.guidelines: GuidelineTier[]`; the hub calls them "Moderation principles". No code rename.
- **Tier invariants stay (5.1).** Every tier covers at least one cover; each cover (`banter`, `rude`, `hostile`, `severe`, `repeated`, `after_warning`) sits in at most one tier in core and exactly one in the hub editor; all four conduct levels are covered; so 1 to 6 tiers. The case view's matching-tier lookup and the code-of-conduct derivation stay one tier per level.
- **Layer shape (5.3).** `PolicyLayer.guidelines` is `Array<{ outcome: string } | null>` (0.2.1, still read) or `{ tiers: GuidelineTier[] }` (whole form, replaces the code profile's tiers). The hub always saves the whole form. New `POLICY_SECTIONS` entries: `teamNotes` and `aiContext` (appended). Reset works per section.
- **Team notes (3.2, 5.8).** `teamNotes: { text: string; rule?: number }[]`, default `[]`; at most 30, each 1 to 500 characters (code points) after trimming and stripping control, bidi and zero-width characters; refused when over, never cut. A `rule` must name an existing Community Rule, active or retired, at save; a note whose rule is later retired still shows in the guide, not on cases. Players never see notes.
- **Prompt (3.3, 5.2, 5.7).** STABLE part only. Tier line: `- <title> (covers: <levels>): <description> Examples: <examples>`, no outcome. Note line: `- Team note: <text>`. Each tier line at most 400 characters and the whole block at most 4,000 after the `oneLine` reduction; notes are dropped last first. A flagged note is left out; a flagged tier keeps only its title and covers. Flagged text is a warning in the hub, never a refusal. The base instruction "never name a penalty" stands.
- **Recommendations (2, 5.4).** `competitive` is `relaxed`; `social` is `standard`; `kids` is `strict`; `creator` is `standard` plus the team note "Protect the creator and their guests from targeted abuse". Applying writes in ONE versioned save: the preset's `guidelines` tiers, `firstOffense`, `repeat`, `ladder` and `aiContext`, plus the creator note for that choice only. `levels` and `profanity` stay in code.
- **First-run panel (3.4, 5.5).** Owner-only; shown while no policy layer has ever been saved and the team has not dismissed it; the dismissal is the `kit_meta` flag through the new Store pair `getSetupState(): { dismissedAt: number | null } | null` and `saveSetupState(state)`; a store without the pair keeps the dismissal for the session only. Routes `GET /setup` and `POST /setup/dismiss` (owner).
- **`chatwarden init` (5.6).** `--game competitive|social|kids|creator` maps to a preset; `--profile` stays and wins when both are given; the interactive flow asks the game type first; the JSON answers gain `game`; the creator choice writes its team note into the generated profile overrides.
- **Moxgate (5.9) is out of this plan.** Moving its wording and notes is a separate Moxgate change after 0.2.2 publishes.
- **Peer floors (RELEASING.md "When a peer floor must rise"):** `http` and `hub-react` use new core API, so their `@chatwarden/core` peer becomes `^0.2.2`; `hub-react` uses the new `http` routes, so its `@chatwarden/http` peer becomes `^0.2.2`; `hub-element` bundles the new hub, so its `@chatwarden/hub-react` peer becomes `^0.2.2`. `discord` and `player-react` stay at their 0.2.1 floor of core; the stores, `matcher`, `profanity` and `http`'s optional peers stay `^0.2.0`. Done in task P8, with `scripts/manifests.test.ts` changed in the same commit.
- **Standing rules:** the AI seam (`ai/**` import allowlist, narrowed AI store, source `'ai'` refused) is not loosened. Synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn). Non-ASCII only as `\u` escapes. LF endings. Browser-bundled code and shipped strings contain no bare word `process` or `require`. Hub: UI clean core, power behind one advanced door; i18n en, es and pt in step; lazy parts settle on real I/O. `node:sqlite` binds exactly as many values as the SQL has `?`, and each new SQL constant goes in `packages/store-sqlite/test/sql-placeholders.test.ts`. Logs name a class, never text.

## Plan rulings (the spec was silent; the briefs follow these)

1. **Field caps live on the whole-form layer only.** Title 80, description 600, at most 8 examples of at most 120 characters each, outcome 1000 (`MAX_GUIDELINE_OUTCOME`, as for the old shape); `aiContext` at most 2,000. A code profile written for 0.2.1 keeps working uncapped (the prompt's own 400 and 4,000 caps still bound what the model sees).
2. **`validateGuidelines` is unchanged.** Core still allows `repeated` and `after_warning` to be uncovered (a 0.2.1 code profile may). The hub editor model enforces all six placed exactly once and refuses Save with a message when not.
3. **Error paths for the whole form** use the tier index, like the old shape: `layer.guidelines[i].title`, `layer.guidelines[i].covers[j]`, and `layer.guidelines` for the cross-tier rules. `{ tiers }` with another key is `layer.guidelines.<key>`.
4. **Editing operations in the hub model.** Add splits the chosen covers out of the tier(s) that own them into a new blank tier inserted after the first source tier (each source keeps at least one cover). Remove (this is also "merge") moves the tier's covers into the tier above it, or into the next one when it is the first, and drops its text; the last tier cannot be removed. Ticking a cover on a tier moves it there; a tier's last cover cannot be unticked. Covers are kept in the fixed order banter, rude, hostile, severe, repeated, after_warning. The structure controls sit behind one disclosure inside the principles panel; the text fields do not.
5. **The prompt names only conduct levels in `(covers: ...)`.** A tier with no conduct-level cover (the presets' "After a warning") describes the record, not the lines, so it has no prompt line and is not counted as excluded.
6. **Line fitting.** A tier with no examples omits the ` Examples:` clause. Over 400 characters: drop examples from the last, then cut the description and end it with `...`, and as a last resort cut the whole line at 400. A flagged title makes the line `- (covers: <levels>)`. Examples are joined with `; `.
7. **The block is measured** as the tier lines and note lines joined by `\n`, headings excluded. Notes are kept as a prefix: the first note that does not fit and every one after it are dropped.
8. **`PolicyState.promptExcluded`** is `{ tiers: number[]; notes: number[]; capped: number[] }`: indexes into the effective `guidelines` and `teamNotes`; `notes` are the flagged ones, `capped` the ones dropped for length (the hub says how many). Optional on the type (older servers), always set by this one, computed in `get()` from the effective profile (so code-profile text is screened too). Not on the preview.
9. **Prompt placement.** A `MODERATION PRINCIPLES` heading between CONDUCT LEVELS and STANDARD, tier lines then note lines; one new TASK line in the shared base. The confirming read shares that text, so `AI_CONFIRM_PROMPT_VERSION` moves 1 to 2 as its own doc comment requires.
10. **`policyJson()` leaves `teamNotes` out**, as it leaves out the safety contact line: staff-only text does not ride a document built for tools. The moderator guide gets a `Team notes` section (heading only when there are notes), notes as `<text> (CR n)` with `, retired` when the rule is retired; the agent brief gets `Team notes:` lines; the code of conduct is untouched. Tier titles and examples already reach players through the code of conduct (0.2.1 behaviour); descriptions and outcomes do not.
11. **`aiContext` is not injection-screened** (it is owner prose that already sits in the prompt in 0.2.1); it is length-capped only.
12. **Setup visibility.** `show` is true only when the store can save settings, nothing was ever saved (`version` is 0: a reset counts as saved), the stored layer is readable and the flag is unset. A second dismissal keeps the first `dismissedAt`. A store error reads as "no flag" and a failed write falls back to the session, logged by class.
13. **Applying a recommendation merges onto the current layer**: it replaces `guidelines`, `firstOffense`, `repeat`, `ladder` and `aiContext` always (even when equal to the base, so the layer exists), leaves every other section alone, and for `creator` appends the note unless it is already there; other choices leave `teamNotes` alone.
14. **Routes.** A third route, `POST /setup/apply { game, version, reason? }`, carries the apply (so it is one audited, versioned save on the server). All three are the owner's, fixed in code like the privacy routes (`policy.read` plus an owner check), so they go in the scope table's denied list. Apply audits `policy.update` (default reason "Applied the recommended principles for <game> games"); the GET and the dismissal write no audit row. `GET /setup` carries the four options only while `show` is true.
15. **CLI.** `game` is absent from the answers unless given or answered. An answered or flagged game replaces the "Which standard?" question; its default answer is `social`. The CLI imports nothing from core, so the game-to-preset map and the creator note text are copies, pinned to core's by a test.
16. **Case view.** Detailed pane only (the Simple card is untouched), a collapsed disclosure, for roles that can read the policy. The level is the decision form's level, else the AI read's severity, else `hostile` (the ladder's own default); notes are those whose `rule` equals the case's rule and whose rule is not retired.
17. **First-run placement.** On the Overview and on the Simple home, above everything else, owner only; no default choice, and "Use these principles" stays off until one is picked.

## Review Focus

Each line has a named test in the task that owns the code (the brief lists it).

1. **The tier invariant while editing** (P6, P1). Add, split, remove and merge keep every cover in exactly one tier and every tier non-empty; Add refuses to empty a source tier; Remove of the first tier merges into the next and of the last remaining tier is refused; ticking a cover moves it, never copies it; Save is refused with a message that says which rule failed; whatever the hub sends, core refuses a duplicated cover, an empty `covers`, an uncovered level and an unknown cover with a path.
2. **An old-shape layer still works** (P1, P4, P6). A stored 0.2.1 `guidelines: [null, { outcome }]` reads, shows in the guide and in the editor, resets per section, and is replaced by the whole form on the next hub save; a layer holding both new sections plus the old shape in different saves never throws.
3. **The prompt stays free of outcomes and the caps hold** (P2). No tier `outcome` text appears in `prompt.stable` for any preset or custom tier; editing an outcome (or the ladder) leaves the stable text and the input hash unchanged; editing a description, an example or a note changes both; every tier line is at most 400 characters (astral characters counted once), the block at most 4,000, notes dropped last first, and the base instruction "Never name a penalty" is still there.
4. **Injection-flagged text is left out but every level keeps a line** (P2, P6). A flagged note is absent; a flagged tier (description or any example) keeps its title and covers; a flagged title keeps `(covers: ...)`; all four levels still appear in some line; the flag never refuses a save; the hub names what is not sent and how many notes were cut for length.
5. **A recommendation's single save makes ladder and principles match** (P3, P4, P7). One version bump; after it the effective `firstOffense`, `repeat`, `ladder`, `guidelines` and `aiContext` equal the preset's even over a different base; the creator note only for `creator`; a stale version is a 409 and writes nothing; other layer sections survive; the guide and brief read the new text on the very next call.
6. **The first-run panel is owner-only and hidden once any layer exists** (P3, P4, P7). The routes are 403 to a senior and a moderator even with every permission lowered, and to a scoped caller; the hub does not even ask for a non-owner; a saved layer of any section, a reset, an unreadable layer or a dismissal hides it; a store without the pair hides it for the session only.
7. **Team notes never reach players** (P2, P4). The three code-of-conduct formats and `GET /rules` are byte-identical with and without notes; `policyJson` carries none; note text is escaped in the guide (html) and one line in the brief and the prompt; a note linked to a retired rule is gone from a case but still in the guide.
8. **Note input hygiene** (P1, P6). Invisible-only and whitespace-only notes are refused, a 501-character note is refused (never cut), 30 notes fit and 31 do not, a bad `rule` (0, negative, fractional, text) is refused with its path, a rule that does not exist is refused at save but a retired one is accepted; error messages never echo note text.
9. **`init --game`** (P5). `--profile` wins over `--game` yet the creator note is still written; an unknown game names the flag and the values; the generated kit and service profile validate against core; every golden but the new one is unchanged byte for byte.
10. **A flagged tier or note shown to the wrong role** (P6, P7). Read-only roles see the editors disabled; the case disclosure shows tier and note text as plain text (never markup) and appears for no role without `policy.read`.

## Chunks and order

| Chunk | Tasks | What it holds | Review |
| --- | --- | --- | --- |
| 1 | P1, P2, P3 | core: whole-form tiers, `teamNotes`, layer-able `aiContext`; the prompt lines, caps, flags, version bump, documents; recommendations, the setup-state Store pair, policy service methods | R1 after chunk 2 |
| 2 | P4, P5 | http: policy routes, `/setup` routes and apply; `init --game` | R1 |
| 3 | P6, P7 | hub: principles, notes and `aiContext` editors; first-run panel, case disclosure, es and pt | R2 after chunk 4 |
| 4 | P8 | docs and 0.2.2 release prep | R2 |

Dependencies: P2 and P3 need P1; P4 needs P1 to P3; P5 needs P3 (the consistency test reads core's `GAME_KINDS`); P6 needs P1, P2 (`promptExcluded` type) and P4; P7 needs P3, P4 and P6 (shared i18n and types); P8 needs everything.

---

## Chunk 1: core

### Task P1: Whole-form tiers, `teamNotes`, layer-able `aiContext`

**Files:**
- Create: `packages/core/src/teamNotes.ts`
- Modify: `packages/core/src/profile.ts` (types, `TOP_KEYS`, `OPTIONAL_TOP_KEYS`, `validateProfile`, `finalize`, `withDurationDefaults`, `POLICY_SECTIONS`, `PolicyLayer`, `guidelinesOverride`, `layerToOverrides`), `packages/core/src/policy.ts` (`ruleExists` dependency and the note-rule check in `save`), `packages/core/src/chatwarden.ts` (wire `ruleExists`, check the code profile's notes at creation, doc comments), `packages/core/src/index.ts`
- Test: Create `packages/core/test/team-notes.test.ts`, `packages/core/test/policy-layer-principles.test.ts`; Modify `packages/core/test/policy-layer.test.ts`, `profile-compat.test.ts`, `audit-policy.test.ts` as the new sections require

**Interfaces:**
- Consumes: `settingsCheck.cleanText(v, path, min, max, oneLine)`, `ProfileError`, `validateGuidelines`.
- Produces: `interface TeamNote { text: string; rule?: number }`; `TEAM_NOTES_MAX = 30`; `TEAM_NOTE_MAX = 500`; `resolveTeamNotes(input: readonly TeamNote[] | undefined, path?: string): TeamNote[]`; `checkTeamNoteRules(notes: readonly TeamNote[], ruleExists: (n: number) => boolean, path: string): void`; `ModerationProfile.teamNotes?: TeamNote[]`; `ResolvedProfile.teamNotes: TeamNote[]`; `interface PolicyGuidelinesWhole { tiers: GuidelineTier[] }`; `PolicyLayer.guidelines?: Array<{ outcome: string } | null> | PolicyGuidelinesWhole`; `PolicyLayer.teamNotes?: TeamNote[]`; `PolicyLayer.aiContext?: string`; `POLICY_SECTIONS` ending `..., 'rooms', 'teamNotes', 'aiContext'`; exported caps `MAX_TIER_TITLE = 80`, `MAX_TIER_DESCRIPTION = 600`, `MAX_TIER_EXAMPLES = 8`, `MAX_TIER_EXAMPLE = 120`, `MAX_AI_CONTEXT = 2000`; `PolicyService` dependency `ruleExists?: (rule: number) => boolean`.

- [ ] **Step 1: Write the failing tests** (names in the brief): `team-notes.test.ts` (clean, trim, one line, 500 and 501, 30 and 31, bad entries and bad `rule`, no echo, frozen and defaulted `[]` on every preset, `checkTeamNoteRules` active and retired); `policy-layer-principles.test.ts` (whole form replaces tiers with 1, 2 and 6 tiers; every invariant refusal with its path; each cap at its edge; old shape unchanged; `aiContext` and `teamNotes` in a layer; section order; per-section reset; changed sections; `cw.policy.save` and the live guide; a missing rule refused at save and a retired one accepted; a code profile citing a missing rule fails at creation).
- [ ] **Step 2: Run red.** `npx vitest run packages/core/test/team-notes.test.ts packages/core/test/policy-layer-principles.test.ts`
- [ ] **Step 3: Implement** the signatures above. The whole form is turned into the same array the old shape produces in `guidelinesOverride`, so `finalize` and `validateGuidelines` judge both; `ruleExists` defaults to "any rule exists" when not given.
- [ ] **Step 4: Run green**, plus the dependents listed in the brief; `npm run typecheck`; `npm run lint`.
- [ ] **Step 5: Commit** (pathspecs; new files added first).

### Task P2: The prompt lines, caps, flags, version bump, documents

**Files:**
- Create: `packages/core/src/principles.ts`
- Modify: `packages/core/src/ai/prompt.ts` (`aiPolicyText`, one line of `BASE`), `packages/core/src/ai/types.ts` (both versions and their doc comments), `packages/core/src/policy.ts` (`PolicyState.promptExcluded`, `get()`), `packages/core/src/documents.ts` (guide, brief, `policyJson`), `packages/core/src/index.ts`
- Test: Create `packages/core/test/principles.test.ts`, `packages/core/test/ai/prompt-principles.test.ts`, `packages/core/test/documents-principles.test.ts`; Modify `test/ai/contract.test.ts`, `test/ai/appeals-feed.test.ts`, `test/ai/signals-input.test.ts` (the pinned 5), and any snapshot that holds the stable text

**Interfaces:**
- Consumes: P1's `ResolvedProfile.teamNotes`, `looksLikeInjection`, `cleanText` (`ai/redact.ts`).
- Produces: `PRINCIPLES_LINE_MAX = 400`; `PRINCIPLES_BLOCK_MAX = 4000`; `interface PromptExcluded { tiers: number[]; notes: number[]; capped: number[] }`; `interface PromptPrinciples { lines: string[]; excluded: PromptExcluded }`; `promptPrinciples(profile: { guidelines: readonly GuidelineTier[]; teamNotes?: readonly TeamNote[] }): PromptPrinciples`; `PolicyState.promptExcluded?: PromptExcluded`; `AI_PROMPT_VERSION = 6`; `AI_CONFIRM_PROMPT_VERSION = 2`; `ModeratorGuide` gains a `Team notes` section; `agentBrief()` gains `Team notes:`.

- [ ] **Step 1: Write the failing tests** (the brief names them): exact line format for the three presets, no outcome text anywhere in `prompt.stable`, outcome and ladder edits leave stable and hash alone, description/example/note edits change them, the 400 and 4,000 caps at their edges with astral characters, flagged tier, flagged title, flagged example, flagged note, every level keeps a line, `promptExcluded` arrays, documents (guide, brief, html escaping, retired-rule suffix, code of conduct byte-identical, `policyJson` without notes).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.** `promptPrinciples` is pure and is the only place the lines and the flags are decided; `aiPolicyText` and `PolicyService.get()` both call it.
- [ ] **Step 4: Run green**, the AI dependents listed in the brief, `scripts/ai-seam.test.ts`; typecheck and lint.
- [ ] **Step 5: Commit.**

### Task P3: Recommendations, the setup-state Store pair, the policy service methods

**Files:**
- Create: `packages/core/src/recommend.ts`, `test/contract/setup.contract.ts`, `packages/store-sqlite/test/setup-state.test.ts`
- Modify: `packages/core/src/types.ts` (Store pair, `SetupState`), `packages/core/src/policy.ts` (`setup`, `dismissSetup`, `applyRecommendation`), `packages/core/src/chatwarden.ts` (facade `cw.policy.setup/dismissSetup/applyRecommendation`), `packages/core/src/index.ts`, `packages/store-sqlite/src/sqliteStore.ts`, `packages/store-memory/src/memoryStore.ts`, `test/contract/index.ts`, `packages/store-sqlite/test/sql-placeholders.test.ts`
- Test: Create `packages/core/test/recommend.test.ts`, `packages/core/test/policy-setup.test.ts`

**Interfaces:**
- Consumes: P1 (`PolicyLayer` whole form, `teamNotes`), `PolicyService.save`.
- Produces: `GAME_KINDS = ['competitive', 'social', 'kids', 'creator'] as const`; `type GameKind`; `GAME_PRESET: Readonly<Record<GameKind, PresetName>>`; `CREATOR_TEAM_NOTE = 'Protect the creator and their guests from targeted abuse'`; `interface Recommendation { game: GameKind; preset: PresetName; layer: PolicyLayer }`; `isGameKind(v: unknown): v is GameKind`; `recommendFor(game: GameKind): Recommendation` (a fresh JSON-clean copy; `RangeError` for an unknown game); `interface SetupState { dismissedAt: number | null }`; `Store.getSetupState?(): SetupState | null`; `Store.saveSetupState?(state: SetupState): void`; `interface PolicySetup { show: boolean; dismissedAt: number | null; persists: boolean }`; `cw.policy.setup(): PolicySetup`; `cw.policy.dismissSetup(): PolicySetup`; `cw.policy.applyRecommendation(game: GameKind, ctx: PolicySaveContext): PolicySaveResult` (invalid game: `{ ok: false, error: 'invalid', path: 'game' }`).

- [ ] **Step 1: Write the failing tests** (the brief names them): the shared store contract (both stores), the SQLite file test (persists across reopen, key `setup_state`, tolerant of a corrupt value, no migration added), the placeholder test, `recommendFor` for all four (applied over a different base the effective ladder, first offences, repeat, tiers and `aiContext` equal the preset's), the setup visibility matrix, apply (one version bump, merge, creator append without duplicate, stale version, unknown game).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.** SQLite: `INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)` and a one-row read, both as exported SQL constants; memory: a field set through `undoWith` like `savePolicyLayer`.
- [ ] **Step 4: Run green**, both store contract files, the policy dependents; typecheck and lint.
- [ ] **Step 5: Commit.**

---

## Chunk 2: http

### Task P4: Policy routes, the setup routes and apply

**Files:**
- Create: `packages/http/src/admin/setup.ts`, `packages/http/test/admin.setup.test.ts`, `packages/http/test/player.principles.test.ts`
- Modify: `packages/http/src/admin/policyProfile.ts` (export `answer`, update the route comment: sections, whole form, `promptExcluded`), `packages/http/src/admin/policy.ts` (comment only), `packages/http/src/admin/index.ts`, `packages/http/test/admin.policy-profile.test.ts`, `admin.every-route.test.ts`, `admin.scope-routes.test.ts`
- Interfaces:
  - Consumes: P1 to P3 (`cw.policy.setup/dismissSetup/applyRecommendation`, `recommendFor`, `GAME_KINDS`).
  - Produces: `GET /setup` answering `{ show: boolean; dismissedAt: number | null; persists: boolean; version: number; options: Recommendation[] }` (`options` is `[]` unless `show`); `POST /setup/dismiss` answering `{ ok: true; show: false; dismissedAt: number; persists: boolean }`; `POST /setup/apply { game, version, reason? }` answering the same body as `PUT /policy/profile` (`ok`, `changed`, the state, `version`); `PUT`, `GET` and `DELETE /policy/profile` accept the new shapes and sections with no code change beyond the comments (the proof is the tests).
- [ ] **Step 1: Write the failing tests** (the brief names them): owner-only matrix for the three routes (senior, moderator, scoped, no authz, every permission lowered), the bodies and keys, apply audited as `policy.update`, stale 409, bad body 400, persisted dismissal, the policy-profile additions (whole form, notes, `aiContext`, old shape, reset sections, `promptExcluded`, the guide with notes), the two tables, and the player routes carrying no note, description or outcome.
- [ ] **Step 2: Run red.** `npx vitest run packages/http/test/admin.setup.test.ts packages/http/test/player.principles.test.ts`
- [ ] **Step 3: Implement** `setupRoutes(ctx)` with the privacy routes' owner check (`policy.read` plus `requireOwner`); register it after `policyProfileRoutes`.
- [ ] **Step 4: Run green**, the dependents in the brief; typecheck and lint.
- [ ] **Step 5: Commit.**

### Task P5: `chatwarden init --game`

**Files:**
- Modify: `packages/http/src/cli/args.ts` (`OPTIONS`, `Parsed`), `types.ts` (`GameChoice`, `Answers.game?`, `ServiceAnswers.game?`), `answers.ts` (map, `QuestionName`, `isAsked`), `index.ts` (`QUESTIONS`, `questionFor`), `service.ts`, `plan.ts`, `templates/kit.ts`, `templates/service.ts`, `packages/http/test/cli-args.test.ts`, `cli-answers.test.ts`, `cli-templates.test.ts`, `cli-templates-js.test.ts`, `cli-run.test.ts`, `cli.service-golden.test.ts`
- Create: `packages/http/test/cli-game.test.ts`, `examples/service/cases/creator/` (generated)
- **Interfaces:**
  - Consumes: P3 (`GAME_KINDS`, `GAME_PRESET`, `CREATOR_TEAM_NOTE`, read by the consistency test only; the CLI itself imports nothing from core).
  - Produces: flag `--game competitive|social|kids|creator`; `Parsed.game?: GameChoice`; `Answers.game?: GameChoice`; the first interactive question "What kind of game is this?" (default `social`); the generated kit passing `overrides: { teamNotes: [{ text: '<note>' }] }` for `creator`; the service `profile.json` with a `teamNotes` key for `creator`.
- [ ] **Step 1: Write the failing tests** (the brief names them), including the new golden case in `cli.service-golden.test.ts`.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement**; regenerate only the new golden with `UPDATE_GOLDEN=1` and check `git status` shows the other cases unchanged.
- [ ] **Step 4: Run green** (the CLI files in the brief); typecheck and lint.
- [ ] **Step 5: Commit.**

---

## Chunk 3: the hub

### Task P6: The principles, team notes and `aiContext` editors

**Files:**
- Create: `packages/hub-react/src/policy/principles.ts` (pure tier and note model), `packages/hub-react/src/policy/PrinciplesPanel.tsx`, `packages/hub-react/src/policy/NotesPanel.tsx`, `packages/hub-react/src/policy/standard.ts`, `packages/hub-react/src/screens/StandardSettings.tsx`
- Modify: `policy/model.ts` (draft, `draftOf`, `setSection`, `sectionKey`, `problemsOf`, `layerOf`, `fieldKeyOf`, `SECTION_ORDER`), `policy/panels.tsx` (replace `GuidelinesPanel`), `policy/useResetFlow.ts` (`notes`, `standard`), `screens/LadderSettings.tsx`, `screens/AdvancedSettings.tsx`, `lazyParts.tsx`, `auditLabel.ts`, `i18n.ts`, `locales/es.ts`, `locales/pt.ts`, `types.ts` (re-export `TeamNote`, `PromptExcluded`), the hub README lists the readme tests check
- Test: Create `packages/hub-react/test/policy/principles-model.test.ts`, `principles-panel.test.tsx`, `notes-panel.test.tsx`, `standard-settings.test.tsx`; Modify `policy/model.test.ts`, `ladder-settings.test.tsx`, `audit-label.test.ts`
- **Interfaces:**
  - Consumes: P1 types and caps, P2's `PolicyState.promptExcluded`, P4's routes.
  - Produces: `interface TierDraft { title; description; examples: string; covers: GuidelineCover[]; outcome }`; `interface NoteDraft { text: string; rule: string }`; `ALL_COVERS`; `type TierEdit = { ok: true; tiers: TierDraft[] } | { ok: false; reason: 'none_chosen' | 'unknown_cover' | 'empty_source' | 'last_tier' }`; `addTier(tiers, covers): TierEdit`; `removeTier(tiers, index): TierEdit`; `moveCover(tiers, cover, to): TierEdit`; `tierProblems(tiers): Record<string, Problem>`; `PolicyDraft.guidelines: TierDraft[]` and `PolicyDraft.teamNotes: NoteDraft[]`; reset keys `notes` (section `teamNotes`) and `standard` (section `aiContext`); field keys `guide-<i>-<field>`, `guide-covers`, `note-<i>-text`, `note-<i>-rule`, `standard`.
- [ ] **Step 1: Write the failing tests** (the brief names them): the pure model first, then the panels over the same world as `ladder-settings.test.tsx`.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.** Text fields visible in the existing "guidelines" slot of the Steps and ladder screen, now titled "Moderation principles"; the structure controls behind one disclosure; the notes panel below it; the `aiContext` panel a lazy Advanced panel built on `useSectionEditor`.
- [ ] **Step 4: Run green** (the files in the brief, the four `locales.*` tests, the readme tests); typecheck and lint.
- [ ] **Step 5: Commit.**

### Task P7: The first-run panel, the case disclosure, es and pt

**Files:**
- Create: `packages/hub-react/src/setup/FirstRun.tsx`, `src/setup/summary.ts`, `src/setupHooks.ts`, `src/case/CasePrinciples.tsx`, `src/case/principles.ts`
- Modify: `client.ts` (`setup`, `dismissSetup`, `applySetup`), `types.ts` (`SetupState`, `SetupOption`), `lazyParts.tsx`, `screens/Overview.tsx`, `screens/SimpleHome.tsx`, `screens/Report.tsx`, `i18n.ts`, `locales/es.ts`, `locales/pt.ts`, README lists
- Test: Create `packages/hub-react/test/first-run.test.tsx`, `case-principles.test.tsx`, `a11y-setup.test.tsx`; Modify `api.test.ts`
- **Interfaces:**
  - Consumes: P3 and P4 (`GET /setup`, `POST /setup/dismiss`, `POST /setup/apply`), P6's i18n and types.
  - Produces: `HubClient.setup(): Promise<SetupState>`; `HubClient.dismissSetup(): Promise<{ ok: true; show: false; dismissedAt: number; persists: boolean }>`; `HubClient.applySetup(input: { game: GameKind; version: number }): Promise<PolicySaved>`; `tierForLevel(tiers, level): GuidelineTier | null`; `notesForRule(notes, rule, rules): TeamNote[]`; `caseLevel(picked: ConductLevel | null, aiSeverity: ConductLevel | undefined): ConductLevel`; `ladderSummary(option: SetupOption, t: HubT): string`.
- [ ] **Step 1: Write the failing tests** (the brief names them): owner-only (no request at all for a non-owner), the choices and the preview, apply, conflict, dismiss, nothing rendered while loading or when `show` is false, focus, axe; the case disclosure for each case in Review Focus 10; the client shapes.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** (the panel is a lazy part; no default choice).
- [ ] **Step 4: Run green** (the files in the brief, locales, readme, size); typecheck and lint.
- [ ] **Step 5: Commit.**

---

## Chunk 4: docs and release

### Task P8: Docs and 0.2.2 release prep

**Files:**
- Create: `.changeset/<name>.md` (patch, all ten packages, upgrade notes naming each raised floor and the API that forced it, and the prompt version note)
- Modify (by `npm run version` and by hand): the ten `package.json` and `CHANGELOG.md`, `package-lock.json`, `packages/*/src/version.ts` through `scripts/sync-version.mjs`, `examples/tiny-chat/package.json`, `services/corpus/package.json` (the matcher pin), the peer ranges above, `scripts/manifests.test.ts` (`RAISED`), `scripts/changelog.test.ts` (a 0.2.2 block), the package READMEs, `docs/status.md`, `docs/plans/follow-ups.md`, `site/public/llms.txt`, `RELEASING.md` (the floors sentence)
- **Interfaces:** Consumes everything; produces the release commit.
- [ ] **Step 1: Write the failing checks** (`manifests.test.ts` expects the new floors; `changelog.test.ts` expects a 0.2.2 section above 0.2.1 in all ten, saying additive, no new migration, the prompt version 6 note, and the Store list `getSetupState` and `saveSetupState`).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Changeset, then `npm run version`; set the floors by hand BEFORE it; fix pins; READMEs, status, llms.txt, follow-ups.**
- [ ] **Step 4: Gates, with everything built:** `npm run build`, `npm run check:pack`, `node scripts/smoke.mjs`, the size tests by path, the script tests by path, typecheck and lint.
- [ ] **Step 5: Commit.** No tag, no push, no merge: publishing is the owner's.

## Self-review

- **Spec coverage:** 2 goals (editor: P1, P6; notes: P1, P6; used everywhere: P2, P7; recommended at setup: P3, P4, P5, P7), 3.1 to 3.5 (P1, P2, P3, P7), 5.1 (P1, P6), 5.2 (P2, P8), 5.3 (P1), 5.4 (P3, P4, P7), 5.5 (P3, P4, P7), 5.6 (P5), 5.7 (P2, P6), 5.8 (P1, P2, P7), 5.9 is out of scope (non-goal), release (P8).
- **Names:** `TeamNote`, `PolicyGuidelinesWhole`, `PromptExcluded`, `PromptPrinciples`, `promptPrinciples`, `GameKind`, `GAME_KINDS`, `GAME_PRESET`, `CREATOR_TEAM_NOTE`, `Recommendation`, `recommendFor`, `SetupState`, `PolicySetup`, `getSetupState`, `saveSetupState` are defined once (P1 to P3) and used by those names afterwards; the hub names (`TierDraft`, `NoteDraft`, `TierEdit`) are defined in P6 and used in P7 only through i18n and types.
- **Proportion:** the briefs hold the test lists, exact strings and commands; this document holds the decisions.
