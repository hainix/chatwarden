# Flood control and signals (0.1.7) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** an adopter can pace a room (a minimum gap between a player's lines, a burst limit, no repeats) and get a refusal that says
why and when to retry, before the term matcher runs. A game can declare its own signal kinds (muted by others, kicked, left
mid-game), record them, and have three places read them only because a profile rule says so: the Person page record, the ladder
suggestion (a note or one step) and the AI read's case context, plus an optional capped queue boost. A signal never acts.

**Architecture:**
- `@chatwarden/core` gets `pace.ts` (settings), `pacing.ts` (the in-memory limiter), `signals.ts` (declarations, validation),
  `signalCounts.ts` (pure distinct-source counting) and a signal service behind `cw.signals`. `ChatService.run` gains the pace check
  and commit; `ladder.suggest` gains `SignalHit`s; `CaseDesk.next` gains `signalBoost`. `profile.ts` gains the `pace` and `signals`
  sections; `retention.ts` gains `signalsMs`.
- Optional `Store` methods and SQLite migration 21 hold signal rows (memory and SQLite, one contract suite).
- `@chatwarden/http` adds fields to existing bodies only. No new route, no new permission, no new audit action.
- `@chatwarden/player-react` gains the `pace` prop on `RestrictedChatLine`. `@chatwarden/hub-react` gains Settings, Advanced (two lazy
  panels), the Person page lines (lazy) and one pure queue seam.

**Spec:** `docs/design/2026-11-12-flood-control-and-signals.md` (section numbers below refer to it), including its closing Rulings
section. Also binding: `docs/design/2026-11-10-editable-ladder-and-roadmap.md` (Part 2) and `docs/design/2026-11-11-ai-levels-1-2.md`
(section 8 is amended by spec 5.7).

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly`, every time from the injected
  `Clock` (no `Date.now()`), synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn), test-first, targeted
  runs only, `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree: commit by pathspec,
  `git add` new files first.
- **Sequencing.** This release follows 0.1.5 (triage speed: migration 19, `rankDownHabitual`, `REPORTER_RANK_LAPSE_MS`, branch
  `triage-speed`) and 0.1.6 (AI levels 1 and 2: `core/src/ai`, migration 20, audit actions `ai.read`, `ai.rerun`, `ai.outcome`, branch
  `ai-levels`). Neither is on `main` when this plan is written. **Step 0, before Task 1:** after both merge, rebase the branch on `main`
  and confirm `POLICY_SECTIONS` ends `... 'reporting', 'ai'`, the newest migration is 20, and `cw.cases.next` has `rankDownHabitual`.
  Tasks marked **after 0.1.6** or **after 0.1.5** name the file to read there and cannot start before the merge. Migration here is
  **21**. `AUDIT_ACTIONS` is append-only and this release adds none (spec 8); if a task ever needs one it is appended after
  `ai.outcome`, never inserted. Branch `flood-signals`, worktree `C:\dev\chatwarden-wt\flood`.
- `@chatwarden/core` stays browser-safe and dependency-free: no `node:` import (digest via `crypto.ts`), no `fetch`. Its browser bundle
  must not grow beyond what `cw.signals` and the pacer cost; `scripts/browser-bundle.test.ts` budgets are re-checked.
- **Off means identical.** With no `pace` and no `signals` configured, every chat result and every http body is what 0.1.6 sends. One
  snapshot test pins it (Task 13) and each core task keeps its own off-parity test.
- No identifier, no text, no `rule`/`noticeId` in a pacing refusal; no free text, handle or seat on a signal row; logs carry event names
  and error classes or reason codes only (never a subject, `by`, room id, kind id, label or line). Refusal logs use `ThrottledWarn`.
- A signal never applies a sanction, opens or closes a report, or changes the matcher. Positive kinds may inform, never raise (spec 3,
  ruling 10): `raise` and `queue` reject them at validation.
- **Hub budget.** The hub-react first-load budget is 76,800 B gzip (`packages/hub-react/test/size.test.ts`) and the hub is near it. The
  new hub code is lazy: both Settings panels and the Person-page signal lines load on demand; only types, the two client calls and the
  pure queue seam are eager, and `size.test.ts` is run in every hub task.
- **UI rule (clean core, power behind one door).** Nothing is added to the queue, case card, top bar or Simple mode. Everything lives in
  Settings, Advanced and in the Person page's existing Timeline panel. Every string through `t()`. No colour for polarity (words).
  Check in a real browser at desktop and 360 px, light and dark, for Tasks 16 to 18.
- Pacing and signal state is staff-side data; `cw.signals.counts` is documented "never send to a player".
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no site deploy without the maintainer's go-ahead.

## Review Focus
Five failure modes no task's happy-path tests would otherwise exercise; each has its test in the owning task.
1. **Lines that normalize to nothing or to almost nothing** (emoji-only, punctuation-only, CJK, full-width, 200-character lines): the
   duplicate check must never refuse them wrongly or crash. Task 3.
2. **The clock.** Two lines in the same millisecond, and a clock that steps backwards, must still give `retryAfterMs` as a whole number
   from 1 up to the configured window. Task 3.
3. **Hostile `record` input and prototype-named kinds** (`constructor`, `__proto__`, `toString` as a kind id; getters that throw; proxies;
   BigInt; cyclic objects): `record` must return `false`, never throw, never read a kind off the prototype. Tasks 5 and 9.
4. **Merges after the fact.** A merge between two recorded sources, or between subject and `by`, must fold in counts and still refuse a
   self-signal; the cap must not be defeated by recording as an alias. Tasks 8 and 9.
5. **A stored layer made invalid later.** The code stops declaring a kind a saved feed names, or retention is lowered below a saved feed
   window. Today an unusable layer is ignored whole (`chatwarden.policy_layer_invalid`), which would silently drop the owner's ladder
   edits too. Startup must not throw, and only the offending feed may be dropped. Task 5.

## Order and parallelism
Step 0 (rebase) first. Tasks 1, 3, 6 and 15 are independent and can run at once. Task 2 follows 1. Task 4 follows 1 and 3. Task 5 follows
2 (same file, `profile.ts`) and 6's type additions. Task 7 follows 6 (**after 0.1.6**). Task 8 follows 6. Task 9 follows 5, 6, 8. Task 10
follows 4 and 9. Task 11 follows 9. Task 12 follows 9 (**after 0.1.5**). Task 13 follows 2, 11, 12. Task 14 follows 9 (**after 0.1.6**).
Task 16 follows 13. Task 17 follows 2 and 13. Task 18 follows 5 and 13. Tasks 19 and 20 are last.

---

### Task 1: Pace settings
Spec 4.1. Pure code, no profile wiring yet.
- **Files:** `packages/core/src/pace.ts` (new); exports in `src/index.ts` (`@experimental`); test `packages/core/test/pace.test.ts`.
- **Interfaces (Produces):** `PACE_REASONS`, `PaceReason`, `PaceSettings`, `ResolvedPace`, `PACE_SUGGESTIONS`, `resolvePace(input: PaceSettings | undefined, path?: string): ResolvedPace`,
  `mergePace(base: ResolvedPace, over: PaceSettings): ResolvedPace`, constants `DUPLICATE_MIN_CHARS = 3`, `DUPLICATE_RECENT = 8`,
  `PACE_KEYS_MAX = 50_000`. Shapes exactly as spec 4.1. Ranges: `slowModeMs` 500 to 600 000; `burst.lines` 2 to 100, `burst.windowMs`
  1 000 to 600 000; `duplicateWindowMs` 1 000 to 3 600 000; integers only. Errors are `ProfileError` with the field path
  (`pace.burst.lines`) and never echo the value. `PACE_SUGGESTIONS` is the table in 4.1 and is frozen.
- **Tests (names):**
  - `all unset resolves to all null`; `null and absent are both off`
  - `each field accepts its minimum and maximum`; `each field rejects one below and one above, naming pace.slowModeMs / pace.burst.lines / pace.burst.windowMs / pace.duplicateWindowMs`
  - `rejects a fraction, NaN, Infinity, a string, a negative, a boolean and an array`; `rejects an unknown key such as pace.nope with its path`; `a thrown message never contains the bad value`
  - `mergePace: absent inherits, null turns off, a value sets`; `an override of {} changes nothing`; `burst merges whole, not by member`
  - `PACE_SUGGESTIONS matches the spec table for relaxed, standard and strict, each passing resolvePace`; `is frozen`
- **Run:** `npx vitest run packages/core/test/pace.test.ts`

### Task 2: `pace` in the profile and the policy layer
Spec 4.1, 4.9, 4.10. Needs Task 1 and Step 0.
- **Files:** `packages/core/src/profile.ts` (`TOP_KEYS` and `OPTIONAL_TOP_KEYS` gain `pace`; `ModerationProfile.pace?: PaceSettings`;
  `ResolvedProfile.pace: ResolvedPace`; `PolicyLayer.pace?`; `POLICY_SECTIONS` appends `'pace'` after `'ai'`; `applyLayer`, `layerSections`,
  `changedSections` follow), `packages/http/src/admin/policyProfile.ts` (the section list in the route doc comment; confirm the
  `DELETE ?section=` check already follows `POLICY_SECTIONS`), tests `packages/core/test/policy-layer-pace.test.ts`,
  `packages/http/test/admin.policy-pace.test.ts`; the existing `profile.test.ts`, `policy-layer.test.ts` and `golden.test.ts` stay green untouched.
- **Interfaces:** Consumes `resolvePace`, `mergePace`. Produces `cw.profile.pace: ResolvedPace` (layer over base over off).
- **Behaviour:** the three presets ship `pace` unset (no install changes). A layer error is the existing `invalid` result with the path
  inside the layer (`layer.pace.burst.lines` over http). `agentBrief` and `policyJson` gain nothing.
- **Tests (names):**
  - `the presets resolve pace to all null`; `a code profile with pace resolves it`; `a layer pace beats the code profile`; `reset("pace") restores the base`
  - `a layer touching pace.nope is refused with its path`; `a layer with pace.burst.lines 1 is refused with layer.pace.burst.lines`
  - `changedSections lists pace; layerSections lists pace in POLICY_SECTIONS order`; `a save of only pace is audited policy.update with sections ["pace"] and no values`
  - `agentBrief and policyJson are unchanged by a pace layer`; `AUDIT_ACTIONS is unchanged`
  - http: `PUT /policy/profile with pace: 200 and effective.pace`; `409 on a stale version`; `400 invalid_profile with layer.pace.burst.lines`;
    `DELETE ?section=pace resets`; `GET returns pace in effective, base and layer`
- **Run:** `npx vitest run packages/core/test/policy-layer-pace.test.ts packages/core/test/policy-layer.test.ts packages/core/test/profile.test.ts packages/core/test/golden.test.ts packages/http/test/admin.policy-pace.test.ts`

### Task 3: The pacer (limiter state)
Spec 4.2 (arithmetic, keys, memory). Pure and clocked; no chat wiring.
- **Files:** `packages/core/src/pacing.ts` (new), test `packages/core/test/pacing.test.ts`.
- **Interfaces (Produces):**
  `createPacer(opts: { clock: Clock; settings: (roomId: string) => ResolvedPace }): Pacer`;
  `PaceKey = { roomId: string; who: string }` (`who` is the canonical subject, or `seat:<seatId>` for a guest);
  `PaceVerdict = { ok: true } | { ok: false; reason: PaceReason; retryAfterMs: number; signalFlood: boolean }`;
  `Pacer = { check(key: PaceKey, line: string): PaceVerdict; commit(key: PaceKey, line: string): void; dropRoom(roomId: string): void; size(): number }`;
  `normalizeForRepeat(text: string): string` (NFKC, lower-case, `\p{L}` and `\p{N}` only).
- **Behaviour:** `check` order is `slow_mode`, `flood`, `duplicate`, first refusal wins, and it never changes timing state (its one
  bookkeeping write is `floodSignalAt`, set when it returns `signalFlood: true`, at most once per `burst.windowMs`). `commit` records the
  line (stamp, `lastAt`, hash). Arithmetic as spec 4.2: `slow_mode` refuses when `now - lastAt < slowModeMs`; `flood` when `burst.lines`
  stamps lie inside the last `windowMs`; `duplicate` compares a truncated digest (`crypto.ts`, never the text) with the last 8 in-window
  hashes, normalized length under 3 never a duplicate, a refused duplicate does not refresh its `at`. `retryAfterMs` is a whole number, at
  least 1, never above the check's own window. State is a map of maps by room, swept every 256 calls against the longest configured
  window, capped at 50 000 keys (oldest go). Settings are read through the function on every call.
- **Tests (names):**
  - `slow_mode: refused inside the gap with the exact retryAfterMs; accepted at exactly the gap; a refused line does not move lastAt`
  - `flood: the (N+1)th line is refused with oldest + window - now; accepted once the oldest ages out; N lines spread wider than the window never trip; a refused line is not counted`
  - `duplicate: same text refused; case, spacing, punctuation, accents-free and full-width variants are one line; a different line is accepted; the third distinct line after two duplicates is fine`
  - `duplicate: window edge exact (just inside refused, at the edge accepted); a refused duplicate does not extend its own block; only the last 8 hashes are compared`
  - `normalized length under 3 is never a duplicate ("gg", "ok", "?!", an emoji-only line, a punctuation-only line)`; `a 3-character CJK line is a duplicate when repeated`; `a 200-character line and a lone surrogate do not throw`
  - `order: slow_mode beats flood, flood beats duplicate`; `a verdict's refusal changes no timing state (check twice, same answer)`
  - `signalFlood is true once per burst window per key and false for the rest; true again in the next window`; `a key is room plus person: the same person in another room, and another person, are unaffected`
  - `retryAfterMs is an integer from 1 up to the window, also for two lines in the same millisecond`; `a clock that steps backwards never gives retryAfterMs above the window` (Review Focus 2)
  - `settings are read live: a longer window saved after a line does not apply a stale longer one; turning a check off applies at once`; `a check set to null does nothing`
  - `memory: 100 000 distinct keys over time stay at or under 50 000 and the sweep drops quiet keys`; `dropRoom removes a room's keys in one step`; `no state holds a line's text` (inspect the stored values)
- **Run:** `npx vitest run packages/core/test/pacing.test.ts`

### Task 4: Pacing in the chat path, the result type and the room override
Spec 4.2 steps 5 to 7, 4.3, 4.5. Needs Tasks 1 and 3.
- **Files:** `packages/core/src/chat.ts` (`RefuseReason` gains `PaceReason`; the `refuse` arm gains `retryAfterMs?: number`; `run` calls
  `check` after `length` and before `rate`, `commit` after `rate` passes; the leading comment's step list is updated; new dep
  `pace?: { settings: (roomId: string) => ResolvedPace; canonical: (s: SubjectId) => SubjectId; onFlood?: (info: { roomId: string; subject: SubjectId }) => void }`),
  `packages/core/src/chatwarden.ts` (`rooms.setPace(roomId, pace | null)`, `rooms.pace(roomId): ResolvedPace`; override map cleared by
  `rooms.close`; settings function = override over `cw.profile.pace`), `index.ts`; tests `packages/core/test/pace-chat.test.ts`.
- **Behaviour:** no `pace` configured makes the dep a no-op that allocates nothing. A pacing refusal has `reason`, `retryAfterMs` and
  nothing else. `onFlood` is called only when the verdict is `flood` with `signalFlood` and the occupant has a subject; a throw from it
  is absorbed and logged `chatwarden.pace_failed { error }`. `setPace` throws `ProfileError` for an invalid value; `setPace(room, null)`
  removes. Task 10 supplies the real `onFlood`.
- **Tests (names):**
  - `off by default: a scripted run of 40 lines gives the same results as the 0.1.6 expectation` (golden table copied from the pre-change run)
  - `order: pacing runs after restricted and length and before rate; a line that is slow_mode and flood is slow_mode; flood and duplicate is flood`
  - `a rate-refused line commits nothing to pacing; a matcher-blocked line commits (its slot is spent); a profanity-refused line commits`
  - `cost: with a counting matcher a pace-refused line never reaches match, spans or the profanity filter and writes no evidence, strike or notice`
  - `retryAfterMs is present for exactly slow_mode, flood and duplicate and absent for every other reason`; `a pacing refusal has no rule, noticeId, until, byModerator or text`
  - `the result still has two arms: 'deliver' in r narrows as before` (type-level with `expectTypeOf`)
  - `guest keyed by seat, known player keyed by canonical subject; re-seating a known player keeps state, a guest in a new seat starts fresh`
  - `setPace applies on the next line; null removes; { slowModeMs: null } disables only that check; {} changes nothing`
  - `rooms.close drops the override and the room's pacing state`; `an invalid override throws ProfileError and changes nothing`
  - `override beats the stored layer, which beats the code profile`; `a saved layer applies to the next line with no restart`
  - `onFlood: called once per window for a known subject, never for a guest, a throw is absorbed and logged by class only`
- **Run:** `npx vitest run packages/core/test/pace-chat.test.ts packages/core/test/chat.test.ts packages/core/test/pacing.test.ts`

### Task 5: Signal declarations, validation and the `signals` profile section
Spec 5.1, 5.9 (cross-check) and the stored-layer rule. Needs Task 2 (same file) and Task 6's type additions.
- **Files:** `packages/core/src/signals.ts` (new: types of spec 5.1 and 5.2, `BUILTIN_SIGNAL_KINDS`, `SIGNAL_KIND_PATTERN = /^[a-z][a-z0-9_]{0,39}$/`,
  `SIGNAL_KINDS_MAX = 40`, `SIGNAL_WINDOW_DAYS_MAX = 90`, `resolveSignals(input, path?)`, `checkSignalFeeds(feeds, kinds, opts: { signalsMs: number }, path)`,
  `pruneSignalFeeds(feeds, kinds, opts)` returning the feeds minus anything unusable), `packages/core/src/profile.ts` (`TOP_KEYS` and
  optional keys gain `signals`; `ModerationProfile.signals?: SignalSettings`; `ResolvedProfile.signals`; `PolicyLayer.signals?: { feeds?: SignalFeeds }`;
  `POLICY_SECTIONS` appends `'signals'` after `'pace'`), `src/index.ts`; tests `packages/core/test/signals.test.ts`, `signals-feeds.test.ts`.
- **Behaviour:** kinds merged over the built-ins (`flood_triggered` may be relabelled or re-weighted, polarity stays negative); kind
  lookups use own properties only. A layer may hold only `feeds`; a layer naming a kind, a guard or any other key is refused with its path.
  A feed naming an undeclared kind, a `queue`/`raise` rule naming a positive kind, `minDistinct` outside 1 to 50, `windowDays` outside 1 to
  90, kinds outside 1 to 8, or a duplicate ladder rule id is refused with its path (`layer.signals.feeds.queue.kinds[0]`). The `windowDays`
  versus `signalsMs` cross-check takes `signalsMs` as an argument (the facade passes it in Task 9). **Decide, then write down in the
  code comment:** a layer's `feeds` replaces the base's `feeds` wholesale (a feed left out is off), like every other section. **Startup
  rule (Review Focus 5):** when the stored layer is loaded, the facade runs `pruneSignalFeeds` first, so a saved feed that now names an
  undeclared kind, or has a window above `signalsMs`, is dropped on its own with `chatwarden.signal_feed_dropped` logged (no ids), and the
  rest of the layer, ladder edits included, stays in force. Save-time validation stays strict.
- **Tests (names):**
  - `declaration: a bad slug, a 0 or 61 character label, a label with markup, a polarity outside the two, a weight outside 0 to 10, 41 kinds: each refused with its path`
  - `redeclaring flood_triggered may relabel and re-weight but not make it positive`; `kinds named constructor, toString and __proto__ are accepted only when declared and never resolve from the prototype` (Review Focus 3)
  - `presets ship signals unset`; `a layer holding kinds or guards is refused with its path`; `a layer feed naming an undeclared kind is refused at layer.signals.feeds.queue.kinds[0]`
  - `queue and raise reject a positive kind; note accepts one; record and ai accept both`
  - `minDistinct 0 and 51, windowDays 0 and 91, kinds [] and 9, a duplicate rule id: each refused`; `a window above signalsMs is refused with its path; a window above 90 is refused`
  - `a layer's feeds replace the base's feeds wholesale; reset("signals") restores the base`; `changedSections lists signals`
  - `pruneSignalFeeds: a stored feed naming a removed kind is dropped alone; a window above a lowered signalsMs is dropped alone; the other feeds and the ladder section survive` (Review Focus 5)
- **Run:** `npx vitest run packages/core/test/signals.test.ts packages/core/test/signals-feeds.test.ts packages/core/test/policy-layer.test.ts packages/core/test/golden.test.ts`

### Task 6: Signal rows in the Store, the memory store, the contract suite, retention
Spec 5.8 (interface), 5.9. The store methods are synchronous like claims.
- **Files:** `packages/core/src/types.ts` (`SignalRow`, `SignalSourceRow`; optional `Store.insertSignal`, `listSignalSources`, `purgeSignals`,
  exactly as spec 5.8), `packages/core/src/retention.ts` (`signalsMs` default 90 days in `RetentionPolicy`, `RETENTION_DEFAULTS`, `FIELDS`;
  floor 14 days in `checkRetentionFloors`; `PurgeResult.signals`; `purge()` calls `purgeSignals(now - signalsMs)` inside its transaction and
  reports 0 for a store without it), `packages/store-memory/src/memoryStore.ts` (a map keyed by `(kind, subject, sourceKey, capBucket)`),
  `test/contract/signals.contract.ts` (registered in `test/contract/index.ts`), tests `packages/store-memory/test/signals.store.test.ts`,
  `packages/core/test/retention.test.ts` additions.
- **Tests (names):**
  - `insert returns true, then false for the same (kind, subject, sourceKey, capBucket); a different bucket, kind, subject or source inserts`
  - `listSignalSources: one row per (subject, kind, sourceKey) with the highest weight, MIN(at) and MAX(at); only rows at or after since; several subjects (a person's aliases) in one call; an empty list gives []`
  - `the grouped result is bounded by distinct sources, not by row volume`
  - `purgeSignals deletes at < before and keeps at == before; returns the count`
  - `retention: default 90 days; 14 days accepted; 13 days refused naming retention.signalsMs; NaN and Infinity refused; purge reports signals; a store without the method purges the rest`
  - `purge deletes flood_triggered rows with the same field`
- **Run:** `npx vitest run packages/store-memory/test/signals.store.test.ts packages/core/test/retention.test.ts`

### Task 7: SQLite migration 21 and the SQLite store (after 0.1.6)
Spec 5.8. Read first: `packages/store-sqlite/src/migrations.ts` (migrations 19 and 20, the 0.1.6 `kit_ai_reads` DDL and the
`AiReadRow` type in `core/src/types.ts`). SQLite is the reference; when the suites disagree the memory store is wrong.
- **Files:** `packages/store-sqlite/src/migrations.ts` (version 21: the DDL of spec 5.8 verbatim, the `ALTER TABLE kit_ai_reads ADD COLUMN
  signals_json TEXT` last, with comments in the existing style), `sqliteStore.ts` (prepared statements; `insertSignal` is one
  `INSERT ... ON CONFLICT DO NOTHING` returning whether a row was written), tests `packages/store-sqlite/test/signals.store.test.ts`,
  `signals.migration.test.ts`; the contract suite from Task 6 runs through `contract.test.ts`; `differential.test.ts` gains the three methods.
- **Tests (names):**
  - `migration 21 from a version 20 database with rows keeps every row; from an empty database creates kit_signals and its three indexes; a rerun is refused`
  - `the ALTER leaves existing kit_ai_reads rows readable and signals_json null`; `weight CHECK refuses a negative weight`
  - `EXPLAIN QUERY PLAN: listSignalSources uses kit_signals_by_subject; purgeSignals uses kit_signals_by_at; insert conflict uses kit_signals_cap`
  - `two connections insert the same cap tuple: exactly one wins` (the cross-process guard)
  - `the shared contract suite passes`; `memory and sqlite give the same answers on the differential script`
- **Run:** `npx vitest run packages/store-sqlite/test/signals.store.test.ts packages/store-sqlite/test/signals.migration.test.ts packages/store-sqlite/test/contract.test.ts`

### Task 8: Counting: distinct sources, weights, thresholds
Spec 5.3. Pure.
- **Files:** `packages/core/src/signalCounts.ts` (new), test `packages/core/test/signals-counts.test.ts`.
- **Interfaces:** `countSignals(rows: readonly SignalSourceRow[], ctx: { kinds: Readonly<Record<string, { label: string; polarity: SignalPolarity }>>; canonical: (s: SubjectId) => SubjectId; windowDays: number }): SignalCount[]`
  (one entry per declared kind with at least one counted source; `SignalCount` as spec 5.2);
  `evaluateThreshold(rows, ctx, t: SignalThreshold): { met: boolean; distinct: number; weight: number; firstAt: number | null; lastAt: number | null }`.
- **Behaviour:** per spec 5.3: group by canonical source (`b:` folds `bySubject` through `canonical`; `r:` and `d:` keys as given), take the
  highest weight per source, drop weight 0, `distinct` is the remaining count, `weight` their sum. A threshold over several kinds takes
  sources per kind and sums, so one player who muted and blocked counts twice (documented in the test name). A kind not in `kinds` is
  ignored.
- **Tests (names):**
  - `ten rows from one by count 1; five different by count 5`; `source-less rows count per room, and per day when there is no room`
  - `two aliases of one by count once after a merge` (Review Focus 4); `rows about an alias and about the canonical person fold into one count`
  - `weights per source take the max`; `weight 0 drops a source`; `minWeight is honoured; distinct below minDistinct is not met`
  - `muted plus blocked by one player counts twice for a two-kind threshold and once for a one-kind threshold`
  - `a kind outside the request is absent; an undeclared kind in the rows is ignored`; `firstAt and lastAt span the counted sources`
  - `empty rows give [] and a not-met threshold with null times`
- **Run:** `npx vitest run packages/core/test/signals-counts.test.ts`

### Task 9: The signal service and `cw.signals`
Spec 5.2, 5.4, 5.8 (facade behaviour), 9. Needs Tasks 5, 6, 8.
- **Files:** `packages/core/src/signalService.ts` (new), `packages/core/src/chatwarden.ts` (option `signals?: { accountAgeDays?: (accountIds: readonly string[]) => number | null | undefined }`;
  `cw.signals = { record, counts, kinds, boosted, forRecord }`; passes `retention.signalsMs` to the feed cross-check; runs the Task 5 prune
  at layer load), `src/index.ts`; tests `packages/core/test/signals-guards.test.ts`, `signals-service.test.ts`.
- **Interfaces:** `record`, `counts`, `kinds` exactly as spec 5.2. Two additions this plan makes (the spec leaves the http layer without a
  way to read the feeds; see the gap list in the hand-back): `boosted(people: readonly SubjectId[]): Set<SubjectId>` (those who meet
  `feeds.queue`, one grouped store read, empty set when the feed is off) and `forRecord(subject: SubjectId): SignalCount[]` (the
  `feeds.record` kinds and window, `[]` when off). Both `@experimental`, never throw.
- **Behaviour:** resolve a party: a string is made canonical and must be known to the subject index (`unknown_subject` otherwise); an
  object goes through `personOf` (find, never create). Refusal reason codes, logged `chatwarden.signal_refused { reason }` through
  `ThrottledWarn`: `undeclared`, `malformed`, `unknown_subject`, `self`, `time`, `capped`, `no_store`, `store_failed`. Row: `sourceKey`
  `b:<canonical by>` | `r:<roomId>` | `d:<UTC day>`, `capBucket = floor(at / perByWindowMs)`, stored weight = given or default times the
  new-account factor (only when the hook exists, returns an age, and the age is below `belowDays`; a throw is unknown, factor 1, logged by
  class). `at` defaults to now, at most 5 minutes ahead, not older than `signalsMs`. `roomId` matches `[A-Za-z0-9_.:-]{1,64}`.
  `createChatwarden` throws a plain message when the profile declares kinds or feeds and the store lacks the methods, and treats
  `flood_triggered` as skipped (logged once) when only pacing is on.
- **Tests (names):**
  - `declared kind records true; undeclared, non-string kind, missing subject, roomId with a space or over 64, at in the far future or before retention: each false`
  - `record never throws for hostile input: a throwing getter, a Proxy, a BigInt, a cyclic object, a symbol, 1 MB strings, null, a kind named constructor or __proto__ that is not declared` (Review Focus 3)
  - `subject equal to by is false, also when they differ only by a merge; a merge after recording folds the two sources in counts` (Review Focus 4); `an unknown RawWho is false and creates no subject`; `an unknown subject id string is false`
  - `cap: a second record of the same (kind, subject, by) inside perByWindowMs is false and true after it; a different kind, subject or by is unaffected; recording as an alias of the same by is also capped`
  - `new-account guard: no hook means no weighting even when the profile sets newAccount; an age below belowDays multiplies the stored weight, at or above does not; null or a throw is factor 1; changing the guard leaves stored rows alone`
  - `weight override per call is used and clamped 0 to 10; a weight outside it is false`
  - `counts: one entry per kind with a source, aliases folded, windowDays and kinds options honoured, a store failure reads []`; `kinds() lists built-ins and declared kinds with builtin flags`
  - `boosted and forRecord are empty when their feed is off and never read the store`; `boosted uses one grouped read for 200 people`
  - `a store without signals: record is false and logged once; createChatwarden throws with kinds declared; pacing-only skips flood_triggered`
  - `logs hold event names and reason codes only: no subject, by, room, kind id or label appears in any captured log line`; `the refusal log is throttled to one a minute with a held count`
- **Run:** `npx vitest run packages/core/test/signals-guards.test.ts packages/core/test/signals-service.test.ts packages/core/test/signals-counts.test.ts packages/core/test/signals.test.ts`

### Task 10: `flood_triggered`
Spec 4.4. Needs Tasks 4 and 9.
- **Files:** `packages/core/src/chatwarden.ts` (the real `pace.onFlood`: `queueMicrotask` then `signals.record({ kind: 'flood_triggered', subject, roomId })`
  with no `by`; a failure logged `chatwarden.pace_failed`/`signal_failed` by class and absorbed), test `packages/core/test/pace-signal.test.ts`.
- **Tests (names):**
  - `a flood trip records flood_triggered once per burst window per player per room`; `five trips in one window leave one row; the next window adds a row only when the per-room-per-day cap allows`
  - `the verdict is returned before the write` (assert the store sees nothing until the microtask runs)
  - `slow_mode and duplicate record nothing`; `a guest records nothing`; `a player flooding ten rooms leaves ten rows`
  - `a store failure is absorbed and logged by class only`; `a store without signals is skipped and logged once`
  - `the row has no by, a room id and weight 1; counts() shows it as one source per room`
- **Run:** `npx vitest run packages/core/test/pace-signal.test.ts packages/core/test/pace-chat.test.ts`

### Task 11: The ladder feed
Spec 5.6. Needs Task 9. Pure `suggest()` plus facade glue.
- **Files:** `packages/core/src/ladder.ts` (`SignalHit`, `SuggestContext.signals?`, `Suggestion.signals?: { raised: boolean; ids: string[] }`;
  `suggest` applies hits after the pick and the area swap), `packages/core/src/chatwarden.ts` (`cw.suggest` computes hits from
  `feeds.ladder` for the reported person and sets `context.signals`; a caller-passed `signals` is ignored), test
  `packages/core/test/ladder-signals.test.ts`.
- **Behaviour:** `note` appends `Also: <text>.` to `why` and leaves the outcome. `raise` takes the stronger of the current pick and the
  cell at `min(recordStep + 1, 5)` of the same column, and falls back to the note alone when that cell is permanent or the record is at
  step 5. Several rules combine to at most one step. `banter` returns before any of this. The area-rule swap applies after a raise.
  `text` is `<label>: <distinct> players in <windowDays> days` (singular `player`/`day` at 1). `policy.preview` samples carry no hits.
- **Tests (names):**
  - `with no feed the suggestion is deep-equal to the golden table`; `note appends the sentence and keeps the outcome`
  - `raise moves one step in the same column`; `raise never goes past step 5, never into a permanent cell (note only), never below the first-offence outcome`
  - `two raise rules firing give one step`; `the area swap still applies after a raise`; `a positive-only hit only notes`
  - `banter returns unchanged with hits`; `an incident with no conduct has no suggestion, so a signal never starts a case`
  - `Suggestion.signals lists the ids and raised flag only when a rule fired`; `a context.signals passed by the caller to cw.suggest is ignored`
  - `the preview with sample records is unchanged`; `singular text at one player and one day`
- **Run:** `npx vitest run packages/core/test/ladder-signals.test.ts packages/core/test/ladder.test.ts packages/core/test/golden.test.ts`

### Task 12: The queue boost in take-next (after 0.1.5)
Spec 5.5. Read first: `packages/core/src/team.ts` (`CaseDesk.next`, `rankedDown`, `RANK_SLICE`, `NEXT_PAGE`, `TeamDeps.accuracy`) and
`reporterAccuracy.ts` (`REPORTER_RANK_LAPSE_MS`) from 0.1.5. Needs Task 9.
- **Files:** `packages/core/src/team.ts` (`TeamDeps.boosted?: (people: readonly SubjectId[]) => Set<SubjectId>`; `next` filter
  `signalBoost?: boolean`, type-checked like `rankDownHabitual`; constant `SIGNAL_BOOST_SCAN_MAX = 200`), `chatwarden.ts` (wires
  `boosted`), exports, test `packages/core/test/team-signal-boost.test.ts`.
- **Behaviour:** the scan stays oldest first. The first case that is overdue (an open report waiting `REPORTER_RANK_LAPSE_MS`) or boosted
  is claimed; if the queue or the 200-person scan ends with neither, the oldest free case is claimed as now. A boosted case is never
  ranked down. Nothing leaves the queue.
- **Tests (names):**
  - `without the filter take-next is unchanged`; `signalBoost must be a boolean`
  - `a boosted newer case is claimed before an ordinary older one`; `an overdue ordinary case is claimed before a newer boosted one`; `among boosted, oldest first`
  - `a boosted case held by someone is skipped`; `the scan cap falls back to the oldest free case`; `a stream of boosted cases cannot starve an old case past 24 hours`
  - `it composes with rankDownHabitual: a boosted habitual-reporter case is not ranked down`; `nothing is dropped: draining the queue claims every case once`
  - `with the feed off boosted is not called` (spy)
- **Run:** `npx vitest run packages/core/test/team-signal-boost.test.ts packages/core/test/team.test.ts`

### Task 13: HTTP: the bodies
Spec 5.5, 7. Needs Tasks 2, 11, 12. Read first: `packages/http/src/admin/reports.ts` (history route, report list), `team.ts`
(`POST /cases/next` passes `rankDownHabitual: true`).
- **Files:** `packages/http/src/admin/reports.ts` (`GET /people/:ref/history` gains `signals: SignalCount[]` from `cw.signals.forRecord` only
  when `feeds.record` is on; `GET /reports` items gain `boosted: true` from `cw.signals.boosted`, one call per page; route comment),
  `team.ts` (`signalBoost: true` when `feeds.queue` is set), `packages/http/src/admin/policyProfile.ts` comment (sections), tests
  `packages/http/test/admin.signals.test.ts`, `admin.bodies-off.test.ts`.
- **Tests (names):**
  - `bodies are byte-identical with everything off`: snapshot of `GET /reports`, `GET /reports/:id`, `GET /people/:ref/history`, `POST /cases/next` against the 0.1.6 shape
  - `history carries signals only when feeds.record is set, only the chosen kinds and window, and no by, room or row`; `the signals key is present as [] when the feed is on and no count qualifies, and absent when the feed is off`
  - `GET /reports marks boosted only with the feed on and only on meeting people; no summary field names a signal`
  - `POST /cases/next passes signalBoost true only with the feed on`
  - `PUT /policy/profile with signals.feeds: 200; a stale version 409; a layer naming a kind 400 invalid_profile with layer.signals...; a feed with an undeclared kind 400 with its path; a window above retention 400`
  - `POST /reports/:id/suggest and GET /reports/:id carry signals in the suggestion and the sentence in why when a rule fired`
  - `history.view is the only audit row for a Person page read with signals; no new audit action`; `a viewer without history.read gets no signals`
  - `every route stays no-store and JSON`
- **Run:** `npx vitest run packages/http/test/admin.signals.test.ts packages/http/test/admin.bodies-off.test.ts packages/http/test/admin.policy-pace.test.ts packages/http/test/admin.every-route.test.ts`

### Task 14: The AI feed (after 0.1.6)
Spec 5.7. Read first, in the `ai-levels` merge: `packages/core/src/ai/types.ts` (`AIReadInput`, `AI_PROMPT_VERSION`), `prompt.ts`
(`buildAIInput`, the stable text, `PROMPT_VERSION`), `hash.ts` (`inputHash`), `service.ts`/`worker.ts` (where the input is built per job),
the `AiReadRow`/`AiReadDone` types and `completeAiRead` in both stores, `packages/hub-react/src/case/AiDetails.tsx`,
`screens/AiSettings.tsx`, and `docs/design/2026-11-11-ai-levels-1-2.md` section 8.
- **Files:** `core/src/ai/types.ts` (`AIReadInput.signals?: Array<{ label; polarity; distinct; windowDays }>`; `AI_PROMPT_VERSION = 2`),
  `prompt.ts` (stable text gains the one always-present paragraph of 5.7; the variable part renders `Context about P1, not evidence: ...`
  last), `hash.ts` (the hash excludes the signal block: it hashes the variable text as rendered without it), the worker (fills `signals`
  from `cw.signals` for P1 only, only when `feeds.ai` is set and the level is above 0), `AiReadDone.signals` stored as `signals_json`
  by both stores (`store-memory`, `store-sqlite`; column from Task 7), the read view and `AiDetails.tsx` ("Context included: N signal
  counts"), the AI Settings help text, the AI design note's section 8 sentence amended; tests in `packages/core/test/ai/signals-input.test.ts`
  and additions to `packages/core/test/contract/ai.contract.ts`.
- **Tests (names):**
  - `with feeds.ai off the variable part and the hash are byte-identical to the same input without signals, and the stable part is identical with the feed on and off` (the version moved to 2 for everyone; the hash differs from 0.1.6's only through it)
  - `with feeds.ai on the block holds label, polarity, distinct and window and nothing else`: a scan of the rendered text for a subject id, a room id, a time, a weight and a kind id finds none
  - `the hash is the same before and after a new signal arrives; Read again takes a new snapshot`; `a stale read caused by version 2 is marked stale, not re-read in bulk`
  - `signals_json records exactly what was sent; null when none; existing rows stay readable`
  - `only P1 gets a block; report counts, reporter accuracy and history are still never sent`
  - `the ceilings are untouched: a recommendation to uphold with signals present and no own line is still downgraded to unclear`
  - `the prompt.stable length guard (9 000 characters) still holds under each preset`
  - hub: `AiDetails shows "Context included: 2 signal counts" only when signals_json is set` (menu only, no new always-visible element)
- **Run:** `npx vitest run packages/core/test/ai/signals-input.test.ts packages/core/test/ai/prompt.test.ts packages/core/test/ai/hash.test.ts packages/store-memory/test/ai.store.test.ts packages/store-sqlite/test/ai.store.test.ts packages/hub-react/test/ai-details.test.tsx`

### Task 15: player-react: the `pace` prop and the words
Spec 4.7. Independent of the core tasks (it takes the refusal's values as props).
- **Files:** `packages/player-react/src/RestrictedChatLine.tsx` (`until`/`byModerator` optional; new `pace?: { reason: PaceReason literal union; retryAfterMs: number }`
  prop; with `pace` it replaces the sanction text, draws no `Card`, keeps `role="status"`; the end time is worked out once on first render
  with `useRef`/`useState` as `ui.now() + retryAfterMs`), `format.ts` (`secondsLeft(ms: number, locale: string): string | null`), `i18n.ts`
  (`player.pace.slow_mode`, `.flood`, `.duplicate`), the README, tests `restricted-chat-line.test.tsx` additions, `format.test.ts`
  additions, `static.test.ts` export lock and `size.test.ts` re-checked.
- **Behaviour:** `secondsLeft` is whole seconds, rounded up, up to 120 seconds, then it defers to `timeLeft`. **Decide (spec gap):** it
  formats through `Intl.RelativeTimeFormat` like `timeLeft`, so the value already reads "in 3 seconds" or "in 3 minutes"; the three
  messages therefore put `{left}` without a literal "in", and the `player.pace.wait.*` keys are not added.
- **Tests (names):**
  - `each reason renders its sentence with the wait, no referee card, role="status"`; `the old until and byModerator props render exactly as before` (existing tests untouched)
  - `500 ms reads as 1 second; 119 000 reads in seconds; 125 000 reads in minutes; secondsLeft returns null for 0 and negatives and the line still renders`; `a re-render does not restart the wait`
  - `the sentence never shames and holds no id` (copy check in `i18n.test.ts`); `a missing key in another locale falls back to English`
  - `no-leak.test.tsx passes; static.test.ts lists secondsLeft and the new prop; size.test.ts budget holds`
- **Run:** `npx vitest run packages/player-react/test/restricted-chat-line.test.tsx packages/player-react/test/format.test.ts packages/player-react/test/i18n.test.ts packages/player-react/test/no-leak.test.tsx packages/player-react/test/static.test.ts packages/player-react/test/size.test.ts`

### Task 16: hub-react: wire types, the queue seam and the Person-page lines
Spec 5.5, 6. Needs Task 13. The always-visible additions are zero.
- **Files:** `packages/hub-react/src/types.ts` (`ReportSummary.boosted?: true`; `PersonHistory.signals?: SignalCountView[]`), `queue.ts`
  (`RankSignals.conduct?: (g: QueueGroup) => number`; `SIGNAL_BOOST = 0.5`; `priorityScore` adds a clamped, NaN-safe conduct term, same clamp
  as `reporter`; `groupQueue` copies `boosted` onto the group), `person/SignalLines.tsx` (new, lazy via `screens/lazy.tsx`, rendered in the
  Timeline panel footer by `screens/Person.tsx`), `i18n.ts` (`hub.person.signals.*`), tests `queue-signal.test.ts`,
  `person-signals.test.tsx`, `a11y-person.test.tsx` addition, `api.test.ts` and `apiNames.ts` updated deliberately, `size.test.ts`.
- **Tests (names):**
  - `a boosted group scores plus 0.5 in the priority sort; the clamp is plus or minus 0.5; NaN and Infinity from conduct are ignored; no signals gives the same order as without`
  - `the default sort and the chip set are unchanged; an older server that sends no boosted field gives every group the neutral weight`
  - `the Person page shows "Muted by other players: 5 (last 14 days)" style lines inside the Timeline panel footer only, with counts above 0 and the feed on`
  - `with no signals field, an empty array or all-zero counts: nothing renders and no extra element exists`; `lines read in words, polarity as "counts against" / "counts for", no colour class`
  - `the line shows when the sources were (first and last) so five in two hours reads differently from five in twelve days`
  - `the lines load lazily: the main chunk gains no SignalLines code` (existing lazy-load pattern); `axe: no violations`
  - `a DOM snapshot of the queue, the case card, the top bar and Simple mode is unchanged`; `size.test.ts budget (76,800 B gzip) holds`
- **Run:** `npx vitest run packages/hub-react/test/queue-signal.test.ts packages/hub-react/test/person-signals.test.tsx packages/hub-react/test/a11y-person.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/size.test.ts`

### Task 17: hub-react: Settings, Advanced, "Slow mode and flooding"
Spec 4.8. Needs Tasks 2 and 13. Read first: `screens/ReportingSettings.tsx` and the `policy/` hooks it uses (`useSaveFlow`, `useResetFlow`,
`useDraftSync`, `useUnsavedGuard`, `SaveBar`).
- **Files:** `packages/hub-react/src/screens/AdvancedSettings.tsx` (lazy; the Advanced section hosts panels, this task adds the first),
  `screens/PaceSettings.tsx` (lazy panel), `screens/lazy.tsx`, `screens/Settings.tsx` (one entry, `need: 'policy.read'`), `router.ts`
  (`SettingsSection` and `SETTINGS_SECTIONS` gain `'advanced'`), `policyHooks.ts` (read-merge-write of `layer.pace`), `i18n.ts`
  (`hub.settings.advanced.nav`, `hub.settings.pace.title`, labels, the two hint lines), tests `pace-settings.test.tsx`, `a11y-settings.test.tsx`
  addition, `api.test.ts`, `lazy-screens.test.tsx`, `size.test.ts`.
- **Behaviour:** the form edits seconds (slow mode, repeats) and "N messages in W seconds", each with an off state; "Use suggested values"
  fills the draft from `PACE_SUGGESTIONS` for the profile's preset and never saves; a reason is required to save; a 409 offers a reload;
  per-section reset. The hint "The built-in limit of 3 messages per 5 seconds applies first" shows when the burst is looser than
  `limits.chatRate` (read from the effective profile response; shown unconditionally if that value is unknown). One line says the settings
  apply per process and to every room unless the game overrides a room. The owner edits; seniors and moderators read.
- **Tests (names):**
  - `the Advanced section appears for policy.read only`; `only the owner can save; others see the values read-only`
  - `defaults to all off`; `seconds convert to ms on save and back on load`; `an out-of-range value shows the field error and does not save`
  - `suggested values fill the form but do not save`; `saving sends the whole layer with pace merged and a reason`; `a 409 offers to reload`; `reset restores the base`
  - `the built-in limit hint shows beside a burst looser than 3 per 5 seconds and not beside a tighter one`
  - `Simple's menu is unchanged (snapshot)`; `the panel is lazy: the main bundle gains no pace-settings code`; `axe: no violations, 360 px no sideways scroll`; `size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/pace-settings.test.tsx packages/hub-react/test/a11y-settings.test.tsx packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task 18: hub-react: Settings, Advanced, "Signals"
Spec 6. Needs Tasks 5 and 13; the "Give the AI read as background" form shows only when the AI is available (Task 14 supplies the status
flag, **after 0.1.6**; before that the form is hidden).
- **Files:** `packages/hub-react/src/screens/SignalSettings.tsx` (lazy panel under Advanced), `screens/lazy.tsx`, `policyHooks.ts`
  (`layer.signals.feeds`), `client.ts` (declared kinds arrive in the profile response; add the field to the wire type), `i18n.ts`
  (`hub.settings.signals.*`), tests `signal-settings.test.tsx`, `a11y-settings.test.tsx`, `api.test.ts`, `size.test.ts`.
- **Behaviour:** declared kinds are read-only (label, polarity in words, default weight, "Declared in your game's code"). Four small forms,
  each off until switched on: show on a person's record; put these people sooner in the queue (negative kinds only); add to the suggested
  step (a short list of rules, each kinds, N players, D days, and "add a note" or "suggest one step higher", the second offered for
  negative kinds only); give the AI read as background. Window inputs are capped at the smaller of 90 and the retention in days. The
  honest sentence "A signal never acts on its own. A person always decides." sits under the forms.
- **Tests (names):**
  - `with no declared kinds the panel says so and offers no form`; `declared kinds are listed read-only with weight and polarity words`
  - `each form is off by default and saves nothing until switched on`; `the queue and raise choices list negative kinds only`
  - `saving sends the whole layer with signals.feeds merged and a reason`; `a 400 invalid_profile with a layer path shows the field error`; `a 409 offers to reload`
  - `the AI form is hidden when the AI is not available`; `the window cannot exceed 90 days or retention`
  - `only the owner edits; policy.read sees it read-only`; `no colour class carries polarity`; `lazy: the main bundle gains no signal-settings code`; `axe, 360 px, size budget`
- **Run:** `npx vitest run packages/hub-react/test/signal-settings.test.tsx packages/hub-react/test/a11y-settings.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task 19: Docs, example, gates
- **Files:** READMEs of `core` (`cw.signals`, `cw.rooms.setPace`, the refusal reasons, the retention table, the per-process advice from
  4.6, "events, not lines"), `http` (the changed bodies), `player-react` (the `pace` prop and words), `hub-react` (Settings, Advanced); the
  `@experimental` list in each README (spec 13); `docs/status.md` (K-line for 0.1.7), `docs/plans/follow-ups.md` (the spec 12 list);
  `examples/tiny-chat` (a `CW_DEMO_PACE=1` switch turning on a 2-second slow mode and showing the line; test `examples/tiny-chat/pace.test.ts`);
  `scripts/readme.test.ts` expectations; core export snapshot; the `scripts/browser-bundle.test.ts` budget check. No site change (spec 12).
- **Tests (names):** `tiny-chat with CW_DEMO_PACE refuses a second line inside two seconds with slow_mode and no refusal without it`; `the readme checks pass`; `the browser bundle budget holds`.
- **Run:** `npx vitest run examples/tiny-chat/pace.test.ts scripts/readme.test.ts scripts/browser-bundle.test.ts`, then `npm run lint` and `npm run typecheck`.

### Task 20: Release prep 0.1.7
See the Release section. Changeset, `npm run version`, peer floors by hand, `scripts/manifests.test.ts`, `npm run check:pack` after deleting
`dist`, `node scripts/smoke.mjs`. Publishing is the maintainer's.
- **Tests (names):** `manifests: the published set is still the ten, none private`; `the new floors are the ones in NEEDS_NEW_KIT`; `publish-order is unchanged`; `smoke: the consumer projects still install and the ESM, CommonJS and no-React checks pass`.
- **Run:** `npx vitest run scripts/manifests.test.ts scripts/publish-order.test.ts scripts/release-workflow.test.ts scripts/changelog.test.ts scripts/sync-version.test.ts`

---

## Release

**What ships:** a patch, 0.1.7, of the ten packages in the fixed group. No new package, so the OIDC publish path is unchanged.

### Before the tag (all in the branch)
1. `npx changeset`: patch for the group. **The first line says it adds a refusal reason** (`slow_mode`, `flood`, `duplicate`, and the optional
   `retryAfterMs`): an adopter whose `switch (reason)` ends in `assertNever` will not compile until it handles them, though it can only
   receive them after turning pacing on. Then plain sentences: pacing, signals, the three feeds, SQLite migration 21 (one-way: a database
   opened by 0.1.7 is not readable by 0.1.6 tooling, as for 19), the `@experimental` names, the per-process advice.
2. `npm run version` (bumps the ten, runs `sync-version`, refreshes the lockfile).
3. **Raise the peer floors by hand** (RELEASING.md "When a peer floor must rise"), only where a package uses a name new in 0.1.7: `store-memory`
   and `store-sqlite` on `@chatwarden/core` `^0.1.7` (the three optional `Store` methods and row types); `http` on core `^0.1.7`
   (`cw.signals.boosted/forRecord`, `signalBoost`, `Suggestion.signals`); `hub-react` on core `^0.1.7` and http `^0.1.7` (the new wire
   fields and the `pace`/`signals` profile sections). `core`, `matcher`, `profanity`, `discord` keep their floors. `player-react` keeps its
   floor unless it imports a new core name (its `pace` prop uses its own literal union; confirm with a grep). `hub-element` follows
   `peerRangeOf` for its bundled hub-react. Run `npm install --package-lock-only`, change `NEEDS_NEW_KIT` in `scripts/manifests.test.ts` in the same
   commit, and name each package and API in the changeset. Never raise a floor just because the group moved.
4. `npm run check:pack` after deleting `dist`, and `node scripts/smoke.mjs`.
5. A dry run: `gh workflow run release.yml -f dry_run=true --ref flood-signals`.
6. Merge when CI is green. **Tag and push only on the maintainer's go-ahead.** The release publishes the ten through OIDC with provenance.

### What the adopter does (not part of the tag)
Nothing is on by default. To use pacing: set `pace` in the profile or in the hub (Settings, Advanced), and call `cw.rooms.setPace` for rooms
that differ. To use signals: declare `signals.kinds` in code, call `cw.signals.record` from the game's events, then switch on a feed in the
hub. Route a room's chat to one process, or accept the looser effective limit.

### Site and announcement
No site change in this release (spec 12). The public site flips a promise only after the release is on npm and has run in Moxgate.

---

## Spec coverage (self-review)
Sections 4.1 to Task 1 and 2; 4.2 and 4.3 to 3 and 4; 4.4 to 10; 4.5 to 4; 4.6 to 19 (README) and 17 (hint); 4.7 to 15; 4.8 to 17; 4.9 and
4.10 to 2; 5.1 to 5; 5.2 and 5.4 to 9; 5.3 to 8; 5.5 to 12, 13 and 16; 5.6 to 11; 5.7 to 14; 5.8 to 6 and 7; 5.9 to 6 and 5; 6 to 18; 7 to 13;
8 (no audit, events or webhooks) to 2 and 13; 9 to the Global Constraints and 9; 10 to the per-task tests; 13 to 19 and 20. Every name used in
more than one task (`PaceReason`, `ResolvedPace`, `Pacer`/`PaceVerdict`, `SignalCount`, `SignalHit`, `SignalRow`/`SignalSourceRow`,
`boosted`, `forRecord`, `signalBoost`, `SIGNAL_BOOST`) is defined once in its owning task and consumed under the same spelling.
