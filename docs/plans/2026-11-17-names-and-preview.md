# Offensive names in reports, and "What the player sees" (0.2.0 theme) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** a player can report a name (`name`, "Inappropriate name", CR 7); a moderator deciding that report can ask for a new name beside
the usual choices, combined with a sanction, in the same request as the decision; and every hub action that sends or withholds a
notice shows "What the player sees": the notice as the player will read it, built from one shared source of words, live as the choice
changes, or a plain line saying nothing is sent.

**Architecture:**
- `@chatwarden/core` gets the subpath `@chatwarden/core/notice-copy` (`NOTICE_WORDS`, `noticeView`, the date formatters moved out of
  player-react, `communityRuleLabel`, `planNotices`, `appealReplacementEnd`), `NoticeService.lineText` and `cw.notices.lineText`, a
  required `rule` on `names.requireRename`, and the `name` default reason. No store change.
- `@chatwarden/http`: `POST /reports/:id/decide` takes `rename` and answers it; `POST /people/:ref/rename` requires `rule`; `GET /reports/:id`
  lines carry `noticeText`; `GET /policy` carries `notices.reporterFeedback`.
- `@chatwarden/player-react` renders its notices from the core's `noticeView` and spreads `NOTICE_WORDS` into `en` (no visible change).
- `@chatwarden/hub-react` gets a lazy `PlayerPreview` panel on the decision bar, Simple's card, the Person forms, revoke and the appeal
  card; the rename row and its off-hint in the decision bar; and the appeal card's choice plus "Send decision".

**Spec:** `docs/design/2026-11-17-names-in-reports-and-player-preview.md` (section numbers below refer to it), including its closing
Rulings. Also binding: `docs/design/2026-11-12-appeals-and-names.md` (5.3 to 5.7, the rename machinery) and
`docs/design/2026-11-10-hub-simple-mode-and-embedding.md`.

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly`, every time from the injected
  `Clock` (no `Date.now()` in core), synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn), test-first,
  targeted runs only, `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree: commit by
  pathspec, `git add` new files first. Every hub string through `t()`.
- **Release.** This is one theme of 0.2.0, which also carries other themes (filter rules and privacy; the urgent lane, desk and rooms;
  any server, many rooms and languages). Branch `names-preview`, worktree `C:\dev\chatwarden-wt\names-preview`. **There is no release
  task here:** the controller prepares 0.2.0 (version, changeset, peer floors, `manifests.test.ts`, `check:pack`, smoke) for the whole
  release. Hand-off for that prep: `http`, `hub-react` and `player-react` must peer on a core that has `@chatwarden/core/notice-copy`
  and `cw.notices.lineText`; `hub-react` reads the new `http` fields.
- **No compatibility paths (owner, 2026-11-17).** No users yet: no optional-for-old-servers fields, no version gates, no shims, no
  byte-identical-body tests. Breaking changes are listed in spec section 12; each task states which it makes.
- **Migration.** This theme adds no table or column, so it adds nothing to migration 26. Do not add one.
- **Other themes land in the same files.** The urgent lane, desk and rooms theme will touch the queue and case panes. Before Tasks 7 to 9,
  rebase on whatever of 0.2.0 has merged to `main` and re-read `DecisionBar.tsx`, `CaseCard.tsx`, `useDecisionForm.ts`,
  `headless/decisions.ts` and `Person.tsx`; tasks name symbols, not line numbers.
- `@chatwarden/core` stays browser-safe and dependency-free: no `node:` import, no `fetch`. The new subpath is pure data and functions,
  no React. `scripts/browser-bundle.test.ts` budgets are re-checked.
- **The moderator-only fields never reach the panel.** `planNotices`' input type has no reason, evidence, gap note, actor, staff ref, group
  id, IP flag, AI read or appeal statement field, and every panel test places sentinels in those fields of the form and scans the DOM
  and `aria` text for them (Review Focus 1).
- **Hub budget.** `packages/hub-react/test/size.test.ts` (88 KB gzip total, 52 KB entry) is near its limit: the panel, its words and its
  plan glue are a lazy chunk (`lazyParts.tsx`); eager code is limited to the form's `rename` field, the client types and the lazy
  wrapper. `size.test.ts` runs in every hub task.
- **UI rule (clean core, power behind one door).** New always-visible UI is only the panel itself, inside each action. The rename row
  is visible at once only for a `name` report and otherwise behind the existing action editor; the off-hint is one line on a `name`
  report. No new colour. Check in a real browser at desktop and 360 px, light and dark, for Tasks 7 to 9.

## Review Focus
Five failure modes no task's happy-path tests would otherwise exercise; each has its test in the owning task.
1. **A moderator-only field in the panel.** A reason, evidence, gap note, actor, ref, group id, IP flag, AI text or appeal statement
   rendered into the preview, an `aria-label` or the live-region sentence. Tasks 6 to 9.
2. **The plan disagreeing with the services.** Who gets which notice, in what order, with what end and which masked lines: decisions
   (pairs of kinds, two people, bad faith, reporter feedback on and off, rename), direct sanctions, revokes, appeal outcomes including
   a reduction already over. Task 6.
3. **A quoted line shown raw.** A blocked line, a line with no spans, a throwing matcher, a line that is not the person's own. Tasks 3, 6, 7.
4. **The decision and the rename partly succeeding.** A rename refused or failed after the decision wrote; a replay; an Undo; a claim;
   renames turned off between the form and the send. Tasks 2 and 8.
5. **Moving player-react's words and formatters.** The player's most-seen dialog must render exactly what it did, in every notice shape,
   with a translation spread over `en`. Tasks 4 and 5.

## Order and parallelism
Tasks 1, 2, 3 and 4 are independent and can run at once. Task 5 follows 4. Task 6 follows 4. Task 7 follows 3, 4 and 6. Task 8 follows 1,
2 and 7. Task 9 follows 7.

---

### Task 1: The `name` reason
Spec 3.1. Core, with tests in four packages.
- **Files:** `packages/core/src/reporting.ts` (`DEFAULT_REPORT_REASONS` gains `reason('name', 'Inappropriate name', 'An offensive or inappropriate player name', 'Chat', [7])` after `personal_info`; update the doc comment listing the defaults), tests
  `packages/core/test/reporting-name-reason.test.ts` (new), and the existing counts: `packages/core/test/policy-reporting.test.ts`,
  `reporting-settings.test.ts`, `packages/http/test/admin.report-reasons.test.ts`, `packages/hub-react/test/policy/reporting-model.test.ts`,
  `packages/hub-react/test/a11y-reporting.test.tsx`, `packages/player-react/test/report-flows.test.tsx` (anything counting 10 reasons or
  listing ids in order), `packages/core/README.md` (the default reasons list).
- **Interfaces (Produces):** `DEFAULT_REPORT_REASONS` has 11 entries; `name` is index 6 (after `personal_info`, before `cheating`).
- **Tests (names):**
  - `name is a default reason: label, hint, group Chat, rules [7], no note, enabled, after personal_info`; `the defaults are 11 and the list stays frozen`
  - `CR 7 is "No offensive names" in relaxed, standard and strict`; `suggestedRule is 7 for name and uncovered when rule 7 is retired or the list has no such reason`
  - `legacyCategoryOf('name') is other and reasonOfCategory leaves it alone`; `canonicalReasonId and reasonLabel find it`
  - `a profile with a reasons list of its own does not gain name; reset restores the defaults including name`
  - http: `GET /reporting lists Inappropriate name under Chat`; `a report with reason name is accepted and stored as reportedReason name`; `GET /reports?reason=name filters`
  - `the reasons that counted 10 count 11` (the files above)
- **Run:** `npx vitest run packages/core/test/reporting-name-reason.test.ts packages/core/test/policy-reporting.test.ts packages/core/test/reporting-settings.test.ts packages/http/test/admin.report-reasons.test.ts packages/hub-react/test/policy/reporting-model.test.ts packages/hub-react/test/a11y-reporting.test.tsx packages/player-react/test/report-flows.test.tsx`

### Task 2: A rename always cites a rule, and `decide` can ask for one
Spec 3.2 (the send), 3.4. Core and http. Breaking: `requireRename.rule` and the route's `rule` are required.
- **Files:** `packages/core/src/nameService.ts` (`requireRename` input `rule: number` required; a missing or non-citable rule is `invalid`; the `autoRestrictRule` default is removed from renames; docs), `packages/core/src/chatwarden.ts`
  (signature and TSDoc), `packages/http/src/admin/names.ts` (`rule` required), `packages/http/src/admin/validate.ts` (`parseRename`, and the decide body's `rename`), `packages/http/src/admin/reports.ts`
  (the decide route: `rename: { rule }` validated before any write; claim gate once; after the decision writes, `cw.names.requireRename({ subject: the reported person, actor, reason: the decision's reason, rule })`; the answer gains `rename: { status: 'asked' | 'already' | 'failed'; error?: 'off' | 'not_found' | 'invalid' }`; audit `name.rename_required` best-effort after the write), `packages/http/src/admin/decideAs.ts` if it shares the body (a `decideAs` caller sends no `rename`; keep the shared parser strict), route doc comments, tests
  `packages/core/test/names-rename-rule.test.ts`, `packages/http/test/admin.decide-rename.test.ts`, edits to `packages/core/test/names-rename.test.ts` and `packages/http/test/admin.names.test.ts`.
- **Interfaces (Produces):** `requireRename(input: { subject; actor; reason; rule: number })`; `POST /reports/:id/decide` body `rename?: { rule: number }`; answer field `rename?: { status; error? }`.
- **Behaviour:** refusals before anything is written: 400 `invalid_request` when `rename` comes with a verdict other than `upheld`, with any action on a person other than the reported person, or without an integer rule; 403 without `sanctions.apply`; 404 when `names.renamesEnabled()` is false (checked before the body, as `POST /people/:ref/rename` does). The decision is written exactly as before (its idempotency key is unchanged: `rename` is not part of it). The core's `pending` becomes `status: 'already'`. A throw in the rename step leaves the decision written and answers `failed`.
- **Tests (names):**
  - core: `requireRename without a rule is invalid; a non-integer, retired or unknown rule is invalid; a numbered rule is accepted and shown on the notice`; `no default rule is used any more`
  - http: `POST /people/:ref/rename without rule is 400; with rule 200; pending_rename 409 and claim rules unchanged`
  - `decide with rename: the sanction notice and the rename notice are both written, sanction first; status asked; two audit rows (decision and name.rename_required)`
  - `rename alone (verdict upheld, no actions) is accepted; the reporter is not thanked`; `a repeated body is replay true and the rename answers already`
  - `refused before any write: rename with no_action, noted or bad_faith (400); an action on the reporter (400); no rule (400); a non-integer rule (400); no sanctions.apply (403, nothing written); renames off (404, nothing written)` (Review Focus 4)
  - `a store fault in the rename step leaves the decision written and answers failed`; `the claim gate runs once and a claimed case is refused before any write`
  - `a decision without rename is answered exactly as before plus no rename field`
- **Run:** `npx vitest run packages/core/test/names-rename-rule.test.ts packages/core/test/names-rename.test.ts packages/http/test/admin.decide-rename.test.ts packages/http/test/admin.names.test.ts packages/http/test/admin.reports.test.ts packages/http/test/admin.every-route.test.ts`

### Task 3: `lineText`, `noticeText` and the policy field
Spec 4.6 (the two server facts). Core and http.
- **Files:** `packages/core/src/notices.ts` (`excerptOf` is split: a public `NoticeService.lineText(line): string` is its per-line step, `excerptOf` maps it; `maskRaw` unchanged), `packages/core/src/chatwarden.ts` (`cw.notices.lineText(line)`, staff side, `@experimental`), `packages/http/src/admin/reports.ts` (`GET /reports/:id`: each excerpt line that is some person's own, by `ownLineIds`, gains `noticeText`), `packages/http/src/admin/policy.ts` (`GET /policy` body gains `notices: { reporterFeedback: boolean }` from `cw.limits`), `packages/hub-react/src/types.ts` (the two fields), tests
  `packages/core/test/notices-linetext.test.ts`, `packages/http/test/admin.notice-text.test.ts`, edits to the policy and no-leak suites.
- **Tests (names):**
  - core: `lineText equals the text createForSanction stores for the same line: a delivered line, a blocked line with spans (only the matched terms starred), a blocked line with no spans or a throwing matcher (all stars), a blocked line the matcher does not recognise (all stars)` (Review Focus 3)
  - `createForSanction still stores the same excerpt as before the split` (existing suite green)
  - http: `every own line of the target carries noticeText; a line of someone else, a line with no writer and the reporter's own non-notice lines do not carry a raw copy; the text is never raw for a blocked line`
  - `GET /policy carries notices.reporterFeedback true by default and false when limits say so`
  - `no-leak: nothing player-visible changes; staff-only fields stay staff-only`
- **Run:** `npx vitest run packages/core/test/notices-linetext.test.ts packages/core/test/notices.test.ts packages/http/test/admin.notice-text.test.ts packages/http/test/admin.reports.test.ts packages/http/test/no-leak.test.ts`

### Task 4: The shared words and view: `@chatwarden/core/notice-copy`
Spec 4.5. Core only. Player-react adopts it in Task 5.
- **Files:** `packages/core/src/noticeCopy.ts` (new: `NOTICE_WORDS`, `NoticeWordKey`, `NoticeWords`, `englishWords()`, `titleKey`, `bodyKey`, `isSanction`, `WARNING_DAYS`, `dayText`, `untilText`, `timeLeft`, `noticeView`, `NoticeView`, `communityRuleLabel`), `packages/core/src/rules.ts` (`CommunityRules.label` calls `communityRuleLabel`), `packages/core/package.json` (`exports['./notice-copy']`, `typesVersions`, `files`), `vitest.config.ts` and every other place that aliases `@chatwarden/core` (grep `chatwarden/core` in `vitest.config.ts`, `tsconfig.base.json`, `packages/hub-element/build/*`, `site/vite.config.*`; the subpath alias goes before the root one), `scripts/check-pack.mjs` (the subpath is in the tarball and importable), `packages/core/README.md`, tests `packages/core/test/notice-copy.test.ts`, `notice-copy-words.test.ts`, `rule-label.test.ts`.
- **Interfaces (Produces):** the words keyed exactly as player-react's (`player.notice.title.warning`, ..., `player.notice.acknowledge`, `player.notice.gotIt`, `player.notice.appeal`, `player.restricted.moderator.until`, `.noEnd`); `noticeView(notice: PlayerNotice, ctx: { words: NoticeWords; locale: string; timeZone?: string; now: () => number; record?: boolean }): NoticeView` where `NoticeView = { kind; title; body; facts: Array<{ id; term; value }>; refHint: string | null; linesLabel: string | null; lines: Array<{ day; text }>; mustAcknowledge: boolean; todo: string | null; button: string; sanction: boolean }`; `communityRuleLabel(ref: RuleRef, title?: string): string`.
- **Behaviour:** the code is moved, not rewritten: `Facts`, `titleKey`, `bodyKey`, `isSanction`, the `WARNING_DAYS` constant and the formatters keep their exact output (the strings equal the 0.1.14 catalog). An unknown kind gets the fallback title and body.
- **Tests (names):**
  - `every NoticeKind has a title and a body in NOTICE_WORDS` (typed over the union, so a new kind fails to compile or run)
  - `NOTICE_WORDS equals the 0.1.14 strings` (snapshot of the values, taken from the current `en` before the move)
  - `noticeView: a warning (on record until, acknowledge), a timed restriction (until with time left), an ended one, a permanent ban (no end date), a report outcome, each message kind, no rule, no reference, five lines, none; record mode adds Given`
  - `an unknown kind falls back; a kind that is not a sanction has no appeal slot`
  - `dayText, untilText and timeLeft keep the cases they had in player-react (bad day, bad zone, now and past)` (moved tests)
  - `communityRuleLabel equals CommunityRules.label for numbered, uncovered, unknown and retired rules`
  - `the subpath imports no node module and no React`; `@chatwarden/core/notice-copy resolves from a packed tarball` (`check-pack`); `the browser bundle budget holds`
- **Run:** `npx vitest run packages/core/test/notice-copy.test.ts packages/core/test/notice-copy-words.test.ts packages/core/test/rule-label.test.ts packages/core/test/rules.test.ts scripts/browser-bundle.test.ts`

### Task 5: player-react renders from the shared view
Spec 4.5, Review Focus 5. Needs Task 4. No visible change.
- **Files:** `packages/player-react/src/i18n.ts` (`en` is `{ ...NOTICE_WORDS, ...the rest }`; the moved keys are deleted from the file), `ui.tsx` (`Facts`, `titleKey`, `bodyKey`, `isSanction` become thin users of `noticeView`/re-exports), `format.ts` (re-exports `dayText`, `untilText`, `timeLeft` from core; keeps `secondsLeft` and `dateText`), `NoticeQueue.tsx`, `MyRecord.tsx`, `RestrictedChatLine.tsx` (draw from `noticeView` and the shared restricted words), `package.json` (nothing: peer floors are the release prep's), `README.md`, tests `packages/player-react/test/notice-copy-parity.test.tsx`, edits to `static.test.ts`, `i18n.test.ts`, `format.test.ts`.
- **Before the move:** take a DOM snapshot of `NoticeQueue` and `MyRecord` for every notice shape (warning, chat, area, ban, report outcome, each message kind, unknown kind, lines and none, appeals on and off) as `test/baselines/` fixtures, and keep them green after.
- **Tests (names):**
  - `en contains NOTICE_WORDS exactly (same keys, same values)`; `PlayerText is the same union` (a type test)
  - `a translation spread over en still wins for a notice key; a missing key falls back to English`
  - `NoticeCard, Facts and MyRecord render the same DOM as the baselines for every shape`; `their text equals noticeView's title, body, facts and lines`
  - `RestrictedChatLine renders the same text for moderator and filter, with and without an end`
  - `the public exports are unchanged (dayText, secondsLeft, timeLeft, untilText, createT, en ...)`; `size.test.ts holds`; `a11y.test.tsx and no-leak.test.tsx pass unchanged`
- **Run:** `npx vitest run packages/player-react/test/notice-copy-parity.test.tsx packages/player-react/test/notice-queue.test.tsx packages/player-react/test/my-record.test.tsx packages/player-react/test/restricted-chat-line.test.tsx packages/player-react/test/appeal-notices.test.tsx packages/player-react/test/i18n.test.ts packages/player-react/test/format.test.ts packages/player-react/test/static.test.ts packages/player-react/test/a11y.test.tsx packages/player-react/test/no-leak.test.tsx packages/player-react/test/size.test.ts`

### Task 6: `planNotices` and its parity with the services
Spec 4.6, 7, Review Focus 1 and 2. Core only. Needs Task 4.
- **Files:** `packages/core/src/noticePlan.ts` (new, exported from the subpath: `planNotices`, `NoticeOp`, `PlanContext`, `NoticePlan`, `PlannedNotice`, `EffectCode`, `appealReplacementEnd`), `packages/core/src/appealService.ts` (the reduction's end is computed by `appealReplacementEnd`; no behaviour change), `packages/core/README.md`, tests `packages/core/test/notice-plan.test.ts`, `notice-plan-parity.test.ts`, `notice-plan-types.test.ts`.
- **Interfaces (Produces):** `planNotices(op, ctx): { notices: Array<{ to: string; notice: PlayerNotice }>; effects: EffectCode[]; nothing: 'note' | 'dismissal' | 'direct' | null }` where `op` is one of `{ op: 'decide'; verdict; target; reporter; actions: Array<{ person; kind; durationMs; rule; lines: Array<{ text; day }> }>; rename: { rule } | null }`, `{ op: 'sanction'; kind; durationMs }`, `{ op: 'note' }`, `{ op: 'rename'; rule }`, `{ op: 'revoke'; kind }`, `{ op: 'appeal'; outcome; original: { kind; startsAt; endsAt; rule; refCode }; to? }`, `{ op: 'dismiss' }`; `ctx = { now; ruleLabel: (ref) => string; reporterFeedback; appeals; refCode: string }`. `appealReplacementEnd(original: { startsAt; endsAt: number | null }, to: { durationMs: number | null }): number | null`.
- **Behaviour:** people and kinds in the core's order (by person ref, then kind); no notice for a note; the reporter's thank-you only on `upheld` with a non-note action and `reporterFeedback`; the rename notice last, rule from the op; a direct sanction and a note make none; a revoke makes none and says what lifts; a reduction makes the replacement's notice then `appeal_reduced`, the replacement ending at `min(original end, start + length)` and written as ended when that is past. The input types carry no moderator-only field.
- **Tests (names):**
  - `plan: each decision case of spec 4.3 A (one kind, pairs of kinds, two people, warning plus chat in the core's order, note only, note plus warning, dismissal, bad faith with and without a sanction on the reporter, rename alone, rename plus each kind)`
  - `plan: direct sanction and note make no notice and say what the player does see; revoke by kind; each appeal outcome; a reduction to a warning; a reduction already over`
  - **parity** (Review Focus 2): `for the whole matrix, the notices cw.notices.pending returns for each person equal the plan: kind, order, recipient, rule label, end within the clock tick, excerpt text and day, acknowledge flag`; `reporterFeedback off removes the thank-you in both`; `an uncovered, a retired and an unknown rule label the same in both`; `appealReplacementEnd equals what the appeals service writes and is never later than the original end`
  - `types: the plan's input has no reason, evidence, gapNote, actor, ref, groupId, includeIp, ai or statement field` (type-level `expectTypeOf`) (Review Focus 1)
  - `planNotices never throws for a malformed op; it returns an empty plan with nothing set`
- **Run:** `npx vitest run packages/core/test/notice-plan.test.ts packages/core/test/notice-plan-parity.test.ts packages/core/test/notice-plan-types.test.ts packages/core/test/appeals-decide.test.ts packages/core/test/decide.test.ts packages/core/test/names-rename-rule.test.ts`

### Task 7: The panel, and the Person forms with revoke
Spec 4.3 B to F, 4.4, 7, 8. Needs Tasks 3, 4 and 6.
- **Files:** `packages/hub-react/src/preview/PlayerPreview.tsx` (new, lazy: the panel; draws `noticeView` output as text, the effect lines, the nothing-sent lines, the live-region sentence), `preview/usePreview.ts` (builds the op from a form, reads `me.features.appeals`, `policy.notices.reporterFeedback`, the rules for `communityRuleLabel`, a clock that ticks each minute), `preview/effects.ts` (effect code to words), `lazyParts.tsx` (`LazyPlayerPreview`), `person/SanctionForm.tsx` (the panel above Apply for a sanction, a note and a rename; the rule becomes required for a rename, and "No rule covers this" is not offered then), `person/sanctionDraft.ts` (`renameProblems` requires a numbered rule; `toRenameInput` always sends it), `person/Revoke.tsx` (the panel above Revoke), `i18n.ts` (`hub.preview.*`; `hub.person.form.noNotice` is replaced by the panel), `styles.css` (the quiet box; no new colour), `README.md`, tests `packages/hub-react/test/preview-panel.test.tsx`, `preview-person.test.tsx`, `preview-privacy.test.tsx`, `a11y-preview.test.tsx`, edits to `person-forms.test.tsx`, `person-rename.test.tsx`, `person.test.tsx`, `api.test.ts`, `size.test.ts`.
- **Behaviour:** as spec 4.3 C, D, E, F and B (the sweep window's line); nothing in the panel takes focus; `lang="en"` on the notice block; a flagged name is the hidden label; a debounced (600 ms) polite sentence after a change; the first render is silent; the panel is a lazy chunk with a one-line placeholder.
- **Tests (names):**
  - `the panel shows nothing-sent for a note ("Nothing is sent to the player. Only your team sees this note.") and for a direct sanction, with the restricted-chat line for a chat restriction and the game-message line for area and ban`
  - `rename: shows the rename notice with the chosen rule's label and "They are asked to pick a new name before they can chat."; the rule is required (a problem line); "No rule covers this" is not offered`
  - `revoke: chat, area, ban, warning and note each say what lifts and that an unseen notice is never shown; the appeals line only with appeals on`
  - `live: changing the kind, the length, the IP box or the rule changes the panel at once; the end time moves with the clock; nothing is shown until a kind is chosen`
  - `a flagged name is the hidden label in every sentence`; `no raw handle in the DOM`
  - **privacy** (Review Focus 1): `a sentinel reason, gap note and ref typed into the form never appear in the DOM, aria text or the live sentence`
  - `no focusable element inside the panel; the drawn buttons are spans; lang is en on the notice`; `axe: no violations, light and dark; 360 px no sideways scroll`
  - `the panel is lazy: the main chunk gains no preview code; size.test.ts holds`; `the live sentence is announced once after 600 ms and not on first render`
- **Run:** `npx vitest run packages/hub-react/test/preview-panel.test.tsx packages/hub-react/test/preview-person.test.tsx packages/hub-react/test/preview-privacy.test.tsx packages/hub-react/test/a11y-preview.test.tsx packages/hub-react/test/person-forms.test.tsx packages/hub-react/test/person-rename.test.tsx packages/hub-react/test/person.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task 8: The case decision: "Ask for a new name", its hint, and the panel
Spec 3.2, 3.3, 4.3 A and B, 6. Needs Tasks 1, 2 and 7.
- **Files:** `packages/hub-react/src/decision.ts` (`DecisionForm.rename: { rule: string } | null`, `emptyForm`, `validate` (rename needs fair and a numbered rule, only the reported person), `dropTargetActions` clears it on a dismissal verdict, `toInput` sends `rename: { rule }` when ticked), `case/useDecisionForm.ts` (the setter, the announcement, the AI echo's form shape includes it), `case/DecisionBar.tsx` (the row after the Add button: shown at once for reason `name`, behind the editor otherwise; the one-line off-hint with the owner's link; the panel above the submit row; the result block's rename line), `case/DecisionResult.tsx`, `case/CaseCard.tsx` (Simple: the panel replaces `hub.simple.sees*` and previews the primary one-tap step; the other one-tap buttons carry their own one-line description), `case/AiParts.tsx` (the accept button's sentence becomes the same panel), `case/useQuickActions.ts` (descriptions), `case/BulkDismiss.tsx` (the sweep line), `headless/decisions.ts` (`SubmitDecision.input` carries `rename`; `DecisionState.done` gains `rename?: 'asked' | 'already' | 'failed'` read from the answer), `types.ts` (`DecideInput.rename`, `DecideResult.rename`), `i18n.ts` (`hub.decide.rename.*`, `hub.decide.renamesOff.*`; `hub.simple.sees*` removed), tests `packages/hub-react/test/case-rename.test.tsx`, `rename-hint.test.tsx`, `preview-decision.test.tsx`, `preview-simple.test.tsx`, `preview-parity.test.tsx` (in `packages/player-react/test/`), edits to `decide-matrix.test.ts`, `case-decide.test.tsx`, `simple.test.tsx`, `headless/*`, `api.test.ts`, `size.test.ts`.
- **Tests (names):**
  - `the rename row is absent with renames off or without sanctions.apply, shown at once for a name report, behind the editor for any other reason; it starts unticked`
  - `its rule starts on the first action's rule, then the report's, and is required; a dismissal verdict clears it with an announcement`
  - `the body sent has rename only when ticked and nothing is sent before the hold ends; Undo sends nothing; rename alone, plus a warning, plus a ban`
  - `each rename answer shows the right result line and keeps the decision: asked, already ("They have already been asked..."), failed ("Decision recorded, but asking for a new name did not go through."); a 404 before any write returns the form with its error` (Review Focus 4)
  - `the headless controller does the same without the shell`
  - `off-hint on a name report: setting off (a link for policy.write, words for others), on but unsupported (words only), absent for other reasons and for roles that cannot decide`
  - panel: `for every kind, a warning, a permanent ban, lines present and absent, appeals on and off, reporter feedback on and off, two people, a rename, rename plus a ban ("They will be asked once they can play again."), a dismissal and a note-only decision: notices, order ("Notice 1 of 2"), recipients, effects and nothing-sent lines of spec 4.3 A`
  - `same output in Simple and Detailed; Simple previews the primary step and the other one-tap buttons carry their one line; hub.simple.sees is gone`
  - `a blocked line reads from noticeText, starred; a missing noticeText is never shown raw` (Review Focus 3); `sentinels in reason, evidence and gap note never appear in the panel` (Review Focus 1)
  - **renderer parity** (`preview-parity.test.tsx`): `for the same decision, the panel's notice text equals the text of the notice the real NoticeQueue shows for the real server's pending answer`
  - `axe, 360 px, size budget; the panel and the row's off-hint are in light and dark`
- **Run:** `npx vitest run packages/hub-react/test/case-rename.test.tsx packages/hub-react/test/rename-hint.test.tsx packages/hub-react/test/preview-decision.test.tsx packages/hub-react/test/preview-simple.test.tsx packages/hub-react/test/decide-matrix.test.ts packages/hub-react/test/case-decide.test.tsx packages/hub-react/test/simple.test.tsx packages/hub-react/test/bulk-dismiss.test.tsx packages/hub-react/test/quick-actions.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts packages/player-react/test/preview-parity.test.tsx`, then `npx vitest run packages/hub-react/test/headless`.

### Task 9: The appeal card's choice and its panel, and the docs
Spec 4.3 G, 8, 13. Needs Task 7. Breaking: three immediate buttons become a choice plus "Send decision".
- **Files:** `packages/hub-react/src/case/AppealCard.tsx` (`Decision`: a radio group, "Keep the decision", "Make it lighter", "Remove it", the lighter kind and length shown when that choice is on, "Send decision" (aria-disabled while busy), the panel above it, nothing sent before Send), `appeals/lighter.ts` (unchanged), `i18n.ts` (`hub.appeals.decide.send`, legend), tests `packages/hub-react/test/preview-appeal.test.tsx`, edits to `appeal-card.test.tsx`, `a11y-appeals.test.tsx`, `appeals-queue.test.tsx`, `size.test.ts`; docs: `packages/core/README.md`, `packages/player-react/README.md`, `packages/hub-react/README.md`, `packages/http/README.md`, `docs/status.md`, `docs/plans/follow-ups.md` (spec section 11), the READMEs' `@experimental` lists, `scripts/readme.test.ts` expectations.
- **Behaviour:** the reason stays required with the saved-reason chips; the existing refusals (`same_decider`, `already_decided`, `gone`) keep the typed text and settle the card; no claim chrome, no Undo hold (as 0.1.9); the panel follows the choice and the lighter picker, with two notices for a reduction, the new end and the old, and the "already run its course" line.
- **Tests (names):**
  - `the three outcomes are a radio group; nothing is sent until Send decision; Enter in the reason box does not send`
  - `keep, lighter and remove each send the body 0.1.9 sent (outcome, to, reason)`
  - `the panel: keep shows the "kept" notice with the original reference; lighter shows two notices in order with the new end and the old one; a reduction to a warning shows Acknowledge; a reduction already over shows the ended line; remove shows the "removed" notice and the by-kind line; nothing chosen shows the prompt`
  - `the lighter picker offers only lighter kinds and the profile's lengths (existing) and drives the panel`
  - `the statement the player wrote and the private reason never appear in the panel` (Review Focus 1)
  - `same_decider, already_decided and gone show in words and keep what was typed; a decided appeal returns to the list`
  - `axe: no violations, light and dark; 360 px no sideways scroll; size.test.ts holds`
  - docs: `the readme checks pass` (`scripts/readme.test.ts`)
- **Run:** `npx vitest run packages/hub-react/test/preview-appeal.test.tsx packages/hub-react/test/appeal-card.test.tsx packages/hub-react/test/a11y-appeals.test.tsx packages/hub-react/test/appeals-queue.test.tsx packages/hub-react/test/size.test.ts scripts/readme.test.ts`, then `npm run lint` and `npm run typecheck`.

---

## Hand-off to the controller's release prep (not a task)
- Peer floors (RELEASING.md "When a peer floor must rise"): `player-react`, `hub-react` and `http` on the new core for `@chatwarden/core/notice-copy`
  and `cw.notices.lineText`, `requireRename`'s required rule and the decide `rename`; `hub-react` reads the new `http` fields. Confirm each by
  grep. `NEEDS_CORE_*` in `scripts/manifests.test.ts` changes in the same commit.
- Changelog sentences for this theme: the `name` reason; the required rename rule (breaking); `decide` accepts and answers `rename`; the
  preview panel and the appeal card's "Send decision" (breaking UI); the words now live in `@chatwarden/core/notice-copy`.
- Migration 26: nothing from this theme.

## Spec coverage (self-review)
3.1 to Task 1; 3.2 (send) to Task 2 and (row, form, result, headless) to Task 8; 3.3 to Task 8; 3.4 to Tasks 2 and 7; 4.2 to Tasks 7 to 9
(one row per action); 4.3 A and B to Task 8, C to F and the sweep line to Task 7, G to Task 9; 4.4 to Tasks 7 to 9; 4.5 to Tasks 4 and 5;
4.6 to Tasks 3 and 6; 4.7 and 6 (edge cases) to the tests of Tasks 6 to 9; 5 to Tasks 2 and 3; 7 to Tasks 6 to 9 (sentinel scans); 8 to
the a11y tests of Tasks 7 to 9; 12 to the hand-off; 13 to Task 9. Names used across tasks (`noticeView`, `NOTICE_WORDS`, `planNotices`,
`appealReplacementEnd`, `communityRuleLabel`, `lineText`, `noticeText`, `PlayerPreview`, `DecisionForm.rename`) are defined once in the
owning task and consumed under the same spelling.
