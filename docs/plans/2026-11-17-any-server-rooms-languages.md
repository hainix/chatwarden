# Any server, many rooms, more languages (0.2.0) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** a game server in any language can moderate chat through a versioned, authenticated HTTP service that the kit runs from one
container recipe (a C# sample client included), and pacing agrees between processes through the store. Rooms can carry rules by a tag
(profanity, pace, phrase-only, minimum account age); a moderator can be limited to a set of rooms; players can block each other; a game
can protect staff names and ask about clan names. Spanish and Portuguese words (machine-drafted, marked so) load on demand for the
player components and the hub, and terms in Chinese, Japanese, Thai, Lao, Khmer and Burmese match without a space.

**Architecture:**
- `@chatwarden/http` gains the subpath `./service` (`serviceRoutes`, `createServiceClient`, `SERVICE_OPENAPI`) and two bin commands,
  `chatwarden serve` and `chatwarden init --service`. No new package; the process dynamically imports the other packages from the
  project it runs in.
- `@chatwarden/core` gains `contexts.ts` (profile `contexts`, tag grammar, `cw.contexts`), `phrases.ts` (books, `acceptPhrase`),
  blocks inside `mutes.ts` (`cw.blocks`), `paceDecide.ts` and `pacingShared.ts` (the shared pacer), room scope on `Authz`-facing
  queries, `names` additions (`reserved`, `kind`, `name_reserved`) and `ReportInput.entity`.
- Optional `Store` methods and the one SQLite migration **26** of the release (this plan's blocks: `kit_pace`, `kit_mutes.block`,
  `kit_reports.scope` and `entity_json`, `kit_terms.match_mode`). Memory and SQLite, shared contract suites.
- `@chatwarden/matcher` gains the unspaced-script path (`unspaced.ts`), `skeleton`, `matchMode`.
- `@chatwarden/player-react` and `@chatwarden/hub-react` gain `locales/es` and `locales/pt` (lazy subpaths), `matchLocale`,
  `loadPlayerT`, locale loading in `HubProvider`; the chat box gains Block and the phrase picker; the hub gains a context chip, a
  read-only contexts list, an entity row, two names textareas and a Match choice on Add term.

**Spec:** `docs/design/2026-11-17-any-server-rooms-languages.md` (section numbers below refer to it), including its Rulings.
Also binding: `docs/design/2026-11-17-moderation-coverage-audit.md`, `docs/design/2026-11-12-k4b-adoption.md` (the CLI rules, the fetch
adapter), `docs/design/2026-11-12-flood-control-and-signals.md` (pacing) and `docs/design/2026-11-12-appeals-and-names.md` (names).

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly`, every time from the injected
  `Clock` (no `Date.now()`), synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn; for the unspaced
  scripts the same rule: invented strings, never a real slur, in every test, fixture and example), test-first, targeted runs only,
  `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree: commit by pathspec, `git add`
  new files first.
- **Release context.** This is 0.2.0, with no adopters: no compatibility shims and no byte-parity tests against 0.1.14; the
  "Breaking changes" of spec 12 are the only deliberate type or wire changes, and each is listed in the task that makes it. New names
  ship **without** `@experimental`.
- **Text chat only.** No image, media or voice work anywhere in this plan.
- **One migration.** The release has exactly one new migration, version **26**, shared with the other themes. Step 0 checks whether
  another theme has already created `version: 26` in `packages/store-sqlite/src/migrations.ts`: if so, append a labelled block to its `sql`
  (`-- any-server-rooms-languages: <table>`); if not, create it with only your block. Never add 27. The migration tests of this plan assert
  their own columns and tables only (so the order of the themes does not matter), plus "a 25 database upgrades and a rerun is refused".
- **No new package.** `scripts/manifests.test.ts` still lists ten published packages; `check-pack` must still pass (the new subpath and
  the `serve` bin are in the tarball; `examples/` is not).
- `@chatwarden/core`, `matcher`, `store-memory`, `hub-*`, `player-react` stay browser-safe: no `node:` import, no `fetch`.
  `@chatwarden/http/service` (except `node.ts` and `serve.ts`, which are reached only by the bin) stays browser-safe too; a test pins
  that `scripts/browser-bundle.test.ts` budgets hold and that no browser-safe entry reaches `node.ts` or `serve.ts`.
- **Off means unchanged.** With `contexts`, `phrases`, `sharedPacing`, `names.reserved`, scope and unspaced terms all unset, each
  task's core tests prove the existing verdicts, events and bodies are what 0.1.14 gives, apart from spec 12.
- **Nothing identifying leaves.** No `/v1` body, log line, event or Discord post holds a subject, person, hash, key, `who`, line, name or
  phrase. A spy logger in S1, S2 and S5 asserts event names and error classes only.
- **Hub budget.** Everything this plan adds to hub-react is loaded on demand (the contexts list, the entity row, the Match choice and
  the locale catalogues); eager code is types, client calls and the chip. `packages/hub-react/test/size.test.ts` runs in every hub task
  and the budget is read after Step 0, not assumed.
- **UI rule (clean core, power behind one door).** Always visible: nothing new. Conditional: the context chip (a context exists), the
  entity row (a report has one), the Match choice (an unspaced term is typed), the phrase picker (a phrase-only room), Block inside the
  existing line `...` menu. Everything else is in Settings > Advanced or code. No new colour. Every string through `t()`. Check in a real
  browser at desktop and 360 px, light and dark, for M3, M4, M5, M6 and L2.
- **Machine translation.** Nothing in L3 or L4 may claim a review. `meta.status` is `'machine-draft'`; the tests of spec 5.1 enforce it.
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no image build, no site deploy without the maintainer's
  go-ahead. There is no release-preparation task in this plan.

## Review Focus
Failure modes no happy-path test would exercise; each has its test in the owning task.
1. **A scope leak.** A route, a count, a claim, the changes feed or a person page that shows a scoped moderator something outside their
   scope, or confirms it exists (403 instead of 404); a route added later that nobody marked. M2 (table-driven over the route table),
   M3.
2. **A retried line judged twice.** Idempotency with and without the key, a refusal replayed, two concurrent calls with one key, a key
   reused for another body, a 5xx not stored, the key never in a log. S1, S2.
3. **Shared pacing races and failure.** Two processes committing for one player (both counted), a flood signalled once per window across
   processes, a store that throws (fail open, logged by class), a guest key, a stepped-back clock, the sweep removing a live row. S3, S4.
4. **Damage in the unspaced path.** NFKD dropping Japanese voiced marks and Thai vowel signs, spans that do not map back to the typed
   text, a segmenter that is missing, a term that matches inside an innocent compound, a Latin term and a Han term in one line. L1.
5. **Block visibility and honesty.** History already on a screen, the blocked person's stream, `hiddenFor`, merges, the cap that must
   never drop a block; and a catalogue or a refusal sentence that claims more than it knows (a "reviewed" label, a wrong plural). M4, L3, L4.

## Order and parallelism
Step 0 (migration 26 check; confirm the base builds) first. **M1 first** among everything that touches rooms (it owns the tag
grammar). Then three lanes can run at once:
- Service lane: S1, then S2 (after M1), then S5, then S6. S3 then S4 (shared pacing) run beside S1 and S2, and S5 needs both lanes.
- Rooms lane: M1, then M2, then M3; M4, M5 and M6 follow M1 (M5 also follows M2 only for the scope tag in its test) and can run at
  once; M7 is last.
- Languages lane: L1 then L2; L3 then L4. The two sub-lanes are independent of everything else.
M5, M6 and M4 each add one route to the service: whoever lands after S2 adds the route; if S2 is not in yet, the route work waits
for it (each task says so).

---

### Task M1: Contexts and the room tag grammar
Spec 4.1. Start here for rooms.
- **Files:** `packages/core/src/contexts.ts` (new: `ContextSettings`, `ResolvedContexts`, `resolveContexts`, `CONTEXT_SECTIONS =
  ['profanity', 'pace', 'chat']`, `checkRoomTags`, `ROOM_TAG_KEYS`), `packages/core/src/profile.ts` (`TOP_KEYS` and optional keys gain
  `contexts`; `ModerationProfile.contexts?`; `ResolvedProfile.contexts`; **not** in `POLICY_SECTIONS`; `applyLayer` carries it unchanged;
  a layer that names it is refused with its path), `packages/core/src/chatwarden.ts` (`cw.contexts = { names, of, effective }`;
  `cw.rooms.seat` and `seatConnection` call `checkRoomTags`; the per-room settings functions `paceOf` and the profanity mode read the
  room's context; the `accountAgeDays` check), `packages/core/src/chat.ts` (`RefuseReason` gains `account_too_new`; a room whose
  context is unknown refuses `gate` and logs `chatwarden.context_unknown` once per room; the per-room profanity mode and the age
  gate), `packages/core/src/evidence.ts` (`RoomRoster.tag(roomId, key)`; a second `seat` that changes `context` throws `RangeError`),
  `packages/core/src/index.ts`, tests `packages/core/test/contexts.test.ts`, `contexts-chat.test.ts`, `contexts-matrix.test.ts`,
  `room-tags.test.ts`.
- **Interfaces (Produces):** `cw.contexts.names(): string[]`; `cw.contexts.of(roomId): string | null` (the validated tag);
  `cw.contexts.effective(name | null): { profanity: ProfanityConfig; pace: ResolvedPace; chat: { phrases: string | null;
  minAccountAgeDays: number | null } }` (pure; the base when null; `ProfileError` for an unknown name); `checkRoomTags(tags)` throwing
  `RangeError` for a bad `context` or `scope` value, more than 8 keys, a bad key or a value over 64 characters. `CONTEXT_SECTIONS` is
  the single list the filters theme extends (spec 13).
- **Behaviour:** precedence is code, stored layer, context, `setPace` override (spec 4.1). The merged context is cached per name and
  dropped when the live profile object changes. `chat.phrases` is validated against the phrase books in M5 (here it only has to be a
  well-formed id). A context's `pace` merges with `mergePace`; its `profanity` merges key by key, arrays replacing.
- **Tests (names):**
  - `defaults: no contexts, cw.contexts.names() is empty, a room with no context tag uses the base`; `a layer that names contexts is refused with the path layer.contexts`
  - `context names: 'kids' and 'a1_b-2' accepted; '', 'Kids', '1kids', 33 characters and 21 contexts refused with the path, never echoing a value`
  - `unknown keys inside a context refused with their path (contexts.kids.pace.slowModeMs for a bad value, contexts.kids.ladder for a closed key)`
  - `label 1..40; minAccountAgeDays 1 and 365 accepted, 0, 366, 2.5, NaN, a string refused; phrases must be a well-formed id or null`
  - `profanity override merges: mode set, style inherited; add replaces the base array whole; remove and only the same`
  - `pace override: slowModeMs set, burst inherited; null turns a base check off; the pacer holds nothing for a room whose context turns every check off`
  - `precedence: a hub layer change to the base pace reaches a context that does not override pace and does not move one that does; setPace beats the context; close drops the override but keeps the tag rules`
  - `a room tagged with an undeclared context: every line is refused gate and one chatwarden.context_unknown is logged per room, not per line; a throwing gate hook still fails closed first`
  - `a malformed context tag at seat throws RangeError and seats nobody; changing a room's context on a later seat throws; scope tag grammar the same (checked here, used in M2)`
  - `tags: 9 keys, a key that starts with a digit, a 65-character value, a non-string value all refused; the reserved keys are context and scope; other keys pass through to the report's tags`
  - `minAccountAgeDays: an account older than the limit speaks; younger, a guest, and an accountAgeDays that returns null or throws are refused account_too_new (fail closed), once per line, no strike`
  - `chat.accept in a refuse-mode context refuses swearing that the base profile stars; the same line in the base is starred`
  - `contexts-matrix: for presets relaxed, standard and strict, three contexts and the base, a table of 12 lines (clean, swearing, slur, repeat, burst, long) gives the verdict of an equivalent whole profile` (differential)
  - `cw.contexts.effective returns frozen values that share nothing with the profile; an unknown name throws ProfileError`
  - `with no contexts the existing chat, pacing and rooms suites are unchanged` (existing suites green)
- **Run:** `npx vitest run packages/core/test/contexts.test.ts packages/core/test/contexts-chat.test.ts packages/core/test/contexts-matrix.test.ts packages/core/test/room-tags.test.ts packages/core/test/chat.test.ts packages/core/test/pace.test.ts packages/core/test/profile.test.ts`

### Task M2: Staff scope, in the store reads
Spec 4.2. Needs M1 (the tag grammar). Core, both stores, http; the hub is M3.
- **Files:** `packages/core/src/types.ts` (`ReportRecord.scope: string | null`, `ReportListQuery.scope?: readonly string[]`,
  `OpenReportQuery.scope?`, `ReportRecord.entity` is M6), `packages/core/src/reports.ts` (stamp `scope` from the room's tag at filing),
  `packages/core/src/staffViews.ts` and `packages/core/src/staffReports.ts` (every staff read takes an optional `scope`; the person
  history read is `scopedHistory`), `packages/store-memory/src/memoryStore.ts`, `packages/store-sqlite/src/sqliteStore.ts` and
  `migrations.ts` (migration 26 block 3: `kit_reports.scope`, the index, the backfill), `test/contract/reports.contract.ts` (scope cases),
  `packages/http/src/types.ts` (`Authz.scope?`), `packages/http/src/auth.ts` (`isAuthz` validates scope: 1..20 labels of the grammar,
  never with `owner`), `packages/http/src/admin/context.ts` (`ctx.secure(permission, handler, { scoped: true })`; an unflagged route is
  403 for a scoped caller; `AdminCall.scope`), the scope-aware routes (`reports.ts`, `team.ts`, `people.ts`, `sanctions.ts`, `me.ts`),
  `packages/http/src/admin/index.ts` (`AdminOptions.scopedLimits?: { kinds, maxDurationMs }`), tests
  `packages/core/test/scope-reports.test.ts`, `packages/store-sqlite/test/scope.migration.test.ts`, `packages/http/test/admin.scope.test.ts`,
  `admin.scope-routes.test.ts`.
- **Interfaces (Produces):** `Authz.scope?: readonly string[]`; `ctx.secure(..., { scoped: true })`; `GET /me` answers `scope` and a `can[]`
  trimmed to scope-aware permissions; `Store.listReports`, `listOpenReports` and a new `loadReportInScope(id, scope)` apply the filter;
  `SCOPED_DEFAULT_LIMITS = { kinds: ['warning', 'chat'], maxDurationMs: 7 days }`.
- **Behaviour:** the filter is `scope IN (...)` in the query (SQLite uses `kit_reports_by_scope`), not a post-filter; a report with a
  null scope is invisible to a scoped caller; global callers are unchanged. Out of scope is 404 `not_found` on every id route. The
  scoped person history returns reports in scope and the sanctions whose `reportId` is one of them, with no account ids, signals or
  linked-account fields. A scoped `POST /sanctions` and `decide` refuse another kind, a longer length, a permanent one, or a `reportId`
  out of scope (400 `invalid_sanction` for the first three, 404 for the last).
- **Tests (names):**
  - `migration 26 block: a 25 database upgrades; kit_reports.scope exists with kit_reports_by_scope; the backfill copies tags.scope and leaves rooms with none NULL; a rerun is refused`
  - `a report filed in a room tagged scope creator:alice stores the scope; a room with none stores NULL; a room whose scope changes mid-life is refused by M1`
  - `listReports and listOpenReports with scope return only matching rows, in the same order and cursor as unscoped; two scopes OR together; an empty list returns nothing; EXPLAIN QUERY PLAN uses kit_reports_by_scope` (contract, memory and sqlite)
  - `a store that ignores scope fails the contract` (the contract is the test; a deliberately broken stub store in the suite)
  - `isAuthz: scope of 1 and 20 labels accepted; 0 labels, 21, a label with a space or 65 characters, a non-array, a non-string label and role owner with a scope are 401`
  - `a global caller (no scope) sees every report exactly as before; an unscoped report is invisible to a scoped caller; a report in scope appears in the queue, take next and changes counts`
  - `out of scope: GET /reports/:id, decide, suggest, claim, release and viewing all answer 404 with the body of an unknown id, and the same time class`
  - `table-driven: every route in the admin table is either marked scoped or answers 403 to a scoped caller; adding a route without a flag fails this test` (the guard for later themes)
  - `scoped person history: only in-scope reports and their sanctions; no accountIds, signals or links keys in the body; a person with nothing in scope is 404`
  - `scoped sanction: warning 7 days with an in-scope reportId accepted; area, ban, permanent, 8 days, no reportId and an out-of-scope reportId refused; scopedLimits widens or narrows it`
  - `scoped revoke only for a sanction that came from an in-scope report; a direct sanction is 404`
  - `GET /me for a scoped caller lists scope and only the scope-aware permissions; for a global caller it is unchanged`
  - `settings, terms, blocked, names, rename, handles, audit, appeals, ai, gaps, bulk dismissal and the community routes are 403 for a scoped caller`
  - `a spy logger sees no scope label, no actor and no report id in any log line of a refused call`
- **Run:** `npx vitest run packages/core/test/scope-reports.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/scope.migration.test.ts packages/store-sqlite/test/contract.test.ts packages/http/test/admin.scope.test.ts packages/http/test/admin.scope-routes.test.ts packages/http/test/auth.test.ts`

### Task M3: Hub: the context chip, the contexts list, scope in the hub
Spec 4.6. Needs M1 and M2.
- **Files:** `packages/http/src/admin/policy.ts` or a new `contexts.ts` (`GET /policy/contexts`, `policy.read`, not scope-aware: name,
  label, `overrides: string[]`), `packages/http/src/admin/reports.ts` (`context` on the report detail and row, from `tags.context`),
  `packages/hub-react/src/types.ts` and `client.ts` (`HubClient.contexts()`, `ReportDetail.context`, `Me.scope`),
  `packages/hub-react/src/case/CaseContext.tsx` (the chip), `packages/hub-react/src/policy/RoomContexts.tsx` (lazy; the read-only list in
  Settings > Advanced), `packages/hub-react/src/i18n.ts` (`hub.case.context`, `hub.settings.contexts.*`, 6 keys), tests
  `packages/http/test/admin.contexts.test.ts`, `packages/hub-react/test/case-context-chip.test.tsx`, `contexts-panel.test.tsx`,
  `a11y-contexts.test.tsx`, `size.test.ts` unchanged.
- **Behaviour:** the chip shows `label` (or the name) only when `GET /policy/contexts` lists at least one context and the report's
  `context` is set; one context declared and used in every room still shows it (the room kind is information); with none declared
  nothing renders and no request is made. The list is read-only and says contexts are set in code; a scoped caller sees no Settings
  entry (403 by M2, hidden by `can[]`). The preview theme reads `/policy/contexts` too (spec 13).
- **Tests (names):**
  - `GET /policy/contexts: names, labels and overridden sections, no values; empty list when none; policy.read needed; 403 for a scoped caller`
  - `report detail carries context for a tagged room and null otherwise; an undeclared context name is carried as written (the chip shows it)`
  - `the chip appears only when a context is declared and the report has one; it shows the label; with none declared the chip and the request are absent`
  - `the contexts list renders name, label, sections; empty state names the code place to declare them; no edit control exists`
  - `lazy: no contexts-panel code in the main chunk`; `axe: chip and list, desktop and 360 px, light and dark`; `size budget holds`
- **Run:** `npx vitest run packages/http/test/admin.contexts.test.ts packages/hub-react/test/case-context-chip.test.tsx packages/hub-react/test/contexts-panel.test.tsx packages/hub-react/test/a11y-contexts.test.tsx packages/hub-react/test/size.test.ts`

### Task M4: Block
Spec 4.3. Needs M1 (room tags are not used; the dependency is the order only) and, for the service route, S2.
- **Files:** `packages/core/src/types.ts` (`MuteRow.block: boolean`; `Store.upsertMute` takes it), `packages/core/src/mutes.ts`
  (`MuteService` keeps the kind; `set(viewer, target, on, kind)`; `isBlocked`, `blockedSeats`; the cap drops the oldest mute first and
  never a block; `loadMutes` keeps blocks past the TTL), `packages/core/src/chat.ts` (`visibleTo` is two-way for a block),
  `packages/core/src/chatwarden.ts` (`cw.blocks = { set, between, anyBetween }`; `cw.mutes.blockedSeats`), `packages/core/src/retention.ts`
  (`purgeMutes` skips blocks), `packages/store-memory/src/memoryStore.ts`, `packages/store-sqlite/src/sqliteStore.ts` and `migrations.ts`
  (block 2 of migration 26), `test/contract/mutes.contract.ts`, `packages/http/src/chat/wire.ts` and `routes.ts`
  (`WireMuted.block?`, the mute body `block?`, `MuteResult.limit?`, `CHAT_WIRE_VERSION = 2`), `packages/http/src/chat/broadcaster.ts`
  (a block hides the blocker's lines from the blocked player's streams and history; later lines are filtered both ways),
  `packages/player-react/src/chat/wire.ts` (the copy), `LineOptions.tsx` and `ChatOptions.tsx` (Block with the confirm; the combined
  list), `packages/player-react/src/chat/words.ts` (`player.chat.block*`, 7 keys), service routes (`PUT .../mutes/{target}` takes
  `kind`; `POST /blocks/between`; `hiddenFor` already computed from `visibleTo`), tests listed below.
- **Interfaces (Produces):** `cw.blocks.set(roomId, viewerSeat, targetSeat, on)`, `cw.blocks.between(whoA, whoB): boolean`,
  `cw.blocks.anyBetween(who, others): boolean[]` (found, never created; guests never blocked; follows merges), `cw.mutes.blockedSeats(roomId, viewerSeat)`.
- **Tests (names):**
  - `migration 26 block: kit_mutes.block defaults 0 for old rows; a block row survives purgeMutes at any age while a mute older than 180 days goes; a rerun is refused`
  - `contract: upsert a block over a mute and a mute over a block (latest wins; a mute never downgrades a block, an unblock deletes the row); the per-viewer cap prunes the oldest mute, never a block; with 500 blocks a new one is refused` (memory and sqlite)
  - `visibleTo: viewer muted sender false; viewer blocked sender false; sender blocked viewer false (two-way); neither true; own lines always true; a throwing store reads as visible`
  - `blocks follow a merge on either side; two guests are never blocked; muting oneself or an empty seat does nothing`
  - `cw.blocks.between true in both directions, false for an unknown person, never creates a subject; anyBetween preserves order and bounds at 50`
  - `the chat routes: mute with block true stores a block; unmute removes it; limit true at the cap; the answer lists hiddenIds of the blocker's lines for the blocker`
  - `broadcaster: after a block, the blocked player's stream gets a hide frame of the blocker's lines already in history and no later line of theirs; a reconnect's hello history omits them; the blocker's hello lists the block in muted with block true`
  - `wire: CHAT_WIRE_VERSION is 2 in both copies and the two copies stay assignable (existing equality test)`
  - `the chat box: Block sits in the line options, asks one confirm, then hides the lines; Undo in Chat options removes the block; nothing new is visible outside the menu; the live region says it`
  - `words: the seven keys exist; axe, 360 px, light and dark`
  - `service (after S2): PUT mutes with kind block, GET mutes lists blocked, hiddenFor lists a seat that blocked the sender, POST /v1/blocks/between answers per pair and 400 for 51 others`
  - `off means unchanged: with no block ever made, every existing mute and chat test is green`
- **Run:** `npx vitest run packages/core/test/blocks.test.ts packages/core/test/mutes.test.ts packages/core/test/chat.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/mutes.store.test.ts packages/store-sqlite/test/contract.test.ts packages/http/test/chat.routes.test.ts packages/http/test/chat.broadcaster.test.ts packages/player-react/test/chat-block.test.tsx packages/player-react/test/chat-wire.test.ts`

### Task M5: Phrase-only chat
Spec 4.4. Needs M1 (contexts carry `chat.phrases`), and S2 for the service route.
- **Files:** `packages/core/src/phrases.ts` (new: `PhraseBook`, `Phrase`, `checkPhraseBooks`, `PhraseBookError`),
  `packages/core/src/chatwarden.ts` (`createChatwarden({ phrases })`; start-up check through the matcher and the profanity filter;
  `cw.chat.acceptPhrase`; `cw.phrases.book(roomId)`), `packages/core/src/chat.ts` (`acceptPhrase` runs the shared pipeline without
  the text steps; `accept` in a phrase room refuses `phrases_only`; `RefuseReason` gains `phrases_only`, `phrase_unknown`;
  `ChatResult.deliver.phrase`), `packages/core/src/contexts.ts` (`chat.phrases` must name a declared book, checked when both exist),
  `packages/http/src/chat/wire.ts` (`WireLine.phrase?`, `hello.phrases`), `routes.ts` (`POST /rooms/:room/phrases`), `broadcaster.ts`
  (history keeps `phrase`), `packages/player-react/src/chat/PhrasePicker.tsx`, `ChatBox.tsx`, `words.ts` (`player.chat.phrase*`,
  `player.chat.refused.phrases_only`, `phrase_unknown`, `account_too_new`; 9 keys), service route `POST .../phrases`, tests below.
- **Interfaces (Produces):** `cw.chat.acceptPhrase(roomId, seatId, phraseId): ChatResult`; `PhraseBook = readonly Phrase[]`,
  `Phrase = { id; text; group? }`.
- **Tests (names):**
  - `books: a valid book of 300 accepted, 301 refused; 21 books refused; ids and texts per the grammar; duplicate ids, control and bidi characters, an empty text and a 101-character text refused with the book and phrase id, never the text`
  - `a phrase that the matcher hits or the profanity filter flags throws PhraseBookError at createChatwarden naming book and id only`
  - `a context naming an undeclared book is refused at start; a declared book no context uses is fine`
  - `acceptPhrase delivers the canonical text with phrase set, buffers it as evidence with raw equal to the text, and skips the matcher, profanity and length steps`
  - `acceptPhrase still checks occupant, gate, restriction, minAccountAgeDays, pacing and the fixed rate in the order of accept; a refusal writes and spends exactly what the same refusal does for accept`
  - `accept(text) in a phrase room is refused phrases_only with no strike, no buffer and no rate spent; acceptPhrase in a free room is refused gate; an unknown id is phrase_unknown with nothing spent`
  - `a phrase line is reportable and muteable like any line; a report's excerpt shows the canonical text`
  - `the hello frame carries phrases for a phrase room and null otherwise; a late joiner's history keeps phrase ids; the stream line has phrase and text`
  - `the chat box in a phrase room shows the picker and no text input; a viewer's catalogue key phrase.gg is shown when present and text otherwise; the sender and a viewer in different locales see their own words`
  - `the picker: grouped headings, a filter box above 12 phrases, one tab stop with arrow keys, Enter sends, the live region announces the result, a refused send shows the refusal sentence`
  - `words: the nine keys exist; axe, 360 px, light and dark`
  - `service (after S2): the phrases route delivers, refuses phrases_only for text in a phrase room, honours Idempotency-Key, and capabilities.phrases is true only when a book is configured`
- **Run:** `npx vitest run packages/core/test/phrases.test.ts packages/core/test/chat-phrases.test.ts packages/http/test/chat.phrases.test.ts packages/player-react/test/chat-phrases.test.tsx packages/player-react/test/chat-wire.test.ts`

### Task M6: Reserved names and names for entities
Spec 4.5. Needs M1 only for the order. Coordinates with the names-in-reports theme (spec 13).
- **Files:** `packages/matcher/src/names.ts` and `normalise.ts` (`skeleton`, `matchReserved(name, entries, allow)`; exported),
  `packages/matcher/src/index.ts`, `packages/core/src/names.ts` (`NameSettings.reserved`, `reservedAllow`, `reservedRule`;
  `ResolvedNames`; `NameReason` gains `name_reserved`), `packages/core/src/nameService.ts` (`check(text, { who?, kind?, skipReserved? })`),
  `packages/core/src/matcher` seam in `types.ts` (`Matcher.matchReserved?` optional beside `matchName?`), `packages/core/src/reports.ts` and
  `types.ts` (`ReportInput.entity`, `ReportRecord.entity`), `packages/core/src/reporting.ts` (`impersonation`, disabled),
  `packages/core/src/events.ts` (`rename.required.entity?`), `nameService.ts` (`requireRename` with an entity: no notice, an event, an
  audit row, no pending flag), `packages/store-memory` and `packages/store-sqlite` (`entity_json`, block 4 of migration 26),
  `packages/http/src/player.ts` (`POST /names/check` takes `kind`), `packages/http/src/admin/names.ts` (rename takes `entity`),
  `packages/http/src/admin/reports.ts` (entity on the detail), service routes (`names/check` kind, reports `entity`),
  `packages/hub-react/src/case/CaseContext.tsx` or `Record.tsx` (the entity row through the names theme's masking helper),
  `packages/hub-react/src/person/` (the rename form's entity), `packages/hub-react/src/settings` Names panel (two textareas),
  `packages/player-react/src/i18n.ts` and `names.ts` (`player.name.reserved`), tests below.
- **Interfaces (Produces):** `skeleton(text): string`; `cw.names.check(name, { who, kind, skipReserved })`; `ReportInput.entity`.
- **Interfaces (Needs):** the names-in-reports theme's name-masking helper and flagged-name field (spec 13); the existing
  `nameViews`.
- **Tests (names):**
  - `skeleton: M0d_Anna, Mod_Anna, m.o.d anna and MODDD anna fold to one key per word; Cyrillic and fullwidth look-alikes fold; zero-width characters vanish; the result is only a-z0-9`
  - `matchReserved: entry moderator matches Moderator and M0derator; entry mod matches Mod_Anna, ModAnna and mod anna; neither matches xXmodXx, Sodmin (for admin) or a longer different word such as Moderately; a two-word entry matches game_master, GameMaster and game master`
  - `reservedAllow: a name whose whole skeleton equals an allowed one passes; Moderator passes if allowed, ModeratorX does not`
  - `settings: defaults [] [] and rule 2; entries of 1 and 33 characters, 201 entries, a non-string, an inactive reservedRule refused with the path; entries are normalised once`
  - `check: a reserved name answers name_reserved with the reservedRule and no text; the slur and profanity reasons keep their order (slur first); skipReserved passes; a clean name is ok; nothing is stored unless keepBlocked and who are given, and then the entity kind is kept the same way`
  - `kind entity: the same checks, a clan named after a slur is name_not_allowed; the player route and POST /v1/names/check take kind and refuse an unknown kind with 400`
  - `ReportInput.entity: kind, ref and label per the grammar; a bad one is refused (400 invalid_request at the routes, a new `ReportRefusal` member `entity_invalid` in core); the report stores it; the detail shows it; one without entity is unchanged; the reporter's budget and duplicate rules are the same`
  - `migration 26 block: kit_reports.entity_json exists and old rows read null`
  - `impersonation: present in DEFAULT_REPORT_REASONS, disabled, mapped to CR 2; a report with it is refused reason_unknown until an owner enables it; the default-reasons snapshot is updated by this task alone`
  - `rename with an entity: no notice is created, rename.required carries entity {kind, ref} and no label, the audit row name.rename_required is written, pendingRename stays false; a rename without an entity is exactly as before`
  - `hub: the entity row shows the label through the masking helper (a flagged label is hidden until shown); the rename form offers the entity when the case has one; the Names panel's two textareas save through the layer with a reason, owner only, and say what a dry run changes`
  - `words and a11y: player.name.reserved exists; axe, 360 px, light and dark; no new always-visible control`
  - `privacy: a spy logger never sees a name, a label or an entry; the event carries no label`
- **Run:** `npx vitest run packages/matcher/test/names-reserved.test.ts packages/core/test/names-reserved.test.ts packages/core/test/reports-entity.test.ts packages/core/test/rename-entity.test.ts packages/store-sqlite/test/entity.migration.test.ts packages/http/test/player.names-kind.test.ts packages/hub-react/test/entity-row.test.tsx packages/hub-react/test/name-settings.test.tsx packages/hub-react/test/size.test.ts`

### Task M7: Rooms docs and recipes
Spec 4, 9, 13. After M1 to M6.
- **Files:** READMEs of `core` (contexts, phrases, blocks, scope, reserved names, entity reports, the new refusal reasons, the tag
  grammar), `http` (scope on `authorize`, `scopedLimits`, the wire version 2, `kind` on names, the phrases and mute routes),
  `player-react` (Block, the phrase picker, the catalogue keys for phrases), `hub-react` (chip, contexts list, entity row, Match is L2),
  `matcher` (`skeleton`, `matchReserved`); two recipes in `docs/recipes/`: `kids-rooms.md` (a kids context with phrase-only chat and a
  strict pace, what is the game's: age checks, which rooms are kids' rooms) and `creator-channels.md` (a `scope` per creator, scoped
  moderators, what a scoped moderator cannot do, the sanction limits); `docs/status.md`; `docs/plans/follow-ups.md` (the spec 15 list
  that concerns rooms: block counts, per-context ladders, hub editing); `scripts/readme.test.ts` expectations; the two recipes are
  checked by `scripts/recipes.test.ts` (their code blocks type-check against the built packages).
- **Tests (names):** `the readme checks pass for the changed packages`; `the two recipe pages' code type-checks and the kids recipe runs against a memory kit: a phrase room refuses text, accepts a phrase, a creator recipe's scoped actor sees only its scope`; `the browser bundle budget holds`.
- **Run:** `npx vitest run scripts/readme.test.ts scripts/recipes.test.ts scripts/browser-bundle.test.ts`, then `npm run lint` and `npm run typecheck`.

---

### Task S1: Service plumbing: contract, keys, idempotency, limits
Spec 3.2. Browser-safe; no routes yet beyond the handshake.
- **Files:** `packages/http/src/service/contract.ts` (new: `SERVICE_API_VERSION = 1`, id and `who` validators, the response
  builder that adds `chatwarden-api`, `x-request-id`, `no-store`, `nosniff`), `auth.ts` (`parseKeys`, `createKeyAuth`: digests, constant-time
  compare over all keys, `kid`, the failure throttle), `idempotency.ts` (`createIdempotencyStore({ now })`: reserve, finish, replay,
  mismatch, `in_progress`, TTL 10 minutes, 20 000 entries), `index.ts` (`serviceRoutes` skeleton: `GET /v1` handshake, 404 for the
  rest under `/v1`, the wrapper every route goes through: request id, auth, rate limit, body cap, idempotency), `packages/http/package.json`
  (`exports` and `typesVersions` gain `./service`), `vitest.config.ts` aliases, `scripts/check-pack.mjs` expectations, tests
  `packages/http/test/service.auth.test.ts`, `service.idempotency.test.ts`, `service.contract.test.ts`, `service.handshake.test.ts`.
- **Interfaces (Produces):** `serviceRoutes(cw, options: ServiceOptions): RouteTable` with `ServiceOptions { keys: readonly string[] |
  Authenticate; rateLimit?: NamesRateLimit; authFailureLimit?; maxBody?; now?; logger?; capabilities?; warnings?: () => string[] }`;
  `ServiceCall` wrapper `svc(route, handler, { idempotent?: boolean })` for S2; `createIdempotencyStore`.
- **Tests (names):**
  - `keys: 1 and 5 accepted; 0, 6, a 31-character key, a 257-character key, a character outside the set and a duplicate refused with RangeError that never echoes a key`
  - `auth: a correct key passes; missing header, wrong scheme, wrong key, empty bearer and a key one character off are all 401 unauthorized with www-authenticate and an identical body; every configured digest is compared (a spy proves the loop does not stop at a match)`
  - `rotation: two keys both work; removing the old one stops it at once`
  - `failures: the 21st failure in a minute from one address is 429 even with the correct key; a different address is unaffected; with no remoteAddress one shared bucket applies; the window resets; the bucket table is bounded at 10 000 keys`
  - `rate limit: 3000 per 10 s per key by default; the next is 429 with retry-after in whole seconds of at least 1; a custom limit validated like checkLimit; two keys have separate buckets`
  - `body: 64 KiB accepted, one byte more is 413; a non-JSON content type on POST is 400 invalid_request; a forbidden key (__proto__) is 400 forbidden_key; invalid JSON is 400 invalid_json`
  - `ids: room and seat ids of 1 and 128 characters of the set accepted; 129, a space, a slash-encoded %2F, a dot-only segment and an empty one are 400; who: unknown keys, a 257-character value and a non-string are 400`
  - `headers: every response has chatwarden-api 1, cache-control no-store, nosniff and an x-request-id; a valid request id is echoed, an invalid one replaced by 16 hex characters`
  - `idempotency: same key and body replays the stored status and body with idempotent-replay true and runs the handler once; different body is 409 idempotency_mismatch; a call in flight is 409 in_progress; a 5xx, 401 and 429 are not stored; after 10 minutes on the fake clock the key is new; 20 001 keys evict the oldest; keys are scoped to the calling key, method and path`
  - `a malformed Idempotency-Key (65 characters, a space, empty) is 400 invalid_idempotency_key; without the header the handler runs every time`
  - `handshake: GET /v1 answers api, kit, mode, processes, capabilities and warnings; warnings come from the option; the answer needs the key`
  - `logging: a spy logger sees event names, rid, kid, route pattern and status only; no key, no who, no path with ids, no body`
  - `service/ imports nothing from node: or from node.ts and serve.ts (a static scan); the browser bundle test still passes`
- **Run:** `npx vitest run packages/http/test/service.auth.test.ts packages/http/test/service.idempotency.test.ts packages/http/test/service.contract.test.ts packages/http/test/service.handshake.test.ts scripts/browser-bundle.test.ts`

### Task S2: The `/v1` routes over the kit
Spec 3.3. Needs S1 and M1 (tag validation). M4, M5 and M6 add their own route lines after this lands.
- **Files:** `packages/http/src/service/routes.ts` (the route table: seats, room close, lines, mutes (mute kind), reports, notices,
  record, restriction, names check (player kind), doors check), `packages/http/src/service/refusal.ts` (a thin use of `refusalOf` and
  the door refusal copier), `packages/http/src/service/openapi.ts` (`SERVICE_OPENAPI` built from the route descriptions the table is
  built from), `packages/http/src/service/index.ts` (mounts them), tests `packages/http/test/service.routes.test.ts`,
  `service.differential.test.ts`, `service.privacy.test.ts`, `service.openapi.test.ts`.
- **Interfaces (Produces):** the route table of spec 3.3 minus the lines M4, M5 and M6 add; one description object per route
  (method, path, summary, request schema, answer schema, `idempotent`) from which both the table and `SERVICE_OPENAPI` are built.
- **Behaviour:** a route is a thin adapter: validate, call `cw`, copy the answer by name. `hiddenFor` is `cw.chat.visibleTo` over the
  room's seats for the sender, bounded by the room's seat count. A seat call with a body that has only `ip` is 400. A `PUT` seat
  returns `restriction` from `cw.chat.restricted(who, { roomId, seatId })` after seating. Refusals are 200 with `ok: false`.
- **Tests (names):**
  - `seat, check and unseat: a seated player's clean line is delivered with text and a line id and hiddenFor empty; an unseated seat and an unknown room are refused gate; DELETE room drops seats and evidence`
  - `a slur is refused blocked with the rule and no term, earns a strike, and an automatic timeout lands after the kit's threshold exactly as cw.chat.accept; the refusal body holds only the documented fields`
  - `PUT seat with context and scope tags: a malformed context is 400 invalid_request (from M1's RangeError); an unknown but well-formed context is accepted and every line is then refused gate`
  - `restriction in the PUT answer: a person with a chat sanction gets kind chat and until; a clean person gets null`
  - `mutes: PUT mutes/{target} mutes, GET lists the seat ids, hiddenFor on a later line lists the muting seat, DELETE removes it; muting oneself is ok and a no-op`
  - `reports: a report with a line id and reason is ok with remaining; refused reason_unknown and rate come back as ok false with the refusal; no report id is in the body; an Idempotency-Key replay files one report`
  - `notices: pending lists an unacknowledged notice for the named who; ack marks it and a second ack and another person's id both answer ok false in the same shape; record lists sanction notices; an unknown person gets empty lists, not 404`
  - `doors: a banned who is refused with the kind, until and refCode and no staff field; a clean one is ok`
  - `names: ok and name_not_allowed with the rule; the name is never in any log line`
  - `differential: one scripted conversation (join, five lines including a slur and a flood under pace, a report, a ban, a door check) through cw.chat.accept and through /v1 over toFetch gives identical verdicts, strikes, evidence lines and notices`
  - `privacy: no response in the whole suite contains a subject id, person id, hash, key, moderator field or the strings of the seat-to-person mapping (a scan over every recorded response)`
  - `idempotency on lines, phrases (when present) and reports only; a retried slur is struck once; the replay does not spend a rate slot (a spy)`
  - `openapi: every route in the table has a description and the reverse; SERVICE_OPENAPI parses as OpenAPI 3.1 structure (paths, operations, security scheme bearer) and each documented example answer validates against the answer schema; the document is deterministic`
  - `unknown paths under /v1 are 404 not_found; wrong methods are 405 with allow; HEAD is not supported`
- **Run:** `npx vitest run packages/http/test/service.routes.test.ts packages/http/test/service.differential.test.ts packages/http/test/service.privacy.test.ts packages/http/test/service.openapi.test.ts packages/http/test/service.handshake.test.ts`

### Task S3: Shared pacing, part 1: the store
Spec 3.7, 7 (block 1). Independent of S1 and S2; can run beside them.
- **Files:** `packages/core/src/types.ts` (`PaceStateRow { roomId; who; lastAt; stamps: number[]; recent: Array<{ h: string; at: number }>;
  floodSignalAt: number | null; touchedAt }`; optional `Store.paceLoad`, `paceUpdate`, `paceDropRoom`, `paceSweep`),
  `packages/store-memory/src/memoryStore.ts`, `packages/store-sqlite/src/sqliteStore.ts` (`paceUpdate` is one `BEGIN IMMEDIATE`
  transaction around a load, the pure function and an upsert) and `migrations.ts` (block 1 of migration 26: `kit_pace` and
  `kit_pace_by_touched`), `test/contract/pace.contract.ts` (registered in `test/contract/index.ts`), tests
  `packages/store-memory/test/pace.store.test.ts`, `packages/store-sqlite/test/pace.store.test.ts`, `pace.migration.test.ts`,
  `pace.concurrency.test.ts`.
- **Behaviour:** `paceLoad` returns null for no row. `paceUpdate(roomId, who, fn)` runs `fn(prev | null)` exactly once under the lock
  and stores and returns its result; a throw from `fn` stores nothing and rethrows. `paceSweep(before)` deletes `touched_at < before`
  (strict) and returns the count; `paceDropRoom` deletes a room's rows. Rows hold digests, never text.
- **Tests (names):**
  - `migration 26 block: kit_pace exists with its primary key and index; a 25 database upgrades; a rerun is refused; WITHOUT ROWID`
  - `contract: load of nothing is null; update creates then merges; fn sees the stored row; a throwing fn leaves the row unchanged; sweep is strict at the edge; dropRoom leaves other rooms; stamps and recent round-trip exactly (order, numbers); floodSignalAt null round-trips` (memory and sqlite)
  - `two connections to one file update one key at once, 200 times each: the stored row holds every stamp up to the burst limit and no update is lost (BEGIN IMMEDIATE serialises them)`
  - `EXPLAIN QUERY PLAN: paceLoad uses the primary key; paceSweep uses kit_pace_by_touched; dropRoom uses the primary key prefix`
  - `a busy database past busy_timeout throws a classified error, not a hang`
  - `memory and sqlite give the same answers on the differential script (differential.test.ts gains the methods)`
- **Run:** `npx vitest run packages/store-memory/test/pace.store.test.ts packages/store-sqlite/test/pace.store.test.ts packages/store-sqlite/test/pace.migration.test.ts packages/store-sqlite/test/pace.concurrency.test.ts packages/store-sqlite/test/differential.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/contract.test.ts`

### Task S4: Shared pacing, part 2: the shared pacer
Spec 3.7. Needs S3.
- **Files:** `packages/core/src/paceDecide.ts` (new: the pure `decide(state, pace, now, digest)` and `commitState(prev, pace, now,
  digest)` moved out of `pacing.ts`, with `normalizeForRepeat` and the digest), `packages/core/src/pacing.ts` (the in-memory pacer now
  calls them; behaviour unchanged), `packages/core/src/pacingShared.ts` (new: `createSharedPacer({ clock, settings, store })`),
  `packages/core/src/chatwarden.ts` (`createChatwarden({ sharedPacing })`: chooses the pacer, throws a plain message when the store
  lacks the methods; `cw.rooms.close` calls `paceDropRoom`), `packages/core/src/chat.ts` (the pacer is injected), `packages/core/src/retention.ts`
  (`purge` calls `paceSweep(now - 1 hour)`, 0 for a store without it; `PurgeResult.pace`), tests
  `packages/core/test/pace-decide.test.ts`, `pacing-shared.test.ts`, `pacing-differential.test.ts`, `pacing-shared-failure.test.ts`,
  existing `pacing.test.ts` untouched.
- **Behaviour:** as spec 3.7. `active(roomId)` is the same function, so a room with every check off touches the store not at all.
  A flood verdict with a signal writes `floodSignalAt` through `paceUpdate`. A store failure (load or update) fails open, logs
  `chatwarden.pace_failed` by class at most once a minute, and the line goes on.
- **Tests (names):**
  - `decide and commitState: the existing pacing.test.ts table runs against the pure functions (slow mode, burst edges, repeat digests, minimum length, a stepped-back clock never refuses, retryAfterMs bounds, order slow_mode then flood then duplicate)`
  - `the in-memory pacer's own suite is green after the refactor (existing file)`
  - `differential: one script of 400 steps over three rooms and ten players (clock steps, bursts, repeats, a guest) gives the same verdict at every step from the in-memory pacer and from the shared pacer over a memory store`
  - `shared pacer over SQLite: two kits on one file, a player alternating lines between them is slowed by the burst limit as if on one process; a repeat sent to the second kit after the first is refused duplicate`
  - `the flood signal fires once per burst window across two kits (onFlood called once), and again after the window`
  - `fail open: a store whose paceLoad throws, whose paceUpdate throws and whose fn is never reached: the line is delivered, chatwarden.pace_failed is logged once a minute with the class only, nothing is thrown`
  - `a guest (no subject) is keyed seat:<id>; two guests with different seats do not share state; a person with merged ids shares one key (canonical)`
  - `a room with every check off: a spy store sees no paceLoad and no paceUpdate`; `setPace overrides stay per process: kit A with an override and kit B without give different verdicts for one player, as documented`
  - `rooms.close drops the room's rows; purge sweeps rows older than an hour and keeps newer ones and reports the count; a store without the methods purges the rest`
  - `sharedPacing true on a store without the methods throws a plain message naming the missing method; off, no store method is ever called`
  - `holdsText: the shared pacer never keeps a line's text beyond check and commit (the existing memo test, run against it); stored rows contain only digests`
- **Run:** `npx vitest run packages/core/test/pace-decide.test.ts packages/core/test/pacing.test.ts packages/core/test/pacing-shared.test.ts packages/core/test/pacing-differential.test.ts packages/core/test/pacing-shared-failure.test.ts packages/core/test/retention.test.ts`

### Task S5: `chatwarden serve` and `chatwarden init --service`
Spec 3.4, 3.5. Needs S1, S2 and S4 (the flag).
- **Files:** `packages/http/src/service/node.ts` (new: the Node bridge, `nodeHandler(fetchHandler, options)`: request to `Request`
  with a byte cap and a 10 s read timeout, response to socket with stream backpressure, no `x-forwarded-*` trust), `service/serve.ts` (config
  from flags and environment, `startService(config): Promise<{ close(): Promise<void>; port }>`), `packages/http/src/cli/serve.ts`
  (the subcommand and its flags), `cli/args.ts` (`serve`, `--service`, `--print-openapi`), `cli/templates/service.ts` (Dockerfile,
  compose, `.env.example`, `profile.json`, `README.txt`, `.dockerignore`), `cli/plan.ts` and `cli/index.ts` (`--service` is a usage
  error with framework, chat, hub and Discord flags; a plan with no `package.json`), `packages/http/package.json` (optional peers
  `@chatwarden/store-sqlite`, `@chatwarden/matcher`, `@chatwarden/profanity`, `@chatwarden/hub-element`), tests
  `packages/http/test/serve.config.test.ts`, `serve.start.test.ts`, `serve.node.test.ts`, `cli.service.test.ts`, `cli.service-golden.test.ts`.
- **Behaviour:** as spec 3.4 and 3.5. Startup validation order: package presence, `CHATWARDEN_SECRET` (32+), service keys, admin token
  not equal to a key, profile file, terms file, then store and kit, then listen; any failure is exit 2 with one sentence naming the
  variable and never its value. The staff side is the init starter's shared-token hooks, or `CHATWARDEN_AUTH_MODULE`. `serve` mounts
  `/v1`, `/admin`, `/mod` (when staff auth exists and the hub is `element`), `/healthz` and `/readyz`.
- **Tests (names):**
  - `config: flags beat environment beat defaults; the port 0..65535 whole number; host any; --hub values; a boolean env is only 1 or 0; unknown flags are a usage error`
  - `startup refusals each exit 2 with the variable named and no value in the output: no secret, a 31-character secret, no service keys, a key shorter than 32, an admin token equal to a key, an unreadable profile file, an invalid profile (the ProfileError path is printed), an unreadable terms pack, a missing optional peer (with the install command)`
  - `start: on an ephemeral port, GET /healthz and /readyz answer; GET /v1 with a key answers the handshake with synthetic_terms in warnings; the hub script and /mod are served only with an admin token configured; with none, /admin and /mod are 401 or absent and /v1 still works`
  - `the profile file is applied: a preset and an override change what /v1 lines refuse; contexts and names.reserved in the file reach the kit`
  - `terms file: a valid TermPack replaces the synthetic pack and the warning disappears; an invalid pack is exit 2`
  - `a custom auth module is loaded from a path, its authorize is used for /admin, a module that throws makes /admin 500 with no detail`
  - `shutdown: SIGTERM stops accepting, lets an in-flight request finish within 10 s, closes the store, exits 0; a second signal exits at once` (an injected signal source)
  - `the Node bridge: a 64 KiB body passes, 64 KiB plus one is 413 before the handler runs; a slow body is closed by the read timeout; a client abort calls the stream cancel once; the socket address, never a header, is the remoteAddress; HEAD is refused`
  - `logs are JSON lines with event and class, plus one request line with rid, kid, route pattern, status and ms; no key, no who, no body`
  - `init --service: the plan lists the six files under chatwarden-service; usage error with --framework, --chat, --hub, --discord; --dry-run and --json print the plan; a second run is unchanged; a differing file is skipped (exit 2) and --force overwrites; --store memory writes CHATWARDEN_DB=:memory: and a comment`
  - `golden: the generated files for each preset equal the committed goldens under examples/service/cases; the Dockerfile parses: node:22-slim, non-root USER node, ARG for the version equal to the CLI's VERSION, no secret, HEALTHCHECK, VOLUME /data, CMD runs serve`
  - `no network: serve.ts and the bridge import no http client, and the CLI service path makes no request` (the existing static scan, extended)
  - `--print-openapi prints SERVICE_OPENAPI as JSON and exits 0`
- **Run:** `npx vitest run packages/http/test/serve.config.test.ts packages/http/test/serve.start.test.ts packages/http/test/serve.node.test.ts packages/http/test/cli.service.test.ts packages/http/test/cli.service-golden.test.ts packages/http/test/cli.test.ts`

### Task S6: Clients, the Docker recipe folder, the C# sample, CI and docs
Spec 3.5, 3.6. Needs S2 and S5.
- **Files:** `packages/http/src/service/client.ts` (`createServiceClient`: one method per route, generated `Idempotency-Key`,
  bounded retry on network errors and 5xx), `examples/service/` (`Dockerfile`, `compose.yaml`, `.env.example`, `profile.json`,
  `README.txt` from the same templates, `curl.sh`, `conformance.mjs`: the curl script as a Node script that exits non-zero on any
  surprise), `examples/service-csharp/` (`ChatwardenClient.cs`, `Program.cs`, `Chatwarden.Sample.csproj` for .NET 8, `README.md`),
  `.github/workflows/ci.yml` (a `service-csharp` job: `actions/setup-dotnet`, `dotnet build`, start the built service with
  `node packages/http/dist/src/cli/bin.js serve` and run the sample against it; an optional second step runs `conformance.mjs`),
  tests `packages/http/test/service.client.test.ts`, `examples/service/conformance.test.ts`, `examples/service/recipe.test.ts`,
  `examples/service-csharp/routes.test.ts`, docs: the READMEs of `http` (service mode, the API table, key rotation, the process and
  environment table, the honest limits) and `core` (shared pacing), `docs/recipes/service-mode.md` (any language; the curl and C#
  walk-through; one process per room set), `docs/status.md`, `docs/plans/follow-ups.md`, `scripts/readme.test.ts` expectations. The
  site FAQ is **not** edited (the site flips a promise only after the release is on npm and has run somewhere).
- **Behaviour:** the Docker recipe is verified by a static test and the C# job in CI; a real `docker build` is the maintainer's check
  after the version is on npm (the README says so in one line; no image is built or pushed by anything here).
- **Tests (names):**
  - `client: every method hits its route with the bearer and a generated Idempotency-Key reused across its own retries; 4xx is not retried; a 5xx is retried up to three times with backoff on the fake clock; a refusal is returned, not thrown; an unknown refusal reason is returned as unknown`
  - `client against the real service over toFetch: the whole conversation of curl.sh runs and ends in the expected state`
  - `conformance.mjs runs against a started serve process on an ephemeral port and exits 0; with a wrong key it exits 1 and says unauthorized`
  - `recipe: examples/service files equal what init --service writes; the Dockerfile and compose pass the static rules (no secret, non-root, localhost binding in compose, the three variables read from the environment)`
  - `csharp routes drift: every path and method used in ChatwardenClient.cs is in SERVICE_OPENAPI and every core route (seat, unseat, lines, reports, notices pending, ack, restriction, doors, names) has a C# method; a path in the C# file that is not in the spec fails`
  - `the C# client's Program.cs expectations list (the strings it asserts) match the conformance script's expectations file` (a shared JSON expectations file read by both)
  - `readme and recipe checks pass; the CI workflow test (scripts/ci-workflow.test.ts) accepts the new job`
- **Run:** `npx vitest run packages/http/test/service.client.test.ts examples/service/conformance.test.ts examples/service/recipe.test.ts examples/service-csharp/routes.test.ts scripts/readme.test.ts scripts/ci-workflow.test.ts`

---

### Task L1: Matching for scripts without spaces
Spec 5.2. Matcher only; the store and hub are L2.
- **Files:** `packages/matcher/src/unspaced.ts` (new: the script classes, `isUnspacedTerm`, `unspacedView(raw)` with grapheme-cluster
  mapping, `buildUnspaced(terms, exceptions)`, the segmenter cache, boundary alignment), `packages/matcher/src/matcher.ts`
  (`TermRow.matchMode?`; `buildMatcher` routes terms: Latin `word`, others `segment` or `contains`; `match`, `spans`, `matchName` run both
  paths; `MatcherBuildError` for a mode that does not fit the script, an unsupported script, a too-short term and a missing
  `Intl.Segmenter`), `packages/matcher/src/normalise.ts` (`foldKana`, `normaliseUnspaced`), `packages/matcher/src/index.ts`,
  `packages/matcher/src/fixtures/syntheticPack.ts` (invented strings in the three scripts with positive and negative lines),
  `packages/matcher/README.md` (the term rules), tests `packages/matcher/test/unspaced.test.ts`, `unspaced-spans.test.ts`,
  `unspaced-normalise.test.ts`, `unspaced-corpus.test.ts`, `unspaced-build.test.ts`.
- **Interfaces (Produces):** `TermRow.matchMode?: 'word' | 'segment' | 'contains'`; `Matcher` unchanged; exports `isUnspacedTerm`,
  `UNSPACED_SCRIPTS`.
- **Tests (names):**
  - `term rules: 2 code points accepted for segment, 1 refused; contains needs 3; 24 accepted and 25 refused; a space, punctuation or digit inside a term refused; a Han+Hiragana+Katakana mix accepted for ja; Han with Thai refused; Cyrillic, Arabic and Hangul refused as an unsupported script naming the row id and never the term`
  - `mode and script must fit: word on a Han term, segment on a Latin term and contains on a Latin term are MatcherBuildError; null picks word for a-z and segment for an unspaced term`
  - `segment: a term occupying whole segments hits; the same characters inside a longer dictionary word do not (an invented dictionary-word fixture per script, asserted against the Node ICU actually running); a slang term the segmenter splits into single characters still hits; contains hits anywhere in the run`
  - `runs: punctuation, spaces, digits, Latin letters and emoji end a run, so a term split by a space does not match (documented limit); a term at the start and the end of the text matches`
  - `normalise: Japanese voiced and half-voiced kana survive (が stays が; NFKD would have made it か); Thai vowel signs and tone marks survive; fullwidth Latin and halfwidth katakana fold by NFKC; format characters, zero-width joiners and variation selectors are dropped; hiragana and katakana forms of one term both match`
  - `spans: the original text of every hit is recovered exactly, including after a dropped zero-width character, a half-width katakana expansion and a combining sequence; overlapping hits merge; a Latin hit and a Han hit in one line both appear in order`
  - `exceptions: an unspaced exception phrase suppresses a hit inside it only when its own edges are boundaries; a Latin exception still works as before; an exception that spans a Latin and a Han part is refused at build with the row id`
  - `no segmenter: a runtime without Intl.Segmenter (a stubbed global) makes buildMatcher throw with a clear message when an active segment term exists, and builds when none do; inactive terms are skipped and not validated`
  - `languages pick the segmenter: the same Han text segmented as zh and ja can differ; each term is checked in the language of its row; a term row language outside zh ja th lo km my is a build error`
  - `corpus gate: every synthetic term ships with must-hit and must-not-hit lines in its script; the gate runs and passes; a deliberately loosened term (contains on a 2-code-point term) fails the gate with the line shown by id`
  - `Latin behaviour is untouched: the existing matcher, spans, names and term-pack suites are green; a Latin-only matcher takes no segmenter path (a spy)`
  - `performance: 2000 unspaced terms and a 200-character mixed line match in under a budget on the fake clock-free benchmark helper already used by corpus-bench; a Latin-only line costs the same as before`
- **Run:** `npx vitest run packages/matcher/test/unspaced.test.ts packages/matcher/test/unspaced-spans.test.ts packages/matcher/test/unspaced-normalise.test.ts packages/matcher/test/unspaced-corpus.test.ts packages/matcher/test/unspaced-build.test.ts packages/matcher/test/matcher.test.ts packages/matcher/test/names.test.ts packages/matcher/test/spans.test.ts packages/matcher/test/termPack.test.ts`

### Task L2: Unspaced terms in the term store, the routes, the hub and the corpus loader
Spec 5.2 (where it surfaces). Needs L1.
- **Files:** `packages/matcher/src/termStore.ts` (`TermRecord.matchMode`, `TermPatch.matchMode`), `packages/matcher/src/liveTerms.ts`
  (add and edit take `matchMode`; the dry run reports the mode; a term whose mode does not fit its script is refused with the same
  error codes as other term refusals), `packages/matcher/src/termPack.ts` (`matchMode` optional in a pack), `packages/store-sqlite/src/migrations.ts` (block 5 of
  migration 26: `kit_terms.match_mode`) and `sqliteStore.ts`, `packages/store-memory` (the fixtures' `memoryTermStore`),
  `packages/matcher/src/corpus/release.ts` and `select.ts` (an optional `matchMode` per row and the languages `zh ja th lo km my` accepted;
  the manifest schema string stays `/1`), `packages/http/src/admin/terms.ts` (`POST /terms`, `PATCH /terms/:id` and the rows carry
  `matchMode`), `packages/hub-react/src/terms/TermForm.tsx` (the Match choice, shown only when the typed word is in an unspaced
  script, with one sentence on each option), `packages/hub-react/src/terms/languages.ts` (`zh ja th lo km my` named by
  `Intl.DisplayNames`), `i18n.ts` (`hub.terms.match.*`, 6 keys), tests
  `packages/matcher/test/liveTerms.matchMode.test.ts`, `packages/store-sqlite/test/terms.matchMode.test.ts`,
  `packages/matcher/test/corpus-unspaced.test.ts`, `packages/http/test/admin.terms.matchMode.test.ts`,
  `packages/hub-react/test/term-form-match.test.tsx`.
- **Tests (names):**
  - `migration 26 block: kit_terms.match_mode is nullable with its CHECK; old rows read null and match by script; a rerun is refused`
  - `LiveTerms.addTerm with a Han term and no mode stores null and builds a segment term; with contains stores it; a Latin term with segment is refused with the existing invalid_term code; editing the mode rebuilds the matcher atomically; the audit row's afterJson carries the mode`
  - `the dry run for an unspaced term reports how many of the recent lines it would block and which of the negative corpus it hits, per mode; switching to contains shows the larger number before saving`
  - `a pack and a store round-trip matchMode; a pack row with an unknown mode is refused at load`
  - `corpus: a release row with matchMode and a zh, ja or th language parses and selects; one without matchMode still parses; an unknown mode is bad_pack; the old Latin rule for a Latin term is unchanged`
  - `routes: POST /terms and PATCH take matchMode (validated), GET /terms returns it, an unknown mode is 400 invalid_term; terms.write needed; the check route answers per mode`
  - `hub: typing a Latin word shows no Match choice; typing a Han, kana or Thai word shows it with "whole words (recommended)" selected; choosing anywhere in the text adds one explanatory sentence; the dry run runs per choice; the saved row shows the mode in the list only when it is not the default; strings through t(); axe, 360 px, light and dark; size budget holds`
- **Run:** `npx vitest run packages/matcher/test/liveTerms.matchMode.test.ts packages/matcher/test/corpus-unspaced.test.ts packages/matcher/test/termPack.test.ts packages/store-sqlite/test/terms.matchMode.test.ts packages/store-sqlite/test/terms.store.test.ts packages/http/test/admin.terms.matchMode.test.ts packages/hub-react/test/term-form-match.test.tsx packages/hub-react/test/size.test.ts`

### Task L3: Spanish and Portuguese for the player: catalogues, loading, report reasons
Spec 5.1. Independent of everything else.
- **Files:** `packages/player-react/src/locales/es.ts` and `pt.ts` (new; header, `meta`, the catalogue for `en` plus `enChat` plus the
  report-reason keys), `packages/player-react/src/locales/match.ts` (`matchLocale`), `packages/player-react/src/locales/load.ts`
  (`loadPlayerT`), `packages/player-react/src/i18n.ts` (the report-reason and thank-you English keys: `player.report.reason.<id>.label`
  and `.hint` for the ten defaults plus `impersonation`, and `player.report.thanks`), `packages/player-react/src/ReportDialog.tsx` and
  `reporting.ts` (the lookup rule: catalogue text only while the server's text equals the English default), `packages/player-react/src/index.ts`,
  `packages/player-react/package.json` (`exports` and `typesVersions` for `./locales/es` and `./locales/pt`), `scripts/check-pack.mjs`,
  tests `packages/player-react/test/locales.complete.test.ts`, `locales.meta.test.ts`, `locales.load.test.ts`,
  `report-reason-lookup.test.tsx`, `locales.review-claims.test.ts`.
- **Drafting rules for the implementer (spec 5.1):** draft in batches of at most 60 keys per area (notice, record, appeal, name, rules,
  restricted, report, chat), keeping placeholders and plural suffixes; neutral Latin American Spanish with `tú`; Brazilian Portuguese with
  `você`; plain, never shaming, second person, sentence case; the header comment and `meta` say machine-drafted, not reviewed. The
  completeness test is the checklist: run it after each batch and fix what it names.
- **Tests (names):**
  - `complete: every key of en and enChat is in es and in pt, and no key outside them; the report-reason keys too`
  - `placeholders: the {name} set of each string equals the English one in both locales; plural bases have .one and .other; no empty string; no string equals its English source unless it is on the allowlist; no markup`
  - `meta: status is 'machine-draft', reviewedBy is [], reviewedAt is null; changing one without the others fails the test`
  - `review claims: no file in locales/ contains reviewed, verified, native, official or approved outside the header block (case-insensitive, Spanish and Portuguese equivalents included: revisado, verificado, nativo, oficial, aprovado)`
  - `matchLocale: es, es-MX, es-419, ES and es_AR give es; pt, pt-BR and pt-PT give pt; en, de, an empty string, a non-string and a 300-character string give null`
  - `loadPlayerT('es') returns a t whose notice title is Spanish and whose missing key falls back to English; pt the same; en and an unknown locale return the English t; the catalogue module is a dynamic import (a build check: the main entry does not contain its text)`
  - `plurals: the report-remaining plural picks .one for 1 and .other for 0, 2 and 1000000 in es and pt (the many category falls back to .other)`
  - `report reasons: with the server's default English label and an es catalogue the dialog shows the Spanish label; with an owner-edited label it shows the owner's text; with a catalogue that lacks the key it shows the server's text; the same for hint and thanks`
  - `the English default keys equal core's DEFAULT_REPORT_REASONS labels and hints and DEFAULT_REPORT_THANKS (drift guard)`
  - `the chat box renders in es with createT; the three new refusal words and the block and phrase words exist; axe on the notice queue and chat box in es at 360 px`
  - `the package main entry size budget (scripts/browser-bundle.test.ts) is unchanged`
- **Run:** `npx vitest run packages/player-react/test/locales.complete.test.ts packages/player-react/test/locales.meta.test.ts packages/player-react/test/locales.load.test.ts packages/player-react/test/locales.review-claims.test.ts packages/player-react/test/report-reason-lookup.test.tsx packages/player-react/test/i18n.test.ts scripts/browser-bundle.test.ts`

### Task L4: Spanish and Portuguese for the hub, and the translation guide
Spec 5.1. Needs L3 (the helpers and tests are reused).
- **Files:** `packages/hub-react/src/locales/es.ts` and `pt.ts` (new; `es` for the 1434 core keys, `esAi` for the 202 AI keys, `meta`),
  `locales/match.ts` and `locales/load.ts` (`matchLocale`, `loadHubCatalog(locale)` returning the merged catalogue), `provider.tsx` and
  `Hub.tsx` (when `t` is not given and `matchLocale(locale)` is not null: load the catalogue and show the hub's loading state until it
  arrives; a failed load keeps English; a given `t` always wins), `packages/hub-element/src/element.ts` (the `locale` attribute reaches
  the provider; changing it reloads), `packages/hub-react/package.json` (`exports` for `./locales/es` and `./locales/pt`),
  `scripts/check-pack.mjs`, docs: the READMEs of `hub-react`, `hub-element` and `player-react` (a "Languages" section: what ships, the
  machine-draft status in its first line, how to turn a language on, how to review and what keys to review first, how a community
  adds a language), `docs/recipes/translations.md` (the translator's guide: the key lists to review first (notices, refusals, appeals,
  sanctions words), the allowlist, the test to run, how `meta` changes by pull request), `docs/status.md`, tests
  `packages/hub-react/test/locales.complete.test.ts`, `locales.meta.test.ts`, `locales.load.test.tsx`, `locales.review-claims.test.ts`,
  `packages/hub-element/test/locale-load.test.ts`.
- **Drafting rules for the implementer:** as L3, in batches of at most 80 keys by key prefix (`hub.nav`, `hub.reports`, `hub.case`,
  `hub.person`, `hub.settings`, `hub.terms`, `hub.audit`, `hub.simple`, and the AI keys last); run the completeness test after each
  batch. Moderator-facing copy follows the English tone: short, plain, no blame. Terms that the moderator guide already defines
  (`strike`, `ladder`, `sanction`, `Community Rule`) keep one Spanish and one Portuguese word throughout (the first batch writes them into
  a small glossary comment at the top of the file, which the later batches follow).
- **Tests (names):**
  - `complete: every key of en and of the AI words is in es and pt and none outside; placeholders, plural bases, empties, identical-to-English strings (allowlist) and markup per the L3 rules`
  - `meta and review claims: the same checks as the player catalogues, applied to the hub files`
  - `glossary: the five defined terms use one translation each across the file (a test over the glossary comment and the strings that contain them)`
  - `loadHubCatalog('es') merges en, the AI words and the catalogue; a missing key falls back to English; pt-PT loads pt; en returns the English catalogue without importing a locale module`
  - `provider: with locale es and no t the hub shows its loading state, then Spanish text with no flash of English (a test renders and asserts the first painted text); with a failed import it renders English and does not throw; with a given t the catalogue is never imported; changing locale at runtime reloads`
  - `hub-element: <chatwarden-hub locale="pt-BR"> loads the Portuguese catalogue; an invalid locale falls back as today`
  - `dates, numbers and plurals follow the locale (an existing test, run for es and pt)`
  - `size: the first-load budget and the entry budget in size.test.ts are unchanged; the locale files are lazy chunks, not in the main bundle`
  - `axe on the queue, the case and Settings in es at 360 px, light and dark`
  - `the translation guide's key lists exist in the catalogue (a test reads the guide and checks every listed key)`
- **Run:** `npx vitest run packages/hub-react/test/locales.complete.test.ts packages/hub-react/test/locales.meta.test.ts packages/hub-react/test/locales.load.test.tsx packages/hub-react/test/locales.review-claims.test.ts packages/hub-react/test/i18n.test.ts packages/hub-react/test/size.test.ts packages/hub-element/test/locale-load.test.ts scripts/readme.test.ts`, then `npm run lint` and `npm run typecheck`.

---

## Spec coverage (self-review)
3.2 to S1; 3.3 to S2 (plus M4, M5 and M6 for their routes); 3.4 and 3.5 to S5; 3.6 to S6; 3.7 to S3 and S4; 3.8 to the READMEs in S6;
4.1 to M1 and M3; 4.2 to M2 and M3; 4.3 to M4; 4.4 to M5; 4.5 to M6; 4.6 to M3, M4, M5, M6 and L2; 5.1 to L3 and L4; 5.2 to L1 and L2;
6 to the tasks that own each setting (contexts M1, reserved M6, phrases M5, scope M2, keys S1, matchMode L2, sharedPacing S4);
7 to S3 (block 1), M4 (2), M2 (3), M6 (4), L2 (5); 8 to the tasks that change each wire; 9 to the per-task edge tests; 10 to the privacy
tests of S1, S2, S5 and M6, and the scope tests of M2; 12 (Breaking changes) to the task that makes each: 1 to S3, M2, M4 and M6; 2 to
M1, M5 and M6; 3 to M4; 4 to M2; 5 to M1; 6 to M2; 7 to M6; 8 to S4 and M5; 9 to L3; 10 to the READMEs in M7, S6 and L4; 13 to the
Interfaces lines of M1, M2, M6 and the notes for the other themes; 15 to `docs/plans/follow-ups.md` in M7 and S6. Names used across tasks
(`CONTEXT_SECTIONS`, `checkRoomTags`, `cw.contexts.effective`, `scopedLimits`, `ctx.secure(..., { scoped })`, `acceptPhrase`, `cw.blocks.between`,
`skeleton`, `matchReserved`, `createSharedPacer`, `paceUpdate`, `matchMode`, `matchLocale`, `loadPlayerT`, `loadHubCatalog`) are defined once in
the owning task and consumed under the same spelling.

## Needs from the other themes (to confirm at Step 0)
- Names in reports and the preview: the name-masking helper and flagged-name field (M6); the preview taking `context` through
  `cw.contexts.effective` and reading `GET /policy/contexts` (M1, M3).
- Filters and privacy: `'filters'` added to `CONTEXT_SECTIONS` and `mergeFilters` exported by their task (M1 merges through it); the
  privacy contract test enumerating `kit_pace`, `kit_mutes` (both ids), `kit_reports.entity_json`.
- Urgent, desk and rooms: every new admin route declares itself scope-aware or is denied (M2's table-driven test fails otherwise); the
  urgent sort applies scope in the store query; room modes do not use the tag keys `context` or `scope`.
- Migration 26: whoever lands first creates it; the rest append blocks (Global Constraints).
